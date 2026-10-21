import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  approveBatch,
  BatchApproveError,
  openDatabase,
  ulid,
  WriteQueue,
} from "../src/index";
import type { SqliteDatabase } from "../src/index";

const dirs: string[] = [];
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
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

interface Fixture {
  db: SqliteDatabase;
  queue: WriteQueue;
  projectId: string;
  roundId: string;
  batchId: string;
  items: { recipient: string; approvalId: string; snapshotId: string; contentHash: string }[];
}

/** 一个「已经拼好 Prompt、等盖章」的批次：round(DRAFT) + batch(READY_FOR_REVIEW) + N 份 snapshot/approval */
function seedBatch(recipients: string[], kind = "initial"): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "room-db-d21-"));
  dirs.push(dir);
  const db = openDatabase(join(dir, "test.db"));
  const queue = new WriteQueue(db);

  const projectId = "proj_" + ulid();
  const roundId = "rnd_" + ulid();
  const batchId = "bat_" + ulid();

  db.prepare("INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)").run(projectId, "议题", NOW);
  db.prepare(
    "INSERT INTO rounds (id, project_id, round_index, state, task, task_source, recipients, history_mode, created_at) " +
      "VALUES (?, ?, 1, 'DRAFT', '本轮任务', 'human', ?, 'recent_with_summaries', ?)",
  ).run(roundId, projectId, JSON.stringify(recipients), NOW);
  db.prepare(
    "INSERT INTO batches (id, project_id, round_id, kind, state, created_at) VALUES (?, ?, ?, ?, 'READY_FOR_REVIEW', ?)",
  ).run(batchId, projectId, roundId, kind, NOW);

  const items = recipients.map((recipient, i) => {
    const content = `发给 ${recipient} 的 Prompt`;
    const contentHash = sha(content);
    const snapshotId = "snap_" + ulid();
    const approvalId = "apr_" + ulid();
    db.prepare(
      "INSERT INTO prompt_snapshots (id, project_id, content, content_hash, nonce, contribution_ids, task_instruction, " +
        "reviewer_agent, adapter_version, token_estimate, created_at) VALUES (?, ?, ?, ?, '0123456789abcdef', '[]', '任务', ?, 'prompt-v3', 10, ?)",
    ).run(snapshotId, projectId, content, contentHash, recipient, NOW);
    db.prepare(
      "INSERT INTO approvals (id, project_id, snapshot_id, state, created_at) VALUES (?, ?, ?, 'READY_FOR_REVIEW', ?)",
    ).run(approvalId, projectId, snapshotId, NOW);
    db.prepare(
      "INSERT INTO batch_items (batch_id, recipient, approval_id, snapshot_id, content_hash, token_estimate) VALUES (?, ?, ?, ?, ?, 10)",
    ).run(batchId, recipient, approvalId, snapshotId, contentHash);
    return { recipient, approvalId, snapshotId, contentHash };
  });

  return { db, queue, projectId, roundId, batchId, items };
}

const count = (db: SqliteDatabase, sql: string): number => (db.prepare(sql).get() as { n: number }).n;

describe("approveBatch：一次盖章 = N 个 Run", () => {
  it("两个人一起盖章：两个 Run、两个 Turn、两个 Approval 全部落地", async () => {
    const f = seedBatch(["deepseek", "codex"]);

    const result = await approveBatch(f.db, f.queue, {
      batchId: f.batchId,
      items: f.items.map((item) => ({ approvalId: item.approvalId, expectedContentHash: item.contentHash })),
      via: "desktop",
    });

    assert.equal(result.runIds.length, 2);
    assert.equal(result.turnIds.length, 2);
    assert.equal(count(f.db, "SELECT count(*) AS n FROM runs WHERE state = 'QUEUED'"), 2);
    assert.equal(count(f.db, "SELECT count(*) AS n FROM turns WHERE outcome = 'running'"), 2);
    assert.equal(count(f.db, "SELECT count(*) AS n FROM approvals WHERE state = 'APPROVED'"), 2);
    assert.equal(
      (f.db.prepare("SELECT state FROM batches WHERE id = ?").get(f.batchId) as { state: string }).state,
      "APPROVED",
    );
    assert.equal(
      (f.db.prepare("SELECT state FROM rounds WHERE id = ?").get(f.roundId) as { state: string }).state,
      "RUNNING",
    );

    // 每个 Turn 都指向自己的 Run，且批内不重复
    const pairs = f.db.prepare("SELECT agent, run_id FROM turns ORDER BY agent").all() as { agent: string; run_id: string }[];
    assert.deepEqual(pairs.map((p) => p.agent), ["codex", "deepseek"]);
    assert.equal(new Set(pairs.map((p) => p.run_id)).size, 2);
    f.db.close();
  });

  it("指纹对不上就整批不发，一条都不写", async () => {
    const f = seedBatch(["deepseek", "codex"]);
    const tampered = f.items.map((item, i) => ({
      approvalId: item.approvalId,
      expectedContentHash: i === 0 ? "b".repeat(64) : item.contentHash,
    }));

    await assert.rejects(
      () => approveBatch(f.db, f.queue, { batchId: f.batchId, items: tampered, via: "desktop" }),
      (error: unknown) => error instanceof BatchApproveError && error.code === "hash_mismatch",
    );

    assert.equal(count(f.db, "SELECT count(*) AS n FROM runs"), 0);
    assert.equal(count(f.db, "SELECT count(*) AS n FROM turns"), 0);
    assert.equal(count(f.db, "SELECT count(*) AS n FROM approvals WHERE state = 'APPROVED'"), 0);
    assert.equal(
      (f.db.prepare("SELECT state FROM batches WHERE id = ?").get(f.batchId) as { state: string }).state,
      "READY_FOR_REVIEW",
    );
    assert.equal(
      (f.db.prepare("SELECT state FROM rounds WHERE id = ?").get(f.roundId) as { state: string }).state,
      "DRAFT",
    );
    f.db.close();
  });

  it("少盖一个人也不行（不能只发一半）", async () => {
    const f = seedBatch(["deepseek", "codex"]);
    await assert.rejects(
      () =>
        approveBatch(f.db, f.queue, {
          batchId: f.batchId,
          items: [{ approvalId: f.items[0]!.approvalId, expectedContentHash: f.items[0]!.contentHash }],
          via: "desktop",
        }),
      (error: unknown) => error instanceof BatchApproveError && error.code === "item_missing",
    );
    assert.equal(count(f.db, "SELECT count(*) AS n FROM runs"), 0);
    f.db.close();
  });

  it("有一个 Approval 已经不在 READY_FOR_REVIEW，整批回滚", async () => {
    const f = seedBatch(["deepseek", "codex"]);
    f.db.prepare("UPDATE approvals SET state = 'CANCELLED' WHERE id = ?").run(f.items[1]!.approvalId);

    await assert.rejects(
      () =>
        approveBatch(f.db, f.queue, {
          batchId: f.batchId,
          items: f.items.map((item) => ({ approvalId: item.approvalId, expectedContentHash: item.contentHash })),
          via: "desktop",
        }),
      (error: unknown) => error instanceof BatchApproveError && error.code === "approval_not_ready",
    );

    // 第一个已经 APPROVED 的也必须滚回去
    assert.equal(count(f.db, "SELECT count(*) AS n FROM approvals WHERE state = 'APPROVED'"), 0);
    assert.equal(count(f.db, "SELECT count(*) AS n FROM runs"), 0);
    f.db.close();
  });

  it("重复盖章被拒（批次已经不是 READY_FOR_REVIEW）", async () => {
    const f = seedBatch(["deepseek"]);
    const items = f.items.map((item) => ({ approvalId: item.approvalId, expectedContentHash: item.contentHash }));
    await approveBatch(f.db, f.queue, { batchId: f.batchId, items, via: "desktop" });

    await assert.rejects(
      () => approveBatch(f.db, f.queue, { batchId: f.batchId, items, via: "desktop" }),
      (error: unknown) => error instanceof BatchApproveError && error.code === "batch_not_ready",
    );
    assert.equal(count(f.db, "SELECT count(*) AS n FROM runs"), 1);
    f.db.close();
  });
});
