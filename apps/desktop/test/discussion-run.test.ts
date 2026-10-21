import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { AgentAdapter } from "@room/core";
import { approveAndCreateRun, openDatabase, ulid, WriteQueue } from "@room/db";
import type { RunRow, SqliteDatabase } from "@room/db";
import type { AgentEvent } from "@room/schemas";
import { RunOrchestrator } from "../src/main/orchestrator";
import { Repository } from "../src/main/repository";

/**
 * D-22 接线（PR A）：讨论室的 Run 结束时**落 Turn 的结局**，而不是写 reviewer_output。
 *
 * 覆盖画布 0-B 里和「一次发言怎么结束」有关的五种：
 * 答完 / 失败原因透传 / 额度缺席 / 完成但没正文 / 汇总。
 *
 * 为什么不塞进 orchestrator.test.ts：那里的用例是 Phase 0 的评审 Run；
 * 讨论室的 Run 有自己的收尾路径（finishTurnFromRun / finishSummaryFromRun），单独一个文件更方便对照 0-B。
 */

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

const event = (runId: string, seq: number, rest: Record<string, unknown>): AgentEvent =>
  ({ eventId: "adapter-" + seq, runId, seq, ts: new Date().toISOString(), ...rest }) as AgentEvent;

function fakeAdapter(run: AgentAdapter["run"]): AgentAdapter {
  return {
    id: "fake",
    kind: "api",
    initialize: async () => ({ streaming: true, permissionRequests: false, readOnly: true }),
    startSession: async () => ({ sessionId: "sess_1", adapterId: "fake" }),
    closeSession: async () => undefined,
    run,
  };
}

/** 和 orchestrator.test.ts 的 setup() 一样：议题 + 原文 + Contribution + Snapshot + Approval + Run */
async function setup() {
  const d = mkdtempSync(join(tmpdir(), "room-discussion-run-"));
  dirs.push(d);
  const db = openDatabase(join(d, "test.db"));
  const queue = new WriteQueue();
  const repo = new Repository(db, queue);

  const project = await repo.createProject("p");
  const message = await repo.addSource(project.id, "deepseek", "abcdef");
  const contribution = await repo.createContribution({
    projectId: project.id,
    sourceMessageId: message.id,
    contributionType: "issue",
    title: "t",
    selection: { start: 0, end: 3 },
  });
  const { snapshot, approval } = await repo.createSnapshot({
    projectId: project.id,
    contributionIds: [contribution.id],
    taskInstruction: "看看",
    reviewerAgent: "claude-review",
  });
  const approved = await approveAndCreateRun(db, queue, {
    approvalId: approval.id,
    expectedSnapshotHash: snapshot.contentHash,
    adapterId: "fake",
  });

  return {
    db,
    queue,
    run: approved.run,
    input: {
      snapshotId: snapshot.id,
      content: snapshot.content,
      contentHash: snapshot.contentHash,
      reviewerAgent: snapshot.reviewerAgent,
    },
  };
}

interface DiscussionFixture {
  db: SqliteDatabase;
  queue: WriteQueue;
  run: RunRow;
  input: { snapshotId: string; content: string; contentHash: string; reviewerAgent: string };
  roundId: string;
  turnId: string;
  isSummary: boolean;
}

/**
 * 在 setup() 之上补讨论室的 round / batch / turn。
 *
 * Turn 复用 setup 那个 Run 的 approval_id 和 run_id：finishTurnFromRun 是按 run_id 找 Turn 的，
 * 而 Run 的创建路径（runs 的 trigger 要求 Approval 已经 APPROVED）交给 approveAndCreateRun，
 * 这样不用关外键、也不用手写一条假的 Run。
 */
async function discussionFixture(options: { isSummary?: boolean } = {}): Promise<DiscussionFixture> {
  const base = await setup();
  const isSummary = options.isSummary ?? false;
  const agent = isSummary ? "claude" : "deepseek";
  const roundId = "rnd_" + ulid();
  const batchId = "bat_" + ulid();
  const turnId = "turn_" + ulid();
  const createdAt = new Date().toISOString();
  const roundState = isSummary ? "SUMMARIZING" : "RUNNING";

  base.db
    .prepare(
      "INSERT INTO rounds (id, project_id, round_index, state, task, task_source, recipients, history_mode, created_at) " +
        "VALUES (?, ?, 1, ?, '本轮任务', 'human', ?, 'recent_with_summaries', ?)",
    )
    .run(roundId, base.run.project_id, roundState, JSON.stringify([agent]), createdAt);
  base.db
    .prepare("INSERT INTO batches (id, project_id, round_id, kind, state, created_at) VALUES (?, ?, ?, ?, 'APPROVED', ?)")
    .run(batchId, base.run.project_id, roundId, isSummary ? "summary" : "initial", createdAt);
  base.db
    .prepare(
      "INSERT INTO turns (id, round_id, batch_id, agent, is_summary, approval_id, run_id, outcome, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?)",
    )
    .run(turnId, roundId, batchId, agent, isSummary ? 1 : 0, base.run.approval_id, base.run.id, createdAt);

  return { ...base, roundId, turnId, isSummary };
}

/** 用假适配器按脚本吐事件（推送的事件这一片不验，PR B 才接讨论室的事件） */
async function runTurn(f: DiscussionFixture, script: Record<string, unknown>[]): Promise<void> {
  const orchestrator = new RunOrchestrator({
    db: f.db,
    queue: f.queue,
    emit: () => undefined,
    getRun: (id) => f.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as never,
    adapterFactory: async () =>
      fakeAdapter(async function* (_sessionId, runId) {
        let seq = 0;
        for (const part of script) yield event(runId, seq++, part);
      }),
  });

  await orchestrator.start(f.run, { ...f.input, discussion: { turnId: f.turnId, isSummary: f.isSummary } });
}

const count = (db: SqliteDatabase, sql: string): number => (db.prepare(sql).get() as { n: number }).n;

function turnRow(db: SqliteDatabase, turnId: string) {
  return db.prepare("SELECT outcome, reply_message_id, finished_at FROM turns WHERE id = ?").get(turnId) as {
    outcome: string;
    reply_message_id: string | null;
    finished_at: string | null;
  };
}

function runRow(db: SqliteDatabase, runId: string) {
  return db.prepare("SELECT state, failure_reason FROM runs WHERE id = ?").get(runId) as {
    state: string;
    failure_reason: string | null;
  };
}

function roundState(db: SqliteDatabase, roundId: string): string {
  return (db.prepare("SELECT state FROM rounds WHERE id = ?").get(roundId) as { state: string }).state;
}

describe("讨论室的 Run 结束 → Turn 的结局（0-B）", () => {
  it("答完：Turn answered + 一条 agent_reply，不写 reviewer_output，轮进待汇总", async () => {
    const f = await discussionFixture();

    await runTurn(f, [
      { type: "message_complete", text: "你好" },
      { type: "completed" },
    ]);

    const turn = turnRow(f.db, f.turnId);
    assert.equal(turn.outcome, "answered");
    assert.ok(turn.reply_message_id, "answered 必须带正式回答");
    assert.ok(turn.finished_at);

    const messages = f.db
      .prepare("SELECT kind, source_agent, content, round_id, turn_id FROM messages WHERE kind IN ('agent_reply', 'reviewer_output')")
      .all() as { kind: string; source_agent: string; content: string; round_id: string; turn_id: string }[];
    assert.equal(messages.length, 1, "讨论室只写一条 agent_reply");
    assert.equal(messages[0]!.kind, "agent_reply");
    assert.equal(messages[0]!.content, "你好");
    assert.equal(messages[0]!.source_agent, "deepseek");
    assert.equal(messages[0]!.round_id, f.roundId);
    assert.equal(messages[0]!.turn_id, f.turnId);
    assert.equal(count(f.db, "SELECT count(*) AS n FROM messages WHERE kind = 'reviewer_output'"), 0);

    assert.equal(roundState(f.db, f.roundId), "AWAITING_SUMMARY");
    assert.equal(runRow(f.db, f.run.id).state, "COMPLETED");
    // 每个 Run 恰好一个终止事件
    assert.equal(count(f.db, "SELECT count(*) AS n FROM run_events WHERE type IN ('completed','error','cancelled','timed_out')"), 1);
    f.db.close();
  });

  it("失败原因原样透传：process_exit_nonzero 不被压成 internal", async () => {
    const f = await discussionFixture();

    await runTurn(f, [{ type: "error", reason: "process_exit_nonzero", message: "exit 1" }]);

    assert.equal(turnRow(f.db, f.turnId).outcome, "failed");
    const run = runRow(f.db, f.run.id);
    assert.equal(run.state, "FAILED");
    assert.equal(run.failure_reason, "process_exit_nonzero");
    assert.equal(count(f.db, "SELECT count(*) AS n FROM messages WHERE kind IN ('agent_reply', 'reviewer_output')"), 0);
    // 唯一的 Turn 已经有结局，轮同样进待汇总
    assert.equal(roundState(f.db, f.roundId), "AWAITING_SUMMARY");
    assert.equal(
      (f.db.prepare("SELECT type FROM run_events WHERE type IN ('completed','error','cancelled','timed_out')").get() as { type: string }).type,
      "error",
    );
    f.db.close();
  });

  it("额度缺席：Turn absent_quota，Run FAILED(quota_exhausted)", async () => {
    const f = await discussionFixture();

    await runTurn(f, [{ type: "error", reason: "quota_exhausted" }]);

    assert.equal(turnRow(f.db, f.turnId).outcome, "absent_quota");
    const run = runRow(f.db, f.run.id);
    assert.equal(run.state, "FAILED");
    assert.equal(run.failure_reason, "quota_exhausted");
    assert.equal(count(f.db, "SELECT count(*) AS n FROM messages WHERE kind IN ('agent_reply', 'reviewer_output')"), 0);
    assert.equal(roundState(f.db, f.roundId), "AWAITING_SUMMARY");
    f.db.close();
  });

  it("完成但没正文：Turn failed，Run FAILED(incomplete_output)", async () => {
    const f = await discussionFixture();

    // 只完成、没有 message_complete：不能记成「答了但内容为空」
    await runTurn(f, [{ type: "completed" }]);

    assert.equal(turnRow(f.db, f.turnId).outcome, "failed");
    const run = runRow(f.db, f.run.id);
    assert.equal(run.state, "FAILED");
    assert.equal(run.failure_reason, "incomplete_output");
    assert.equal(count(f.db, "SELECT count(*) AS n FROM messages WHERE kind IN ('agent_reply', 'reviewer_output')"), 0);
    assert.equal(roundState(f.db, f.roundId), "AWAITING_SUMMARY");
    f.db.close();
  });

  it("汇总：summary 消息 + RoundSummary，轮变已汇总", async () => {
    const f = await discussionFixture({ isSummary: true });

    await runTurn(f, [
      { type: "message_complete", text: "汇总全文" },
      { type: "completed" },
    ]);

    const messages = f.db.prepare("SELECT id, kind, source_agent, content, turn_id FROM messages WHERE kind IN ('agent_reply', 'summary')").all() as {
      id: string;
      kind: string;
      source_agent: string;
      content: string;
      turn_id: string;
    }[];
    assert.equal(messages.length, 1, "汇总只写一条 summary 消息");
    assert.equal(messages[0]!.kind, "summary");
    assert.equal(messages[0]!.content, "汇总全文");
    assert.equal(messages[0]!.source_agent, "claude");
    assert.equal(messages[0]!.turn_id, f.turnId);

    const summary = f.db
      .prepare("SELECT message_id, summarizer, answered, expected FROM round_summaries WHERE round_id = ?")
      .get(f.roundId) as { message_id: string; summarizer: string; answered: number; expected: number };
    assert.equal(summary.message_id, messages[0]!.id);
    assert.equal(summary.summarizer, "claude");
    assert.equal(summary.answered, 0, "这一轮没有普通发言，按人算 answered = 0");
    assert.equal(summary.expected, 1);

    assert.equal(roundState(f.db, f.roundId), "SUMMARIZED");
    assert.equal(turnRow(f.db, f.turnId).outcome, "answered");
    assert.equal(runRow(f.db, f.run.id).state, "COMPLETED");
    f.db.close();
  });
});
