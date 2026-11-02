import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import Database from "better-sqlite3";
import { ChatMessage, ChatReplySlot, ChatRun, ChatSnapshot, Conversation, UserChatMessage, attachmentImageBlock, attachmentImageSlotMarker, attachmentManifestBlock } from "@room/schemas";
import {
  ChatRunStateConflictError,
  ChatSendConflictError,
  chatRecipients,
  chatRequired,
  createChatSend,
  ChatToTopicConflictError,
  createChatToTopic,
  createConversation,
  currentVersion,
  findDirectConversation,
  finishChatRun,
  getChatMessage,
  getChatRun,
  getChatSlot,
  getChatSnapshot,
  getConversation,
  insertChatMessage,
  insertChatRun,
  insertChatSlot,
  insertChatSnapshot,
  LATEST_SCHEMA_VERSION,
  recordChatPromptFinal,
  repairInterruptedChatRuns,
  transitionChatRun,
  listChatMessages,
  listChatSlotsForMessages,
  listConversations,
  markConversationRead,
  newChatMessageId,
  newConversationId,
  openDatabase,
  retractChatMessage,
  updateChatSlot,
  updateConversation,
  ulid,
  WriteQueue,
} from "../src/index";
import { SCHEMA_V1 } from "../src/schema";
import { SCHEMA_V2 } from "../src/schema";
import { SCHEMA_V3, SCHEMA_V3_REBUILD } from "../src/schema-v3";
import { SCHEMA_V4 } from "../src/schema-v4";
import { SCHEMA_V5 } from "../src/schema-v5";
import { SCHEMA_V6 } from "../src/schema-v6";
import { SCHEMA_V7 } from "../src/schema-v7";

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // Windows 上句柄释放有延迟；残留临时目录不影响结果
    }
  }
});

const T = "2026-10-26T00:00:00.000Z";
const at = (seconds: number): string => new Date(Date.parse(T) + seconds * 1000).toISOString();
const count = (db: Database.Database, table: string): number =>
  (db.prepare("SELECT count(*) AS n FROM " + table).get() as { n: number }).n;

function tempFile(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return join(dir, "room.db");
}

/** 造一个 v4 的真库（迁移 1～4 的 SQL 顺序跑一遍），用来验证升级 */
function buildV4(file: string): void {
  const raw = new Database(file);
  raw.pragma("foreign_keys = OFF");
  raw.exec(SCHEMA_V1);
  raw.exec(SCHEMA_V2);
  raw.exec(SCHEMA_V3);
  raw.exec(SCHEMA_V3_REBUILD);
  raw.exec(SCHEMA_V4);
  raw.pragma("user_version = 4");

  raw
    .prepare("INSERT INTO projects (id, name, created_at) VALUES ('proj_old', '旧议题', ?)")
    .run(at(0));
  raw
    .prepare(
      "INSERT INTO agents (id, display_name, color, role_note, can_discuss, can_summarize, can_execute, " +
        "paused_by_user, created_at, updated_at) VALUES ('deepseek', '汐', '#2f5aa0', '旧人设', 1, 1, 0, 0, ?, ?)",
    )
    .run(at(0), at(0));
  raw
    .prepare(
      "INSERT INTO messages (id, project_id, kind, source_agent, run_id, content, created_at) " +
        "VALUES ('msg_old', 'proj_old', 'source_input', 'deepseek', NULL, '旧材料', ?)",
    )
    .run(at(0));
  raw
    .prepare(
      "INSERT INTO prompt_snapshots (id, project_id, content, content_hash, nonce, contribution_ids, task_instruction, " +
        "reviewer_agent, adapter_version, token_estimate, created_at) VALUES ('snap_old', 'proj_old', 'b', ?, " +
        "'0123456789abcdef', '[]', 't', 'deepseek', 'v1', 1, ?)",
    )
    .run("a".repeat(64), at(0));
  raw
    .prepare("INSERT INTO approvals (id, project_id, snapshot_id, state, created_at) VALUES ('apr_old', 'proj_old', 'snap_old', 'APPROVED', ?)")
    .run(at(0));
  raw
    .prepare(
      "INSERT INTO runs (id, project_id, approval_id, snapshot_id, adapter_id, state, created_at) " +
        "VALUES ('run_old', 'proj_old', 'apr_old', 'snap_old', 'api', 'COMPLETED', ?)",
    )
    .run(at(0));
  raw.close();
}

/** 旧表的数据指纹：只取 v5 之前就存在的列，迁移前后必须一模一样 */
function oldDataDigest(db: Database.Database): string {
  const data = {
    projects: db.prepare("SELECT id, name, created_at FROM projects ORDER BY id").all(),
    agents: db
      .prepare(
        "SELECT id, display_name, color, role_note, can_discuss, can_summarize, can_execute, node_id, profile_id, " +
          "paused_by_user, substitute, created_at, updated_at FROM agents ORDER BY id",
      )
      .all(),
    messages: db.prepare("SELECT id, project_id, kind, source_agent, run_id, content, created_at FROM messages ORDER BY id").all(),
  };
  return createHash("sha256").update(JSON.stringify(data)).digest("hex");
}

describe("migration v5 (chat space)", () => {
  it("upgrades a v4 database: old digest unchanged, new tables empty, backup written, fk ok", () => {
    const file = tempFile("room-v5-");
    buildV4(file);

    const before = new Database(file, { readonly: true });
    const digestBefore = oldDataDigest(before);
    before.close();

    const db = openDatabase(file);
    try {
      assert.equal(currentVersion(db), LATEST_SCHEMA_VERSION);
      assert.ok(LATEST_SCHEMA_VERSION >= 5);

      // 旧数据一个字节都没变
      assert.equal(oldDataDigest(db), digestBefore, "old rows must not change");

      // 新表都是空的
      for (const table of ["conversations", "conversation_members", "chat_messages", "chat_reply_slots"]) {
        assert.equal(count(db, table), 0, table + " must start empty");
      }

      // 新列存在、旧行是 NULL（读的时候由 repository 补默认值）
      const agentColumns = (db.prepare("PRAGMA table_info(agents)").all() as { name: string }[]).map((c) => c.name);
      for (const column of ["chat_persona", "chat_profile_id", "memory_source"]) {
        assert.ok(agentColumns.includes(column), column);
      }
      const projectColumns = (db.prepare("PRAGMA table_info(projects)").all() as { name: string }[]).map((c) => c.name);
      assert.ok(projectColumns.includes("from_conversation_id"));

      const agent = db
        .prepare("SELECT chat_persona, chat_profile_id, memory_source FROM agents WHERE id = 'deepseek'")
        .get() as { chat_persona: string | null; chat_profile_id: string | null; memory_source: string | null };
      assert.equal(agent.chat_persona, null);
      assert.equal(agent.chat_profile_id, null);
      assert.equal(agent.memory_source, null);

      // 索引也在
      const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'chat_messages'").all() as {
        name: string;
      }[]).map((r) => r.name);
      assert.ok(indexes.includes("idx_chat_messages_conversation"));

      assert.deepEqual(db.pragma("foreign_key_check"), []);
    } finally {
      db.close();
    }

    // 迁移前的备份：版本停在 4，旧数据还在，没有 v5 的表
    const backup = file + ".bak-v4";
    assert.ok(existsSync(backup), "backup must exist");
    const old = new Database(backup, { readonly: true });
    try {
      assert.equal(old.pragma("user_version", { simple: true }), 4);
      assert.equal(oldDataDigest(old), digestBefore);
      const tables = (old.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(
        (r) => r.name,
      );
      assert.ok(!tables.includes("chat_messages"), "backup is the pre-migration state");
    } finally {
      old.close();
    }
  });

  it("reopens without redoing the migration and keeps the original backup", () => {
    const file = tempFile("room-v5-reopen-");
    buildV4(file);

    const first = openDatabase(file);
    const digest = oldDataDigest(first);
    first.close();
    const backupBefore = new Database(file + ".bak-v4", { readonly: true });
    const backupDigest = oldDataDigest(backupBefore);
    backupBefore.close();

    const second = openDatabase(file);
    try {
      assert.equal(currentVersion(second), LATEST_SCHEMA_VERSION);
      assert.equal(oldDataDigest(second), digest);
      assert.deepEqual(second.pragma("foreign_key_check"), []);
    } finally {
      second.close();
    }

    const backupAfter = new Database(file + ".bak-v4", { readonly: true });
    assert.equal(oldDataDigest(backupAfter), backupDigest, "backup is not overwritten by a later open");
    assert.equal(backupAfter.pragma("user_version", { simple: true }), 4);
    backupAfter.close();
  });

  it("cleans up a half-written backup and only leaves a complete one", () => {
    const file = tempFile("room-v5-partial-");
    buildV4(file);
    // 上一次 VACUUM 写到一半被杀：留下一个 .tmp
    writeFileSync(file + ".bak-v4.tmp", "half written");

    const db = openDatabase(file);
    db.close();

    assert.ok(existsSync(file + ".bak-v4"), "backup must be complete");
    assert.equal(existsSync(file + ".bak-v4.tmp"), false, "staging file must be gone");
    const backup = new Database(file + ".bak-v4", { readonly: true });
    assert.equal(backup.pragma("user_version", { simple: true }), 4);
    backup.close();
  });

  it("writes no backup for a brand-new database or when disabled", () => {
    const fresh = tempFile("room-v5-fresh-");
    const db = openDatabase(fresh);
    db.close();
    assert.equal(existsSync(fresh + ".bak-v0"), false);
    assert.equal(existsSync(fresh + ".bak-v4"), false);

    const legacy = tempFile("room-v5-nobackup-");
    buildV4(legacy);
    const migrated = openDatabase(legacy, { backupBeforeMigrate: false });
    migrated.close();
    assert.equal(existsSync(legacy + ".bak-v4"), false);
  });
});

describe("chat models", () => {
  function fresh(): { db: Database.Database; queue: WriteQueue } {
    return { db: openDatabase(tempFile("room-chat-")), queue: new WriteQueue() };
  }

  const userMessage = (conversationId: string, id: string, text: string, createdAt: string): ChatMessage => ({
    id,
    conversationId,
    createdAt,
    sender: "user",
    content: { kind: "text", text, attachments: [] },
    mentions: { kind: "none" },
    quoteMessageId: null,
    replacesMessageId: null,
    state: "sent",
    retractedAt: null,
  });

  it("creates one direct conversation per agent and keeps group member order", async () => {
    const { db, queue } = fresh();
    try {
      const direct = await createConversation(db, queue, { members: { kind: "direct", agent: "deepseek" }, title: null });
      Conversation.parse(direct);
      assert.equal(direct.kind, "direct");
      assert.deepEqual(direct.members, ["deepseek"]);
      assert.equal(direct.title, null);

      const again = await createConversation(db, queue, { members: { kind: "direct", agent: "deepseek" }, title: null });
      assert.equal(again.id, direct.id, "existing direct conversation is returned");
      assert.equal(count(db, "conversations"), 1);
      assert.equal(findDirectConversation(db, "deepseek")?.id, direct.id);

      const group = await createConversation(db, queue, {
        members: { kind: "group", agents: ["claude", "codex", "deepseek"] },
        title: "三个人",
      });
      Conversation.parse(group);
      assert.deepEqual(group.members, ["claude", "codex", "deepseek"]);
      assert.equal(getConversation(db, group.id)?.title, "三个人");

      await assert.rejects(
        createConversation(db, queue, { members: { kind: "group", agents: ["claude", "claude"] }, title: null }),
      );
      // 群聊至少 2 位（绕过 Zod 直接调用也建不出一位的群聊）
      await assert.rejects(
        createConversation(db, queue, { members: { kind: "group", agents: ["claude"] }, title: null }),
      );
    } finally {
      db.close();
    }
  });

  it("updates settings, replaces group members, and never lets a direct chat change members", async () => {
    const { db, queue } = fresh();
    try {
      const group = await createConversation(db, queue, { members: { kind: "group", agents: ["claude", "codex"] }, title: null });
      const updated = await updateConversation(db, queue, group.id, {
        title: "改名",
        pinned: true,
        members: ["deepseek", "codex"],
      });
      assert.equal(updated?.title, "改名");
      assert.equal(updated?.pinned, true);
      assert.deepEqual(updated?.members, ["deepseek", "codex"]);

      const direct = await createConversation(db, queue, { members: { kind: "direct", agent: "claude" }, title: null });
      await assert.rejects(updateConversation(db, queue, direct.id, { members: ["claude", "codex"] }));

      // 置顶的排在前面
      const list = listConversations(db);
      const first = list[0];
      assert.ok(first !== undefined);
      assert.equal(first.id, group.id);
      assert.equal(first.pinned, true);

      // 不存在的会话
      assert.equal(await updateConversation(db, queue, "conv_" + ulid(), { title: "x" }), null);
    } finally {
      db.close();
    }
  });

  it("marks read forward only", async () => {
    const { db, queue } = fresh();
    try {
      const conversation = await createConversation(db, queue, { members: { kind: "direct", agent: "deepseek" }, title: null });
      const first = userMessage(conversation.id, newChatMessageId(), "a", at(0));
      const second = userMessage(conversation.id, newChatMessageId(), "b", at(10));
      insertChatMessage(db, { message: first });
      insertChatMessage(db, { message: second });

      const readSecond = await markConversationRead(db, queue, conversation.id, second.id);
      assert.equal(readSecond?.lastReadMessageId, second.id);

      const back = await markConversationRead(db, queue, conversation.id, first.id);
      assert.equal(back?.lastReadMessageId, second.id, "older message is ignored");

      assert.equal(await markConversationRead(db, queue, conversation.id, newChatMessageId()), null);
    } finally {
      db.close();
    }
  });

  it("stores both senders, pages newest-first, retracts in place", async () => {
    const { db, queue } = fresh();
    try {
      // 会话的创建时间也要固定：lastActivityAt 只往前走，用真实时间会让这个用例随运行时钟漂移
      const conversation = await createConversation(db, queue, {
        members: { kind: "direct", agent: "deepseek" },
        title: null,
        createdAt: at(0),
      });
      const m1 = userMessage(conversation.id, newChatMessageId(), "一", at(0));
      const m2 = userMessage(conversation.id, newChatMessageId(), "二", at(10));
      const m3 = userMessage(conversation.id, newChatMessageId(), "三", at(20));
      for (const m of [m1, m2, m3]) insertChatMessage(db, { message: m, requestHash: "b".repeat(64) });

      assert.equal(getConversation(db, conversation.id)?.lastActivityAt, at(20));

      const page1 = listChatMessages(db, conversation.id, null, 2);
      assert.deepEqual(
        page1.messages.map((m) => m.id),
        [m3.id, m2.id],
      );
      assert.deepEqual(page1.nextCursor, { createdAt: at(10), id: m2.id });

      const page2 = listChatMessages(db, conversation.id, page1.nextCursor, 2);
      assert.deepEqual(
        page2.messages.map((m) => m.id),
        [m1.id],
      );
      assert.equal(page2.nextCursor, null);

      const retracted = retractChatMessage(db, m2.id, at(30));
      assert.ok(retracted !== null);
      ChatMessage.parse(retracted);
      assert.equal(retracted.state, "retracted");
      assert.equal(retracted.retractedAt, at(30));
      assert.equal(retractChatMessage(db, m2.id, at(40)), null, "already retracted");

      // 撤回之后别的字段仍然不能改，也不能撤销撤回、不能改撤回时间
      assert.throws(() => db.prepare("UPDATE chat_messages SET content = '{}' WHERE id = ?").run(m1.id), /immutable/);
      assert.throws(() => db.prepare("DELETE FROM chat_messages WHERE id = ?").run(m1.id), /immutable/);
      assert.throws(
        () => db.prepare("UPDATE chat_messages SET state = 'sent', retracted_at = NULL WHERE id = ?").run(m2.id),
        /immutable/,
        "撤回不能撤销",
      );
      assert.throws(
        () => db.prepare("UPDATE chat_messages SET retracted_at = ? WHERE id = ?").run(at(40), m2.id),
        /immutable/,
        "撤回时间不能改",
      );
    } finally {
      db.close();
    }
  });

  it("keeps one reply slot per (message, agent) and updates it in place", async () => {
    const { db, queue } = fresh();
    try {
      const conversation = await createConversation(db, queue, { members: { kind: "direct", agent: "deepseek" }, title: null });
      const message = userMessage(conversation.id, newChatMessageId(), "在吗", at(0));
      insertChatMessage(db, { message });

      const runId = "run_" + ulid();
      const slot: ChatReplySlot = {
        id: "slot_" + ulid(),
        conversationId: conversation.id,
        userMessageId: message.id,
        agent: "deepseek",
        required: true,
        outcome: "running",
        runId,
        attempt: 1,
        replyMessageId: null,
        failure: null,
        unavailableReason: null,
        createdAt: at(0),
        finishedAt: null,
      };
      insertChatSlot(db, slot);
      ChatReplySlot.parse(getChatSlot(db, slot.id));
      assert.deepEqual(
        listChatSlotsForMessages(db, [message.id]).map((s) => s.id),
        [slot.id],
      );

      assert.throws(() => insertChatSlot(db, { ...slot, id: "slot_" + ulid() }), /UNIQUE/);

      // running → failed → running 只能按转换表走，重试必须 attempt + 1
      const failed: ChatReplySlot = {
        ...slot,
        outcome: "failed",
        failure: { kind: "run_failed", message: "第一次失败了" },
        finishedAt: at(5),
      };
      updateChatSlot(db, failed);
      assert.throws(() => updateChatSlot(db, { ...slot, finishedAt: null }), /attempt/, "重试要把 attempt 加一");

      const runId2 = "run_" + ulid();
      const retried: ChatReplySlot = { ...slot, outcome: "running", runId: runId2, attempt: 2, finishedAt: null };
      updateChatSlot(db, retried);
      assert.equal(getChatSlot(db, slot.id)?.outcome, "running");

      const reply: ChatMessage = {
        id: newChatMessageId(),
        conversationId: conversation.id,
        createdAt: at(6),
        sender: "agent",
        agent: "deepseek",
        text: "在",
        inReplyTo: message.id,
        slotId: slot.id,
        runId: runId2,
        memoryEntriesUsed: null,
      };
      insertChatMessage(db, { message: reply });
      // 回答必须和回答位同一组：Run 不对、回答的不是那条消息，都插不进去
      assert.throws(
        () => insertChatMessage(db, { message: { ...reply, id: newChatMessageId(), runId: "run_" + ulid() } }),
        /run does not match/,
      );
      assert.throws(
        () => insertChatMessage(db, { message: { ...reply, id: newChatMessageId(), inReplyTo: "cmsg_" + ulid() } }),
        /answers another message/,
      );

      const answered: ChatReplySlot = {
        ...retried,
        outcome: "answered",
        replyMessageId: reply.id,
        finishedAt: at(6),
      };
      updateChatSlot(db, answered);
      const stored = getChatSlot(db, slot.id);
      assert.equal(stored?.outcome, "answered");
      assert.equal(stored?.replyMessageId, reply.id);
      assert.equal(stored?.attempt, 2);
      ChatReplySlot.parse(stored);

      // answered 不能直接变 failed；撤回可以，而且保留 replyMessageId（审计用）
      assert.throws(
        () =>
          updateChatSlot(db, {
            ...answered,
            outcome: "failed",
            replyMessageId: null,
            failure: { kind: "run_failed", message: "x" },
          }),
        /illegal transition/,
      );
      const retracted: ChatReplySlot = { ...answered, outcome: "retracted" };
      updateChatSlot(db, retracted);
      const afterRetract = getChatSlot(db, slot.id);
      assert.equal(afterRetract?.outcome, "retracted");
      assert.equal(afterRetract?.replyMessageId, reply.id, "撤回保留回答");
      ChatReplySlot.parse(afterRetract);
      assert.throws(
        () =>
          updateChatSlot(db, {
            ...answered,
            outcome: "running",
            attempt: 3,
            runId: "run_" + ulid(),
            replyMessageId: null,
            finishedAt: null,
          }),
        /illegal transition/,
        "retracted 是终态",
      );

      // 消息撤回之后，迟到的回答不能再写进来
      retractChatMessage(db, message.id, at(9));
      assert.throws(
        () => insertChatMessage(db, { message: { ...reply, id: newChatMessageId() } }),
        /still in context/,
      );

      // 回答位的身份字段不能改
      assert.throws(
        () => db.prepare("UPDATE chat_reply_slots SET agent = 'codex' WHERE id = ?").run(slot.id),
        /immutable/,
      );
      assert.throws(() => db.prepare("DELETE FROM chat_reply_slots WHERE id = ?").run(slot.id), /never deleted/);
    } finally {
      db.close();
    }
  });

  it("refuses to delete conversations", async () => {
    const { db, queue } = fresh();
    try {
      const conversation = await createConversation(db, queue, { members: { kind: "direct", agent: "deepseek" }, title: null });
      assert.throws(() => db.prepare("DELETE FROM conversations WHERE id = ?").run(conversation.id), /never deleted/);
      assert.throws(() => db.prepare("UPDATE conversations SET kind = 'group' WHERE id = ?").run(conversation.id), /immutable/);
    } finally {
      db.close();
    }
  });
});
describe("chat runs and snapshots (v6)", () => {
  function fresh(): { db: Database.Database; queue: WriteQueue } {
    return { db: openDatabase(tempFile("room-chat-run-")), queue: new WriteQueue() };
  }

  async function seed(db: Database.Database, queue: WriteQueue) {
    const conversation = await createConversation(db, queue, {
      members: { kind: "direct", agent: "deepseek" },
      title: null,
      createdAt: at(0),
    });
    const message: ChatMessage = {
      id: newChatMessageId(),
      conversationId: conversation.id,
      createdAt: at(0),
      sender: "user",
      content: { kind: "text", text: "在吗", attachments: [] },
      mentions: { kind: "none" },
      quoteMessageId: null,
      replacesMessageId: null,
      state: "sent",
      retractedAt: null,
    };
    insertChatMessage(db, { message });

    const slot: ChatReplySlot = {
      id: "slot_" + ulid(),
      conversationId: conversation.id,
      userMessageId: message.id,
      agent: "deepseek",
      required: true,
      outcome: "running",
      runId: "run_" + ulid(),
      attempt: 1,
      replyMessageId: null,
      failure: null,
      unavailableReason: null,
      createdAt: at(0),
      finishedAt: null,
    };
    const snapshot: ChatSnapshot = {
      id: "snap_" + ulid(),
      purpose: "reply",
      conversationId: conversation.id,
      userMessageId: message.id,
      agent: "deepseek",
      content: "你在和一个用户聊天。\n\n当前消息：在吗",
      contentHash: "a".repeat(64),
      nonce: "0123456789abcdef",
      memorySlot: null,
      includedMessageIds: [message.id],
      includedSummaryIds: [],
      adapterVersion: "chat-v1",
      tokenEstimate: 12,
      createdAt: at(0),
    };
    const run: ChatRun = {
      id: slot.runId as string,
      kind: "chat",
      purpose: "reply",
      conversationId: conversation.id,
      slotId: slot.id,
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
      createdAt: at(0),
      startedAt: null,
      finishedAt: null,
    };
    insertChatSnapshot(db, snapshot);
    insertChatSlot(db, slot);
    insertChatRun(db, run);
    return { conversation, message, slot, snapshot, run };
  }

  it("stores an immutable snapshot and a run chained to its slot", async () => {
    const { db, queue } = fresh();
    try {
      const { run, snapshot, slot } = await seed(db, queue);
      assert.deepEqual(getChatSnapshot(db, snapshot.id), snapshot);
      assert.equal(getChatRun(db, run.id)?.slotId, slot.id);

      // C-42g / X-34b（v15）：带图的 Snapshot 要把清单和图片位置标记一起存下来、原样读回
      const manifest = [
        { index: 1, ref: "img_" + ulid(), name: "图片.png", mime: "image/png" as const, bytes: 2048, sha256: "b".repeat(64) },
      ];
      const imageContent =
        attachmentManifestBlock(manifest) + "历史……\n" + attachmentImageBlock(snapshot.nonce, 1) + "\n当前消息：看看这张";
      const withImage: ChatSnapshot = {
        ...snapshot,
        id: "snap_" + ulid(),
        content: imageContent,
        contentHash: createHash("sha256").update(imageContent, "utf8").digest("hex"),
        attachments: manifest,
        imageSlot: attachmentImageSlotMarker(snapshot.nonce),
      };
      insertChatSnapshot(db, withImage);
      assert.deepEqual(getChatSnapshot(db, withImage.id), withImage, "附件清单和图片位置标记都存下来");

      assert.throws(() => db.prepare("UPDATE chat_snapshots SET content = 'x' WHERE id = ?").run(snapshot.id), /immutable/);
      assert.throws(() => db.prepare("DELETE FROM chat_snapshots WHERE id = ?").run(snapshot.id), /immutable/);
      assert.throws(() => db.prepare("UPDATE chat_runs SET slot_id = NULL WHERE id = ?").run(run.id), /immutable/);
      // 同一个回答位、同一个 attempt 只能有一个 Run
      assert.throws(
        () =>
          insertChatRun(db, {
            ...run,
            id: "run_" + ulid(),
          }),
        /UNIQUE|current attempt/,
      );
    } finally {
      db.close();
    }
  });

  const startRun = (db: Database.Database, runId: string): void => {
    transitionChatRun(db, runId, "QUEUED", "STARTING", { startedAt: at(1) });
    transitionChatRun(db, runId, "STARTING", "RUNNING", { substate: "active" });
  };

  it("回答与媒体计划同事务：写计划失败回滚回答，成功后重开数据库仍有计划", async () => {
    const file = tempFile("room-chat-outbox-");
    const db = openDatabase(file);
    const queue = new WriteQueue();
    let replyId: string;
    try {
      const { run, slot } = await seed(db, queue);
      startRun(db, run.id);
      db.exec("CREATE TRIGGER reject_pending BEFORE INSERT ON chat_immersive_pending BEGIN SELECT RAISE(ABORT, 'test crash'); END");
      const input = {
        runId: run.id, from: "RUNNING" as const,
        terminal: { kind: "answered" as const, text: "好", mediaIntent: { speak: true as const } },
        immersivePlan: { draw: false, speak: true }, finishedAt: at(5),
      };
      await assert.rejects(finishChatRun(db, queue, input), /test crash/);
      assert.equal(getChatRun(db, run.id)?.state, "RUNNING");
      assert.equal(getChatSlot(db, slot.id)?.outcome, "running");
      assert.equal(count(db, "chat_messages"), 1);
      db.exec("DROP TRIGGER reject_pending");
      const result = await finishChatRun(db, queue, input);
      replyId = result.message!.id;
    } finally { db.close(); }
    const reopened = openDatabase(file);
    try {
      assert.equal(getChatMessage(reopened, replyId!)?.sender, "agent");
      assert.deepEqual(reopened.prepare("SELECT * FROM chat_immersive_pending").all(), [
        { message_id: replyId!, draw: 0, speak: 1 },
      ]);
      assert.deepEqual(reopened.pragma("foreign_key_check"), []);
    } finally { reopened.close(); }
  });

  it("finishes answered: run COMPLETED + slot answered + exactly one reply message", async () => {
    const { db, queue } = fresh();
    try {
      const { run, slot } = await seed(db, queue);
      startRun(db, run.id);
      const finished = await finishChatRun(db, queue, {
        runId: run.id,
        from: "RUNNING",
        terminal: { kind: "answered", text: "在。" },
        finishedAt: at(5),
      });

      assert.equal(finished.run.state, "COMPLETED");
      assert.equal(finished.run.finishedAt, at(5));
      assert.equal(finished.slot?.outcome, "answered");
      assert.equal(finished.slot?.replyMessageId, finished.message?.id);
      ChatReplySlot.parse(finished.slot);
      assert.equal(finished.message?.text, "在。");
      assert.equal(finished.message?.inReplyTo, slot.userMessageId);
      assert.equal(finished.message?.slotId, slot.id);
      ChatMessage.parse(finished.message);

      // 同一个 Run 不能结两次（迟到的结果）
      await assert.rejects(
        finishChatRun(db, queue, { runId: run.id, from: "RUNNING", terminal: { kind: "answered", text: "再来一次" } }),
        ChatRunStateConflictError,
      );
      assert.equal(
        (db.prepare("SELECT count(*) AS n FROM chat_messages WHERE sender = 'agent'").get() as { n: number }).n,
        1,
      );
    } finally {
      db.close();
    }
  });

  it("maps failures and skips, drops late results for retracted slots", async () => {
    const { db, queue } = fresh();
    try {
      const first = await seed(db, queue);
      startRun(db, first.run.id);
      const failed = await finishChatRun(db, queue, {
        runId: first.run.id,
        from: "RUNNING",
        terminal: { kind: "failed", failure: { kind: "run_failed", message: "节点挂了" }, failureReason: "internal" },
      });
      assert.equal(failed.run.state, "FAILED");
      assert.equal(failed.run.failureReason, "internal");
      assert.equal(failed.slot?.outcome, "failed");
      assert.equal(failed.slot?.failure?.kind, "run_failed");
      assert.equal(failed.message, null);

      // 必须回答的人给出 skip：Run 正常结束（COMPLETED），回答位记 failed(skip_not_allowed)
      const second = await seed(db, queue);
      startRun(db, second.run.id);
      const skipped = await finishChatRun(db, queue, {
        runId: second.run.id,
        from: "RUNNING",
        terminal: { kind: "skipped" },
      });
      assert.equal(skipped.run.state, "COMPLETED");
      assert.equal(skipped.run.failureReason, null);
      assert.equal(skipped.slot?.outcome, "failed");
      assert.equal(skipped.slot?.failure?.kind, "skip_not_allowed");

      // 撤回之后才答完：Run 照常收尾，回答位保持 retracted、不写消息
      const third = await seed(db, queue);
      startRun(db, third.run.id);
      retractChatMessage(db, third.message.id, at(3));
      updateChatSlot(db, { ...third.slot, outcome: "retracted", finishedAt: at(3) });
      const late = await finishChatRun(db, queue, {
        runId: third.run.id,
        from: "RUNNING",
        terminal: { kind: "answered", text: "迟到的回答" },
      });
      assert.equal(late.run.state, "COMPLETED");
      assert.equal(late.slot?.outcome, "retracted");
      assert.equal(late.message, null);
    } finally {
      db.close();
    }
  });

  it("records prompt_final once and keeps the first value", async () => {
    const { db, queue } = fresh();
    try {
      const { run, snapshot } = await seed(db, queue);
      // 没有记忆槽位：最终 hash 必须等于 snapshotHash、清单必须为 null
      assert.equal(recordChatPromptFinal(db, run.id, "c".repeat(64), null), false);
      assert.equal(recordChatPromptFinal(db, run.id, snapshot.contentHash, null), true);
      assert.equal(recordChatPromptFinal(db, run.id, snapshot.contentHash, null), false, "只记第一次");
      assert.equal(getChatRun(db, run.id)?.finalPromptHash, snapshot.contentHash);

      startRun(db, run.id);
      const finished = await finishChatRun(db, queue, {
        runId: run.id,
        from: "RUNNING",
        terminal: { kind: "answered", text: "好" },
      });
      assert.equal(finished.message?.memoryEntriesUsed, null);
    } finally {
      db.close();
    }
  });

  it("旧尝试的迟到结果只收尾自己，不动新尝试的回答位", async () => {
    const { db, queue } = fresh();
    try {
      const { run, slot } = await seed(db, queue);
      startRun(db, run.id);
      // 用户取消这次尝试，然后重试：回答位指向 run2（attempt 2），run2 还没结束
      updateChatSlot(db, { ...slot, outcome: "cancelled", finishedAt: at(2) });
      const run2 = "run_" + ulid();
      updateChatSlot(db, { ...slot, outcome: "running", runId: run2, attempt: 2, finishedAt: null });

      const late = await finishChatRun(db, queue, {
        runId: run.id,
        from: "RUNNING",
        terminal: { kind: "answered", text: "旧尝试的回答" },
      });
      assert.equal(late.run.state, "COMPLETED");
      assert.equal(late.message, null, "旧尝试不写回答消息");
      assert.equal(late.slot?.outcome, "running", "新尝试的回答位不被旧结果改掉");
      assert.equal(late.slot?.runId, run2);
      assert.equal(late.slot?.attempt, 2);
    } finally {
      db.close();
    }
  });

  it("transitionChatRun 只能走 RUN_TRANSITIONS，且 RUNNING 必须有子状态", async () => {
    const { db, queue } = fresh();
    try {
      const { run } = await seed(db, queue);
      assert.throws(() => transitionChatRun(db, run.id, "QUEUED", "RUNNING"), /illegal transition/);
      transitionChatRun(db, run.id, "QUEUED", "STARTING", { startedAt: at(1) });
      assert.throws(() => transitionChatRun(db, run.id, "STARTING", "RUNNING"), /substate/);
      transitionChatRun(db, run.id, "STARTING", "RUNNING", { substate: "active" });
      assert.throws(() => transitionChatRun(db, run.id, "RUNNING", "COMPLETED"), /finishChatRun/);
      assert.throws(() => transitionChatRun(db, run.id, "RUNNING", "QUEUED"), /illegal transition/);

      const disconnected = transitionChatRun(db, run.id, "RUNNING", "RUNNING", { substate: "disconnected" });
      assert.equal(disconnected.substate, "disconnected");
      assert.equal(disconnected.failureReason, null);
    } finally {
      db.close();
    }
  });

  it("insertChatRun 核对 Snapshot / 回答位的一致性", async () => {
    const { db, queue } = fresh();
    try {
      const { run, snapshot } = await seed(db, queue);
      assert.throws(
        () => insertChatRun(db, { ...run, id: "run_" + ulid(), snapshotHash: "b".repeat(64) }),
        /snapshotHash/,
      );
      assert.throws(
        () => insertChatRun(db, { ...run, id: "run_" + ulid(), agent: "codex" }),
        /agent/,
      );
      assert.throws(
        () => insertChatRun(db, { ...run, id: "run_" + ulid(), purpose: "history_summary", slotId: null }),
        /purpose/,
      );
      assert.ok(getChatSnapshot(db, snapshot.id) !== null);
    } finally {
      db.close();
    }
  });

  it("prompt_final 在没有记忆槽位时核对 hash / 清单", async () => {
    const { db, queue } = fresh();
    try {
      const { run, snapshot } = await seed(db, queue);
      assert.equal(recordChatPromptFinal(db, run.id, "b".repeat(64), null), false, "hash 必须等于 snapshotHash");
      assert.equal(
        recordChatPromptFinal(db, run.id, snapshot.contentHash, { status: "filled", entries: [{ id: "a.md", sha256: "c".repeat(64) }] }),
        false,
        "没有槽位就不该有记忆清单",
      );
      assert.equal(recordChatPromptFinal(db, run.id, snapshot.contentHash, null), true);
    } finally {
      db.close();
    }
  });

  it("冻结 Run 上发送时定下的列", async () => {
    const { db, queue } = fresh();
    try {
      const { run } = await seed(db, queue);
      for (const sql of [
        "UPDATE chat_runs SET snapshot_hash = ? WHERE id = ?",
        "UPDATE chat_runs SET adapter_id = ? WHERE id = ?",
        "UPDATE chat_runs SET model = ? WHERE id = ?",
      ]) {
        assert.throws(
          () => db.prepare(sql).run(sql.includes("model") ? JSON.stringify({ model: "x" }) : "b".repeat(64), run.id),
          /immutable/,
        );
      }
    } finally {
      db.close();
    }
  });

  it("FAILED 必须有失败原因（数据库层反例）", async () => {
    const { db, queue } = fresh();
    try {
      const { run } = await seed(db, queue);
      startRun(db, run.id);
      assert.throws(() => db.prepare("UPDATE chat_runs SET state = 'FAILED' WHERE id = ?").run(run.id), /CHECK/);
      assert.throws(
        () => db.prepare("UPDATE chat_runs SET state = 'COMPLETED', failure_reason = 'internal' WHERE id = ?").run(run.id),
        /CHECK/,
      );
    } finally {
      db.close();
    }
  });

  it("repairs interrupted runs and their slots on restart", async () => {
    const { db, queue } = fresh();
    try {
      const { run, slot } = await seed(db, queue);
      // 停在 RUNNING 的 Run：模拟强杀后的状态
      db.prepare("UPDATE chat_runs SET state = 'RUNNING', substate = 'active', started_at = ? WHERE id = ?").run(at(1), run.id);

      const repaired = await repairInterruptedChatRuns(db, queue);
      assert.deepEqual(repaired.repaired, [run.id]);
      const after = getChatRun(db, run.id);
      assert.equal(after?.state, "FAILED");
      assert.equal(after?.failureReason, "interrupted");
      assert.equal(after?.substate, null);
      const storedSlot = getChatSlot(db, slot.id);
      assert.equal(storedSlot?.outcome, "failed");
      assert.equal(storedSlot?.failure?.kind, "interrupted");

      // 再跑一次是幂等的
      assert.deepEqual((await repairInterruptedChatRuns(db, queue)).repaired, []);
    } finally {
      db.close();
    }
  });
});
describe("chat send transaction (D-31b)", () => {
  function fresh(): { db: Database.Database; queue: WriteQueue } {
    return { db: openDatabase(tempFile("room-chat-send-")), queue: new WriteQueue() };
  }

  const userMessage = (conversationId: string, text = "在吗"): UserChatMessage => ({
    id: newChatMessageId(),
    conversationId,
    createdAt: at(0),
    sender: "user",
    content: { kind: "text", text, attachments: [] },
    mentions: { kind: "none" },
    quoteMessageId: null,
    replacesMessageId: null,
    state: "sent",
    retractedAt: null,
  });

  const snapshotFor = (conversationId: string, userMessageId: string, agent: string): ChatSnapshot => ({
    id: "snap_" + ulid(),
    purpose: "reply",
    conversationId,
    userMessageId,
    agent,
    content: "聊天上下文\n\n当前消息：在吗",
    contentHash: "a".repeat(64),
    nonce: "0123456789abcdef",
    memorySlot: null,
    includedMessageIds: [userMessageId],
    includedSummaryIds: [],
    adapterVersion: "chat-v2",
    tokenEstimate: 8,
    createdAt: at(0),
  });

  it("re-checks the quote and the re-edit target inside the write transaction", async () => {
    const { db, queue } = fresh();
    try {
      const direct = await createConversation(db, queue, { members: { kind: "direct", agent: "deepseek" }, title: null });
      const send = (message: UserChatMessage) =>
        createChatSend(db, queue, {
          conversation: direct,
          message,
          requestHash: "c".repeat(64),
          createdAt: at(2),
          availability: new Map([["deepseek", { kind: "unavailable" as const, reason: "offline" as const }]]),
          snapshots: new Map(),
          adapterIds: new Map(),
        });

      // 引用：事务外检查之后，被引用的消息被撤回了
      const quoted = userMessage(direct.id, "会被撤回");
      insertChatMessage(db, { message: quoted });
      retractChatMessage(db, quoted.id, at(1));
      await assert.rejects(
        send({ ...userMessage(direct.id, "引用它"), quoteMessageId: quoted.id }),
        ChatSendConflictError,
      );
      assert.equal((db.prepare("SELECT count(*) AS n FROM chat_messages WHERE quote_message_id = ?").get(quoted.id) as { n: number }).n, 0);

      // 重新编辑：两个不同的新 id 都指向同一条已撤回消息，第二个在事务里被拦
      const original = userMessage(direct.id, "原文");
      insertChatMessage(db, { message: original });
      retractChatMessage(db, original.id, at(1));
      await send({ ...userMessage(direct.id, "改一"), replacesMessageId: original.id });
      await assert.rejects(
        send({ ...userMessage(direct.id, "改二"), replacesMessageId: original.id }),
        ChatSendConflictError,
      );
      assert.equal(
        (db.prepare("SELECT count(*) AS n FROM chat_messages WHERE replaces_message_id = ?").get(original.id) as { n: number }).n,
        1,
      );
    } finally {
      db.close();
    }
  });

  it("applies the @ rules: direct, @all, @some, no mention", async () => {
    const { db, queue } = fresh();
    try {
      const direct = await createConversation(db, queue, { members: { kind: "direct", agent: "deepseek" }, title: null });
      assert.deepEqual(chatRecipients(direct, { kind: "none" }), ["deepseek"]);
      assert.equal(chatRequired(direct, { kind: "none" }, "deepseek"), true);
      assert.throws(() => chatRecipients(direct, { kind: "all" }));

      const group = await createConversation(db, queue, {
        members: { kind: "group", agents: ["claude", "codex", "deepseek"] },
        title: null,
      });
      assert.deepEqual(chatRecipients(group, { kind: "all" }), ["claude", "codex", "deepseek"]);
      assert.deepEqual(chatRecipients(group, { kind: "agents", agents: ["codex"] }), ["codex"]);
      assert.equal(chatRequired(group, { kind: "agents", agents: ["codex"] }, "codex"), true);
      assert.equal(chatRequired(group, { kind: "agents", agents: ["codex"] }, "claude"), false, "没被点到的人不必回答");
      assert.deepEqual(chatRecipients(group, { kind: "none" }), ["claude", "codex", "deepseek"]);
      assert.equal(chatRequired(group, { kind: "none" }, "codex"), false);
      assert.throws(() => chatRecipients(group, { kind: "agents", agents: ["nobody"] }));
    } finally {
      db.close();
    }
  });

  it("writes message + slots + snapshots + runs in one transaction, absent people get no run", async () => {
    const { db, queue } = fresh();
    try {
      const group = await createConversation(db, queue, {
        members: { kind: "group", agents: ["claude", "codex"] },
        title: null,
      });
      const message = userMessage(group.id);
      const result = await createChatSend(db, queue, {
        conversation: group,
        message,
        requestHash: "b".repeat(64),
        createdAt: at(0),
        availability: new Map([
          ["claude", { kind: "available" as const }],
          ["codex", { kind: "unavailable" as const, reason: "offline" as const }],
        ]),
        snapshots: new Map([["claude", snapshotFor(group.id, message.id, "claude")]]),
        adapterIds: new Map([["claude", "remote:claude-chat"]]),
      });

      assert.equal(result.slots.length, 2);
      assert.equal(result.runs.length, 1);
      const claude = result.slots.find((s) => s.agent === "claude");
      const codex = result.slots.find((s) => s.agent === "codex");
      assert.equal(claude?.outcome, "running");
      assert.equal(claude?.required, false, "群聊没点名时不是必须回答");
      assert.equal(claude?.runId, result.runs[0]?.id);
      assert.equal(codex?.outcome, "unavailable");
      assert.equal(codex?.unavailableReason, "offline");
      assert.equal(codex?.runId, null);
      ChatReplySlot.parse(claude);
      ChatReplySlot.parse(codex);

      assert.equal(getChatRun(db, result.runs[0]!.id)?.snapshotHash, "a".repeat(64));
      const stored = db.prepare("SELECT request_hash FROM chat_messages WHERE id = ?").get(message.id) as {
        request_hash: string;
      };
      assert.equal(stored.request_hash, "b".repeat(64));

      await assert.rejects(
        createChatSend(db, queue, {
          conversation: group,
          message,
          requestHash: "b".repeat(64),
          createdAt: at(1),
          availability: new Map([["claude", { kind: "available" as const }]]),
          snapshots: new Map([["claude", snapshotFor(group.id, message.id, "claude")]]),
          adapterIds: new Map([["claude", "remote:claude-chat"]]),
        }),
        /already exists/,
      );
    } finally {
      db.close();
    }
  });

  it("rejects a send when a recipient's availability is missing (snapshot present)", async () => {
    const { db, queue } = fresh();
    try {
      const group = await createConversation(db, queue, {
        members: { kind: "group", agents: ["claude", "codex"] },
        title: null,
      });
      const message = userMessage(group.id);
      await assert.rejects(
        createChatSend(db, queue, {
          conversation: group,
          message,
          requestHash: null,
          createdAt: at(0),
          // 只探测了 claude：codex 的 paused_by_user / 离线都不能被默认成「能答」
          availability: new Map([["claude", { kind: "available" as const }]]),
          snapshots: new Map([["claude", snapshotFor(group.id, message.id, "claude")]]),
          adapterIds: new Map([["claude", "remote:claude-chat"]]),
        }),
        /missing availability for chat recipient codex/,
      );
      for (const table of ["chat_messages", "chat_reply_slots", "chat_snapshots", "chat_runs"]) {
        assert.equal((db.prepare("SELECT count(*) AS n FROM " + table).get() as { n: number }).n, 0, table);
      }
    } finally {
      db.close();
    }
  });

  it("rejects missing availability before anything is written, even without a snapshot", async () => {
    const { db, queue } = fresh();
    try {
      const group = await createConversation(db, queue, {
        members: { kind: "group", agents: ["claude", "codex"] },
        title: null,
      });
      const message = userMessage(group.id);
      await assert.rejects(
        createChatSend(db, queue, {
          conversation: group,
          message,
          requestHash: null,
          createdAt: at(0),
          availability: new Map([["claude", { kind: "available" as const }]]),
          snapshots: new Map(),
          adapterIds: new Map(),
        }),
        /missing availability for chat recipient codex/,
        "先报数据缺失，而不是先报缺 Snapshot",
      );
      assert.equal((db.prepare("SELECT count(*) AS n FROM chat_messages").get() as { n: number }).n, 0);
      assert.equal((db.prepare("SELECT count(*) AS n FROM chat_reply_slots").get() as { n: number }).n, 0);
      assert.equal(getConversation(db, group.id)?.lastActivityAt !== undefined, true);
    } finally {
      db.close();
    }
  });

  it("rejects a send prepared against stale conversation members", async () => {
    const { db, queue } = fresh();
    try {
      const group = await createConversation(db, queue, {
        members: { kind: "group", agents: ["claude", "codex"] },
        title: null,
      });
      const stale = getConversation(db, group.id);
      assert.ok(stale !== null);
      // 拼 Snapshot 期间成员被改了：调用方还在用旧名单
      await updateConversation(db, queue, group.id, { members: ["claude", "deepseek"] });

      const message = userMessage(group.id);
      await assert.rejects(
        createChatSend(db, queue, {
          conversation: stale,
          message,
          requestHash: null,
          createdAt: at(0),
          availability: new Map([
            ["claude", { kind: "available" as const }],
            ["codex", { kind: "available" as const }],
          ]),
          snapshots: new Map([["claude", snapshotFor(group.id, message.id, "claude")]]),
          adapterIds: new Map([["claude", "remote:claude-chat"]]),
        }),
        ChatSendConflictError,
      );
      assert.equal((db.prepare("SELECT count(*) AS n FROM chat_messages").get() as { n: number }).n, 0);
      assert.equal((db.prepare("SELECT count(*) AS n FROM chat_reply_slots").get() as { n: number }).n, 0);
    } finally {
      db.close();
    }
  });

  it("rolls the whole send back when a later recipient lacks its snapshot", async () => {
    const { db, queue } = fresh();
    try {
      const group = await createConversation(db, queue, {
        members: { kind: "group", agents: ["claude", "codex"] },
        title: null,
      });
      const before = getConversation(db, group.id)?.lastActivityAt;
      const message = userMessage(group.id);

      await assert.rejects(
        createChatSend(db, queue, {
          conversation: group,
          message,
          requestHash: null,
          createdAt: at(0),
          availability: new Map([
            ["claude", { kind: "available" as const }],
            ["codex", { kind: "available" as const }],
          ]),
          // 只给了 claude 的 Snapshot：轮到 codex 时抛错，整次发送必须回滚
          snapshots: new Map([["claude", snapshotFor(group.id, message.id, "claude")]]),
          adapterIds: new Map([
            ["claude", "remote:claude-chat"],
            ["codex", "remote:codex-chat"],
          ]),
        }),
        /missing snapshot or adapter for codex/,
      );

      for (const table of ["chat_messages", "chat_reply_slots", "chat_snapshots", "chat_runs"]) {
        assert.equal((db.prepare("SELECT count(*) AS n FROM " + table).get() as { n: number }).n, 0, table);
      }
      assert.equal(getConversation(db, group.id)?.lastActivityAt, before, "会话活跃时间也不能变");
    } finally {
      db.close();
    }
  });
});
describe("migration v7 (chat material)", () => {
  it("rebuilds messages without losing rows, keeps triggers, and accepts chat_material", () => {
    const file = tempFile("room-v7-");
    const raw = new Database(file);
    raw.pragma("foreign_keys = OFF");
    raw.exec(SCHEMA_V1);
    raw.exec(SCHEMA_V2);
    raw.exec(SCHEMA_V3);
    raw.exec(SCHEMA_V3_REBUILD);
    raw.exec(SCHEMA_V4);
    raw.exec(SCHEMA_V5);
    raw.exec(SCHEMA_V6);
    raw.pragma("user_version = 6");

    raw.prepare("INSERT INTO projects (id, name, created_at) VALUES ('proj_old', '旧议题', ?)").run(at(0));
    raw.prepare(
      "INSERT INTO conversations (id, kind, direct_agent, title, pinned, muted, last_read_message_id, last_activity_at, created_at) " +
        "VALUES ('conv_old', 'direct', 'deepseek', NULL, 0, 0, NULL, ?, ?)",
    ).run(at(0), at(0));
    raw.prepare(
      "INSERT INTO messages (id, project_id, kind, source_agent, content, created_at) VALUES ('msg_old', 'proj_old', 'source_input', 'deepseek', '旧材料', ?)",
    ).run(at(0));
    raw.close();

    const db = openDatabase(file);
    try {
      assert.equal(currentVersion(db), LATEST_SCHEMA_VERSION);
      assert.ok(LATEST_SCHEMA_VERSION >= 7);
      assert.equal((db.prepare("SELECT count(*) AS n FROM messages").get() as { n: number }).n, 1);
      assert.equal((db.prepare("SELECT content FROM messages WHERE id = 'msg_old'").get() as { content: string }).content, "旧材料");
      assert.deepEqual(db.pragma("foreign_key_check"), []);

      // 新 kind 可以写
      db.prepare(
        "INSERT INTO messages (id, project_id, kind, conversation_id, chat_message_ids, content, created_at) " +
          "VALUES ('msg_mat', 'proj_old', 'chat_material', 'conv_old', '[\"cmsg_x\"]', '材料', ?)",
      ).run(at(0));
      // 消息仍然不可变
      assert.throws(() => db.prepare("UPDATE messages SET content = 'x' WHERE id = 'msg_mat'").run(), /immutable/);
      assert.throws(() => db.prepare("DELETE FROM messages WHERE id = 'msg_mat'").run(), /immutable/);
      // chat_material 必须带会话和消息 id
      assert.throws(
        () =>
          db.prepare(
            "INSERT INTO messages (id, project_id, kind, content, created_at) VALUES ('msg_bad', 'proj_old', 'chat_material', 'x', ?)",
          ).run(at(0)),
        /CHECK/,
      );
    } finally {
      db.close();
    }
  });

  it("creates the topic and its chat_material in one transaction", async () => {
    const { db, queue } = { db: openDatabase(tempFile("room-v7-topic-")), queue: new WriteQueue() };
    try {
      const conversation = await createConversation(db, queue, {
        members: { kind: "direct", agent: "deepseek" },
        title: null,
        createdAt: at(0),
      });
      const materialIds = [newChatMessageId(), newChatMessageId()];
      for (const [index, id] of materialIds.entries()) {
        insertChatMessage(db, {
          message: {
            id,
            conversationId: conversation.id,
            createdAt: at(index),
            sender: "user",
            content: { kind: "text", text: "材料 " + index, attachments: [] },
            mentions: { kind: "none" },
            quoteMessageId: null,
            replacesMessageId: null,
            state: "sent",
            retractedAt: null,
          },
        });
      }
      const result = await createChatToTopic(db, queue, {
        projectId: "proj_" + ulid(),
        materialId: "msg_" + ulid(),
        conversationId: conversation.id,
        name: "从聊天来的议题",
        chatMessageIds: materialIds,
        content: "整理好的材料",
        createdAt: at(0),
      });

      assert.equal(result.project.fromConversationId, conversation.id);
      assert.equal(result.material.kind, "chat_material");
      assert.deepEqual(result.material.chatMessageIds, materialIds);
      assert.equal(result.material.projectId, result.project.id);
    } finally {
      db.close();
    }
  });
});
describe("createChatToTopic guards", () => {
  it("rejects selected messages that were retracted before the transaction", async () => {
    const { db, queue } = { db: openDatabase(tempFile("room-topic-guard-")), queue: new WriteQueue() };
    try {
      const conversation = await createConversation(db, queue, {
        members: { kind: "direct", agent: "deepseek" },
        title: null,
        createdAt: at(0),
      });
      const messageId = newChatMessageId();
      insertChatMessage(db, {
        message: {
          id: messageId,
          conversationId: conversation.id,
          createdAt: at(0),
          sender: "user",
          content: { kind: "text", text: "会被撤回", attachments: [] },
          mentions: { kind: "none" },
          quoteMessageId: null,
          replacesMessageId: null,
          state: "sent",
          retractedAt: null,
        },
      });
      retractChatMessage(db, messageId, at(5));

      await assert.rejects(
        createChatToTopic(db, queue, {
          projectId: "proj_" + ulid(),
          materialId: "msg_" + ulid(),
          conversationId: conversation.id,
          name: "不该建出来",
          chatMessageIds: [messageId],
          content: "材料",
          createdAt: at(5),
        }),
        ChatToTopicConflictError,
      );
      assert.equal((db.prepare("SELECT count(*) AS n FROM projects").get() as { n: number }).n, 0);
    } finally {
      db.close();
    }
  });
});

describe("migration v8 (chat media intent)", () => {
  it("adds media_intent, keeps old rows unchanged, and plugs the new column into the immutability trigger", () => {
    const file = tempFile("room-v8-");
    const raw = new Database(file);
    raw.pragma("foreign_keys = OFF");
    raw.exec(SCHEMA_V1);
    raw.exec(SCHEMA_V2);
    raw.exec(SCHEMA_V3);
    raw.exec(SCHEMA_V3_REBUILD);
    raw.exec(SCHEMA_V4);
    raw.exec(SCHEMA_V5);
    raw.exec(SCHEMA_V6);
    raw.exec(SCHEMA_V7);
    raw.pragma("user_version = 7");

    raw
      .prepare(
        "INSERT INTO conversations (id, kind, direct_agent, title, pinned, muted, last_read_message_id, last_activity_at, created_at) " +
          "VALUES ('conv_old', 'direct', 'deepseek', NULL, 0, 0, NULL, ?, ?)",
      )
      .run(at(0), at(0));
    raw
      .prepare(
        "INSERT INTO chat_messages (id, conversation_id, sender, created_at, content, mentions, state) " +
          "VALUES ('cmsg_old', 'conv_old', 'user', ?, ?, ?, 'sent')",
      )
      .run(at(0), JSON.stringify({ kind: "text", text: "旧消息", attachments: [] }), JSON.stringify({ kind: "none" }));
    raw.close();

    const db = openDatabase(file);
    try {
      assert.equal(currentVersion(db), LATEST_SCHEMA_VERSION);
      assert.ok(LATEST_SCHEMA_VERSION >= 8);

      // 旧行一个字节没变，新列是 NULL；读出来省略 mediaIntent
      const row = db.prepare("SELECT content, media_intent FROM chat_messages WHERE id = 'cmsg_old'").get() as {
        content: string;
        media_intent: string | null;
      };
      assert.equal((JSON.parse(row.content) as { text: string }).text, "旧消息");
      assert.equal(row.media_intent, null);
      const stored = getChatMessage(db, "cmsg_old");
      assert.ok(stored !== null && stored.sender === "user");
      assert.equal("mediaIntent" in stored, false, "旧行省略媒体意图");

      // 列和 CHECK 都在：不是 JSON 对象就写不进去
      const columns = (db.prepare("PRAGMA table_info(chat_messages)").all() as { name: string }[]).map((c) => c.name);
      assert.ok(columns.includes("media_intent"));
      assert.throws(
        () =>
          db
            .prepare(
              "INSERT INTO chat_messages (id, conversation_id, sender, created_at, content, mentions, state, media_intent) " +
                "VALUES ('cmsg_bad', 'conv_old', 'user', ?, ?, ?, 'sent', ?)",
            )
            .run(at(1), JSON.stringify({ kind: "text", text: "x", attachments: [] }), JSON.stringify({ kind: "none" }), "not json"),
        /CHECK/,
      );

      // 加列之后消息仍然不可变：改 media_intent 也被触发器拦下；撤回照旧可以
      assert.throws(
        () => db.prepare("UPDATE chat_messages SET media_intent = ? WHERE id = 'cmsg_old'").run('{"speak":true}'),
        /immutable/,
      );
      assert.ok(retractChatMessage(db, "cmsg_old", at(10)) !== null);

      assert.deepEqual(db.pragma("foreign_key_check"), []);
    } finally {
      db.close();
    }

    assert.ok(existsSync(file + ".bak-v7"), "migration backup must exist");
  });
});

describe("chat media intent (C-42e / D-31d)", () => {
  const userMessage = (conversationId: string, id: string, text: string, createdAt: string): ChatMessage => ({
    id,
    conversationId,
    createdAt,
    sender: "user",
    content: { kind: "text", text, attachments: [] },
    mentions: { kind: "none" },
    quoteMessageId: null,
    replacesMessageId: null,
    state: "sent",
    retractedAt: null,
  });

  it("stores the qualified intent with the reply, reads it back, and omits it when there is none", async () => {
    const { db, queue } = { db: openDatabase(tempFile("room-media-intent-")), queue: new WriteQueue() };
    try {
      const conversation = await createConversation(db, queue, {
        members: { kind: "direct", agent: "deepseek" },
        title: null,
        createdAt: at(0),
      });
      let questionIndex = 0;
      /** 造一条你发的消息 + 它正在跑的回答位，返回插入回答要用到的那几样 */
      const prepare = () => {
        const question = userMessage(conversation.id, newChatMessageId(), "问一句", at(questionIndex++));
        insertChatMessage(db, { message: question });
        const runId = "run_" + ulid();
        const slot: ChatReplySlot = {
          id: "slot_" + ulid(),
          conversationId: conversation.id,
          userMessageId: question.id,
          agent: "deepseek",
          required: true,
          outcome: "running",
          runId,
          attempt: 1,
          replyMessageId: null,
          failure: null,
          unavailableReason: null,
          createdAt: at(0),
          finishedAt: null,
        };
        insertChatSlot(db, slot);
        return { question, runId, slot };
      };

      const first = prepare();
      const draw = { prompt: "小鲸鱼", size: "1024x1024" as const };
      const withMedia: ChatMessage = {
        id: newChatMessageId(),
        conversationId: conversation.id,
        createdAt: at(1),
        sender: "agent",
        agent: "deepseek",
        text: "给你画一张",
        inReplyTo: first.question.id,
        slotId: first.slot.id,
        runId: first.runId,
        memoryEntriesUsed: null,
        mediaIntent: { speak: true, draw },
      };
      insertChatMessage(db, { message: withMedia });

      const readBack = getChatMessage(db, withMedia.id);
      assert.ok(readBack !== null && readBack.sender === "agent");
      assert.deepEqual(readBack.mediaIntent, { speak: true, draw });
      ChatMessage.parse(readBack);

      // 一项都没有就是不传 → 列是 NULL → 读出来没有这个键
      const second = prepare();
      const plain: ChatMessage = {
        id: newChatMessageId(),
        conversationId: conversation.id,
        createdAt: at(2),
        sender: "agent",
        agent: "deepseek",
        text: "好的",
        inReplyTo: second.question.id,
        slotId: second.slot.id,
        runId: second.runId,
        memoryEntriesUsed: null,
      };
      insertChatMessage(db, { message: plain });
      const plainStored = getChatMessage(db, plain.id);
      assert.ok(plainStored !== null);
      assert.equal("mediaIntent" in plainStored, false);
      assert.equal(
        (db.prepare("SELECT media_intent FROM chat_messages WHERE id = ?").get(plain.id) as { media_intent: string | null }).media_intent,
        null,
      );

      // D-39：immersiveDeferred 和媒体意图一起落库，读回来是同一份
      const third = prepare();
      const deferred = {
        id: newChatMessageId(),
        conversationId: conversation.id,
        createdAt: at(3),
        sender: "agent" as const,
        agent: "deepseek",
        text: "好",
        inReplyTo: third.question.id,
        slotId: third.slot.id,
        runId: third.runId,
        memoryEntriesUsed: null,
        mediaIntent: { draw: { prompt: "小鲸鱼", size: "1024x1024" as const } },
        immersiveDeferred: { draw: "hourly_limit" as const },
      };
      insertChatMessage(db, { message: deferred });
      const stored = getChatMessage(db, deferred.id);
      assert.ok(stored !== null && stored.sender === "agent");
      assert.deepEqual(stored.immersiveDeferred, { draw: "hourly_limit" });
      assert.deepEqual(stored.mediaIntent, { draw: { prompt: "小鲸鱼", size: "1024x1024" } });
    } finally {
      db.close();
    }
  });
});
