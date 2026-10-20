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
 * 四条硬约束：
 * 1. 批准 Approval 与创建 Run 在同一事务（approveAndCreateRun，AC-6）。
 * 2. 恰好一个终止事件（AC-9）：状态机和数据库的部分唯一索引各拦一层。
 * 3. 终止事件只能经 finishRun 写入；状态与事件在同一个事务里提交。
 * 4. 状态变更必须 CAS：UPDATE ... WHERE id = ? AND state = :from。
 *
 * 事务体一律抽成 *Tx 同步函数，供组合使用；对外 API 只是它们的队列包装。
 */

export class ApprovalNotConsumableError extends Error {
  readonly approvalId: string;
  readonly reason: "not_found" | "not_approved" | "project_mismatch";
  readonly actualState: string | undefined;

  constructor(approvalId: string, reason: "not_found" | "not_approved" | "project_mismatch", actualState?: string) {
    super("approval " + approvalId + " cannot start a run: " + reason + (actualState === undefined ? "" : " (state=" + actualState + ")"));
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

/** 批准时拿到的 hash 与库里 snapshot 的不一致（停留在旧页面）。 */
export class StaleSnapshotError extends Error {
  readonly approvalId: string;
  constructor(approvalId: string) {
    super("approval " + approvalId + ": snapshot hash does not match what the user approved");
    this.name = "StaleSnapshotError";
    this.approvalId = approvalId;
  }
}

/** 审批状态已经变了（别人先批/先拒）。 */
export class ApprovalDecisionConflictError extends Error {
  readonly approvalId: string;
  readonly actualState: string | null;
  constructor(approvalId: string, actualState: string | null) {
    super("approval " + approvalId + ": cannot decide, current state is " + (actualState ?? "missing"));
    this.name = "ApprovalDecisionConflictError";
    this.approvalId = approvalId;
    this.actualState = actualState;
  }
}

export interface ApprovalRow {
  id: string;
  project_id: string;
  snapshot_id: string;
  state: string;
  decided_via: string | null;
  reason: string | null;
  created_at: string;
  decided_at: string | null;
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

function readApproval(db: SqliteDatabase, approvalId: string): ApprovalRow | undefined {
  return db.prepare("SELECT * FROM approvals WHERE id = ?").get(approvalId) as ApprovalRow | undefined;
}

function insertRun(
  db: SqliteDatabase,
  runId: string,
  approval: { id: string; project_id: string; snapshot_id: string },
  adapterId: string,
  now: string,
): void {
  try {
    db.prepare(
      "INSERT INTO runs (id, project_id, approval_id, snapshot_id, adapter_id, state, created_at) " +
        "VALUES (?, ?, ?, ?, ?, 'QUEUED', ?)",
    ).run(runId, approval.project_id, approval.id, approval.snapshot_id, adapterId, now);
  } catch (error) {
    if (isUniqueViolation(error)) throw new ApprovalAlreadyConsumedError(approval.id);
    throw error;
  }
}

/** 从一个已批准的 Approval 创建 Run。保留给测试与迁移用；D-07 用 approveAndCreateRun。 */
export async function createRunFromApproval(
  db: SqliteDatabase,
  queue: WriteQueue,
  input: CreateRunInput,
): Promise<RunRow> {
  const now = input.now ?? new Date().toISOString();
  const runId = input.runId ?? "run_" + ulid();

  return writeTransaction(db, queue, () => {
    const approval = readApproval(db, input.approvalId);
    if (approval === undefined) throw new ApprovalNotConsumableError(input.approvalId, "not_found");
    if (approval.state !== "APPROVED") {
      throw new ApprovalNotConsumableError(input.approvalId, "not_approved", approval.state);
    }
    if (input.projectId !== undefined && input.projectId !== approval.project_id) {
      throw new ApprovalNotConsumableError(input.approvalId, "project_mismatch", approval.state);
    }

    insertRun(db, runId, approval, input.adapterId, now);
    return readRun(db, runId)!;
  });
}

export interface ApproveAndCreateRunInput {
  approvalId: string;
  /** 用户在界面上看到的 snapshot hash（AC-6 的防陈旧批准） */
  expectedSnapshotHash: string;
  adapterId: string;
  decidedVia?: "desktop" | "mobile" | null;
  runId?: string;
  now?: string;
}

/**
 * 批准并创建 Run —— 一个事务（AC-6）。
 *
 * 避免「Approval 卡在 APPROVED 但没有 Run」的死状态：要么都成功，要么都没发生。
 */
export async function approveAndCreateRun(
  db: SqliteDatabase,
  queue: WriteQueue,
  input: ApproveAndCreateRunInput,
): Promise<{ approval: ApprovalRow; run: RunRow }> {
  const now = input.now ?? new Date().toISOString();
  const runId = input.runId ?? "run_" + ulid();

  return writeTransaction(db, queue, () => {
    const approval = readApproval(db, input.approvalId);
    if (approval === undefined) throw new ApprovalNotConsumableError(input.approvalId, "not_found");

    const snapshot = db
      .prepare("SELECT content_hash FROM prompt_snapshots WHERE id = ?")
      .get(approval.snapshot_id) as { content_hash: string } | undefined;
    if (snapshot === undefined) throw new ApprovalNotConsumableError(input.approvalId, "not_found");
    if (snapshot.content_hash !== input.expectedSnapshotHash) {
      throw new StaleSnapshotError(input.approvalId);
    }

    const updated = db
      .prepare(
        "UPDATE approvals SET state = 'APPROVED', decided_via = ?, decided_at = ? " +
          "WHERE id = ? AND state = 'READY_FOR_REVIEW'",
      )
      .run(input.decidedVia ?? null, now, input.approvalId);

    if (updated.changes !== 1) {
      throw new ApprovalDecisionConflictError(input.approvalId, approval.state);
    }

    insertRun(db, runId, approval, input.adapterId, now);

    return { approval: readApproval(db, input.approvalId)!, run: readRun(db, runId)! };
  });
}

export interface RunPatch {
  substate?: RunSubstate | null;
  failureReason?: FailureReason | null;
  startedAt?: string | null;
  finishedAt?: string | null;
}

/** CAS 状态变更的同步事务体。调用方必须已经处在 writeTransaction 里。 */
export function transitionRunTx(
  db: SqliteDatabase,
  runId: string,
  from: RunState,
  to: RunState,
  patch: RunPatch = {},
): RunRow {
  assertTransition(RUN_TRANSITIONS, "run", from, to);

  if (patch.substate !== undefined && patch.substate !== null && !canHaveSubstate(to)) {
    throw new IllegalTransitionError("run", from, to);
  }
  if (patch.failureReason !== undefined && patch.failureReason !== null && !canHaveFailureReason(to)) {
    throw new IllegalTransitionError("run", from, to);
  }

  const sets: string[] = ["state = @to"];
  const params: Record<string, unknown> = { to, id: runId, from };

  // 离开 RUNNING 时 substate 必须清空，否则会撞上 CHECK (substate IS NULL OR state = RUNNING)
  const substate = patch.substate !== undefined ? patch.substate : (canHaveSubstate(to) ? undefined : null);
  if (substate !== undefined) {
    sets.push("substate = @substate");
    params["substate"] = substate;
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
}

/** 对外包装：排队 + 开事务。 */
export async function transitionRun(
  db: SqliteDatabase,
  queue: WriteQueue,
  runId: string,
  from: RunState,
  to: RunState,
  patch: RunPatch = {},
): Promise<RunRow> {
  return writeTransaction(db, queue, () => transitionRunTx(db, runId, from, to, patch));
}

export interface RunEventInput {
  type: string;
  payload?: unknown;
  eventId?: string;
  ts?: string;
}

export interface StoredEvent {
  seq: number;
  eventId: string;
  ts: string;
}

const TERMINAL_TYPES = new Set(["completed", "error", "cancelled", "timed_out"]);

/** 追加事件的同步事务体。seq / eventId 由数据库分配，调用方不得自己编。 */
export function appendRunEventTx(
  db: SqliteDatabase,
  runId: string,
  event: RunEventInput,
  options: { allowTerminal?: boolean } = {},
): StoredEvent {
  if (TERMINAL_TYPES.has(event.type) && options.allowTerminal !== true) {
    throw new Error("terminal event \"" + event.type + "\" must go through finishRun(), not appendRunEvent()");
  }

  const ts = event.ts ?? new Date().toISOString();
  const row = db
    .prepare("SELECT COALESCE(MAX(seq) + 1, 0) AS next FROM run_events WHERE run_id = ?")
    .get(runId) as { next: number };
  const seq = row.next;
  const eventId = event.eventId ?? runId + "_" + seq;

  // payload 里也写入数据库分配的 id / seq / ts：否则库里有「两套 id」，
  // 回放时要靠上层覆盖，容易漏。这里就让它自洽。
  const base =
    event.payload !== null && typeof event.payload === "object"
      ? (event.payload as Record<string, unknown>)
      : {};
  const payload = { ...base, eventId, runId, seq, ts, type: event.type };

  db.prepare(
    "INSERT INTO run_events (run_id, seq, event_id, type, payload, ts) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(runId, seq, eventId, event.type, JSON.stringify(payload), ts);

  return { seq, eventId, ts };
}

/** 对外包装。终止类型会被拒绝（见模块头部的约定 3）。 */
export async function appendRunEvent(
  db: SqliteDatabase,
  queue: WriteQueue,
  runId: string,
  event: RunEventInput,
): Promise<StoredEvent> {
  return writeTransaction(db, queue, () => appendRunEventTx(db, runId, event));
}

export type TerminalType = "completed" | "error" | "cancelled" | "timed_out";

const TERMINAL_TO_STATE: Record<TerminalType, RunState> = {
  completed: "COMPLETED",
  error: "FAILED",
  cancelled: "CANCELLED",
  timed_out: "TIMED_OUT",
};

/** Reviewer 的正式结论（只会在 completed 时写入）。 */
export interface ReviewOutput {
  /** 原样保存 message_complete.text */
  readonly content: string;
  /** snapshot 的 reviewerAgent */
  readonly sourceAgent: string;
  readonly messageId?: string;
}

export interface ReviewMessageRow {
  id: string;
  projectId: string;
  runId: string;
  sourceAgent: string;
  content: string;
  createdAt: string;
}

export interface FinishRunInput {
  from: RunState;
  terminal: {
    type: TerminalType;
    reason?: FailureReason;
    message?: string;
    kind?: "idle" | "total";
  };
  /**
   * 仅当 terminal.type === "completed" 时写入 Message(reviewer_output)。
   * 和终态在**同一个事务**里，保证「COMPLETED」和「结果已入库」绑在一起。
   * error / cancelled / timed_out 一律忽略（被截断的结果不能当正式结论）。
   */
  reviewerOutput?: ReviewOutput;
  now?: string;
}

export type FinishedRun = RunRow & { message: ReviewMessageRow | null };

/**
 * 结束一个 Run：CAS 到终态 **和** 写终止事件在**同一个事务**里。
 * 任何一步失败整体回滚，所以不会出现「终态但没事件」或「有事件但状态没变」。
 */
export async function finishRun(
  db: SqliteDatabase,
  queue: WriteQueue,
  runId: string,
  input: FinishRunInput,
): Promise<FinishedRun> {
  const to = TERMINAL_TO_STATE[input.terminal.type];
  const now = input.now ?? new Date().toISOString();

  assertTransition(RUN_TRANSITIONS, "run", input.from, to);

  const payload: Record<string, unknown> = { type: input.terminal.type };
  if (input.terminal.reason !== undefined) payload["reason"] = input.terminal.reason;
  if (input.terminal.message !== undefined) payload["message"] = input.terminal.message;
  if (input.terminal.kind !== undefined) payload["kind"] = input.terminal.kind;

  return writeTransaction(db, queue, () => {
    transitionRunTx(db, runId, input.from, to, {
      substate: null,
      failureReason: input.terminal.type === "error" ? (input.terminal.reason ?? "internal") : null,
      finishedAt: now,
    });

    appendRunEventTx(db, runId, { type: input.terminal.type, ts: now, payload }, { allowTerminal: true });

    let message: ReviewMessageRow | null = null;
    if (input.terminal.type === "completed" && input.reviewerOutput !== undefined) {
      const run = readRun(db, runId)!;
      const messageId = input.reviewerOutput.messageId ?? "msg_" + ulid();
      const createdAt = now;

      db.prepare(
        "INSERT INTO messages (id, project_id, kind, source_agent, run_id, content, created_at) " +
          "VALUES (?, ?, 'reviewer_output', ?, ?, ?, ?)",
      ).run(messageId, run.project_id, input.reviewerOutput.sourceAgent, runId, input.reviewerOutput.content, createdAt);

      message = {
        id: messageId,
        projectId: run.project_id,
        runId,
        sourceAgent: input.reviewerOutput.sourceAgent,
        content: input.reviewerOutput.content,
        createdAt,
      };
    }

    return { ...readRun(db, runId)!, message };
  });
}

export interface RepairResult {
  repaired: RunRow[];
  appendedEvents: number;
}

/**
 * 启动修复（V0.4 §32 / §24）：STARTING / RUNNING / QUEUED 都标成 FAILED(interrupted)。
 * QUEUED 也要修——Phase 0 没有持久化派发队列，重启后没人会再启动它，用户重新批准即可。
 */
export async function repairInterruptedRuns(
  db: SqliteDatabase,
  queue: WriteQueue,
  now: string = new Date().toISOString(),
): Promise<RepairResult> {
  const stale = db
    .prepare("SELECT * FROM runs WHERE state IN ('QUEUED', 'STARTING', 'RUNNING')")
    .all() as RunRow[];

  const repaired: RunRow[] = [];
  let appendedEvents = 0;

  for (const run of stale) {
    const updated = await writeTransaction(db, queue, () => {
      const next = transitionRunTx(db, run.id, run.state, "FAILED", {
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
        appendRunEventTx(
          db,
          run.id,
          { type: "error", ts: now, payload: { type: "error", reason: "interrupted", message: "orchestrator restarted" } },
          { allowTerminal: true },
        );
        appendedEvents += 1;
      }

      return next;
    });

    repaired.push(updated);
  }

  return { repaired, appendedEvents };
}

/** 读一个 run 及其事件（C-05 的 runs.events 查询用）。 */
export function getRunWithEvents(
  db: SqliteDatabase,
  runId: string,
): { run: RunRow; events: { seq: number; eventId: string; type: string; payload: string; ts: string }[] } | undefined {
  const run = readRun(db, runId);
  if (run === undefined) return undefined;
  const events = db
    .prepare("SELECT seq, event_id AS eventId, type, payload, ts FROM run_events WHERE run_id = ? ORDER BY seq")
    .all(runId) as { seq: number; eventId: string; type: string; payload: string; ts: string }[];
  return { run, events };
}
