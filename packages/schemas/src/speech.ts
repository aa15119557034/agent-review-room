import { z } from "zod";
import { IsoTimestamp, Sha256Hex, prefixedId } from "./common";

/**
 * 语音合成（C-42c，ADR-004 §4，阶段 1B-M1）。
 *
 * - 文字是正本，语音从文字合成：秘书照样回文字，SpeechClip 只是附带的音频
 * - 什么时候合成（授权看 MediaJob.authorization，由 main 填）：
 *   - user_play      : 你点了「播放」
 *   - reply_as_voice : 你这条消息开了「用语音回」（ChatMessage.replyAsVoice，字段在 C-34）。
 *                      只看你的消息上的这个开关，**不看**秘书输出里的 speak
 *   - immersive      : 沉浸模式下秘书的 speak 意图（C-42d）
 * - 在主控机本地合成，独立进程，走全局显卡队列；不上传第三方
 * - 缓存键 = sha256(朗读文本) + voiceId + speed + engine + engineVersion，命中就不再合成。
 *   语速在合成时生效（不是播放端变速），所以改了语速就不命中旧缓存
 * - 朗读文本 = 回答正文去掉代码块、图表数据、链接和表情说明（朗读过滤，D-37b 实现），超过 SPEAK_MAX_CHARS 不合成
 *
 * 音频只经过 main：renderer 拿 AudioRef，用 `${AUDIO_URL_SCHEME}://aud_…` 播放，规则和 room-image 一样
 * （只接受这个格式、只读、不可导航、路径由 main 映射）。
 */

export const SpeechClipId = prefixedId("spch");
export type SpeechClipId = z.infer<typeof SpeechClipId>;

export const AudioRef = prefixedId("aud");
export type AudioRef = z.infer<typeof AudioRef>;

export const AUDIO_URL_SCHEME = "room-audio";

export const AudioMime = z.enum(["audio/ogg", "audio/wav", "audio/mpeg"]);
export type AudioMime = z.infer<typeof AudioMime>;

/** 超过这个字数（朗读过滤之后）的回答不合成语音，只显示文字 */
export const SPEAK_MAX_CHARS = 2000;

/**
 * 合成引擎。具体用哪个由你盲听后定（D-37a），之后只用选中的那个。
 * 枚举值不删：试听时合成过的片段要能照常读出来
 */
export const TtsEngine = z.enum(["cosyvoice", "indextts2", "gpt-sovits"]);
export type TtsEngine = z.infer<typeof TtsEngine>;

/** 声音 id：引擎里的预置音色，或用你提供、你有权使用的参考录音做的音色。不仿真人的声音 */
export const VoiceId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
export type VoiceId = z.infer<typeof VoiceId>;

/** 一个可选的声音（voices.list 的一项） */
export const VoiceOption = z
  .object({
  id: VoiceId,
  displayName: z.string().min(1).max(40),
  engine: TtsEngine,
  /** preset = 引擎自带；reference = 用参考录音做的 */
  source: z.enum(["preset", "reference"]),
  /** 试听用的短音频；没有为 null */
  sampleRef: AudioRef.nullable(),
  })
  .strict();
export type VoiceOption = z.infer<typeof VoiceOption>;

/** 语速倍数，合成时生效 */
export const VoiceSpeed = z.number().min(0.5).max(2);

/** 秘书的声音设置（AgentProfile.voice）。没设置时不合成，播放按钮显示「还没选声音」 */
export const VoiceProfile = z
  .object({
    voiceId: VoiceId,
    /** 语速倍数 */
    speed: VoiceSpeed,
  })
  .strict();
export type VoiceProfile = z.infer<typeof VoiceProfile>;

export const SpeechClip = z
  .object({
    id: SpeechClipId,
    /** sha256(UTF-8(朗读文本))，朗读文本是过滤之后的 */
    textHash: Sha256Hex,
    voiceId: VoiceId,
    /** 合成时用的语速 */
    speed: VoiceSpeed,
    engine: TtsEngine,
    engineVersion: z.string().min(1).max(60),
    audioRef: AudioRef,
    mime: AudioMime,
    durationMs: z.number().int().positive(),
    createdAt: IsoTimestamp,
  })
  .strict();
export type SpeechClip = z.infer<typeof SpeechClip>;
