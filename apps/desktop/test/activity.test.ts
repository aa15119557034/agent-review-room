import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { openDatabase, ulid, WriteQueue } from "@room/db";
import { AGENT_ACTIVITY_CURRENT_MAX, agentActivity, truncatePreview } from "../src/main/activity";

/**
 * D-44 / C-37a：agents.activity 的核心（纯函数 + 真库）。
 * - current 正序、recent 倒序、两表按 (createdAt, id) 合并
 * - 分页：满页给 cursor、before 只翻历史、翻到底 nextCursor 为 null
 * - preview：讨论 = 轮任务、聊天 = 用户消息正文；200 个码点截断；撤回 / 没有文字 → null
 * - 替补的 Turn 只列在替补那边；VOIDED 的轮照常列
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

const TS = (minute: number) => new Date(Date.UTC(2026, 10, 2, 0, minute)).toISOString();

async function env() {
  const dir = mkdtempSync(join(tmpdir(), "room-activity-"));
  dirs.push(dir);
  const db = openDatabase(join(dir, "room.db"));
  // 这些用例只关心 activity 的查询/排序/截断，不建 Run 那套完整链路：关掉外键，用占位的 run_id 满足 CHECK 约束
  db.pragma("foreign_keys = OFF");
  const queue = new WriteQueue();
  const projectId = "prj_" + ulid();
  db.prepare("INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)").run(projectId, "迁移方案", TS(0));
  return { db, queue, projectId };
}

function addRound(
  db: ReturnType<typeof openDatabase>,
  projectId: string,
  input: { index: number; task: string; state?: string; id?: string; voidReason?: string },
): string {
  const id = input.id ?? "rnd_" + ulid();
  db.prepare(
    "INSERT INTO rounds (id, project_id, round_index, state, task, task_source, recipients, history_mode, void_reason, created_at) " +
      "VALUES (?, ?, ?, ?, ?, 'human', '[\"deepseek\",\"codex\"]', 'recent_with_summaries', ?, ?)",
  ).run(id, projectId, input.index, input.state ?? "SUMMARIZED", input.task, input.voidReason ?? null, TS(0));
  return id;
}

function addTurn(
  db: ReturnType<typeof openDatabase>,
  roundId: string,
  input: { agent: string; outcome: string; at: string; onBehalfOf?: string | null; isSummary?: boolean },
): string {
  const id = "turn_" + ulid();
  const snapshotId = "snap_" + ulid();
  const approvalId = "apr_" + ulid();
  db.prepare(
    "INSERT INTO prompt_snapshots (id, project_id, content, content_hash, nonce, contribution_ids, task_instruction, " +
      "reviewer_agent, adapter_version, token_estimate, created_at) " +
      "SELECT ?, project_id, 'P', '" + "a".repeat(64) + "', '0123456789abcdef', '[]', 't', ?, 'discussion-v2', 1, ? FROM rounds WHERE id = ?",
  ).run(snapshotId, input.agent, input.at, roundId);
  db.prepare("INSERT INTO approvals (id, project_id, snapshot_id, state, created_at) SELECT ?, project_id, ?, 'APPROVED', ? FROM prompt_snapshots WHERE id = ?").run(
    approvalId,
    snapshotId,
    input.at,
    snapshotId,
  );
  const roundRow = db.prepare("SELECT id FROM batches WHERE round_id = ? LIMIT 1").get(roundId) as { id: string } | undefined;
  let batchId = roundRow?.id;
  if (batchId === undefined) {
    batchId = "bat_" + ulid();
    db.prepare("INSERT INTO batches (id, project_id, round_id, kind, state, created_at) SELECT ?, project_id, ?, 'initial', 'APPROVED', ? FROM rounds WHERE id = ?").run(
      batchId,
      roundId,
      input.at,
      roundId,
    );
  }
  // 这些 outcome 在 schema 里要求有 run_id（外键已关，占位值够）
  const needsRun = ["running", "answered", "skipped", "failed", "cancelled"].includes(input.outcome);
  const runId = needsRun ? "run_" + ulid() : null;
  // answered 的 Turn 在 schema 里必须有回答消息（messages 的 reviewer_output 还要挂 run）
  let replyMessageId: string | null = null;
  if (input.outcome === "answered") {
    replyMessageId = "msg_" + ulid();
    db.prepare(
      "INSERT INTO messages (id, project_id, kind, source_agent, run_id, content, created_at) SELECT ?, project_id, 'reviewer_output', ?, ?, '回答', ? FROM rounds WHERE id = ?",
    ).run(replyMessageId, input.agent, runId, input.at, roundId);
  }
  db.prepare(
    "INSERT INTO turns (id, round_id, batch_id, agent, on_behalf_of, is_summary, approval_id, run_id, outcome, reply_message_id, created_at, finished_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    id,
    roundId,
    batchId,
    input.agent,
    input.onBehalfOf ?? null,
    input.isSummary === true ? 1 : 0,
    approvalId,
    runId,
    input.outcome,
    replyMessageId,
    input.at,
    input.outcome === "pending" || input.outcome === "running" ? null : input.at,
  );
  return id;
}

function addConversation(
  db: ReturnType<typeof openDatabase>,
  input: { kind: "direct" | "group"; members: string[]; title?: string | null; at: string },
): string {
  const id = "conv_" + ulid();
  db.prepare(
    "INSERT INTO conversations (id, kind, direct_agent, title, pinned, muted, last_read_message_id, last_activity_at, created_at) " +
      "VALUES (?, ?, ?, ?, 0, 0, NULL, ?, ?)",
  ).run(id, input.kind, input.kind === "direct" ? input.members[0]! : null, input.title ?? null, input.at, input.at);
  const insertMember = db.prepare("INSERT INTO conversation_members (conversation_id, agent, ordinal) VALUES (?, ?, ?)");
  input.members.forEach((agent, index) => insertMember.run(id, agent, index));
  return id;
}

function addUserMessage(
  db: ReturnType<typeof openDatabase>,
  conversationId: string,
  input: { content: string; state?: "sent" | "retracted"; at: string },
): string {
  const id = "cmsg_" + ulid();
  db.prepare(
    "INSERT INTO chat_messages (id, conversation_id, sender, created_at, content, mentions, quote_message_id, replaces_message_id, state, retracted_at, request_hash) " +
      "VALUES (?, ?, 'user', ?, ?, '{\"kind\":\"none\"}', NULL, NULL, ?, ?, NULL)",
  ).run(id, conversationId, input.at, input.content, input.state ?? "sent", input.state === "retracted" ? input.at : null);
  return id;
}

function addSlot(
  db: ReturnType<typeof openDatabase>,
  conversationId: string,
  messageId: string,
  input: { agent: string; outcome: string; at: string },
): string {
  const id = "slot_" + ulid();
  const needsRun = ["running", "skipped", "failed", "cancelled"].includes(input.outcome);
  db.prepare(
    "INSERT INTO chat_reply_slots (id, conversation_id, user_message_id, agent, required, outcome, run_id, attempt, reply_message_id, failure, unavailable_reason, created_at, finished_at) " +
      "VALUES (?, ?, ?, ?, 0, ?, ?, 1, NULL, ?, NULL, ?, ?)",
  ).run(
    id,
    conversationId,
    messageId,
    input.agent,
    input.outcome,
    needsRun ? "crun_" + ulid() : null,
    input.outcome === "failed" ? JSON.stringify({ kind: "run_failed", message: "x" }) : null,
    input.at,
    input.outcome === "running" ? null : input.at,
  );
  return id;
}

const textContent = (text: string) => JSON.stringify({ kind: "text", text, attachments: [] });

describe("D-44 agents.activity", () => {
  it("current 正序、recent 倒序，讨论和聊天按 (createdAt, id) 合并；替补的 Turn 只列在替补那边", async () => {
    const { db, projectId } = await env();
    try {
      const roundId = addRound(db, projectId, { index: 1, task: "第一轮任务", state: "RUNNING" });
      addTurn(db, roundId, { agent: "deepseek", outcome: "running", at: TS(3) });
      addTurn(db, roundId, { agent: "claude", outcome: "running", at: TS(1), onBehalfOf: "codex" });

      const convId = addConversation(db, { kind: "direct", members: ["deepseek"], at: TS(0) });
      const msgId = addUserMessage(db, convId, { content: textContent("在吗"), at: TS(0) });
      addSlot(db, convId, msgId, { agent: "deepseek", outcome: "running", at: TS(2) });

      const mine = agentActivity(db, "deepseek");
      assert.deepEqual(
        mine.current.map((item) => (item.kind === "discussion" ? item.turn.createdAt : item.slot.createdAt)),
        [TS(2), TS(3)],
        "正序，两表合并",
      );
      assert.equal(mine.recent.length, 0);
      assert.equal(mine.nextCursor, null);

      // 替补：只列在 claude 那边（onBehalfOf 记着代谁），被替的 codex 那边不列
      const claude = agentActivity(db, "claude");
      assert.equal(claude.current.length, 1);
      assert.equal(claude.current[0]!.kind === "discussion" ? claude.current[0]!.turn.onBehalfOf : null, "codex");
      assert.equal(agentActivity(db, "codex").current.length, 0, "被替的人那边不列");
    } finally {
      db.close();
    }
  });

  it("recent 分页：满页给 cursor、before 只翻历史、翻到底 nextCursor 为 null", async () => {
    const { db, projectId } = await env();
    try {
      const roundId = addRound(db, projectId, { index: 2, task: "任务" });
      for (let i = 1; i <= 5; i += 1) addTurn(db, roundId, { agent: "deepseek", outcome: "answered", at: TS(i) });

      const first = agentActivity(db, "deepseek", { limit: 2 });
      assert.equal(first.recent.length, 2);
      assert.deepEqual(first.recent.map((item) => (item.kind === "discussion" ? item.turn.createdAt : "")), [TS(5), TS(4)]);
      assert.ok(first.nextCursor !== null, "满页给 cursor");
      assert.equal(first.nextCursor!.createdAt, TS(4), "cursor = 本页最后一条");
      assert.equal(first.current.length, 0, "没有进行中的");

      const second = agentActivity(db, "deepseek", { limit: 2, before: first.nextCursor! });
      assert.deepEqual(second.recent.map((item) => (item.kind === "discussion" ? item.turn.createdAt : "")), [TS(3), TS(2)]);
      assert.ok(second.nextCursor !== null);

      const third = agentActivity(db, "deepseek", { limit: 2, before: second.nextCursor! });
      assert.deepEqual(third.recent.map((item) => (item.kind === "discussion" ? item.turn.createdAt : "")), [TS(1)]);
      assert.equal(third.nextCursor, null, "不足 limit 条 = 到头了");

      // 传了 before 时 current 为空（只翻历史）
      const liveRound = addRound(db, projectId, { index: 3, task: "进行中", state: "RUNNING" });
      addTurn(db, liveRound, { agent: "deepseek", outcome: "running", at: TS(9) });
      const paged = agentActivity(db, "deepseek", { limit: 2, before: first.nextCursor! });
      assert.equal(paged.current.length, 0);
    } finally {
      db.close();
    }
  });

  it("恰好满一页（不多不少）时也给 cursor，下一页为空（林离 #163 第二档）", async () => {
    const { db, projectId } = await env();
    try {
      const roundId = addRound(db, projectId, { index: 1, task: "任务" });
      addTurn(db, roundId, { agent: "deepseek", outcome: "answered", at: TS(1) });
      addTurn(db, roundId, { agent: "deepseek", outcome: "answered", at: TS(2) });

      const full = agentActivity(db, "deepseek", { limit: 2 });
      assert.equal(full.recent.length, 2);
      assert.ok(full.nextCursor !== null, "满页就给 cursor，即使这是最后一页");
      const lastItem = full.recent[1]!;
      const lastKey = lastItem.kind === "discussion" ? lastItem.turn : lastItem.slot;
      assert.deepEqual(full.nextCursor, { createdAt: lastKey.createdAt, id: lastKey.id }, "cursor = 本页最后一条");

      const empty = agentActivity(db, "deepseek", { limit: 2, before: full.nextCursor! });
      assert.deepEqual([empty.recent.length, empty.nextCursor], [0, null], "下一页为空，这才到头");
    } finally {
      db.close();
    }
  });

  it("preview：讨论 = 轮任务、聊天 = 用户消息正文；200 码点截断；撤回 / 没有文字 → null", async () => {
    const { db, projectId } = await env();
    try {
      const longTask = "字".repeat(150) + "😀".repeat(100);
      const roundId = addRound(db, projectId, { index: 1, task: longTask });
      addTurn(db, roundId, { agent: "deepseek", outcome: "answered", at: TS(1) });

      const convId = addConversation(db, { kind: "group", members: ["deepseek", "codex"], title: "群聊", at: TS(0) });
      const retracted = addUserMessage(db, convId, { content: textContent("我不会出现在控制台"), state: "retracted", at: TS(2) });
      addSlot(db, convId, retracted, { agent: "deepseek", outcome: "retracted", at: TS(2) });
      const sticker = addUserMessage(db, convId, { content: JSON.stringify({ kind: "sticker", stickerId: "stk_1", image: "img_1", label: "笑" }), at: TS(3) });
      addSlot(db, convId, sticker, { agent: "deepseek", outcome: "skipped", at: TS(3) });

      const page = agentActivity(db, "deepseek");
      const byTime = new Map(page.recent.map((item) => [item.kind === "discussion" ? item.turn.createdAt : item.slot.createdAt, item]));
      const disc = byTime.get(TS(1))!;
      assert.equal(disc.kind, "discussion");
      if (disc.kind === "discussion") {
        assert.equal(disc.projectName, "迁移方案");
        assert.equal(disc.roundIndex, 1);
        assert.ok(disc.preview !== null);
        assert.equal(Array.from(disc.preview!).length, 200, "按码点截到 200");
        assert.ok(!/[\uD800-\uDBFF]$/.test(disc.preview!), "不留半个代理对");
      }

      const retractedItem = page.recent.find((item) => item.kind === "chat" && item.slot.createdAt === TS(2))!;
      assert.equal(retractedItem.kind, "chat");
      if (retractedItem.kind === "chat") {
        assert.equal(retractedItem.preview, null, "撤回的消息不给预览");
        assert.deepEqual(retractedItem.conversation.members, ["deepseek", "codex"], "会话成员按 ordinal");
        assert.equal(retractedItem.conversation.title, "群聊");
      }

      const stickerItem = page.recent.find((item) => item.kind === "chat" && item.slot.createdAt === TS(3))!;
      assert.equal(stickerItem.kind === "chat" ? stickerItem.preview : "x", null, "表情没有文字 → null");
    } finally {
      db.close();
    }
  });

  it("current 有硬上限：超出只保留最近的 200 条", async () => {
    const { db, projectId } = await env();
    try {
      const convId = addConversation(db, { kind: "direct", members: ["deepseek"], at: TS(0) });
      const total = AGENT_ACTIVITY_CURRENT_MAX + 5;
      for (let i = 0; i < total; i += 1) {
        const msgId = addUserMessage(db, convId, { content: textContent("第 " + i + " 条"), at: TS(0) });
        addSlot(db, convId, msgId, { agent: "deepseek", outcome: "running", at: new Date(Date.UTC(2026, 10, 2, 1, 0, i)).toISOString() });
      }
      const page = agentActivity(db, "deepseek");
      assert.equal(page.current.length, AGENT_ACTIVITY_CURRENT_MAX);
      // 保留的是最近的那些：最后一条在最末
      const last = page.current[page.current.length - 1]!;
      assert.equal(last.kind === "chat" ? last.slot.createdAt : "", new Date(Date.UTC(2026, 10, 2, 1, 0, total - 1)).toISOString());
    } finally {
      db.close();
    }
  });

  it("作废（VOIDED）的轮里的 Turn 照常列出", async () => {
    const { db, projectId } = await env();
    try {
      const roundId = addRound(db, projectId, { index: 1, task: "作废的轮", state: "VOIDED", voidReason: "改方向" });
      addTurn(db, roundId, { agent: "deepseek", outcome: "interrupted", at: TS(1) });
      const page = agentActivity(db, "deepseek");
      assert.equal(page.recent.length, 1);
      assert.equal(page.recent[0]!.kind === "discussion" ? page.recent[0]!.turn.outcome : null, "interrupted");
    } finally {
      db.close();
    }
  });

  it("truncatePreview：不超时原样，超了按码点截", () => {
    assert.equal(truncatePreview("短的"), "短的");
    const emoji = "😀".repeat(250);
    const cut = truncatePreview(emoji);
    assert.equal(Array.from(cut).length, 200);
    assert.ok(cut === "😀".repeat(200));
  });
});
