import {
  CHAT_LIMITS,
  FileRef as FileRefSchema,
  ImageMime as ImageMimeSchema,
  ImagePurpose as ImagePurposeSchema,
  ImageRef as ImageRefSchema,
  Sticker as StickerSchema,
  StickerId as StickerIdSchema,
  type FileRef,
  type ImageMime,
  type ImagePurpose,
  type ImageRef,
  type Sticker,
} from "@room/schemas";
import type { SqliteDatabase } from "./database";

/**
 * 图片引用表的读写（D-36b 第一段，契约 C-32 / C-42a）。
 *
 * 一行 = 一条引用记录（img_…，用途，指向的字节的 sha256）；字节本身不在这里，在 userData/images/<sha256>。
 * 同一种用途 + 同一个 sha256 只有一条记录（唯一索引兜着），所以同一张图重复选只会拿到同一个 ref。
 * 记录不可变（换图就是新 ref）；删除只发生在清理时。
 */

export interface ImageRefRecord {
  ref: ImageRef;
  purpose: ImagePurpose;
  /** 处理之后的字节的 sha256（D-36a 管道输出） */
  sha256: string;
  mime: ImageMime;
  bytes: number;
  width: number;
  height: number;
  createdAt: string;
}

interface ImageRefRow {
  ref: string;
  purpose: string;
  sha256: string;
  mime: string;
  bytes: number;
  width: number;
  height: number;
  created_at: string;
}

const toRecord = (row: ImageRefRow): ImageRefRecord => ({
  ref: ImageRefSchema.parse(row.ref),
  purpose: ImagePurposeSchema.parse(row.purpose),
  sha256: row.sha256,
  mime: ImageMimeSchema.parse(row.mime),
  bytes: row.bytes,
  width: row.width,
  height: row.height,
  createdAt: row.created_at,
});

/** 插入一条引用记录。同用途同 sha256 已经存在时抛错（调用方先查，别靠异常当流程） */
export function insertImageRef(db: SqliteDatabase, record: ImageRefRecord): void {
  ImageRefSchema.parse(record.ref);
  ImagePurposeSchema.parse(record.purpose);
  ImageMimeSchema.parse(record.mime);
  if (!/^[0-9a-f]{64}$/.test(record.sha256)) throw new Error("image sha256 must be 64 lowercase hex chars");
  if (!Number.isInteger(record.bytes) || record.bytes <= 0) throw new Error("image bytes must be a positive integer");
  if (!Number.isInteger(record.width) || record.width <= 0 || !Number.isInteger(record.height) || record.height <= 0) {
    throw new Error("image dimensions must be positive integers");
  }
  db.prepare(
    "INSERT INTO images (ref, purpose, sha256, mime, bytes, width, height, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    record.ref,
    record.purpose,
    record.sha256,
    record.mime,
    record.bytes,
    record.width,
    record.height,
    record.createdAt,
  );
}

export function getImageRef(db: SqliteDatabase, ref: string): ImageRefRecord | null {
  if (!ImageRefSchema.safeParse(ref).success) return null;
  const row = db.prepare("SELECT * FROM images WHERE ref = ?").get(ref) as ImageRefRow | undefined;
  return row === undefined ? null : toRecord(row);
}

/** 同一种用途 + 同一个 sha256 的已有引用（去重用） */
export function findImageRefBySha(db: SqliteDatabase, purpose: ImagePurpose, sha256: string): ImageRefRecord | null {
  const row = db
    .prepare("SELECT * FROM images WHERE purpose = ? AND sha256 = ?")
    .get(purpose, sha256) as ImageRefRow | undefined;
  return row === undefined ? null : toRecord(row);
}

export function listImageRefs(db: SqliteDatabase, purpose?: ImagePurpose): ImageRefRecord[] {
  const rows = (
    purpose === undefined
      ? db.prepare("SELECT * FROM images ORDER BY created_at DESC, ref DESC").all()
      : db.prepare("SELECT * FROM images WHERE purpose = ? ORDER BY created_at DESC, ref DESC").all(purpose)
  ) as ImageRefRow[];
  return rows.map(toRecord);
}

export function deleteImageRef(db: SqliteDatabase, ref: string): boolean {
  const result = db.prepare("DELETE FROM images WHERE ref = ?").run(ref);
  return result.changes > 0;
}

/** 这份字节还有没有别的引用指着（没有才能删磁盘上的文件） */
export function imageShaInUse(db: SqliteDatabase, sha256: string): boolean {
  const row = db.prepare("SELECT 1 AS one FROM images WHERE sha256 = ? LIMIT 1").get(sha256) as { one: number } | undefined;
  return row !== undefined;
}

// ================================================================ 聊天文件（D-34a）

export interface FileRefRecord {
  ref: FileRef;
  sha256: string;
  /** 第一次选它时的文件名（给人看的；后面同一份内容复用这个名字） */
  name: string;
  mime: string;
  bytes: number;
  /** 能当 UTF-8 文本读：只有这类文件的正文会进 Prompt */
  isText: boolean;
  createdAt: string;
}

interface FileRefRow {
  ref: string;
  sha256: string;
  name: string;
  mime: string;
  bytes: number;
  is_text: number;
  created_at: string;
}

const MIME_PATTERN = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/;

const toFileRecord = (row: FileRefRow): FileRefRecord => ({
  ref: FileRefSchema.parse(row.ref),
  sha256: row.sha256,
  name: row.name,
  mime: row.mime,
  bytes: row.bytes,
  isText: row.is_text === 1,
  createdAt: row.created_at,
});

export function insertFile(db: SqliteDatabase, record: FileRefRecord): void {
  FileRefSchema.parse(record.ref);
  if (!/^[0-9a-f]{64}$/.test(record.sha256)) throw new Error("file sha256 must be 64 lowercase hex chars");
  const name = record.name.trim();
  if (name.length < 1 || name.length > 255) throw new Error("file name must be 1..255 chars");
  if (!MIME_PATTERN.test(record.mime) || record.mime.length > 100) throw new Error("file mime is invalid");
  if (!Number.isInteger(record.bytes) || record.bytes <= 0 || record.bytes > CHAT_LIMITS.fileMaxBytes) {
    throw new Error("file size is out of range");
  }
  db.prepare(
    "INSERT INTO files (ref, sha256, name, mime, bytes, is_text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(record.ref, record.sha256, name, record.mime, record.bytes, record.isText ? 1 : 0, record.createdAt);
}

export function getFile(db: SqliteDatabase, ref: string): FileRefRecord | null {
  if (!FileRefSchema.safeParse(ref).success) return null;
  const row = db.prepare("SELECT * FROM files WHERE ref = ?").get(ref) as FileRefRow | undefined;
  return row === undefined ? null : toFileRecord(row);
}

/** 按内容去重：同一份字节只有一个 file ref */
export function findFileBySha(db: SqliteDatabase, sha256: string): FileRefRecord | null {
  const row = db.prepare("SELECT * FROM files WHERE sha256 = ?").get(sha256) as FileRefRow | undefined;
  return row === undefined ? null : toFileRecord(row);
}

// ================================================================ 表情库（D-34a）

export function countStickers(db: SqliteDatabase): number {
  return (db.prepare("SELECT count(*) AS n FROM chat_stickers").get() as { n: number }).n;
}

export function listStickers(db: SqliteDatabase): Sticker[] {
  const rows = db.prepare("SELECT * FROM chat_stickers ORDER BY created_at DESC, id DESC").all() as {
    id: string;
    image_ref: string;
    label: string;
    created_at: string;
  }[];
  return rows.map((row) => StickerSchema.parse({ id: row.id, image: row.image_ref, label: row.label, createdAt: row.created_at }));
}

export function getSticker(db: SqliteDatabase, id: string): Sticker | null {
  if (!StickerIdSchema.safeParse(id).success) return null;
  const row = db.prepare("SELECT * FROM chat_stickers WHERE id = ?").get(id) as
    | { id: string; image_ref: string; label: string; created_at: string }
    | undefined;
  return row === undefined
    ? null
    : StickerSchema.parse({ id: row.id, image: row.image_ref, label: row.label, createdAt: row.created_at });
}

/** 表情库满了（CHAT_LIMITS.stickersMax）时抛这个；main 翻成 validation_failed */
export class StickerLimitError extends Error {
  constructor(readonly max: number) {
    super(`表情库最多 ${max} 个`);
    this.name = "StickerLimitError";
  }
}

/** 加一个表情：图片必须是已经存好的 sticker 用途引用 */
export function insertSticker(db: SqliteDatabase, sticker: Sticker): void {
  StickerSchema.parse(sticker);
  const image = getImageRef(db, sticker.image);
  if (image === null || image.purpose !== "sticker") throw new Error("sticker image must be a stored sticker-purpose image");
  if (countStickers(db) >= CHAT_LIMITS.stickersMax) throw new StickerLimitError(CHAT_LIMITS.stickersMax);
  db.prepare("INSERT INTO chat_stickers (id, image_ref, label, created_at) VALUES (?, ?, ?, ?)").run(
    sticker.id,
    sticker.image,
    sticker.label.trim(),
    sticker.createdAt,
  );
}

export function updateStickerLabel(db: SqliteDatabase, id: string, label: string): Sticker | null {
  if (!StickerIdSchema.safeParse(id).success) return null;
  const trimmed = label.trim();
  if (trimmed.length < 1 || trimmed.length > 40) throw new Error("sticker label must be 1..40 chars");
  const result = db.prepare("UPDATE chat_stickers SET label = ? WHERE id = ?").run(trimmed, id);
  return result.changes > 0 ? getSticker(db, id) : null;
}

export function deleteSticker(db: SqliteDatabase, id: string): boolean {
  if (!StickerIdSchema.safeParse(id).success) return false;
  return db.prepare("DELETE FROM chat_stickers WHERE id = ?").run(id).changes > 0;
}
