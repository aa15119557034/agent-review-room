import { SpeechClip as SpeechClipSchema, type SpeechClip, type SpeechClipId, type TtsEngine, type VoiceId } from "@room/schemas";
import type { SqliteDatabase } from "./database";

/**
 * 语音片段的缓存索引（v16，C-42c / D-37b）。
 *
 * 缓存键 = sha256(朗读文本) + voiceId + speed + engine + engineVersion（契约 speech.ts）：
 * 命中就不再合成；片段不可变，只插入、不更新。
 */
export interface SpeechClipCacheKey {
  /** sha256(UTF-8(朗读文本))，朗读文本是 speakableText 过滤之后的 */
  textHash: string;
  voiceId: VoiceId;
  speed: number;
  engine: TtsEngine;
  engineVersion: string;
}

interface SpeechClipRow {
  id: string;
  text_hash: string;
  voice_id: string;
  speed: number;
  engine: TtsEngine;
  engine_version: string;
  audio_ref: string;
  mime: SpeechClip["mime"];
  duration_ms: number;
  created_at: string;
}

const toSpeechClip = (row: SpeechClipRow): SpeechClip => ({
  id: row.id as SpeechClipId,
  textHash: row.text_hash,
  voiceId: row.voice_id as VoiceId,
  speed: row.speed,
  engine: row.engine,
  engineVersion: row.engine_version,
  audioRef: row.audio_ref as SpeechClip["audioRef"],
  mime: row.mime,
  durationMs: row.duration_ms,
  createdAt: row.created_at,
});

export function insertSpeechClip(db: SqliteDatabase, clip: SpeechClip): void {
  const parsed = SpeechClipSchema.parse(clip);
  db.prepare(
    "INSERT INTO speech_clips (id, text_hash, voice_id, speed, engine, engine_version, audio_ref, mime, duration_ms, " +
      "created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    parsed.id,
    parsed.textHash,
    parsed.voiceId,
    parsed.speed,
    parsed.engine,
    parsed.engineVersion,
    parsed.audioRef,
    parsed.mime,
    parsed.durationMs,
    parsed.createdAt,
  );
}

/** 按缓存键找片段；命中就直接用它，不再合成 */
export function findSpeechClip(db: SqliteDatabase, key: SpeechClipCacheKey): SpeechClip | null {
  const row = db
    .prepare(
      "SELECT * FROM speech_clips WHERE text_hash = ? AND voice_id = ? AND speed = ? AND engine = ? AND engine_version = ?",
    )
    .get(key.textHash, key.voiceId, key.speed, key.engine, key.engineVersion) as SpeechClipRow | undefined;
  return row === undefined ? null : toSpeechClip(row);
}

export function getSpeechClip(db: SqliteDatabase, id: string): SpeechClip | null {
  const row = db.prepare("SELECT * FROM speech_clips WHERE id = ?").get(id) as SpeechClipRow | undefined;
  return row === undefined ? null : toSpeechClip(row);
}

/** 播放端只拿得到 AudioRef：按 ref 反查片段（room-audio:// 校验用） */
export function getSpeechClipByAudioRef(db: SqliteDatabase, audioRef: string): SpeechClip | null {
  const row = db.prepare("SELECT * FROM speech_clips WHERE audio_ref = ?").get(audioRef) as SpeechClipRow | undefined;
  return row === undefined ? null : toSpeechClip(row);
}
