import type { AudioMime, AudioRef } from "@room/schemas";
import type { SqliteDatabase } from "./database";

/**
 * 音频引用（v16，C-42c / D-37b）。和 images 同构：ref 是契约的 `aud_…`，
 * 磁盘上的文件按 sha256 命名（同一份字节只有一个 ref）。D-34b 的录音以后也走这张表。
 */
export interface AudioRefRecord {
  ref: AudioRef;
  sha256: string;
  mime: AudioMime;
  bytes: number;
  createdAt: string;
}

interface AudioRefRow {
  ref: string;
  sha256: string;
  mime: AudioMime;
  bytes: number;
  created_at: string;
}

const toAudioRef = (row: AudioRefRow): AudioRefRecord => ({
  ref: row.ref as AudioRef,
  sha256: row.sha256,
  mime: row.mime,
  bytes: row.bytes,
  createdAt: row.created_at,
});

export function insertAudioRef(db: SqliteDatabase, record: AudioRefRecord): void {
  db.prepare("INSERT INTO audio_refs (ref, sha256, mime, bytes, created_at) VALUES (?, ?, ?, ?, ?)").run(
    record.ref,
    record.sha256,
    record.mime,
    record.bytes,
    record.createdAt,
  );
}

export function getAudioRef(db: SqliteDatabase, ref: string): AudioRefRecord | null {
  const row = db.prepare("SELECT * FROM audio_refs WHERE ref = ?").get(ref) as AudioRefRow | undefined;
  return row === undefined ? null : toAudioRef(row);
}

export function findAudioRefBySha(db: SqliteDatabase, sha256: string): AudioRefRecord | null {
  const row = db.prepare("SELECT * FROM audio_refs WHERE sha256 = ?").get(sha256) as AudioRefRow | undefined;
  return row === undefined ? null : toAudioRef(row);
}

/** 这份字节还有没有引用（清理时用） */
export function audioShaInUse(db: SqliteDatabase, sha256: string): boolean {
  return db.prepare("SELECT 1 FROM audio_refs WHERE sha256 = ?").get(sha256) !== undefined;
}
