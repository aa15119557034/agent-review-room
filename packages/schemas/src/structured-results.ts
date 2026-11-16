import { z } from "zod";
import { ChatMessageId, IsoTimestamp, MessageId, Sha256Hex } from "./common";

/** P2-C11：仅展示和来源元数据；不携带命令、权限、厂商续聊状态或原始工具参数。 */
export const STRUCTURED_RESULTS_VERSION = 1 as const;
export const StructuredResultOptIn = z.object({ version: z.literal(STRUCTURED_RESULTS_VERSION) }).strict();
export type StructuredResultOptIn = z.infer<typeof StructuredResultOptIn>;

/** 链接是来源定位信息，不是访问授权；读取仍由节点和 main 的边界决定。 */
export const SourceUrl = z.string().max(8192).url().refine((value) => {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && url.hostname !== "" && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}, "来源只接受不含用户名和密码的 HTTP(S) URL");

export const SourceIdentity = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("message"), id: MessageId }).strict(),
  z.object({ kind: z.literal("chat_message"), id: ChatMessageId }).strict(),
  z.object({ kind: z.literal("web"), url: SourceUrl }).strict(),
]);
export type SourceIdentity = z.infer<typeof SourceIdentity>;

/**
 * 指向同一来源的确定版本。version 为生产方的不可变版本标识；无版本的网页用正文 SHA-256。
 * hash 为已取回可读正文的 UTF-8 SHA-256；未取回正文必须为 null，不能用摘要或空串冒充。
 * version 未知也显式为 null；retrievedAt 为本次检索/取回记录时间，不证明正文取回成功。
 * status 是记录时的可读状态，不授予读取权限；旧 Snapshot 不改写，后续使用必须重新检查撤回/归属。
 */
export const SourceReference = z.object({
  source: SourceIdentity,
  version: z.string().min(1).max(128).nullable(),
  contentHash: Sha256Hex.nullable(),
  retrievedAt: IsoTimestamp,
  status: z.enum(["readable", "missing", "revoked"]),
}).strict().refine((ref) => ref.status !== "readable" || (ref.contentHash !== null && ref.version !== null), "可读来源必须有版本和正文 hash");
export type SourceReference = z.infer<typeof SourceReference>;
/** 既有 Message / ChatMessage / Snapshot 的可选附属记录；省略保持旧格式。 */
export const SourceReferences = z.array(SourceReference).min(1).max(100);

/** 不返回用量与实测 0 是不同状态；禁止默认填 0、估算冒充实测。 */
const unknownMeasurement = z.object({
  status: z.literal("unknown"),
  reason: z.enum(["not_reported", "unavailable"]),
}).strict();
export const UsageCount = z.discriminatedUnion("status", [
  unknownMeasurement,
  z.object({ status: z.literal("measured"), value: z.number().int().nonnegative().safe() }).strict(),
]);
export type UsageCount = z.infer<typeof UsageCount>;
export const UsageCost = z.discriminatedUnion("status", [
  unknownMeasurement,
  z.object({ status: z.literal("measured"), amount: z.number().finite().nonnegative(), currency: z.string().regex(/^[A-Z]{3}$/) }).strict(),
]);
export type UsageCost = z.infer<typeof UsageCost>;

export const ResultDisplayBlock = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("citation"),
    citationId: z.string().min(1).max(128),
    source: SourceReference,
    title: z.string().max(500).optional(),
  }).strict(),
  z.object({
    kind: z.literal("tool_step"),
    stepId: z.string().min(1).max(128),
    tool: z.string().min(1).max(100),
    /** 是运行方的进度报告，不是独立验收/执行回执，也不改变 Run 终态。 */
    status: z.enum(["started", "completed", "failed", "unknown"]),
    summary: z.string().max(4000),
  }).strict(),
  z.object({
    kind: z.literal("usage"),
    /** 整个 Run 截至此 seq 的累计值；覆盖旧值，不按事件相加。 */
    scope: z.literal("run"),
    inputTokens: UsageCount,
    outputTokens: UsageCount,
    toolCalls: UsageCount,
    cost: UsageCost,
  }).strict(),
  /** 上游未知展示块由适配层显式归一化；不保留原始 payload，不伪造支持。 */
  z.object({
    kind: z.literal("unsupported"),
    originalKind: z.string().min(1).max(128),
    reason: z.enum(["unknown_display_kind", "unsupported_display_version"]),
  }).strict(),
]);
export type ResultDisplayBlock = z.infer<typeof ResultDisplayBlock>;

/** 未知 Room 版本/块及执行语义均拒绝；不能把未知动作转成已成功的工具步骤。 */
export const ResultDisplay = z.object({
  version: z.literal(STRUCTURED_RESULTS_VERSION),
  block: ResultDisplayBlock,
}).strict();
export type ResultDisplay = z.infer<typeof ResultDisplay>;
