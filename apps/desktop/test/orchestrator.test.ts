import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { AgentAdapter } from "@room/core";
import { approveAndCreateRun, openDatabase, WriteQueue } from "@room/db";
import type { AgentEvent, ControlEvent } from "@room/schemas";
import { RunOrchestrator } from "../src/main/orchestrator";
import { Repository } from "../src/main/repository";

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

async function setup() {
  const d = mkdtempSync(join(tmpdir(), "room-orch-"));
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

  return { db, queue, run: approved.run, input: { snapshotId: snapshot.id, content: snapshot.content, contentHash: snapshot.contentHash } };
}

describe("RunOrchestrator", () => {
  it("streams events, commits them with database seq, and finishes once", async () => {
    const { db, queue, run, input } = await setup();
    const emitted: ControlEvent[] = [];

    const orchestrator = new RunOrchestrator({
      db,
      queue,
      emit: (e) => emitted.push(e),
      getRun: (id) => db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as never,
      adapterFactory: async () =>
        fakeAdapter(async function* (_s, runId) {
          yield event(runId, 0, { type: "message_delta", text: "你" });
          yield event(runId, 1, { type: "message_complete", text: "你好" });
          yield event(runId, 2, { type: "completed" });
        }),
    });

    await orchestrator.start(run, input);

    const row = db.prepare("SELECT state FROM runs WHERE id = ?").get(run.id) as { state: string };
    assert.equal(row.state, "COMPLETED");

    const events = db
      .prepare("SELECT seq, event_id AS eventId, type FROM run_events WHERE run_id = ? ORDER BY seq")
      .all(run.id) as { seq: number; eventId: string; type: string }[];
    assert.deepEqual(events.map((e) => e.type), ["message_delta", "message_complete", "completed"]);
    assert.deepEqual(events.map((e) => e.seq), [0, 1, 2]);
    assert.equal(events.filter((e) => e.type === "completed").length, 1);

    // 推送出去的 seq / eventId 必须是数据库分配的，而不是 adapter 自己编的
    const streamed = emitted.filter((e) => e.type === "run.event");
    const firstDelta = streamed[0] as { event: { seq: number; eventId: string } };
    assert.equal(firstDelta.event.seq, 0);
    assert.equal(firstDelta.event.eventId, events[0]?.eventId);
  });

  it("cancels a run during STARTING and still writes exactly one terminal event", async () => {
    const { db, queue, run, input } = await setup();

    const orchestrator = new RunOrchestrator({
      db,
      queue,
      emit: () => undefined,
      getRun: (id) => db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as never,
      adapterFactory: async () =>
        fakeAdapter(async function* (_s, runId, _i, opts) {
          if (!opts.signal.aborted) {
            await new Promise<void>((resolve) => {
              opts.signal.addEventListener("abort", () => resolve(), { once: true });
            });
          }
          yield event(runId, 0, { type: "cancelled", reason: "aborted" });
        }),
    });

    const running = orchestrator.start(run, input);
    assert.equal(orchestrator.cancel(run.id), true);
    await running;

    const row = db.prepare("SELECT state FROM runs WHERE id = ?").get(run.id) as { state: string };
    assert.equal(row.state, "CANCELLED");

    const terminals = db
      .prepare("SELECT type FROM run_events WHERE run_id = ? AND type IN ('completed','error','cancelled','timed_out')")
      .all(run.id) as { type: string }[];
    assert.equal(terminals.length, 1);
    assert.equal(terminals[0]?.type, "cancelled");
  });
});
