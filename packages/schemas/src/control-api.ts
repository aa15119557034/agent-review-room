import { z } from "zod";
import { AppearanceSettings, ChatBackground, ImagePurpose, ImageRef } from "./appearance";
import { ApprovalId, BatchId, PermissionRequestId, PlanVersionId, RoundId, RunId, Sha256Hex, SnapshotId } from "./common";
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
  NodeId,
  PlanVersion,
  Round,
  RoundSummary,
  TaskSource,
  Turn,
} from "./discussion";

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
/** 主控机本机节点的 id（S-10 / C-27 的推荐配置）。node.importLocalToken 只对它可用 */
export const LOCAL_NODE_ID = "controller-local";

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
    }),
    AgentProfile,
    "admin",
  ),

  /**
   * 主控机节点一键读取本机 Token（C-39）。
   * - 只对 id 是 LOCAL_NODE_ID（"controller-local"）**并且** baseUrl 是本机回环地址（127.0.0.1 / localhost / [::1]）的节点可用，
   *   否则 invalid_state
   * - Token 文件的位置：main 的 settings.json 里的 `localAgentServerTokenFile`（只在 main 里，不经过控制 API，renderer 改不了）；
   *   没配置时用主控机 AgentServer 的默认位置。**请求里不能带路径**
   * - 读到的值按 NodeToken 校验，只写进 safeStorage，不回显；日志里不写 token，也不写文件路径
   * - 失败分类：节点不存在或 Token 文件不存在 → not_found；文件读不了（权限等）→ internal；内容不合 NodeToken → validation_failed
   * - 成功后 renderer 自己再调一次 node.test（这条命令只负责导入）
   */
  "node.importLocalToken": def(
    z.object({ type: z.literal("node.importLocalToken"), id: z.literal(LOCAL_NODE_ID) }),
    NodeInfo,
    "admin",
  ),

  // ---------------------------------------------------------------- 外观（C-32，阶段 1B-1）

  /**
   * 打开系统的选图对话框（由 main 打开，renderer 不传路径）。
   * 取消返回 null；类型不对（按文件头判断）或超过 IMAGE_MAX_BYTES[purpose]：validation_failed。
   * 选中的图先存下来、还没被引用；之后 agent.update / appearance.update 用上它才算数，没用上的由 main 清理
   */
  "image.pick": def(
    z.object({ type: z.literal("image.pick"), purpose: ImagePurpose }),
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
} as const;

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
  "agent_unavailable", // 讨论室：收件人离线、未配置、被暂停或额度缺席
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
]);
export type ControlEvent = z.infer<typeof ControlEvent>;
