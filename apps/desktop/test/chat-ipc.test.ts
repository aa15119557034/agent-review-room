import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  insertChatMessage,
  insertChatRun,
  insertChatSlot,
  insertChatSnapshot,
  openDatabase,
  ulid,
  WriteQueue,
} from "@room/db";
import {
  CHAT_LIMITS,
  ControlEvent,
  type AgentEvent,
  type AgentModelSettings,
  type CommandRequest,
  type ProfileModels,
} from "@room/schemas";
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
  /** 每次 adapterFactory 收到的目标（看模型有没有传下去） */
  targets: ChatRunTarget[];
}

async function makeHarness(
  options: {
    scripts?: Record<string, Script>;
    paused?: string[];
    unavailableProfiles?: string[];
    /** 这些 agent 的 adapter 一直等到被 abort 才结束（测取消 / 中断修复） */
    hold?: string[];
    profileModels?: ProfileModels[];
    modelSettings?: Record<string, AgentModelSettings>;
  } = {},
): Promise<Harness> {
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

  for (const [agentId, settings] of Object.entries(options.modelSettings ?? {})) {
    db.prepare("UPDATE agents SET model_settings = ? WHERE id = ?").run(JSON.stringify(settings), agentId);
  }

  const scripts = options.scripts ?? {};
  const events: ControlEvent[] = [];
  const targets: ChatRunTarget[] = [];
  const held = new Set(options.hold ?? []);
  const chat = new ChatService({
    db,
    queue,
    repo,
    settings,
    emit: (event) => events.push(ControlEvent.parse(event)),
    adapterFactory: async (target: ChatRunTarget) => {
      targets.push(target);
      if (held.has(target.agent)) {
        return {
          id: "hold",
          kind: "api" as const,
          initialize: async () => ({ streaming: true, permissionRequests: false, readOnly: true }),
          startSession: async () => ({ sessionId: "hold", adapterId: "hold" }),
          closeSession: async () => undefined,
          run: async function* (_sessionId, runId, _input, opts) {
            await new Promise<void>((resolve) => {
              if (opts.signal.aborted) resolve();
              else opts.signal.addEventListener("abort", () => resolve(), { once: true });
            });
            yield { eventId: runId + "-0", runId, seq: 0, ts: NOW, type: "cancelled" } as AgentEvent;
          },
        };
      }
      return fakeAdapter(scripts[target.agent] ?? reply("好的"));
    },
    probe: async (params) => ({
      reachable: true,
      health: {
        protocol: 1,
        nodeId: "controller-local",
        profiles: ["claude-chat", "codex-chat", "deepseek-chat"],
        activeRuns: 0,
        maxConcurrentRuns: 4,
        leaseMs: 30_000,
        heartbeatMs: 5_000,
        ...(options.profileModels === undefined ? {} : { profileModels: options.profileModels }),
      },
      // profileAvailable 是 per-profile 的：同节点上不同秘书不能共用一次探测结果
      profileAvailable: !(options.unavailableProfiles ?? []).includes(params.profileId),
      latencyMs: 1,
    }),
    now: () => NOW,
  });

  const conversation = await chat.createConversation({
    type: "chat.conversation.create",
    members: { kind: "direct", agent: "deepseek" },
    title: null,
  } as never);
  return { chat, repo, db, events, conversationId: conversation.id, targets };
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

  it("probes per profile even on the same node", async () => {
    const h = await makeHarness({ unavailableProfiles: ["codex-chat"] });
    try {
      const group = await h.chat.createConversation({
        type: "chat.conversation.create",
        members: { kind: "group", agents: ["claude", "codex"] },
        title: null,
      } as never);
      const sent = await h.chat.send(send(group.id, userMessageId(60), "都在吗"));
      const byAgent = Object.fromEntries(sent.slots.map((slot) => [slot.agent, slot]));
      assert.equal(byAgent["claude"]?.outcome, "running");
      assert.equal(byAgent["codex"]?.outcome, "unavailable");
      assert.equal(byAgent["codex"]?.unavailableReason, "offline");
      assert.equal(sent.runs.length, 1, "只有 claude 起 Run");
      await settle(h.chat);
    } finally {
      h.db.close();
    }
  });

  it("two concurrent sends with the same messageId return the first result, not internal", async () => {
    const h = await makeHarness();
    try {
      const command = send(h.conversationId, userMessageId(70), "并发同一条");
      const results = await Promise.allSettled([h.chat.send(command), h.chat.send(command)]);
      assert.equal(results.filter((result) => result.status === "fulfilled").length, 2, JSON.stringify(results));
      const ids = new Set(
        results.map((result) => (result as PromiseFulfilledResult<{ message: { id: string } }>).value.message.id),
      );
      assert.equal(ids.size, 1);
      const stored = h.db.prepare("SELECT count(*) AS n FROM chat_messages WHERE sender = 'user'").get() as { n: number };
      assert.equal(stored.n, 1);
      await settle(h.chat);
    } finally {
      h.db.close();
    }
  });

  it("cannot exceed the per-minute limit with concurrent sends", async () => {
    const h = await makeHarness();
    try {
      const results = await Promise.allSettled(
        Array.from({ length: 7 }, (_, index) => h.chat.send(send(h.conversationId, userMessageId(80 + index), "并发 " + index))),
      );
      const rejected = results.filter((result) => result.status === "rejected");
      assert.equal(rejected.length, 1);
      assert.equal((rejected[0] as PromiseRejectedResult).reason.code, "rate_limited");
      const stored = h.db.prepare("SELECT count(*) AS n FROM chat_messages WHERE sender = 'user'").get() as { n: number };
      assert.equal(stored.n, CHAT_LIMITS.messagesPerMinute);
      await settle(h.chat);
    } finally {
      h.db.close();
    }
  });

  it("classifies a blank reply as empty_output, not parse_error", async () => {
    const h = await makeHarness({ scripts: { deepseek: reply("   ") } });
    try {
      const sent = await h.chat.send(send(h.conversationId, userMessageId(90), "说点什么"));
      await settle(h.chat);
      const page = h.chat.listMessages({ type: "chat.messages.list", conversationId: h.conversationId, limit: 10 } as never);
      assert.equal(page.slots[0]?.outcome, "failed");
      assert.equal(page.slots[0]?.failure?.kind, "empty_output");
      assert.equal(page.messages.length, 1);
      assert.equal(h.chat.listSlotRuns(sent.slots[0]!.id)[0]?.state, "COMPLETED");
    } finally {
      h.db.close();
    }
  });

  it("retries with the context from before the original message", async () => {
    const scripts: Record<string, Script> = { deepseek: [{ type: "error", reason: "internal", message: "boom" }] };
    const h = await makeHarness({ scripts });
    try {
      const first = await h.chat.send(send(h.conversationId, userMessageId(95), "问题 A"));
      await settle(h.chat);
      scripts["deepseek"] = reply("好的");
      await h.chat.send(send(h.conversationId, userMessageId(96), "后来的 B"));
      await h.chat.send(send(h.conversationId, userMessageId(97), "后来的 C"));
      await settle(h.chat);

      const retried = await h.chat.retry({ type: "chat.retry", slotId: first.slots[0]!.id } as never);
      const snapshot = h.chat.getSnapshot(retried.run.snapshotId);
      assert.ok(!snapshot.includedMessageIds.includes(userMessageId(96)), "重试看不到 B");
      assert.ok(!snapshot.includedMessageIds.includes(userMessageId(97)), "重试看不到 C");
      assert.ok(snapshot.includedMessageIds.includes(userMessageId(95)), "能看到原来的问题");
      await settle(h.chat);
    } finally {
      h.db.close();
    }
  });

  it("counts only agent messages as unread", async () => {
    const h = await makeHarness();
    try {
      await h.chat.send(send(h.conversationId, userMessageId(98), "在吗"));
      await settle(h.chat);
      const item = h.chat.listConversations().find((entry) => entry.conversation.id === h.conversationId);
      assert.ok(item !== undefined);
      assert.equal(item.unreadCount, 1, "只有秘书那一条算未读");
    } finally {
      h.db.close();
    }
  });

  it("selects the chat model from modelSettings and passes it to the node", async () => {
    const efforts = [
      { id: "low", displayName: "低", note: null },
      { id: "high", displayName: "高", note: null },
    ];
    const h = await makeHarness({
      modelSettings: {
        deepseek: { primaryModel: "deepseek-flash", fallbackModel: null, effort: { chat: "high", discussion: null, summary: null } },
      },
      profileModels: [
        {
          profileId: "deepseek-chat",
          models: [{ id: "deepseek-flash", displayName: "Flash", efforts, defaultEffort: "low" }],
        },
      ],
    });
    try {
      const sent = await h.chat.send(send(h.conversationId, userMessageId(100), "用哪个模型？"));
      const run = h.chat.getRun(sent.runs[0]!.id);
      assert.deepEqual(run.model, { model: "deepseek-flash", effort: "high", usedFallback: false, effortSource: "configured" });
      await settle(h.chat);
      // adapter 是异步起的：等 Run 跑完再看节点收到的目标
      assert.deepEqual(h.targets[0]?.model, { model: "deepseek-flash", effort: "high" });
      assert.equal(h.targets[0]?.profileId, "deepseek-chat");
    } finally {
      h.db.close();
    }
  });

  it("falls back to the fallback model and marks usedFallback", async () => {
    const h = await makeHarness({
      modelSettings: {
        deepseek: { primaryModel: "missing-model", fallbackModel: "deepseek-flash", effort: { chat: null, discussion: null, summary: null } },
      },
      profileModels: [
        {
          profileId: "deepseek-chat",
          models: [{ id: "deepseek-flash", displayName: "Flash", efforts: [{ id: "low", displayName: "低", note: null }], defaultEffort: "low" }],
        },
      ],
    });
    try {
      const sent = await h.chat.send(send(h.conversationId, userMessageId(101), "备选"));
      assert.deepEqual(h.chat.getRun(sent.runs[0]!.id).model, {
        model: "deepseek-flash",
        effort: "low",
        usedFallback: true,
        effortSource: "node_default",
      });
      await settle(h.chat);
    } finally {
      h.db.close();
    }
  });

  it("marks the slot unavailable when neither configured model exists", async () => {
    const h = await makeHarness({
      modelSettings: {
        deepseek: { primaryModel: "ghost-a", fallbackModel: "ghost-b", effort: { chat: null, discussion: null, summary: null } },
      },
      profileModels: [
        { profileId: "deepseek-chat", models: [{ id: "deepseek-flash", displayName: "Flash", efforts: [], defaultEffort: null }] },
      ],
    });
    try {
      const sent = await h.chat.send(send(h.conversationId, userMessageId(102), "模型都不在"));
      assert.equal(sent.slots[0]?.outcome, "unavailable");
      assert.equal(sent.slots[0]?.unavailableReason, "unconfigured");
      assert.equal(sent.runs.length, 0);
      assert.equal(h.targets.length, 0);
    } finally {
      h.db.close();
    }
  });

  it("re-edits a retracted message as a new message with new slots", async () => {
    const h = await makeHarness();
    try {
      const first = await h.chat.send(send(h.conversationId, userMessageId(110), "打错了"));
      await settle(h.chat);
      await h.chat.retract({ type: "chat.retract", messageId: first.message.id } as never);

      const edited = await h.chat.send({
        ...send(h.conversationId, userMessageId(111), "改好了"),
        replacesMessageId: first.message.id,
      });
      assert.equal(edited.message.replacesMessageId, first.message.id);
      assert.equal(edited.slots[0]?.outcome, "running");
      const old = h.chat.listMessages({ type: "chat.messages.list", conversationId: h.conversationId, limit: 20 } as never);
      assert.equal(old.messages.find((message) => message.id === first.message.id)?.state, "retracted");
      assert.equal(old.slots.find((slot) => slot.userMessageId === first.message.id)?.outcome, "retracted");
      await settle(h.chat);
    } finally {
      h.db.close();
    }
  });

  it("cancels a running reply and lets the late terminal close only the run", async () => {
    const h = await makeHarness({ hold: ["deepseek"] });
    try {
      const sent = await h.chat.send(send(h.conversationId, userMessageId(120), "慢慢答"));
      const cancelled = await h.chat.cancelReply({ type: "chat.cancelReply", slotId: sent.slots[0]!.id } as never);
      assert.equal(cancelled.outcome, "cancelled");
      await settle(h.chat);
      const runs = h.chat.listSlotRuns(sent.slots[0]!.id);
      assert.equal(runs[0]?.state, "CANCELLED");
      assert.equal(h.chat.listMessages({ type: "chat.messages.list", conversationId: h.conversationId, limit: 10 } as never).slots[0]?.outcome, "cancelled");
    } finally {
      h.db.close();
    }
  });

  it("repairs an interrupted chat run on startup", async () => {
    const h = await makeHarness();
    try {
      // 直接造一个「上次崩溃时停在 RUNNING」的库状态（不经过 ChatService.send，避免和活着的执行器抢）
      const messageId = userMessageId(130);
      insertChatMessage(h.db, {
        message: {
          id: messageId,
          conversationId: h.conversationId,
          createdAt: NOW,
          sender: "user",
          content: { kind: "text", text: "重启前", attachments: [] },
          mentions: { kind: "none" },
          quoteMessageId: null,
          replacesMessageId: null,
          state: "sent",
          retractedAt: null,
        },
      });
      const slotId = "slot_" + ulid();
      const runId = "run_" + ulid();
      insertChatSlot(h.db, {
        id: slotId,
        conversationId: h.conversationId,
        userMessageId: messageId,
        agent: "deepseek",
        required: true,
        outcome: "running",
        runId,
        attempt: 1,
        replyMessageId: null,
        failure: null,
        unavailableReason: null,
        createdAt: NOW,
        finishedAt: null,
      });
      insertChatSnapshot(h.db, {
        id: "snap_" + ulid(),
        purpose: "reply",
        conversationId: h.conversationId,
        userMessageId: messageId,
        agent: "deepseek",
        content: "上下文",
        contentHash: "a".repeat(64),
        nonce: "0123456789abcdef",
        memorySlot: null,
        includedMessageIds: [messageId],
        includedSummaryIds: [],
        adapterVersion: "chat-v2",
        tokenEstimate: 1,
        createdAt: NOW,
      });
      const snapshotId = h.db.prepare("SELECT id FROM chat_snapshots").get() as { id: string };
      insertChatRun(h.db, {
        id: runId,
        kind: "chat",
        purpose: "reply",
        conversationId: h.conversationId,
        slotId,
        agent: "deepseek",
        snapshotId: snapshotId.id,
        snapshotHash: "a".repeat(64),
        finalPromptHash: null,
        memoryManifest: null,
        model: null,
        adapterId: "remote:deepseek-chat",
        state: "QUEUED",
        substate: null,
        failureReason: null,
        createdAt: NOW,
        startedAt: null,
        finishedAt: null,
      });
      h.db.prepare("UPDATE chat_runs SET state = 'RUNNING', substate = 'active', started_at = ? WHERE id = ?").run(NOW, runId);

      const repaired = await h.chat.repairInterrupted();
      assert.equal(repaired, 1);
      const runs = h.chat.listSlotRuns(slotId);
      assert.equal(runs[0]?.state, "FAILED");
      assert.equal(runs[0]?.failureReason, "interrupted");
      const page = h.chat.listMessages({ type: "chat.messages.list", conversationId: h.conversationId, limit: 10 } as never);
      assert.equal(page.slots[0]?.outcome, "failed");
      assert.equal(page.slots[0]?.failure?.kind, "interrupted");
    } finally {
      h.db.close();
    }
  });

  it("converts selected messages into a topic with one chat_material", async () => {
    const h = await makeHarness({ scripts: { deepseek: reply("我也觉得") } });
    try {
      await h.chat.send(send(h.conversationId, userMessageId(140), "把这段转成议题"));
      await settle(h.chat);
      const page = h.chat.listMessages({ type: "chat.messages.list", conversationId: h.conversationId, limit: 10 } as never);
      const ids = page.messages.map((message) => message.id);

      const result = await h.chat.toTopic({
        type: "chat.toTopic",
        conversationId: h.conversationId,
        messageIds: ids,
        name: "从聊天来的议题",
      } as never);

      assert.equal(result.project.name, "从聊天来的议题");
      assert.equal(result.project.fromConversationId, h.conversationId);
      assert.equal(result.material.kind, "chat_material");
      assert.deepEqual([...result.material.chatMessageIds].sort(), [...ids].sort());
      assert.ok(result.material.content.includes("把这段转成议题"));
      assert.ok(result.material.content.includes("我也觉得"));
      assert.ok(result.material.content.includes("汐"), "秘书用显示名");

      // repository 读得出来（讨论室后面直接用它当材料）
      const stored = h.repo.getMessage(result.material.id);
      assert.equal(stored.kind, "chat_material");
      if (stored.kind === "chat_material") assert.deepEqual([...stored.chatMessageIds].sort(), [...ids].sort());
    } finally {
      h.db.close();
    }
  });

  it("refuses to convert retracted messages or messages from another conversation", async () => {
    const h = await makeHarness();
    try {
      const sent = await h.chat.send(send(h.conversationId, userMessageId(141), "撤回我"));
      await settle(h.chat);
      await h.chat.retract({ type: "chat.retract", messageId: sent.message.id } as never);
      await assert.rejects(
        h.chat.toTopic({
          type: "chat.toTopic",
          conversationId: h.conversationId,
          messageIds: [sent.message.id],
          name: "不该建出来",
        } as never),
        (error: unknown) => (error as { code?: string }).code === "invalid_state",
      );

      const other = await h.chat.createConversation({
        type: "chat.conversation.create",
        members: { kind: "direct", agent: "codex" },
        title: null,
      } as never);
      await assert.rejects(
        h.chat.toTopic({
          type: "chat.toTopic",
          conversationId: h.conversationId,
          messageIds: [userMessageId(142)],
          name: "别处的消息",
        } as never),
        (error: unknown) => (error as { code?: string }).code === "validation_failed",
      );
      assert.notEqual(other.id, h.conversationId);

      await assert.rejects(
        h.chat.toTopic({
          type: "chat.toTopic",
          conversationId: h.conversationId,
          messageIds: [userMessageId(143), userMessageId(143)],
          name: "重复",
        } as never),
        (error: unknown) => (error as { code?: string }).code === "validation_failed",
      );
    } finally {
      h.db.close();
    }
  });

  it("refuses to build a material larger than the message limit", async () => {
    const h = await makeHarness();
    try {
      const ids: string[] = [];
      for (let index = 0; index < 101; index += 1) {
        const id = "cmsg_" + String(index).padStart(26, "0");
        ids.push(id);
        insertChatMessage(h.db, {
          message: {
            id,
            conversationId: h.conversationId,
            createdAt: NOW,
            sender: "user",
            content: { kind: "text", text: "长".repeat(20_000), attachments: [] },
            mentions: { kind: "none" },
            quoteMessageId: null,
            replacesMessageId: null,
            state: "sent",
            retractedAt: null,
          },
        });
      }
      await assert.rejects(
        h.chat.toTopic({ type: "chat.toTopic", conversationId: h.conversationId, messageIds: ids, name: "太大" } as never),
        (error: unknown) => (error as { code?: string }).code === "validation_failed",
      );
      assert.equal((h.db.prepare("SELECT count(*) AS n FROM projects").get() as { n: number }).n, 0);
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