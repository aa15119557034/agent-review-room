import { z } from "zod";
import { CommitSha, IsoTimestamp, RunId, Sha256Hex, SnapshotId } from "./common";
import { PermissionDecision, PermissionRequest } from "./permission";
import { StartRunAttachments, VisionSupport, attachmentManifestBlock } from "./attachments";

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
 *   GET  /v1/runs/:runId/artifacts/:sha256        C-42b：取回 image Run 画出来的图（原始字节）
 *   GET  /v1/profiles/:profileId/quota            C-42b：这个 profile 的订阅额度（RemoteProfileQuota）
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
  /**
   * C-42a：这个模型能不能看图，节点用带暗号的测试图实测（S-23）。不报 = unknown。
   * 只有 yes 才发图；no / unknown 收到「[图片：名字]」占位。不会为了看图自动换成备选模型
   */
  vision: VisionSupport.optional(),
}).refine(
  (m) => (m.efforts.length === 0 ? m.defaultEffort === null : m.efforts.some((e) => e.id === m.defaultEffort)),
  "defaultEffort 必须是 efforts 里的一档；没有档位时为 null",
).refine((m) => new Set(m.efforts.map((e) => e.id)).size === m.efforts.length, "档位 id 不能重复");
export type ModelOption = z.infer<typeof ModelOption>;

/** 一个 profile 能用哪些模型。models 为空 = 这个 profile 的模型写死在节点配置里，不接受选择 */
export const ProfileModels = z.object({
  profileId: ProfileId,
  models: z.array(ModelOption).max(16),
  /**
   * C-42a：models 为空（模型写死）时，那个写死的模型能不能看图，和 ModelOption.vision 同样实测。不报 = unknown。
   * models 不为空时不能带这个字段（看图能力报在各个 ModelOption 上）
   */
  fixedModelVision: VisionSupport.optional(),
})
  .refine((p) => new Set(p.models.map((m) => m.id)).size === p.models.length, "模型 id 不能重复")
  .refine((p) => p.models.length === 0 || p.fixedModelVision === undefined, "有模型列表时看图能力报在 ModelOption.vision 上");
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

// ---------------------------------------------------------------- 聊天的记忆槽位（C-34，阶段 1B-2）

/**
 * 记忆条目 id：节点给的、相对于记忆文件夹的名字，例如 "L1/identity.md"、"メモ/café.md"。
 * 不能是绝对路径、不能有 "." / ".." / 空段、不能有反斜杠和控制字符，只用来事后核对「用了哪几条」。
 */
export const MemoryEntryId = z
  .string()
  .min(1)
  .max(200)
  // 不能有控制字符和 Windows 文件名里不允许的 \ : * ? " < > |（所以也不会有盘符和反斜杠路径）
  .regex(/^[^\u0000-\u001f\u007f\\:*?"<>|]+$/)
  // Windows 会吃掉段尾的空格和点（"a/.. /b" 实际是 "a/../b"），所以段尾不能是空格或点，比较前也先 trim
  .refine(
    (v) => !v.split("/").some((seg) => [".", "..", ""].includes(seg.trim()) || /[. ]$/.test(seg)),
    "不能有空段、. 或 ..，段尾不能是空格或点",
  );
export type MemoryEntryId = z.infer<typeof MemoryEntryId>;

/**
 * 节点回报的记忆清单。主控端**只存清单和 hash，不存记忆正文**；导出聊天记录时也不含记忆正文。
 * - filled     ：读到了，entries 至少一条
 * - empty      ：文件夹在，但没有相关条目（entries 为空）
 * - unavailable：这个 profile 没配记忆文件夹或读不了；节点仍按边界包一段「记忆不可用」放进槽位，entries 为空
 */
export const MemoryManifest = z
  .object({
    status: z.enum(["filled", "empty", "unavailable"]),
    entries: z.array(z.object({ id: MemoryEntryId, sha256: Sha256Hex }).strict()).max(200),
  })
  .strict()
  .refine((m) => (m.status === "filled") === (m.entries.length > 0), "只有 filled 有条目")
  .refine((m) => new Set(m.entries.map((e) => e.id)).size === m.entries.length, "条目不能重复");
export type MemoryManifest = z.infer<typeof MemoryManifest>;

/** marker 在 content 里恰好出现一次（ChatSnapshot 和 StartRun 都用这条） */
export const occursExactlyOnce = (content: string, marker: string): boolean => content.split(marker).length === 2;

/**
 * Snapshot 里的记忆槽位。主控端拼好除记忆以外的全部内容，留一个槽位：
 * content 里**恰好出现一次** marker（X-30 生成，带本次 nonce），节点把它换成用同一个包裹函数（core 导出）包好的记忆。
 * marker 出现 0 次或多于 1 次，节点拒绝（bad_request）。
 */
export const MemorySlot = z
  .object({
    nonce: z.string().regex(/^[a-f0-9]{16,64}$/),
    marker: z.string().min(16).max(200),
  })
  .strict();
export type MemorySlot = z.infer<typeof MemorySlot>;

/**
 * C-42b：Run 的种类。省略 = text（Phase 0 起的文字回答）。
 * image = 让 profile 画一张图（只有节点配置里标了能画图的 profile 接受，否则 unsupported_kind）：
 * - snapshot.content 是主控端按固定模板写好的画图指令（含提示词和尺寸），节点照样校验 hash，不改写
 * - 不能带 attachments
 * - 画完在 terminal(completed) 里带上 artifact（一张）；画不出来按 error 结束
 */
export const RunKind = z.enum(["text", "image"]);
export type RunKind = z.infer<typeof RunKind>;

/** image Run 画出来的图。字节用 GET /v1/runs/:runId/artifacts/:sha256 取 */
export const RemoteArtifact = z
  .object({
    sha256: Sha256Hex,
    mime: z.enum(["image/png", "image/jpeg", "image/webp"]),
    bytes: z.number().int().min(1).max(10 * 1024 * 1024),
  })
  .strict();
export type RemoteArtifact = z.infer<typeof RemoteArtifact>;

/**
 * 订阅额度的一个窗口（S-24：Codex 的 account/rateLimits/read）。读不到就整个为 null，不猜。
 * C-36 的额度状态复用这个形状
 */
export const RemoteQuotaWindow = z.object({
  usedPercent: z.number().min(0).max(100),
  windowMinutes: z.number().int().positive().nullable(),
  resetsAt: IsoTimestamp.nullable(),
});
export type RemoteQuotaWindow = z.infer<typeof RemoteQuotaWindow>;

/**
 * GET /v1/profiles/:profileId/quota 的结果。节点读订阅额度的超时不超过 2 秒，超时 / 出错时
 * 各项为 null（不是 0）。只有 capabilities.quota 为 true 的节点提供这个端点
 */
export const RemoteProfileQuota = z.object({
  fiveHour: RemoteQuotaWindow.nullable(),
  weekly: RemoteQuotaWindow.nullable(),
  /** 是否已经在用付费 credits；读不到为 null */
  creditsInUse: z.boolean().nullable(),
  readAt: IsoTimestamp,
});
export type RemoteProfileQuota = z.infer<typeof RemoteProfileQuota>;

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
    /**
     * C-34：聊天 Run 才有。不传 = 讨论 / 单次评审（行为不变）。
     * - memory 非 null：节点先按规则 2 校验 sha256(content) === contentHash，再找 content 里恰好一次的 marker，
     *   读这个 profile 配置的记忆文件夹，用 core 导出的包裹函数（同一个 nonce）把记忆换进去，然后才交给 CLI。
     *   marker 不是恰好一次 → bad_request。节点**不能往 Prompt 里加槽位以外的任何文字**
     * - memory 为 null：原样发 content
     * 两种情况都按 RemoteEvent.prompt_final 的规则发一次 prompt_final（最终 hash + 记忆清单）。
     * 幂等：同一个 runId 重复提交时 chat 也要一致，否则 run_id_conflict。
     */
    chat: z.object({ memory: MemorySlot.nullable() }).strict().optional(),
    /**
     * C-42a：随附的图片，只发给 health.capabilities.attachments 为 true 的节点，且**这一次实际用的模型**看图能力为 yes：
     * - 传了 model：那个 ModelOption.vision === "yes"
     * - 没传 model（只允许 profile 的 models 为空、模型写死）：ProfileModels.fixedModelVision === "yes"
     * - profile 有模型列表却没传 model 时不能带图
     * 节点按自己上报的值再核对一次，不满足 → vision_unsupported，整个请求拒绝（不丢图继续跑）。
     *
     * 节点必须逐张检查：sha256(解码后的字节) === sha256、字节数 === bytes；
     * 并且 snapshot.content **以** attachmentManifestBlock(这组附件) **开头**（逐字相等，见 attachments.ts）。
     * 只认开头这一块：正文里就算有人写了一模一样的清单行也不算数。任何一项不对 → hash_mismatch，整个请求拒绝。
     * 幂等（同一个 runId 重复提交）时附件的 sha256 列表也要一致，否则 run_id_conflict。
     * 节点按自己配置的映射把图交给 CLI，不往 content 里加任何文字；用完删临时文件。
     */
    attachments: StartRunAttachments.optional(),
    /** C-42b：省略 = text */
    kind: RunKind.optional(),
  })
  .strict()
  .refine(
    (r) => !r.chat?.memory || occursExactlyOnce(r.snapshot.content, r.chat.memory.marker),
    "chat.memory.marker 必须在 snapshot.content 里恰好出现一次",
  )
  .refine(
    (r) => r.attachments === undefined || r.snapshot.content.startsWith(attachmentManifestBlock(r.attachments)),
    "带图时 snapshot.content 要以这组附件的清单块开头",
  )
  .refine((r) => r.kind !== "image" || r.attachments === undefined, "image Run 不能带附件");

export const StartRunResponse = z.object({
  runId: RunId,
  status: z.enum(["accepted", "already_exists"]),
  eventsPath: z.string(),
});

/** 节点侧事件。seq 是节点本地序号，RemoteAgentAdapter 负责映射成 AgentEvent。 */
const seqd = { seq: z.number().int().nonnegative(), ts: IsoTimestamp };

export const RemoteTerminal = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("completed"),
    exitCode: z.literal(0),
    /**
     * C-42b：image Run 画好的图（text Run 没有这个字段）。主控端用 artifacts 端点取回字节、校验 sha256 / 类型 / 大小后
     * 存成 generated 图片。节点在取回成功后、或 Run 结束后超过 leaseMs 仍没人取时删除文件。
     * image Run 完成却没有 artifact：节点改报 error(incomplete_output)
     */
    artifact: RemoteArtifact.optional(),
  }),
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
  /**
   * C-34：只在 StartRun 带了 chat 时出现。PROMPT_FINAL_RULE：节点拼好最终 Prompt 之后、交给 CLI 之前恰好一次，
   * 在任何 text_delta / output / message_complete 之前；拼好之前就失败（校验、读记忆出错、取消）可以没有。
   * finalPromptHash = sha256(UTF-8(实际交给 CLI 的全文))；没有记忆槽位时等于 contentHash，memory 为 null
   */
  z.object({
    type: z.literal("prompt_final"),
    ...seqd,
    finalPromptHash: Sha256Hex,
    memory: MemoryManifest.nullable(),
  }),
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
  /**
   * C-34：配了记忆文件夹、能读到的聊天 profile（只报有没有，不报路径）。必须都在 profiles 里。
   * 老节点不报 = 都没有，开了 memorySource.nodeFolder 的人界面显示「此记忆来源不可用」，Snapshot 仍留槽位、节点填「不可用」
   */
  memoryProfiles: z.array(ProfileId).max(64).optional(),
  /**
   * C-42a：节点支持的可选能力。不报 = 都不支持（老节点）。
   * attachments：能收 StartRun.attachments，且请求体上限不小于 NODE_MIN_BODY_BYTES_WITH_ATTACHMENTS
   */
  capabilities: z
    .object({
      attachments: z.boolean().optional(),
      /** C-42b：接受 kind = "image" 的 Run 和 artifacts 端点；imageProfiles 列出能画图的 profile */
      imageRuns: z.boolean().optional(),
      imageProfiles: z.array(ProfileId).max(16).optional(),
      /** C-42b：提供 GET /v1/profiles/:profileId/quota */
      quota: z.boolean().optional(),
    })
    .optional(),
}).refine(
  (h) => (h.memoryProfiles ?? []).every((p) => h.profiles.includes(p)),
  "memoryProfiles 里的 profile 必须都在 profiles 里",
);

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
  "vision_unsupported", // C-42a：带了图，但这一次用的模型上报的看图能力不是 yes
  "unsupported_kind", // C-42b：这个 profile 不接受这种 Run（例如不能画图的 profile 收到 image）
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
