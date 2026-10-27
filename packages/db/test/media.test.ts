import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import Database from "better-sqlite3";
import {
  currentVersion,
  deleteImageRef,
  findImageRefBySha,
  getImageRef,
  imageShaInUse,
  insertImageRef,
  LATEST_SCHEMA_VERSION,
  listImageRefs,
  openDatabase,
  type ImageRefRecord,
} from "../src/index";
import { SCHEMA_V1, SCHEMA_V2 } from "../src/schema";
import { SCHEMA_V3, SCHEMA_V3_REBUILD } from "../src/schema-v3";
import { SCHEMA_V4 } from "../src/schema-v4";
import { SCHEMA_V5 } from "../src/schema-v5";
import { SCHEMA_V6 } from "../src/schema-v6";
import { SCHEMA_V7 } from "../src/schema-v7";
import { SCHEMA_V8 } from "../src/schema-v8";

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

