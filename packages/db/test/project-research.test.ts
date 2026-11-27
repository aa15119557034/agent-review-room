import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { sha256Hex } from "@room/core";
import { ProjectResearchStartRunRequest, type SourceReference } from "@room/schemas";
import { appendResearchResultTx, approveAndCreateRun, approveBatch, chatSourceReference, createDraftTurns, currentProjectSources, finishRun, insertResearchPlanTx, openDatabase, previewProjectSource, readResearchPlan, readResultDisplay, repairInterruptedRuns, retractChatMessage, transitionRun, ulid, WriteQueue, writeTransaction } from "../src/index";
import { SOURCE_TIME as ts, sourceChat, sourceProjectRun } from "./source-fixtures";

const body = "  原样保存\r\n🧪正文\n";
const source: SourceReference = { source: { kind: "web", url: "https://example.com/article" }, version: sha256Hex(body), contentHash: sha256Hex(body), retrievedAt: ts, status: "readable" };
async function fixture() {
  const db = openDatabase(":memory:"), queue = new WriteQueue(), project = sourceProjectRun(db);
  const saved = await writeTransaction(db, queue, () => insertResearchPlanTx(db, { version: 1, projectId: project.projectId, snapshotId: "snap_" + ulid(), query: "公开资料", target: { nodeId: "research-node", baseUrl: "https://node.example", profileId: "research" } }, ts));
  const approve = { approvalId: saved.approvalId, expectedSnapshotHash: sha256Hex(saved.plan.query), expectedResearchHash: saved.researchHash, adapterId: "remote:research" };
  const start = async () => {
    const { run } = await approveAndCreateRun(db, queue, approve);
    await transitionRun(db, queue, run.id, "QUEUED", "STARTING");
    await transitionRun(db, queue, run.id, "STARTING", "RUNNING", { substate: "active" });
    const request = ProjectResearchStartRunRequest.parse({ protocol: 1, runId: run.id, profileId: "research", projectResearch: { version: 1 }, structuredResults: { version: 1 }, snapshot: { id: saved.plan.snapshotId, content: saved.plan.query, contentHash: approve.expectedSnapshotHash }, limits: { idleTimeoutMs: 10000, totalTimeoutMs: 20000 } });
    const append = (event: unknown) => writeTransaction(db, queue, () => appendResearchResultTx(db, request, event));
    return { run, request, append };
  };
  return { db, queue, saved, approve, start };
}
const complete = { type: "message_complete", seq: 3, ts, text: body, source };
const citation = { type: "result_display", seq: 4, ts, result: { version: 1, block: { kind: "citation", citationId: "original", source } } };

it("ordinary batch approval cannot consume a research snapshot", async () => {
  const f = await fixture();
  try {
    const roundId = "rnd_" + ulid(), batchId = "bat_" + ulid();
    f.db.prepare("INSERT INTO rounds (id, project_id, round_index, state, task, task_source, recipients, history_mode, created_at) VALUES (?, ?, 1, 'DRAFT', 'task', 'human', '[\"research\"]', 'recent_with_summaries', ?)").run(roundId, f.saved.plan.projectId, ts);
    f.db.prepare("INSERT INTO batches (id, project_id, round_id, kind, state, created_at) VALUES (?, ?, ?, 'initial', 'READY_FOR_REVIEW', ?)").run(batchId, f.saved.plan.projectId, roundId, ts);
    f.db.prepare("INSERT INTO batch_items (batch_id, recipient, approval_id, snapshot_id, content_hash, token_estimate) VALUES (?, 'research', ?, ?, ?, 1)").run(batchId, f.saved.approvalId, f.saved.plan.snapshotId, f.approve.expectedSnapshotHash);
    await createDraftTurns(f.db, f.queue, batchId);
    await assert.rejects(approveBatch(f.db, f.queue, { batchId, items: [{ approvalId: f.saved.approvalId, expectedContentHash: f.approve.expectedSnapshotHash }], via: "desktop" }), /research.approve/);
    assert.equal((f.db.prepare("SELECT state FROM approvals WHERE id = ?").get(f.saved.approvalId) as { state: string }).state, "READY_FOR_REVIEW");
    assert.equal((f.db.prepare("SELECT count(*) AS n FROM runs WHERE snapshot_id = ?").get(f.saved.plan.snapshotId) as { n: number }).n, 0);
  } finally { f.db.close(); }
});

it("current-source queries require explicit project sharing and recheck withdrawal without changing history", async () => {
  const f = await fixture();
  try {
    const chat = await sourceChat(f.db, f.queue), projectId = f.saved.plan.projectId, ownerId = "msg_" + ulid();
    const reference = chatSourceReference(f.db, chat.question.id, chat.conversation.id, ts);
    // A malformed historical owner cannot grant access to an unshared private chat.
    f.db.prepare("INSERT INTO messages (id, project_id, kind, source_agent, content, source_refs, created_at) VALUES (?, ?, 'source_input', 'research', 'derived', ?, ?)").run(ownerId, projectId, JSON.stringify([reference]), ts);
    const lookup = { type: "sources.current", projectId, owner: { kind: "message", id: ownerId } };
    const preview = { ...lookup, type: "sources.preview", index: 0 };
    assert.throws(() => currentProjectSources(f.db, lookup), /outside/);
    assert.throws(() => previewProjectSource(f.db, preview), /outside/);
    f.db.prepare("INSERT INTO messages (id, project_id, kind, conversation_id, chat_message_ids, content, created_at) VALUES (?, ?, 'chat_material', ?, ?, 'explicitly shared', ?)").run("msg_" + ulid(), projectId, chat.conversation.id, JSON.stringify([chat.question.id]), ts);
    assert.equal(previewProjectSource(f.db, preview).content, "Use the source");
    assert.equal(currentProjectSources(f.db, lookup).sources[0]!.currentStatus, "readable");
    assert.throws(() => previewProjectSource(f.db, { ...preview, projectId: sourceProjectRun(f.db).projectId }), { code: "not_found" });
    assert.throws(() => previewProjectSource(f.db, { ...preview, index: 1 }), { code: "not_found" });
    retractChatMessage(f.db, chat.question.id, ts);
    assert.deepEqual(currentProjectSources(f.db, lookup).sources, [{ index: 0, reference, currentStatus: "revoked" }]);
    assert.equal(previewProjectSource(f.db, preview).content, null);
    assert.equal(previewProjectSource(f.db, preview).status, "revoked");
    assert.deepEqual(previewProjectSource(f.db, preview).reference, reference);
  } finally { f.db.close(); }
});

it("cancellation while completion waits in the write queue wins settlement and preserves an already committed original", async () => {
  const f = await fixture();
  try {
    const r = await f.start(), original = await r.append(complete), controller = new AbortController();
    let release!: () => void, entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const blocker = f.queue.run(() => new Promise<void>((resolve) => { release = resolve; entered(); }));
    await ready;
    const finishing = finishRun(f.db, f.queue, r.run.id, { from: "RUNNING", signal: controller.signal, terminal: { type: "completed" } });
    controller.abort(); release(); await blocker;
    assert.equal((await finishing).state, "CANCELLED");
    assert.equal(previewProjectSource(f.db, { type: "sources.preview", projectId: f.saved.plan.projectId, owner: { kind: "message", id: original.originalMessageId }, index: 0 }).content, body);
    assert.equal((f.db.prepare("SELECT count(*) AS n FROM messages WHERE kind = 'reviewer_output'").get() as { n: number }).n, 0);
  } finally { f.db.close(); }
});

it("research approval binds both hashes and cannot pass through ordinary approval; concurrent approval consumes once", async () => {
  const f = await fixture();
  try {
    const { expectedResearchHash: _, ...ordinary } = f.approve;
    await assert.rejects(approveAndCreateRun(f.db, f.queue, ordinary), /research approval/);
    await assert.rejects(approveAndCreateRun(f.db, f.queue, { ...f.approve, expectedResearchHash: "0".repeat(64) }), /research approval/);
    await assert.rejects(approveAndCreateRun(f.db, f.queue, { ...f.approve, adapterId: "remote:other" }), /research approval/);
    const results = await Promise.allSettled([approveAndCreateRun(f.db, f.queue, f.approve), approveAndCreateRun(f.db, f.queue, f.approve)]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal((f.db.prepare("SELECT count(*) AS n FROM runs WHERE snapshot_id = ?").get(f.saved.plan.snapshotId) as { n: number }).n, 1);
    assert.throws(() => f.db.prepare("UPDATE prompt_snapshots SET research_hash = NULL WHERE id = ?").run(f.saved.plan.snapshotId), /immutable/);
  } finally { f.db.close(); }
});

it("a research marker with missing metadata fails closed instead of becoming a normal review", async () => {
  const f = await fixture();
  try {
    const id = "snap_" + ulid();
    f.db.prepare("INSERT INTO prompt_snapshots (id, project_id, content, content_hash, nonce, contribution_ids, task_instruction, reviewer_agent, adapter_version, token_estimate, created_at) VALUES (?, ?, 'q', ?, '0123456789abcdef', '[]', 'q', 'research', 'project-research-v1', 1, ?)").run(id, f.saved.plan.projectId, sha256Hex("q"), ts);
    assert.throws(() => readResearchPlan(f.db, id), /incomplete/);
  } finally { f.db.close(); }
});

it("commits exact original and reference once, rejects early/foreign citation and preserves provenance through backup and interruption", async () => {
  const f = await fixture();
  try {
    const r = await f.start();
    await assert.rejects(r.append(citation), /committed original/);
    await assert.rejects(r.append({ ...complete, source: { ...source, version: "0".repeat(64), contentHash: "0".repeat(64) } }), /hash/);
    assert.equal((f.db.prepare("SELECT count(*) AS n FROM messages").get() as { n: number }).n, 0);
    const original = await r.append(complete);
    assert.ok(original.originalMessageId);
    assert.equal((await r.append(complete)).changed, false);
    await assert.rejects(r.append({ ...complete, text: "changed" }), /changed payload/);
    await assert.rejects(r.append({ ...complete, seq: 5 }), /more than one/);
    await assert.rejects(r.append({ ...citation, result: { version: 1, block: { ...citation.result.block, source: { ...source, source: { kind: "web", url: "https://example.com/other" } } } } }), /committed original/);
    await r.append(citation);
    assert.equal((await r.append(citation)).changed, false);
    assert.equal(readResultDisplay(f.db, r.run.id).length, 1);
    const lookup = { type: "sources.current", projectId: f.saved.plan.projectId, owner: { kind: "message", id: original.originalMessageId } };
    const current = currentProjectSources(f.db, lookup);
    assert.deepEqual(current.sources, [{ index: 0, reference: source, currentStatus: "readable" }]);
    assert.equal(previewProjectSource(f.db, { ...lookup, type: "sources.preview", index: 0 }).content, body);
    assert.throws(() => currentProjectSources(f.db, { ...lookup, projectId: "proj_" + ulid() }), /not found/);
    await assert.rejects(finishRun(f.db, f.queue, r.run.id, { from: "RUNNING", terminal: { type: "completed" }, reviewerOutput: { content: body, sourceAgent: "research" } }), /research.approve/);
    const backup = join(mkdtempSync(join(tmpdir(), "room-research-")), "backup.db");
    await f.db.backup(backup);
    const reopened = openDatabase(backup);
    try {
      assert.deepEqual(readResearchPlan(reopened, f.saved.plan.snapshotId), { plan: f.saved.plan, researchHash: f.saved.researchHash });
      await repairInterruptedRuns(reopened, new WriteQueue());
      assert.equal((reopened.prepare("SELECT state FROM runs WHERE id = ?").get(r.run.id) as { state: string }).state, "FAILED");
      assert.equal(previewProjectSource(reopened, { ...lookup, type: "sources.preview", index: 0 }).content, body);
      assert.deepEqual(reopened.pragma("foreign_key_check"), []);
    } finally { reopened.close(); }
    await finishRun(f.db, f.queue, r.run.id, { from: "RUNNING", terminal: { type: "cancelled" } });
    await assert.rejects(r.append({ ...citation, seq: 6 }), /active authorized run/);
    assert.equal((f.db.prepare("SELECT count(*) AS n FROM messages WHERE kind = 'reviewer_output'").get() as { n: number }).n, 0);
    assert.equal(previewProjectSource(f.db, { ...lookup, type: "sources.preview", index: 0 }).content, body);
  } finally { f.db.close(); }
});

it("empty search completion records no original, and an injected write failure rolls back all original state", async () => {
  const f = await fixture();
  try {
    const r = await f.start();
    f.db.exec("CREATE TRIGGER research_test_failure BEFORE INSERT ON run_events WHEN NEW.type = 'message_complete' BEGIN SELECT RAISE(ABORT, 'injected disk failure'); END");
    await assert.rejects(r.append(complete), /injected disk failure/);
    assert.equal((f.db.prepare("SELECT count(*) AS n FROM messages").get() as { n: number }).n, 0);
    assert.equal((f.db.prepare("SELECT research_original_message_id AS id FROM runs WHERE id = ?").get(r.run.id) as { id: string | null }).id, null);
    f.db.exec("DROP TRIGGER research_test_failure");
    assert.equal((await r.append({ ...complete, source: null, text: "No results" })).originalMessageId, null);
    await assert.rejects(r.append(citation), /committed original/);
    await finishRun(f.db, f.queue, r.run.id, { from: "RUNNING", terminal: { type: "completed" } });
    assert.equal((f.db.prepare("SELECT count(*) AS n FROM messages").get() as { n: number }).n, 0);
  } finally { f.db.close(); }
});
