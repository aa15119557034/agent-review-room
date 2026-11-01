import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import Database from "better-sqlite3";
import { currentVersion, LATEST_SCHEMA_VERSION, openDatabase } from "../src/index";
import { SCHEMA_V1, SCHEMA_V2 } from "../src/schema";
import { SCHEMA_V3, SCHEMA_V3_REBUILD } from "../src/schema-v3";
import { SCHEMA_V4 } from "../src/schema-v4";
import { SCHEMA_V5 } from "../src/schema-v5";
import { SCHEMA_V6 } from "../src/schema-v6";
import { SCHEMA_V7 } from "../src/schema-v7";
import { SCHEMA_V8 } from "../src/schema-v8";
import { SCHEMA_V9 } from "../src/schema-v9";
import { SCHEMA_V10 } from "../src/schema-v10";
import { SCHEMA_V11 } from "../src/schema-v11";
import { SCHEMA_V12 } from "../src/schema-v12";

/**
 * v13（C-44 / D-40）：主控机上林离的参与者从 controller-local（7420）迁到
 * controller-local-codex（7421），节点行没有就补一条；别的电脑上的库不动。
 */

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

const OLD = "2026-10-01T00:00:00.000Z";

/** 造一个停在 v12 的库（把 v1～v12 的 schema 照顺序跑一遍） */
function makeV12(dir: string): string {
  const file = join(dir, "v12.db");
  const db = new Database(file);
  try {
    db.exec(SCHEMA_V1);
    db.exec(SCHEMA_V2);
    db.exec(SCHEMA_V3);
    db.exec(SCHEMA_V3_REBUILD);
    for (const schema of [SCHEMA_V4, SCHEMA_V5, SCHEMA_V6, SCHEMA_V7, SCHEMA_V8, SCHEMA_V9, SCHEMA_V10, SCHEMA_V11, SCHEMA_V12]) {
      db.exec(schema);
    }
    db.pragma("user_version = 12");
  } finally {
    db.close();
  }
  return file;
}

interface SeedOptions {
  readonly codexNode: string | null;
  readonly otherNode?: { readonly id: string; readonly baseUrl: string };
}

function seed(file: string, options: SeedOptions): void {
  const db = new Database(file);
  try {
    const node = db.prepare("INSERT INTO nodes (id, display_name, base_url, created_at) VALUES (?, ?, ?, ?)");
    node.run("controller-local", "主控机（本机）", "http://127.0.0.1:7420", OLD);
    node.run("user-pc", "你的电脑", "http://192.168.0.9:7420", OLD);
    if (options.otherNode) node.run(options.otherNode.id, "自定义", options.otherNode.baseUrl, OLD);

    const agent = db.prepare(
      "INSERT INTO agents (id, display_name, color, can_discuss, can_summarize, can_execute, node_id, profile_id, " +
        "created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    agent.run("claude", "C酱", "#a0522d", 1, 1, 0, "user-pc", "claude-review", OLD, OLD);
    agent.run("deepseek", "汐", "#2f5aa0", 1, 0, 1, "controller-local", "deepseek-discuss", OLD, OLD);
    agent.run("codex", "林离", "#1f6b55", 1, 0, 1, options.codexNode, "codex-discuss", OLD, OLD);
  } finally {
    db.close();
  }
}

const row = (file: string, sql: string, ...args: unknown[]): Record<string, unknown> | undefined => {
  const db = new Database(file, { readonly: true });
  try {
    return db.prepare(sql).get(...args) as Record<string, unknown> | undefined;
  } finally {
    db.close();
  }
};

describe("v13: controller-local-codex node (D-40)", () => {
  it("moves codex to the new node and adds `127.0.0.1:7421`, leaving everyone else alone", () => {
    const dir = mkdtempSync(join(tmpdir(), "room-db-v13-"));
    dirs.push(dir);
    const file = makeV12(dir);
    seed(file, { codexNode: "controller-local" });

    const db = openDatabase(file);
    try {
      assert.equal(currentVersion(db), LATEST_SCHEMA_VERSION);
      assert.ok(LATEST_SCHEMA_VERSION >= 13);
      assert.equal((db.pragma("foreign_key_check") as unknown[]).length, 0);
    } finally {
      db.close();
    }

    assert.deepEqual(
      record(row(file, "SELECT id, base_url FROM nodes WHERE id = 'controller-local-codex'")),
      { id: "controller-local-codex", base_url: "http://127.0.0.1:7421" },
    );
    assert.equal(row(file, "SELECT node_id FROM agents WHERE id = 'codex'")?.node_id, "controller-local-codex");
    // 讨论和聊天都按 agents.node_id 选节点，所以这一条就决定了林离走 7421
    assert.equal(row(file, "SELECT node_id FROM agents WHERE id = 'deepseek'")?.node_id, "controller-local");
    assert.equal(row(file, "SELECT node_id FROM agents WHERE id = 'claude'")?.node_id, "user-pc");
    // 迁移会更新 updated_at（旧库的时间戳容易和「真的改过」混起来）
    assert.notEqual(row(file, "SELECT updated_at FROM agents WHERE id = 'codex'")?.updated_at, OLD);
  });

  it("leaves a database alone when codex lives on another machine", () => {
    const dir = mkdtempSync(join(tmpdir(), "room-db-v13-"));
    dirs.push(dir);
    const file = makeV12(dir);
    seed(file, { codexNode: "user-pc" });

    const db = openDatabase(file);
    try {
      assert.equal(currentVersion(db), LATEST_SCHEMA_VERSION);
    } finally {
      db.close();
    }

    assert.equal(row(file, "SELECT 1 AS x FROM nodes WHERE id = 'controller-local-codex'"), undefined);
    assert.equal(row(file, "SELECT node_id FROM agents WHERE id = 'codex'")?.node_id, "user-pc");
    assert.equal(row(file, "SELECT updated_at FROM agents WHERE id = 'codex'")?.updated_at, OLD);
  });

  it("keeps a node row the user already configured", () => {
    const dir = mkdtempSync(join(tmpdir(), "room-db-v13-"));
    dirs.push(dir);
    const file = makeV12(dir);
    seed(file, { codexNode: "controller-local", otherNode: { id: "controller-local-codex", baseUrl: "http://127.0.0.1:9999" } });

    const db = openDatabase(file);
    try {
      assert.equal(currentVersion(db), LATEST_SCHEMA_VERSION);
    } finally {
      db.close();
    }

    assert.equal(
      row(file, "SELECT base_url FROM nodes WHERE id = 'controller-local-codex'")?.base_url,
      "http://127.0.0.1:9999",
      "用户自己配的地址不能被迁移覆盖",
    );
    assert.equal(row(file, "SELECT node_id FROM agents WHERE id = 'codex'")?.node_id, "controller-local-codex");
  });
});

function record(value: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  return value === undefined ? undefined : { ...value };
}
