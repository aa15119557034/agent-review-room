import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import Database from "better-sqlite3";
import {
  countStickers,
  currentVersion,
  deleteImageRef,
  deleteSticker,
  findFileBySha,
  findImageRefBySha,
  getFile,
  getImageRef,
  getSticker,
  imageShaInUse,
  insertFile,
  insertImageRef,
  insertSticker,
  LATEST_SCHEMA_VERSION,
  listImageRefs,
  listStickers,
  openDatabase,
  StickerLimitError,
  updateStickerLabel,
  type FileRefRecord,
  type ImageRefRecord,
} from "../src/index";
import { SCHEMA_V1, SCHEMA_V2 } from "../src/schema";
import { SCHEMA_V3, SCHEMA_V3_REBUILD } from "../src/schema-v3";
import { SCHEMA_V4 } from "../src/schema-v4";
import { SCHEMA_V5 } from "../src/schema-v5";
import { SCHEMA_V6 } from "../src/schema-v6";
import { SCHEMA_V7 } from "../src/schema-v7";
import { SCHEMA_V8 } from "../src/schema-v8";
import { SCHEMA_V9 } from "../src/schema-v9";

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

function tempFile(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return join(dir, "room.db");
}

const T = "2026-10-27T00:00:00.000Z";
const REF = (n: number) => `img_${String(n).padStart(26, "0").replace(/[0-9]/g, (d) => "0123456789ABCDEFGHJKMNPQRSTVWXYZ".charAt(Number(d)))}`;
const SHA = (n: number) => n.toString(16).padStart(64, "0");

const record = (patch: Partial<ImageRefRecord> = {}): ImageRefRecord => ({
  ref: REF(1) as ImageRefRecord["ref"],
  purpose: "chat",
  sha256: SHA(1),
  mime: "image/png",
  bytes: 1234,
  width: 100,
  height: 60,
  createdAt: T,
  ...patch,
});

describe("migration v9 (image refs)", () => {
  it("adds the images table on a v8 database without touching old data", () => {
    const file = tempFile("room-v9-");
    const raw = new Database(file);
    raw.pragma("foreign_keys = OFF");
    raw.exec(SCHEMA_V1);
    raw.exec(SCHEMA_V2);
    raw.exec(SCHEMA_V3);
    raw.exec(SCHEMA_V3_REBUILD);
    raw.exec(SCHEMA_V4);
    raw.exec(SCHEMA_V5);
    raw.exec(SCHEMA_V6);
    raw.exec(SCHEMA_V7);
    raw.exec(SCHEMA_V8);
    raw.pragma("user_version = 8");

    raw
      .prepare(
        "INSERT INTO conversations (id, kind, direct_agent, title, pinned, muted, last_read_message_id, last_activity_at, created_at) " +
          "VALUES ('conv_old', 'direct', 'deepseek', NULL, 0, 0, NULL, ?, ?)",
      )
      .run(T, T);
    raw
      .prepare(
        "INSERT INTO chat_messages (id, conversation_id, sender, created_at, content, mentions, state) " +
          "VALUES ('cmsg_old', 'conv_old', 'user', ?, ?, ?, 'sent')",
      )
      .run(T, JSON.stringify({ kind: "text", text: "旧消息", attachments: [] }), JSON.stringify({ kind: "none" }));
    raw.close();

    const db = openDatabase(file);
    try {
      assert.equal(currentVersion(db), LATEST_SCHEMA_VERSION);
      assert.ok(LATEST_SCHEMA_VERSION >= 9);

      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(
        (r) => r.name,
      );
      assert.ok(tables.includes("images"));
      assert.equal(
        (db.prepare("SELECT count(*) AS n FROM chat_messages").get() as { n: number }).n,
        1,
        "old rows are still there",
      );
      assert.deepEqual(db.pragma("foreign_key_check"), []);
    } finally {
      db.close();
    }
    assert.ok(existsSync(file + ".bak-v8"), "migration backup must exist");
  });
});

describe("image refs (C-32 / C-42a)", () => {
  const fresh = () => openDatabase(tempFile("room-images-"));

  it("stores one record per (purpose, sha256), reads it back, and refuses updates", () => {
    const db = fresh();
    try {
      insertImageRef(db, record());
      assert.deepEqual(getImageRef(db, REF(1)), record());

      // 同用途同 sha256 再来一条：唯一索引挡住
      assert.throws(() => insertImageRef(db, record({ ref: REF(2) })), /UNIQUE/);
      // 不同用途可以共用同一份字节
      insertImageRef(db, record({ ref: REF(2), purpose: "sticker" }));
      assert.equal(findImageRefBySha(db, "chat", SHA(1))?.ref, REF(1));
      assert.equal(findImageRefBySha(db, "sticker", SHA(1))?.ref, REF(2));
      assert.equal(findImageRefBySha(db, "avatar", SHA(1)), null);

      // 引用记录不可变
      assert.throws(() => db.prepare("UPDATE images SET purpose = 'avatar' WHERE ref = ?").run(REF(1)), /immutable/);

      // 字节还有引用时不能当没人用
      assert.equal(imageShaInUse(db, SHA(1)), true);
      assert.equal(imageShaInUse(db, SHA(9)), false);

      assert.deepEqual(
        listImageRefs(db, "chat").map((r) => r.ref),
        [REF(1)],
      );
      assert.equal(deleteImageRef(db, REF(2)), true);
      assert.equal(imageShaInUse(db, SHA(1)), true, "chat ref still points at the bytes");
      assert.equal(deleteImageRef(db, REF(1)), true);
      assert.equal(imageShaInUse(db, SHA(1)), false);
    } finally {
      db.close();
    }
  });

  it("rejects refs / mime / sha that do not match the contract", () => {
    const db = fresh();
    try {
      assert.throws(() => insertImageRef(db, record({ ref: "img_notaulid" as never })));
      assert.throws(() => insertImageRef(db, record({ mime: "image/gif" as never })));
      assert.throws(() => insertImageRef(db, record({ sha256: "xyz" })), /sha256/);
      assert.throws(() => insertImageRef(db, record({ bytes: 0 })), /bytes/);
      assert.throws(() => insertImageRef(db, record({ width: -1 })), /dimensions/);
      assert.equal(getImageRef(db, "img_notaulid"), null);
    } finally {
      db.close();
    }
  });
});


describe("migration v10 (chat files + stickers)", () => {
  it("adds files and chat_stickers on a v9 database without touching old data", () => {
    const file = tempFile("room-v10-");
    const raw = new Database(file);
    raw.pragma("foreign_keys = OFF");
    raw.exec(SCHEMA_V1);
    raw.exec(SCHEMA_V2);
    raw.exec(SCHEMA_V3);
    raw.exec(SCHEMA_V3_REBUILD);
    raw.exec(SCHEMA_V4);
    raw.exec(SCHEMA_V5);
    raw.exec(SCHEMA_V6);
    raw.exec(SCHEMA_V7);
    raw.exec(SCHEMA_V8);
    raw.exec(SCHEMA_V9);
    raw.pragma("user_version = 9");

    raw
      .prepare(
        "INSERT INTO conversations (id, kind, direct_agent, title, pinned, muted, last_read_message_id, last_activity_at, created_at) " +
          "VALUES ('conv_old', 'direct', 'deepseek', NULL, 0, 0, NULL, ?, ?)",
      )
      .run(T, T);
    raw
      .prepare(
        "INSERT INTO chat_messages (id, conversation_id, sender, created_at, content, mentions, state) " +
          "VALUES ('cmsg_old', 'conv_old', 'user', ?, ?, ?, 'sent')",
      )
      .run(T, JSON.stringify({ kind: "text", text: "旧消息", attachments: [] }), JSON.stringify({ kind: "none" }));
    raw.close();

    const db = openDatabase(file);
    try {
      assert.equal(currentVersion(db), LATEST_SCHEMA_VERSION);
      assert.ok(LATEST_SCHEMA_VERSION >= 10);
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(
        (r) => r.name,
      );
      assert.ok(tables.includes("files"));
      assert.ok(tables.includes("chat_stickers"));
      assert.equal((db.prepare("SELECT count(*) AS n FROM chat_messages").get() as { n: number }).n, 1);
      assert.deepEqual(db.pragma("foreign_key_check"), []);
    } finally {
      db.close();
    }
    assert.ok(existsSync(file + ".bak-v9"), "migration backup must exist");
  });
});

const FILE_REF = (n: number) => `file_${REF(n).slice(4)}`;
const STICKER_ID = (n: number) => `stk_${REF(n).slice(4)}`;

const fileRecord = (patch: Partial<FileRefRecord> = {}): FileRefRecord => ({
  ref: FILE_REF(3) as FileRefRecord["ref"],
  sha256: SHA(3),
  name: "笔记.md",
  mime: "text/plain",
  bytes: 12,
  isText: true,
  createdAt: T,
  ...patch,
});

describe("chat files and stickers (D-34a)", () => {
  const fresh = () => openDatabase(tempFile("room-files-"));

  it("stores files once per sha256, reads them back, and refuses updates", () => {
    const db = fresh();
    try {
      insertFile(db, fileRecord());
      assert.deepEqual(getFile(db, FILE_REF(3)), fileRecord());
      assert.equal(findFileBySha(db, SHA(3))?.ref, FILE_REF(3));
      assert.equal(findFileBySha(db, SHA(4)), null);
      // 同一份内容再来一条（不同 ref）：唯一索引挡住
      assert.throws(() => insertFile(db, fileRecord({ ref: FILE_REF(5) })), /UNIQUE/);
      // 记录不可变
      assert.throws(() => db.prepare("UPDATE files SET name = 'x' WHERE ref = ?").run(FILE_REF(3)), /immutable/);

      assert.throws(() => insertFile(db, fileRecord({ ref: "file_nope" as never })));
      assert.throws(() => insertFile(db, fileRecord({ sha256: "zz" })), /sha256/);
      assert.throws(() => insertFile(db, fileRecord({ mime: "nope" })), /mime/);
      assert.throws(() => insertFile(db, fileRecord({ bytes: 0 })), /size/);
      assert.equal(getFile(db, "file_nope"), null);
    } finally {
      db.close();
    }
  });

  it("stores stickers pointing at sticker images; enforces labels and the library cap", async () => {
    const db = fresh();
    try {
      insertImageRef(db, record({ ref: REF(7), purpose: "sticker" }));
      insertImageRef(db, record({ ref: REF(8), purpose: "chat" }));
      const sticker = { id: STICKER_ID(1), image: REF(7), label: "比心", createdAt: T } as const;
      insertSticker(db, sticker);
      assert.deepEqual(getSticker(db, STICKER_ID(1)), sticker);
      assert.deepEqual(listStickers(db).map((s) => s.id), [STICKER_ID(1)]);

      // 图片必须是 sticker 用途
      assert.throws(() => insertSticker(db, { ...sticker, id: STICKER_ID(2), image: REF(8) }), /sticker-purpose/);
      // label 不合规
      assert.throws(() => insertSticker(db, { ...sticker, id: STICKER_ID(3), label: "x".repeat(41) }));

      assert.equal(updateStickerLabel(db, STICKER_ID(1), " 比心 2 ")?.label, "比心 2");
      assert.throws(() => updateStickerLabel(db, STICKER_ID(1), " "));
      assert.equal(updateStickerLabel(db, STICKER_ID(99), "x"), null);

      // 上限：塞满之后再加要报 StickerLimitError
      const { CHAT_LIMITS } = await import("@room/schemas");
      while (countStickers(db) < CHAT_LIMITS.stickersMax) {
        insertSticker(db, { id: `stk_${STICKER_ID(countStickers(db) + 10).slice(4)}`, image: REF(7), label: "满", createdAt: T });
      }
      assert.throws(
        () => insertSticker(db, { id: STICKER_ID(5000), image: REF(7), label: "再加", createdAt: T }),
        StickerLimitError,
      );

      assert.equal(deleteSticker(db, STICKER_ID(1)), true);
      assert.equal(deleteSticker(db, STICKER_ID(1)), false);
      assert.equal(countStickers(db), CHAT_LIMITS.stickersMax - 1);
    } finally {
      db.close();
    }
  });
});
