import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { currentVersion, LATEST_SCHEMA_VERSION, openDatabase } from "../src/index";

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
    const db = openDatabase(file);
    assert.equal(currentVersion(db), LATEST_SCHEMA_VERSION);
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
