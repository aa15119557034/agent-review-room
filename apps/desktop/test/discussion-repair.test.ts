import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { approveBatch, createDraftTurns, finishTurnFromRun, openDatabase, repairInterruptedRuns, ulid, WriteQueue, type SqliteDatabase } from "@room/db";
import { repairInterruptedTurns } from "../src/main/discussion-repair";

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

interface Fx {
  db: SqliteDatabase;
  queue: WriteQueue;
  roundId: string;
  batchId: string;
  runIds: Record<string, string>;
  turnIds: Record<string, string>;
}

/** 起草 + 盖章：拿到 N 个 running 的 Turn 和对应的 Run */
async function seedApproved(recipients: string[], kind = "initial"): Promise<Fx> {
  const dir = mkdtempSync(join(tmpdir(), "room-db-d21c-"));
  dirs.push(dir);
  const db = openDatabase(join(dir, "test.db"));
  const queue = new WriteQueue();

  const projectId = "proj_" + ulid();
  const roundId = "rnd_" + ulid();
  const batchId = "bat_" + ulid();
  db.prepare("INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)").run(projectId, "议题", NOW);
  db.prepare(
    "INSERT INTO rounds (id, project_id, round_index, state, task, task_source, recipients, history_mode, created_at) " +
      "VALUES (?, ?, 1, 'DRAFT', '任务', 'human', ?, 'recent_with_summaries', ?)",
  ).run(roundId, projectId, JSON.stringify(recipients), NOW);
  db.prepare(
    "INSERT INTO batches (id, project_id, round_id, kind, state, created_at) VALUES (?, ?, ?, ?, 'READY_FOR_REVIEW', ?)",
  ).run(batchId, projectId, roundId, kind, NOW);
  if (kind === "summary") {
    db.prepare("UPDATE rounds SET state = 'AWAITING_SUMMARY' WHERE id = ?").run(roundId);
  }

  const items = recipients.map((recipient) => {
    const content = "发给 " + recipient + " 的 Prompt";
    const contentHash = sha(content);
    const snapshotId = "snap_" + ulid();
    const approvalId = "apr_" + ulid();
    db.prepare(
      "INSERT INTO prompt_snapshots (id, project_id, content, content_hash, nonce, contribution_ids, task_instruction, " +
        "reviewer_agent, adapter_version, token_estimate, created_at) VALUES (?, ?, ?, ?, '0123456789abcdef', '[]', '任务', ?, 'prompt-v3', 10, ?)",
    ).run(snapshotId, projectId, content, contentHash, recipient, NOW);
    db.prepare("INSERT INTO approvals (id, project_id, snapshot_id, state, created_at) VALUES (?, ?, ?, 'READY_FOR_REVIEW', ?)").run(
      approvalId,
      projectId,
      snapshotId,
      NOW,
    );
    db.prepare(
      "INSERT INTO batch_items (batch_id, recipient, approval_id, snapshot_id, content_hash, token_estimate) VALUES (?, ?, ?, ?, ?, 10)",
    ).run(batchId, recipient, approvalId, snapshotId, contentHash);
    return { recipient, approvalId, contentHash };
  });

  await createDraftTurns(db, queue, batchId);
  const approved = await approveBatch(db, queue, {
    batchId,
    items: items.map((i) => ({ approvalId: i.approvalId, expectedContentHash: i.contentHash })),
    via: "desktop",
  });

  const runIds: Record<string, string> = {};
  const turnIds: Record<string, string> = {};
  const rows = db.prepare("SELECT id, agent, run_id FROM turns ORDER BY agent").all() as { id: string; agent: string; run_id: string }[];
  for (const row of rows) {
    runIds[row.agent] = row.run_id;
    turnIds[row.agent] = row.id;
  }
  assert.equal(approved.runIds.length, recipients.length);
  return { db, queue, roundId, batchId, runIds, turnIds };
}

const one = <T,>(db: SqliteDatabase, sql: string, ...args: unknown[]): T => db.prepare(sql).get(...args) as T;

describe("启动修复：讨论室没答完的发言（D-05 / C-01）", () => {
  it("回答途中被关：Run、Turn 一起收尾成失败，轮推到待汇总；再跑通用修复不重复处理", async () => {
    const fx = await seedApproved(["claude", "deepseek"]);
    // claude 已经答完，deepseek 还在答的时候应用被杀
    await finishTurnFromRun(fx.db, fx.queue, { runId: fx.runIds.claude!, terminal: { kind: "answered", text: "答完了" } });

    assert.equal(await repairInterruptedTurns(fx.db, fx.queue), 1);

    assert.equal(one<{ outcome: string }>(fx.db, "SELECT outcome FROM turns WHERE id = ?", fx.turnIds.deepseek).outcome, "failed");
    assert.equal(one<{ outcome: string }>(fx.db, "SELECT outcome FROM turns WHERE id = ?", fx.turnIds.claude).outcome, "answered");
    const run = one<{ state: string; failure_reason: string }>(fx.db, "SELECT state, failure_reason FROM runs WHERE id = ?", fx.runIds.deepseek);
    assert.deepEqual({ ...run }, { state: "FAILED", failure_reason: "interrupted" });
    assert.equal(one<{ state: string }>(fx.db, "SELECT state FROM rounds WHERE id = ?", fx.roundId).state, "AWAITING_SUMMARY");
    // 终止事件只有一条
    assert.equal(
      one<{ n: number }>(fx.db, "SELECT count(*) AS n FROM run_events WHERE run_id = ? AND type IN ('completed','error','cancelled','timed_out')", fx.runIds.deepseek).n,
      1,
    );

    assert.equal((await repairInterruptedRuns(fx.db, fx.queue)).repaired.length, 0);
    assert.equal(await repairInterruptedTurns(fx.db, fx.queue), 0);
  });

  it("旧版本留下的半截数据：Run 已经是 FAILED 但 Turn 还挂着，也补上", async () => {
    const fx = await seedApproved(["claude"]);
    // 旧行为：只有通用修复跑过
    assert.equal((await repairInterruptedRuns(fx.db, fx.queue)).repaired.length, 1);
    assert.equal(one<{ outcome: string }>(fx.db, "SELECT outcome FROM turns WHERE id = ?", fx.turnIds.claude).outcome, "running");

    assert.equal(await repairInterruptedTurns(fx.db, fx.queue), 1);
    assert.equal(one<{ outcome: string }>(fx.db, "SELECT outcome FROM turns WHERE id = ?", fx.turnIds.claude).outcome, "failed");
    assert.equal(one<{ state: string }>(fx.db, "SELECT state FROM rounds WHERE id = ?", fx.roundId).state, "AWAITING_SUMMARY");
  });

  it("暂停中的轮不会被推进汇总：Turn 记失败，轮仍是 PAUSED（守住修复里的 state 条件）", async () => {
    const fx = await seedApproved(["claude"]);
    // 正常流程不会出现「PAUSED + running Turn」，这里人为造一份脏数据
    fx.db.prepare("UPDATE rounds SET state = 'PAUSED' WHERE id = ?").run(fx.roundId);

    assert.equal(await repairInterruptedTurns(fx.db, fx.queue), 1);
    assert.equal(one<{ outcome: string }>(fx.db, "SELECT outcome FROM turns WHERE id = ?", fx.turnIds.claude).outcome, "failed");
    assert.equal(one<{ state: string }>(fx.db, "SELECT state FROM rounds WHERE id = ?", fx.roundId).state, "PAUSED");
  });

  it("汇总途中被关：轮退回待汇总，可以重新请人汇总", async () => {
    const fx = await seedApproved(["claude"], "summary");
    assert.equal(one<{ state: string }>(fx.db, "SELECT state FROM rounds WHERE id = ?", fx.roundId).state, "SUMMARIZING");

    assert.equal(await repairInterruptedTurns(fx.db, fx.queue), 1);
    assert.equal(one<{ outcome: string }>(fx.db, "SELECT outcome FROM turns WHERE id = ?", fx.turnIds.claude).outcome, "failed");
    assert.equal(one<{ state: string }>(fx.db, "SELECT state FROM rounds WHERE id = ?", fx.roundId).state, "AWAITING_SUMMARY");
    assert.equal(one<{ state: string }>(fx.db, "SELECT state FROM runs WHERE id = ?", fx.runIds.claude).state, "FAILED");
  });
});
