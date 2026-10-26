import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AgentChatMessage, ChatMessage, ChatReplySlot, ControlEvent, Conversation, ConversationListItem } from "@room/schemas";
import { createMockBridge, type MockOptions } from "../mock/mock-backend";
import { createActions } from "../lib/actions";
import { createClient } from "../lib/client";
import { initialState } from "../lib/state";
import { createStore } from "../lib/store";
import { newId } from "../lib/ids";

/**
 * 聊天 mock 按 C-34 的规则走：单聊、群聊 @、没点名可以 skip、撤回、重试、防重复、转议题。
 * 这也是 C-35 的验收：mock 下跑通单聊、群聊、转议题（最后一组用 actions 从界面那一层走一遍）。
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function ok<T>(p: Promise<{ ok: true; data: T } | { ok: false; error: string; message: string }>): Promise<T> {
  const r = await p;
  if (!r.ok) throw new Error(`${r.error}: ${r.message}`);
  return r.data;
}

function setup(opts: MockOptions = {}) {
  const bridge = createMockBridge({ tickMs: 1, reviewerConfigured: true, ...opts });
  const events: ControlEvent[] = [];
  bridge.onEvent((e) => events.push(e));
  const cmd = <T = any>(req: Record<string, unknown>) => ok<T>(bridge.command(req as never) as never);
  const q = <T = any>(req: Record<string, unknown>) => ok<T>(bridge.query(req as never) as never);
  const raw = (req: Record<string, unknown>) => bridge.command(req as never) as Promise<{ ok: boolean; error?: string }>;
  return { bridge, events, cmd, q, raw };
}

async function until(check: () => Promise<boolean> | boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(5);
  }
  throw new Error("timed out waiting");
}

const text = (t: string) => ({ kind: "text", text: t, attachments: [] });
const sendReq = (conversationId: string, t: string, mentions: Record<string, unknown> = { kind: "none" }, extra: Record<string, unknown> = {}) => ({
  type: "chat.send", conversationId, messageId: newId("cmsg"), content: text(t), mentions, quoteMessageId: null, replacesMessageId: null, ...extra,
});

type Page = { messages: ChatMessage[]; slots: ChatReplySlot[] };

async function settled(q: ReturnType<typeof setup>["q"], conversationId: string): Promise<Page> {
  let page!: Page;
  await until(async () => {
    page = await q<Page>({ type: "chat.messages.list", conversationId });
    return page.slots.every((s) => s.outcome !== "running");
  });
  return page;
}

describe("chat mock follows C-34", () => {
  it("direct chat: the other side always answers, with a memory marker", async () => {
    const { cmd, q, events } = setup();
    const conv = await cmd<Conversation>({ type: "chat.conversation.create", members: { kind: "direct", agent: "claude" }, title: null });
    // 同一位再建一次单聊 → 原来那个
    const again = await cmd<Conversation>({ type: "chat.conversation.create", members: { kind: "direct", agent: "claude" }, title: null });
    assert.equal(again.id, conv.id);

    const r = await cmd<{ slots: ChatReplySlot[] }>(sendReq(conv.id, "你好"));
    assert.deepEqual(r.slots.map((s) => [s.agent, s.required, s.outcome]), [["claude", true, "running"]]);
    const page = await settled(q, conv.id);
    const reply = page.messages.find((m): m is AgentChatMessage => m.sender === "agent");
    assert.ok(reply);
    assert.equal(reply.memoryEntriesUsed, 2);
    // 每个 Run 恰好一个终止事件
    const terminal = events.filter((e) => e.type === "run.event" && e.event.runId === reply.runId && ["completed", "error", "cancelled", "timed_out"].includes(e.event.type));
    assert.equal(terminal.length, 1);
    // 单聊不能 @
    await assert.rejects(cmd(sendReq(conv.id, "x", { kind: "all" })), /validation_failed/);
  });

  it("group: @someone → only they get a required slot; no mention → everyone, skip allowed", async () => {
    const { cmd, q } = setup();
    const conv = await cmd<Conversation>({ type: "chat.conversation.create", members: { kind: "group", agents: ["claude", "deepseek", "codex"] }, title: null });

    const one = await cmd<{ slots: ChatReplySlot[] }>(sendReq(conv.id, "汐你说", { kind: "agents", agents: ["deepseek"] }));
    assert.deepEqual(one.slots.map((s) => [s.agent, s.required]), [["deepseek", true]]);
    await settled(q, conv.id);

    const none = await cmd<{ slots: ChatReplySlot[] }>(sendReq(conv.id, "大家觉得呢"));
    assert.deepEqual(none.slots.map((s) => s.required), [false, false, false]);
    const page = await settled(q, conv.id);
    const outcomes = Object.fromEntries(page.slots.filter((s) => s.userMessageId === none.slots[0]!.userMessageId).map((s) => [s.agent, s.outcome]));
    assert.deepEqual(outcomes, { claude: "answered", deepseek: "answered", codex: "skipped" });

    const all = await cmd<{ slots: ChatReplySlot[] }>(sendReq(conv.id, "都说说", { kind: "all" }));
    assert.ok(all.slots.every((s) => s.required));
    const after = await settled(q, conv.id);
    // 被点名的人不会是 skipped
    assert.ok(after.slots.filter((s) => s.required).every((s) => s.outcome === "answered"));
  });

  it("someone offline gets 'unavailable' and the others still answer; retry while still offline is refused", async () => {
    const { cmd, q, raw } = setup({ chat: { offlineAgents: ["codex"] } });
    const conv = await cmd<Conversation>({ type: "chat.conversation.create", members: { kind: "group", agents: ["deepseek", "codex"] }, title: null });
    const r = await cmd<{ slots: ChatReplySlot[] }>(sendReq(conv.id, "在吗", { kind: "all" }));
    const codex = r.slots.find((s) => s.agent === "codex")!;
    assert.equal(codex.outcome, "unavailable");
    assert.equal(codex.unavailableReason, "offline");
    const page = await settled(q, conv.id);
    assert.equal(page.slots.find((s) => s.agent === "deepseek")?.outcome, "answered");
    assert.equal((await raw({ type: "chat.retry", slotId: codex.id })).error, "agent_unavailable");
  });

  it("a failed slot can be retried alone (attempt + 1)", async () => {
    const { cmd, q } = setup({ chat: { failOnce: ["deepseek"] } });
    const conv = await cmd<Conversation>({ type: "chat.conversation.create", members: { kind: "direct", agent: "deepseek" }, title: null });
    await cmd(sendReq(conv.id, "说说"));
    const page = await settled(q, conv.id);
    const failed = page.slots[0]!;
    assert.equal(failed.outcome, "failed");
    assert.equal(failed.failure?.kind, "run_failed");
    const r = await cmd<{ slot: ChatReplySlot }>({ type: "chat.retry", slotId: failed.id });
    assert.equal(r.slot.attempt, 2);
    const after = await settled(q, conv.id);
    assert.equal(after.slots[0]!.outcome, "answered");
  });

  it("same messageId + same intent → first result; different intent → idempotency_conflict", async () => {
    const { cmd, q, raw } = setup();
    const conv = await cmd<Conversation>({ type: "chat.conversation.create", members: { kind: "direct", agent: "claude" }, title: null });
    const req = sendReq(conv.id, "只算一次");
    const a = await cmd<{ message: { id: string }; slots: ChatReplySlot[] }>(req);
    const b = await cmd<{ message: { id: string }; slots: ChatReplySlot[] }>(req);
    assert.deepEqual(b.slots.map((s) => s.id), a.slots.map((s) => s.id));
    assert.equal((await raw({ ...req, content: text("改了") })).error, "idempotency_conflict");
    const page = await settled(q, conv.id);
    assert.equal(page.messages.filter((m) => m.sender === "user").length, 1);
  });

  it("retract stops running answers (cancelled, one terminal event), then re-edit is a new message", async () => {
    const { cmd, q, events, bridge } = setup({ tickMs: 20 });
    const conv = await cmd<Conversation>({ type: "chat.conversation.create", members: { kind: "direct", agent: "deepseek" }, title: null });
    const sent = await cmd<{ message: { id: string }; slots: ChatReplySlot[] }>(sendReq(conv.id, "说错了"));
    const r = await cmd<{ slots: ChatReplySlot[] }>({ type: "chat.retract", messageId: sent.message.id });
    assert.equal(r.slots[0]!.outcome, "retracted");
    await sleep(60);
    const runId = sent.slots[0]!.runId!;
    const terminal = events.filter((e) => e.type === "run.event" && e.event.runId === runId && ["completed", "error", "cancelled", "timed_out"].includes(e.event.type));
    assert.deepEqual(terminal.map((e) => e.type === "run.event" && e.event.type), ["cancelled"]);
    // 撤回的不能引用、不能转议题
    assert.equal(((await bridge.command(sendReq(conv.id, "引用", { kind: "none" }, { quoteMessageId: sent.message.id }) as never)) as { error?: string }).error, "invalid_state");
    assert.equal(((await bridge.command({ type: "chat.toTopic", conversationId: conv.id, messageIds: [sent.message.id], name: "x" } as never)) as { error?: string }).error, "invalid_state");

    const re = await cmd<{ message: { id: string; replacesMessageId: string } }>(sendReq(conv.id, "重新说", { kind: "none" }, { replacesMessageId: sent.message.id }));
    assert.equal(re.message.replacesMessageId, sent.message.id);
    await settled(q, conv.id);
    // 同一条不能重新编辑两次
    assert.equal(((await bridge.command(sendReq(conv.id, "再来", { kind: "none" }, { replacesMessageId: sent.message.id }) as never)) as { error?: string }).error, "invalid_state");
  });

  it("rate limit: the 7th message within a minute is refused", async () => {
    const { cmd, raw } = setup({ tickMs: 50 });
    const conv = await cmd<Conversation>({ type: "chat.conversation.create", members: { kind: "direct", agent: "claude" }, title: null });
    for (let i = 0; i < 6; i++) await cmd(sendReq(conv.id, `第 ${i} 条`));
    assert.equal((await raw(sendReq(conv.id, "第 7 条"))).error, "rate_limited");
  });
});

describe("C-35 acceptance through the UI actions (mock)", () => {
  function app(opts: MockOptions = {}) {
    const bridge = createMockBridge({ tickMs: 1, reviewerConfigured: true, ...opts });
    const store = createStore(initialState);
    const actions = createActions(store, createClient(bridge));
    return { store, actions };
  }

  it("seed shows a pinned group first, with unread counts from the backend", async () => {
    const { store, actions } = app({ seed: true });
    await actions.start();
    const list = store.get().chat.list as ConversationListItem[];
    assert.equal(list.length, 2);
    assert.equal(list[0]!.conversation.pinned, true);
    assert.ok(list[0]!.unreadCount > 0);
    assert.equal(list[1]!.unreadCount, 0);
  });

  it("direct chat → group chat with @ → select messages → turn into a topic and land in the discussion room", async () => {
    const { store, actions } = app();
    await actions.start();
    actions.goChat();

    // 单聊
    await actions.chat.createConversation({ kind: "direct", agent: "claude" }, null);
    actions.chat.setDraftText("你好");
    await actions.chat.send();
    assert.equal(store.get().chat.drafts[store.get().chat.currentId!]?.text, "");
    await until(() => store.get().chat.messages.some((m) => m.sender === "agent"));

    // 群聊 + @汐
    await actions.chat.createConversation({ kind: "group", agents: ["claude", "deepseek", "codex"] }, "三位秘书");
    const groupId = store.get().chat.currentId!;
    actions.chat.setDraftText("@汐 聊天后端还差什么");
    actions.chat.toggleMention("deepseek");
    await actions.chat.send();
    await until(() => store.get().chat.slots.every((s) => s.outcome !== "running") && store.get().chat.messages.length === 2);
    const slots = store.get().chat.slots;
    assert.deepEqual(slots.map((s) => [s.agent, s.required, s.outcome]), [["deepseek", true, "answered"]]);
    // 流式文字收进了 runEvents
    assert.ok((store.get().runEvents[slots[0]!.runId!] ?? []).some((e) => e.type === "message_delta"));
    // 列表里的未读：正在看的会话已标已读
    await until(() => store.get().chat.list?.find((x) => x.conversation.id === groupId)?.unreadCount === 0);

    // 多选 → 转议题
    const ids = store.get().chat.messages.map((m) => m.id);
    actions.chat.startSelect(ids[0]);
    actions.chat.toggleSelect(ids[1]!);
    await actions.chat.toTopic("聊天后端还差什么");
    const s = store.get();
    assert.equal(s.view, "discussion");
    assert.equal(s.chat.selecting, null);
    const project = s.projects.find((p) => p.id === s.currentProjectId);
    assert.equal(project?.fromConversationId, groupId);
    const material = s.messages.find((m) => m.kind === "chat_material");
    assert.ok(material && material.kind === "chat_material");
    assert.deepEqual(material.chatMessageIds, ids);
    assert.equal(s.notice, null);
  });

  it("a send that never got an answer keeps its messageId, so resending is the same send", async () => {
    const { store, actions } = app();
    await actions.start();
    await actions.chat.createConversation({ kind: "direct", agent: "claude" }, null);
    actions.chat.setDraftText("网络断了");
    const cid = store.get().chat.currentId!;
    // 模拟：第一次发出去了但没拿到结果 → 草稿里留着 id
    const messageId = newId("cmsg");
    store.set((s) => ({ ...s, chat: { ...s.chat, drafts: { ...s.chat.drafts, [cid]: { ...s.chat.drafts[cid]!, messageId } } } }));
    await actions.chat.send();
    assert.equal(store.get().chat.messages.find((m) => m.sender === "user")?.id, messageId);
    // 改了草稿 → id 作废
    actions.chat.setDraftText("x");
    assert.equal(store.get().chat.drafts[cid]?.messageId, null);
  });
});
