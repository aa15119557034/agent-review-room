import { z } from "zod";
import { CommitSha, IsoTimestamp, RunId, Sha256Hex, SnapshotId, prefixedId } from "./common";
import { PermissionDecision, PermissionRequest } from "./permission";
import { ResultDisplay, StructuredResultOptIn } from "./structured-results";
import {
  AttachmentImageSlot,
  StartRunAttachments,
  VisionSupport,
  attachmentManifestBlock,
  imageBlockPlaced,
} from "./attachments";

/**
 * Orchestrator（控制面） ⇄ AgentServer（执行面）协议 v1。
 *
 * HTTP 端点（全部要求 Authorization: Bearer <token>）：
 *   GET  /v1/health
 *   GET  /v1/runs                                 对账：节点上还活着/刚结束的 run
 *   POST /v1/runs                                 StartRunRequest → StartRunResponse（幂等，按 runId）
 *   GET  /v1/runs/:runId/events?after=<seq>       NDJSON 流：先补发 seq > after 的事件，再推实时事件
 *   POST /v1/runs/:runId/cancel                   CancelRunRequest
 *   GET  /v1/runs/:runId/proof                    RemoteRunProof（需 health.capabilities.runFence）
 *   POST /v1/runs/:runId/permissions/:requestId   PermissionDecision（Phase 1，骨架返回 501）
 *   GET  /v1/runs/:runId/artifacts/:sha256        C-42b：取回 image Run 画出来的图（原始字节）
 *   GET  /v1/profiles/:profileId/quota            C-42b：这个 profile 的订阅额度（RemoteProfileQuota）
 *
 * 关键规则：
 * 1. Payload 里不允许出现命令。只能选节点本地配置好的 profileId。（.strict() 拒绝多余字段）
 * 2. 节点执行前必须重新计算 sha256(content)，与 contentHash 不一致就拒绝。
 * 3. 事件流就是租约：没有任何订阅者连着超过 leaseMs，节点自行终止该 run。
 *    必须满足 leaseMs < Orchestrator 的 reconnectGraceMs，给节点先发起终止的时间；
 *    租约到期、网络宽限期结束或 terminal 本身都不是进程已停止的证明。
 * 4. heartbeat 不带 seq、不进缓冲；只用来检测连接是否还活着。
 */
export const REMOTE_PROTOCOL_VERSION = 1 as const;

export const ProfileId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);

/** 只有列出的 profile 可接收本次 Run 的显式 opt-in。 */
export const StructuredResultCapability = StructuredResultOptIn.extend({
  profiles: z.array(ProfileId).min(1).max(64)
    .refine((profiles) => new Set(profiles).size === profiles.length, "profile 不能重复"),
}).strict();
export type StructuredResultCapability = z.infer<typeof StructuredResultCapability>;

/** 持久 Run 账本的身份；重建账本必须换身份，不能冒充旧账本证明旧 Run 已停。 */
export const RemoteRunLedgerId = prefixedId("rled");
export type RemoteRunLedgerId = z.infer<typeof RemoteRunLedgerId>;

/**
 * 只有满足 docs/design/Run-fence-v1.md 的持久化、单 owner 和完整性要求才可上报。
 * 未上报 = 不支持；客户端不能为旧节点补默认能力或降级重发受保护的世界请求。
 */
export const RemoteRunFenceCapability = z.object({
  version: z.literal(1),
  ledgerId: RemoteRunLedgerId,
}).strict();
export type RemoteRunFenceCapability = z.infer<typeof RemoteRunFenceCapability>;

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

/** 稳定的隔离执行语义版本；未知版本可解析，但调用方不能因此准入世界模型。 */
export const WorldProfileRecipeId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
export type WorldProfileRecipeId = z.infer<typeof WorldProfileRecipeId>;

/** v1 审定的 recipe 标识，不表示当前节点已经实现或验证了它。 */
export const WORLD_PROFILE_RECIPE_DEEPSEEK_HTTP_V1 = "deepseek-http-v1";

export const WorldProfileExpectation = z.object({
  sourceChatProfileId: ProfileId,
  recipeVersion: WorldProfileRecipeId,
}).strict();
export type WorldProfileExpectation = z.infer<typeof WorldProfileExpectation>;

/**
 * 节点经固定 recipe 校验后才能声明；schema 只核格式/目录一致性，不能验证实际命令或隔离。
 * 不由 -chat 后缀、readOnly 或手填布尔值产生。完整约束见 World-profile-v1.md。
 */
export const WorldProfileCapability = z.object({
  profileId: ProfileId,
  sourceChatProfileId: ProfileId,
  recipeVersion: WorldProfileRecipeId,
  /** source 的可核实实际默认；null = 未知，不能以 world 自己的默认代替。 */
  sourceDefaultModel: RunModel.nullable(),
}).strict();
export type WorldProfileCapability = z.infer<typeof WorldProfileCapability>;

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
 * C-36：按量计费（API）的余额。金额是十进制字符串（原样显示，不换算），currency 是 ISO 4217 或服务商原样的代码
 */
export const RemoteBalance = z
  .object({
    amount: z.string().regex(/^-?\d{1,12}(\.\d{1,6})?$/),
    currency: z.string().min(1).max(8),
  })
  .strict();
export type RemoteBalance = z.infer<typeof RemoteBalance>;

/**
 * GET /v1/profiles/:profileId/quota 的结果。节点读订阅额度的超时不超过 2 秒，超时 / 出错时
 * 各项为 null（不是 0）。只有 capabilities.quota 为 true 的节点提供这个端点。
 * C-36：不只 Codex——Claude 的 rate_limits 填 fiveHour / weekly，DeepSeek 这类按量计费的填 balance（订阅窗口为 null）。
 * 一项都读不到时照样返回 200、各项 null，不返回错误（「未知」由 quotaState 判断）
 */
export const RemoteProfileQuota = z.object({
  fiveHour: RemoteQuotaWindow.nullable(),
  weekly: RemoteQuotaWindow.nullable(),
  /** 是否已经在用付费 credits；读不到为 null */
  creditsInUse: z.boolean().nullable(),
  /** C-36：按量计费的余额；订阅制、或读不到为 null。老节点不报 = null */
  balance: RemoteBalance.nullable().optional(),
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
    /** 不支持的节点必须省略；仅能力声明且本次开启才可发 result_display，正文仍完整。 */
    structuredResults: StructuredResultOptIn.optional(),
    /**
     * 先从 health.capabilities.runFence 协商取得。与当前账本不同则 409 run_ledger_mismatch，不能准入。
     * 最终准入处（所有 await 校验之后）再次按同 RunId 原子核对 fence；持久 admitted 后才可 spawn。
     * 旧请求可省略；要求持久 fence 的调用方不得在失败后去掉此字段重试。
     */
    expectedLedgerId: RemoteRunLedgerId.optional(),
    /**
     * 世界请求绑定隔离映射。节点在最终准入（所有 await 之后）核对当前固定 recipe 注册表，
     * 同 ledger 下 profile 被改名/替换/停用也不能退成普通执行；此字段参与 RunId 幂等比较。
     */
    expectedWorldProfile: WorldProfileExpectation.optional(),
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
    /**
     * C-42g：图片位置标记（见 attachments.ts 的 attachmentImageSlotMarker / attachmentImageBlock）。
     * 主控端从 Snapshot.imageSlot 原样带过来（Snapshot 上已核过它用的是 Snapshot 的 nonce）；节点拿不到 Snapshot 的 nonce，
     * 只按标记里自带的 nonce 核图片资料块。
     * 带 attachments 时必须有、不带时不能有；content 里要有恰好一块图片资料块（在清单块后面），标记只在块里出现一次，否则 bad_request。
     * 节点把图片块紧接在标记后面交给 CLI，不删标记、不加文字
     */
    imageSlot: AttachmentImageSlot.optional(),
    /**
     * C-42b：省略 = text。kind 也是 runId 幂等比较的一部分（先按「省略 = text」归一化再比）：
     * 同一个 runId 先 text 后 image（或反过来）→ run_id_conflict，不能回 already_exists
     */
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
  .refine((r) => (r.attachments === undefined) === (r.imageSlot === undefined), "带图时要有 imageSlot，不带图时不能有")
  .refine(
    (r) =>
      r.attachments === undefined ||
      r.imageSlot === undefined ||
      imageBlockPlaced(r.snapshot.content, r.attachments, r.imageSlot),
    "content 里要有恰好一块图片资料块（attachmentImageBlock），在附件清单块后面，标记只在块里出现一次",
  )
  .refine((r) => r.kind !== "image" || r.attachments === undefined, "image Run 不能带附件")
  .superRefine((r, ctx) => {
    if (r.structuredResults !== undefined && (r.kind === "image" || r.expectedWorldProfile !== undefined)) {
      ctx.addIssue({ code: "custom", path: ["structuredResults"], message: "首片结构化结果仅用于普通文本 Run" });
    }
    if (r.expectedWorldProfile === undefined) return;
    const reject = (path: string[], message: string) => ctx.addIssue({ code: "custom", path, message });
    if (r.expectedLedgerId === undefined) reject(["expectedLedgerId"], "世界请求必须绑定 ledger");
    if (r.model === undefined) reject(["model"], "世界请求必须显式指定实际模型和档位");
    if (r.profileId === r.expectedWorldProfile.sourceChatProfileId) reject(["profileId"], "世界 target 不能与 source chat profile 相同");
    if (r.chat !== undefined) reject(["chat"], "世界请求不能携带 chat，即使 memory 为 null");
    if (r.snapshot.commitSha !== undefined) reject(["snapshot", "commitSha"], "世界请求不能携带工程 commit");
    if (r.attachments !== undefined) reject(["attachments"], "世界请求不能携带图片");
    if (r.imageSlot !== undefined) reject(["imageSlot"], "世界请求不能携带图片槽位");
    if (r.kind === "image") reject(["kind"], "世界请求只接受 text Run");
  });

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
   * finalPromptHash = sha256(UTF-8(实际交给 CLI 的全文))；没有记忆槽位时等于 contentHash，memory 为 null。
   * C-42g：带图时「全文」= 交给 CLI 的全部文字块按顺序直接拼起来（不含图片块，图片已逐张按 sha256 校验）。
   * 节点不改不删文字、标记也留在文字里，所以没有记忆槽位时它就等于 sha256(UTF-8(content)) = contentHash；
   * 有记忆槽位时等于 sha256(UTF-8(把 marker 换成记忆之后的 content))，和不带图时一样
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

/** 仅成功协商 C11 的消费者使用；RemoteEvent 保留旧格式，纯契约不提前改适配器。 */
export const StructuredRemoteEvent = z.discriminatedUnion("type", [
  ...RemoteEvent.options,
  z.object({ type: z.literal("result_display"), ...seqd, result: ResultDisplay }).strict(),
]);
export type StructuredRemoteEvent = z.infer<typeof StructuredRemoteEvent>;

/**
 * 支持 runFence 的节点对未知 ID 也须先持久禁止创建，才可响应 202 {ok:true}。
 * expectedLedgerId 不匹配则 409 且不修改新账本。202 只是取消已接收，停止证据另查 proof。
 * 已 admitted 的 Run 不能因重启后 PID/对象缺席变成 never_started；同 ID 永不再次启动。
 */
export const CancelRunRequest = z.object({
  reason: z.string().max(500).optional(),
  expectedLedgerId: RemoteRunLedgerId.optional(),
}).strict();

/** 取消已接收；不是 RemoteRunProof，不代表受管进程已经停止。wire 保持原有 {ok:true}。 */
export const CancelRunResponse = z.object({ ok: z.literal(true) });
export type CancelRunResponse = z.infer<typeof CancelRunResponse>;

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
      /** 可协商的持久准入 fence 与按 RunId 查询证据；不改变已有 runs 列表。 */
      runFence: RemoteRunFenceCapability.optional(),
      structuredResults: StructuredResultCapability.optional(),
      /** 经节点实际校验的隔离映射；缺席/未知 recipe 不可用于世界模型，不按名称推断。 */
      worldProfiles: z.array(WorldProfileCapability).max(64).optional(),
    })
    .optional(),
}).refine(
  (h) => (h.memoryProfiles ?? []).every((p) => h.profiles.includes(p)),
  "memoryProfiles 里的 profile 必须都在 profiles 里",
).superRefine((h, ctx) => {
  if (h.capabilities?.structuredResults?.profiles.some((profile) => !h.profiles.includes(profile))) {
    ctx.addIssue({ code: "custom", path: ["capabilities", "structuredResults", "profiles"], message: "结构化结果 profile 必须在 profiles 中" });
  }
  const mappings = h.capabilities?.worldProfiles;
  if (mappings === undefined || mappings.length === 0) return;
  const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });
  if (h.capabilities?.runFence === undefined) issue(["capabilities", "runFence"], "世界映射需要持久 Run fence 能力");
  const targets = new Set(mappings.map((m) => m.profileId));
  const seenTargets = new Set<string>(), seenSources = new Set<string>();
  const supports = (models: readonly ModelOption[], chosen: RunModel) => models.some((m) =>
    m.id === chosen.model && (chosen.effort === null ? m.efforts.length === 0 : m.efforts.some((e) => e.id === chosen.effort)));
  for (const [index, mapping] of mappings.entries()) {
    const path = ["capabilities", "worldProfiles", index];
    if (seenTargets.has(mapping.profileId)) issue([...path, "profileId"], "世界 target 不能重复");
    if (seenSources.has(mapping.sourceChatProfileId)) issue([...path, "sourceChatProfileId"], "同一 source 只能有一个世界映射");
    seenTargets.add(mapping.profileId); seenSources.add(mapping.sourceChatProfileId);
    if (!h.profiles.includes(mapping.profileId)) issue([...path, "profileId"], "世界 target 必须在 profiles 中");
    if (!h.profiles.includes(mapping.sourceChatProfileId)) issue([...path, "sourceChatProfileId"], "source chat profile 必须在 profiles 中");
    if (targets.has(mapping.sourceChatProfileId)) issue([...path, "sourceChatProfileId"], "source 不能是世界 target（包括自身和映射链）");
    if (h.memoryProfiles?.includes(mapping.profileId) || h.capabilities?.imageProfiles?.includes(mapping.profileId)) {
      issue([...path, "profileId"], "世界 target 不能同时声明记忆或图片能力");
    }
    const targetModels = h.profileModels?.find((p) => p.profileId === mapping.profileId)?.models;
    if (!targetModels?.length) issue([...path, "profileId"], "世界 target 必须有显式的非空模型目录");
    const chosen = mapping.sourceDefaultModel;
    if (chosen !== null) {
      if (targetModels && !supports(targetModels, chosen)) issue([...path, "sourceDefaultModel"], "source 默认必须是 target 目录中合法的模型/档位");
      const sourceModels = h.profileModels?.find((p) => p.profileId === mapping.sourceChatProfileId)?.models;
      if (sourceModels?.length && !supports(sourceModels, chosen)) issue([...path, "sourceDefaultModel"], "source 默认与 source 已声明的模型目录不一致");
    }
  }
});

export const RemoteRunSummary = z.object({
  runId: RunId,
  profileId: ProfileId,
  state: z.enum(["running", "finished"]),
  lastSeq: z.number().int().min(-1),
  subscribers: z.number().int().nonnegative(),
});

const runProofIdentity = { runId: RunId, ledgerId: RemoteRunLedgerId };

/**
 * GET /v1/runs/:runId/proof：合法 ID 返回 200，no-store。读失败/损坏不可伪装成 missing。
 * 调用方须核对 runId 和派发前持久绑定的 ledgerId；新账本不能解除旧账本的屏障。
 * 输出事件 TTL 不得清理准入/fence 记录；同一账本仅有一个合法执行 owner。
 */
export const RemoteRunProof = z.discriminatedUnion("status", [
  /** 完整账本没有这个 ID；POST 仍可能在途中，不能据此放行。 */
  z.object({ ...runProofIdentity, status: z.literal("missing") }).strict(),
  /** 已 admitted，但没有肯定停止证据；含运行、取消未确认、节点崩溃和证据写入失败。 */
  z.object({ ...runProofIdentity, status: z.literal("unconfirmed") }).strict(),
  /**
   * 已持久禁止同 ID 启动，并肯定从未启动目标执行：取消先于准入，或原 owner 确知没有调用
   * spawn / 得到明确 spawn 失败。未知异常、非零 exit code 或重启后 PID 缺席均不算此证据。
   */
  z.object({ ...runProofIdentity, status: z.literal("fenced_never_started") }).strict(),
  /**
   * 已持久禁止重建，并记录直接受管 ChildProcess 的 close。
   * 只证明该进程关闭，不保证所有后代/脱离管道的任务停止；不自动代表可放行前台。
   */
  z.object({ ...runProofIdentity, status: z.literal("closed_process") }).strict(),
]);
export type RemoteRunProof = z.infer<typeof RemoteRunProof>;

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
  "run_ledger_mismatch", // 409：expectedLedgerId 与节点当前持久账本不符，不采取替代操作
  "run_fenced", // 409：该 RunId 已永久消耗，不能创建替代执行
  "world_profile_mismatch", // 409：预期隔离映射与当前经过校验的注册表不符，不退成普通 profile
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

/** 已 parse 的契约对象：节点能力与本次请求同时成立才可发新展示事件。不能据此授予工具权限。 */
export const canEmitStructuredResults = (health: NodeHealth, request: StartRunRequest): boolean =>
  request.structuredResults?.version === 1 &&
  health.capabilities?.structuredResults?.version === 1 &&
  health.capabilities.structuredResults.profiles.includes(request.profileId) &&
  request.kind !== "image" && request.expectedWorldProfile === undefined;
export type RemoteRunSummary = z.infer<typeof RemoteRunSummary>;
export type RemoteErrorCode = z.infer<typeof RemoteErrorCode>;
