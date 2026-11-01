import { z } from "zod";
import { AppearanceSettings, ChatBackground, ImageRef, PickableImagePurpose } from "./appearance";
import {
  ApprovalId,
  AudioRef,
  BatchId,
  ChatMessageId,
  ConversationId,
  PermissionRequestId,
  PlanVersionId,
  RoundId,
  RunId,
  Sha256Hex,
  SnapshotId,
} from "./common";
import { NodeHealth, ProfileId, RunModel } from "./remote-protocol";
import { AgentEvent } from "./agent-event";
import { PermissionDecision, PermissionRequest } from "./permission";
import {
  AgentName,
  Approval,
  Contribution,
  ContributionId,
  ContributionType,
  Message,
  MessageId,
  Project,
  ProjectId,
  PromptSnapshot,
  Run,
  SystemStatus,
  TextSelection,
} from "./entities";
import {
  AgentModelSettings,
  AgentProfile,
  AgentStatus,
  ApprovalBatch,
  HexColor,
  HistoryMode,
  MemorySource,
  NodeId,
  PlanVersion,
  Round,
  RoundSummary,
  TaskSource,
  Turn,
} from "./discussion";
import {
  CHAT_LIMITS,
  ChatAttachment,
  ChatContentInput,
  ConversationMembers,
  GroupMembers,
  ChatCursor,
  ChatHistorySummary,
  ChatMentions,
  ChatMessage,
  ChatReplySlot,
  ChatRun,
  ChatSlotId,
  ChatSnapshot,
  Conversation,
  ConversationListItem,
  Sticker,
  StickerId,
  UserChatMessage,
  VoiceRecording,
} from "./chat";
import { DrawRequest, DrawRoutePreview, MediaJob, MediaJobId, MEDIA_LIST_MESSAGE_IDS_MAX, MediaScope, MediaSource } from "./media";
import { ImmersiveSettings, ImmersiveUsage } from "./immersive";
import { SpeechClip, VoiceOption, VoiceProfile } from "./speech";

/**
 * 控制面 API：人 ⇄ Orchestrator。
 *
 * - 桌面 renderer 今天通过 Electron IPC 使用（见 ipc.ts）；以后手机 App 通过网络网关使用同一套格式
 * - 手机 App 只连 Orchestrator，**永远不直接连 AgentServer**
 * - 与传输层无关：这里只定义消息格式、返回格式和所需权限
 *
 * 每个命令 / 查询都登记在 COMMANDS / QUERIES 里：request schema、response schema、所需 scope。
 * main 进程按登记表校验入参和出参；renderer 的类型从登记表推导。
 */

export const ClientKind = z.enum(["desktop", "mobile"]);
export type ClientKind = z.infer<typeof ClientKind>;

export const ControlScope = z.enum([
  "read",       // 看状态、看 prompt、看结果
  "author",     // 创建项目、粘贴输入、标记 Contribution、生成 Snapshot
  "approve",    // 批准 / 拒绝
  "permission", // 回答 Agent 的权限请求
  "cancel",     // 取消 run
  "admin",      // 修改设置（Reviewer 节点地址、Token）
]);
export type ControlScope = z.infer<typeof ControlScope>;

// ================================================================ Reviewer 节点设置（ADR-001 物理分离）

/**
 * 主控端连接 AgentServer 的地址，例如 http://192.168.1.20:7420 。
 * 只允许 http / https，不带路径、查询参数和账号信息。
 */
export const NodeBaseUrl = z
  .string()
  .max(200)
  .refine((v) => {
    try {
      const u = new URL(v);
      return (u.protocol === "http:" || u.protocol === "https:") && !u.username && !u.password &&
        (u.pathname === "/" || u.pathname === "") && !u.search && !u.hash;
    } catch {
      return false;
    }
  }, "需要形如 http://192.168.1.20:7420 的地址");

/**
 * AgentServer 的 Token。只能写入，永远不会从后端读出来（查询只返回 tokenConfigured）。
 * main 进程收到后存进系统凭据库（Electron safeStorage），不落 SQLite、不进日志。
 */
export const NodeToken = z.string().min(32).max(512).regex(/^[\x21-\x7e]+$/, "Token 只能包含可见 ASCII 字符");

export const ReviewerNodeSettings = z.object({
  baseUrl: NodeBaseUrl,
  profileId: ProfileId,
  tokenConfigured: z.boolean(),
});
export type ReviewerNodeSettings = z.infer<typeof ReviewerNodeSettings>;

export const NodeTestResult = z.discriminatedUnion("reachable", [
  z.object({
    reachable: z.literal(true),
    health: NodeHealth,
    /** 填写的 profileId 是否在节点上存在 */
    profileAvailable: z.boolean(),
    latencyMs: z.number().int().nonnegative(),
  }),
  z.object({
    reachable: z.literal(false),
    error: z.enum(["unreachable", "timeout", "unauthorized", "protocol_mismatch", "no_token"]),
    message: z.string(),
  }),
]);
export type NodeTestResult = z.infer<typeof NodeTestResult>;

// ================================================================ 节点（ADR-002：可以有多个 AgentServer）

/** 节点设置。和 ReviewerNodeSettings 一样，Token 只写不读 */
/** 主控机本机节点的 id（S-10 / C-27 的推荐配置；ADR-003 §2a 拆分后是汐的节点，7420） */
export const LOCAL_NODE_ID = "controller-local";
/** C-44：主控机上林离的节点（ADR-003 §2a，7421，以 agentroom-codex 运行） */
export const LOCAL_CODEX_NODE_ID = "controller-local-codex";
/**
 * C-44：主控机本机节点白名单。node.importLocalToken 只对这些 id 可用。
 * 加新的本机节点要改这里（契约 PR），不能由设置或 renderer 扩
 */
export const LOCAL_NODE_IDS = [LOCAL_NODE_ID, LOCAL_CODEX_NODE_ID] as const;
export const LocalNodeId = z.enum(LOCAL_NODE_IDS);
export type LocalNodeId = z.infer<typeof LocalNodeId>;

export const NodeInfo = z.object({
  id: NodeId,
  label: z.string().min(1).max(60),
  baseUrl: NodeBaseUrl,
  tokenConfigured: z.boolean(),
});
export type NodeInfo = z.infer<typeof NodeInfo>;

const uniqueAgents = (xs: readonly string[]) => new Set(xs).size === xs.length;

// ================================================================ Commands

const def = <Req extends z.ZodTypeAny, Res extends z.ZodTypeAny>(
  request: Req,
  response: Res,
  scope: ControlScope,
) => ({ request, response, scope });

export const COMMANDS = {
  "project.create": def(
    z.object({ type: z.literal("project.create"), name: z.string().min(1).max(200) }),
    Project,
    "author",
  ),

  /** AC-1：手动粘贴 Source Agent 输出 */
  "source.add": def(
    z.object({
      type: z.literal("source.add"),
      projectId: ProjectId,
      sourceAgent: AgentName,
      content: z.string().min(1).max(2_000_000),
    }),
    Message,
    "author",
  ),

  /** AC-2：选中一段标记成 Contribution。不提交 content，由后端按 selection 截取 */
  "contribution.create": def(
    z.object({
      type: z.literal("contribution.create"),
      projectId: ProjectId,
      sourceMessageId: MessageId,
      contributionType: ContributionType,
      title: z.string().min(1).max(200),
      selection: TextSelection,
    }),
    Contribution,
    "author",
  ),

  /**
   * AC-3/4/5：生成不可变 Snapshot，同时创建一个 READY_FOR_REVIEW 的 Approval。
   * 同一项目中之前处于 READY_FOR_REVIEW / APPROVED 且尚未产生 Run 的 Approval 会变成 EXPIRED。
   */
  "snapshot.create": def(
    z.object({
      type: z.literal("snapshot.create"),
      projectId: ProjectId,
      contributionIds: z.array(ContributionId).min(1).max(100),
      taskInstruction: z.string().min(1).max(20_000),
    }),
    z.object({ snapshot: PromptSnapshot, approval: Approval }),
    "author",
  ),

  /**
   * AC-6：批准并立即创建 Run。
   * expectedSnapshotHash 必须等于 snapshot.contentHash，否则返回 stale_snapshot——
   * 防止停留在旧页面（尤其是手机上）的人批准了已经变化的 prompt。
   */
  "approval.approve": def(
    z.object({
      type: z.literal("approval.approve"),
      approvalId: ApprovalId,
      expectedSnapshotHash: Sha256Hex,
    }),
    z.object({ approval: Approval, run: Run }),
    "approve",
  ),

  "approval.reject": def(
    z.object({
      type: z.literal("approval.reject"),
      approvalId: ApprovalId,
      reason: z.string().max(2000).optional(),
    }),
    Approval,
    "approve",
  ),

  "run.cancel": def(
    z.object({ type: z.literal("run.cancel"), runId: RunId, reason: z.string().max(500).optional() }),
    Run,
    "cancel",
  ),

  /** Phase 0 的 Reviewer 走 API，不会产生权限请求；先占位 */
  "permission.decide": def(
    z.object({
      type: z.literal("permission.decide"),
      runId: RunId,
      requestId: PermissionRequestId,
      decision: PermissionDecision.shape.decision,
    }),
    z.object({}),
    "permission",
  ),

  /** 保存 Reviewer 节点设置。token 不传表示保留原来的 */
  "settings.updateReviewerNode": def(
    z.object({
      type: z.literal("settings.updateReviewerNode"),
      baseUrl: NodeBaseUrl,
      profileId: ProfileId,
      token: NodeToken.optional(),
    }),
    ReviewerNodeSettings,
    "admin",
  ),

  /**
   * 测试连接（不保存）。
   * token 不传时：**只有 baseUrl 与已保存的完全相同**才使用已保存的 token，
   * 否则返回 { reachable: false, error: "no_token" }——防止把 token 发到新填的（可能填错的）地址。
   * profileId 不参与鉴权，改 profileId 不要求重新输入 token。
   */
  "settings.testReviewerNode": def(
    z.object({
      type: z.literal("settings.testReviewerNode"),
      baseUrl: NodeBaseUrl,
      profileId: ProfileId,
      token: NodeToken.optional(),
    }),
    NodeTestResult,
    "admin",
  ),

  // ---------------------------------------------------------------- 讨论室（ADR-002 / C-20，阶段 1A）

  /** 新增或修改一个节点。token 不传表示保留原来的 */
  "node.upsert": def(
    z.object({
      type: z.literal("node.upsert"),
      id: NodeId,
      label: z.string().min(1).max(60),
      baseUrl: NodeBaseUrl,
      token: NodeToken.optional(),
    }),
    NodeInfo,
    "admin",
  ),

  /**
   * 测试某个节点上的某个 profile（不保存）。token 规则同 settings.testReviewerNode：
   * 不传 token 时，只有 baseUrl 与这个节点已保存的完全相同才使用已保存的 token。
   */
  "node.test": def(
    z.object({
      type: z.literal("node.test"),
      id: NodeId,
      baseUrl: NodeBaseUrl,
      profileId: ProfileId,
      token: NodeToken.optional(),
    }),
    NodeTestResult,
    "admin",
  ),

  /** 修改参与者设置。只传要改的字段 */
  "agent.update": def(
    z.object({
      type: z.literal("agent.update"),
      id: AgentName,
      displayName: z.string().min(1).max(40).optional(),
      color: HexColor.optional(),
      roleNote: z.string().max(2000).optional(),
      canDiscuss: z.boolean().optional(),
      canSummarize: z.boolean().optional(),
      canExecute: z.boolean().optional(),
      nodeId: NodeId.nullable().optional(),
      profileId: ProfileId.nullable().optional(),
      pausedByUser: z.boolean().optional(),
      substitute: AgentName.nullable().optional(),
      /** C-32：先用 image.pick 拿到引用再传进来；null = 去掉头像 */
      avatarRef: ImageRef.nullable().optional(),
      /** C-40：整份替换，不做字段级合并。只校验格式，不连节点 */
      modelSettings: AgentModelSettings.optional(),
      /** C-34：聊天人设、聊天 profile、记忆来源 */
      chatPersona: AgentProfile.shape.chatPersona.optional(),
      chatProfileId: ProfileId.nullable().optional(),
      memorySource: MemorySource.optional(),
      /** C-42c：null = 不用语音；voiceId 必须在 voices.list 里，否则 validation_failed */
      voice: VoiceProfile.nullable().optional(),
    }),
    AgentProfile,
    "admin",
  ),

  /**
   * 主控机节点一键读取本机 Token（C-39；C-44 扩成本机节点白名单）。
   * - 只对 id 在 LOCAL_NODE_IDS 里（"controller-local"、"controller-local-codex"）**并且** baseUrl 是本机回环地址
   *   （127.0.0.1 / localhost / [::1]）的节点可用；id 在白名单里但节点的 baseUrl 不是回环地址 → invalid_state；
   *   id 不在白名单里 → 入参校验就拒绝（validation_failed）
   * - Token 文件的位置：**每个 id 一个路径**，在 main 的 settings.json 里的 `localAgentServerTokenFiles`
   *   （键是 LocalNodeId，值是文件路径；只在 main 里，不经过控制 API，renderer 改不了）。
   *   某个 id 没配置时用它的默认位置：`<AgentRoom>\node\deepseek\agent-server.token`（controller-local）、
   *   `<AgentRoom>\node\codex\agent-server.token`（controller-local-codex）。`<AgentRoom>` 是 main 设置里的 `agentRoom`
   *   （D-40 加，和节点配置的 `homeDir` 是同一个值，安装时选一次，主控端复用；ADR-003 §2a）。
   *   这个 id 的路径没配置、`agentRoom` 也没有 → not_found（提示去设置里填），不猜路径。
   *   旧设置 `localAgentServerTokenFile`（C-39，单个路径）只当作 controller-local 的路径读，D-40 读到时写进
   *   `localAgentServerTokenFiles["controller-local"]`；不能拿来给 controller-local-codex。
   *   **请求里不能带路径**；两个 id 解析出的是同一个文件（同一份 Token 给了两个节点）时，导入任何一个都返回 invalid_state，
   *   错误信息说明是哪两个 id 指向了同一个文件（不写路径）。「同一个文件」按 realpath 判断：Windows 上不区分大小写，
   *   `\` 和 `/` 等价，`..`、junction、符号链接都先解析再比较
   * - 读到的值按 NodeToken 校验，只写进这个 id 对应节点的 safeStorage 槽位，不回显；日志里不写 token，也不写文件路径
   * - 前提：导入前节点要已经在节点列表里（推荐配置是 controller-local → http://127.0.0.1:7420、
   *   controller-local-codex → http://127.0.0.1:7421，D-40 的首启推荐配置把两条都种进去）
   * - 失败分类：节点不存在或 Token 文件不存在 → not_found；文件读不了（权限等）→ internal；内容不合 NodeToken → validation_failed
   * - 成功后 renderer 自己再调一次 node.test（这条命令只负责导入）；一键导入两份 = renderer 按 id 各调一次
   */
  "node.importLocalToken": def(
    z.object({ type: z.literal("node.importLocalToken"), id: LocalNodeId }),
    NodeInfo,
    "admin",
  ),

  // ---------------------------------------------------------------- 外观（C-32，阶段 1B-1）

  /**
   * 打开系统的选图对话框（由 main 打开，renderer 不传路径）。
   * 取消返回 null；类型不对（按文件头判断）或超过 IMAGE_MAX_BYTES[purpose]：validation_failed。
   * C-42a：chat / material 先按 ATTACHMENT_LIMITS 处理（去元数据、转正、缩放），处理后再判断大小；动图和 HEIC 拒绝。
   * 选中的图先存下来、还没被引用；之后 agent.update / appearance.update 用上它才算数，没用上的由 main 清理
   */
  "image.pick": def(
    z.object({ type: z.literal("image.pick"), purpose: PickableImagePurpose }),
    z.object({ ref: ImageRef }).nullable(),
    "admin",
  ),

  /** 修改外观设置。只传要改的字段；换下来的旧图片如果没人再用，main 删除 */
  "appearance.update": def(
    z.object({
      type: z.literal("appearance.update"),
      userDisplayName: z.string().trim().min(1).max(40).optional(),
      userAvatarRef: ImageRef.nullable().optional(),
      chatBackground: ChatBackground.optional(),
    }),
    AppearanceSettings,
    "admin",
  ),

  /** 「只发言」：写进时间线，不发给任何 Agent，不用盖章 */
  "note.add": def(
    z.object({
      type: z.literal("note.add"),
      projectId: ProjectId,
      content: z.string().min(1).max(200_000),
    }),
    Message,
    "author",
  ),

  /**
   * 起草新的一轮：为每个收件人生成 Snapshot + Approval，打包成一个 initial 批次，等盖章。
   * 议题里已有 DRAFT / RUNNING / PAUSED / AWAITING_SUMMARY / SUMMARIZING 的轮时返回 invalid_state；
   * 收件人不在线、未配置、被暂停或额度缺席时返回 agent_unavailable（message 里写明是谁）。
   */
  "round.draft": def(
    z.object({
      type: z.literal("round.draft"),
      projectId: ProjectId,
      recipients: z.array(AgentName).min(1).max(8).refine(uniqueAgents, "收件人不能重复"),
      task: z.string().min(1).max(20_000),
      taskSource: TaskSource,
      planVersionId: PlanVersionId.nullable(),
      historyMode: HistoryMode,
    }),
    z.object({ round: Round, batch: ApprovalBatch }),
    "author",
  ),

  /**
   * 修改还没盖章的一轮（任务、收件人、讨论记录取法）：旧批次 CANCELLED，生成新批次。
   * 只允许 DRAFT 状态。
   */
  "round.redraft": def(
    z.object({
      type: z.literal("round.redraft"),
      roundId: RoundId,
      recipients: z.array(AgentName).min(1).max(8).refine(uniqueAgents, "收件人不能重复").optional(),
      task: z.string().min(1).max(20_000).optional(),
      historyMode: HistoryMode.optional(),
    }),
    z.object({ round: Round, batch: ApprovalBatch }),
    "author",
  ),

  /**
   * 盖章。批次种类决定这一轮怎么变：
   * - initial：DRAFT → RUNNING
   * - resume：PAUSED → RUNNING
   * - supplement / retry：RUNNING 保持；AWAITING_SUMMARY → RUNNING（大家都答完后再补一句或重试某人）
   * - summary：AWAITING_SUMMARY → SUMMARIZING
   * 这一批的 Turn 在起草时已经以 pending 建好，盖章时变成 running 并挂上 Run。
   *
   * expected 必须**恰好**覆盖批次里的每一项，且每个 contentHash 都和 Snapshot 一致，
   * 否则整批拒绝（stale_snapshot），一个都不发。批准 + 建 Run 在同一事务里。
   *
   * C-40：模型和强度也算进盖章指纹。每项只比较 model 和 effort 两个字段（usedFallback / effortSource 不比较，
   * 不要整体 deepEqual）；两边都是 null 算一致，一边 null 一边不是算不一致。不一致同样整批 stale_snapshot，
   * message 里写明是哪个人、是模型还是强度对不上（不要只说「内容已变化」）。
   * 盖章时 main 不重新挑模型；人批准的是「这份内容、用这个模型和强度、发给这个人」。
   *
   * C-42a：带图的项，main 在同一事务前重新读每个图片文件、算 sha256，和 Snapshot.attachments 逐张比对；
   * 任何一张缺失或对不上 → 整批 stale_snapshot（message 写明是谁的第几张图），一个 Run 都不建。
   * 起跑前（发 StartRun 之前）再比一次，对不上这个 Run 记失败，不发出去。
   */
  "batch.approve": def(
    z.object({
      type: z.literal("batch.approve"),
      batchId: BatchId,
      expected: z
        .array(z.object({ approvalId: ApprovalId, contentHash: Sha256Hex, model: RunModel.nullable() }))
        .min(1)
        .max(8),
    }),
    z.object({ batch: ApprovalBatch, turns: z.array(Turn) }),
    "approve",
  ),

  "batch.reject": def(
    z.object({ type: z.literal("batch.reject"), batchId: BatchId, reason: z.string().max(2000).optional() }),
    ApprovalBatch,
    "approve",
  ),

  /** 全部暂停：正在答的按"打断"结束（Turn 结局 paused），计时停止 */
  "round.pause": def(z.object({ type: z.literal("round.pause"), roundId: RoundId }), Round, "cancel"),

  /** 恢复：为结局是 paused 的人生成 resume 批次（内容不变），盖章后回到 RUNNING */
  "round.resume": def(
    z.object({ type: z.literal("round.resume"), roundId: RoundId }),
    z.object({ round: Round, batch: ApprovalBatch }),
    "author",
  ),

  /** 结束本轮：没答完的 Turn 结局 round_ended，已写部分保留，进入 AWAITING_SUMMARY */
  "round.end": def(z.object({ type: z.literal("round.end"), roundId: RoundId }), Round, "cancel"),

  /**
   * 插话补充。补充本身总是写进时间线（human_note）。
   * - restart_now: targets 里正在答的人被打断，生成 supplement 批次让他们带上补充重答
   * - next_round : 不打断，只记下来，下一轮起草时会带上（batch 为 null）
   * - only       : 只发给 targets（通常一个人），批次里 differsFromOthers = true
   */
  "round.supplement": def(
    z.object({
      type: z.literal("round.supplement"),
      roundId: RoundId,
      content: z.string().min(1).max(200_000),
      mode: z.enum(["restart_now", "next_round", "only"]),
      /** restart_now / only 时至少一个（main 校验，不满足返回 validation_failed） */
      targets: z.array(AgentName).max(8).refine(uniqueAgents, "不能重复"),
    }),
    z.object({ note: Message, batch: ApprovalBatch.nullable() }),
    "author",
  ),

  /** 单独重试一个人（他上一个 Turn 的结局是 timed_out / failed / absent_quota） */
  "round.retry": def(
    z.object({ type: z.literal("round.retry"), roundId: RoundId, agent: AgentName }),
    ApprovalBatch,
    "author",
  ),

  /**
   * 请汇总者汇总这一轮（AWAITING_SUMMARY 时可用）。发给汇总者也是一次发送，同样要盖章。
   * 汇总者必须 canSummarize，且不能是本轮任何人的替补。
   * 这一轮没有任何 answered 的发言时返回 invalid_state（没什么可汇总的，界面建议作废）。
   */
  "round.summarize": def(
    z.object({ type: z.literal("round.summarize"), roundId: RoundId, summarizer: AgentName }),
    ApprovalBatch,
    "author",
  ),

  /** 回到某一阶段改方向：这一轮作废（记录保留），正在答的全部按 round_ended 结束 */
  "round.void": def(
    z.object({ type: z.literal("round.void"), roundId: RoundId, reason: z.string().min(1).max(2000) }),
    Round,
    "author",
  ),

  /** 确认方案草稿：DRAFT → CURRENT，原来的 CURRENT → SUPERSEDED */
  "plan.confirm": def(
    z.object({ type: z.literal("plan.confirm"), planVersionId: PlanVersionId }),
    PlanVersion,
    "approve",
  ),

  /**
   * 用户写第一版方案（C-28）：这个议题还没有任何方案版本时使用，生成 v1 DRAFT（drafted_by = human，parentId = null）。
   * 已经有版本时返回 invalid_state，改用 plan.edit。用于汇总没有给出方案、而用户想自己起草的情况。
   */
  "plan.create": def(
    z.object({
      type: z.literal("plan.create"),
      projectId: ProjectId,
      content: z.string().min(1).max(200_000),
      changeNote: z.string().max(2000),
    }),
    PlanVersion,
    "author",
  ),

  /** 用户自己改方案：基于 parentId 生成一个新的 DRAFT */
  "plan.edit": def(
    z.object({
      type: z.literal("plan.edit"),
      parentId: PlanVersionId,
      content: z.string().min(1).max(200_000),
      changeNote: z.string().max(2000),
    }),
    PlanVersion,
    "author",
  ),

  /**
   * 盖章定稿：CURRENT → FINAL。expectedContentHash 和 Snapshot 一样防"看的是旧版本"。
   * 这个议题已经有 FINAL（之前定过稿、后来派生出新版本）时，旧的 FINAL 在同一事务里变成 SUPERSEDED（C-26）
   */
  "plan.finalize": def(
    z.object({ type: z.literal("plan.finalize"), planVersionId: PlanVersionId, expectedContentHash: Sha256Hex }),
    PlanVersion,
    "approve",
  ),

  /** 定稿后发现漏了：从 FINAL 派生一个新的 DRAFT，版本链不断 */
  "plan.derive": def(
    z.object({ type: z.literal("plan.derive"), planVersionId: PlanVersionId }),
    PlanVersion,
    "author",
  ),
  // ---------------------------------------------------------------- 聊天空间（ADR-003 / C-34，阶段 1B-2）
  // 聊天不盖章：下面没有一条命令会改文件、跑命令或改讨论室的结果。要变成动作只能 chat.toTopic。

  /**
   * 新建会话。单聊（members.kind = direct）：和这位已经有单聊时返回原来那个，不新建。
   * 群聊：2～8 位，不重复（入参就校验，不会建出一位的群聊）。成员必须是已有的参与者（not_found）
   */
  "chat.conversation.create": def(
    z.object({
      type: z.literal("chat.conversation.create"),
      members: ConversationMembers,
      title: z.string().trim().min(1).max(60).nullable(),
    }),
    Conversation,
    "author",
  ),

  /**
   * 改会话设置。只传要改的字段。members 只对群聊（单聊传了 → invalid_state），改完仍要 2～8 位；
   * 移出的人正在答的回答位照常答完，之后的消息不再建他的回答位
   */
  "chat.conversation.update": def(
    z.object({
      type: z.literal("chat.conversation.update"),
      conversationId: ConversationId,
      title: z.string().trim().min(1).max(60).nullable().optional(),
      pinned: z.boolean().optional(),
      muted: z.boolean().optional(),
      members: GroupMembers.optional(),
    }),
    Conversation,
    "author",
  ),

  /** 读到这一条为止（只能往后挪，比当前的旧就忽略） */
  "chat.conversation.markRead": def(
    z.object({ type: z.literal("chat.conversation.markRead"), conversationId: ConversationId, messageId: ChatMessageId }),
    Conversation,
    "read",
  ),

  /**
   * 发一条消息。打字就发，不盖章。
   *
   * 检查顺序：① 入参 schema → ② 防重复 → ③ 限流 → ④ 其余校验 → ⑤ 一个事务建消息、回答位、Run。
   * - **防重复**：messageId 由发送方生成。判等看整条发送意图 chatSendIntentJson(req)（conversationId、content、mentions、
   *   quoteMessageId、replacesMessageId，按键排序的 JSON），main 把它的 sha256 和消息一起落库，重启后仍有效：
   *   同一个 id、意图相同 → 原样返回第一次的结果，不新建回答位和 Run，**也不占限流名额**（所以网络重试不会变成 rate_limited）；
   *   同一个 id、意图任一字段不同 → idempotency_conflict。
   *   只有成功的发送会落库：第一次被拒（rate_limited / validation_failed / invalid_state）什么都没建，同一个 id 再发按新的一次处理。
   *   两个同 id 请求同时到达、都没查到记录时：后提交的那个插入消息撞主键 → 回滚，重读记录再按上面的规则返回（意图相同返回第一次的结果），不报 internal
   * - **上限**：每个会话最近 60 秒最多 CHAT_LIMITS.messagesPerMinute 条，超了 rate_limited（什么都不建）
   * - content 只带引用（ChatContentInput），附件 / 录音 / 表情的元数据由 main 从自己的记录填，不信客户端
   * - mentions：单聊只能是 none；agents 里的人必须都是成员（validation_failed）
   * - 附件 / 录音 / 表情的引用必须存在、属于聊天（validation_failed）；录音必须 ready
   * - quoteMessageId：必须在同一个会话里，并且没有被排除（isExcludedFromContext：已撤回的消息、回答已撤回消息的秘书回答都不能引用），
   *   否则 invalid_state
   * - replacesMessageId（重新编辑）：必须是同一个会话里**你的、已撤回的**消息，撤回不超过 CHAT_LIMITS.reeditWindowMs，
   *   而且还没被别的消息替换过，否则 invalid_state。重新编辑是一条新消息、新回答位（同样的 @ 规则）；旧回答位和旧 Run 归档，不复活
   *
   * 回答位按 ChatReplySlot 的规则建，**所有回答位和 Run 在同一个事务里**；不能答的人直接记 unavailable / absent_quota，
   * 其他人照常。每个 Run 的模型按 modelSettings 的「聊天」场合定。一个能答的人都没有时也照样成功（回答位全是缺席），不报错。
   */
  "chat.send": def(
    z.object({
      type: z.literal("chat.send"),
      conversationId: ConversationId,
      messageId: ChatMessageId,
      content: ChatContentInput,
      mentions: ChatMentions,
      quoteMessageId: ChatMessageId.nullable(),
      replacesMessageId: ChatMessageId.nullable(),
      /**
       * C-42c：「用语音回」开关。你在话里说「用语音回我」时，renderer 在发送前只看这一条、自动点亮，你发送前看得到也能关。
       * 省略 = 没开。main 原样存到 UserChatMessage.replyAsVoice
       */
      replyAsVoice: z.literal(true).optional(),
    }),
    z.object({ message: UserChatMessage, slots: z.array(ChatReplySlot).max(CHAT_LIMITS.maxRecipients), runs: z.array(ChatRun) }),
    "author",
  ),

  /**
   * 撤回自己的消息。只能撤回你发的、CHAT_LIMITS.retractWindowMs 以内的（按主控机时间），否则 invalid_state；已撤回的再撤 → invalid_state。
   * 顺序：先在一个事务里落库（消息 retracted、它的回答位全部 retracted——replyMessageId / failure / unavailableReason 保留原值不清空、
   * 包含它或它的回答的摘要 stale、发出取消请求），
   * 再中止正在答的 Run（Run 结局 CANCELLED，仍然恰好一个终止事件）。撤回瞬间刚好答完的结果按迟到结果丢弃
   */
  "chat.retract": def(
    z.object({ type: z.literal("chat.retract"), messageId: ChatMessageId }),
    z.object({ message: UserChatMessage, slots: z.array(ChatReplySlot) }),
    "author",
  ),

  /**
   * 单独重试一个回答位（结局是 failed / absent_quota / unavailable / cancelled），其他人不重发。
   * **重新拼一份 Snapshot**（不重放旧的），attempt + 1，新建 Run。这位现在仍然不能答 → agent_unavailable，回答位不变。
   * 消息已撤回、或这位已经不在会话成员里（被移出群）→ invalid_state，回答位不变
   */
  "chat.retry": def(
    z.object({ type: z.literal("chat.retry"), slotId: ChatSlotId }),
    z.object({ slot: ChatReplySlot, run: ChatRun }),
    "author",
  ),

  /** 停掉一个正在答的回答位：先落库（cancelled），再取消 Run；之后到的结果丢弃。不是 running → invalid_state */
  "chat.cancelReply": def(
    z.object({ type: z.literal("chat.cancelReply"), slotId: ChatSlotId }),
    ChatReplySlot,
    "cancel",
  ),

  /**
   * 选一个附件（main 打开系统对话框，renderer 不传路径）。取消返回 null。
   * 按文件头判断类型；image 只收 png / jpeg / webp（没有 GIF，处理规则见 C-42a）；超过上限 validation_failed。
   * 按内容去重（D-34a）。选了没发的由 main 按 C-32 的规则清理
   */
  "chat.attachment.pick": def(
    z.object({ type: z.literal("chat.attachment.pick"), kind: z.enum(["image", "file"]) }),
    ChatAttachment.nullable(),
    "author",
  ),

  /**
   * 交一段录音给 main（renderer 录的，没有文件路径）。main 转成 16k 单声道存下，返回 transcribing，
   * 转写完成后推 chat.voice.updated。超过 CHAT_LIMITS.voiceMaxMs 或 voiceImportMaxBytes → validation_failed。
   * 转写只在主控机本地做（D-34b），不上传第三方
   */
  "chat.voice.import": def(
    z.object({
      type: z.literal("chat.voice.import"),
      format: z.enum(["wav", "webm", "ogg"]),
      /** 原始录音的 base64。解码后不超过 CHAT_LIMITS.voiceImportMaxBytes */
      data: z.string().min(1).max(Math.ceil(CHAT_LIMITS.voiceImportMaxBytes / 3) * 4).regex(/^[A-Za-z0-9+/]+={0,2}$/),
    }),
    VoiceRecording,
    "author",
  ),

  /** 往表情库里加一张（main 打开选图对话框；只收静态 png / jpeg / webp）。取消返回 null；超过 CHAT_LIMITS.stickersMax → invalid_state */
  "chat.sticker.add": def(
    z.object({ type: z.literal("chat.sticker.add"), label: z.string().trim().min(1).max(40) }),
    Sticker.nullable(),
    "author",
  ),

  "chat.sticker.update": def(
    z.object({ type: z.literal("chat.sticker.update"), stickerId: StickerId, label: z.string().trim().min(1).max(40) }),
    Sticker,
    "author",
  ),

  /** 从表情库移除。已经发出去的消息里的表情不受影响（图片还被消息引用，不会被清理） */
  "chat.sticker.remove": def(
    z.object({ type: z.literal("chat.sticker.remove"), stickerId: StickerId }),
    z.object({}),
    "author",
  ),

  /**
   * 一键转议题：选中的消息 → 新议题 + 一条 chat_material 初始材料（同一事务）。之后照讨论室流程盖章发送，创建本身不发给任何人。
   * messageIds 必须都在这个会话里、不重复；有被排除的消息（isExcludedFromContext）→ invalid_state。
   * 整理出的材料超过 Message.content 的上限（2,000,000 字）→ validation_failed，在事务开始前检查，不会留下没有材料的议题
   */
  "chat.toTopic": def(
    z.object({
      type: z.literal("chat.toTopic"),
      conversationId: ConversationId,
      messageIds: z.array(ChatMessageId).min(1).max(CHAT_LIMITS.toTopicMaxMessages).refine((xs) => new Set(xs).size === xs.length, "不能重复"),
      name: z.string().min(1).max(200),
    }),
    z.object({ project: Project, material: Message }),
    "author",
  ),

  // ---------------------------------------------------------------- 媒体任务（C-42b，ADR-004）

  /**
   * 画一张图：你点了请求卡上的「画」，或用了 /画（authorization = user_tap）。沉浸模式的自动画图不走这条命令，由 main 内部发起。
   * - backend = auto：按 85% 规则选路（见 media.ts）
   * - backend = codex（手动）：额度 ≥ 阈值或读不到时，confirmOverThreshold 必须为 true，否则 invalid_state（message 写明当前百分比）；
   *   ≥ 100% 或在用 credits 时一律 invalid_state
   * - 同一个 source + 同样的 draw 已经有没结束的任务时，返回那个任务，不重复建
   * - source 由 main 按存下来的消息核对：消息不存在、不在这个会话 / 议题里，或 source.agent 和那条消息的作者对不上 → validation_failed。
   *   任务里记的 source 用 main 查到的，不用 renderer 传来的
   * 返回新建（queued）的任务；之后的变化走 media.updated 事件
   */
  "draw.start": def(
    z.object({
      type: z.literal("draw.start"),
      request: DrawRequest,
      source: MediaSource,
      confirmOverThreshold: z.boolean().optional(),
    }),
    MediaJob,
    "author",
  ),

  /** 取消一个任务（queued 或 running）。已经结束的：invalid_state */
  "media.cancel": def(z.object({ type: z.literal("media.cancel"), jobId: MediaJobId }), MediaJob, "cancel"),

  /**
   * 会话 / 议题的「停」：取消这个范围里所有 queued 和 running 的任务（cancelReason = user_stop），取消之后才到的结果丢弃。
   * 一次性的：沉浸模式仍然开着。返回被取消的任务
   */
  "media.stop": def(z.object({ type: z.literal("media.stop"), scope: MediaScope }), z.array(MediaJob), "cancel"),

  /**
   * C-42c：你点了一条秘书回答的「播放」（authorization = user_play）。source 指向那条回答，main 自己取正文做朗读过滤（speakableText），
   * 不接受 renderer 传来的文字。缓存（键见 speech.ts，含语速）命中直接返回音频；否则建一个语音任务。
   * - source 以存下来的回答为准：消息不存在、不是秘书的回答，或 source.agent 和那条回答的作者对不上 → validation_failed。
   *   用谁的声音只看那条回答的作者，不看 renderer 传来的 agent
   * - 秘书没选声音、回答过滤后为空或超过 SPEAK_MAX_CHARS：validation_failed
   */
  "speech.play": def(
    z.object({ type: z.literal("speech.play"), source: MediaSource }),
    z.discriminatedUnion("cached", [
      z.object({ cached: z.literal(true), clip: SpeechClip }),
      z.object({ cached: z.literal(false), job: MediaJob }),
    ]),
    "author",
  ),

  /**
   * C-42d：改一个聊天会话的沉浸模式设置（整份替换）。会话 id 的格式由 C-34 定。
   * 从开到关时，这个会话所有 queued / running 的媒体任务取消（cancelReason = immersive_off）
   */
  "immersive.update": def(
    z.object({ type: z.literal("immersive.update"), conversationId: ConversationId, settings: ImmersiveSettings }),
    ImmersiveSettings,
    "author",
  ),
} as const;

/** 按键排序的 JSON（数组保持顺序），用来给发送意图判等 */
const stableJson = (v: unknown): string =>
  Array.isArray(v)
    ? `[${v.map(stableJson).join(",")}]`
    : v !== null && typeof v === "object"
      ? `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`).join(",")}}`
      : JSON.stringify(v);

/** chat.send 的发送意图（防重复判等用）：除 type、messageId 以外的全部字段，按键排序的 JSON。main 存它的 sha256 */
export const chatSendIntentJson = (req: CommandRequest<"chat.send">): string =>
  stableJson({
    conversationId: req.conversationId,
    content: req.content,
    mentions: req.mentions,
    quoteMessageId: req.quoteMessageId,
    replacesMessageId: req.replacesMessageId,
    // C-42c：只在开了时才进意图，所以没开的发送和 C-42c 之前算出来的 hash 一样
    ...(req.replyAsVoice ? { replyAsVoice: true } : {}),
  });

// ================================================================ Queries

export const QUERIES = {
  "system.status": def(z.object({ type: z.literal("system.status") }), SystemStatus, "read"),

  /** 还没配置过节点时 reviewerNode 为 null */
  "settings.get": def(
    z.object({ type: z.literal("settings.get") }),
    z.object({ reviewerNode: ReviewerNodeSettings.nullable() }),
    "admin",
  ),

  /** 外观设置（C-32）。还没设置过时返回 DEFAULT_APPEARANCE */
  "appearance.get": def(z.object({ type: z.literal("appearance.get") }), AppearanceSettings, "read"),

  "projects.list": def(z.object({ type: z.literal("projects.list") }), z.array(Project), "read"),

  "messages.list": def(
    z.object({ type: z.literal("messages.list"), projectId: ProjectId }),
    z.array(Message),
    "read",
  ),

  "contributions.list": def(
    z.object({ type: z.literal("contributions.list"), projectId: ProjectId }),
    z.array(Contribution),
    "read",
  ),

  "snapshots.get": def(
    z.object({ type: z.literal("snapshots.get"), snapshotId: SnapshotId }),
    PromptSnapshot,
    "read",
  ),

  "approvals.list": def(
    z.object({
      type: z.literal("approvals.list"),
      projectId: ProjectId,
      /** 不传则返回全部 */
      pendingOnly: z.boolean().optional(),
    }),
    z.array(Approval),
    "read",
  ),

  "runs.list": def(
    z.object({
      type: z.literal("runs.list"),
      projectId: ProjectId,
      limit: z.number().int().min(1).max(200).optional(),
    }),
    z.array(Run),
    "read",
  ),

  "runs.get": def(z.object({ type: z.literal("runs.get"), runId: RunId }), Run, "read"),

  /** 回放某个 run 的事件；断线或重启后补齐 UI */
  "runs.events": def(
    z.object({
      type: z.literal("runs.events"),
      runId: RunId,
      afterSeq: z.number().int().min(-1).optional(),
    }),
    z.array(AgentEvent),
    "read",
  ),

  // ---------------------------------------------------------------- 讨论室（ADR-002 / C-20）

  "nodes.list": def(z.object({ type: z.literal("nodes.list") }), z.array(NodeInfo), "admin"),

  "agents.list": def(z.object({ type: z.literal("agents.list") }), z.array(AgentProfile), "read"),

  /** 读不到的额度字段为 null（界面显示「未知」） */
  "agents.status": def(z.object({ type: z.literal("agents.status") }), z.array(AgentStatus), "read"),

  "rounds.list": def(
    z.object({ type: z.literal("rounds.list"), projectId: ProjectId }),
    z.array(Round),
    "read",
  ),

  "rounds.get": def(
    z.object({ type: z.literal("rounds.get"), roundId: RoundId }),
    z.object({
      round: Round,
      batches: z.array(ApprovalBatch),
      turns: z.array(Turn),
      summary: RoundSummary.nullable(),
    }),
    "read",
  ),

  /** 确认页用：批次 + 每个收件人的完整 Snapshot（逐字查看） */
  "batches.get": def(
    z.object({ type: z.literal("batches.get"), batchId: BatchId }),
    z.object({ batch: ApprovalBatch, snapshots: z.array(PromptSnapshot) }),
    "read",
  ),

  "plans.list": def(
    z.object({ type: z.literal("plans.list"), projectId: ProjectId }),
    z.array(PlanVersion),
    "read",
  ),
  // ---------------------------------------------------------------- 聊天空间（C-34）

  /** 会话列表：置顶的在前，其余按 lastActivityAt 倒序 */
  "chat.conversations.list": def(
    z.object({ type: z.literal("chat.conversations.list") }),
    z.array(ConversationListItem),
    "read",
  ),

  "chat.conversations.get": def(
    z.object({ type: z.literal("chat.conversations.get"), conversationId: ConversationId }),
    Conversation,
    "read",
  ),

  /**
   * 消息分页，按 (createdAt, id) 倒序：不传 before 从最新开始；nextCursor 为 null 表示到头了。
   * 已撤回的消息也返回（界面显示「你撤回了一条消息」，详情里能看原文）。
   * slots 是本页里你发的消息的全部回答位
   */
  "chat.messages.list": def(
    z.object({
      type: z.literal("chat.messages.list"),
      conversationId: ConversationId,
      before: ChatCursor.optional(),
      limit: z.number().int().min(1).max(100).optional(),
    }),
    z.object({ messages: z.array(ChatMessage), slots: z.array(ChatReplySlot), nextCursor: ChatCursor.nullable() }),
    "read",
  ),

  /** 一个回答位的所有尝试（attempt 从小到大） */
  "chat.slots.runs": def(
    z.object({ type: z.literal("chat.slots.runs"), slotId: ChatSlotId }),
    z.array(ChatRun),
    "read",
  ),

  "chat.runs.get": def(z.object({ type: z.literal("chat.runs.get"), runId: RunId }), ChatRun, "read"),

  /** 逐字查看主控端拼的部分（不含记忆正文，主控端没有） */
  "chat.snapshots.get": def(
    z.object({ type: z.literal("chat.snapshots.get"), snapshotId: SnapshotId }),
    ChatSnapshot,
    "read",
  ),

  "chat.summaries.list": def(
    z.object({ type: z.literal("chat.summaries.list"), conversationId: ConversationId }),
    z.array(ChatHistorySummary),
    "read",
  ),

  "chat.voice.get": def(z.object({ type: z.literal("chat.voice.get"), audio: AudioRef }), VoiceRecording, "read"),

  "chat.stickers.list": def(z.object({ type: z.literal("chat.stickers.list") }), z.array(Sticker), "read"),

  /** C-42b：请求卡打开时预览这次会走哪条路（会现读一次 Codex 额度，2 秒超时） */
  "draw.preview": def(
    z.object({ type: z.literal("draw.preview"), request: DrawRequest }),
    DrawRoutePreview,
    "read",
  ),

  /** C-42c：能选的声音（来自本机语音合成引擎）；引擎没装好时为空数组 */
  "voices.list": def(z.object({ type: z.literal("voices.list") }), z.array(VoiceOption).max(200), "read"),

  /** C-42d：会话的沉浸模式设置和最近 60 分钟的用量；没设置过返回 DEFAULT_IMMERSIVE_SETTINGS */
  "immersive.get": def(
    z.object({ type: z.literal("immersive.get"), conversationId: ConversationId }),
    z.object({ settings: ImmersiveSettings, usage: ImmersiveUsage }),
    "read",
  ),

  "media.get": def(z.object({ type: z.literal("media.get"), jobId: MediaJobId }), MediaJob, "read"),

  /**
   * 一个范围里的媒体任务，按创建时间倒序，最多 200 条。
   * C-42f：messageIds（只用于 chat 范围）= 只要这些消息的任务（source.messageId 在其中）。界面按当前加载的那页消息去查，
   * 会话累计超过 200 条任务后旧消息的图仍然找得回来，请求卡也不会因为查不到任务而重复出现。
   * - 每条消息每一类（draw / speech）返回最新 MEDIA_LIST_PER_MESSAGE_KIND_LATEST 条，再加最新一条成功的、最新一条没结束的
   *   （不在前面那几条里时），每类最多 MEDIA_LIST_PER_MESSAGE_KIND_MAX 条；挑法和 media.ts 的 pickMessageMediaJobs 一致。
   *   成功画过的图不会被后来的几次失败 / 取消挤掉，界面据此判断请求卡要不要出现（林离 #116）。
   *   messageIds 最多 MEDIA_LIST_MESSAGE_IDS_MAX 个。14 × 2 类 × 7 = 196 ≤ 200，所以一次查询**每条消息、每一类都查得到**，
   *   不会被别的消息或另一类的任务挤掉（汐 #116）。客户端按 14 条消息一批查、结果合并。
   *   更早的失败 / 取消记录只在 media.get 里，界面不需要
   * - 和 scope 取交集：不属于这个会话的 id 查不到任务，不报错
   * - topic 范围带 messageIds → validation_failed（main 校验；请求体在判别联合里，schema 层加不了跨字段校验）
   */
  "media.list": def(
    z.object({
      type: z.literal("media.list"),
      scope: MediaScope,
      messageIds: z
        .array(ChatMessageId)
        .min(1)
        .max(MEDIA_LIST_MESSAGE_IDS_MAX)
        .refine((xs) => new Set(xs).size === xs.length, "不能重复")
        .optional(),
    }),
    z.array(MediaJob).max(200),
    "read",
  ),
} as const;

// ================================================================ Unions & helpers

type Registry = Record<string, { request: z.ZodTypeAny; response: z.ZodTypeAny; scope: ControlScope }>;
type Requests<R extends Registry> = { [K in keyof R]: R[K]["request"] }[keyof R];

const requestsOf = <R extends Registry>(r: R) =>
  Object.values(r).map((d) => d.request) as unknown as [Requests<R>, Requests<R>, ...Requests<R>[]];

export const ControlCommand = z.discriminatedUnion(
  "type",
  requestsOf(COMMANDS) as unknown as [z.ZodDiscriminatedUnionOption<"type">, ...z.ZodDiscriminatedUnionOption<"type">[]],
);
export const ControlQuery = z.discriminatedUnion(
  "type",
  requestsOf(QUERIES) as unknown as [z.ZodDiscriminatedUnionOption<"type">, ...z.ZodDiscriminatedUnionOption<"type">[]],
);

export type CommandType = keyof typeof COMMANDS;
export type QueryType = keyof typeof QUERIES;

export type CommandRequest<T extends CommandType = CommandType> = z.infer<(typeof COMMANDS)[T]["request"]>;
export type CommandResponse<T extends CommandType> = z.infer<(typeof COMMANDS)[T]["response"]>;
export type QueryRequest<T extends QueryType = QueryType> = z.infer<(typeof QUERIES)[T]["request"]>;
export type QueryResponse<T extends QueryType> = z.infer<(typeof QUERIES)[T]["response"]>;

export type ControlCommand = CommandRequest;
export type ControlQuery = QueryRequest;

// ================================================================ Results

export const ControlErrorCode = z.enum([
  "validation_failed", // 入参不符合 schema
  "forbidden",         // 客户端没有所需 scope
  "not_found",
  "invalid_state",     // 状态机不允许这个转换
  "stale_snapshot",    // expectedSnapshotHash 与当前 snapshot 不一致
  "already_decided",   // 审批或权限请求已经有结果
  "reviewer_not_configured",
  "agent_unavailable", // 讨论室：收件人离线、未配置、被暂停或额度缺席；聊天：重试时这位仍然不能答
  "rate_limited",      // C-34：聊天每个会话每分钟的条数超了
  "idempotency_conflict", // C-34：同一个 messageId 发了不一样的内容
  "internal",
]);
export type ControlErrorCode = z.infer<typeof ControlErrorCode>;

export const ControlError = z.object({
  ok: z.literal(false),
  error: ControlErrorCode,
  /** 给人看的说明。不包含密钥、不包含 prompt 原文 */
  message: z.string(),
});
export type ControlError = z.infer<typeof ControlError>;

export type ControlResult<T> = { ok: true; data: T } | ControlError;

export const controlResult = <T extends z.ZodTypeAny>(data: T) =>
  z.discriminatedUnion("ok", [z.object({ ok: z.literal(true), data }), ControlError]);

// ================================================================ Events（Orchestrator → 所有客户端）

export const ControlEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("message.created"), message: Message }),
  z.object({ type: z.literal("approval.updated"), approval: Approval }),
  z.object({ type: z.literal("run.updated"), run: Run }),
  z.object({ type: z.literal("run.event"), event: AgentEvent }),
  z.object({ type: z.literal("permission.requested"), runId: RunId, request: PermissionRequest }),
  // ---- 讨论室（ADR-002 / C-20）
  z.object({ type: z.literal("round.updated"), round: Round }),
  z.object({ type: z.literal("batch.updated"), batch: ApprovalBatch }),
  z.object({ type: z.literal("turn.updated"), turn: Turn }),
  z.object({ type: z.literal("summary.created"), summary: RoundSummary }),
  z.object({ type: z.literal("plan.updated"), plan: PlanVersion }),
  z.object({ type: z.literal("agent.status"), status: AgentStatus }),
  // ---- 聊天空间（C-34）。秘书回答的流式文字照旧是 run.event
  z.object({ type: z.literal("chat.conversation.updated"), conversation: Conversation }),
  z.object({ type: z.literal("chat.message.created"), message: ChatMessage }),
  /** 只有你的消息会更新（撤回） */
  z.object({ type: z.literal("chat.message.updated"), message: UserChatMessage }),
  z.object({ type: z.literal("chat.slot.updated"), slot: ChatReplySlot }),
  z.object({ type: z.literal("chat.run.updated"), run: ChatRun }),
  z.object({ type: z.literal("chat.summary.updated"), summary: ChatHistorySummary }),
  z.object({ type: z.literal("chat.voice.updated"), recording: VoiceRecording }),
  // ---- 媒体任务（C-42b）
  z.object({ type: z.literal("media.updated"), job: MediaJob }),
]);
export type ControlEvent = z.infer<typeof ControlEvent>;
