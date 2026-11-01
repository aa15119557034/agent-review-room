import { z } from "zod";
import {
  ApprovalId,
  BatchId,
  IsoTimestamp,
  PlanVersionId,
  RoundId,
  RunId,
  Sha256Hex,
  SnapshotId,
  TurnId,
} from "./common";
import { AgentName, MessageId, ProjectId } from "./entities";
import { ApprovalState, PlanState, RoundState, TurnOutcome } from "./state-machines";
import { EffortId, ModelId, ProfileId, RunModel } from "./remote-protocol";
import { ImageRef } from "./appearance";
import { AttachmentManifest } from "./attachments";
import { VoiceProfile } from "./speech";

/**
 * 讨论室模式的实体（ADR-002 / C-20，阶段 1A）。
 *
 * 和 Phase 0 的关系：
 * - 议题 = Project（不新增实体）
 * - 每个收件人仍然是「一份 PromptSnapshot + 一个 Approval + 至多一个 Run」，Phase 0 的不变量原样保留
 * - 新增的 ApprovalBatch 把一轮里的多个 Approval 绑在一起：用户盖一次章，同一事务里全部批准
 * - Turn 把「谁、在哪一轮、第几次发言、结局如何」记下来，Run 本身的状态机不变
 */

// ================================================================ 参与者

/** 节点 id（主控端给每个 AgentServer 起的名字），例如 "user-pc"、"controller-local" */
export const NodeId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
export type NodeId = z.infer<typeof NodeId>;

/** 头像颜色等用到的 #rrggbb */
export const HexColor = z.string().regex(/^#[0-9a-f]{6}$/);

/** 在什么场合发言。每个场合各有默认的思考强度（C-40） */
export const RunOccasion = z.enum(["chat", "discussion", "summary"]);
export type RunOccasion = z.infer<typeof RunOccasion>;

/**
 * 参与者的模型设置（C-40）。保存时只校验格式，不连节点；是否可用在起草时按节点当时的上报判断。
 *
 * 起草（round.draft / round.redraft / round.summarize / 补充 / 重试 / 恢复 等所有生成批次的命令）时，
 * main 对每个收件人按下面的顺序定下 BatchItem.model，定下之后这一批就不再变：
 * 1. 下面任一情况 → model = null（用 profile 自带的模型和强度，各场合的 effort 不用）：
 *    节点没报 profileModels；profileModels 里没有这个 profile；这个 profile 的 models 为空（模型写死）；primaryModel 为 null
 * 2. primaryModel 在这个 profile 的 models 里 → 用首选
 * 3. 否则 fallbackModel 在里面 → 用备选，usedFallback = true
 * 4. 都不在 → agent_unavailable（message 里写明是谁、哪个模型不可用），整批不生成
 * 强度（只在选中了模型时）：这个场合的 effort 在所选模型的 efforts 里 → 用它，effortSource = "configured"；
 * 否则（包括设为 null、或档位名在这个模型上不存在）→ 用节点报的 defaultEffort，effortSource = "node_default"；
 * 所选模型没有档位（efforts 为空）→ effort = null，effortSource = "none"。
 * 重试（retry）和恢复（resume）：先沿用被重试 / 恢复的那个 Turn 原来的 BatchItem.model（原来是 null 就照上面重选）；
 * 节点已不支持它时，再按上面 1～4 重选。确认页每次都逐人显示模型和强度。
 * 盖章之后不再换模型：运行时节点拒绝（unknown_model）就按 remote_rejected 失败，额度用尽照旧走缺席 / 替补。
 */
export const AgentModelSettings = z.object({
  /** null = 不选，用节点 profile 自带的模型 */
  primaryModel: ModelId.nullable(),
  /** 首选不可用时的备选；null = 没有备选。不能和首选相同 */
  fallbackModel: ModelId.nullable(),
  /** 各场合的思考强度；null = 用节点报的 defaultEffort */
  effort: z.object({
    chat: EffortId.nullable(),
    discussion: EffortId.nullable(),
    summary: EffortId.nullable(),
  }),
}).refine(
  (s) => s.fallbackModel === null || (s.primaryModel !== null && s.fallbackModel !== s.primaryModel),
  "备选模型要和首选不同，且必须先设了首选",
);
export type AgentModelSettings = z.infer<typeof AgentModelSettings>;

/** 没有设置过的参与者：全部跟随节点 */
export const DEFAULT_AGENT_MODEL_SETTINGS: AgentModelSettings = {
  primaryModel: null,
  fallbackModel: null,
  effort: { chat: null, discussion: null, summary: null },
};

/**
 * 批次里定下的模型。确认页逐人显示。
 * 盖章（batch.approve 的 expected.model）和 StartRun.model 都只收 RunModel（{ model, effort }，strict），
 * 不能把整个 BatchModel 传过去，要先用 toRunModel 投影；usedFallback / effortSource 只留在批次和确认页里。
 */
export const BatchModel = RunModel.extend({
  /** 首选不可用、改用了备选。确认页要标出来 */
  usedFallback: z.boolean(),
  /**
   * effort 从哪来：configured = 用户设的这个场合的档位；node_default = 用户设的不在这个模型的档位里（或没设），
   * 改用节点的 defaultEffort，确认页要标出来；none = 这个模型没有档位，effort 为 null
   */
  effortSource: z.enum(["configured", "node_default", "none"]),
}).strict().refine((m) => (m.effortSource === "none") === (m.effort === null), "没有档位时 effort 为 null，反之亦然");
export type BatchModel = z.infer<typeof BatchModel>;

/** BatchModel → RunModel：去掉只给人看的两个标记 */
export const toRunModel = (m: BatchModel): RunModel => ({ model: m.model, effort: m.effort });

/**
 * 参与者的记忆来源配置（ADR-003 §2 / C-34）。
 * - nodeFolder：聊天回答前由节点读它自己配置的记忆文件夹。**主控端只存这个开关**，不存路径、不存正文；
 *   这个聊天 profile 不在 NodeHealth.memoryProfiles 里时，界面显示「此记忆来源不可用」
 * 本会话的历史（最近的全文 + 更早的摘要）总是带上，不用配置。claude.ai / ChatGPT / DeepSeek 网页里的云端记忆读不到，也不去读本机凭据。
 */
export const MemorySource = z.object({ nodeFolder: z.boolean() }).strict();
export type MemorySource = z.infer<typeof MemorySource>;

export const DEFAULT_MEMORY_SOURCE: MemorySource = { nodeFolder: false };

/** 聊天人设的上限（ADR-003「上限另定」）。和 CHAT_LIMITS.chatPersonaMaxChars 相同 */
export const CHAT_PERSONA_MAX_CHARS = 50_000;

export const AgentProfile = z.object({
  /** 也是消息里的 sourceAgent，例如 "claude"、"deepseek"、"codex" */
  id: AgentName,
  displayName: z.string().min(1).max(40),
  color: HexColor,
  /** 头像图片的引用（C-32，见 appearance.ts）；null 时显示首字 */
  avatarRef: ImageRef.nullable(),
  /** 角色设定，加在发给它的指令最前面（不在不可信边界里，因为是用户写的） */
  roleNote: z.string().max(2000),
  canDiscuss: z.boolean(),
  canSummarize: z.boolean(),
  /** 阶段 1C 才会用到 */
  canExecute: z.boolean(),
  /** 运行在哪个节点的哪个 profile 上；未配置时为 null */
  nodeId: NodeId.nullable(),
  profileId: ProfileId.nullable(),
  /** 用户手动暂停（和额度缺席不同：额度缺席由系统判断，见 AgentStatus） */
  pausedByUser: z.boolean(),
  /** 额度用尽时，讨论里由谁替补；null = 不找替补，记为缺席。替补不能是本议题的汇总者 */
  substitute: AgentName.nullable(),
  /** C-40：首选 / 备选模型和各场合的思考强度 */
  modelSettings: AgentModelSettings,
  /**
   * C-34：聊天人设（完整版，可以很长），和讨论室的三句 roleNote 分开。在可信指令区，因为是你写的。
   * 空字符串 = 还没写，聊天时只用 roleNote
   */
  chatPersona: z.string().max(CHAT_PERSONA_MAX_CHARS),
  /**
   * C-34：聊天用的 profile（例如 "claude-chat"），和 profileId（讨论用）分开：只读、无工具，Codex 用单独的 CODEX_HOME（S-20）。
   * 和 profileId 在同一个节点（nodeId）上。null = 没配，聊天里这位的回答位记 unavailable(unconfigured)
   */
  chatProfileId: ProfileId.nullable(),
  /** C-34：记忆来源 */
  memorySource: MemorySource,
  /** C-42c：秘书的声音；没有 = 还没选，不合成语音 */
  voice: VoiceProfile.nullable().optional(),
});
export type AgentProfile = z.infer<typeof AgentProfile>;

/** 一个窗口的额度：5 小时 / 每周。读不到就整个为 null，界面显示「未知」，不猜 */
export const QuotaWindow = z.object({
  usedPercent: z.number().min(0).max(100),
  resetsAt: IsoTimestamp.nullable(),
});
export type QuotaWindow = z.infer<typeof QuotaWindow>;

/**
 * C-36：这一轮谁替谁答（ADR-002 §3「替补代答」，状态表 #10）。
 * - absent    ：本来要答的人，必须在这一轮的收件人里
 * - substitute：代他答的人，**不在**收件人里（一个人一轮只有一个 Turn），也不能同时是别人的 absent（不做替补链）
 * 批次里对应一项 recipient = substitute、onBehalfOf = absent；发给替补的 Snapshot 用替补自己的角色设定，
 * 不带被替补者的 roleNote，题面里写明「代 X 回答」。替补不能当这一轮的汇总者（round.summarize 已经拒绝）
 */
export const RoundSubstitution = z
  .object({ absent: AgentName, substitute: AgentName })
  .strict()
  .refine((x) => x.absent !== x.substitute, "不能自己替自己");
export type RoundSubstitution = z.infer<typeof RoundSubstitution>;

export const RoundSubstitutions = z
  .array(RoundSubstitution)
  .max(8)
  .refine((xs) => new Set(xs.map((x) => x.absent)).size === xs.length, "同一个人只能有一位替补")
  .refine((xs) => new Set(xs.map((x) => x.substitute)).size === xs.length, "一位替补一轮只代一个人")
  .refine((xs) => xs.every((x) => !xs.some((y) => y.absent === x.substitute)), "替补自己不能也缺席（不做替补链）");
export type RoundSubstitutions = z.infer<typeof RoundSubstitutions>;

/**
 * C-36：一个 profile 的额度读出来是什么状态（D-32 判断自动缺席、C-37 控制台显示都用它，不各写一套）：
 * - exhausted：任一窗口 usedPercent ≥ 100，或者余额 ≤ 0
 * - ok       ：读到了至少一项，而且都没用完
 * - unknown  ：什么都没读到（节点不支持、超时、出错）。**未知不等于用完**：不因此自动缺席
 */
export type QuotaState = "ok" | "exhausted" | "unknown";

export function quotaState(q: {
  fiveHour: { usedPercent: number } | null;
  weekly: { usedPercent: number } | null;
  balance?: { amount: string } | null;
}): QuotaState {
  const windows = [q.fiveHour, q.weekly].filter((w): w is { usedPercent: number } => w !== null);
  const amount = q.balance ? Number(q.balance.amount) : null;
  const known = windows.length > 0 || (amount !== null && Number.isFinite(amount));
  if (!known) return "unknown";
  if (windows.some((w) => w.usedPercent >= 100)) return "exhausted";
  if (amount !== null && Number.isFinite(amount) && amount <= 0) return "exhausted";
  return "ok";
}

/**
 * 参与者的实时状态（节点上报 + 主控端统计）。阶段 1A 只需要 availability，其余字段在 1B 填上。
 * C-36：额度只来自节点 GET /v1/profiles/:profileId/quota（讨论用的 profileId），**读不到的项是 null，不猜、不写 0**；
 * availability = absent_quota 当且仅当 quotaState(这份状态) = exhausted，或者这位最近一个 Run 以 quota_exhausted 结束、
 * 之后还没有读到不是 exhausted 的额度。unknown 不算缺席
 */
export const AgentStatus = z.object({
  agent: AgentName,
  availability: z.enum(["available", "offline", "unconfigured", "paused_by_user", "absent_quota"]),
  billing: z.enum(["subscription", "api", "unknown"]),
  fiveHour: QuotaWindow.nullable(),
  weekly: QuotaWindow.nullable(),
  /** API 计费：余额和本月消耗，货币单位原样显示 */
  balance: z.object({ amount: z.string().max(40), currency: z.string().max(8), spentThisMonth: z.string().max(40).nullable() }).nullable(),
  /** 最近一次会话的上下文用量 */
  contextUsedPercent: z.number().min(0).max(100).nullable(),
  compactions: z.number().int().nonnegative().nullable(),
  model: z.string().max(80).nullable(),
  effort: z.string().max(20).nullable(),
  updatedAt: IsoTimestamp,
});
export type AgentStatus = z.infer<typeof AgentStatus>;

// ================================================================ 一轮

export const TaskSource = z.enum(["human", "summarizer_proposal", "carried_over"]);
export type TaskSource = z.infer<typeof TaskSource>;

/** 发给 Agent 的讨论记录怎么取：最近 2 轮全文 + 更早的用汇总代替，或者全部原文 */
export const HistoryMode = z.enum(["recent_with_summaries", "full"]);
export type HistoryMode = z.infer<typeof HistoryMode>;

export const Round = z.object({
  id: RoundId,
  projectId: ProjectId,
  /** 议题内从 1 开始递增；作废的轮也占号 */
  index: z.number().int().positive(),
  state: RoundState,
  /** 本轮任务（用户在确认页能看到、能改） */
  task: z.string().min(1).max(20_000),
  taskSource: TaskSource,
  /** 这一轮发给谁（不含汇总者，汇总是单独一批） */
  recipients: z.array(AgentName).min(1).max(8),
  /** 附带的方案版本；没有就是 null */
  planVersionId: PlanVersionId.nullable(),
  historyMode: HistoryMode,
  /** 状态为 VOIDED 时必填 */
  voidReason: z.string().max(2000).nullable(),
  /** 实际进行时长（毫秒），暂停期间不计 */
  activeMs: z.number().int().nonnegative(),
  createdAt: IsoTimestamp,
  startedAt: IsoTimestamp.nullable(),
  finishedAt: IsoTimestamp.nullable(),
});
export type Round = z.infer<typeof Round>;

/**
 * 一次盖章。kind 说明为什么要发：
 * - initial   : 这一轮第一次发出
 * - supplement: 插话补充（打断重答、或只发给一个人）
 * - resume    : 暂停后恢复，内容和原来相同
 * - retry     : 单独重试某个失败 / 超时的人
 * - summary   : 发给汇总者
 *
 * 不变量：items 里每一项对应一个 Approval（批准同一事务内完成）；同一个 Approval 最多一个 Run（Phase 0 原样）。
 */
export const BatchKind = z.enum(["initial", "supplement", "resume", "retry", "summary"]);
export type BatchKind = z.infer<typeof BatchKind>;

export const BatchItem = z.object({
  recipient: AgentName,
  /** 替补代答时为被替补的人 */
  onBehalfOf: AgentName.nullable(),
  approvalId: ApprovalId,
  snapshotId: SnapshotId,
  contentHash: Sha256Hex,
  /** 这份内容和同批其他人不一样（例如只给他的补充）。界面要标「他收到了额外信息」 */
  differsFromOthers: z.boolean(),
  tokenEstimate: z.number().int().nonnegative(),
  /**
   * C-40：起草时定下的模型和强度（规则见 AgentModelSettings）；null = 用 profile 自带的模型。
   * 1A 时期的旧批次读出来是 null。
   * 传输时：非 null → 盖章回传和 StartRun.model 都用 toRunModel(model)；
   * null → 盖章回传 model: null，StartRun **省略** model 字段（不能传 null）。
   */
  model: BatchModel.nullable(),
  /**
   * C-42a：这个人这一次实际带上的图片清单，确认页逐张列出（缩略图用 ref）。
   * 在建 Snapshot 的同一个事务里从 Snapshot.attachments 复制，必须相等，不另外拼。
   * 省略 = 没带图（包括所选模型看不了图、只收到占位文字的情况）
   */
  attachments: AttachmentManifest.optional(),
});
export type BatchItem = z.infer<typeof BatchItem>;

export const ApprovalBatch = z.object({
  id: BatchId,
  projectId: ProjectId,
  roundId: RoundId,
  kind: BatchKind,
  /** 和成员 Approval 的状态始终一致（成员在同一事务里一起变） */
  state: ApprovalState,
  items: z.array(BatchItem).min(1).max(8),
  /** 讨论记录被压缩的说明，确认页展示：「第 1–3 轮 → 摘要（C酱，第 3 轮生成）」 */
  compressedRounds: z.array(z.object({
    roundIndex: z.number().int().positive(),
    summaryMessageId: MessageId,
    summarizer: AgentName,
  })),
  decidedVia: z.enum(["desktop", "mobile"]).nullable(),
  createdAt: IsoTimestamp,
  decidedAt: IsoTimestamp.nullable(),
});
export type ApprovalBatch = z.infer<typeof ApprovalBatch>;

/** 一个人在一轮里的一次发言 */
export const Turn = z.object({
  id: TurnId,
  roundId: RoundId,
  batchId: BatchId,
  agent: AgentName,
  onBehalfOf: AgentName.nullable(),
  /** summary 批次里的 Turn 为 true */
  isSummary: z.boolean(),
  approvalId: ApprovalId,
  /** 盖章之前为 null */
  runId: RunId.nullable(),
  outcome: TurnOutcome,
  /** 被打断 / 暂停 / 结束本轮时已经写出来的部分，保留在记录里；没有则 null */
  partialText: z.string().max(2_000_000).nullable(),
  /** 结局为 answered 时指向正式回答（agent_reply 或 summary） */
  replyMessageId: MessageId.nullable(),
  /** 打断后接替它的 Turn */
  supersededBy: TurnId.nullable(),
  createdAt: IsoTimestamp,
  finishedAt: IsoTimestamp.nullable(),
});
export type Turn = z.infer<typeof Turn>;

// ================================================================ 汇总

/** 一个人对一个要点的态度。没表态的情况分开记，不能混成"中立" */
export const Stance = z.enum([
  "agree",
  "partial",
  "oppose",
  "no_response",     // 被问到了但没回应
  "timed_out",
  "abstained",
  "off_topic",       // 答非所问
  "not_addressed",   // 这个要点没人问到他
  "absent_quota",
  "interrupted",
]);
export type Stance = z.infer<typeof Stance>;

export const SummaryPoint = z.object({
  text: z.string().min(1).max(2000),
  /** 要点的来源：用户写的 / 汇总者抽取 / 某个 Agent 提出 */
  source: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("human") }),
    z.object({ kind: z.literal("summarizer") }),
    z.object({ kind: z.literal("agent"), agent: AgentName }),
  ]),
  stances: z.array(z.object({
    agent: AgentName,
    stance: Stance,
    note: z.string().max(2000).nullable(),
    /** 替补代答的态度：单独显示，不算票 */
    bySubstituteFor: AgentName.nullable(),
  })),
});
export type SummaryPoint = z.infer<typeof SummaryPoint>;

/**
 * 汇总的结构化部分。汇总者按约定格式输出，主控端解析；
 * 解析不出来时为 null，界面只显示汇总全文（Message kind = summary）。
 */
export const RoundSummary = z.object({
  roundId: RoundId,
  messageId: MessageId,
  summarizer: AgentName,
  /** 「2/3 参与」：有正式回答的人数 / 收件人数 */
  answered: z.number().int().nonnegative(),
  expected: z.number().int().positive(),
  report: z.object({
    points: z.array(SummaryPoint).max(100),
    risks: z.array(z.string().max(2000)).max(50),
    gaps: z.array(z.string().max(2000)).max(50),
    alternatives: z.array(z.string().max(2000)).max(50),
    /** 用了「只发给一个人」的补充时，汇总要注明 */
    extraInfoNotes: z.array(z.string().max(2000)).max(20),
  }).nullable(),
  /** 汇总产生的方案草稿 */
  planVersionId: PlanVersionId.nullable(),
  createdAt: IsoTimestamp,
});
export type RoundSummary = z.infer<typeof RoundSummary>;

// ================================================================ 方案版本

export const PlanVersion = z.object({
  id: PlanVersionId,
  projectId: ProjectId,
  /** 议题内从 1 开始递增 */
  version: z.number().int().positive(),
  state: PlanState,
  /** 方案全文（Markdown）。版本创建后不可修改，修改 = 新版本 */
  content: z.string().min(1).max(200_000),
  /** sha256(UTF-8(content))；盖章定稿时要校验 */
  contentHash: Sha256Hex,
  /** 「+2 条 · 改 1 条」这种给人看的变化说明 */
  changeNote: z.string().max(2000),
  basedOnRoundId: RoundId.nullable(),
  /** 上一版；第一版为 null。派生（定稿后再改）也指向原来的那一版 */
  parentId: PlanVersionId.nullable(),
  draftedBy: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("human") }),
    z.object({ kind: z.literal("agent"), agent: AgentName }),
  ]),
  /** 因为回退而作废时记原因 */
  supersededReason: z.string().max(2000).nullable(),
  createdAt: IsoTimestamp,
  decidedAt: IsoTimestamp.nullable(),
});
export type PlanVersion = z.infer<typeof PlanVersion>;
