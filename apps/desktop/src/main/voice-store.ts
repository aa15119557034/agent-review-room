import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  findLiveVoiceRecordingBySha,
  getVoiceRecording,
  insertVoiceRecording,
  ulid,
  type SqliteDatabase,
} from "@room/db";
import { AudioRef as AudioRefSchema, CHAT_LIMITS, type AudioRef, type VoiceRecording } from "@room/schemas";

/**
 * 录音本体 + 引用记录（D-34b 第二段）。
 *
 * - 字节存 `userData/audio/<sha256>`：按内容去重，同一段录音只有一份；写的时候先写 `.tmp` 再改名（原子）
 * - 引用记录在 voice_recordings（v12）：audio（aud_…）、时长、状态、转写
 * - 同一份内容同时只留一条「还在用」的记录（transcribing / ready）；failed 的可以重新导入
 * - 时长由本地 ASR sidecar 探（webm / ogg 要解码，不在主进程里自己做）
 */

export type VoiceFormat = "wav" | "webm" | "ogg";

export const VOICE_MIME: Record<VoiceFormat, "audio/wav" | "audio/webm" | "audio/ogg"> = {
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
  /** 本体文件（已有记录时也有） */
  file: string;
}

export class VoiceStore {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly audioDir: string,
    private readonly probe: (path: string) => Promise<number>,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    mkdirSync(audioDir, { recursive: true });
  }

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
      return { recording: existing, created: false, file: this.audioFile(sha256) };
    }

    const file = this.audioFile(sha256);
    const wrote = this.writeBytes(sha256, bytes);
    let durationMs: number;
    try {
      durationMs = await this.probe(file);
    } catch (error) {
      if (wrote) this.removeBytes(sha256);
      throw new VoiceRejectedError("unsupported_type", `读不出这段录音的时长：${error instanceof Error ? error.message : String(error)}`);
    }
    if (!Number.isInteger(durationMs) || durationMs <= 0) {
      if (wrote) this.removeBytes(sha256);
      throw new VoiceRejectedError("unsupported_type", "读不出这段录音的时长");
    }
    if (durationMs > CHAT_LIMITS.voiceMaxMs) {
      if (wrote) this.removeBytes(sha256);
      throw new VoiceRejectedError("too_long", "录音太长了（上限 5 分钟）");
    }

    const recording: VoiceRecording = {
      audio: `aud_${ulid()}` as AudioRef,
      durationMs,
      status: "transcribing",
      transcript: null,
      error: null,
      createdAt: this.now(),
    };
    insertVoiceRecording(this.db, { recording, sha256, mime: VOICE_MIME[input.format], bytes: bytes.length });
    return { recording, created: true, file };
  }

  /** `room-audio://<ref>` 要的文件路径和类型；没有记录 / 文件丢了返回 null */
  resolveAudio(ref: string): { file: string; mime: "audio/wav" | "audio/webm" | "audio/ogg" } | null {
    if (!AudioRefSchema.safeParse(ref).success) return null;
    const row = getVoiceRecording(this.db, ref);
    if (row === null) return null;
    const sha = this.shaOf(ref);
    if (sha === null) return null;
    const file = this.audioFile(sha);
    if (!existsSync(file)) return null;
    return { file, mime: this.mimeOf(ref) ?? "audio/wav" };
  }

  /** 只读：把字节读出来（测试和 ASR sidecar 用） */
  readAudio(ref: string): Buffer | null {
    const hit = this.resolveAudio(ref);
    return hit === null ? null : readFileSync(hit.file);
  }

  private shaOf(ref: string): string | null {
    const row = this.db.prepare("SELECT sha256 FROM voice_recordings WHERE audio_ref = ?").get(ref) as
      | { sha256: string }
      | undefined;
    return row?.sha256 ?? null;
  }

  private mimeOf(ref: string): "audio/wav" | "audio/webm" | "audio/ogg" | null {
    const row = this.db.prepare("SELECT mime FROM voice_recordings WHERE audio_ref = ?").get(ref) as
      | { mime: "audio/wav" | "audio/webm" | "audio/ogg" }
      | undefined;
    return row?.mime ?? null;
  }

  private audioFile(sha256: string): string {
    return join(this.audioDir, sha256);
  }

  private writeBytes(sha256: string, bytes: Buffer): boolean {
    const file = this.audioFile(sha256);
    if (existsSync(file)) return false;
    const tmp = join(this.audioDir, `${sha256}.${process.pid}.tmp`);
    writeFileSync(tmp, bytes);
    renameSync(tmp, file);
    return true;
  }

  private removeBytes(sha256: string): void {
    try {
      rmSync(this.audioFile(sha256), { force: true });
    } catch {
      // 删不掉就留着，以后清理
    }
  }
}

/** `room-audio://<ref>` → 字节（和 room-image 同一套规则：只认 aud_…，别的 404） */
export function createAudioProtocolHandler(store: VoiceStore): (request: Request) => Promise<Response> {
  return async (request) => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return new Response("bad request", { status: 400 });
    }
    if (url.protocol !== "room-audio:") return new Response("not found", { status: 404 });
    if (url.pathname !== "" && url.pathname !== "/") return new Response("not found", { status: 404 });
    // Chromium 对 standard scheme 会把 host 转成小写；AudioRef 的 ULID 是大写，这里规范回去（同 #120）
    const host = url.host;
    const ref = host.startsWith("aud_") ? "aud_" + host.slice(4).toUpperCase() : host;
    const hit = store.resolveAudio(ref);
    if (hit === null) return new Response("not found", { status: 404 });
    const bytes = await readFile(hit.file);
    return new Response(bytes, {
      status: 200,
      headers: {
        "content-type": hit.mime,
        "content-length": String(bytes.length),
        "cache-control": "private, max-age=31536000, immutable",
      },
    });
  };
}
