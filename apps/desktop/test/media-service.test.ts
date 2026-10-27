import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  getFile,
  getImageRef,
  insertSticker,
  openDatabase,
  ulid,
  type SqliteDatabase,
} from "@room/db";
import { CHAT_LIMITS, type ChatAttachment } from "@room/schemas";
import sharp from "sharp";
import { ChatError } from "../src/main/chat";
import { MediaService } from "../src/main/media";
import { MediaStore } from "../src/main/media-store";

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // Windows 上句柄释放有延迟
    }
  }
});

interface Harness {
  service: MediaService;
  store: MediaStore;
  db: SqliteDatabase;
  root: string;
  /** 下一次「对话框」要返回的路径；null 表示用户取消 */
  queue: (string | null)[];
}

function makeHarness(): Harness {
  const root = mkdtempSync(join(tmpdir(), "room-media-service-"));
  dirs.push(root);
  const db = openDatabase(join(root, "room.db"));
  const store = new MediaStore(join(root, "images"), join(root, "files"), db);
  const queue: (string | null)[] = [];
  const service = new MediaService({
    db,
    store,
    now: () => "2026-10-27T00:00:00.000Z",
    openFileDialog: async () => queue.shift() ?? null,
  });
  return { service, store, db, root, queue };
}

const pngBytes = () =>
  sharp({ create: { width: 40, height: 30, channels: 3, background: { r: 1, g: 2, b: 3 } } })
    .png()
    .toBuffer();

async function writeImage(root: string, name: string): Promise<string> {
  const path = join(root, name);
  writeFileSync(path, await pngBytes());
  return path;
}

const isChatError = (code: string) => (error: unknown) => error instanceof ChatError && error.code === code;

describe("media service (D-34a)", () => {
  it("picks an image, stores it as a chat image, and reuses the ref for the same picture", async () => {
    const h = makeHarness();
    try {
      const path = await writeImage(h.root, "小鲸鱼.png");
      h.queue.push(path);
      const first = (await h.service.pickAttachment("image")) as ChatAttachment;
      assert.equal(first.kind, "image");
      if (first.kind !== "image") return;
      assert.equal(first.name, "小鲸鱼.png");
      assert.match(first.ref, /^img_[0-9A-HJKMNP-TV-Z]{26}$/);
      assert.equal(getImageRef(h.db, first.ref)?.purpose, "chat");

      h.queue.push(path);
      const second = (await h.service.pickAttachment("image")) as ChatAttachment;
      assert.equal(second.kind === "image" ? second.ref : null, first.ref, "same picture, same ref");
    } finally {
      h.db.close();
    }
  });

  it("picks files by header, dedupes by content, and rejects empty / oversized / GIF", async () => {
    const h = makeHarness();
    try {
      const textPath = join(h.root, "笔记.md");
      writeFileSync(textPath, "# 标题\n正文");
      h.queue.push(textPath);
      const text = await h.service.pickAttachment("file");
      assert.ok(text !== null && text.kind === "file");
      if (text === null || text.kind !== "file") return;
      assert.equal(text.mime, "text/plain");
      assert.equal(text.isText, true);
      assert.equal(text.bytes, Buffer.byteLength("# 标题\n正文"));

      // 同一份内容换个名字再选：同一个 ref、名字保持第一次的
      const copyPath = join(h.root, "副本.txt");
      writeFileSync(copyPath, "# 标题\n正文");
      h.queue.push(copyPath);
      const again = await h.service.pickAttachment("file");
      assert.equal(again?.kind === "file" ? again.ref : null, text.ref);
      assert.equal(again?.kind === "file" ? again.name : null, "笔记.md");

      // 取消
      h.queue.push(null);
      assert.equal(await h.service.pickAttachment("file"), null);

      // 空文件
      const emptyPath = join(h.root, "empty.txt");
      writeFileSync(emptyPath, "");
      h.queue.push(emptyPath);
      await assert.rejects(() => h.service.pickAttachment("file"), isChatError("validation_failed"));

      // GIF 当图片：拒绝（D-34a 的验收：GIF 被拒）
      const gifPath = join(h.root, "动图.gif");
      writeFileSync(gifPath, Buffer.from("GIF89a" + "x".repeat(20), "latin1"));
      h.queue.push(gifPath);
      await assert.rejects(() => h.service.pickAttachment("image"), isChatError("validation_failed"));

      // 超过 20 MB 的文件
      const bigPath = join(h.root, "big.bin");
      writeFileSync(bigPath, Buffer.alloc(CHAT_LIMITS.fileMaxBytes + 1));
      h.queue.push(bigPath);
      await assert.rejects(() => h.service.pickAttachment("file"), isChatError("validation_failed"));
      assert.equal(getFile(h.db, text.ref)?.isText, true);
    } finally {
      h.db.close();
    }
  });

  it("adds, lists, renames, and removes stickers; enforces the label and the library cap", async () => {
    const h = makeHarness();
    try {
      const path = await writeImage(h.root, "比心.png");
      h.queue.push(path);
      const sticker = await h.service.addSticker("小鲸鱼比心");
      assert.ok(sticker !== null);
      assert.equal(sticker!.label, "小鲸鱼比心");
      assert.equal(getImageRef(h.db, sticker!.image)?.purpose, "sticker");
      assert.deepEqual(
        h.service.listStickers().map((s) => s.id),
        [sticker!.id],
      );

      assert.equal(h.service.updateSticker(sticker!.id, "比心 2").label, "比心 2");

      // 取消选图：不建表情
      h.queue.push(null);
      assert.equal(await h.service.addSticker("取消的"), null);

      // 空 label 直接拒（连对话框都不该弹）
      await assert.rejects(() => h.service.addSticker("   "), isChatError("validation_failed"));

      h.service.removeSticker(sticker!.id);
      assert.deepEqual(h.service.listStickers(), []);
      assert.throws(() => h.service.removeSticker(sticker!.id), isChatError("not_found"));

      // 塞满上限：直接用库插 500 条（同一张 sticker 图可以复用），之后再加要拒
      const image = await h.store.addImage(await pngBytes(), "sticker");
      for (let i = 0; i < CHAT_LIMITS.stickersMax; i += 1) {
        insertSticker(h.db, { id: `stk_${ulid()}`, image: image.ref, label: "满", createdAt: "2026-10-27T00:00:00.000Z" });
      }
      h.queue.push(await writeImage(h.root, "再来一个.png"));
      await assert.rejects(() => h.service.addSticker("再加一个"), isChatError("validation_failed"));
    } finally {
      h.db.close();
    }
  });
});
