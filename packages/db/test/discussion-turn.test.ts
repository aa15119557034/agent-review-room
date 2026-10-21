import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  approveBatch,
  createDraftTurns,
  endRound,
  finishTurnFromRun,
  openDatabase,
  pauseRound,
  rejectBatch,
  TurnError,
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

interface Fx {
  db: SqliteDatabase;
  queue: WriteQueue;
  roundId: string;
  batchId: string;
  runIds: Record<string, string>;
  turnIds: Record<string, string>;
}

/** 起草 + 盖章：拿到 N 个 running 的 Turn 和对应的 Run */
async function seedApproved(recipients: string[]): Promise<Fx> {
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
    "INSERT INTO batches (id, project_id, round_id, kind, state, created_at) VALUES (?, ?, ?, 'initial', 'READY_FOR_REVIEW', ?)",
  ).run(batchId, projectId, roundId, NOW);

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

const count = (db: SqliteDatabase, sql: string): number => (db.prepare(sql).get() as { n: number }).n;

describe("finishTurnFromRun：Run 终态 → Turn 结局", () => {
  it("答完：Run COMPLETED，写一条 agent_reply，Turn answered，终止事件恰好一个", async () => {
    const f = await seedApproved(["deepseek"]);
    const runId = f.runIds["deepseek"]!;

    const result = await finishTurnFromRun(f.db, f.queue, { runId, terminal: { kind: "answered", text: "我的回答" } });

    assert.equal(result.outcome, "answered");
    assert.equal(
      (f.db.prepare("SELECT state FROM runs WHERE id = ?").get(runId) as { state: string }).state,
      "COMPLETED",
    );
    const message = f.db.prepare("SELECT kind, source_agent, round_id, turn_id, content FROM messages WHERE id = ?").get(result.messageId!) as {
      kind: string;
      source_agent: string;
      round_id: string;
      turn_id: string;
      content: string;
    };
    assert.equal(message.kind, "agent_reply");
    assert.equal(message.source_agent, "deepseek");
    assert.equal(message.round_id, f.roundId);
    assert.equal(message.content, "我的回答");
    assert.equal(count(f.db, "SELECT count(*) AS n FROM run_events WHERE type = 'completed'"), 1);
    assert.equal(count(f.db, "SELECT count(*) AS n FROM run_events WHERE type IN ('completed','error','cancelled','timed_out')"), 1);
    f.db.close();
  });

  it("最后一个 Turn 答完，轮自动进待汇总（0-B 第 2 行）", async () => {
    const f = await seedApproved(["deepseek", "codex"]);
    const first = await finishTurnFromRun(f.db, f.queue, {
      runId: f.runIds["codex"]!,
      terminal: { kind: "answered", text: "A" },
    });
    assert.equal(first.roundState, "RUNNING");

    const last = await finishTurnFromRun(f.db, f.queue, {
      runId: f.runIds["deepseek"]!,
      terminal: { kind: "answered", text: "B" },
    });
    assert.equal(last.roundState, "AWAITING_SUMMARY");
    f.db.close();
  });

  it("额度用尽：Run FAILED(quota_exhausted)，Turn absent_quota，不写回答", async () => {
    const f = await seedApproved(["deepseek", "codex"]);
    const result = await finishTurnFromRun(f.db, f.queue, {
      runId: f.runIds["deepseek"]!,
      terminal: { kind: "failed", failureReason: "quota_exhausted" },
    });

    assert.equal(result.outcome, "absent_quota");
    const run = f.db.prepare("SELECT state, failure_reason FROM runs WHERE id = ?").get(f.runIds["deepseek"]!) as {
      state: string;
      failure_reason: string;
    };
    assert.equal(run.state, "FAILED");
    assert.equal(run.failure_reason, "quota_exhausted");
    assert.equal(count(f.db, "SELECT count(*) AS n FROM messages"), 0);
    // 其他人还在跑，轮不推进
    assert.equal(result.roundState, "RUNNING");
    f.db.close();
  });

  it("超时：Run TIMED_OUT，Turn timed_out", async () => {
    const f = await seedApproved(["deepseek"]);
    const result = await finishTurnFromRun(f.db, f.queue, {
      runId: f.runIds["deepseek"]!,
      terminal: { kind: "timed_out", partialText: "写到一半" },
    });
    assert.equal(result.outcome, "timed_out");
    assert.equal(
      (f.db.prepare("SELECT state FROM runs WHERE id = ?").get(f.runIds["deepseek"]!) as { state: string }).state,
      "TIMED_OUT",
    );
    f.db.close();
  });

  it("同一个 Run 结束两次会被拒（防止重复终止事件）", async () => {
    const f = await seedApproved(["deepseek"]);
    const runId = f.runIds["deepseek"]!;
    await finishTurnFromRun(f.db, f.queue, { runId, terminal: { kind: "answered", text: "x" } });

    await assert.rejects(
      () => finishTurnFromRun(f.db, f.queue, { runId, terminal: { kind: "answered", text: "y" } }),
      (error: unknown) => error instanceof TurnError && (error.code === "turn_not_running" || error.code === "run_not_active"),
    );
    assert.equal(count(f.db, "SELECT count(*) AS n FROM run_events WHERE type = 'completed'"), 1);
    f.db.close();
  });
});

describe("暂停与结束本轮", () => {
  it("全部暂停：Run CANCELLED、Turn paused、已写部分保留、计时累加", async () => {
    const f = await seedApproved(["deepseek", "codex"]);
    f.db.prepare("UPDATE rounds SET started_at = ? WHERE id = ?").run(new Date(Date.now() - 5000).toISOString(), f.roundId);

    const partials = { [f.turnIds["deepseek"]!]: "写到一半" };
    const result = await pauseRound(f.db, f.queue, { roundId: f.roundId, partialText: partials });

    assert.equal(result.paused, 2);
    const round = f.db.prepare("SELECT state, started_at, active_ms FROM rounds WHERE id = ?").get(f.roundId) as {
      state: string;
      started_at: string | null;
      active_ms: number;
    };
    assert.equal(round.state, "PAUSED");
    assert.equal(round.started_at, null);
    assert.ok(round.active_ms >= 5000, "active_ms 应该累加已进行的时长");
    assert.equal(count(f.db, "SELECT count(*) AS n FROM runs WHERE state = 'CANCELLED'"), 2);
    assert.equal(count(f.db, "SELECT count(*) AS n FROM turns WHERE outcome = 'paused'"), 2);
    assert.equal(
      (f.db.prepare("SELECT partial_text FROM turns WHERE id = ?").get(f.turnIds["deepseek"]!) as { partial_text: string })
        .partial_text,
      "写到一半",
    );
    // 每个 Run 一个终止事件
    assert.equal(count(f.db, "SELECT count(*) AS n FROM run_events WHERE type = 'cancelled'"), 2);
    f.db.close();
  });

  it("结束本轮：没答完的标 round_ended，轮进待汇总", async () => {
    const f = await seedApproved(["deepseek", "codex"]);
    // 一个人先答完
    await finishTurnFromRun(f.db, f.queue, { runId: f.runIds["codex"]!, terminal: { kind: "answered", text: "A" } });

    const result = await endRound(f.db, f.queue, { roundId: f.roundId });
    assert.equal(result.ended, 1);
    assert.equal(
      (f.db.prepare("SELECT state FROM rounds WHERE id = ?").get(f.roundId) as { state: string }).state,
      "AWAITING_SUMMARY",
    );
    assert.equal(count(f.db, "SELECT count(*) AS n FROM turns WHERE outcome = 'round_ended'"), 1);
    f.db.close();
  });

  it("没在跑的轮不能暂停", async () => {
    const f = await seedApproved(["deepseek"]);
    await endRound(f.db, f.queue, { roundId: f.roundId });
    await assert.rejects(
      () => pauseRound(f.db, f.queue, { roundId: f.roundId }),
      (error: unknown) => error instanceof TurnError && error.code === "round_not_active",
    );
    f.db.close();
  });
});

describe("rejectBatch：只作废这一批", () => {
  it("批次 REJECTED、成员 Approval REJECTED、pending Turn rejected，Round 不动", async () => {
    const dir = mkdtempSync(join(tmpdir(), "room-db-d21c-rej-"));
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
    ).run(roundId, projectId, '["deepseek"]', NOW);
    db.prepare("INSERT INTO batches (id, project_id, round_id, kind, state, created_at) VALUES (?, ?, ?, 'initial', 'READY_FOR_REVIEW', ?)").run(
      batchId,
      projectId,
      roundId,
      NOW,
    );
    const content = "prompt";
    const snapshotId = "snap_" + ulid();
    const approvalId = "apr_" + ulid();
    db.prepare(
      "INSERT INTO prompt_snapshots (id, project_id, content, content_hash, nonce, contribution_ids, task_instruction, " +
        "reviewer_agent, adapter_version, token_estimate, created_at) VALUES (?, ?, ?, ?, '0123456789abcdef', '[]', '任务', 'deepseek', 'prompt-v3', 10, ?)",
    ).run(snapshotId, projectId, content, sha(content), NOW);
    db.prepare("INSERT INTO approvals (id, project_id, snapshot_id, state, created_at) VALUES (?, ?, ?, 'READY_FOR_REVIEW', ?)").run(
      approvalId,
      projectId,
      snapshotId,
      NOW,
    );
    db.prepare(
      "INSERT INTO batch_items (batch_id, recipient, approval_id, snapshot_id, content_hash, token_estimate) VALUES (?, 'deepseek', ?, ?, ?, 10)",
    ).run(batchId, approvalId, snapshotId, sha(content));
    await createDraftTurns(db, queue, batchId);

    await rejectBatch(db, queue, batchId);

    assert.equal((db.prepare("SELECT state FROM batches WHERE id = ?").get(batchId) as { state: string }).state, "REJECTED");
    assert.equal((db.prepare("SELECT state FROM approvals WHERE id = ?").get(approvalId) as { state: string }).state, "REJECTED");
    assert.equal(count(db, "SELECT count(*) AS n FROM turns WHERE outcome = 'rejected'"), 1);
    // Round 状态不动
    assert.equal((db.prepare("SELECT state FROM rounds WHERE id = ?").get(roundId) as { state: string }).state, "DRAFT");
    assert.equal(count(db, "SELECT count(*) AS n FROM runs"), 0);

    await assert.rejects(
      () => rejectBatch(db, queue, batchId),
      (error: unknown) => error instanceof TurnError && error.code === "batch_not_ready",
    );
    db.close();
  });
});
