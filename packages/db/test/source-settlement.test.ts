import assert from "node:assert/strict";
import { it } from "node:test";
import { sha256Hex } from "@room/core";
import { appendStructuredEventTx, approveAndCreateRun, approveBatch, chatSourceReference, createChatToTopic, createRoundDraft, createSummaryDraft, finishChatRun, finishRun, finishSummaryFromRun, finishTurnFromRun, openDatabase, retractChatMessage, transitionRun, ulid, WriteQueue } from "../src/index";
import { sourceChat, SOURCE_TIME as T } from "./source-fixtures";

for (const path of ["discussion", "summary", "reviewer", "chat"] as const) {
  it(`settles ${path} without publishing output when a source is revoked during the run`, async () => {
    const db = openDatabase(":memory:"), queue = new WriteQueue();
    try {
      const source = await sourceChat(db, queue);
      const ref = chatSourceReference(db, source.question.id, source.conversation.id, T);
      let runId: string;
      if (path === "chat") {
        const reply = await sourceChat(db, queue);
        runId = reply.run.id;
        // The current question stays sent: revoking a different cited message must still close its slot.
        appendStructuredEventTx(db, { eventId: "citation", runId, seq: 0, ts: T, type: "result_display", result: { version: 1, block: { kind: "citation", citationId: "source", source: ref } } });
        retractChatMessage(db, source.question.id, T);
        const result = await finishChatRun(db, queue, { runId, from: "RUNNING", terminal: { kind: "answered", text: "late answer" } });
        assert.equal(result.message, null);
        assert.equal(result.slot!.outcome, "failed");
        assert.equal(result.slot!.replyMessageId, null);
        assert.equal(result.slot!.failure!.kind, "run_failed");
        assert.equal(result.run.state, "FAILED");
        assert.equal(result.run.failureReason, "postprocess");
        assert.ok(result.run.finishedAt);
      } else {
        const { project } = await createChatToTopic(db, queue, { projectId: "proj_" + ulid(), materialId: "msg_" + ulid(), conversationId: source.conversation.id, name: path, chatMessageIds: [source.question.id], content: "Use the source", createdAt: T });
        const prompt = { content: "source", contentHash: sha256Hex("source"), nonce: "0123456789abcdef", adapterVersion: "test", tokenEstimate: 2, differsFromOthers: false, sourceRefs: [ref] };
        const draft = await createRoundDraft(db, queue, { projectId: project.id, task: "discuss", taskSource: "human", historyMode: "recent_with_summaries", recipients: [{ agent: "deepseek", prompt }] });
        const approve = async (batchId: string) => {
          const items = db.prepare("SELECT approval_id AS approvalId, content_hash AS expectedContentHash FROM batch_items WHERE batch_id = ?").all(batchId) as { approvalId: string; expectedContentHash: string }[];
          return (await approveBatch(db, queue, { batchId, items, via: "desktop" })).runIds[0]!;
        };
        if (path === "reviewer") {
          const item = db.prepare("SELECT approval_id FROM batch_items WHERE batch_id = ?").get(draft.batch.id) as { approval_id: string };
          runId = (await approveAndCreateRun(db, queue, { approvalId: item.approval_id, expectedSnapshotHash: prompt.contentHash, adapterId: "test" })).run.id;
        } else {
          runId = await approve(draft.batch.id);
          if (path === "summary") {
            await finishTurnFromRun(db, queue, { runId, terminal: { kind: "answered", text: "valid answer before retraction" } });
            const summary = await createSummaryDraft(db, queue, { roundId: draft.round.id, recipients: [{ agent: "deepseek", prompt }] });
            runId = await approve(summary.batch.id);
          }
        }
        await transitionRun(db, queue, runId, "QUEUED", "STARTING");
        await transitionRun(db, queue, runId, "STARTING", "RUNNING");
        retractChatMessage(db, source.question.id, T);
        if (path === "reviewer") {
          const result = await finishRun(db, queue, runId, { from: "RUNNING", terminal: { type: "completed" }, reviewerOutput: { content: "late review", sourceAgent: "deepseek" } });
          assert.equal(result.message, null);
        } else if (path === "summary") {
          const result = await finishSummaryFromRun(db, queue, { runId, result: { kind: "answered", text: "late summary", plan: { content: "late plan", changeNote: "late" } } });
          assert.equal(result.messageId, null);
          assert.equal(result.roundSummaryId, null);
          assert.equal(result.planVersionId, null);
          assert.equal(result.roundState, "AWAITING_SUMMARY");
          assert.equal((db.prepare("SELECT count(*) AS n FROM plan_versions WHERE project_id = ?").get(project.id) as { n: number }).n, 0);
        } else {
          const result = await finishTurnFromRun(db, queue, { runId, terminal: { kind: "answered", text: "late answer" } });
          assert.equal(result.messageId, null);
          assert.equal(result.outcome, "failed");
          assert.equal(result.roundState, "AWAITING_SUMMARY");
        }
        const run = db.prepare("SELECT state, failure_reason, finished_at FROM runs WHERE id = ?").get(runId) as { state: string; failure_reason: string; finished_at: string | null };
        assert.equal(run.state, "FAILED");
        assert.equal(run.failure_reason, "postprocess");
        assert.ok(run.finished_at);
        assert.equal((db.prepare("SELECT count(*) AS n FROM messages WHERE run_id = ?").get(runId) as { n: number }).n, 0);
        if (path !== "reviewer") assert.equal((db.prepare("SELECT outcome FROM turns WHERE run_id = ?").get(runId) as { outcome: string }).outcome, "failed");
      }
      const terminals = db.prepare("SELECT type, payload FROM run_events WHERE (run_id = ? OR chat_run_id = ?) AND type IN ('completed', 'error', 'cancelled', 'timed_out')").all(runId, runId) as { type: string; payload: string }[];
      assert.equal(terminals.length, 1);
      assert.equal(terminals[0]!.type, "error");
      assert.equal(JSON.parse(terminals[0]!.payload).reason, "postprocess");
    } finally { db.close(); }
  });
}
