import { createHash } from "node:crypto";
import { findLiveVoiceRecordingBySha, insertVoiceRecording, type SqliteDatabase } from "@room/db";
import { CHAT_LIMITS, type AudioMime, type VoiceRecording } from "@room/schemas";
import type { MediaStore } from "./media-store";

/**
 * 录音本体 + 引用记录（D-34b 第二段；#137 评审第 1 条：字节并入 D-37b 的 MediaStore）。
 *
 * - 字节**不再自己存**：走 `MediaStore.addAudioDetailed(bytes, mime)` 拿 `aud_` 引用（按内容去重、
 *   原子写 `.tmp` + 改名都在那边做），和合成语音共用一张 `audio_refs` 表和同一个 `room-audio://` 处理器
 * - 引用记录在 voice_recordings（v12）：audio（aud_…）、时长、状态、转写
 * - 同一份内容同时只留一条「还在用」的记录（transcribing / ready）；failed 的可以重新导入
 * - 太长 / 探不出时长时，**只有这次真的新建了引用**（`created === true`）才删掉；删的时候 MediaStore
 *   会先查 `audioShaInUse`，不会误删合成语音还在引用的那份字节
 * - 时长由本地 ASR sidecar 探（webm / ogg 要解码，不在主进程里自己做）
 */

export type VoiceFormat = "wav" | "webm" | "ogg";

export const VOICE_MIME: Record<VoiceFormat, AudioMime> = {
  wav: "audio/wav",
  webm: "audio/webm",
  ogg: "audio/ogg",
};

export type VoiceRejectReason = "empty_file" | "too_big" | "unsupported_type" | "too_long";

export class VoiceRejectedError extends Error {
  constructor(
    readonly code: VoiceRejectReason,
    message: string,
  ) {
    super(message);
    this.name = "VoiceRejectedError";
  }
}

/** 按文件头认格式；认不出返回 null。声明格式和实际字节不一致也算不支持 */
export function sniffVoiceFormat(bytes: Buffer): VoiceFormat | null {
  if (bytes.length >= 12 && bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WAVE") {
    return "wav";
  }
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return "webm"; // EBML
  }
  if (bytes.length >= 4 && bytes.toString("latin1", 0, 4) === "OggS") return "ogg";
  return null;
}

export interface AddVoiceInput {
  format: VoiceFormat;
  bytes: Buffer;
}

export interface AddVoiceResult {
  recording: VoiceRecording;
  /** false = 同一份内容已经有记录（transcribing / ready），没有新写库 */
  created: boolean;
  /** 本体文件（已有记录时也有；极端情况下字节丢了就是空串） */
  file: string;
}

/** VoiceService 需要的存储能力（测试里可以换成假的） */
export interface VoiceAudioStore {
  add(input: AddVoiceInput): Promise<AddVoiceResult>;
  resolveAudio(ref: string): { file: string; mime: AudioMime } | null;
}

export class MediaVoiceStore implements VoiceAudioStore {
  constructor(
    private readonly media: MediaStore,
    private readonly db: SqliteDatabase,
    private readonly probe: (path: string) => Promise<number>,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  /** 导入一段录音：校验格式和大小、按内容去重、探时长、落库（transcribing） */
  async add(input: AddVoiceInput): Promise<AddVoiceResult> {
    const bytes = input.bytes;
    if (bytes.length === 0) throw new VoiceRejectedError("empty_file", "录音是空的");
    if (bytes.length > CHAT_LIMITS.voiceImportMaxBytes) {
      throw new VoiceRejectedError("too_big", "录音太大（上限 16 MB）");
    }
    const sniffed = sniffVoiceFormat(bytes);
    if (sniffed === null || sniffed !== input.format) {
      throw new VoiceRejectedError("unsupported_type", "录音格式不对（只收 wav / webm / ogg）");
    }

    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const existing = findLiveVoiceRecordingBySha(this.db, sha256);
    if (existing !== null) {
      const hit = this.media.resolveAudio(existing.audio);
      return { recording: existing, created: false, file: hit?.file ?? "" };
    }

    const { record, created } = this.media.addAudioDetailed(bytes, VOICE_MIME[input.format], this.now());
    const hit = this.media.resolveAudio(record.ref);
    if (hit === null) {
      if (created) this.media.deleteAudio(record.ref);
      throw new VoiceRejectedError("unsupported_type", "录音存不进音频库");
    }

    let durationMs: number;
    try {
      durationMs = await this.probe(hit.file);
    } catch (error) {
      if (created) this.media.deleteAudio(record.ref);
      throw new VoiceRejectedError(
        "unsupported_type",
        `读不出这段录音的时长：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!Number.isInteger(durationMs) || durationMs <= 0) {
      if (created) this.media.deleteAudio(record.ref);
      throw new VoiceRejectedError("unsupported_type", "读不出这段录音的时长");
    }
    if (durationMs > CHAT_LIMITS.voiceMaxMs) {
      if (created) this.media.deleteAudio(record.ref);
      throw new VoiceRejectedError("too_long", "录音太长了（上限 5 分钟）");
    }

    const recording: VoiceRecording = {
      audio: record.ref,
      durationMs,
      status: "transcribing",
      transcript: null,
      error: null,
      createdAt: this.now(),
    };
    insertVoiceRecording(this.db, { recording, sha256, mime: VOICE_MIME[input.format], bytes: bytes.length });
    return { recording, created: true, file: hit.file };
  }

  /** `room-audio://<ref>` 要的文件路径和类型；和合成语音共用 MediaStore 的解析（没有记录 / 文件丢了 → null） */
  resolveAudio(ref: string): { file: string; mime: AudioMime } | null {
    return this.media.resolveAudio(ref);
  }
}
