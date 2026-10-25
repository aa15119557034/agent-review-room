import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import Database from "better-sqlite3";
import { currentVersion, LATEST_SCHEMA_VERSION, openDatabase } from "../src/index";
import { SCHEMA_V2 } from "../src/schema";
import { SCHEMA_V1 } from "../src/schema";
import { SCHEMA_V3, SCHEMA_V3_REBUILD } from "../src/schema-v3";

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // Windows 句柄延迟
    }
  }
});

describe("迁移 v4：模型选择", () => {
  it("v3 旧库升级：旧参与者 model_settings 为 NULL，新增 batch_items.model 列", async () => {
    const dir = mkdtempSync(join(tmpdir(), "room-model-v4-"));
    dirs.push(dir);
    const file = join(dir, "legacy.db");
    const raw = new Database(file);
    raw.pragma("foreign_keys = OFF");
    // 一个真实的 v3 库：v5 给 projects 加列，所以 fixture 要按 v1→v3 的顺序建全
    raw.exec(SCHEMA_V1);
    raw.exec(SCHEMA_V2);
    raw.exec(SCHEMA_V3);
    raw.exec(SCHEMA_V3_REBUILD);
    raw.pragma("user_version = 3");
    raw
      .prepare(
        "INSERT INTO agents (id, display_name, color, role_note, can_discuss, can_summarize, can_execute, paused_by_user, created_at, updated_at) " +
          "VALUES ('claude', 'C酱', '#a0522d', '', 1, 1, 0, 0, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')",
      )
      .run();
    raw.close();

    const db = openDatabase(file);
    try {
      assert.equal(currentVersion(db), LATEST_SCHEMA_VERSION);
      const agentColumns = db.prepare("PRAGMA table_info(agents)").all() as { name: string }[];
      const batchColumns = db.prepare("PRAGMA table_info(batch_items)").all() as { name: string }[];
      assert.ok(agentColumns.some((column) => column.name === "model_settings"));
      assert.ok(batchColumns.some((column) => column.name === "model"));

      const agent = db.prepare("SELECT model_settings FROM agents WHERE id = 'claude'").get() as { model_settings: string | null };
      assert.equal(agent.model_settings, null, "旧参与者没有设置过模型");
      assert.equal((db.prepare("SELECT count(*) AS n FROM agents").get() as { n: number }).n, 1, "旧行还在");
      assert.deepEqual(db.pragma("foreign_key_check"), []);
    } finally {
      db.close();
    }
  });

  it("新库建到 v4：v4 的列存在，再打开是幂等的", async () => {
    const dir = mkdtempSync(join(tmpdir(), "room-model-v4-new-"));
    dirs.push(dir);
    const file = join(dir, "new.db");
    const db = openDatabase(file);
    assert.equal(currentVersion(db), LATEST_SCHEMA_VERSION);
    db.close();
    const reopened = openDatabase(file);
    assert.equal(currentVersion(reopened), LATEST_SCHEMA_VERSION);
    reopened.close();
  });
});
