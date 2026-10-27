import { z } from "zod";
import { IsoTimestamp } from "./common";
import { DrawSize, DRAW_PROMPT_MAX_CHARS } from "./media";
import { SPEAK_MAX_CHARS } from "./speech";
import type { ChatAgentOutput } from "./chat";

/**
 * 媒体意图和沉浸模式（C-42d，ADR-004 §3a，阶段 1B-M2 实现，契约先定）。
 *
 * 秘书的回答就是 C-34 的 ChatAgentOutput（reply / skip），C-42d 只在 reply 分支上加 speak / draw 两个入口（见 chat.ts）：
 * - 信封解析失败（不是合法 JSON、kind 不对、skip 带了别的字段、reply 没有正文）→ 这个回答位按 ADR-003 记失败，
 *   不降级成 skip，不执行任何媒体意图
 * - 单聊或被点名的人给出 skip 仍是失败（ADR-003）
 * - 信封合法后，speak 和 draw **各自**校验：哪一项不合格（超长、尺寸不在白名单、多余字段）就只丢那一项、
 *   另一项照常用；文字照常显示，并记下丢掉的原始值；不让整条回答失败。speak: false 等于没写，不算丢
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

/**
 * C-42e：沉浸模式开着、媒体意图却没有自动执行，在写回答的同一个事务里定下的原因（界面照原因把它显示成请求卡 / 播放按钮）：
 * - hourly_limit：入队占名额时，这个会话最近 60 分钟的自动画图 / 自动语音已经到上限
 * 入队之后才发生的退回（显卡排队超时、ComfyUI 没开）不在这里：任务本身会 failed（gpu_queue_timeout / backend_unavailable），
 * 界面看任务的结局。
 *
 * 不变量（D-38a / D-39 的验收）：沉浸模式开着时，mediaIntent 里的每一项要么有一条 authorization = immersive 的 MediaJob
 * （本机也画不了时允许立刻 failed(backend_unavailable)），要么在 immersiveDeferred 里有原因，不能两样都没有。
 * 这是写回答那一刻的记录：之后你手动点「画」/「播放」也不改它，界面以任务和语音片段的现状为准
 */
export const ImmersiveDeferReason = z.enum(["hourly_limit"]);
export type ImmersiveDeferReason = z.infer<typeof ImmersiveDeferReason>;

export const ImmersiveDeferral = z
  .object({ speak: ImmersiveDeferReason.optional(), draw: ImmersiveDeferReason.optional() })
  .strict()
  .refine((d) => d.speak !== undefined || d.draw !== undefined, "没有被退回就省略");
export type ImmersiveDeferral = z.infer<typeof ImmersiveDeferral>;

/**
 * 从合法的 reply 信封里取媒体意图，speak 和 draw 分开校验：
 * - intent：合格的那几项；一项都没有为 null
 * - dropped：有没有哪一项因为不合格被丢掉（调用方记下原始值）
 *
 * speakableChars：回答正文经过朗读过滤（去代码块、图表数据、链接、表情说明，D-37b，和 speech.play 用同一个函数）之后的字数。
 * speak 只对 1～SPEAK_MAX_CHARS 字的朗读文本生效（ADR-004 §3a）；超过或过滤后为空就丢掉 speak（dropped = true），
 * 文字照常显示。这样存下来的 mediaIntent.speak 一定是合成得了的，界面不会出现点了播放却被拒的按钮
 */
export function extractMediaIntent(
  env: Extract<ChatAgentOutput, { kind: "reply" }>,
  speakableChars: number,
): {
  intent: MediaIntent | null;
  dropped: boolean;
} {
  const intent: MediaIntent = {};
  let dropped = false;
  if (env.speak === true) {
    if (speakableChars > 0 && speakableChars <= SPEAK_MAX_CHARS) intent.speak = true;
    else dropped = true;
  } else if (env.speak !== undefined && env.speak !== false) dropped = true;
  if (env.draw !== undefined) {
    const d = DrawIntent.safeParse(env.draw);
    if (d.success) intent.draw = d.data;
    else dropped = true;
  }
  return { intent: Object.keys(intent).length > 0 ? intent : null, dropped };
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

/**
 * 最近 60 分钟用了多少（给界面和 Prompt 里的「剩余次数」用）。
 * 是 main 在 asOf 那一刻按数据库里的占位记录算好的快照，界面不自己推算；窗口是 (asOf - 60 分钟, asOf]
 */
export const ImmersiveUsage = z.object({
  asOf: IsoTimestamp,
  drawsLastHour: z.number().int().nonnegative(),
  voiceClipsLastHour: z.number().int().nonnegative(),
});
export type ImmersiveUsage = z.infer<typeof ImmersiveUsage>;
