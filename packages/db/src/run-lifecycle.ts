import {
  assertTransition,
  canHaveFailureReason,
  canHaveSubstate,
  IllegalTransitionError,
} from "@room/core";
import { RUN_TRANSITIONS, type FailureReason, type RunState, type RunSubstate } from "@room/schemas";
import type { SqliteDatabase } from "./database";
import { ulid } from "./ulid";
import { type WriteQueue, writeTransaction } from "./write-queue";

/**
 * Run 生命周期（D-06）。
 *
 * 三条硬约束：
 * 1. 消费 Approval 与创建 Run 在同一事务（AC-6）。runs.approval_id 是 UNIQUE，
 *    所以「一个 Approval 最多一个 Run」由数据库兜底，而不是靠调用方自觉。
 * 2. 恰好一个终止事件（AC-9）：状态机保证终态不可再转，数据库的部分唯一索引
 *    再拦一层；两者都失败时整个事务回滚。
 * 3. 状态变更必须 CAS：UPDATE ... WHERE id = ? AND state = :from，
 *    影响行数不等于 1 就说明别人先改了，抛 RunStateConflictError。
 *
 * 所有写操作都走 WriteQueue + BEGIN IMMEDIATE（见 write-queue.ts）。
 */

export class ApprovalNotConsumableError extends Error {
  readonly approvalId: string;
  readonly reason: "not_found" | "not_approved" | "project_mismatch";
  readonly actualState: string | undefined;

  constructor(approvalId: string, reason: "not_found" | "not_approved" | "project_mismatch", actualState?: string) {
    super(
      "approval " + approvalId + " cannot start a run: " + reason +
        (actualState === undefined ? "" : " (state=" + actualState + ")"),
    );
    this.name = "ApprovalNotConsumableError";
    this.approvalId = approvalId;
    this.reason = reason;
    this.actualState = actualState;
  }
}

export class ApprovalAlreadyConsumedError extends Error {
  readonly approvalId: string;
  constructor(approvalId: string) {
    super("approval " + approvalId + " already has a run");
    this.name = "ApprovalAlreadyConsumedError";
    this.approvalId = approvalId;
  }
}

export class RunStateConflictError extends Error {
  readonly runId: string;
  readonly expected: RunState;
  readonly actual: string | null;
  constructor(runId: string, expected: RunState, actual: string | null) {
    super("run " + runId + ": expected state " + expected + ", found " + (actual === null ? "no row" : actual));
    this.name = "RunStateConflictError";
    this.runId = runId;
    this.expected = expected;
    this.actual = actual;
  }
}

export interface ApprovalRow {
  id: string;
  project_id: string;
  snapshot_id: string;
  state: string;
}

export interface RunRow {
  id: string;
  project_id: string;
  approval_id: string;
  snapshot_id: string;
  adapter_id: string;
  state: RunState;
  substate: RunSubstate | null;
  failure_reason: FailureReason | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface CreateRunInput {
  approvalId: string;
  adapterId: string;
  /** 不传就用 approval 的 project_id；传了就必须一致 */
  projectId?: string;
  runId?: string;
  now?: string;
}

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === "SQLITE_CONSTRAINT_UNIQUE" || code === "SQLITE_CONSTRAINT_PRIMARYKEY";
}

function readRun(db: SqliteDatabase, runId: string): RunRow | undefined {
  return db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as RunRow | undefined;
}

/** 从一个已批准的 Approval 创建 Run（AC-6）。同一事务里校验并插入。 */
export async function createRunFromApproval(
  db: SqliteDatabase,
  queue: WriteQueue,
  input: CreateRunInput,
): Promise<RunRow> {
  const now = input.now ?? new Date().toISOString();
  const runId = input.runId ?? "run_" + ulid();

  return writeTransaction(db, queue, () => {
    const approval = db
      .prepare("SELECT id, project_id, snapshot_id, state FROM approvals WHERE id = ?")
      .get(input.approvalId) as ApprovalRow | undefined;

    if (approval === undefined) throw new ApprovalNotConsumableError(input.approvalId, "not_found");
    if (approval.state !== "APPROVED") {
      throw new ApprovalNotConsumableError(input.approvalId, "not_approved", approval.state);
    }
    if (input.projectId !== undefined && input.projectId !== approval.project_id) {
      throw new ApprovalNotConsumableError(input.approvalId, "project_mismatch", approval.state);
    }

    try {
      db.prepare(
        "INSERT INTO runs (id, project_id, approval_id, snapshot_id, adapter_id, state, created_at) " +
          "VALUES (?, ?, ?, ?, ?, 'QUEUED', ?)",
      ).run(runId, approval.project_id, approval.id, approval.snapshot_id, input.adapterId, now);
    } catch (error) {
      if (isUniqueViolation(error)) throw new ApprovalAlreadyConsumedError(input.approvalId);
      throw error;
    }

    return readRun(db, runId)!;
  });
}

export interface RunPatch {
  substate?: RunSubstate | null;
  failureReason?: FailureReason | null;
  startedAt?: string | null;
  finishedAt?: string | null;
}

/** CAS 状态变更：只有当前状态确实是 from 才更新，否则抛 RunStateConflictError。 */
export async function transitionRun(
  db: SqliteDatabase,
  queue: WriteQueue,
  runId: string,
  from: RunState,
  to: RunState,
  patch: RunPatch = {},
): Promise<RunRow> {
  assertTransition(RUN_TRANSITIONS, "run", from, to);

  if (patch.substate !== undefined && patch.substate !== null && !canHaveSubstate(to)) {
    throw new IllegalTransitionError("run", from, to);
  }
  if (patch.failureReason !== undefined && patch.failureReason !== null && !canHaveFailureReason(to)) {
    throw new IllegalTransitionError("run", from, to);
  }

  return writeTransaction(db, queue, () => {
    const sets: string[] = ["state = @to"];
    const params: Record<string, unknown> = { to, id: runId, from };

    if (patch.substate !== undefined) {
      sets.push("substate = @substate");
      params["substate"] = patch.substate;
    }
    if (patch.failureReason !== undefined) {
      sets.push("failure_reason = @failureReason");
      params["failureReason"] = patch.failureReason;
    }
    if (patch.startedAt !== undefined) {
      sets.push("started_at = @startedAt");
      params["startedAt"] = patch.startedAt;
    }
    if (patch.finishedAt !== undefined) {
      sets.push("finished_at = @finishedAt");
      params["finishedAt"] = patch.finishedAt;
    }

    const result = db
      .prepare("UPDATE runs SET " + sets.join(", ") + " WHERE id = @id AND state = @from")
      .run(params);

    if (result.changes !== 1) {
      const current = readRun(db, runId);
      throw new RunStateConflictError(runId, from, current?.state ?? null);
    }

    return readRun(db, runId)!;
  });
}

export interface RunEventInput {
  type: string;
  payload?: unknown;
  eventId?: string;
  ts?: string;
}

/** 追加一条 run 事件。终止事件的唯一性由数据库索引兜底（AC-9）。 */
export async function appendRunEvent(
  db: SqliteDatabase,
  queue: WriteQueue,
  runId: string,
  event: RunEventInput,
): Promise<number> {
  const ts = event.ts ?? new Date().toISOString();

  return writeTransaction(db, queue, () => {
    const row = db
      .prepare("SELECT COALESCE(MAX(seq) + 1, 0) AS next FROM run_events WHERE run_id = ?")
      .get(runId) as { next: number };
    const seq = row.next;

    db.prepare(
      "INSERT INTO run_events (run_id, seq, event_id, type, payload, ts) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      runId,
      seq,
      event.eventId ?? runId + "_" + seq,
      event.type,
      JSON.stringify(event.payload ?? {}),
      ts,
    );

    return seq;
  });
}

export type TerminalType = "completed" | "error" | "cancelled" | "timed_out";

const TERMINAL_TO_STATE: Record<TerminalType, RunState> = {
  completed: "COMPLETED",
  error: "FAILED",
  cancelled: "CANCELLED",
  timed_out: "TIMED_OUT",
};

export interface FinishRunInput {
  from: RunState;
  terminal: {
    type: TerminalType;
    reason?: FailureReason;
    message?: string;
    kind?: "idle" | "total";
  };
  now?: string;
}

/** 结束一个 Run：CAS 到终态并追加终止事件，同一事务。 */
export async function finishRun(
  db: SqliteDatabase,
  queue: WriteQueue,
  runId: string,
  input: FinishRunInput,
): Promise<RunRow> {
  const to = TERMINAL_TO_STATE[input.terminal.type];
  const now = input.now ?? new Date().toISOString();

  assertTransition(RUN_TRANSITIONS, "run", input.from, to);

  await transitionRun(db, queue, runId, input.from, to, {
    substate: null,
    failureReason: input.terminal.type === "error" ? (input.terminal.reason ?? "internal") : null,
    finishedAt: now,
  });

  const payload: Record<string, unknown> = { type: input.terminal.type };
  if (input.terminal.reason !== undefined) payload["reason"] = input.terminal.reason;
  if (input.terminal.message !== undefined) payload["message"] = input.terminal.message;
  if (input.terminal.kind !== undefined) payload["kind"] = input.terminal.kind;

  await appendRunEvent(db, queue, runId, { type: input.terminal.type, ts: now, payload });

  return readRun(db, runId)!;
}

export interface RepairResult {
  repaired: RunRow[];
  appendedEvents: number;
}

/**
 * 启动修复（V0.4 §32 / §24）：把崩溃遗留的 STARTING / RUNNING 标成 FAILED(interrupted)，
 * 并保证每个被修复的 run 恰好有一条终止事件（AC-9）。
 */
export async function repairInterruptedRuns(
  db: SqliteDatabase,
  queue: WriteQueue,
  now: string = new Date().toISOString(),
): Promise<RepairResult> {
  const stale = db.prepare("SELECT * FROM runs WHERE state IN ('STARTING', 'RUNNING')").all() as RunRow[];

  const repaired: RunRow[] = [];
  let appendedEvents = 0;

  for (const run of stale) {
    const updated = await transitionRun(db, queue, run.id, run.state, "FAILED", {
      substate: null,
      failureReason: "interrupted",
      finishedAt: now,
    });

    const terminal = db
      .prepare(
        "SELECT 1 AS present FROM run_events WHERE run_id = ? " +
          "AND type IN ('completed', 'error', 'cancelled', 'timed_out') LIMIT 1",
      )
      .get(run.id) as { present: number } | undefined;

    if (terminal === undefined) {
      await appendRunEvent(db, queue, run.id, {
        type: "error",
        ts: now,
        payload: { type: "error", reason: "interrupted", message: "orchestrator restarted" },
      });
      appendedEvents += 1;
    }

    repaired.push(updated);
  }

  return { repaired, appendedEvents };
}

/** 读一个 run 及其事件（C-05 的 runs.events 查询用）。 */
export function getRunWithEvents(
  db: SqliteDatabase,
  runId: string,
): { run: RunRow; events: { seq: number; type: string; payload: string; ts: string }[] } | undefined {
  const run = readRun(db, runId);
  if (run === undefined) return undefined;
  const events = db
    .prepare("SELECT seq, type, payload, ts FROM run_events WHERE run_id = ? ORDER BY seq")
    .all(runId) as { seq: number; type: string; payload: string; ts: string }[];
  return { run, events };
}
