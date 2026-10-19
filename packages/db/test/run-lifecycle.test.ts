import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { IllegalTransitionError } from "@room/core";
import { openDatabase, WriteQueue } from "../src/index";
import type { SqliteDatabase } from "../src/index";
import {
  appendRunEvent,
  ApprovalAlreadyConsumedError,
  ApprovalNotConsumableError,
  createRunFromApproval,
  finishRun,
  getRunWithEvents,
  repairInterruptedRuns,
  RunStateConflictError,
  transitionRun,
} from "../src/run-lifecycle";

const dirs: string[] = [];
const NOW = "2026-10-20T00:00:00.000Z";

function freshDb(): { db: SqliteDatabase; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "room-run-"));
  dirs.push(dir);
  const file = join(dir, "test.db");
  return { db: openDatabase(file), file };
}

after(() => {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // Windows 上句柄释放有延迟；测试目录留在 temp 里不影响结果
    }
  }
});

function count(db: SqliteDatabase, sql: string): number {
  return (db.prepare(sql).get() as { n: number }).n;
}

function seedWorld(db: SqliteDatabase, approvalState = "APPROVED", projectId = "proj_01") {
  db.prepare("INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)").run(projectId, "p", NOW);
  db.prepare(
    "INSERT INTO prompt_snapshots (id, project_id, content, content_hash, nonce, contribution_ids, " +
      "task_instruction, reviewer_agent, adapter_version, token_estimate, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    "snap_01", projectId, "body", "a".repeat(64), "0123456789abcdef",
    JSON.stringify(["c_01"]), "评审", "deepseek", "v1", 10, NOW,
  );
  db.prepare(
    "INSERT INTO approvals (id, project_id, snapshot_id, state, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run("appr_01", projectId, "snap_01", approvalState, NOW);
  return { projectId, snapshotId: "snap_01", approvalId: "appr_01" };
}

describe("createRunFromApproval (AC-6)", () => {
  it("creates a QUEUED run and copies the approved snapshot", async () => {
    const { db } = freshDb();
    const world = seedWorld(db);
    const queue = new WriteQueue();

    const run = await createRunFromApproval(db, queue, { approvalId: world.approvalId, adapterId: "api", now: NOW });

    assert.equal(run.state, "QUEUED");
    assert.equal(run.snapshot_id, world.snapshotId);
    assert.equal(run.approval_id, world.approvalId);
    assert.equal(run.project_id, world.projectId);
    assert.equal(run.adapter_id, "api");
    db.close();
  });

  it("refuses an approval that is not APPROVED", async () => {
    const { db } = freshDb();
    const world = seedWorld(db, "READY_FOR_REVIEW");
    const queue = new WriteQueue();

    await assert.rejects(
      createRunFromApproval(db, queue, { approvalId: world.approvalId, adapterId: "api" }),
      (error: unknown) => error instanceof ApprovalNotConsumableError && error.reason === "not_approved",
    );
    assert.equal(count(db, "SELECT count(*) AS n FROM runs"), 0);
    db.close();
  });

  it("refuses an unknown approval", async () => {
    const { db } = freshDb();
    seedWorld(db);
    const queue = new WriteQueue();

    await assert.rejects(
      createRunFromApproval(db, queue, { approvalId: "appr_missing", adapterId: "api" }),
      (error: unknown) => error instanceof ApprovalNotConsumableError && error.reason === "not_found",
    );
    db.close();
  });

  it("refuses a mismatched project", async () => {
    const { db } = freshDb();
    const world = seedWorld(db);
    const queue = new WriteQueue();

    await assert.rejects(
      createRunFromApproval(db, queue, { approvalId: world.approvalId, adapterId: "api", projectId: "proj_other" }),
      (error: unknown) => error instanceof ApprovalNotConsumableError && error.reason === "project_mismatch",
    );
    db.close();
  });

  it("allows only one run per approval", async () => {
    const { db } = freshDb();
    const world = seedWorld(db);
    const queue = new WriteQueue();

    await createRunFromApproval(db, queue, { approvalId: world.approvalId, adapterId: "api" });
    await assert.rejects(
      createRunFromApproval(db, queue, { approvalId: world.approvalId, adapterId: "api" }),
      ApprovalAlreadyConsumedError,
    );
    assert.equal(count(db, "SELECT count(*) AS n FROM runs"), 1);
    db.close();
  });
});

describe("CAS transitions", () => {
  async function seedRun(db: SqliteDatabase, queue: WriteQueue) {
    const world = seedWorld(db);
    return createRunFromApproval(db, queue, { approvalId: world.approvalId, adapterId: "api", now: NOW });
  }

  it("applies a legal transition", async () => {
    const { db } = freshDb();
    const queue = new WriteQueue();
    const run = await seedRun(db, queue);

    const started = await transitionRun(db, queue, run.id, "QUEUED", "STARTING", { startedAt: NOW });
    assert.equal(started.state, "STARTING");
    assert.equal(started.started_at, NOW);
    db.close();
  });

  it("rejects an illegal transition before touching the database", async () => {
    const { db } = freshDb();
    const queue = new WriteQueue();
    const run = await seedRun(db, queue);

    await assert.rejects(
      transitionRun(db, queue, run.id, "QUEUED", "COMPLETED"),
      IllegalTransitionError,
    );
    assert.equal(count(db, "SELECT count(*) AS n FROM runs WHERE state = 'QUEUED'"), 1);
    db.close();
  });

  it("rejects a stale transition with RunStateConflictError", async () => {
    const { db } = freshDb();
    const queue = new WriteQueue();
    const run = await seedRun(db, queue);

    await transitionRun(db, queue, run.id, "QUEUED", "STARTING");
    await assert.rejects(
      transitionRun(db, queue, run.id, "QUEUED", "STARTING"),
      (error: unknown) => error instanceof RunStateConflictError && error.actual === "STARTING",
    );
    db.close();
  });

  it("only allows substate while RUNNING", async () => {
    const { db } = freshDb();
    const queue = new WriteQueue();
    const run = await seedRun(db, queue);

    await assert.rejects(
      transitionRun(db, queue, run.id, "QUEUED", "STARTING", { substate: "active" }),
      IllegalTransitionError,
    );

    await transitionRun(db, queue, run.id, "QUEUED", "STARTING");
    const running = await transitionRun(db, queue, run.id, "STARTING", "RUNNING", { substate: "active" });
    assert.equal(running.substate, "active");
    db.close();
  });
});

describe("finishRun (AC-8 / AC-9)", () => {
  it("writes the terminal state and exactly one terminal event", async () => {
    const { db } = freshDb();
    const queue = new WriteQueue();
    const world = seedWorld(db);
    const run = await createRunFromApproval(db, queue, { approvalId: world.approvalId, adapterId: "api" });
    await transitionRun(db, queue, run.id, "QUEUED", "STARTING");
    await transitionRun(db, queue, run.id, "STARTING", "RUNNING");

    const finished = await finishRun(db, queue, run.id, { from: "RUNNING", terminal: { type: "completed" }, now: NOW });
    assert.equal(finished.state, "COMPLETED");
    assert.equal(finished.finished_at, NOW);

    const { events } = getRunWithEvents(db, run.id)!;
    assert.equal(events.length, 1);
    assert.equal(events[0]?.type, "completed");
    db.close();
  });

  it("records failure_reason only for error terminals", async () => {
    const { db } = freshDb();
    const queue = new WriteQueue();
    const world = seedWorld(db);
    const run = await createRunFromApproval(db, queue, { approvalId: world.approvalId, adapterId: "api" });
    await transitionRun(db, queue, run.id, "QUEUED", "STARTING");

    const finished = await finishRun(db, queue, run.id, {
      from: "STARTING",
      terminal: { type: "error", reason: "hash_mismatch", message: "hash" },
    });
    assert.equal(finished.state, "FAILED");
    assert.equal(finished.failure_reason, "hash_mismatch");
    db.close();
  });

  it("cannot finish twice", async () => {
    const { db } = freshDb();
    const queue = new WriteQueue();
    const world = seedWorld(db);
    const run = await createRunFromApproval(db, queue, { approvalId: world.approvalId, adapterId: "api" });
    await transitionRun(db, queue, run.id, "QUEUED", "STARTING");
    await transitionRun(db, queue, run.id, "STARTING", "RUNNING");
    await finishRun(db, queue, run.id, { from: "RUNNING", terminal: { type: "completed" } });

    // 终态不可再转，这是状态机给的第一个保证
    await assert.rejects(
      finishRun(db, queue, run.id, { from: "COMPLETED", terminal: { type: "error" } }),
      IllegalTransitionError,
    );
    assert.equal(count(db, "SELECT count(*) AS n FROM run_events"), 1);
    db.close();
  });

  it("rejects a second terminal event at the database level", async () => {
    const { db } = freshDb();
    const queue = new WriteQueue();
    const world = seedWorld(db);
    const run = await createRunFromApproval(db, queue, { approvalId: world.approvalId, adapterId: "api" });

    await appendRunEvent(db, queue, run.id, { type: "completed" });
    await assert.rejects(appendRunEvent(db, queue, run.id, { type: "error" }), /UNIQUE/);
    assert.equal(count(db, "SELECT count(*) AS n FROM run_events"), 1);
    db.close();
  });
});

describe("repairInterruptedRuns (§32)", () => {
  it("marks STARTING/RUNNING as FAILED(interrupted) with exactly one terminal event", async () => {
    const { db } = freshDb();
    const queue = new WriteQueue();
    const world = seedWorld(db);
    const run = await createRunFromApproval(db, queue, { approvalId: world.approvalId, adapterId: "api" });
    await transitionRun(db, queue, run.id, "QUEUED", "STARTING");
    await transitionRun(db, queue, run.id, "STARTING", "RUNNING");

    const result = await repairInterruptedRuns(db, queue, NOW);
    assert.equal(result.repaired.length, 1);
    assert.equal(result.appendedEvents, 1);

    const { run: repaired, events } = getRunWithEvents(db, run.id)!;
    assert.equal(repaired.state, "FAILED");
    assert.equal(repaired.failure_reason, "interrupted");
    assert.equal(repaired.finished_at, NOW);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.type, "error");
    db.close();
  });

  it("leaves finished runs alone", async () => {
    const { db } = freshDb();
    const queue = new WriteQueue();
    const world = seedWorld(db);
    const run = await createRunFromApproval(db, queue, { approvalId: world.approvalId, adapterId: "api" });
    await transitionRun(db, queue, run.id, "QUEUED", "STARTING");
    await transitionRun(db, queue, run.id, "STARTING", "RUNNING");
    await finishRun(db, queue, run.id, { from: "RUNNING", terminal: { type: "completed" } });

    const result = await repairInterruptedRuns(db, queue, NOW);
    assert.equal(result.repaired.length, 0);
    assert.equal(result.appendedEvents, 0);
    assert.equal(count(db, "SELECT count(*) AS n FROM run_events"), 1);
    db.close();
  });

  it("does not add a second terminal event when one already exists", async () => {
    const { db } = freshDb();
    const queue = new WriteQueue();
    const world = seedWorld(db);
    const run = await createRunFromApproval(db, queue, { approvalId: world.approvalId, adapterId: "api" });
    await transitionRun(db, queue, run.id, "QUEUED", "STARTING");
    await transitionRun(db, queue, run.id, "STARTING", "RUNNING");
    await appendRunEvent(db, queue, run.id, { type: "completed" });

    const result = await repairInterruptedRuns(db, queue, NOW);
    assert.equal(result.repaired.length, 1);
    assert.equal(result.appendedEvents, 0);
    assert.equal(count(db, "SELECT count(*) AS n FROM run_events"), 1);
    db.close();
  });
});
