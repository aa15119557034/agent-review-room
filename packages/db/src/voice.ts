import { AudioRef as AudioRefSchema, VoiceRecording as VoiceRecordingSchema, type VoiceRecording } from "@room/schemas";
import type { SqliteDatabase } from "./database";

/**
 * 录音的读写（D-34b 第一段）。
 *
 * 契约里一段录音是 VoiceRecording：audio（aud_…）、时长、状态（transcribing / ready / failed）、
 * ready 时的转写、failed 时的原因。这里只做「行 ↔ 契约」和状态检查：
 * - 新导入的录音一定是 transcribing（还没有转写、也没有失败原因）
 * - transcribing → ready 必须带转写（source 只能是 transcribed；人工改过的转写在 D-34b 后续）
 * - transcribing → failed 必须带原因
 * - ready / failed 之后不再改（转写结果以第一份为准；要重来就重新导入）
 *
 * 转写本身（本地 ASR）不在这里：那是主控机上的另一个进程，等 D-34b 的形态定下来再接。
 *
 * TODO(D-34b 接 ASR 时)：应用重启后遗留的 transcribing 要收尾成 failed（「应用重启，转写中断」），
 * 否则界面会一直转圈——留给接转写引擎那一段。
 */

interface VoiceRecordingRow {
  audio_ref: string;
  sha256: string;
  mime: string;
  bytes: number;
  duration_ms: number;
  status: string;
  transcript: string | null;
  error: string | null;
  created_at: string;
}

const toRecording = (row: VoiceRecordingRow): VoiceRecording =>
  VoiceRecordingSchema.parse({
    audio: row.audio_ref,
    durationMs: row.duration_ms,
    status: row.status,
    transcript: row.transcript === null ? null : (JSON.parse(row.transcript) as unknown),
    error: row.error,
    createdAt: row.created_at,
  });

/** 一次导入要落库的东西（契约里没有 sha256 / 字节数，这里单独传） */
export interface NewVoiceRecording {
  recording: VoiceRecording;
  sha256: string;
  mime: "audio/wav" | "audio/ogg" | "audio/webm" | "audio/mpeg";
  bytes: number;
}

export function insertVoiceRecording(db: SqliteDatabase, input: NewVoiceRecording): void {
  const parsed = VoiceRecordingSchema.parse(input.recording);
  if (parsed.status !== "transcribing") throw new Error("voice recordings start as transcribing");
  if (!/^[0-9a-f]{64}$/.test(input.sha256)) throw new Error("voice sha256 must be 64 lowercase hex chars");
  if (!Number.isInteger(input.bytes) || input.bytes <= 0 || input.bytes > 16 * 1024 * 1024) {
    throw new Error("voice bytes are out of range");
  }
  db.prepare(
    "INSERT INTO voice_recordings (audio_ref, sha256, mime, bytes, duration_ms, status, transcript, error, created_at) " +
      "VALUES (?, ?, ?, ?, ?, 'transcribing', NULL, NULL, ?)",
  ).run(parsed.audio, input.sha256, input.mime, input.bytes, parsed.durationMs, parsed.createdAt);
}

export function getVoiceRecording(db: SqliteDatabase, audioRef: string): VoiceRecording | null {
  if (!AudioRefSchema.safeParse(audioRef).success) return null;
  const row = db.prepare("SELECT * FROM voice_recordings WHERE audio_ref = ?").get(audioRef) as
    | VoiceRecordingRow
    | undefined;
  return row === undefined ? null : toRecording(row);
}

export function findVoiceRecordingBySha(db: SqliteDatabase, sha256: string): VoiceRecording | null {
  const row = db.prepare("SELECT * FROM voice_recordings WHERE sha256 = ?").get(sha256) as VoiceRecordingRow | undefined;
  return row === undefined ? null : toRecording(row);
}

/** 还在用（transcribing / ready）的同内容录音；failed 的可以重新导入（v12 的部分唯一索引就是这么约束的） */
export function findLiveVoiceRecordingBySha(db: SqliteDatabase, sha256: string): VoiceRecording | null {
  const row = db
    .prepare("SELECT * FROM voice_recordings WHERE sha256 = ? AND status <> 'failed' ORDER BY created_at DESC LIMIT 1")
    .get(sha256) as VoiceRecordingRow | undefined;
  return row === undefined ? null : toRecording(row);
}

/**
 * 启动时收尾：上一次没转完的录音记成 failed（「应用重启，转写中断」），不然界面一直转圈。
 * 返回收尾了几条。
 */
export function failStaleTranscribing(db: SqliteDatabase, error: string): number {
  const message = error.trim();
  if (message.length < 1 || message.length > 2000) throw new Error("转写中断说明要 1～2000 字");
  const result = db
    .prepare("UPDATE voice_recordings SET status = 'failed', error = ?, transcript = NULL WHERE status = 'transcribing'")
    .run(message);
  return Number(result.changes);
}

export function listVoiceRecordings(db: SqliteDatabase, limit = 50): VoiceRecording[] {
  const rows = db
    .prepare("SELECT * FROM voice_recordings ORDER BY created_at DESC, audio_ref DESC LIMIT ?")
    .all(limit) as VoiceRecordingRow[];
  return rows.map(toRecording);
}

export class VoiceStatusConflictError extends Error {
  constructor(
    readonly audioRef: string,
    readonly expected: string,
    readonly actual: string | null,
  ) {
    super(`录音 ${audioRef} 的状态已经变了（期望 ${expected}，实际 ${actual ?? "不存在"}）`);
    this.name = "VoiceStatusConflictError";
  }
}

/** 转写完成：transcribing → ready（转写必须是 transcribed） */
export function markVoiceReady(db: SqliteDatabase, audioRef: string, transcript: VoiceRecording["transcript"]): VoiceRecording {
  if (transcript === null || transcript.source !== "transcribed") throw new Error("ready 需要引擎给的转写");
  const current = getVoiceRecording(db, audioRef);
  if (current === null) throw new VoiceStatusConflictError(audioRef, "transcribing", null);
  if (current.status !== "transcribing") throw new VoiceStatusConflictError(audioRef, "transcribing", current.status);
  // 先按契约校验再写库：空转写（静音录音常见）会在这里被拒，不会把坏行写进去（C酱 #126）
  const next: VoiceRecording = { ...current, status: "ready", transcript, error: null };
  VoiceRecordingSchema.parse(next);
  db.prepare(
    "UPDATE voice_recordings SET status = 'ready', transcript = ?, error = NULL WHERE audio_ref = ? AND status = 'transcribing'",
  ).run(JSON.stringify(transcript), audioRef);
  return getVoiceRecording(db, audioRef) as VoiceRecording;
}

/** 转写失败：transcribing → failed */
export function markVoiceFailed(db: SqliteDatabase, audioRef: string, error: string): VoiceRecording {
  const message = error.trim();
  if (message.length < 1 || message.length > 2000) throw new Error("转写失败说明要 1～2000 字");
  const current = getVoiceRecording(db, audioRef);
  if (current === null) throw new VoiceStatusConflictError(audioRef, "transcribing", null);
  if (current.status !== "transcribing") throw new VoiceStatusConflictError(audioRef, "transcribing", current.status);
  VoiceRecordingSchema.parse({ ...current, status: "failed", transcript: null, error: message });
  db.prepare(
    "UPDATE voice_recordings SET status = 'failed', error = ?, transcript = NULL WHERE audio_ref = ? AND status = 'transcribing'",
  ).run(message, audioRef);
  return getVoiceRecording(db, audioRef) as VoiceRecording;
}




