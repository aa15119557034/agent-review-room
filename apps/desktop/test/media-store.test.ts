import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { openDatabase, type SqliteDatabase } from "@room/db";
import sharp from "sharp";
import { createImageProtocolHandler, MediaStore } from "../src/main/media-store";

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

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function setup(): { store: MediaStore; db: SqliteDatabase; images: string } {
  const root = tempDir("room-media-store-");
  const images = join(root, "images");
  const files = join(root, "files");
  const db = openDatabase(join(root, "room.db"));
  return { store: new MediaStore(images, files, db), db, images };
}

const jpeg = () =>
  sharp({ create: { width: 100, height: 60, channels: 3, background: { r: 10, g: 20, b: 30 } } })
    .jpeg({ quality: 80 })
    .toBuffer();

describe("media store (D-36b)", () => {
  it("stores processed bytes once per sha256 and reuses the ref for the same purpose", async () => {
    const { store, db, images } = setup();
    try {
      const input = await jpeg();
      const first = await store.addImage(input, "chat");
      assert.equal(first.purpose, "chat");
      assert.equal(first.mime, "image/jpeg");
      assert.deepEqual([first.width, first.height], [100, 60]);
      assert.match(first.ref, /^img_[0-9A-HJKMNP-TV-Z]{26}$/);
      assert.ok(existsSync(join(images, first.sha256)), "bytes are on disk under the sha256 name");

      // 同一用途 + 同一张图：拿到同一个 ref，不会越堆越多
      const again = await store.addImage(input, "chat");
      assert.equal(again.ref, first.ref);
      assert.equal(readdirSync(images).length, 1);

      // 换用途：新 ref、同一份字节
      const sticker = await store.addImage(input, "sticker");
      assert.notEqual(sticker.ref, first.ref);
      assert.equal(sticker.sha256, first.sha256);
      assert.equal(readdirSync(images).length, 1, "bytes are still stored once");

      // 解析回文件；读出来的就是处理后的字节
      const hit = store.resolveImage(first.ref);
      assert.ok(hit !== null);
      assert.equal(hit.mime, "image/jpeg");
      const bytes = store.readImage(first.ref);
      assert.ok(bytes !== null && bytes.length === first.bytes);
      assert.equal(store.isBytesReferenced(first.sha256), true);

      // ref 不合格式 / 不存在：解析返回 null（协议层回 404，不抛）
      assert.equal(store.resolveImage("img_notaulid"), null);
      assert.equal(store.resolveImage("img_" + "0".repeat(26)), null);

      // 没有引用之后可以删字节；有引用时不删
      assert.equal(store.dropUnreferencedBytes(first.sha256), false, "still referenced");
    } finally {
      db.close();
    }
  });

  it("applies the per-purpose byte cap (stickers are smaller than chat images)", async () => {
    const { store, db } = setup();
    try {
      // 随机像素的 png 压不小：1 MB 的表情上限会把它挡住
      const noisy = await sharp(randomBytes(760 * 760 * 3), { raw: { width: 760, height: 760, channels: 3 } })
        .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
        .toBuffer();
      assert.ok(noisy.length > 1024 * 1024 && noisy.length < 2 * 1024 * 1024, "fixture sits between the sticker and chat caps: " + noisy.length);
      await assert.rejects(
        () => store.addImage(noisy, "sticker"),
        (error: unknown) => (error as { code?: string }).code === "output_too_big",
      );
      // 同样的图当聊天图片（2 MB 上限）能过
      const chat = await store.addImage(noisy, "chat");
      assert.equal(chat.purpose, "chat");
    } finally {
      db.close();
    }
  });

  it("serves room-image:// only for known refs and only at the bare path", async () => {
    const { store, db } = setup();
    try {
      const record = await store.addImage(await jpeg(), "chat");
      const handle = createImageProtocolHandler(store);

      const ok = await handle(new Request(`room-image://${record.ref}`));
      assert.equal(ok.status, 200);
      assert.equal(ok.headers.get("content-type"), "image/jpeg");
      assert.equal(ok.headers.get("content-length"), String(record.bytes));
      assert.match(ok.headers.get("cache-control") ?? "", /immutable/);
      assert.equal((await ok.arrayBuffer()).byteLength, record.bytes);

      assert.equal((await handle(new Request(`room-image://${record.ref}/extra`))).status, 404);
      assert.equal((await handle(new Request("room-image://img_" + "0".repeat(26)))).status, 404);
      assert.equal((await handle(new Request("room-image://img_notaulid"))).status, 404);
    } finally {
      db.close();
    }
  });
});



