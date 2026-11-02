import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ChatRun, ChatWindowDraft, ChatWindowStatus, ControlEvent, Conversation, ConversationListItem, ProjectNote } from "@room/schemas";
import { createMockBridge, type MockOptions } from "../mock/mock-backend";
import { createActions } from "../lib/actions";
import { createNotesActions } from "../lib/notes-actions";
import { createClient } from "../lib/client";
import { initialState, type AppState } from "../lib/state";
import { createStore } from "../lib/store";
import { newId } from "../lib/ids";
import {
  applyNotesEvent,
  boundaryText,
  diffSummary,
  handoffPhase,
  initialNotes,
  noteDiff,
  noteKey,
  notesBySource,
  versionLabel,
  windowLinesAfter,
  type NotesState,
} from "../lib/notes";

/**
 * C-47：笔记和换窗口的纯函数，以及 mock 按 C-46 的规则走（版本链、并发改、换窗口草稿、取消不留痕、GitHub 只推私有）。
 * 最后一组从 actions 那一层走一遍「点换窗口 → 等交接 → 改 → 换」。
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function ok<T>(p: Promise<{ ok: true; data: T } | { ok: false; error: string; message: string }>): Promise<T> {
  const r = await p;
  if (!r.ok) throw new Error(`${r.error}: ${r.message}`);
  return r.data;
}
async function until(check: () => Promise<boolean> | boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(5);
  }
  throw new Error("timed out waiting");
}
function setup(opts: MockOptions = {}) {
  const bridge = createMockBridge({ tickMs: 1, reviewerConfigured: true, seed: true, ...opts });
  const events: ControlEvent[] = [];
  bridge.onEvent((e) => events.push(e));
  const cmd = <T = any>(req: Record<string, unknown>) => ok<T>(bridge.command(req as never) as never);
  const q = <T = any>(req: Record<string, unknown>) => ok<T>(bridge.query(req as never) as never);
  const raw = (req: Record<string, unknown>) => bridge.command(req as never) as Promise<{ ok: boolean; error?: string }>;
  return { bridge, events, cmd, q, raw };
}
async function conversations(q: ReturnType<typeof setup>["q"]) {
  let list: ConversationListItem[] = [];
  await until(async () => (list = await q<ConversationListItem[]>({ type: "chat.conversations.list" })).length >= 2);
  return { group: list.find((x) => x.conversation.kind === "group")!.conversation, direct: list.find((x) => x.conversation.kind === "direct")!.conversation };
}

const note = (p: Partial<ProjectNote>): ProjectNote => ({
  id: newId("note"), scope: { kind: "conversation", conversationId: "conv_1" }, agent: "claude", version: 1, parentId: null,
  content: "", contentHash: "a".repeat(64), updatedBy: "agent", reason: "reply", source: { kind: "chat_run", runId: "run_1" },
  revertedFromId: null, shrankALot: false, createdAt: "2026-11-02T00:00:00.000Z", ...p,
});

describe("notes logic (C-47)", () => {
  it("收到历史摘要更新后刷新已打开会话的窗口压缩次数", async () => {
    const status: ChatWindowStatus = { agent: "claude", index: 1, window: null, compactionsInWindow: 0, suggestSwitch: false, pendingDraft: null };
    const store = createStore<AppState>({ ...initialState, notes: { ...initialNotes, windows: { conv_1: [status] } } });
    const actions = createNotesActions(store, { query: async (req: { type: string }) =>
      req.type === "chat.windows.get" ? [{ ...status, compactionsInWindow: 3, suggestSwitch: true }] : [],
    } as never, (error) => { throw error; });
    actions.onEvent({ type: "chat.summary.updated", summary: { conversationId: "conv_1" } as never });
    await sleep(0);
    assert.equal(store.get().notes.windows.conv_1?.[0]?.compactionsInWindow, 3);
    assert.equal(store.get().notes.windows.conv_1?.[0]?.suggestSwitch, true);
  });
  it("笔记查询晚到不能覆盖期间收到的新版，首次加载也保留事件", async () => {
    for (const initialized of [false, true]) {
      const v1 = note({ version: 1 });
      const v2 = note({ version: 2, parentId: v1.id });
      const store = createStore<AppState>({ ...initialState, notes: { ...initialNotes, latest: initialized ? { "c:conv_1": [v1] } : {} } });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const actions = createNotesActions(store, { query: async (req: { type: string }) => {
        if (req.type === "projectNotes.list") { await gate; return [v1]; }
        return [];
      } } as never, (error) => { throw error; });
      const loading = actions.loadScope(v1.scope);
      store.set((s) => ({ ...s, notes: applyNotesEvent(s.notes, { type: "projectNote.created", note: v2 }) }));
      release();
      await loading;
      assert.equal(store.get().notes.latest["c:conv_1"]?.[0]?.version, 2, `初始化=${initialized}`);
    }
  });
  it("diff by lines: keeps order, marks adds and deletes", () => {
    const d = noteDiff("a\nb\nc", "a\nc\nd");
    assert.deepEqual(d, [
      { kind: "same", text: "a" },
      { kind: "del", text: "b" },
      { kind: "same", text: "c" },
      { kind: "add", text: "d" },
    ]);
    assert.equal(diffSummary(d), "加了 1 行、删了 1 行");
    assert.equal(diffSummary(noteDiff("x", "x")), "没有改动");
    assert.deepEqual(noteDiff("", "x"), [{ kind: "add", text: "x" }]);
  });

  it("projectNote.created: newer version replaces latest, older one does not; history stays newest first", () => {
    const v1 = note({ version: 1 });
    const v2 = note({ version: 2, parentId: v1.id });
    let n: NotesState = { ...initialNotes, latest: { "c:conv_1": [v1] }, history: { [noteKey(v1.scope, "claude")]: [v1] } };
    n = applyNotesEvent(n, { type: "projectNote.created", note: v2 });
    assert.equal(n.latest["c:conv_1"]![0]!.version, 2);
    assert.deepEqual(n.history[noteKey(v1.scope, "claude")]!.map((x) => x.version), [2, 1]);
    // 迟到的旧版不覆盖
    const again = applyNotesEvent(n, { type: "projectNote.created", note: v1 });
    assert.equal(again.latest["c:conv_1"]![0]!.version, 2);
    assert.equal(again, n);
  });

  it("draft events keep the member's pendingDraft in sync; window.created resets compactions", () => {
    const st: ChatWindowStatus = { agent: "claude", index: 1, window: null, compactionsInWindow: 3, suggestSwitch: true, pendingDraft: null };
    const d: ChatWindowDraft = {
      id: newId("cwd"), conversationId: "conv_1", agent: "claude", startsAfterMessageId: "cmsg_1", runId: "run_9", content: null,
      contentHash: null, contentBy: null, state: "pending", windowId: null, createdAt: "2026-11-02T00:00:00.000Z", updatedAt: "2026-11-02T00:00:00.000Z",
    };
    let n: NotesState = { ...initialNotes, windows: { conv_1: [st] } };
    n = applyNotesEvent(n, { type: "chat.window.draftUpdated", draft: d });
    assert.equal(n.windows.conv_1![0]!.pendingDraft?.id, d.id);
    // 更旧的草稿事件不覆盖
    const older = applyNotesEvent(n, { type: "chat.window.draftUpdated", draft: { ...d, updatedAt: "2026-11-01T00:00:00.000Z", state: "cancelled" } });
    assert.equal(older, n);
    const w = { id: newId("cwin"), conversationId: "conv_1", agent: "claude", index: 2, startsAfterMessageId: "cmsg_1", handoffNoteId: newId("note"), draftId: d.id, createdAt: "2026-11-02T00:00:01.000Z" };
    n = applyNotesEvent({ ...n, windowList: { conv_1: [] } }, { type: "chat.window.created", window: w });
    assert.deepEqual(
      { index: n.windows.conv_1![0]!.index, c: n.windows.conv_1![0]!.compactionsInWindow, s: n.windows.conv_1![0]!.suggestSwitch, p: n.windows.conv_1![0]!.pendingDraft },
      { index: 2, c: 0, s: false, p: null },
    );
    assert.deepEqual([...windowLinesAfter(n.windowList.conv_1).keys()], ["cmsg_1"]);
  });

  it("handoff phase: writing → failed when the run ended without content; ready once content arrives", () => {
    const d = { state: "pending", content: null, runId: "run_1" } as ChatWindowDraft;
    assert.equal(handoffPhase(d, undefined), "writing");
    assert.equal(handoffPhase(d, { id: "run_1", state: "RUNNING" } as ChatRun), "writing");
    assert.equal(handoffPhase(d, { id: "run_1", state: "FAILED" } as ChatRun), "failed");
    assert.equal(handoffPhase(d, { id: "run_1", state: "TIMED_OUT" } as ChatRun), "failed");
    // Run 先推 COMPLETED、草稿内容随后才到：这一瞬间仍算 writing，不闪「没写成」
    assert.equal(handoffPhase(d, { id: "run_1", state: "COMPLETED" } as ChatRun), "writing");
    // 别的 Run（重写之前那个）结束了不算
    assert.equal(handoffPhase(d, { id: "run_0", state: "FAILED" } as ChatRun), "writing");
    assert.equal(handoffPhase({ ...d, content: "x" }, { id: "run_1", state: "COMPLETED" } as ChatRun), "ready");
    assert.equal(handoffPhase({ ...d, state: "cancelled" }, undefined), "closed");
  });

  it("labels and timeline lookups", () => {
    const v1 = note({ version: 1 });
    const r = note({ version: 2, parentId: v1.id, reason: "revert", updatedBy: "human", source: null, revertedFromId: v1.id });
    assert.equal(versionLabel(r, (a) => a, (id) => (id === v1.id ? 1 : undefined)), "你回退到第 1 版");
    assert.equal(versionLabel(v1, () => "C酱", () => undefined), "C酱 在回答里更新");
    assert.equal(notesBySource({ [noteKey(v1.scope, "claude")]: [r, v1] }, v1.scope).get("run_1")?.id, v1.id);
    assert.equal(boundaryText("nope", [], () => ""), "你点「换窗口」时的最后一条消息");
  });
});

describe("notes mock follows C-46", () => {
  it("edit needs the latest parent; revert makes a new version with the old content", async () => {
    const { cmd, q, raw } = setup();
    const { group } = await conversations(q);
    const scope = { kind: "conversation", conversationId: group.id };
    await until(async () => (await q<ProjectNote[]>({ type: "projectNotes.history", scope, agent: "claude" })).length === 2);
    const [v2, v1] = await q<ProjectNote[]>({ type: "projectNotes.history", scope, agent: "claude" });
    const stale = await raw({ type: "projectNote.edit", scope, agent: "claude", content: "x", expectedParentId: v1!.id });
    assert.equal(stale.error, "invalid_state");
    const v3 = await cmd<ProjectNote>({ type: "projectNote.edit", scope, agent: "claude", content: "只剩一行", expectedParentId: v2!.id });
    assert.deepEqual([v3.version, v3.parentId, v3.reason, v3.updatedBy, v3.shrankALot], [3, v2!.id, "human_edit", "human", true]);
    const v4 = await cmd<ProjectNote>({ type: "projectNote.revert", noteId: v1!.id });
    assert.deepEqual([v4.version, v4.content, v4.revertedFromId], [4, v1!.content, v1!.id]);
    assert.equal((await raw({ type: "projectNote.revert", noteId: v4.id })).error, "invalid_state");
    // 不是成员 → not_found
    const { direct } = await conversations(q);
    const other = await raw({ type: "projectNote.edit", scope: { kind: "conversation", conversationId: direct.id }, agent: "codex", content: "x", expectedParentId: null });
    assert.equal(other.error, "not_found");
  });

  it("window: prepare once, confirm with the hash, compactions reset; old content no longer counted", async () => {
    const { cmd, q, raw, events } = setup();
    const { group } = await conversations(q);
    const before = await q<ChatWindowStatus[]>({ type: "chat.windows.get", conversationId: group.id });
    const claude = before.find((s) => s.agent === "claude")!;
    assert.deepEqual([claude.index, claude.suggestSwitch], [1, true]);
    const d = await cmd<ChatWindowDraft>({ type: "chat.window.prepare", conversationId: group.id, agent: "claude" });
    const again = await cmd<ChatWindowDraft>({ type: "chat.window.prepare", conversationId: group.id, agent: "claude" });
    assert.equal(again.id, d.id, "已有 pending 就返回它，不起新 Run");
    let ready!: ChatWindowDraft;
    await until(() => {
      const e = events.filter((x): x is Extract<ControlEvent, { type: "chat.window.draftUpdated" }> => x.type === "chat.window.draftUpdated" && x.draft.id === d.id).pop();
      if (e?.draft.content) ready = e.draft;
      return Boolean(e?.draft.content);
    });
    assert.equal(ready.contentBy, "agent");
    const bad = await raw({ type: "chat.window.confirm", draftId: d.id, expectedContentHash: "0".repeat(64) });
    assert.equal(bad.error, "stale_snapshot");
    const done = await cmd<{ window: { index: number; startsAfterMessageId: string }; note: ProjectNote; draft: ChatWindowDraft }>({
      type: "chat.window.confirm", draftId: d.id, expectedContentHash: ready.contentHash,
    });
    assert.deepEqual([done.window.index, done.window.startsAfterMessageId, done.note.reason, done.draft.state], [2, d.startsAfterMessageId, "window_handoff", "confirmed"]);
    const after = await q<ChatWindowStatus[]>({ type: "chat.windows.get", conversationId: group.id });
    assert.deepEqual(after.map((s) => [s.agent, s.index, s.compactionsInWindow]), [["claude", 2, 0], ["deepseek", 1, 1], ["codex", 1, 0]]);
    // 写交接的 Run 恰好一个终止事件
    const terminal = events.filter((e) => e.type === "run.event" && e.event.runId === d.runId && ["completed", "error", "cancelled", "timed_out"].includes(e.event.type));
    assert.equal(terminal.length, 1);
  });

  it("cancel leaves no note and no window; the run keeps its single terminal event", async () => {
    const { cmd, q, events } = setup();
    const { direct } = await conversations(q);
    const agent = direct.members[0]!;
    const scope = { kind: "conversation", conversationId: direct.id };
    await until(async () => (await q<ProjectNote[]>({ type: "projectNotes.history", scope, agent })).length === 1);
    const d = await cmd<ChatWindowDraft>({ type: "chat.window.prepare", conversationId: direct.id, agent });
    const c = await cmd<ChatWindowDraft>({ type: "chat.window.cancel", draftId: d.id });
    assert.equal(c.state, "cancelled");
    await sleep(30);
    assert.equal((await q<ProjectNote[]>({ type: "projectNotes.history", scope, agent })).length, 1);
    assert.deepEqual(await q({ type: "chat.windows.list", conversationId: direct.id }), []);
    const terminal = events.filter((e) => e.type === "run.event" && e.event.runId === d.runId && ["completed", "error", "cancelled"].includes(e.event.type));
    assert.deepEqual(terminal.map((e) => e.type === "run.event" && e.event.type), ["cancelled"]);
  });

  it("write it yourself: editing while the run writes stops it and the late result is dropped", async () => {
    const { cmd, q } = setup();
    const { group } = await conversations(q);
    const d = await cmd<ChatWindowDraft>({ type: "chat.window.prepare", conversationId: group.id, agent: "deepseek" });
    const mine = await cmd<ChatWindowDraft>({ type: "chat.window.editDraft", draftId: d.id, content: "我自己写的交接" });
    assert.deepEqual([mine.content, mine.contentBy], ["我自己写的交接", "human"]);
    const run = await q<ChatRun>({ type: "chat.runs.get", runId: d.runId });
    assert.equal(run.state, "CANCELLED");
    await sleep(30);
    const st = (await q<ChatWindowStatus[]>({ type: "chat.windows.get", conversationId: group.id })).find((s) => s.agent === "deepseek")!;
    assert.equal(st.pendingDraft?.content, "我自己写的交接");
  });

  it("room-note in a reply saves a version; two blocks are rejected and the reply still shows", async () => {
    const { cmd, q, events } = setup();
    const { group } = await conversations(q);
    await cmd({
      type: "chat.send", conversationId: group.id, messageId: newId("cmsg"), content: { kind: "text", text: "记一下：周五前合 C-47", attachments: [] },
      mentions: { kind: "all" }, quoteMessageId: null, replacesMessageId: null,
    });
    await until(() => events.some((e) => e.type === "projectNote.created" && e.note.agent === "claude" && e.note.content.includes("周五前合")));
    await until(() => events.some((e) => e.type === "projectNote.rejected" && e.agent === "codex"));
    const rejected = events.find((e) => e.type === "projectNote.rejected")!;
    assert.equal(rejected.type === "projectNote.rejected" && rejected.reason, "multiple");
    const page = await q<{ messages: { sender: string; text?: string }[] }>({ type: "chat.messages.list", conversationId: group.id });
    assert.ok(page.messages.every((m) => !(m.text ?? "").includes("room-note")), "回答正文里不显示笔记块");
  });

  it("github: public repo is never pushed; private repo pushes the queue; token is never returned", async () => {
    const { cmd, q, events } = setup();
    const pub = await cmd({ type: "github.update", repo: "jianghao/public-notes", token: "ghp_" + "x".repeat(30) });
    assert.equal(pub.private, null, "先存、后台查");
    await until(() => events.some((e) => e.type === "github.updated" && e.status.lastError === "public_repo"));
    await cmd({ type: "github.update", repo: "jianghao/agent-notes" });
    await until(() => events.some((e) => e.type === "github.updated" && e.status.repo === "jianghao/agent-notes" && e.status.private === true));
    const { group } = await conversations(q);
    const scope = { kind: "conversation", conversationId: group.id };
    const [v] = await q<ProjectNote[]>({ type: "projectNotes.history", scope, agent: "deepseek" });
    await cmd({ type: "projectNote.edit", scope, agent: "deepseek", content: "改一下", expectedParentId: v!.id });
    await until(async () => {
      const g = await q({ type: "github.get" });
      return g.lastPushedAt !== null && g.pending === 0;
    });
    const s = await q({ type: "github.get" });
    assert.ok(!JSON.stringify(s).includes("ghp_"));
  });
});

describe("notes through actions (C-47)", () => {
  it("open a chat → statuses load; switch window from the UI path", async () => {
    const bridge = createMockBridge({ tickMs: 1, reviewerConfigured: true, seed: true });
    const store = createStore(initialState);
    const actions = createActions(store, createClient(bridge));
    await actions.start();
    let group: Conversation | undefined;
    await until(() => Boolean((group = store.get().chat.list?.find((x) => x.conversation.kind === "group")?.conversation)));
    await actions.chat.openConversation(group!.id);
    await actions.notes.loadConversation(group!.id);
    assert.equal(store.get().notes.windows[group!.id]?.find((s) => s.agent === "claude")?.suggestSwitch, true);
    assert.ok(store.get().notes.latest[`c:${group!.id}`]!.length >= 2);

    await actions.notes.prepareWindow(group!.id, "claude");
    const sheet = store.get().notes.sheet;
    assert.equal(sheet?.kind, "handoff");
    const draftId = sheet!.kind === "handoff" ? sheet!.draftId : "";
    await until(() => store.get().notes.drafts[draftId]?.content != null);
    const ok = await actions.notes.confirmWindow(draftId, "改过的交接");
    assert.equal(ok, true);
    assert.equal(store.get().notes.sheet, null);
    await until(() => store.get().notes.windows[group!.id]?.find((s) => s.agent === "claude")?.index === 2);
    const latest = store.get().notes.latest[`c:${group!.id}`]!.find((n) => n.agent === "claude")!;
    assert.deepEqual([latest.reason, latest.content, latest.updatedBy], ["window_handoff", "改过的交接", "human"]);
    assert.equal(store.get().notes.windowList[group!.id]?.length, 1);
    assert.equal(store.get().notice, null);
  });
});
