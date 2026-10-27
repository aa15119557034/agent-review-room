import { readFileSync } from "node:fs";
import {
  countStickers,
  deleteSticker,
  getSticker,
  insertSticker,
  listStickers,
  StickerLimitError,
  ulid,
  updateStickerLabel as updateLabel,
  type FileRefRecord,
  type SqliteDatabase,
} from "@room/db";
import {
  CHAT_LIMITS,
  Sticker as StickerSchema,
  StickerId as StickerIdSchema,
  type ChatAttachment,
  type Sticker,
} from "@room/schemas";
import { ChatError } from "./chat";
import { FileRejectedError, ImageRejectedError, MediaStore } from "./media-store";

/**
 * 聊天文件和表情库的操作（D-34a，契约 C-34 / C-42a）。
 *
 * - 选文件走 main 的系统对话框：renderer 只拿到 ref / 名字 / 类型，拿不到路径
 * - 图片先过 D-36a 的管道、再按 sha256 存（MediaStore）；文件按文件头判类型、按内容去重
 * - 表情是一个「label + 一张 sticker 用途的图」；图片和表情的引用关系都在数据库里
 * - 失败一律翻成 ChatError(validation_failed)，message 直接给用户看
 */

export interface FileDialogOptions {
  title: string;
  filters: { name: string; extensions: string[] }[];
}

export interface MediaServiceDeps {
  db: SqliteDatabase;
  store: MediaStore;
  /** 生产里是 Electron 的 dialog.showOpenDialog；测试注入假的 */
  openFileDialog: (options: FileDialogOptions) => Promise<string | null>;
  now: () => string;
}

const IMAGE_FILTER = { name: "图片", extensions: ["png", "jpg", "jpeg", "webp"] };
const FILE_FILTER = { name: "所有文件", extensions: ["*"] };

export class MediaService {
  constructor(private readonly deps: MediaServiceDeps) {}

  /** 选一张图 / 一个文件。用户取消返回 null */
  async pickAttachment(kind: "image" | "file"): Promise<ChatAttachment | null> {
    const path = await this.deps.openFileDialog({
      title: kind === "image" ? "选一张图片" : "选一个文件",
      filters: [kind === "image" ? IMAGE_FILTER : FILE_FILTER],
    });
    if (path === null) return null;
    const name = baseName(path);
    let bytes: Buffer;
    try {
      bytes = readFileSync(path);
    } catch {
      throw new ChatError("validation_failed", "这个文件读不了（可能被移走了）");
    }

    if (kind === "image") {
      const image = await this.#storeImage(bytes, "chat");
      return { kind: "image", ref: image.ref, name };
    }
    const file = this.#storeFile(bytes, name);
    return {
      kind: "file",
      ref: file.ref,
      name: file.name,
      mime: file.mime,
      bytes: file.bytes,
      sha256: file.sha256,
      isText: file.isText,
    };
  }

  /** 加一个表情：选图 → 处理成 sticker 用途的图 → 记一行。用户取消返回 null */
  async addSticker(label: string): Promise<Sticker | null> {
    const trimmed = label.trim();
    if (trimmed.length < 1 || trimmed.length > 40) throw new ChatError("validation_failed", "表情说明要 1～40 个字");
    if (countStickers(this.deps.db) >= CHAT_LIMITS.stickersMax) {
      throw new ChatError("validation_failed", `表情库最多 ${CHAT_LIMITS.stickersMax} 个`);
    }
    const path = await this.deps.openFileDialog({ title: "选一张表情图片", filters: [IMAGE_FILTER] });
    if (path === null) return null;
    let bytes: Buffer;
    try {
      bytes = readFileSync(path);
    } catch {
      throw new ChatError("validation_failed", "这个文件读不了（可能被移走了）");
    }
    const image = await this.#storeImage(bytes, "sticker");
    const sticker = StickerSchema.parse({
      id: `stk_${ulid()}`,
      image: image.ref,
      label: trimmed,
      createdAt: this.deps.now(),
    });
    try {
      insertSticker(this.deps.db, sticker);
    } catch (error) {
      if (error instanceof StickerLimitError) throw new ChatError("validation_failed", error.message);
      throw error;
    }
    return sticker;
  }

  updateSticker(stickerId: string, label: string): Sticker {
    if (!StickerIdSchema.safeParse(stickerId).success || getSticker(this.deps.db, stickerId) === null) {
      throw new ChatError("not_found", "这个表情已经不在表情库里了");
    }
    const updated = updateLabel(this.deps.db, stickerId, label);
    if (updated === null) throw new ChatError("not_found", "这个表情已经不在表情库里了");
    return updated;
  }

  removeSticker(stickerId: string): Record<string, never> {
    if (!deleteSticker(this.deps.db, stickerId)) throw new ChatError("not_found", "这个表情已经不在表情库里了");
    return {};
  }

  listStickers(): Sticker[] {
    return listStickers(this.deps.db);
  }

  async #storeImage(bytes: Buffer, purpose: "chat" | "sticker") {
    try {
      return await this.deps.store.addImage(bytes, purpose, this.deps.now());
    } catch (error) {
      if (error instanceof ImageRejectedError) throw new ChatError("validation_failed", error.message);
      throw error;
    }
  }

  #storeFile(bytes: Buffer, name: string): FileRefRecord {
    try {
      return this.deps.store.addFile(bytes, name, this.deps.now());
    } catch (error) {
      if (error instanceof FileRejectedError) throw new ChatError("validation_failed", error.message);
      throw error;
    }
  }
}

const baseName = (path: string): string => path.split(/[\\/]/).pop() ?? path;


