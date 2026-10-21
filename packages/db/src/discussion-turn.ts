import { createHash } from "node:crypto";
import type { FailureReason, TurnOutcome } from "@room/schemas";
import type { SqliteDatabase } from "./database";
import { appendRunEventTx } from "./run-lifecycle";
import { writeTransaction, type WriteQueue } from "./write-queue";

/**
 * 讨论室第三片（D-21 / 0-B 第 2、3、5、7、8 行）：Run 的终态怎么落到 Turn 上。
 *
 * 一条铁律：**Run 的终态、Turn 的结局、正式回答（agent_reply）在同一个事务里写**。
 * 否则会出现「Run 完成了但没有回答」或者「有回答但 Run 还没完成」这种半截状态。
 */

/** 从契约推导，别手写枚举（手写就会和 FailureReason / TurnOutcome 漂移） */
export type TurnFailureReason = FailureReason;

/** Turn 的终态结局：契约里除了 pending / running / rejected 之外的那些 */
export type TurnOutcomeTerminal = Exclude<TurnOutcome, "pending" | "running" | "rejected">;

export type FinishTurnTerminal =
  | { kind: "answered"; text: string }
  | { kind: "failed"; failureReason: TurnFailureReason; partialText?: string | null }
  /** kind 是 AgentEvent.timed_out 的必填字段（idle / total 超时） */
  | { kind: "timed_out"; timeoutKind: "idle" | "total"; partialText?: string | null }
  | { kind: "paused" | "round_ended" | "interrupted"; partialText?: string | null };

export interface FinishTurnInput {
  runId: string;
  terminal: FinishTurnTerminal;
  /** 所有 Turn 都有结局时，自动把这一轮推到待汇总（0-B 第 2 行）。默认开 */
  autoAdvanceRound?: boolean;
}

export interface FinishTurnResult {
  turnId: string;
  roundId: string;
  outcome: TurnOutcomeTerminal;
  messageId: string | null;
  roundState: string;
}

export type TurnErrorCode =
  | "turn_not_found"
  | "turn_not_running"
  | "run_not_active"
  | "round_not_active"
  | "batch_not_ready"
  | "summary_not_supported";

export class TurnError extends Error {
  readonly code: TurnErrorCode;
  constructor(code: TurnErrorCode, message: string) {
    super(message);
    this.name = "TurnError";
    this.code = code;
  }
}

const now = (): string => new Date().toISOString();

interface TurnRow {
  id: string;
  round_id: string;
  batch_id: string;
  agent: string;
  on_behalf_of: string | null;
  is_summary: number;
  run_id: string | null;
  outcome: string;
}

interface RunRow {
  id: string;
  state: string;
}

function loadTurnByRun(db: SqliteDatabase, runId: string): TurnRow {
  const turn = db
    .prepare("SELECT id, round_id, batch_id, agent, on_behalf_of, is_summary, run_id, outcome FROM turns WHERE run_id = ?")
    .get(runId) as TurnRow | undefined;
  if (turn === undefined) throw new TurnError("turn_not_found", "no turn for run " + runId);
  if (turn.outcome !== "running") throw new TurnError("turn_not_running", "turn is " + turn.outcome);
  return turn;
}

/** 把 Run 推到终态并写唯一的终止事件（CAS：状态已经被别人改过就整体失败） */
function finishRunTx(
  db: SqliteDatabase,
  run: RunRow,
  target: { state: "COMPLETED" | "FAILED" | "CANCELLED" | "TIMED_OUT"; failureReason: string | null },
  event: { type: "completed" | "error" | "cancelled" | "timed_out"; payload: Record<string, unknown> },
  ts: string,
): void {
  const changed = db
    .prepare(
      "UPDATE runs SET state = ?, failure_reason = ?, finished_at = ?, substate = NULL " +
        "WHERE id = ? AND state IN ('QUEUED', 'STARTING', 'RUNNING')",
    )
    .run(target.state, target.failureReason, ts, run.id);
  if (changed.changes !== 1) throw new TurnError("run_not_active", "run " + run.id + " is not active");
  appendRunEventTx(db, run.id, { type: event.type, payload: event.payload, ts }, { allowTerminal: true });
}

/** 所有 Turn 都有结局时，把 RUNNING 的轮推到待汇总 */
function advanceRoundIfIdle(db: SqliteDatabase, roundId: string, ts: string): string {
  const live = db
    .prepare("SELECT count(*) AS n FROM turns WHERE round_id = ? AND outcome IN ('pending', 'running')")
    .get(roundId) as { n: number };
  const round = db.prepare("SELECT state FROM rounds WHERE id = ?").get(roundId) as { state: string } | undefined;
  if (round === undefined) return "unknown";
  if (live.n > 0) return round.state;
  if (round.state !== "RUNNING") return round.state;

  db.prepare("UPDATE rounds SET state = 'AWAITING_SUMMARY', finished_at = ? WHERE id = ? AND state = 'RUNNING'").run(ts, roundId);
  return "AWAITING_SUMMARY";
}

/**
 * 一次发言的结束。按 Run 的终态决定 Turn 的结局：
 * - answered      → Run COMPLETED，写 agent_reply（同一个事务）
 * - failed        → Run FAILED(reason)；quota_exhausted 记成 absent_quota（0-B 第 7 行），其余记 failed
 * - timed_out     → Run TIMED_OUT
 * - paused / round_ended / interrupted → Run CANCELLED，已写部分留在 partial_text
 */
export function finishTurnFromRun(
  db: SqliteDatabase,
  queue: WriteQueue,
  input: FinishTurnInput,
): Promise<FinishTurnResult> {
  return writeTransaction(db, queue, () => {
    const turn = loadTurnByRun(db, input.runId);
    // 汇总的写入（summary 消息 + RoundSummary）在第四片单独做，这里先拒绝，避免写出半截
    if (turn.is_summary === 1) {
      throw new TurnError("summary_not_supported", "summary turns are handled in a later slice");
    }
    const run = db.prepare("SELECT id, state FROM runs WHERE id = ?").get(input.runId) as RunRow | undefined;
    if (run === undefined) throw new TurnError("turn_not_found", "run not found");
    if (["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"].includes(run.state)) {
      throw new TurnError("run_not_active", "run " + run.id + " is already " + run.state);
    }

    const ts = now();
    const terminal = input.terminal;
    let outcome: TurnOutcomeTerminal;
    let messageId: string | null = null;

    if (terminal.kind === "answered") {
      outcome = "answered";
      finishRunTx(db, run, { state: "COMPLETED", failureReason: null }, { type: "completed", payload: { outcome: "completed" } }, ts);

      messageId = "msg_" + turn.id.slice(5);
      db.prepare(
        "INSERT INTO messages (id, project_id, kind, source_agent, run_id, round_id, turn_id, on_behalf_of, content, created_at) " +
          "SELECT ?, project_id, 'agent_reply', ?, ?, ?, ?, ?, ?, ? FROM rounds WHERE id = ?",
      ).run(
        messageId,
        turn.agent,
        input.runId,
        turn.round_id,
        turn.id,
        turn.on_behalf_of,
        terminal.text,
        ts,
        turn.round_id,
      );

      const updated = db
        .prepare("UPDATE turns SET outcome = 'answered', reply_message_id = ?, finished_at = ? WHERE id = ? AND outcome = 'running'")
        .run(messageId, ts, turn.id);
      if (updated.changes !== 1) throw new TurnError("turn_not_running", "turn changed concurrently");
    } else if (terminal.kind === "failed") {
      outcome = terminal.failureReason === "quota_exhausted" ? "absent_quota" : "failed";
      finishRunTx(
        db,
        run,
        { state: "FAILED", failureReason: terminal.failureReason },
        { type: "error", payload: { reason: terminal.failureReason } },
        ts,
      );
      setTurnOutcome(db, turn.id, outcome, terminal.partialText ?? null, ts);
    } else if (terminal.kind === "timed_out") {
      outcome = "timed_out";
      finishRunTx(
        db,
        run,
        { state: "TIMED_OUT", failureReason: null },
        { type: "timed_out", payload: { kind: terminal.timeoutKind } },
        ts,
      );
      setTurnOutcome(db, turn.id, outcome, terminal.partialText ?? null, ts);
    } else {
      outcome = terminal.kind;
      finishRunTx(db, run, { state: "CANCELLED", failureReason: null }, { type: "cancelled", payload: { reason: terminal.kind } }, ts);
      setTurnOutcome(db, turn.id, outcome, terminal.partialText ?? null, ts);
    }

    const roundState =
      input.autoAdvanceRound === false ? currentRoundState(db, turn.round_id) : advanceRoundIfIdle(db, turn.round_id, ts);

    return { turnId: turn.id, roundId: turn.round_id, outcome, messageId, roundState };
  });
}

function currentRoundState(db: SqliteDatabase, roundId: string): string {
  const row = db.prepare("SELECT state FROM rounds WHERE id = ?").get(roundId) as { state: string } | undefined;
  return row?.state ?? "unknown";
}

function setTurnOutcome(db: SqliteDatabase, turnId: string, outcome: string, partialText: string | null, ts: string): void {
  const updated = db
    .prepare("UPDATE turns SET outcome = ?, partial_text = ?, finished_at = ? WHERE id = ? AND outcome = 'running'")
    .run(outcome, partialText, ts, turnId);
  if (updated.changes !== 1) throw new TurnError("turn_not_running", "turn changed concurrently");
}

/**
 * 盖章被拒（0-B 补充规则）：只作废这一批——批次 `REJECTED`、成员 Approval `REJECTED`、
 * 这一批的 `pending` Turn 记 `rejected`，**Round 状态不动**。
 */
export function rejectBatch(db: SqliteDatabase, queue: WriteQueue, batchId: string): Promise<{ batchId: string }> {
  return writeTransaction(db, queue, () => {
    const batch = db.prepare("SELECT id, state FROM batches WHERE id = ?").get(batchId) as
      | { id: string; state: string }
      | undefined;
    if (batch === undefined) throw new TurnError("batch_not_ready", "batch not found");
    if (batch.state !== "READY_FOR_REVIEW") throw new TurnError("batch_not_ready", "batch is " + batch.state);

    const ts = now();
    db.prepare("UPDATE batches SET state = 'REJECTED', decided_at = ? WHERE id = ? AND state = 'READY_FOR_REVIEW'").run(ts, batchId);
    db.prepare(
      "UPDATE approvals SET state = 'REJECTED', decided_at = ? WHERE state = 'READY_FOR_REVIEW' AND id IN " +
        "(SELECT approval_id FROM batch_items WHERE batch_id = ?)",
    ).run(ts, batchId);
    db.prepare("UPDATE turns SET outcome = 'rejected', finished_at = ? WHERE batch_id = ? AND outcome = 'pending'").run(ts, batchId);
    return { batchId };
  });
}

export interface PauseRoundInput {
  roundId: string;
  /** 被打断的 Turn 已经写出来的部分，按 turnId 传进来 */
  partialText?: Readonly<Record<string, string>>;
}

/**
 * 全部暂停（0-B 第 5 行）：正在答的都按打断处理，轮变 `PAUSED`，**计时停**。
 * 计时用 `rounds.active_ms` 累计：暂停时把这一段加进去，并把 `started_at` 清空；
 * 恢复时 approveBatch 会把 `started_at` 重新填上。
 */
export function pauseRound(
  db: SqliteDatabase,
  queue: WriteQueue,
  input: PauseRoundInput,
): Promise<{ paused: number; cancelledBatches: number }> {
  return writeTransaction(db, queue, () => {
    const round = db.prepare("SELECT id, state, started_at, active_ms FROM rounds WHERE id = ?").get(input.roundId) as
      | { id: string; state: string; started_at: string | null; active_ms: number }
      | undefined;
    if (round === undefined) throw new TurnError("round_not_active", "round not found");
    if (round.state !== "RUNNING") throw new TurnError("round_not_active", "round is " + round.state);

    const ts = now();
    const paused = cancelRunningTurns(db, round.id, "paused", input.partialText ?? {}, ts);
    // 暂停之后这一轮不能还留着"待盖章"的批次：用户再点一次就会把暂停的轮又拉回 RUNNING
    const cancelledBatches = cancelOpenBatchesTx(db, round.id, ts);

    const elapsed = round.started_at === null ? 0 : Math.max(0, Date.parse(ts) - Date.parse(round.started_at));
    db.prepare("UPDATE rounds SET state = 'PAUSED', started_at = NULL, active_ms = ? WHERE id = ? AND state = 'RUNNING'").run(
      round.active_ms + elapsed,
      round.id,
    );
    return { paused, cancelledBatches };
  });
}

/**
 * 结束本轮（0-B 第 3 行）：没答完的标 `round_ended`（已写部分保留），轮直接进待汇总。
 */
export function endRound(
  db: SqliteDatabase,
  queue: WriteQueue,
  input: PauseRoundInput,
): Promise<{ ended: number; cancelledBatches: number }> {
  return writeTransaction(db, queue, () => {
    const round = db.prepare("SELECT id, state, started_at, active_ms FROM rounds WHERE id = ?").get(input.roundId) as
      | { id: string; state: string; started_at: string | null; active_ms: number }
      | undefined;
    if (round === undefined) throw new TurnError("round_not_active", "round not found");
    if (round.state !== "RUNNING" && round.state !== "PAUSED") {
      throw new TurnError("round_not_active", "round is " + round.state);
    }

    const ts = now();
    const ended = cancelRunningTurns(db, round.id, "round_ended", input.partialText ?? {}, ts);
    const cancelledBatches = cancelOpenBatchesTx(db, round.id, ts);
    const elapsed = round.started_at === null ? 0 : Math.max(0, Date.parse(ts) - Date.parse(round.started_at));

    db.prepare(
      "UPDATE rounds SET state = 'AWAITING_SUMMARY', started_at = NULL, finished_at = ?, active_ms = ? WHERE id = ? AND state = ?",
    ).run(ts, round.active_ms + elapsed, round.id, round.state);
    return { ended, cancelledBatches };
  });
}

/**
 * 作废这一轮还没盖章的批次（0-B 第 3/5 行的补充规则）：
 * 批次 `CANCELLED`、成员 Approval `CANCELLED`、对应的 `pending` Turn 记 `rejected`。
 *
 * 不这么做的话：暂停/结束本轮之后，用户手里那张"待盖章"的批次还能盖下去，
 * 一个 `resume` 就能把已经进汇总的轮又拉回 RUNNING。
 */
function cancelOpenBatchesTx(db: SqliteDatabase, roundId: string, ts: string): number {
  db.prepare(
    "UPDATE approvals SET state = 'CANCELLED', decided_at = ? WHERE state IN ('DRAFT', 'READY_FOR_REVIEW') AND id IN (" +
      "SELECT bi.approval_id FROM batch_items bi JOIN batches b ON b.id = bi.batch_id WHERE b.round_id = ?)",
  ).run(ts, roundId);

  const batches = db
    .prepare("UPDATE batches SET state = 'CANCELLED', decided_at = ? WHERE round_id = ? AND state IN ('DRAFT', 'READY_FOR_REVIEW')")
    .run(ts, roundId);

  db.prepare(
    "UPDATE turns SET outcome = 'rejected', finished_at = ? WHERE outcome = 'pending' AND batch_id IN (" +
      "SELECT id FROM batches WHERE round_id = ?)",
  ).run(ts, roundId);

  return batches.changes;
}

function cancelRunningTurns(
  db: SqliteDatabase,
  roundId: string,
  outcome: "paused" | "round_ended" | "interrupted",
  partials: Readonly<Record<string, string>>,
  ts: string = now(),
): number {
  const running = db
    .prepare("SELECT id, run_id FROM turns WHERE round_id = ? AND outcome = 'running'")
    .all(roundId) as { id: string; run_id: string | null }[];

  let count = 0;
  for (const turn of running) {
    if (turn.run_id !== null) {
      const changed = db
        .prepare(
          "UPDATE runs SET state = 'CANCELLED', finished_at = ?, substate = NULL WHERE id = ? AND state IN ('QUEUED', 'STARTING', 'RUNNING')",
        )
        .run(ts, turn.run_id);
      // 已经自己结束的 Run 不再写事件；Turn 仍然要落到结局
      if (changed.changes === 1) {
        appendRunEventTx(db, turn.run_id, { type: "cancelled", payload: { reason: outcome }, ts }, { allowTerminal: true });
      }
    }
    setTurnOutcomeLoose(db, turn.id, outcome, partials[turn.id] ?? null, ts);
    count += 1;
  }
  return count;
}

function setTurnOutcomeLoose(db: SqliteDatabase, turnId: string, outcome: string, partialText: string | null, ts: string): void {
  db.prepare("UPDATE turns SET outcome = ?, partial_text = ?, finished_at = ? WHERE id = ? AND outcome = 'running'").run(
    outcome,
    partialText,
    ts,
    turnId,
  );
}
export type FinishSummaryResult =
  | {
      kind: "answered";
      text: string;
      /** 结构化汇总；解析不出来就传 null（0-B 第 11 行允许只有全文） */
      report?: unknown;
      /** 顺带产生的方案草稿；不传就不建版本 */
      plan?: { content: string; changeNote: string };
    }
  | { kind: "failed"; failureReason: TurnFailureReason }
  | { kind: "timed_out"; timeoutKind: "idle" | "total" };

export interface FinishSummaryInput {
  runId: string;
  result: FinishSummaryResult;
}

export interface FinishSummaryOutput {
  turnId: string;
  roundId: string;
  /** 只有成功的汇总才有消息 */
  messageId: string | null;
  roundSummaryId: string | null;
  planVersionId: string | null;
  roundState: string;
}

/**
 * 汇总者的一次发言（0-B 第 11 行）。
 *
 * 成功：`summary` 消息 + `round_summaries` +（可选）方案草稿，轮 `SUMMARIZING → SUMMARIZED`。
 * 失败（失败 / 超时 / 额度缺席）：轮退回 `AWAITING_SUMMARY`，可以换人或重试。
 *
 * 三样记录和 Run 终态在同一个事务里写。
 */
export function finishSummaryFromRun(
  db: SqliteDatabase,
  queue: WriteQueue,
  input: FinishSummaryInput,
): Promise<FinishSummaryOutput> {
  return writeTransaction(db, queue, () => {
    const turn = loadTurnByRun(db, input.runId);
    if (turn.is_summary !== 1) throw new TurnError("summary_not_supported", "turn is not a summary turn");
    const run = db.prepare("SELECT id, state FROM runs WHERE id = ?").get(input.runId) as RunRow | undefined;
    if (run === undefined) throw new TurnError("turn_not_found", "run not found");
    if (["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"].includes(run.state)) {
      throw new TurnError("run_not_active", "run " + run.id + " is already " + run.state);
    }

    // 汇总只能在 SUMMARIZING 的轮上发生；否则说明这一轮已经被结束 / 作废 / 已经汇总过
    const round = db.prepare("SELECT state FROM rounds WHERE id = ?").get(turn.round_id) as { state: string } | undefined;
    if (round === undefined || round.state !== "SUMMARIZING") {
      throw new TurnError("round_not_active", "round is " + (round?.state ?? "missing"));
    }

    const ts = now();
    const result = input.result;

    if (result.kind !== "answered") {
      const quota = result.kind === "failed" && result.failureReason === "quota_exhausted";
      const outcome: TurnOutcome = quota ? "absent_quota" : result.kind === "timed_out" ? "timed_out" : "failed";
      if (result.kind === "timed_out") {
        finishRunTx(db, run, { state: "TIMED_OUT", failureReason: null }, { type: "timed_out", payload: { kind: result.timeoutKind } }, ts);
      } else {
        finishRunTx(
          db,
          run,
          { state: "FAILED", failureReason: result.failureReason },
          { type: "error", payload: { reason: result.failureReason } },
          ts,
        );
      }
      setTurnOutcome(db, turn.id, outcome, null, ts);
      // 汇总失败 -> 退回待汇总（CAS：轮已经被别人改过就整体失败，不能悄悄吞掉）
      const moved = db
        .prepare("UPDATE rounds SET state = 'AWAITING_SUMMARY' WHERE id = ? AND state = 'SUMMARIZING'")
        .run(turn.round_id);
      if (moved.changes !== 1) throw new TurnError("round_not_active", "round changed concurrently");
      return {
        turnId: turn.id,
        roundId: turn.round_id,
        messageId: null,
        roundSummaryId: null,
        planVersionId: null,
        roundState: currentRoundState(db, turn.round_id),
      };
    }

    finishRunTx(db, run, { state: "COMPLETED", failureReason: null }, { type: "completed", payload: { outcome: "completed" } }, ts);

    const messageId = "msg_" + turn.id.slice(5);
    db.prepare(
      "INSERT INTO messages (id, project_id, kind, source_agent, run_id, round_id, turn_id, on_behalf_of, content, created_at) " +
        "SELECT ?, project_id, 'summary', ?, ?, ?, ?, NULL, ?, ? FROM rounds WHERE id = ?",
    ).run(messageId, turn.agent, input.runId, turn.round_id, turn.id, result.text, ts, turn.round_id);

    // 按"人"算，不按 Turn 算：
    // - 同一个人被打断后重答，只取最新一次
    // - 替补代答（on_behalf_of 非空）不等于原来那个人答了
    const answered = db
      .prepare(
        // 先过滤再取最新一条：替补代答的 Turn、待盖章 / 被拒的 Turn 不该参与"谁答了"的判定
        "SELECT count(*) AS n FROM (" +
          "SELECT agent, outcome, ROW_NUMBER() OVER (PARTITION BY agent ORDER BY created_at DESC, rowid DESC) AS rn " +
          "FROM turns WHERE round_id = ? AND is_summary = 0 " +
          "AND on_behalf_of IS NULL AND outcome NOT IN ('pending', 'rejected')" +
          ") WHERE rn = 1 AND outcome = 'answered'",
      )
      .get(turn.round_id) as { n: number };
    const expected = db
      .prepare("SELECT json_array_length(recipients) AS n FROM rounds WHERE id = ?")
      .get(turn.round_id) as { n: number };

    let planVersionId: string | null = null;
    if (result.plan !== undefined) {
      const latest = db
        .prepare("SELECT id, version FROM plan_versions WHERE project_id = (SELECT project_id FROM rounds WHERE id = ?) ORDER BY version DESC LIMIT 1")
        .get(turn.round_id) as { id: string; version: number } | undefined;
      planVersionId = "plan_" + turn.id.slice(5);
      const projectId = (db.prepare("SELECT project_id FROM rounds WHERE id = ?").get(turn.round_id) as { project_id: string })
        .project_id;
      db.prepare(
        "INSERT INTO plan_versions (id, project_id, version, state, content, content_hash, change_note, based_on_round_id, parent_id, drafted_by_kind, drafted_by_agent, created_at) " +
          "VALUES (?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?, 'agent', ?, ?)",
      ).run(
        planVersionId,
        projectId,
        (latest?.version ?? 0) + 1,
        result.plan.content,
        createHash("sha256").update(result.plan.content, "utf8").digest("hex"),
        result.plan.changeNote,
        turn.round_id,
        latest?.id ?? null,
        turn.agent,
        ts,
      );
    }

    const summaryId = "rsum_" + turn.id.slice(5);
    db.prepare(
      "INSERT INTO round_summaries (round_id, message_id, summarizer, answered, expected, report, plan_version_id, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      turn.round_id,
      messageId,
      turn.agent,
      answered.n,
      expected.n,
      result.report === undefined || result.report === null ? null : JSON.stringify(result.report),
      planVersionId,
      ts,
    );

    db.prepare("UPDATE turns SET outcome = 'answered', reply_message_id = ?, finished_at = ? WHERE id = ? AND outcome = 'running'").run(
      messageId,
      ts,
      turn.id,
    );
    db.prepare("UPDATE rounds SET state = 'SUMMARIZED', finished_at = ? WHERE id = ? AND state = 'SUMMARIZING'").run(ts, turn.round_id);

    return {
      turnId: turn.id,
      roundId: turn.round_id,
      messageId,
      roundSummaryId: summaryId,
      planVersionId,
      roundState: currentRoundState(db, turn.round_id),
    };
  });
}

/**
 * 打断后重发：把"这一轮里这个人上一次被打断的 Turn"和新 Turn 连起来（0-B 第 4 行）。
 * 只允许连同一轮的 Turn，避免连错。
 */
export async function linkSuperseded(
  db: SqliteDatabase,
  queue: WriteQueue,
  input: { previousTurnId: string; nextTurnId: string },
): Promise<void> {
  await writeTransaction(db, queue, () => {
    const previous = db.prepare("SELECT id, round_id, outcome, superseded_by FROM turns WHERE id = ?").get(input.previousTurnId) as
      | { id: string; round_id: string; outcome: string; superseded_by: string | null }
      | undefined;
    const next = db.prepare("SELECT id, round_id FROM turns WHERE id = ?").get(input.nextTurnId) as
      | { id: string; round_id: string }
      | undefined;
    if (previous === undefined || next === undefined) throw new TurnError("turn_not_found", "turn not found");
    if (previous.round_id !== next.round_id) throw new TurnError("turn_not_found", "turns belong to different rounds");
    if (previous.superseded_by !== null) throw new TurnError("turn_not_running", "turn already superseded");
    if (previous.outcome !== "interrupted") throw new TurnError("turn_not_running", "previous turn is " + previous.outcome);

    db.prepare("UPDATE turns SET superseded_by = ? WHERE id = ?").run(next.id, previous.id);
  });
}
