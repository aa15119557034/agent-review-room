import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import Database from "better-sqlite3";
import { currentVersion, LATEST_SCHEMA_VERSION, MIGRATIONS, openDatabase } from "../src/index";
import { SCHEMA_V1 } from "../src/schema";

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

const NOW = "2026-10-27T00:00:00.000Z";

describe("migration chain (v1 → latest)", () => {
  it("upgrades a v1 database in one go: data kept, every table present, backup written once", () => {
    const dir = mkdtempSync(join(tmpdir(), "room-db-chain-"));
    dirs.push(dir);
    const file = join(dir, "legacy.db");

    const legacy = new Database(file);
    try {
      legacy.exec(SCHEMA_V1);
      legacy.pragma("user_version = 1");
      legacy.prepare("INSERT INTO projects (id, name, created_at) VALUES ('proj_old', '旧项目', ?)").run(NOW);
      legacy
        .prepare(
          "INSERT INTO prompt_snapshots (id, project_id, content, content_hash, nonce, contribution_ids, task_instruction, " +
            "reviewer_agent, adapter_version, token_estimate, created_at) VALUES ('snap_old', 'proj_old', 'b', ?, '0123456789abcdef', " +
            "'[\"c_1\"]', 't', 'deepseek', 'v1', 1, ?)",
        )
        .run("a".repeat(64), NOW);
      legacy
        .prepare(
          "INSERT INTO approvals (id, project_id, snapshot_id, state, created_at) VALUES ('appr_old', 'proj_old', 'snap_old', 'APPROVED', ?)",
        )
        .run(NOW);
      legacy
        .prepare(
          "INSERT INTO runs (id, project_id, approval_id, snapshot_id, adapter_id, state, created_at) " +
            "VALUES ('run_old', 'proj_old', 'appr_old', 'snap_old', 'api', 'COMPLETED', ?)",
        )
        .run(NOW);
    } finally {
      legacy.close();
    }

    const db = openDatabase(file);
    try {
      assert.equal(currentVersion(db), LATEST_SCHEMA_VERSION);
      assert.ok(LATEST_SCHEMA_VERSION >= 11);
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(
        (t) => t.name,
      );
      for (const table of [
        "projects",
        "runs",
        "conversations",
        "chat_messages",
        "chat_reply_slots",
        "chat_snapshots",
        "images",
        "files",
        "chat_stickers",
        "media_jobs",
      ]) {
        assert.ok(tables.includes(table), `missing table ${table}`);
      }
      assert.equal((db.prepare("SELECT count(*) AS n FROM projects").get() as { n: number }).n, 1);
      assert.equal((db.prepare("SELECT count(*) AS n FROM runs").get() as { n: number }).n, 1);
      assert.deepEqual(db.pragma("foreign_key_check"), []);
      // 迁移前的状态还在（v1 的 run 仍然是 COMPLETED）
      assert.equal((db.prepare("SELECT state FROM runs WHERE id = 'run_old'").get() as { state: string }).state, "COMPLETED");
    } finally {
      db.close();
    }
    assert.ok(existsSync(file + ".bak-v1"));

    // 再开一次：已经是最新版本，不再迁移、也不覆盖备份
    const again = openDatabase(file);
    try {
      assert.equal(currentVersion(again), LATEST_SCHEMA_VERSION);
      assert.equal((again.prepare("SELECT count(*) AS n FROM projects").get() as { n: number }).n, 1);
    } finally {
      again.close();
    }
  });
});

/** 只迁到某个版本（模拟「用户库里已经是 v18」） */
function applyUpTo(db: Database.Database, upTo: number): void {
  for (const migration of MIGRATIONS) {
    if (migration.version > upTo) break;
    if (migration.disableForeignKeys === true) db.pragma("foreign_keys = OFF");
    db.exec("BEGIN");
    migration.up(db);
    db.pragma(`user_version = ${migration.version}`);
    db.exec("COMMIT");
    db.pragma("foreign_keys = ON");
  }
}

describe("v19：audio_refs 重建（#137 C酱）", () => {
  it("已经有合成语音的库能从 v18 升上来：数据不变、外键干净、webm 能进、触发器还在", () => {
    const dir = mkdtempSync(join(tmpdir(), "room-db-v19-"));
    dirs.push(dir);
    const file = join(dir, "v18.db");

    const v18 = new Database(file);
    try {
      v18.pragma("foreign_keys = ON");
      applyUpTo(v18, 18);
      assert.equal(currentVersion(v18), 18);
      v18
        .prepare("INSERT INTO audio_refs (ref, sha256, mime, bytes, created_at) VALUES (?, ?, 'audio/wav', 10, ?)")
        .run("aud_OLD", "b".repeat(64), NOW);
      v18
        .prepare(
          "INSERT INTO speech_clips (id, text_hash, voice_id, speed, engine, engine_version, audio_ref, mime, duration_ms, created_at) " +
            "VALUES (?, ?, 'xiaoyu', 1, 'indextts2', 'v1', ?, 'audio/wav', 1200, ?)",
        )
        .run("clip_OLD", "c".repeat(64), "aud_OLD", NOW);
    } finally {
      v18.close();
    }

    // 升级：这一步在旧代码里会因为 speech_clips 的外键直接失败
    const db = openDatabase(file);
    try {
      assert.equal(currentVersion(db), LATEST_SCHEMA_VERSION);
      assert.ok(LATEST_SCHEMA_VERSION >= 19);
      assert.equal((db.prepare("SELECT count(*) AS n FROM audio_refs").get() as { n: number }).n, 1, "音频引用不丢");
      assert.equal((db.prepare("SELECT count(*) AS n FROM speech_clips").get() as { n: number }).n, 1, "合成片段不丢");
      assert.deepEqual(db.pragma("foreign_key_check"), [], "重建之后外键一致");
      // speech_clips 的外键现在指向重建后的 audio_refs
      const fks = db.pragma("foreign_key_list('speech_clips')") as { table: string; from: string; to: string }[];
      assert.ok(fks.some((fk) => fk.table === "audio_refs" && fk.from === "audio_ref" && fk.to === "ref"));
      // 新的 CHECK 收 webm
      db.prepare("INSERT INTO audio_refs (ref, sha256, mime, bytes, created_at) VALUES (?, ?, 'audio/webm', 20, ?)").run(
        "aud_WEBM",
        "d".repeat(64),
        NOW,
      );
      // 触发器重建了：引用记录不能改
      assert.throws(() => db.prepare("UPDATE audio_refs SET bytes = 1 WHERE ref = 'aud_OLD'").run(), /immutable/);
      // 老 CHECK 里的格式仍然可用
      assert.equal((db.prepare("SELECT mime FROM audio_refs WHERE ref = 'aud_OLD'").get() as { mime: string }).mime, 'audio/wav');
    } finally {
      db.close();
    }
  });
});



describe("migration v20 → v21 (chat tables rebuilt for window_handoff)", () => {
  it("keeps chat rows and foreign keys when upgrading a v20 database that already has chat data", () => {
    const dir = mkdtempSync(join(tmpdir(), "room-db-v20-"));
    dirs.push(dir);
    const file = join(dir, "v20.db");

    const legacy = new Database(file);
    try {
      legacy.pragma("foreign_keys = ON");
      for (const migration of MIGRATIONS) {
        if (migration.version > 20) break;
        if (migration.disableForeignKeys === true) legacy.pragma("foreign_keys = OFF");
        legacy.exec("BEGIN IMMEDIATE");
        migration.up(legacy);
        legacy.pragma("user_version = " + migration.version);
        legacy.exec("COMMIT");
        if (migration.disableForeignKeys === true) legacy.pragma("foreign_keys = ON");
      }
      assert.equal((legacy.pragma("user_version", { simple: true }) as number), 20);

      legacy
        .prepare(
          "INSERT INTO conversations (id, kind, direct_agent, last_activity_at, created_at) " +
            "VALUES ('conv_old', 'direct', 'deepseek', ?, ?)",
        )
        .run(NOW, NOW);
      // history_summary 的快照没有当前消息；Run 指着它 —— 重建 chat_snapshots 时外键必须关掉
      legacy
        .prepare(
          "INSERT INTO chat_snapshots (id, purpose, conversation_id, user_message_id, agent, content, content_hash, nonce, " +
            "memory_slot, attachments, included_message_ids, included_summary_ids, adapter_version, token_estimate, created_at) " +
            "VALUES ('snap_old', 'history_summary', 'conv_old', NULL, 'deepseek', '旧摘要', ?, '0123456789abcdef', " +
            "NULL, NULL, '[\"msg_old\"]', '[]', 'v1', 1, ?)",
        )
        .run("a".repeat(64), NOW);
      legacy
        .prepare(
          "INSERT INTO chat_runs (id, kind, purpose, conversation_id, slot_id, agent, snapshot_id, snapshot_hash, " +
            "final_prompt_hash, memory_manifest, model, adapter_id, state, substate, failure_reason, attempt, created_at, " +
            "started_at, finished_at) VALUES ('run_old', 'chat', 'history_summary', 'conv_old', NULL, 'deepseek', " +
            "'snap_old', ?, NULL, NULL, NULL, 'remote:deepseek', 'COMPLETED', NULL, NULL, 1, ?, NULL, ?)",
        )
        .run("b".repeat(64), NOW, NOW);
    } finally {
      legacy.close();
    }

    const db = openDatabase(file);
    try {
      assert.equal(currentVersion(db), LATEST_SCHEMA_VERSION);
      assert.equal((db.prepare("SELECT count(*) AS n FROM chat_snapshots").get() as { n: number }).n, 1);
      assert.equal((db.prepare("SELECT count(*) AS n FROM chat_runs").get() as { n: number }).n, 1);
      assert.deepEqual(db.pragma("foreign_key_check"), []);
      const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'chat_runs'").get() as { sql: string }).sql;
      assert.ok(sql.includes("window_handoff"), "重建后的 chat_runs 要收下 window_handoff");
    } finally {
      db.close();
    }
  });
});
