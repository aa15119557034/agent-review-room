import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import Database from "better-sqlite3";
import { sha256Hex } from "@room/core";
import type { SourceReference } from "@room/schemas";
import { appendRunEventTx, appendStructuredEventTx, chatSourceReference, currentVersion, excludedMessageIdsForRetract, finishChatRun, finishChatSummaryRun, getChatMessage, getChatRun, getChatSnapshot, insertChatMessage, insertChatRun, insertChatSnapshot, isChatMessageCurrent, LATEST_SCHEMA_VERSION, markChatSummariesStale, MIGRATIONS, openDatabase, readResultDisplay, resolveSourceReference, retractChatMessage, sourceRefsCurrent, ulid, validateSourceRefs, WriteQueue, writeTransaction } from "../src/index";
import { SOURCE_TIME as T, sourceChat, sourceProjectRun, sourceUser } from "./source-fixtures";

const fresh = () => ({ db: openDatabase(":memory:"), queue: new WriteQueue() });
const display = (runId: string, n: number, source: SourceReference) => ({ eventId: runId + ":" + n, runId, seq: n, ts: T, type: "result_display", result: { version: 1, block: { kind: "citation", citationId: "source-1", source } } });

describe("P2-D08 immutable source storage", () => {
  it("migrates a real v27 database without changing any old columns, and creates a restorable original backup", () => {
    const dir = mkdtempSync(join(tmpdir(), "room-source-migration-")), file = join(dir, "room.db");
    const old = new Database(file);
    for (const migration of MIGRATIONS.filter((item) => item.version <= 27)) migration.up(old);
    old.pragma("user_version = 27");
    const run = sourceProjectRun(old);
    appendRunEventTx(old, run.runId, { type: "message_complete", payload: { text: "old\n原件" } });
    const tables = (old.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map(({ name }) => ({ name, columns: (old.prepare('PRAGMA table_info("' + name + '")').all() as { name: string }[]).map((column) => column.name) }));
    const digest = (db: Database.Database) => sha256Hex(JSON.stringify(tables.map(({ name, columns }) => db.prepare('SELECT ' + columns.map((c) => '"' + c + '"').join(',') + ' FROM "' + name + '" ORDER BY rowid').all())));
    const before = digest(old);
    old.close();
    const upgraded = openDatabase(file);
    assert.equal(currentVersion(upgraded), LATEST_SCHEMA_VERSION);
    assert.equal(digest(upgraded), before);
    assert.deepEqual(upgraded.pragma("foreign_key_check"), []);
    upgraded.close();
    const backupName = readdirSync(dir).find((name) => name.includes(".bak"));
    assert.ok(backupName);
    const backup = new Database(join(dir, backupName), { readonly: true });
    assert.equal(currentVersion(backup), 27);
    assert.equal(digest(backup), before);
    backup.close();
  });

  it("persists a reply and snapshot with references, preserves them through backup, and rejects mutation", async () => {
    const { db, queue } = fresh();
    const seeded = await sourceChat(db, queue);
    const ref = chatSourceReference(db, seeded.question.id, seeded.conversation.id, T);
    const snapshot = { ...seeded.snapshot, id: "snap_" + ulid(), sourceRefs: [ref] };
    insertChatSnapshot(db, snapshot);
    const result = await finishChatRun(db, queue, { runId: seeded.run.id, from: "RUNNING", terminal: { kind: "answered", text: "answer", sourceRefs: [ref] } });
    assert.deepEqual(getChatMessage(db, result.message!.id)?.sourceRefs, [ref]);
    assert.deepEqual(getChatSnapshot(db, snapshot.id), snapshot);
    assert.equal(getChatMessage(db, seeded.question.id)?.sourceRefs, undefined);
    for (const [table, id] of [["chat_messages", result.message!.id], ["chat_snapshots", snapshot.id]]) assert.throws(() => db.prepare("UPDATE " + table + " SET source_refs = NULL WHERE id = ?").run(id), /immutable/);
    const file = join(mkdtempSync(join(tmpdir(), "room-source-backup-")), "backup.db");
    await db.backup(file);
    const restored = openDatabase(file);
    assert.deepEqual(getChatSnapshot(restored, snapshot.id), snapshot);
    assert.deepEqual(getChatMessage(restored, result.message!.id), result.message);
    restored.close(); db.close();
  });

  it("rejects user metadata, forged hashes, foreign conversations and foreign projects at the write boundary", async () => {
    const { db, queue } = fresh();
    const a = await sourceChat(db, queue), b = await sourceChat(db, queue, "claude");
    const ref = chatSourceReference(db, a.question.id, a.conversation.id, T);
    assert.throws(() => insertChatMessage(db, { message: { ...sourceUser(a.conversation.id, "x"), sourceRefs: [ref] } }), /user chat messages/);
    assert.throws(() => validateSourceRefs(db, { conversationId: a.conversation.id }, [{ ...ref, contentHash: "0".repeat(64) }]), /version\/hash/);
    await assert.rejects(finishChatRun(db, queue, { runId: b.run.id, from: "RUNNING", terminal: { kind: "answered", text: "bad", sourceRefs: [ref] } }), /outside/);
    assert.equal(getChatRun(db, b.run.id)!.state, "RUNNING", "reference failure rolls back terminal state");
    const p = sourceProjectRun(db), other = sourceProjectRun(db), messageId = "msg_" + ulid();
    db.prepare("INSERT INTO messages (id, project_id, kind, source_agent, content, created_at) VALUES (?, ?, 'source_input', 'deepseek', 'original', ?)").run(messageId, p.projectId, T);
    const projectRef: SourceReference = { source: { kind: "message", id: messageId }, version: messageId, contentHash: sha256Hex("original"), retrievedAt: T, status: "readable" };
    assert.throws(() => resolveSourceReference(db, { projectId: other.projectId }, projectRef), /another project/);
    assert.throws(() => resolveSourceReference(db, { conversationId: a.conversation.id }, projectRef), /outside/);
    db.close();
  });

  it("retraction invalidates dependent replies and X-35 summaries without rewriting historical references", async () => {
    const { db, queue } = fresh();
    const source = await sourceChat(db, queue);
    const replyRun = await sourceChat(db, queue);
    const ref = chatSourceReference(db, source.question.id, source.conversation.id, T);
    appendStructuredEventTx(db, display(replyRun.run.id, 1, ref));
    assert.equal(sourceRefsCurrent(db, { conversationId: source.conversation.id }, [{ ...ref, status: "missing" }]), true);
    const answer = await finishChatRun(db, queue, { runId: replyRun.run.id, from: "RUNNING", terminal: { kind: "answered", text: "derived", sourceRefs: [ref] } });
    const summaryId = "csum_" + ulid();
    db.prepare("INSERT INTO chat_summaries (id, conversation_id, source_message_ids, content, content_hash, state, run_id, agent, created_at) VALUES (?, ?, ?, 'summary', ?, 'current', ?, 'deepseek', ?)").run(summaryId, source.conversation.id, JSON.stringify([replyRun.question.id]), sha256Hex("summary"), replyRun.run.id, T);
    await writeTransaction(db, queue, () => {
      retractChatMessage(db, source.question.id, T);
      const stale = markChatSummariesStale(db, excludedMessageIdsForRetract(db, source.question.id));
      assert.equal(stale.length, 1);
    });
    assert.equal(isChatMessageCurrent(db, answer.message!.id, source.conversation.id), false);
    assert.equal(resolveSourceReference(db, { conversationId: source.conversation.id }, ref).reference.status, "revoked");
    assert.equal(sourceRefsCurrent(db, { conversationId: source.conversation.id }, [{ ...ref, status: "missing" }]), false, "a window restriction must not bypass retraction");
    assert.deepEqual(getChatMessage(db, answer.message!.id)!.sourceRefs, [ref]);
    db.close();
  });

  it("does not publish a late history summary when a newly cited source was revoked", async () => {
    const { db, queue } = fresh(), source = await sourceChat(db, queue), other = await sourceChat(db, queue);
    const snapshot = { ...other.snapshot, id: "snap_" + ulid(), purpose: "history_summary" as const, userMessageId: null };
    insertChatSnapshot(db, snapshot);
    const run = { ...other.run, id: "run_" + ulid(), purpose: "history_summary" as const, slotId: null, snapshotId: snapshot.id };
    insertChatRun(db, run);
    appendStructuredEventTx(db, display(run.id, 1, chatSourceReference(db, source.question.id, source.conversation.id, T)));
    retractChatMessage(db, source.question.id, T);
    const result = await finishChatSummaryRun(db, queue, { runId: run.id, from: "RUNNING", summary: { id: "csum_" + ulid(), conversationId: source.conversation.id, sourceMessageIds: [other.question.id], content: "late summary", contentHash: sha256Hex("late summary"), state: "current", runId: run.id, agent: "deepseek", createdAt: T } });
    assert.equal(result.summary, null);
    assert.equal((db.prepare("SELECT count(*) AS n FROM chat_summaries").get() as { n: number }).n, 0);
    db.close();
  });

  it("projects cumulative usage once, persists citations with the reply and drops terminal/old-attempt events", async () => {
    const { db, queue } = fresh();
    const c = await sourceChat(db, queue), ref = chatSourceReference(db, c.question.id, c.conversation.id, T);
    const event = display(c.run.id, 3, ref);
    assert.ok(appendStructuredEventTx(db, event).stored);
    assert.ok(appendStructuredEventTx(db, event).stored);
    assert.equal((db.prepare("SELECT count(*) AS n FROM run_events WHERE chat_run_id = ?").get(c.run.id) as { n: number }).n, 1);
    assert.throws(() => appendStructuredEventTx(db, { ...display(c.run.id, 4, ref), result: { ...event.result, block: { ...event.result.block, title: "changed" } } }), /identity changed/);
    appendStructuredEventTx(db, { type: "message_complete", runId: c.run.id, eventId: "text", seq: 4, ts: T, text: "full body" });
    const unknown = { status: "unknown", reason: "not_reported" };
    for (const seq of [5, 6]) appendStructuredEventTx(db, { type: "result_display", runId: c.run.id, eventId: "usage" + seq, seq, ts: T, result: { version: 1, block: { kind: "usage", scope: "run", inputTokens: unknown, outputTokens: { status: "measured", value: seq }, toolCalls: { status: "measured", value: 0 }, cost: unknown } } });
    const usage = readResultDisplay(db, c.run.id).find((block) => block.kind === "usage")!;
    assert.equal(usage.kind, "usage");
    if (usage.kind === "usage") { assert.deepEqual(usage.outputTokens, { status: "measured", value: 6 }); assert.deepEqual(usage.inputTokens, unknown); }
    const answer = await finishChatRun(db, queue, { runId: c.run.id, from: "RUNNING", terminal: { kind: "answered", text: "full body" } });
    assert.deepEqual(answer.message!.sourceRefs, [ref]);
    assert.equal(appendStructuredEventTx(db, display(c.run.id, 7, ref)).reason, "run_not_running");
    const stale = await sourceChat(db, queue);
    db.prepare("UPDATE chat_reply_slots SET run_id = ? WHERE id = ?").run(c.run.id, stale.slot.id);
    assert.equal(appendStructuredEventTx(db, display(stale.run.id, 8, ref)).reason, "stale_attempt");
    assert.equal(readResultDisplay(db, stale.run.id).length, 0);
    db.close();
  });

  it("cancellation while queued cannot publish a reply or its references", async () => {
    const { db, queue } = fresh();
    const c = await sourceChat(db, queue), ref = chatSourceReference(db, c.question.id, c.conversation.id, T), controller = new AbortController();
    const result = finishChatRun(db, queue, { runId: c.run.id, from: "RUNNING", signal: controller.signal, terminal: { kind: "answered", text: "late", sourceRefs: [ref] } });
    controller.abort();
    assert.equal((await result).message, null);
    assert.equal(getChatRun(db, c.run.id)!.state, "CANCELLED");
    db.close();
  });
});
