import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import Database from "better-sqlite3";
import { currentVersion, openDatabase, WriteQueue, writeTransaction } from "../src/index";
import { SCHEMA_V1 } from "../src/schema";
import type { SqliteDatabase } from "../src/index";

const dirs: string[] = [];

function freshDb(): { db: SqliteDatabase; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "room-db-v3-"));
  dirs.push(dir);
  const file = join(dir, "test.db");
  return { db: openDatabase(file), file };
}

after(() => {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // Windows 句柄释放有延迟
    }
  }
});

const NOW = "2026-10-21T00:00:00.000Z";
const HASH = "a".repeat(64);

let seq = 0;
/** 26 位 Crockford Base32 的 ULID 体，最后一个字符按序号变化，保证唯一 */
function id(prefix: string): string {
  seq += 1;
  const body = ("01JABCDEFGHJKMNPQRSTVWXYZ" + "0").slice(0, 25) + "0123456789ABCDEFGHJKMNPQRSTVWXYZ"[seq % 32];
  return prefix + "_" + body;
}

/** Phase 0 的最小可用数据：项目 + 快照 + 已批准的 Approval + Run */
function seedApprovedRun(db: SqliteDatabase) {
  const projectId = id("proj");
  const snapshotId = id("snap");
  const approvalId = id("apr");
  const runId = id("run");

  db.prepare("INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)").run(projectId, "项目", NOW);
  db.prepare(
    "INSERT INTO prompt_snapshots (id, project_id, content, content_hash, nonce, contribution_ids, task_instruction, " +
      "reviewer_agent, adapter_version, token_estimate, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(snapshotId, projectId, "prompt", HASH, "0123456789abcdef", '["c_1"]', "任务", "deepseek", "prompt-v2", 10, NOW);
  db.prepare(
    "INSERT INTO approvals (id, project_id, snapshot_id, state, created_at) VALUES (?, ?, ?, 'APPROVED', ?)",
  ).run(approvalId, projectId, snapshotId, NOW);
  db.prepare(
    "INSERT INTO runs (id, project_id, approval_id, snapshot_id, adapter_id, state, created_at) VALUES (?, ?, ?, ?, ?, 'QUEUED', ?)",
  ).run(runId, projectId, approvalId, snapshotId, "api", NOW);

  return { projectId, snapshotId, approvalId, runId };
}

/** 单独造一个已批准的 Approval（Turn 的 approval_id 有外键） */
function seedApproval(db: SqliteDatabase, projectId: string, snapshotId: string): string {
  const approvalId = id("apr");
  db.prepare("INSERT INTO approvals (id, project_id, snapshot_id, state, created_at) VALUES (?, ?, ?, 'APPROVED', ?)").run(
    approvalId,
    projectId,
    snapshotId,
    NOW,
  );
  return approvalId;
}

function seedRound(db: SqliteDatabase, projectId: string) {
  const roundId = id("rnd");
  db.prepare(
    "INSERT INTO rounds (id, project_id, round_index, state, task, task_source, recipients, history_mode, created_at) " +
      "VALUES (?, ?, 1, 'DRAFT', '本轮任务', 'human', ?, 'recent_with_summaries', ?)",
  ).run(roundId, projectId, '["deepseek"]', NOW);
  return roundId;
}

describe("迁移 v3", () => {
  it("新库直接建到 v3，并包含讨论室的全部表", () => {
    const { db } = freshDb();
    assert.equal(currentVersion(db), 4);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => (r as { name: string }).name);

    for (const name of ["nodes", "agents", "plan_versions", "rounds", "batches", "batch_items", "turns", "round_summaries"]) {
      assert.ok(tables.includes(name), `缺少表 ${name}`);
    }
    db.close();
  });

  it("从旧库升级后 Phase 0 的数据和不可变约束都还在", () => {
    const dir = mkdtempSync(join(tmpdir(), "room-db-legacy3-"));
    dirs.push(dir);
    const file = join(dir, "v1.db");

    // 造一个 v1 的库（v1 schema + 一条完整的 Phase 0 数据）
    const legacy = new Database(file);
    legacy.exec(SCHEMA_V1);
    legacy.pragma("user_version = 1");
    legacy.prepare("INSERT INTO projects (id, name, created_at) VALUES ('proj_old', '旧项目', ?)").run(NOW);
    legacy
      .prepare(
        "INSERT INTO prompt_snapshots (id, project_id, content, content_hash, nonce, contribution_ids, task_instruction, " +
          "reviewer_agent, adapter_version, token_estimate, created_at) VALUES ('snap_old', 'proj_old', 'b', ?, '0123456789abcdef', " +
          "'[\"c_1\"]', 't', 'deepseek', 'v1', 1, ?)",
      )
      .run(HASH, NOW);
    legacy
      .prepare("INSERT INTO approvals (id, project_id, snapshot_id, state, created_at) VALUES ('appr_old', 'proj_old', 'snap_old', 'APPROVED', ?)")
      .run(NOW);
    legacy
      .prepare(
        "INSERT INTO runs (id, project_id, approval_id, snapshot_id, adapter_id, state, created_at) " +
          "VALUES ('run_old', 'proj_old', 'appr_old', 'snap_old', 'api', 'COMPLETED', ?)",
      )
      .run(NOW);
    legacy
      .prepare("INSERT INTO messages (id, project_id, kind, source_agent, content, created_at) VALUES ('msg_old', 'proj_old', 'source_input', 'deepseek', '原文', ?)")
      .run(NOW);
    legacy.close();

    const upgraded = openDatabase(file);
    assert.equal(currentVersion(upgraded), 4);
    assert.equal((upgraded.prepare("SELECT count(*) AS n FROM runs").get() as { n: number }).n, 1);
    assert.equal((upgraded.prepare("SELECT count(*) AS n FROM messages").get() as { n: number }).n, 1);
    assert.equal(
      (upgraded.prepare("SELECT content FROM messages WHERE id = 'msg_old'").get() as { content: string }).content,
      "原文",
    );

    // 重建后的 messages 仍然不可变，contributions 的一致性触发器也装回去了
    assert.throws(() => upgraded.prepare("UPDATE messages SET content = 'y' WHERE id = 'msg_old'").run(), /immutable/);
    assert.throws(() => upgraded.prepare("DELETE FROM messages WHERE id = 'msg_old'").run(), /immutable/);
    assert.throws(
      () =>
        upgraded
          .prepare(
            "INSERT INTO contributions (id, project_id, source_message_id, contribution_type, title, selection_start, selection_end, content, content_hash, confidence, created_by, schema_version, created_at) " +
              "VALUES ('c_x', 'proj_x', 'msg_old', 'issue', 't', 0, 1, 'x', ?, 0.5, 'deepseek', 1, ?)",
          )
          .run(HASH, NOW),
      /constraint|FOREIGN|contribution/i,
    );
    upgraded.close();
  });
});

describe("v3 约束：一轮与一批", () => {
  it("同一批次里同一个收件人只能有一项", () => {
    const { db } = freshDb();
    const { projectId, snapshotId, approvalId } = seedApprovedRun(db);
    const roundId = seedRound(db, projectId);
    const batchId = id("bat");
    db.prepare(
      "INSERT INTO batches (id, project_id, round_id, kind, state, created_at) VALUES (?, ?, ?, 'initial', 'APPROVED', ?)",
    ).run(batchId, projectId, roundId, NOW);

    const insert = db.prepare(
      "INSERT INTO batch_items (batch_id, recipient, approval_id, snapshot_id, content_hash, token_estimate) VALUES (?, ?, ?, ?, ?, 1)",
    );
    insert.run(batchId, "deepseek", approvalId, snapshotId, HASH);

    assert.throws(() => insert.run(batchId, "deepseek", id("apr"), snapshotId, HASH), /UNIQUE|constraint/i);
    db.close();
  });

  it("同一个 Approval 不能出现在两个批次项里（Phase 0 的「一个批准最多一个 Run」）", () => {
    const { db } = freshDb();
    const { projectId, snapshotId, approvalId } = seedApprovedRun(db);
    const roundId = seedRound(db, projectId);

    const makeBatch = (kind: string) => {
      const batchId = id("bat");
      db.prepare(
        "INSERT INTO batches (id, project_id, round_id, kind, state, created_at) VALUES (?, ?, ?, ?, 'APPROVED', ?)",
      ).run(batchId, projectId, roundId, kind, NOW);
      return batchId;
    };

    const first = makeBatch("initial");
    const second = makeBatch("retry");
    const insert = db.prepare(
      "INSERT INTO batch_items (batch_id, recipient, approval_id, snapshot_id, content_hash, token_estimate) VALUES (?, ?, ?, ?, ?, 1)",
    );
    insert.run(first, "deepseek", approvalId, snapshotId, HASH);
    assert.throws(() => insert.run(second, "codex", approvalId, snapshotId, HASH), /UNIQUE|constraint/i);
    db.close();
  });

  it("一轮的 approval 只能对应一个 Turn", () => {
    const { db } = freshDb();
    const { projectId, snapshotId, approvalId } = seedApprovedRun(db);
    const roundId = seedRound(db, projectId);
    const batchId = id("bat");
    db.prepare(
      "INSERT INTO batches (id, project_id, round_id, kind, state, created_at) VALUES (?, ?, ?, 'initial', 'APPROVED', ?)",
    ).run(batchId, projectId, roundId, NOW);

    const insert = db.prepare(
      "INSERT INTO turns (id, round_id, batch_id, agent, approval_id, outcome, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)",
    );
    insert.run(id("turn"), roundId, batchId, "deepseek", approvalId, NOW);
    assert.throws(() => insert.run(id("turn"), roundId, batchId, "codex", approvalId, NOW), /UNIQUE|constraint/i);
    db.close();
  });

  it("议题内的轮号唯一", () => {
    const { db } = freshDb();
    const { projectId } = seedApprovedRun(db);
    seedRound(db, projectId);
    assert.throws(() => seedRound(db, projectId), /UNIQUE|constraint/i);
    db.close();
  });

  it("作废的轮必须写原因", () => {
    const { db } = freshDb();
    const { projectId } = seedApprovedRun(db);
    const roundId = seedRound(db, projectId);
    assert.throws(() => db.prepare("UPDATE rounds SET state = 'VOIDED' WHERE id = ?").run(roundId), /constraint/i);
    db.prepare("UPDATE rounds SET state = 'VOIDED', void_reason = '改成方向了' WHERE id = ?").run(roundId);
    db.close();
  });
});

describe("v3 约束：方案版本", () => {
  function insertPlan(db: SqliteDatabase, projectId: string, version: number, state: string) {
    const planId = id("plan");
    db.prepare(
      "INSERT INTO plan_versions (id, project_id, version, state, content, content_hash, drafted_by_kind, created_at) " +
        "VALUES (?, ?, ?, ?, '内容', ?, 'human', ?)",
    ).run(planId, projectId, version, state, HASH, NOW);
    return planId;
  }

  it("版本号在议题内唯一，且每个议题最多一个 CURRENT / 一个 FINAL", () => {
    const { db } = freshDb();
    const { projectId } = seedApprovedRun(db);

    insertPlan(db, projectId, 1, "CURRENT");
    assert.throws(() => insertPlan(db, projectId, 1, "DRAFT"), /UNIQUE|constraint/i);
    assert.throws(() => insertPlan(db, projectId, 2, "CURRENT"), /UNIQUE|constraint/i);

    insertPlan(db, projectId, 2, "FINAL");
    assert.throws(() => insertPlan(db, projectId, 3, "FINAL"), /UNIQUE|constraint/i);
    db.close();
  });

  it("起草者为 agent 时必须写 agent 名", () => {
    const { db } = freshDb();
    const { projectId } = seedApprovedRun(db);
    assert.throws(
      () =>
        db
          .prepare(
            "INSERT INTO plan_versions (id, project_id, version, state, content, content_hash, drafted_by_kind, created_at) " +
              "VALUES (?, ?, 1, 'DRAFT', 'x', ?, 'agent', ?)",
          )
          .run(id("plan"), projectId, HASH, NOW),
      /constraint/i,
    );
    db.close();
  });
});

describe("v3 约束：messages 与 failure_reason 的新枚举", () => {
  it("接受讨论室的三种新 kind，并拒绝缺字段的组合", () => {
    const { db } = freshDb();
    const { projectId, runId, snapshotId } = seedApprovedRun(db);
    const roundId = seedRound(db, projectId);
    const batchId = id("bat");
    db.prepare(
      "INSERT INTO batches (id, project_id, round_id, kind, state, created_at) VALUES (?, ?, ?, 'initial', 'APPROVED', ?)",
    ).run(batchId, projectId, roundId, NOW);
    const turnId = id("turn");
    db.prepare(
      "INSERT INTO turns (id, round_id, batch_id, agent, approval_id, outcome, created_at) VALUES (?, ?, ?, 'deepseek', ?, 'pending', ?)",
    ).run(turnId, roundId, batchId, seedApproval(db, projectId, snapshotId), NOW);

    // human_note：不挂 run / turn
    db.prepare("INSERT INTO messages (id, project_id, kind, content, created_at) VALUES (?, ?, 'human_note', ?, ?)").run(
      id("msg"),
      projectId,
      "插一句话",
      NOW,
    );

    // agent_reply：必须同时有 run / round / turn
    const insertReply = db.prepare(
      "INSERT INTO messages (id, project_id, kind, source_agent, run_id, round_id, turn_id, on_behalf_of, content, created_at) " +
        "VALUES (?, ?, 'agent_reply', 'deepseek', ?, ?, ?, NULL, ?, ?)",
    );
    insertReply.run(id("msg"), projectId, runId, roundId, turnId, "回答", NOW);

    assert.throws(
      () =>
        db
          .prepare(
            "INSERT INTO messages (id, project_id, kind, source_agent, run_id, round_id, content, created_at) " +
              "VALUES (?, ?, 'agent_reply', 'deepseek', ?, ?, ?, ?)",
          )
          .run(id("msg"), projectId, runId, roundId, "x", NOW),
      /constraint/i,
    );
    db.close();
  });

  it("runs 接受 quota_exhausted，并且仍然只允许 FAILED 带原因", () => {
    const { db } = freshDb();
    const { runId } = seedApprovedRun(db);
    db.prepare("UPDATE runs SET state = 'FAILED', failure_reason = 'quota_exhausted' WHERE id = ?").run(runId);
    assert.equal(
      (db.prepare("SELECT failure_reason FROM runs WHERE id = ?").get(runId) as { failure_reason: string }).failure_reason,
      "quota_exhausted",
    );
    db.close();
  });

  it("turns 的 answered 必须带 reply_message_id", () => {
    const { db } = freshDb();
    const { projectId, snapshotId } = seedApprovedRun(db);
    const roundId = seedRound(db, projectId);
    const batchId = id("bat");
    db.prepare(
      "INSERT INTO batches (id, project_id, round_id, kind, state, created_at) VALUES (?, ?, ?, 'initial', 'APPROVED', ?)",
    ).run(batchId, projectId, roundId, NOW);

    const turnId = id("turn");
    db.prepare(
      "INSERT INTO turns (id, round_id, batch_id, agent, approval_id, outcome, created_at) VALUES (?, ?, ?, 'deepseek', ?, 'pending', ?)",
    ).run(turnId, roundId, batchId, seedApproval(db, projectId, snapshotId), NOW);

    assert.throws(
      () => db.prepare("UPDATE turns SET outcome = 'answered' WHERE id = ?").run(turnId),
      /constraint/i,
    );
    db.close();
  });
});

describe("v3 约束：事务与不可变", () => {
  it("整批盖章在同一个事务里：任一项失败则全部回滚", async () => {
    const { db } = freshDb();
    const { projectId, snapshotId, approvalId } = seedApprovedRun(db);
    const roundId = seedRound(db, projectId);

    const queue = new WriteQueue();
    await assert.rejects(
      () =>
        writeTransaction(db, queue, () => {
        const batchId = id("bat");
        db.prepare(
          "INSERT INTO batches (id, project_id, round_id, kind, state, created_at) VALUES (?, ?, ?, 'initial', 'APPROVED', ?)",
        ).run(batchId, projectId, roundId, NOW);
        db.prepare(
          "INSERT INTO batch_items (batch_id, recipient, approval_id, snapshot_id, content_hash, token_estimate) VALUES (?, 'deepseek', ?, ?, ?, 1)",
        ).run(batchId, approvalId, snapshotId, HASH);
        // 第二项用同一个 approval，必然 UNIQUE 失败
        db.prepare(
          "INSERT INTO batch_items (batch_id, recipient, approval_id, snapshot_id, content_hash, token_estimate) VALUES (?, 'codex', ?, ?, ?, 1)",
        ).run(batchId, approvalId, snapshotId, HASH);
        }),
      /UNIQUE|constraint/i,
    );

    assert.equal((db.prepare("SELECT count(*) AS n FROM batches").get() as { n: number }).n, 0);
    assert.equal((db.prepare("SELECT count(*) AS n FROM batch_items").get() as { n: number }).n, 0);
    db.close();
  });
});

describe("v3：讨论室的 Snapshot 与「同时只有一轮没结束」", () => {
  it("接受没有片段的 Snapshot（contribution_ids 为 []）", () => {
    const { db } = freshDb();
    const { projectId } = seedApprovedRun(db);

    const snapshotId = id("snap");
    db.prepare(
      "INSERT INTO prompt_snapshots (id, project_id, content, content_hash, nonce, contribution_ids, task_instruction, " +
        "reviewer_agent, adapter_version, token_estimate, created_at) VALUES (?, ?, '讨论记录拼成的 Prompt', ?, '0123456789abcdef', '[]', '本轮任务', 'deepseek', 'prompt-v3', 10, ?)",
    ).run(snapshotId, projectId, HASH, NOW);

    assert.equal(
      (db.prepare("SELECT contribution_ids FROM prompt_snapshots WHERE id = ?").get(snapshotId) as { contribution_ids: string })
        .contribution_ids,
      "[]",
    );

    // 仍然是合法的 JSON 数组才能写进去
    assert.throws(
      () =>
        db
          .prepare(
            "INSERT INTO prompt_snapshots (id, project_id, content, content_hash, nonce, contribution_ids, task_instruction, " +
              "reviewer_agent, adapter_version, token_estimate, created_at) VALUES (?, ?, 'x', ?, '0123456789abcdef', 'not-json', 't', 'deepseek', 'v', 1, ?)",
          )
          .run(id("snap"), projectId, HASH, NOW),
      /constraint/i,
    );
    db.close();
  });

  it("同一议题同时只能有一轮没结束", () => {
    const { db } = freshDb();
    const { projectId } = seedApprovedRun(db);

    const insertRound = (index: number) => {
      const roundId = id("rnd");
      db.prepare(
        "INSERT INTO rounds (id, project_id, round_index, state, task, task_source, recipients, history_mode, created_at) " +
          "VALUES (?, ?, ?, 'DRAFT', '任务', 'human', ?, 'recent_with_summaries', ?)",
      ).run(roundId, projectId, index, '["deepseek"]', NOW);
      return roundId;
    };

    const first = insertRound(1);
    assert.throws(() => insertRound(2), /UNIQUE|constraint/i);

    // 第一轮总结完成之后，才能开第二轮
    db.prepare("UPDATE rounds SET state = 'SUMMARIZED', finished_at = ? WHERE id = ?").run(NOW, first);
    const second = insertRound(2);
    assert.ok(second);

    // 被作废的轮不占位
    db.prepare("UPDATE rounds SET state = 'VOIDED', void_reason = '改方向' WHERE id = ?").run(second);
    assert.ok(insertRound(3));
    db.close();
  });
});
