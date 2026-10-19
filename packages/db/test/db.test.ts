import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { currentVersion, openDatabase, ulid, WriteQueue, writeTransaction } from "../src/index";
import type { SqliteDatabase } from "../src/index";

/** 每个测试一个独立库文件，避免互相污染（迁移和触发器的测试尤其需要干净库）。 */
const dirs: string[] = [];

function freshDb(): { db: SqliteDatabase; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "room-db-"));
  dirs.push(dir);
  const file = join(dir, "test.db");
  return { db: openDatabase(file), file };
}

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const NOW = "2026-10-20T00:00:00.000Z";

/** better-sqlite3 的 get() 返回 unknown，测试里统一用它取单值。 */
function count(db: SqliteDatabase, sql: string): number {
  return (db.prepare(sql).get() as { n: number }).n;
}

function seedProject(db: SqliteDatabase, id = "proj_01"): string {
  db.prepare("INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)").run(id, "测试项目", NOW);
  return id;
}

function seedMessage(db: SqliteDatabase, projectId: string, id = "msg_01", content = "hello"): string {
  db.prepare(
    "INSERT INTO messages (id, project_id, kind, source_agent, run_id, content, created_at) VALUES (?, ?, 'source_input', 'deepseek', NULL, ?, ?)",
  ).run(id, projectId, content, NOW);
  return id;
}

function seedSnapshot(db: SqliteDatabase, projectId: string, id = "snap_01"): string {
  db.prepare(
    `INSERT INTO prompt_snapshots
       (id, project_id, content, content_hash, nonce, contribution_ids, task_instruction,
        reviewer_agent, adapter_version, token_estimate, synthesis_version, branch, commit_sha, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)`,
  ).run(
    id,
    projectId,
    "prompt body",
    "a".repeat(64),
    "0123456789abcdef",
    JSON.stringify(["c_01"]),
    "评审这段",
    "deepseek",
    "v1",
    12,
    NOW,
  );
  return id;
}

describe("migrations", () => {
  it("applies v1 on a fresh database", () => {
    const { db } = freshDb();
    assert.equal(currentVersion(db), 1);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => (row as { name: string }).name);
    for (const expected of ["projects", "messages", "contributions", "prompt_snapshots", "approvals", "runs"]) {
      assert.ok(tables.includes(expected), `missing table ${expected}`);
    }
    db.close();
  });

  it("is idempotent", () => {
    const { db, file } = freshDb();
    db.close();
    const reopened = openDatabase(file);
    assert.equal(currentVersion(reopened), 1);
    reopened.close();
  });
});

describe("connection invariants", () => {
  it("uses WAL, foreign keys and busy_timeout", () => {
    const { db } = freshDb();
    assert.equal(db.pragma("journal_mode", { simple: true }), "wal");
    assert.equal(db.pragma("foreign_keys", { simple: true }), 1);
    assert.equal(db.pragma("busy_timeout", { simple: true }), 5000);
    db.close();
  });
});

describe("constraints", () => {
  it("rejects a message whose project does not exist", () => {
    const { db } = freshDb();
    assert.throws(() => seedMessage(db, "proj_missing"), /FOREIGN KEY/);
    db.close();
  });

  it("rejects reviewer_output without a run", () => {
    const { db } = freshDb();
    const projectId = seedProject(db);
    assert.throws(
      () =>
        db
          .prepare(
            "INSERT INTO messages (id, project_id, kind, source_agent, run_id, content, created_at) VALUES ('msg_x', ?, 'reviewer_output', 'deepseek', NULL, 'x', ?)",
          )
          .run(projectId, NOW),
      /CHECK/,
    );
    db.close();
  });

  it("rejects unknown contribution types and bad selections", () => {
    const { db } = freshDb();
    const projectId = seedProject(db);
    const messageId = seedMessage(db, projectId);

    const insert = db.prepare(
      `INSERT INTO contributions
         (id, project_id, source_message_id, type, title, content, selection_start, selection_end,
          confidence, created_by, schema_version, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'human', 1, ?)`,
    );

    assert.throws(() => insert.run("c_bad", projectId, messageId, "not_a_type", "t", "c", 0, 1, NOW), /CHECK/);
    assert.throws(() => insert.run("c_bad2", projectId, messageId, "issue", "t", "c", 3, 3, NOW), /CHECK/);
    insert.run("c_ok", projectId, messageId, "issue", "标题", "x", 0, 1, NOW);
    assert.equal(count(db, "SELECT count(*) AS n FROM contributions"), 1);
    db.close();
  });

  it("rejects unknown run states and couples substate/failure_reason to state", () => {
    const { db } = freshDb();
    const projectId = seedProject(db);
    const snapshotId = seedSnapshot(db, projectId);
    db.prepare("INSERT INTO approvals (id, project_id, snapshot_id, state, created_at) VALUES ('appr_01', ?, ?, 'APPROVED', ?)")
      .run(projectId, snapshotId, NOW);

    const insertRun = db.prepare(
      `INSERT INTO runs (id, project_id, approval_id, snapshot_id, adapter_id, state, substate, failure_reason, created_at)
       VALUES (?, ?, 'appr_01', ?, 'api', ?, ?, ?, ?)`,
    );

    assert.throws(() => insertRun.run("run_bad", projectId, snapshotId, "NOPE", null, null, NOW), /CHECK/);
    // substate 只在 RUNNING 允许
    assert.throws(() => insertRun.run("run_bad2", projectId, snapshotId, "QUEUED", "active", null, NOW), /CHECK/);
    // failure_reason 只在 FAILED 允许
    assert.throws(
      () => insertRun.run("run_bad3", projectId, snapshotId, "RUNNING", null, "interrupted", NOW),
      /CHECK/,
    );
    insertRun.run("run_ok", projectId, snapshotId, "RUNNING", "active", null, NOW);
    db.close();
  });

  it("enforces one run per approval", () => {
    const { db } = freshDb();
    const projectId = seedProject(db);
    const snapshotId = seedSnapshot(db, projectId);
    db.prepare("INSERT INTO approvals (id, project_id, snapshot_id, state, created_at) VALUES ('appr_01', ?, ?, 'APPROVED', ?)")
      .run(projectId, snapshotId, NOW);

    const insertRun = db.prepare(
      `INSERT INTO runs (id, project_id, approval_id, snapshot_id, adapter_id, state, created_at)
       VALUES (?, ?, 'appr_01', ?, 'api', 'QUEUED', ?)`,
    );
    insertRun.run("run_1", projectId, snapshotId, NOW);
    assert.throws(() => insertRun.run("run_2", projectId, snapshotId, NOW), /UNIQUE/);
    db.close();
  });

  it("keeps messages and snapshots immutable", () => {
    const { db } = freshDb();
    const projectId = seedProject(db);
    const messageId = seedMessage(db, projectId);
    const snapshotId = seedSnapshot(db, projectId);

    assert.throws(() => db.prepare("UPDATE messages SET content = 'x' WHERE id = ?").run(messageId), /immutable/);
    assert.throws(() => db.prepare("DELETE FROM messages WHERE id = ?").run(messageId), /immutable/);
    assert.throws(() => db.prepare("UPDATE prompt_snapshots SET content = 'x' WHERE id = ?").run(snapshotId), /immutable/);
    db.close();
  });
});

describe("ulid", () => {
  it("is 26 Crockford Base32 chars", () => {
    const id = ulid();
    assert.match(id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("is monotonic within one millisecond", () => {
    const fixed = 1_760_000_000_000;
    const ids = Array.from({ length: 500 }, () => ulid(fixed));
    const sorted = [...ids].sort();
    assert.deepEqual(ids, sorted, "same-millisecond ULIDs must stay ordered");
    assert.equal(new Set(ids).size, ids.length);
  });

  it("sorts by time across milliseconds, even if the clock goes backwards", () => {
    const t = 1_760_000_000_000;
    const earlier = ulid(t);
    const later = ulid(t + 5);
    assert.ok(earlier < later, "later timestamp must sort after an earlier one");

    // 时钟回拨：不能产生比已发出的更小的 ID，否则按 ID 排序会乱
    const backwards = ulid(t - 1000);
    assert.ok(backwards > later, "clock rollback must not produce a smaller ULID");
  });
});

describe("single writer queue", () => {
  it("serializes concurrent writes instead of nesting transactions", async () => {
    const { db } = freshDb();
    const queue = new WriteQueue();

    const ids = await Promise.all(
      Array.from({ length: 30 }, (_, index) =>
        writeTransaction(db, queue, () => {
          const id = `proj_${String(index).padStart(2, "0")}`;
          db.prepare("INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)").run(id, `p${index}`, NOW);
          return id;
        }),
      ),
    );

    assert.equal(new Set(ids).size, 30);
    assert.equal(count(db, "SELECT count(*) AS n FROM projects"), 30);
    await queue.drain();
    assert.equal(queue.pending, 0);
    db.close();
  });

  it("rolls back a failed transaction and keeps the queue usable", async () => {
    const { db } = freshDb();
    const queue = new WriteQueue();

    await assert.rejects(
      writeTransaction(db, queue, () => {
        db.prepare("INSERT INTO projects (id, name, created_at) VALUES ('proj_x', 'x', ?)").run(NOW);
        throw new Error("boom");
      }),
      /boom/,
    );

    assert.equal(count(db, "SELECT count(*) AS n FROM projects"), 0);

    const ok = await writeTransaction(db, queue, () => {
      db.prepare("INSERT INTO projects (id, name, created_at) VALUES ('proj_y', 'y', ?)").run(NOW);
      return "done";
    });
    assert.equal(ok, "done");
    assert.equal(count(db, "SELECT count(*) AS n FROM projects"), 1);
    db.close();
  });
});

describe("AC-10 重启后历史仍可读取", () => {
  it("reads back what was written after reopening the file", () => {
    const { db, file } = freshDb();
    const projectId = seedProject(db);
    const messageId = seedMessage(db, projectId, "msg_keep", "持久化的原文");
    db.close();

    const reopened = openDatabase(file);
    const row = reopened.prepare("SELECT content FROM messages WHERE id = ?").get(messageId) as { content: string };
    assert.equal(row.content, "持久化的原文");
    assert.equal(count(reopened, "SELECT count(*) AS n FROM projects"), 1);
    reopened.close();
  });
});
