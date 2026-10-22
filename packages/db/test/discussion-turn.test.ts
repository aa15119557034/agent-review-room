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
  voidRound,
  finishSummaryFromRun,
  linkSuperseded,
  rejectBatch,
  TurnError,
  ulid,
  WriteQueue,
} from "../src/index";
import { AgentEvent } from "@room/schemas";
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
      terminal: { kind: "timed_out", timeoutKind: "idle", partialText: "写到一半" },
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

/** 造一张"已起草、等盖章"的批次（用来验证暂停/结束本轮会把它作废） */
function addPendingBatch(f: Fx, recipients: string[], kind = "supplement"): { batchId: string; approvalIds: string[]; turnIds: string[] } {
  const projectId = (f.db.prepare("SELECT project_id FROM rounds WHERE id = ?").get(f.roundId) as { project_id: string }).project_id;
  const batchId = "bat_" + ulid();
  f.db.prepare("INSERT INTO batches (id, project_id, round_id, kind, state, created_at) VALUES (?, ?, ?, ?, 'READY_FOR_REVIEW', ?)").run(
    batchId,
    projectId,
    f.roundId,
    kind,
    NOW,
  );

  const approvalIds: string[] = [];
  for (const recipient of recipients) {
    const content = "补充给 " + recipient;
    const contentHash = sha(content);
    const snapshotId = "snap_" + ulid();
    const approvalId = "apr_" + ulid();
    f.db.prepare(
      "INSERT INTO prompt_snapshots (id, project_id, content, content_hash, nonce, contribution_ids, task_instruction, " +
        "reviewer_agent, adapter_version, token_estimate, created_at) VALUES (?, ?, ?, ?, '0123456789abcdef', '[]', '任务', ?, 'prompt-v3', 10, ?)",
    ).run(snapshotId, projectId, content, contentHash, recipient, NOW);
    f.db.prepare("INSERT INTO approvals (id, project_id, snapshot_id, state, created_at) VALUES (?, ?, ?, 'READY_FOR_REVIEW', ?)").run(
      approvalId,
      projectId,
      snapshotId,
      NOW,
    );
    f.db.prepare(
      "INSERT INTO batch_items (batch_id, recipient, approval_id, snapshot_id, content_hash, token_estimate) VALUES (?, ?, ?, ?, ?, 10)",
    ).run(batchId, recipient, approvalId, snapshotId, contentHash);
    approvalIds.push(approvalId);
  }

  // 起草（这里直接插 pending Turn，避免再跑一次 createDraftTurns 的异步）
  const turnIds: string[] = [];
  const rows = f.db.prepare("SELECT recipient, approval_id FROM batch_items WHERE batch_id = ?").all(batchId) as {
    recipient: string;
    approval_id: string;
  }[];
  for (const row of rows) {
    const turnId = "turn_" + ulid();
    f.db
      .prepare(
        "INSERT INTO turns (id, round_id, batch_id, agent, is_summary, approval_id, run_id, outcome, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, NULL, 'pending', ?)",
      )
      .run(turnId, f.roundId, batchId, row.recipient, kind === "summary" ? 1 : 0, row.approval_id, NOW);
    turnIds.push(turnId);
  }
  return { batchId, approvalIds, turnIds };
}

describe("终止事件与契约一致", () => {
  it("四种终止事件的 payload 都能被 AgentEvent 解析", async () => {
    const cases: { terminal: unknown; expect: string }[] = [
      { terminal: { kind: "answered", text: "x" }, expect: "completed" },
      { terminal: { kind: "failed", failureReason: "internal" }, expect: "error" },
      { terminal: { kind: "timed_out", timeoutKind: "total" }, expect: "timed_out" },
      { terminal: { kind: "paused" }, expect: "cancelled" },
    ];

    for (const item of cases) {
      const f = await seedApproved(["deepseek"]);
      await finishTurnFromRun(f.db, f.queue, { runId: f.runIds["deepseek"]!, terminal: item.terminal as never });
      const row = f.db
        .prepare("SELECT type, payload FROM run_events WHERE type IN ('completed','error','cancelled','timed_out')")
        .get() as { type: string; payload: string };
      assert.equal(row.type, item.expect);
      const parsed = AgentEvent.parse(JSON.parse(row.payload));
      assert.equal(parsed.type, item.expect);
      if (parsed.type === "timed_out") assert.equal(parsed.kind, "total");
      f.db.close();
    }
  });

  it("汇总的 Turn 先拒绝（第四片再做）", async () => {
    const f = await seedApproved(["claude"]);
    f.db.prepare("UPDATE turns SET is_summary = 1 WHERE id = ?").run(f.turnIds["claude"]!);

    await assert.rejects(
      () => finishTurnFromRun(f.db, f.queue, { runId: f.runIds["claude"]!, terminal: { kind: "answered", text: "汇总" } }),
      (error: unknown) => error instanceof TurnError && error.code === "summary_not_supported",
    );
    assert.equal(count(f.db, "SELECT count(*) AS n FROM messages"), 0);
    f.db.close();
  });
});

describe("暂停 / 结束本轮会作废待盖章的批次", () => {
  it("结束本轮：批次 CANCELLED、Approval CANCELLED、pending Turn rejected", async () => {
    const f = await seedApproved(["deepseek"]);
    const pending = addPendingBatch(f, ["deepseek"]);

    const result = await endRound(f.db, f.queue, { roundId: f.roundId });
    assert.equal(result.cancelledBatches, 1);
    assert.equal((f.db.prepare("SELECT state FROM batches WHERE id = ?").get(pending.batchId) as { state: string }).state, "CANCELLED");
    assert.equal(
      (f.db.prepare("SELECT state FROM approvals WHERE id = ?").get(pending.approvalIds[0]!) as { state: string }).state,
      "CANCELLED",
    );
    assert.equal(
      (f.db.prepare("SELECT outcome FROM turns WHERE id = ?").get(pending.turnIds[0]!) as { outcome: string }).outcome,
      "rejected",
    );
    f.db.close();
  });

  it("暂停：同样作废待盖章批次（否则一次 resume 就能把轮拉回 RUNNING）", async () => {
    const f = await seedApproved(["deepseek"]);
    const pending = addPendingBatch(f, ["codex"]);

    const result = await pauseRound(f.db, f.queue, { roundId: f.roundId });
    assert.equal(result.cancelledBatches, 1);
    assert.equal((f.db.prepare("SELECT state FROM batches WHERE id = ?").get(pending.batchId) as { state: string }).state, "CANCELLED");
    assert.equal(count(f.db, "SELECT count(*) AS n FROM turns WHERE outcome = 'rejected'"), 1);
    f.db.close();
  });
});

describe("finishSummaryFromRun：汇总写入（0-B 第 11 行）", () => {
  it("成功：summary 消息 + round_summaries + 方案草稿，轮变已汇总", async () => {
    const f = await seedApproved(["claude"], "summary");
    const runId = f.runIds["claude"]!;

    const out = await finishSummaryFromRun(f.db, f.queue, {
      runId,
      result: {
        kind: "answered",
        text: "汇总全文",
        report: { points: [], risks: ["r1"], gaps: [], alternatives: [], extraInfoNotes: [] },
        plan: { content: "# 方案 v1", changeNote: "+1 条" },
      },
    });

    assert.equal(out.roundState, "SUMMARIZED");
    assert.ok(out.planVersionId);

    const message = f.db.prepare("SELECT kind, source_agent FROM messages WHERE id = ?").get(out.messageId) as {
      kind: string;
      source_agent: string;
    };
    assert.equal(message.kind, "summary");
    assert.equal(message.source_agent, "claude");

    const summary = f.db
      .prepare("SELECT summarizer, answered, expected, plan_version_id, report FROM round_summaries WHERE round_id = ?")
      .get(f.roundId) as { summarizer: string; answered: number; expected: number; plan_version_id: string; report: string };
    assert.equal(summary.summarizer, "claude");
    assert.equal(summary.expected, 1);
    assert.equal(summary.plan_version_id, out.planVersionId);
    assert.deepEqual(JSON.parse(summary.report).risks, ["r1"]);

    const plan = f.db.prepare("SELECT version, state, drafted_by_kind, based_on_round_id FROM plan_versions WHERE id = ?").get(out.planVersionId!) as {
      version: number;
      state: string;
      drafted_by_kind: string;
      based_on_round_id: string;
    };
    assert.equal(plan.version, 1);
    assert.equal(plan.state, "DRAFT");
    assert.equal(plan.drafted_by_kind, "agent");
    assert.equal(plan.based_on_round_id, f.roundId);
    f.db.close();
  });

  it("汇总者额度用尽：轮退回待汇总，Turn 记缺席", async () => {
    const f = await seedApproved(["claude"], "summary");
    const out = await finishSummaryFromRun(f.db, f.queue, {
      runId: f.runIds["claude"]!,
      result: { kind: "failed", failureReason: "quota_exhausted" },
    });

    assert.equal(out.roundState, "AWAITING_SUMMARY");
    assert.equal(count(f.db, "SELECT count(*) AS n FROM messages"), 0);
    assert.equal(count(f.db, "SELECT count(*) AS n FROM round_summaries"), 0);
    assert.equal(count(f.db, "SELECT count(*) AS n FROM turns WHERE outcome = 'absent_quota'"), 1);
    f.db.close();
  });

  it("不是汇总的 Turn 不能走汇总路径", async () => {
    const f = await seedApproved(["deepseek"]);
    await assert.rejects(
      () =>
        finishSummaryFromRun(f.db, f.queue, {
          runId: f.runIds["deepseek"]!,
          result: { kind: "answered", text: "x" },
        }),
      (error: unknown) => error instanceof TurnError && error.code === "summary_not_supported",
    );
    f.db.close();
  });
});

describe("linkSuperseded：打断后重发", () => {
  it("把被打断的 Turn 和新 Turn 连起来", async () => {
    const f = await seedApproved(["deepseek"]);
    await finishTurnFromRun(f.db, f.queue, {
      runId: f.runIds["deepseek"]!,
      terminal: { kind: "interrupted", partialText: "前半段" },
    });

    // 再起草一张补充批次并盖章，得到同一轮里的新 Turn
    // addPendingBatch 已经建好 pending Turn，直接盖章
    const pending = addPendingBatch(f, ["deepseek"]);
    const approved = await approveBatch(f.db, f.queue, {
      batchId: pending.batchId,
      items: pending.approvalIds.map((id) => ({
        approvalId: id,
        expectedContentHash: (f.db.prepare("SELECT content_hash FROM batch_items WHERE approval_id = ?").get(id) as { content_hash: string })
          .content_hash,
      })),
      via: "desktop",
    });

    await linkSuperseded(f.db, f.queue, {
      previousTurnId: f.turnIds["deepseek"]!,
      nextTurnId: approved.turnIds[0]!,
    });

    const row = f.db.prepare("SELECT superseded_by FROM turns WHERE id = ?").get(f.turnIds["deepseek"]!) as {
      superseded_by: string;
    };
    assert.equal(row.superseded_by, approved.turnIds[0]);
    f.db.close();
  });
});

describe("汇总的 answered 按人算", () => {
  it("同一个人答两次只算一次（只取最新一次发言）", async () => {
    const f = await seedApproved(["deepseek"]);
    // 第一次回答
    await finishTurnFromRun(f.db, f.queue, { runId: f.runIds["deepseek"]!, terminal: { kind: "answered", text: "第一版" } });

    // 打断后重答：同一轮的第二次发言
    const pending = addPendingBatch(f, ["deepseek"]);
    const approved = await approveBatch(f.db, f.queue, {
      batchId: pending.batchId,
      items: pending.approvalIds.map((id) => ({
        approvalId: id,
        expectedContentHash: (f.db.prepare("SELECT content_hash FROM batch_items WHERE approval_id = ?").get(id) as { content_hash: string })
          .content_hash,
      })),
      via: "desktop",
    });
    await finishTurnFromRun(f.db, f.queue, { runId: approved.runIds[0]!, terminal: { kind: "answered", text: "第二版" } });

    // 再开一张 summary 批次
    const summaryBatch = addPendingBatch(f, ["claude"], "summary");
    const summaryApproved = await approveBatch(f.db, f.queue, {
      batchId: summaryBatch.batchId,
      items: summaryBatch.approvalIds.map((id) => ({
        approvalId: id,
        expectedContentHash: (f.db.prepare("SELECT content_hash FROM batch_items WHERE approval_id = ?").get(id) as { content_hash: string })
          .content_hash,
      })),
      via: "desktop",
    });
    const out = await finishSummaryFromRun(f.db, f.queue, {
      runId: summaryApproved.runIds[0]!,
      result: { kind: "answered", text: "汇总" },
    });

    const row = f.db.prepare("SELECT answered FROM round_summaries WHERE round_id = ?").get(f.roundId) as { answered: number };
    assert.equal(row.answered, 1, "同一个人两次发言只算一次");
    assert.ok(out.messageId);
    f.db.close();
  });

  it("这一轮不是 SUMMARIZING 时不能汇总", async () => {
    const f = await seedApproved(["claude"], "summary");
    // 把轮从 AWAITING_SUMMARY 强行留在 RUNNING，模拟"已经结束/改方向"的情况
    f.db.prepare("UPDATE rounds SET state = 'RUNNING' WHERE id = ?").run(f.roundId);

    await assert.rejects(
      () => finishSummaryFromRun(f.db, f.queue, { runId: f.runIds["claude"]!, result: { kind: "answered", text: "x" } }),
      (error: unknown) => error instanceof TurnError && error.code === "round_not_active",
    );
    f.db.close();
  });
});

describe("answered 的边界情况", () => {
  async function summaryWith(extraTurns: (f: Fx) => void): Promise<number> {
    const f = await seedApproved(["deepseek"]);
    await finishTurnFromRun(f.db, f.queue, { runId: f.runIds["deepseek"]!, terminal: { kind: "answered", text: "正式回答" } });
    extraTurns(f);

    const summaryBatch = addPendingBatch(f, ["claude"], "summary");
    const approved = await approveBatch(f.db, f.queue, {
      batchId: summaryBatch.batchId,
      items: summaryBatch.approvalIds.map((id) => ({
        approvalId: id,
        expectedContentHash: (f.db.prepare("SELECT content_hash FROM batch_items WHERE approval_id = ?").get(id) as { content_hash: string })
          .content_hash,
      })),
      via: "desktop",
    });
    await finishSummaryFromRun(f.db, f.queue, { runId: approved.runIds[0]!, result: { kind: "answered", text: "汇总" } });
    const row = f.db.prepare("SELECT answered FROM round_summaries WHERE round_id = ?").get(f.roundId) as { answered: number };
    f.db.close();
    return row.answered;
  }

  it("自己答了又替别人代答：代答那条不算他答了", async () => {
    const answered = await summaryWith((f) => {
      const other = addPendingBatch(f, ["deepseek"]);
      // 这条 Turn 是"代 codex 答"（失败了）。如果 on_behalf_of 过滤没生效，
      // 它就会成为 deepseek 的最新一条，answered 会变成 0。
      f.db
        .prepare("UPDATE turns SET on_behalf_of = 'codex', outcome = 'failed' WHERE id = ?")
        .run(other.turnIds[0]!);
    });
    assert.equal(answered, 1);
  });

  it("答完以后追问被拒：被拒的那条不影响他已经答过", async () => {
    const answered = await summaryWith((f) => {
      const retry = addPendingBatch(f, ["deepseek"]);
      f.db.prepare("UPDATE turns SET outcome = 'rejected' WHERE id = ?").run(retry.turnIds[0]!);
    });
    assert.equal(answered, 1);
  });
});

describe("voidRound：作废的轮也累计 active_ms", () => {
  it("作废时把正在跑的这段加进 active_ms，清空 started_at，记下原因", async () => {
    const f = await seedApproved(["deepseek"]);
    f.db
      .prepare("UPDATE rounds SET started_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 5000).toISOString(), f.roundId);

    const result = await voidRound(f.db, f.queue, { roundId: f.roundId, reason: "方向变了" });

    assert.equal(result.round.state, "VOIDED");
    assert.equal(result.round.void_reason, "方向变了");
    assert.equal(result.round.started_at, null);
    assert.ok(result.round.active_ms >= 5000, "作废前跑的那一段要累计进去");
    assert.equal(count(f.db, "SELECT count(*) AS n FROM turns WHERE outcome = 'round_ended'"), 1);
    f.db.close();
  });
});
