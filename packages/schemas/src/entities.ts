import { z } from "zod";
import { AttachmentManifest } from "./attachments";
import {
  ApprovalId,
  ChatMessageId,
  CommitSha,
  ConversationId,
  IsoTimestamp,
  prefixedId,
  RoundId,
  RunId,
  Sha256Hex,
  SnapshotId,
  TurnId,
} from "./common";
import { FailureReason } from "./agent-event";
import { ApprovalState, RunState, RunSubstate } from "./state-machines";

/**
 * Phase 0 实体（C-01b）。
 * 这里定义的是跨 IPC 传输的记录形状。数据库表结构由 D-02 决定，但读出来必须能 parse 成这些类型。
 */

export const ProjectId = prefixedId("proj");
export const MessageId = prefixedId("msg");
export const ContributionId = prefixedId("c");

export type ProjectId = z.infer<typeof ProjectId>;
export type MessageId = z.infer<typeof MessageId>;
export type ContributionId = z.infer<typeof ContributionId>;

/** 来源 Agent 的名字，例如 "deepseek"、"codex"、"human"。只是标签，不做枚举限制 */
export const AgentName = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);

// ---------------------------------------------------------------- Project

export const Project = z.object({
  id: ProjectId,
  name: z.string().min(1).max(200),
  /** C-34：从哪个聊天会话转来（chat.toTopic）；不是转来的为 null */
  fromConversationId: ConversationId.nullable(),
  createdAt: IsoTimestamp,
});
export type Project = z.infer<typeof Project>;

// ---------------------------------------------------------------- Message（不可变原始记录）

const messageBase = {
  id: MessageId,
  projectId: ProjectId,
  /** 原文。写入后永不修改（V0.3 §17） */
  content: z.string().min(1).max(2_000_000),
  createdAt: IsoTimestamp,
};

export const Message = z.discriminatedUnion("kind", [
  /** 用户手动粘贴的 Source Agent 输出或项目材料（AC-1） */
  z.object({ ...messageBase, kind: z.literal("source_input"), sourceAgent: AgentName }),
  /** Reviewer 的输出，一定属于某个 run（AC-8） */
  z.object({ ...messageBase, kind: z.literal("reviewer_output"), sourceAgent: AgentName, runId: RunId }),

  // ---- 讨论室（ADR-002 / C-20）。以下三种只出现在讨论议题里
  /** 用户的议题或插话（「只发言」不会发给任何 Agent）。roundId 为 null 表示在两轮之间说的 */
  z.object({ ...messageBase, kind: z.literal("human_note"), roundId: RoundId.nullable() }),
  /**
   * Agent 在某一轮的正式回答。只在 Turn 结局为 answered 时写入，和 Run 的终态同一事务。
   * onBehalfOf 非 null 表示替补代答（标「代 X」），汇总时单独一栏、不算票
   */
  z.object({
    ...messageBase,
    kind: z.literal("agent_reply"),
    sourceAgent: AgentName,
    onBehalfOf: AgentName.nullable(),
    roundId: RoundId,
    turnId: TurnId,
    runId: RunId,
  }),
  /** 汇总者的汇总全文。结构化部分（谁同意了什么）在 RoundSummary 里 */
  z.object({
    ...messageBase,
    kind: z.literal("summary"),
    sourceAgent: AgentName,
    roundId: RoundId,
    turnId: TurnId,
    runId: RunId,
  }),
  /**
   * C-34：从聊天转来的初始材料（chat.toTopic），和议题在同一事务里建。
   * content 是 main 按选中消息的时间顺序整理出的文字记录（谁、什么时候、说了什么；语音用转写，表情用说明，
   * 图片和文件用「[图片：文件名]」「[文件：文件名]」占位），之后按附件规则进不可信边界。
   * 被撤回的消息不能选（invalid_state）；它的回答也不能选
   */
  z.object({
    ...messageBase,
    kind: z.literal("chat_material"),
    conversationId: ConversationId,
    chatMessageIds: z.array(ChatMessageId).min(1).max(200),
  }),
]);
export type Message = z.infer<typeof Message>;

// ---------------------------------------------------------------- Contribution

export const ContributionType = z.enum([
  "proposal",
  "issue",
  "risk",
  "counterexample",
  "correction",
  "implementation",
  "review",
  "decision_candidate",
  "test_result",
  "evidence",
  "open_question",
]);
export type ContributionType = z.infer<typeof ContributionType>;

/** 在来源 Message.content 中的位置，单位是 UTF-16 code unit（即 JS 字符串下标），左闭右开 */
export const TextSelection = z
  .object({
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
  })
  .refine((s) => s.end > s.start, { message: "end must be greater than start" });
export type TextSelection = z.infer<typeof TextSelection>;

export const Contribution = z.object({
  id: ContributionId,
  projectId: ProjectId,
  sourceMessageId: MessageId,
  type: ContributionType,
  title: z.string().min(1).max(200),
  /**
   * 不变量：content === sourceMessage.content.slice(selection.start, selection.end)
   * 由后端在创建时从 selection 截取，renderer 不提交 content。
   */
  content: z.string().min(1),
  selection: TextSelection,
  confidence: z.number().min(0).max(1).nullable(),
  /** Phase 0 只有 human；agent / local_model 留给 Phase 2 的自动抽取 */
  createdBy: z.enum(["human", "agent", "local_model"]),
  schemaVersion: z.literal(1),
  createdAt: IsoTimestamp,
});
export type Contribution = z.infer<typeof Contribution>;

// ---------------------------------------------------------------- PromptSnapshot

export const PromptSnapshot = z.object({
  id: SnapshotId,
  projectId: ProjectId,
  /** 实际发给 Reviewer 的完整原文。创建后不可修改（AC-4） */
  content: z.string().min(1),
  /** sha256(UTF-8(content))（AC-5） */
  contentHash: Sha256Hex,
  /** 这次拼装用的边界 nonce（V0.4 §15） */
  nonce: z.string().regex(/^[a-f0-9]{16,64}$/),
  /**
   * 单次评审（Phase 0）的 Snapshot 至少一个片段——由 snapshot.create 的入参保证（min 1）。
   * 讨论室（C-20）的 Snapshot 由讨论记录拼成，没有片段，这里为空数组。
   */
  contributionIds: z.array(ContributionId),
  /** 用户写的评审任务说明 */
  taskInstruction: z.string().min(1).max(20_000),
  /**
   * 生成时 Reviewer 节点设置里的 profileId（未配置时为 "unconfigured"）。
   * 批准时节点当前的 profileId 必须与它相同，否则拒绝（invalid_state）：
   * 人批准的是「这份内容发给这个 profile」，不能静默换成别的执行方式。
   */
  reviewerAgent: AgentName,
  /** Prompt 拼装器版本，改拼装逻辑时递增 */
  adapterVersion: z.string().min(1),
  /** 粗略估算，只用于 UI 展示 */
  tokenEstimate: z.number().int().nonnegative(),
  /** Phase 0 没有 Synthesis 和 git，以下均为 null */
  synthesisVersion: z.number().int().nonnegative().nullable(),
  branch: z.string().nullable(),
  commitSha: CommitSha.nullable(),
  /**
   * C-42a：这份内容附带的图片清单（权威记录）。不带图时省略；1A 及以前的 Snapshot 读出来没有这个字段。
   * 清单也以 attachmentManifestBlock 写在 content 开头，所以 contentHash 已经覆盖它
   */
  attachments: AttachmentManifest.optional(),
  createdAt: IsoTimestamp,
});
export type PromptSnapshot = z.infer<typeof PromptSnapshot>;

// ---------------------------------------------------------------- Approval

export const Approval = z.object({
  id: ApprovalId,
  projectId: ProjectId,
  snapshotId: SnapshotId,
  state: ApprovalState,
  /** 审批时使用的客户端，为以后手机审批留痕 */
  decidedVia: z.enum(["desktop", "mobile"]).nullable(),
  reason: z.string().max(2000).nullable(),
  createdAt: IsoTimestamp,
  decidedAt: IsoTimestamp.nullable(),
});
export type Approval = z.infer<typeof Approval>;

// ---------------------------------------------------------------- Run

export const Run = z.object({
  id: RunId,
  projectId: ProjectId,
  /** 唯一：一个 Approval 最多对应一个 Run */
  approvalId: ApprovalId,
  snapshotId: SnapshotId,
  adapterId: z.string().min(1),
  state: RunState,
  /** 只在 RUNNING 时非 null */
  substate: RunSubstate.nullable(),
  /** 只在 FAILED 时非 null */
  failureReason: FailureReason.nullable(),
  createdAt: IsoTimestamp,
  startedAt: IsoTimestamp.nullable(),
  finishedAt: IsoTimestamp.nullable(),
});
export type Run = z.infer<typeof Run>;

// ---------------------------------------------------------------- 系统状态

export const SystemStatus = z.object({
  appVersion: z.string(),
  /** Reviewer 节点和 Token 是否都已配置（Token 能解密）。只返回布尔值，Token 永远不离开 main 进程 */
  reviewerConfigured: z.boolean(),
  /** 当前节点设置里的 profileId；未配置时为 "unconfigured" */
  reviewerAgent: AgentName,
  /** 启动时修复了多少个中断的 run（V0.4 §24），用于 UI 提示 */
  recoveredRuns: z.number().int().nonnegative(),
});
export type SystemStatus = z.infer<typeof SystemStatus>;
