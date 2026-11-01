import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { ChatRun, ChatSnapshot } from "@room/schemas";
import {
  createConversation,
  currentVersion,
  insertChatMessage,
  insertChatRun,
  insertChatSnapshot,
  insertChatSummary,
  LATEST_SCHEMA_VERSION,
  listChatSummaries,
  markChatSummariesStale,
  openDatabase,
  retractChatMessage,
  WriteQueue,
} from "../src/index";

/**
 * v14 / D-41：聊天历史摘要。
 * - 存哪儿、按时间正序读回来
 * - 覆盖的消息被撤回 → 摘要在同一事务里变成 stale（只改相关的那几条）
 * - 已经是 stale 的不重复改（撤回两条消息不会推两次同样的东西）
 */

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // Windows 上句柄释放有延迟
    }
  }
});

const TS = "2026-11-01T00:00:00.000Z";
const hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const ulid = () => Array.from({ length: 26 }, () => "0123456789ABCDEFGHJKMNPQRSTVWXYZ"[Math.floor(Math.random() * 32)]).join("");

async function env() {
  const dir = mkdtempSync(join(tmpdir(), "room-chat-summary-"));
  dirs.push(dir);
  const db = openDatabase(join(dir, "test.db"));
  const queue = new WriteQueue();
  const conversation = await createConversation(db, queue, { members: { kind: "direct", agent: "deepseek" }, title: null });
  return { db, queue, conversation };
}

function userMessage(conversationId: string, text: string, at = TS) {
  return {
    id: "cmsg_" + ulid(),
    conversationId,
    createdAt: at,
    sender: "user" as const,
    content: { kind: "text" as const, text, attachments: [] },
    mentions: { kind: "none" as const },
    quoteMessageId: null,
    replacesMessageId: null,
    state: "sent" as const,
    retractedAt: null,
  };
}

/** 写摘要的那个 Run（purpose = history_summary）：先有 Snapshot，再有 Run，摘要的 run_id 指向它 */
function historySummaryRun(
  db: ReturnType<typeof openDatabase>,
  conversationId: string,
  covered: string[],
): string {
  const content = "历史资料\n" + covered.join("\n");
  const snapshot = ChatSnapshot.parse({
    id: "snap_" + ulid(),
    purpose: "history_summary",
    conversationId,
    userMessageId: null,
    agent: "deepseek",
    content,
    contentHash: hex(content),
    nonce: "0123456789abcdef",
    memorySlot: null,
    includedMessageIds: covered,
    includedSummaryIds: [],
    adapterVersion: "chat-v4",
    tokenEstimate: 10,
    createdAt: TS,
  });
  insertChatSnapshot(db, snapshot);
  const run = ChatRun.parse({
    id: "run_" + ulid(),
    kind: "chat",
    purpose: "history_summary",
    conversationId,
    slotId: null,
    agent: "deepseek",
    snapshotId: snapshot.id,
    snapshotHash: snapshot.contentHash,
    finalPromptHash: null,
    memoryManifest: null,
    model: null,
    adapterId: "remote:deepseek-chat",
    state: "QUEUED",
    substate: null,
    failureReason: null,
    attempt: 1,
    createdAt: TS,
    startedAt: null,
    finishedAt: null,
  });
  insertChatRun(db, run);
  return run.id;
}

function summary(
  conversationId: string,
  runId: string,
  covered: string[],
  text: string,
  at = TS,
) {
  return {
    id: "csum_" + ulid(),
    conversationId,
    sourceMessageIds: covered,
    content: text,
    contentHash: hex(text),
    state: "current" as const,
    runId,
    agent: "deepseek" as const,
    createdAt: at,
  };
}

describe("chat history summaries (v14 / D-41)", () => {
  it("stores summaries and reads them back in time order", async () => {
    const { db, queue, conversation } = await env();
    try {
      assert.ok(currentVersion(db) >= 14);
      assert.ok(LATEST_SCHEMA_VERSION >= 14);

      const m1 = userMessage(conversation.id, "第一句", "2026-11-01T00:00:00.000Z");
      const m2 = userMessage(conversation.id, "第二句", "2026-11-01T00:01:00.000Z");
      insertChatMessage(db, { message: m1 });
      insertChatMessage(db, { message: m2 });

      const run1 = historySummaryRun(db, conversation.id, [m1.id]);
      const run2 = historySummaryRun(db, conversation.id, [m2.id]);
      insertChatSummary(db, summary(conversation.id, run2, [m2.id], "后写的", "2026-11-01T00:03:00.000Z"));
      insertChatSummary(db, summary(conversation.id, run1, [m1.id], "先写的", "2026-11-01T00:02:00.000Z"));

      assert.deepEqual(
        listChatSummaries(db, conversation.id).map((s) => s.content),
        ["先写的", "后写的"],
        "按时间正序，拼 Prompt 的顺序",
      );
      assert.equal((db.pragma("foreign_key_check") as unknown[]).length, 0);
    } finally {
      db.close();
    }
  });

  it("marks only summaries covering the retracted message as stale, in the same transaction", async () => {
    const { db, queue, conversation } = await env();
    try {
      const m1 = userMessage(conversation.id, "会被撤回");
      const m2 = userMessage(conversation.id, "留着");
      insertChatMessage(db, { message: m1 });
      insertChatMessage(db, { message: m2 });
      const run = historySummaryRun(db, conversation.id, [m1.id, m2.id]);
      const covering = summary(conversation.id, run, [m1.id, m2.id], "两条都覆盖");
      const otherRun = historySummaryRun(db, conversation.id, [m2.id]);
      const unrelated = summary(conversation.id, otherRun, [m2.id], "只覆盖第二条");
      insertChatSummary(db, covering);
      insertChatSummary(db, unrelated);

      db.exec("BEGIN IMMEDIATE");
      try {
        const retracted = retractChatMessage(db, m1.id, TS);
        assert.ok(retracted !== null);
        const changed = markChatSummariesStale(db, [m1.id]);
        db.exec("COMMIT");
        assert.deepEqual(changed.map((s) => s.id), [covering.id]);
        assert.equal(changed[0]!.state, "stale");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }

      const after = listChatSummaries(db, conversation.id);
      assert.equal(after.find((s) => s.id === covering.id)?.state, "stale");
      assert.equal(after.find((s) => s.id === unrelated.id)?.state, "current", "没覆盖到这条的摘要不动");
      // 已经是 stale 的不会再报一次（撤回第二条相关消息时不会重复推事件）
      assert.deepEqual(markChatSummariesStale(db, [m1.id]), []);
    } finally {
      db.close();
    }
  });

  it("rejects a summary with no source messages and a dangling run", async () => {
    const { db, queue, conversation } = await env();
    try {
      const run = historySummaryRun(db, conversation.id, ["cmsg_" + "0".repeat(26)]);
      assert.throws(() => insertChatSummary(db, summary(conversation.id, run, [], "没有来源")), /至少一条|min/i);
      assert.throws(
        () => db.prepare("INSERT INTO chat_summaries (id, conversation_id, source_message_ids, content, content_hash, state, run_id, agent, created_at) VALUES (?, ?, ?, ?, ?, 'current', ?, ?, ?)")
          .run("csum_x", conversation.id, JSON.stringify(["cmsg_a"]), "x", hex("x"), "run_missing", "deepseek", TS),
        /FOREIGN KEY/i,
      );
    } finally {
      db.close();
    }
  });
});
