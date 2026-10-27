import { createHash } from "node:crypto";
import { unlinkSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  findFileBySha,
  findImageRefBySha,
  getFile,
  getImageRef,
  imageShaInUse,
  insertFile,
  insertImageRef,
  ulid,
  type FileRefRecord,
  type ImageRefRecord,
  type SqliteDatabase,
} from "@room/db";
import {
  CHAT_LIMITS,
  FileRef as FileRefSchema,
  IMAGE_MAX_BYTES,
  ImageRef as ImageRefSchema,
  type ImagePurpose,
  type ImageRef,
} from "@room/schemas";
import sharp from "sharp";
import { sniffFile } from "./file-sniff";
import { ImageRejectedError, processImage, sniffImage } from "./image";

/**
 * 图片本体 + 引用记录（D-36b 第一段，契约 C-32 / C-42a）。
 *
 * - 字节存 `userData/images/<sha256>`：按内容去重，多张图共用一份；写的时候先写 `.tmp` 再改名（原子）
 * - 引用记录在数据库的 images 表：ref（img_…）、用途、sha256、类型、字节数、尺寸
 * - 同一用途 + 同一个 sha256 复用同一个 ref（重复选同一张图不会越堆越多）
 * - renderer 永远只拿 ref，`room-image://<ref>` 由 main 查表映射到文件，不拼接任何外部输入
 * - 清理（按引用情况删记录和字节）留给后续：现在没有任何东西会引用它时也不删，先不制造「删了还在用」的风险
 */

export class MediaStore {
  constructor(
    private readonly imagesDir: string,
    private readonly filesDir: string,
    private readonly db: SqliteDatabase,
  ) {
    mkdirSync(imagesDir, { recursive: true });
    mkdirSync(filesDir, { recursive: true });
  }

  /**
   * 处理并保存一张图（走 D-36a 的管道：转正、去元数据、确定性输出、按用途的上限）。
   * 同一用途 + 同一个 sha256 已经有记录就直接返回那条（不重复占 ref）。
   */
  async addImage(input: Buffer, purpose: ImagePurpose, now: string = new Date().toISOString()): Promise<ImageRefRecord> {
    const processed = await processImage(input, { imageMaxBytes: IMAGE_MAX_BYTES[purpose] });
    const existing = findImageRefBySha(this.db, purpose, processed.sha256);
    if (existing !== null) return existing;

    this.writeBytes(processed.sha256, processed.bytes);
    const record: ImageRefRecord = {
      ref: ImageRefSchema.parse(`img_${ulid()}`),
      purpose,
      sha256: processed.sha256,
      mime: processed.mime,
      bytes: processed.bytes.length,
      width: processed.width,
      height: processed.height,
      createdAt: now,
    };
    insertImageRef(this.db, record);
    return record;
  }

  /**
   * 存一张「画出来的图」：不做管道（原图就是最终结果），只按文件头认类型、按上限截、按 sha256 去重。
   * 用途固定 generated；字节照样存 userData/images/<sha256>。
   */
  async addGeneratedImage(input: Buffer, now: string = new Date().toISOString()): Promise<ImageRefRecord> {
    if (input.length === 0) throw new ImageRejectedError("unsupported_type", "画图模块返回了空文件");
    if (input.length > IMAGE_MAX_BYTES.generated) {
      throw new ImageRejectedError("input_too_big", "画出来的图太大了（上限 10 MB）");
    }
    const sniffed = sniffImage(input);
    if (sniffed === null || sniffed.kind === "gif" || sniffed.kind === "heic") {
      throw new ImageRejectedError("unsupported_type", "画图模块返回的不是 png / jpeg / webp");
    }
    if (sniffed.animated) throw new ImageRejectedError("animated", "画图模块返回了动图");

    const sha256 = createHash("sha256").update(input).digest("hex");
    const existing = findImageRefBySha(this.db, "generated", sha256);
    if (existing !== null) return existing;

    const meta = await sharp(input, { limitInputPixels: false }).metadata();
    if (meta.width === undefined || meta.height === undefined) {
      throw new ImageRejectedError("decode_failed", "画出来的图读不出尺寸");
    }
    this.writeBytes(sha256, input);
    const record: ImageRefRecord = {
      ref: ImageRefSchema.parse(`img_${ulid()}`),
      purpose: "generated",
      sha256,
      mime: sniffed.kind === "png" ? "image/png" : sniffed.kind === "jpeg" ? "image/jpeg" : "image/webp",
      bytes: input.length,
      width: meta.width,
      height: meta.height,
      createdAt: now,
    };
    insertImageRef(this.db, record);
    return record;
  }

  /** `room-image://<ref>` 要的文件路径和类型；ref 不合法 / 没有记录 / 文件丢了都返回 null（调用方回 404） */
  resolveImage(ref: string): { file: string; mime: ImageRefRecord["mime"] } | null {
    const record = getImageRef(this.db, ref);
    if (record === null) return null;
    const file = this.imageFile(record.sha256);
    return existsSync(file) ? { file, mime: record.mime } : null;
  }

  /** 只读：把 ref 对应的字节读出来（测试和后面的附件清单用） */
  readImage(ref: ImageRef): Buffer | null {
    const hit = this.resolveImage(ref);
    return hit === null ? null : readFileSync(hit.file);
  }

  /** 这份字节还有没有引用；没有的话可以连文件一起删（清理时用） */
  isBytesReferenced(sha256: string): boolean {
    return imageShaInUse(this.db, sha256);
  }

  /**
   * 保存一个聊天文件（D-34a）：按文件头判类型、按内容去重（同一份字节只有一个 FileRef）。
   * 大小上限 CHAT_LIMITS.fileMaxBytes（20 MB）；空文件拒绝。
   */
  addFile(input: Buffer, name: string, now: string = new Date().toISOString()): FileRefRecord {
    if (input.length === 0) throw new FileRejectedError("empty_file", "这个文件是空的");
    if (input.length > CHAT_LIMITS.fileMaxBytes) {
      throw new FileRejectedError("file_too_big", "文件太大了（上限 20 MB）");
    }
    const sha256 = createHash("sha256").update(input).digest("hex");
    const existing = findFileBySha(this.db, sha256);
    if (existing !== null) return existing;

    const sniffed = sniffFile(input);
    const displayName = displayNameOf(name);
    this.writeFileBytes(sha256, input);
    const record: FileRefRecord = {
      ref: FileRefSchema.parse(`file_${ulid()}`),
      sha256,
      name: displayName,
      mime: sniffed.mime,
      bytes: input.length,
      isText: sniffed.isText,
      createdAt: now,
    };
    insertFile(this.db, record);
    return record;
  }

  /** D-36b：把文件 ref 读成 UTF-8 文本（只有 is_text 的文件会读）；读不到返回 null */
  readFileText(ref: string): string | null {
    const record = getFile(this.db, ref);
    if (record === null || !record.isText) return null;
    const hit = this.resolveFile(ref);
    return hit === null ? null : readFileSync(hit.file, "utf8");
  }

  /** 文件引用对应的路径和类型；没有记录 / 文件丢了返回 null */
  resolveFile(ref: string): { file: string; mime: string } | null {
    const record = getFile(this.db, ref);
    if (record === null) return null;
    const file = this.fileFile(record.sha256);
    return existsSync(file) ? { file, mime: record.mime } : null;
  }

  /** 没有任何引用时删掉磁盘上的字节；返回是否真的删了 */
  dropUnreferencedBytes(sha256: string): boolean {
    if (imageShaInUse(this.db, sha256)) return false;
    const file = this.imageFile(sha256);
    if (!existsSync(file)) return false;
    unlinkSync(file);
    return true;
  }

  private imageFile(sha256: string): string {
    return join(this.imagesDir, sha256);
  }

  private fileFile(sha256: string): string {
    return join(this.filesDir, sha256);
  }

  private writeBytes(sha256: string, bytes: Buffer): void {
    const target = this.imageFile(sha256);
    if (existsSync(target)) return;
    const tmp = join(this.imagesDir, `${sha256}.${process.pid}.tmp`);
    writeFileSync(tmp, bytes);
    renameSync(tmp, target);
  }

  private writeFileBytes(sha256: string, bytes: Buffer): void {
    const target = this.fileFile(sha256);
    if (existsSync(target)) return;
    const tmp = join(this.filesDir, `${sha256}.${process.pid}.tmp`);
    writeFileSync(tmp, bytes);
    renameSync(tmp, target);
  }
}

/**
 * `room-image://<ref>` 的处理函数：只认 `<ref>` 形式的 host，path 必须是空或 "/"，
 * 其余一律 404；不做目录拼接（文件路径只来自数据库里的 sha256）。
 */
export function createImageProtocolHandler(store: MediaStore): (request: Request) => Promise<Response> {
  return async (request) => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return new Response("bad request", { status: 400 });
    }
    if (url.protocol !== "room-image:") return new Response("not found", { status: 404 });
    if (url.pathname !== "" && url.pathname !== "/") return new Response("not found", { status: 404 });
    // Chromium 对 standard scheme 会把 host 转成小写（Node 里不会，所以测试摸不到）。
    // ImageRef 的 ULID 是大写，这里把 ref 规范回去；前缀不对就让 getImageRef 去拒。
    const host = url.host;
    const ref = host.startsWith("img_") ? "img_" + host.slice(4).toUpperCase() : host;
    const hit = store.resolveImage(ref);
    if (hit === null) return new Response("not found", { status: 404 });
    // 别在主进程里同步读整张图（最大 10 MB）：一屏几十张会卡住界面
    const bytes = await readFile(hit.file);
    return new Response(bytes, {
      status: 200,
      headers: {
        "content-type": hit.mime,
        "content-length": String(bytes.length),
        // 引用不可变（换图就是新 ref），可以长期缓存
        "cache-control": "private, max-age=31536000, immutable",
      },
    });
  };
}

export { ImageRejectedError };

/** 聊天文件不能收（空文件 / 太大）。main 翻成 validation_failed */
export class FileRejectedError extends Error {
  readonly code: "empty_file" | "file_too_big";

  constructor(code: "empty_file" | "file_too_big", message: string) {
    super(message);
    this.name = "FileRejectedError";
    this.code = code;
  }
}

/** 只留文件名本身（不要路径），去首尾空白，最长 255 */
function displayNameOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const trimmed = base.trim();
  const safe = trimmed.length === 0 ? "未命名" : trimmed;
  return safe.length > 255 ? safe.slice(0, 255) : safe;
}



