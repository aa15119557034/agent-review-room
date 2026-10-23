import { z } from "zod";
import { DrawSize, DRAW_PROMPT_MAX_CHARS } from "./media";

/**
 * 媒体意图和沉浸模式（C-42d，ADR-004 §3a，阶段 1B-M2 实现，契约先定）。
 *
 * 秘书的回答是一个结构化信封（和 ADR-003 群聊的 reply / skip 是同一个结构，C-34 直接用这里的 AgentReplyEnvelope）：
 * - 信封解析失败（不是合法 JSON、kind 不对、skip 带了别的字段、reply 没有正文）→ 这个回答位按 ADR-003 记失败，
 *   不降级成 skip，不执行任何媒体意图
 * - 单聊或被点名的人给出 skip 仍是失败（ADR-003）
 * - 信封合法后，speak / draw 再单独用 MediaIntent 校验：不合格（超长、尺寸不在白名单、多余字段）只丢掉媒体意图、
 *   照常显示文字，并记下原始意图；不让整条回答失败
 * - 只认结构化字段；正文里写「我给你画一张」不算
 *
 * 媒体意图怎么用：
 * - 沉浸模式开着：在上限内自动执行（authorization = immersive），超限 / 显卡排队超时 / ComfyUI 没开 → 退回成请求卡
 * - 沉浸模式关着：draw 只变成请求卡（你点「画」才开始）；speak 只多一个播放按钮。
 *   语音的自动合成只看你那条消息的 replyAsVoice（C-42c），**不看** speak
 */

/** 秘书想画的图。不能选画图后端：选路由应用按 85% 规则决定 */
export const DrawIntent = z
  .object({
    prompt: z.string().trim().min(1).max(DRAW_PROMPT_MAX_CHARS),
    size: DrawSize,
  })
  .strict();
export type DrawIntent = z.infer<typeof DrawIntent>;

export const MediaIntent = z
  .object({
    /** 这条用语音发。只能是 true；不想用语音就省略 */
    speak: z.literal(true).optional(),
    draw: DrawIntent.optional(),
  })
  .strict();
export type MediaIntent = z.infer<typeof MediaIntent>;

/** 秘书回答的信封。speak / draw 在这一层先不校验内容，见 extractMediaIntent */
export const AgentReplyEnvelope = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("reply"),
      text: z.string().trim().min(1).max(200_000),
      speak: z.unknown().optional(),
      draw: z.unknown().optional(),
    })
    .strict(),
  z.object({ kind: z.literal("skip") }).strict(),
]);
export type AgentReplyEnvelope = z.infer<typeof AgentReplyEnvelope>;

/**
 * 从合法的 reply 信封里取媒体意图。没有意图 → intent 为 null、dropped 为 false；
 * 有但不合格 → intent 为 null、dropped 为 true（调用方记下原始值）
 */
export function extractMediaIntent(env: Extract<AgentReplyEnvelope, { kind: "reply" }>): {
  intent: MediaIntent | null;
  dropped: boolean;
} {
  const raw: Record<string, unknown> = {};
  if (env.speak !== undefined) raw.speak = env.speak;
  if (env.draw !== undefined) raw.draw = env.draw;
  if (Object.keys(raw).length === 0) return { intent: null, dropped: false };
  const r = MediaIntent.safeParse(raw);
  return r.success ? { intent: r.data, dropped: false } : { intent: null, dropped: true };
}

/** 沉浸模式能设的最大值（后端强制；设置只能调低） */
export const IMMERSIVE_LIMITS = {
  /** 每位秘书每条回答最多几张图 */
  drawsPerReply: 1,
  /** 每个会话最近 60 分钟最多自动画几张 */
  drawsPerHour: 6,
  /** 每个会话最近 60 分钟最多自动合成几段语音 */
  voiceClipsPerHour: 30,
  /** 显卡排队超过这个时间，自动任务退回成请求卡 */
  gpuQueueTimeoutMs: 120_000,
} as const;

/**
 * 一个聊天会话的沉浸模式设置。计数规则：
 * - 入队时原子地占名额（群聊几位同时要画也不会一起越过上限）；按会话、最近 60 分钟滑动计算，存数据库，重启不清零
 * - 开始前被取消的退回名额；开始之后不管结局都算
 */
export const ImmersiveSettings = z
  .object({
    enabled: z.boolean(),
    /** 自动画图可以用林离的订阅（仍按 85% 规则）；关掉 = 这个会话自动画图只用本机 */
    autoDrawUsesSubscription: z.boolean(),
    drawsPerHour: z.number().int().min(0).max(IMMERSIVE_LIMITS.drawsPerHour),
    voiceClipsPerHour: z.number().int().min(0).max(IMMERSIVE_LIMITS.voiceClipsPerHour),
  })
  .strict();
export type ImmersiveSettings = z.infer<typeof ImmersiveSettings>;

export const DEFAULT_IMMERSIVE_SETTINGS: ImmersiveSettings = {
  enabled: false,
  autoDrawUsesSubscription: true,
  drawsPerHour: IMMERSIVE_LIMITS.drawsPerHour,
  voiceClipsPerHour: IMMERSIVE_LIMITS.voiceClipsPerHour,
};

/** 最近 60 分钟用了多少（给界面和 Prompt 里的「剩余次数」用） */
export const ImmersiveUsage = z.object({
  drawsLastHour: z.number().int().nonnegative(),
  voiceClipsLastHour: z.number().int().nonnegative(),
});
export type ImmersiveUsage = z.infer<typeof ImmersiveUsage>;
