import {
  ImageMime as ImageMimeSchema,
  ImagePurpose as ImagePurposeSchema,
  ImageRef as ImageRefSchema,
  type ImageMime,
  type ImagePurpose,
  type ImageRef,
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
