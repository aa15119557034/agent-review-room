import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import Database from "better-sqlite3";
import { currentVersion, LATEST_SCHEMA_VERSION, MIGRATIONS, openDatabase } from "../src/index";

const dirs: string[] = [];
after(() => {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // Windows 句柄延迟
    }
  }
});

describe("agents.voice（迁移 26）", () => {
  it("已有 voice 列、user_version 回退到 25，再打开不报 duplicate column", () => {
    const dir = mkdtempSync(join(tmpdir(), "room-v26-"));
    dirs.push(dir);
    const file = join(dir, "room.db");
    // The fixture is v26, not the latest schema with only its version marker rolled back.
    const db = new Database(file);
    db.pragma("foreign_keys = ON");
    for (const migration of MIGRATIONS.filter((entry) => entry.version <= 26)) {
      if (migration.disableForeignKeys) db.pragma("foreign_keys = OFF");
      db.transaction(() => {
        migration.up(db);
        db.pragma("user_version = " + migration.version);
      })();
      db.pragma("foreign_keys = ON");
    }
    assert.equal(currentVersion(db), 26);
    const columns = db.prepare("PRAGMA table_info(agents)").all() as { name: string }[];
    assert.ok(columns.some((column) => column.name === "voice"));
    db.pragma("user_version = 25");
    db.close();
    // 迁移 26 会重跑：列已经在就跳过（验收机手工跑过 v26 的情况）
    const again = openDatabase(file);
    assert.equal(currentVersion(again), LATEST_SCHEMA_VERSION);
    again.close();
  });
});
