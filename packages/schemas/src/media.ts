import { z } from "zod";
import { ChatMessageId, ConversationId, IsoTimestamp, RunId, Sha256Hex, prefixedId } from "./common";
import { ImageRef } from "./appearance";
import { AgentName, MessageId, ProjectId } from "./entities";
import { MediaJobState } from "./state-machines";
import { RemoteProfileQuota } from "./remote-protocol";

/**
 * 媒体任务：画图和语音合成（C-42b，ADR-004 §3 / §3a，阶段 1B-M1）。
 *
 * - 每次画图 / 合成都是一个持久化的 MediaJob，**恰好一个终态**（转换表见 state-machines.ts 的 MEDIA_JOB_TRANSITIONS）
 * - 应用启动时，遗留的 queued / running 一律记成 cancelled（cancelReason = app_restart），不留「生成中」
 * - 画图有两条路：
 *   - comfyui：主控机本机的 ComfyUI，只连 127.0.0.1，只用固定工作流，按节点映射填提示词、宽、高、种子
 *   - codex：林离节点上的 `codex-image` profile。主控端发一个 kind = "image" 的 StartRun（见 remote-protocol.ts），
 *     节点画完在 terminal(completed).artifact 里给出图片信息，主控端用 GET /v1/runs/:runId/artifacts/:sha256 取回、校验后存成 generated 图片。
 *     这个远端 Run 不经过盖章，主控端也不建 Approval / Run 记录，只在 MediaJob.remoteRunId 上记下它
 * - 显卡上的任务（comfyui 画图、语音合成）共用一条全局队列，并发 1；走 codex 的画图一次只跑一张
 * - 授权来源（authorization）只能是下面几种，由 main 根据发起方式填写，不接受 renderer 或模型自报
 */

export const MediaJobId = prefixedId("mjob");
export type MediaJobId = z.infer<typeof MediaJobId>;

export const MediaJobKind = z.enum(["draw", "speech"]);
export type MediaJobKind = z.infer<typeof MediaJobKind>;

/**
 * 谁同意了这次生成：
 * - user_tap       : 你点了请求卡上的「画」，或用了 /画
 * - user_play      : 你点了「播放」
 * - reply_as_voice : 你这条消息开了「用语音回」（C-42c）
 * - immersive      : 会话开着沉浸模式，秘书的媒体意图自动执行（C-42d）。只在聊天里有，讨论室没有沉浸模式
 *
 * 和任务种类绑定：画图只能是 user_tap / immersive；语音只能是 user_play / reply_as_voice / immersive
 */
export const MediaAuthorization = z.enum(["user_tap", "user_play", "reply_as_voice", "immersive"]);
export type MediaAuthorization = z.infer<typeof MediaAuthorization>;

const DRAW_AUTHORIZATIONS: readonly MediaAuthorization[] = ["user_tap", "immersive"];
const SPEECH_AUTHORIZATIONS: readonly MediaAuthorization[] = ["user_play", "reply_as_voice", "immersive"];

/**
 * 任务从哪来：聊天里的一条消息（C-34 的 ConversationId / ChatMessageId），或讨论室议题里的一条消息。
 * agent = 提出这个意图的秘书；你自己用 /画 时为 null
 */
export const MediaSource = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("chat"), conversationId: ConversationId, messageId: ChatMessageId, agent: AgentName.nullable() }).strict(),
  z.object({ kind: z.literal("topic"), projectId: ProjectId, messageId: MessageId, agent: AgentName.nullable() }).strict(),
]);
export type MediaSource = z.infer<typeof MediaSource>;

/** 「停」和列表的范围：一个聊天会话，或一个议题 */
export const MediaScope = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("chat"), conversationId: ConversationId }).strict(),
  z.object({ kind: z.literal("topic"), projectId: ProjectId }).strict(),
]);
export type MediaScope = z.infer<typeof MediaScope>;

// ================================================================ 画图

export const DrawBackend = z.enum(["codex", "comfyui"]);
export type DrawBackend = z.infer<typeof DrawBackend>;

/** 尺寸白名单（宽 x 高） */
export const DrawSize = z.enum(["1024x1024", "1024x1536", "1536x1024"]);
export type DrawSize = z.infer<typeof DrawSize>;

export const DRAW_PROMPT_MAX_CHARS = 1000;

/** 画什么。prompt 往往是秘书写的：显示和回流到 Prompt 时都按不可信内容处理（进 nonce 边界、转义） */
export const DrawRequest = z
  .object({
    prompt: z.string().trim().min(1).max(DRAW_PROMPT_MAX_CHARS),
    size: DrawSize,
    /** auto = 按 85% 规则选路；codex / comfyui = 你手动指定 */
    backend: z.union([DrawBackend, z.literal("auto")]),
  })
  .strict();
export type DrawRequest = z.infer<typeof DrawRequest>;

/** 选路阈值：Codex 两个额度窗口任一达到它就走本机（用户 2026-10-23 定；S-24 实测单图消耗后可能请用户重定） */
export const CODEX_DRAW_QUOTA_THRESHOLD_PERCENT = 85;
/** 读 Codex 额度的超时；超时按「读不到」走本机 */
export const CODEX_QUOTA_READ_TIMEOUT_MS = 2_000;

/** 没走林离（或没走成）的原因。界面照原因写，例如「林离额度 87%，改用本机」 */
export const DrawFallbackReason = z.enum([
  "quota_threshold",       // 任一窗口 ≥ 阈值
  "quota_unknown",         // 读不到 / 超时 / 少了某个窗口
  "credits_in_use",        // 已经在用 credits
  "codex_unavailable",     // 节点离线、忙、unknown_model、不支持 image Run
  "session_local_only",    // 这个会话关掉了「自动画图用订阅」。只用于沉浸模式自动画（authorization = immersive），
                           // 你点出来的画图（含请求卡）不受这个开关影响，所以 draw.preview 不会返回它
]);
export type DrawFallbackReason = z.infer<typeof DrawFallbackReason>;

/** 一个 profile 的订阅额度快照（节点 GET /v1/profiles/:profileId/quota 的结果） */
export const SubscriptionQuota = RemoteProfileQuota;
export type SubscriptionQuota = z.infer<typeof SubscriptionQuota>;

/** 选路记录：每张图都存，导出能看到 */
export const DrawRoute = z.object({
  backend: DrawBackend,
  /** 你在请求卡上手动指定了这条路 */
  manual: z.boolean(),
  /** 手动选林离且额度 ≥ 阈值或读不到时，你又点了一次确认 */
  confirmedOverThreshold: z.boolean(),
  /** 走本机的原因；走林离时为 null */
  fallbackReason: DrawFallbackReason.nullable(),
  /** 画之前 / 之后读到的额度；没读或读不到为 null */
  quotaBefore: SubscriptionQuota.nullable(),
  quotaAfter: SubscriptionQuota.nullable(),
});
export type DrawRoute = z.infer<typeof DrawRoute>;

/** 画出来的图和它的来历 */
export const GeneratedImage = z.object({
  ref: ImageRef,
  sha256: Sha256Hex,
  backend: DrawBackend,
  /** codex 时是模型 id（例如 gpt-image-2）；comfyui 时是工作流里的模型名；不知道为 null */
  model: z.string().max(120).nullable(),
  prompt: z.string().max(DRAW_PROMPT_MAX_CHARS),
  size: DrawSize,
  /** 应用只生成 32 位种子（JS number 能精确表示），工作流里自带的更大种子不用 */
  seed: z.number().int().nonnegative().max(0xffff_ffff).nullable(),
  /** comfyui 工作流 JSON 的 sha256；codex 为 null */
  workflowHash: Sha256Hex.nullable(),
});
export type GeneratedImage = z.infer<typeof GeneratedImage>;

// ================================================================ 任务

export const MediaFailureReason = z.enum([
  "backend_unavailable",   // 两条路都不可用 / 语音合成进程起不来
  "quota_exhausted",       // 画到一半 Codex 额度用完（不自动重画，给「改用本机」）
  "generation_failed",     // 模型或工作流报错
  "artifact_invalid",      // 取回的图 sha256 / 类型 / 大小不对
  "gpu_queue_timeout",     // 显卡排队超时（还在 queued 就等太久 → failed）。开始以后超过总时限才是 timed_out 状态
  "internal",
]);
export type MediaFailureReason = z.infer<typeof MediaFailureReason>;

export const MediaCancelReason = z.enum([
  "user_cancel",       // 取消了这一个
  "user_stop",         // 点了会话的「停」
  "immersive_off",     // 关掉了沉浸模式
  "message_withdrawn", // 消息被撤回
  "superseded",        // 回答被重试 / 重新生成
  "app_restart",       // 应用重启时还没结束
]);
export type MediaCancelReason = z.infer<typeof MediaCancelReason>;

export const MediaJob = z
  .object({
    id: MediaJobId,
    kind: MediaJobKind,
    state: MediaJobState,
    authorization: MediaAuthorization,
    source: MediaSource,
    /**
     * 去重键的一部分：同一条消息、同一位秘书、同一个意图只生成一次。
     * 只有 immersive 带（且 source.agent 必须是那位秘书）；其余授权为 null
     */
    intentHash: Sha256Hex.nullable(),
    /** kind = draw 时必填 */
    draw: DrawRequest.nullable(),
    /** 开始画以后才有 */
    route: DrawRoute.nullable(),
    /** 走 codex 时节点上的 Run */
    remoteRunId: RunId.nullable(),
    /** succeeded 的画图任务必填 */
    result: GeneratedImage.nullable(),
    failure: z.object({ reason: MediaFailureReason, message: z.string().max(2000) }).nullable(),
    cancelReason: MediaCancelReason.nullable(),
    createdAt: IsoTimestamp,
    startedAt: IsoTimestamp.nullable(),
    finishedAt: IsoTimestamp.nullable(),
  })
  .refine((j) => (j.kind === "draw") === (j.draw !== null), "draw 只在画图任务上有")
  .refine((j) => (j.state === "failed") === (j.failure !== null), "只有 failed 带 failure")
  .refine((j) => (j.state === "cancelled") === (j.cancelReason !== null), "只有 cancelled 带 cancelReason")
  .refine((j) => j.kind !== "draw" || (j.state === "succeeded") === (j.result !== null), "画图成功必须有结果")
  // 时间：queued 没开始；running 开始了没结束；终态都有结束时间；succeeded / timed_out 一定开始过
  .refine((j) => j.state !== "queued" || (j.startedAt === null && j.finishedAt === null), "queued 不能有开始 / 结束时间")
  .refine((j) => j.state !== "running" || (j.startedAt !== null && j.finishedAt === null), "running 要有开始时间、不能有结束时间")
  .refine((j) => j.state === "queued" || j.state === "running" || j.finishedAt !== null, "终态要有结束时间")
  .refine((j) => (j.state !== "succeeded" && j.state !== "timed_out") || j.startedAt !== null, "succeeded / timed_out 要有开始时间")
  // 授权和去重键
  .refine(
    (j) => (j.authorization === "immersive") === (j.intentHash !== null) && (j.authorization !== "immersive" || j.source.agent !== null),
    "只有 immersive 带 intentHash，且要有提出意图的秘书",
  )
  // 选路和结果一致
  .refine((j) => j.kind === "draw" || (j.route === null && j.remoteRunId === null), "只有画图任务有 route / remoteRunId")
  .refine((j) => j.remoteRunId === null || j.route?.backend === "codex", "remoteRunId 只在走林离时有")
  .refine((j) => j.result === null || j.route !== null, "有结果就要有选路记录")
  .refine(
    (j) =>
      j.result === null ||
      (j.result.backend === j.route?.backend && j.result.prompt === j.draw?.prompt && j.result.size === j.draw?.size),
    "结果的后端 / 提示词 / 尺寸要和请求、选路一致",
  )
  .refine((j) => j.route?.fallbackReason !== "session_local_only" || j.authorization === "immersive", "session_local_only 只用于沉浸模式")
  .refine(
    (j) => (j.kind === "draw" ? DRAW_AUTHORIZATIONS : SPEECH_AUTHORIZATIONS).includes(j.authorization),
    "授权方式要和任务种类对得上（画图只能 user_tap / immersive）",
  )
  .refine((j) => j.authorization !== "immersive" || j.source.kind === "chat", "沉浸模式只在聊天里");
export type MediaJob = z.infer<typeof MediaJob>;

/**
 * 选路预览：请求卡打开时显示「这次会用林离（额度 42%）」或「会用本机，因为……」。
 * 请求卡点出来的是 user_tap，不受会话的「自动画图用订阅」影响，所以不需要会话信息，fallbackReason 不会是 session_local_only
 */
export const DrawRoutePreview = z.object({
  backend: DrawBackend.nullable(),
  fallbackReason: DrawFallbackReason.nullable(),
  quota: SubscriptionQuota.nullable(),
  /** 手动选林离时：none = 可以直接画；confirm = 要再点一次确认（≥ 阈值或读不到）；blocked = 不能选（≥ 100% 或在用 credits） */
  codexManual: z.enum(["none", "confirm", "blocked"]),
  comfyuiAvailable: z.boolean(),
});
export type DrawRoutePreview = z.infer<typeof DrawRoutePreview>;
