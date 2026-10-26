import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { openDatabase, WriteQueue } from "@room/db";
import { ControlEvent, type AgentEvent, type CommandRequest } from "@room/schemas";
import type { AgentAdapter } from "@room/core";
import { ChatService, type ChatRunTarget } from "../src/main/chat";
import { Repository } from "../src/main/repository";
import { SettingsStore, type SafeStorageLike } from "../src/main/settings";

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

const NOW = "2026-10-26T00:00:00.000Z";
const NODE_URL = "http://192.168.1.20:7420";
const ID = "0".repeat(26);

const fakeSafeStorage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (plain: string) => Buffer.from(plain, "utf8"),
  decryptString: (encrypted: Buffer) => encrypted.toString("utf8"),
};

type Script = Record<string, unknown>[];

function fakeAdapter(script: Script): AgentAdapter {
  return {
    id: "fake",
    kind: "api",
    initialize: async () => ({ streaming: true, permissionRequests: false, readOnly: true }),
    startSession: async () => ({ sessionId: "sess_1", adapterId: "fake" }),
    closeSession: async () => undefined,
    run: async function* (_sessionId, runId) {
      let seq = 0;
      for (const part of script) {
        yield { eventId: runId + "-" + seq, runId, seq: seq++, ts: NOW, ...part } as AgentEvent;
      }
    },
  };
}

function reply(text: string): Script {
  return [
    { type: "message_delta", text: "想一下" },
    { type: "message_complete", text: JSON.stringify({ kind: "reply", text }) },
    { type: "completed" },
  ];
}

function skip(): Script {
  return [
    { type: "message_complete", text: JSON.stringify({ kind: "skip" }) },
    { type: "completed" },
  ];
}

interface Harness {
  chat: ChatService;
  repo: Repository;
  db: ReturnType<typeof openDatabase>;
  events: ControlEvent[];
  conversationId: string;
}

async function makeHarness(options: { scripts?: Record<string, Script>; paused?: string[] } = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "room-chat-ipc-"));
  dirs.push(dir);
  const db = openDatabase(join(dir, "test.db"));
  const queue = new WriteQueue();
  const repo = new Repository(db, queue);
  const settings = new SettingsStore(join(dir, "settings.json"), fakeSafeStorage);
  settings.upsertNode("controller-local", { baseUrl: NODE_URL, token: "t".repeat(40) });
  await repo.upsertNodeRow({ id: "controller-local", label: "主控机", baseUrl: NODE_URL });

  const addAgent = db.prepare(
    "INSERT INTO agents (id, display_name, color, role_note, can_discuss, can_summarize, can_execute, node_id, " +
      "profile_id, chat_profile_id, chat_persona, paused_by_user, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, 1, 0, 0, 'controller-local', ?, ?, ?, ?, ?, ?)",
  );
  const paused = new Set(options.paused ?? []);
  for (const [id, name] of [["claude", "C酱"], ["codex", "林离"], ["deepseek", "汐"]] as const) {
    addAgent.run(
      id, name, "#1f6b55", "人设", id + "-review", id + "-chat", "你是" + name, paused.has(id) ? 1 : 0, NOW, NOW,
    );
  }

  const scripts = options.scripts ?? {};
  const events: ControlEvent[] = [];
  const chat = new ChatService({
    db,
    queue,
    repo,
    settings,
    emit: (event) => events.push(ControlEvent.parse(event)),
    adapterFactory: async (target: ChatRunTarget) => fakeAdapter(scripts[target.agent] ?? reply("好的")),
    probe: async () => ({
      reachable: true,
      health: {
        protocol: 1,
        nodeId: "controller-local",
        profiles: ["claude-chat", "codex-chat", "deepseek-chat"],
        activeRuns: 0,
        maxConcurrentRuns: 4,
        leaseMs: 30_000,
        heartbeatMs: 5_000,
      },
      profileAvailable: true,
      latencyMs: 1,
    }),
    now: () => NOW,
  });

  const conversation = await chat.createConversation({
    type: "chat.conversation.create",
    members: { kind: "direct", agent: "deepseek" },
    title: null,
  } as never);
  return { chat, repo, db, events, conversationId: conversation.id };
}

const userMessageId = (n: number): string => "cmsg_" + String(n).padStart(26, "0");

async function settle(chat: ChatService): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (chat.activeCount() === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("chat runs did not settle");
}

function send(conversationId: string, messageId: string, text: string): CommandRequest<"chat.send"> {
  return {
    type: "chat.send",
    conversationId,
    messageId,
    content: { kind: "text", text, attachments: [] },
    mentions: { kind: "none" },
    quoteMessageId: null,
    replacesMessageId: null,
  };
}

describe("chat service (D-31b)", () => {
  it("sends a direct message, runs it and stores the reply", async () => {
    const h = await makeHarness({ scripts: { deepseek: reply("在。") } });
    try {
      const result = await h.chat.send(send(h.conversationId, userMessageId(1), "在吗"));
      assert.equal(result.message.sender, "user");
      assert.equal(result.slots.length, 1);
      assert.equal(result.slots[0]?.outcome, "running");
      assert.equal(result.runs.length, 1);
      await settle(h.chat);

      const page = h.chat.listMessages({
        type: "chat.messages.list",
        conversationId: h.conversationId,
        limit: 20,
      } as never);
      assert.equal(page.messages.length, 2);
      const agent = page.messages.find((message) => message.sender === "agent");
      assert.ok(agent !== undefined && agent.sender === "agent");
      assert.equal(agent.text, "在。");
      const slot = h.chat.listSlotRuns(result.slots[0]!.id);
      assert.equal(slot.length, 1);
      assert.equal(slot[0]?.state, "COMPLETED");
      assert.ok(h.events.some((event) => event.type === "chat.message.created"));
      assert.ok(h.events.some((event) => event.type === "chat.slot.updated" && (event as never as { slot: { outcome: string } }).slot.outcome === "answered"));
    } finally {
      h.db.close();
    }
  });

  it("treats skip as answered-no for unmentioned group members, but as failure when required", async () => {
    const h = await makeHarness({ scripts: { deepseek: skip(), codex: skip() } });
    try {
      const group = await h.chat.createConversation({
        type: "chat.conversation.create",
        members: { kind: "group", agents: ["deepseek", "codex"] },
        title: null,
      } as never);
      const sent = await h.chat.send(send(group.id, userMessageId(2), "随便聊聊"));
      await settle(h.chat);
      const list = h.chat.listMessages({ type: "chat.messages.list", conversationId: group.id, limit: 10 } as never);
      assert.equal(list.messages.length, 1, "skip 不建消息");
      const slot = h.chat.listSlotRuns(sent.slots[0]!.id)[0];
      assert.equal(slot?.state, "COMPLETED");
      const slots = list.slots;
      assert.deepEqual(slots.map((item) => item.outcome).sort(), ["skipped", "skipped"]);

      // 单聊里 skip 算失败
      const fail = await h.chat.send(send(h.conversationId, userMessageId(3), "必须回答"));
      await settle(h.chat);
      const failedSlot = h.chat.listMessages({ type: "chat.messages.list", conversationId: h.conversationId, limit: 10 } as never);
      assert.equal(failedSlot.slots[0]?.outcome, "failed");
      assert.equal(failedSlot.slots[0]?.failure?.kind, "skip_not_allowed");
      assert.equal(h.chat.listSlotRuns(fail.slots[0]!.id)[0]?.state, "COMPLETED");
    } finally {
      h.db.close();
    }
  });

  it("is idempotent by messageId and rejects the same id with different intent", async () => {
    const h = await makeHarness();
    try {
      const command = send(h.conversationId, userMessageId(4), "同一条");
      const first = await h.chat.send(command);
      const second = await h.chat.send(command);
      assert.equal(second.message.id, first.message.id);
      assert.equal(h.chat.listMessages({ type: "chat.messages.list", conversationId: h.conversationId, limit: 10 } as never).messages.length, 1);

      await assert.rejects(
        h.chat.send({ ...command, content: { kind: "text", text: "改了内容", attachments: [] } }),
        (error: unknown) => (error as { code?: string }).code === "idempotency_conflict",
      );
      await settle(h.chat);
    } finally {
      h.db.close();
    }
  });

  it("rate limits after CHAT_LIMITS.messagesPerMinute", async () => {
    const h = await makeHarness();
    try {
      for (let i = 0; i < 6; i += 1) await h.chat.send(send(h.conversationId, userMessageId(10 + i), "第 " + i + " 条"));
      await assert.rejects(
        h.chat.send(send(h.conversationId, userMessageId(20), "第 7 条")),
        (error: unknown) => (error as { code?: string }).code === "rate_limited",
      );
      await settle(h.chat);
    } finally {
      h.db.close();
    }
  });

  it("marks paused agents unavailable and starts no run for them", async () => {
    const h = await makeHarness({ paused: ["deepseek"] });
    try {
      const result = await h.chat.send(send(h.conversationId, userMessageId(30), "在吗"));
      assert.equal(result.slots[0]?.outcome, "unavailable");
      assert.equal(result.slots[0]?.unavailableReason, "paused_by_user");
      assert.equal(result.runs.length, 0);
      assert.equal(h.chat.activeCount(), 0);
    } finally {
      h.db.close();
    }
  });

  it("retries a failed slot with attempt + 1 and the new answer", async () => {
    const scripts: Record<string, Script> = { deepseek: [{ type: "error", reason: "internal", message: "boom" }] };
    const h = await makeHarness({ scripts });
    try {
      const sent = await h.chat.send(send(h.conversationId, userMessageId(50), "先失败一次"));
      await settle(h.chat);
      const failed = h.chat.listMessages({ type: "chat.messages.list", conversationId: h.conversationId, limit: 10 } as never);
      assert.equal(failed.slots[0]?.outcome, "failed");
      assert.equal(failed.slots[0]?.attempt, 1);

      scripts["deepseek"] = reply("第二次答上了");
      const retried = await h.chat.retry({ type: "chat.retry", slotId: sent.slots[0]!.id } as never);
      assert.equal(retried.slot.outcome, "running");
      assert.equal(retried.slot.attempt, 2);
      await settle(h.chat);

      const after = h.chat.listMessages({ type: "chat.messages.list", conversationId: h.conversationId, limit: 10 } as never);
      assert.equal(after.slots[0]?.outcome, "answered");
      assert.equal(after.slots[0]?.attempt, 2);
      const runs = h.chat.listSlotRuns(sent.slots[0]!.id);
      assert.equal(runs.length, 2);
      assert.equal(runs[1]?.state, "COMPLETED");
      assert.equal(after.messages.filter((message) => message.sender === "agent").length, 1);
    } finally {
      h.db.close();
    }
  });

  it("retracts a message and its slots", async () => {
    const h = await makeHarness({ scripts: { deepseek: reply("答完了") } });
    try {
      const sent = await h.chat.send(send(h.conversationId, userMessageId(40), "说点什么"));
      await settle(h.chat);
      const result = await h.chat.retract({ type: "chat.retract", messageId: sent.message.id } as never);
      assert.equal(result.message.state, "retracted");
      assert.equal(result.slots[0]?.outcome, "retracted");
      const list = h.chat.listMessages({ type: "chat.messages.list", conversationId: h.conversationId, limit: 10 } as never);
      assert.equal(list.messages.find((message) => message.id === sent.message.id)?.state, "retracted");
      // 撤回之后不能再发同一个 messageId（意图不同会冲突、相同会返回原消息）
      await assert.rejects(
        h.chat.send(send(h.conversationId, sent.message.id, "再说一次")),
        (error: unknown) => (error as { code?: string }).code === "idempotency_conflict",
      );
    } finally {
      h.db.close();
    }
  });
});
