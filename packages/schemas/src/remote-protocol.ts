import { z } from "zod";
import { CommitSha, IsoTimestamp, RunId, Sha256Hex, SnapshotId } from "./common";
import { PermissionDecision, PermissionRequest } from "./permission";

/**
 * Orchestrator（控制面） ⇄ AgentServer（执行面）协议 v1。
 *
 * HTTP 端点（全部要求 Authorization: Bearer <token>）：
 *   GET  /v1/health
 *   GET  /v1/runs                                 对账：节点上还活着/刚结束的 run
 *   POST /v1/runs                                 StartRunRequest → StartRunResponse（幂等，按 runId）
 *   GET  /v1/runs/:runId/events?after=<seq>       NDJSON 流：先补发 seq > after 的事件，再推实时事件
 *   POST /v1/runs/:runId/cancel                   CancelRunRequest
 *   POST /v1/runs/:runId/permissions/:requestId   PermissionDecision（Phase 1，骨架返回 501）
 *
 * 关键规则：
 * 1. Payload 里不允许出现命令。只能选节点本地配置好的 profileId。（.strict() 拒绝多余字段）
 * 2. 节点执行前必须重新计算 sha256(content)，与 contentHash 不一致就拒绝。
 * 3. 事件流就是租约：没有任何订阅者连着超过 leaseMs，节点自行终止该 run。
 *    必须满足 leaseMs < Orchestrator 的 reconnectGraceMs，保证"远端先停，本地后判失败"。
 * 4. heartbeat 不带 seq、不进缓冲；只用来检测连接是否还活着。
 */
export const REMOTE_PROTOCOL_VERSION = 1 as const;

export const ProfileId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);

// ---------------------------------------------------------------- 模型选择（C-40，阶段 1B）

/**
 * 模型的 API 名，例如 "claude-opus-5-5"、"deepseek-flash"。节点把它翻译成 CLI 参数，所以只允许
 * 字母、数字、点、下划线、连字符，不能以 "-" 开头（防止被当成命令行选项）。
 */
export const ModelId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/);
export type ModelId = z.infer<typeof ModelId>;

/** 思考强度档位的 id，例如 "low"、"medium"、"high"、"xhigh"、"max"、"off"。准确名字由节点实测后上报 */
export const EffortId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/);
export type EffortId = z.infer<typeof EffortId>;

export const EffortLevel = z.object({
  id: EffortId,
  /** 界面拉条上的字，例如「中等」 */
  displayName: z.string().min(1).max(20),
  /** 给人看的提示，例如「约 4 倍用量」；没有就是 null */
  note: z.string().max(80).nullable(),
});
export type EffortLevel = z.infer<typeof EffortLevel>;

export const ModelOption = z.object({
  id: ModelId,
  displayName: z.string().min(1).max(40),
  /**
   * 这个模型能用的思考强度，**从弱到强排好序**，界面拉条按这个顺序画。
   * 空数组 = 这个模型没有强度可调，StartRun 里 effort 只能是 null。
   */
  efforts: z.array(EffortLevel).max(8),
  /** 节点推荐的档位，必须在 efforts 里；efforts 为空时为 null */
  defaultEffort: EffortId.nullable(),
}).refine(
  (m) => (m.efforts.length === 0 ? m.defaultEffort === null : m.efforts.some((e) => e.id === m.defaultEffort)),
  "defaultEffort 必须是 efforts 里的一档；没有档位时为 null",
).refine((m) => new Set(m.efforts.map((e) => e.id)).size === m.efforts.length, "档位 id 不能重复");
export type ModelOption = z.infer<typeof ModelOption>;

/** 一个 profile 能用哪些模型。models 为空 = 这个 profile 的模型写死在节点配置里，不接受选择 */
export const ProfileModels = z.object({
  profileId: ProfileId,
  models: z.array(ModelOption).max(16),
}).refine((p) => new Set(p.models.map((m) => m.id)).size === p.models.length, "模型 id 不能重复");
export type ProfileModels = z.infer<typeof ProfileModels>;

/** StartRun 里指定的模型和强度 */
export const RunModel = z
  .object({
    model: ModelId,
    /** 模型没有档位时为 null */
    effort: EffortId.nullable(),
  })
  .strict();
export type RunModel = z.infer<typeof RunModel>;

export const RunLimits = z
  .object({
    idleTimeoutMs: z.number().int().min(1_000).max(3_600_000),
    totalTimeoutMs: z.number().int().min(1_000).max(24 * 3_600_000),
  })
  .strict();

export const StartRunRequest = z
  .object({
    protocol: z.literal(REMOTE_PROTOCOL_VERSION),
    runId: RunId,
    profileId: ProfileId,
    snapshot: z
      .object({
        id: SnapshotId,
        /** 原样作为 stdin 传给 CLI */
        content: z.string().min(1).max(2_000_000),
        contentHash: Sha256Hex,
        /** 提供时，且节点 profile 开启 verifyCommit，节点会校验工作目录 HEAD 一致且干净 */
        commitSha: CommitSha.optional(),
      })
      .strict(),
    limits: RunLimits,
    /**
     * C-40：用哪个模型、什么强度。不传 = 用 profile 配置里自带的模型（Phase 0 / 1A 的行为）。
     * 节点先核对 model 在这个 profile 上报的 models 里、effort 在这个模型的 efforts 里，
     * 不在就拒绝（unknown_model），不换成别的、不就近取档。节点自己把它翻译成 CLI 参数，请求里仍然没有命令。
     * profile 的 models 为空（模型写死）时传了 model 也拒绝（unknown_model）。
     */
    model: RunModel.optional(),
  })
  .strict();

export const StartRunResponse = z.object({
  runId: RunId,
  status: z.enum(["accepted", "already_exists"]),
  eventsPath: z.string(),
});

/** 节点侧事件。seq 是节点本地序号，RemoteAgentAdapter 负责映射成 AgentEvent。 */
const seqd = { seq: z.number().int().nonnegative(), ts: IsoTimestamp };

export const RemoteTerminal = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("completed"), exitCode: z.literal(0) }),
  z.object({
    outcome: z.literal("error"),
    reason: z.enum([
      "spawn_failed",
      "process_exit_nonzero",
      "lease_expired",
      "output_limit_exceeded",
      "incomplete_output", // 进程正常退出，但解析器没看到完整的结束标记（例如流被截断）
      /**
       * 服务商明确说额度用尽或被限流（C-25 / ADR-002）。只在解析器从 CLI 的结构化输出里
       * 认出来时才用；认不出来的失败仍然是 process_exit_nonzero / internal，不猜。
       * 主控端原样映射成 FailureReason.quota_exhausted → Turn `absent_quota`。
       */
      "quota_exhausted",
      "node_shutdown",
      "internal",
    ]),
    exitCode: z.number().int().nullable(),
    message: z.string().max(4000).optional(),
  }),
  z.object({ outcome: z.literal("cancelled"), reason: z.string().max(500).optional() }),
  z.object({ outcome: z.literal("timed_out"), kind: z.enum(["idle", "total"]) }),
]);

export const RemoteEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("started"), ...seqd }),
  z.object({ type: z.literal("output"), ...seqd, stream: z.enum(["stdout", "stderr"]), data: z.string() }),
  /**
   * 节点已经解析好的回复文字（profile 配置了 parser 时才会出现，例如 claude-stream-json）。
   * 有解析器时 stdout 不再以 output 事件转发，stderr 照常转发。
   */
  z.object({ type: z.literal("text_delta"), ...seqd, text: z.string() }),
  /** 完整回复，权威结果。每个 run 最多一次，且一定在 terminal(completed) 之前 */
  z.object({ type: z.literal("message_complete"), ...seqd, text: z.string() }),
  z.object({ type: z.literal("permission_request"), ...seqd, request: PermissionRequest }),
  z.object({ type: z.literal("terminal"), ...seqd, result: RemoteTerminal }),
  z.object({ type: z.literal("heartbeat"), ts: IsoTimestamp, lastSeq: z.number().int().min(-1) }),
]);

export const CancelRunRequest = z.object({ reason: z.string().max(500).optional() }).strict();

export const PermissionDecisionRequest = PermissionDecision;

export const NodeHealth = z.object({
  protocol: z.literal(REMOTE_PROTOCOL_VERSION),
  nodeId: z.string(),
  profiles: z.array(ProfileId),
  activeRuns: z.number().int().nonnegative(),
  maxConcurrentRuns: z.number().int().positive(),
  leaseMs: z.number().int().positive(),
  heartbeatMs: z.number().int().positive(),
  /**
   * C-40：每个 profile 能用的模型和强度。只列 profiles 里有的 profile，每个最多出现一次。
   * 老节点不报这个字段 = 不支持选模型，主控端不在 StartRun 里带 model。
   */
  profileModels: z
    .array(ProfileModels)
    .max(64)
    .refine((list) => new Set(list.map((p) => p.profileId)).size === list.length, "同一个 profile 只能出现一次")
    .optional(),
});

export const RemoteRunSummary = z.object({
  runId: RunId,
  profileId: ProfileId,
  state: z.enum(["running", "finished"]),
  lastSeq: z.number().int().min(-1),
  subscribers: z.number().int().nonnegative(),
});

export const RemoteErrorCode = z.enum([
  "unauthorized",
  "bad_request",
  "not_found",
  "unknown_profile",
  "unknown_model", // C-40：模型或强度不在这个 profile 上报的列表里
  "hash_mismatch",
  "commit_mismatch",
  "run_id_conflict",
  "node_busy",
  "payload_too_large",
  "not_implemented",
  "internal",
]);

export const RemoteErrorResponse = z.object({
  error: RemoteErrorCode,
  message: z.string(),
});

export type StartRunRequest = z.infer<typeof StartRunRequest>;
export type StartRunResponse = z.infer<typeof StartRunResponse>;
export type RemoteEvent = z.infer<typeof RemoteEvent>;
export type RemoteTerminal = z.infer<typeof RemoteTerminal>;
export type NodeHealth = z.infer<typeof NodeHealth>;
export type RemoteRunSummary = z.infer<typeof RemoteRunSummary>;
export type RemoteErrorCode = z.infer<typeof RemoteErrorCode>;
