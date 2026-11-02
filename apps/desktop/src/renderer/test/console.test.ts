import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ChatSlotOutcome,
  TurnOutcome,
  toRunModel,
  type AgentActivityItem,
  type AgentStatus,
  type ApprovalBatch,
  type ChatMessage,
  type ChatReplySlot,
  type Conversation,
  type Project,
  type Round,
  type Turn,
} from "@room/schemas";
import { createMockBridge, type MockOptions } from "../mock/mock-backend";
import { createActivityQuery } from "../mock/activity-mock";
import {
  activityOutcome,
  activityPreview,
  activityTags,
  activityTitle,
  appendRecent,
  applyActivityEvent,
  quotaView,
  substituteOptions,
  type ActivityPage,
} from "../lib/console";
import { createActions } from "../lib/actions";
import { createClient } from "../lib/client";
import { initialState } from "../lib/state";
import { createStore } from "../lib/store";

/** C-37 秘书控制台：agents.activity 的 mock 语义（契约 C-37a）、事件就地更新、所有状态都有字显示 */

const ID = (n: number) => `01J${String(n).padStart(23, "0")}`;
const T = (min: number) => new Date(Date.UTC(2026, 10, 1, 8, min)).toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const project: Project = { id: `proj_${ID(1)}`, name: "数据库写入路径", fromConversationId: null, createdAt: T(0) };
const round: Round = {
  id: `rnd_${ID(1)}`, projectId: project.id, index: 3, state: "RUNNING", task: "各自说说怎么做", taskSource: "human",
  recipients: ["claude", "codex"], planVersionId: null, historyMode: "recent_with_summaries", voidReason: null, activeMs: 0,
  createdAt: T(0), startedAt: T(0), finishedAt: null,
};
const turn = (n: number, agent: string, outcome: Turn["outcome"], extra: Partial<Turn> = {}): Turn => ({
  id: `turn_${ID(n)}`, roundId: round.id, batchId: `bat_${ID(1)}`, agent, onBehalfOf: null, isSummary: false,
  approvalId: `apr_${ID(n)}`, runId: outcome === "pending" ? null : `run_${ID(n)}`, outcome, partialText: null,
  replyMessageId: null, supersededBy: null, createdAt: T(n), finishedAt: outcome === "pending" || outcome === "running" ? null : T(n),
  ...extra,
});
const conv: Conversation = {
  id: `conv_${ID(1)}`, kind: "direct", members: ["claude"], title: null, pinned: false, muted: false,
  lastReadMessageId: null, lastActivityAt: T(0), createdAt: T(0),
};
const userMsg = (n: number, text: string, retracted = false): ChatMessage => ({
  id: `cmsg_${ID(n)}`, conversationId: conv.id, createdAt: T(n), sender: "user", content: { kind: "text", text, attachments: [] },
  mentions: { kind: "none" }, quoteMessageId: null, replacesMessageId: null,
  state: retracted ? "retracted" : "sent", retractedAt: retracted ? T(n) : null,
} as ChatMessage);
const slot = (n: number, outcome: ChatReplySlot["outcome"], extra: Partial<ChatReplySlot> = {}): ChatReplySlot => ({
  id: `slot_${ID(n)}`, conversationId: conv.id, userMessageId: `cmsg_${ID(n)}`, agent: "claude", required: true, outcome,
  runId: `run_${ID(100 + n)}`, attempt: 1, replyMessageId: outcome === "answered" ? `cmsg_${ID(200 + n)}` : null,
  failure: null, unavailableReason: null, createdAt: T(n), finishedAt: outcome === "running" ? null : T(n), ...extra,
});

function fixture() {
  const turns = [
    turn(2, "claude", "answered"),
    turn(4, "claude", "running"),
    // C酱 额度用完，DeepSeek 代答：只算 DeepSeek 的
    turn(6, "deepseek", "answered", { onBehalfOf: "claude" }),
  ];
  const messages = [userMsg(3, "今天 #99 怎么样？"), userMsg(5, "撤回前的原文 SENTINEL", true), userMsg(7, "再说一句")];
  const slots = [slot(3, "answered"), slot(5, "retracted"), slot(7, "running")];
  return createActivityQuery({
    agentExists: (a) => ["claude", "deepseek", "codex"].includes(a),
    projects: () => [project],
    discussion: () => ({ rounds: [round], turns }),
    chat: async () => ({ conversations: [conv], messages, slots }),
  });
}

describe("agents.activity mock (C-37a)", () => {
  it("current is the live ones oldest first; recent is the finished ones newest first", async () => {
    const r = await fixture()({ type: "agents.activity", agent: "claude" });
    assert.deepEqual(r.current.map((x) => (x.kind === "discussion" ? x.turn.id : x.slot.id)), [`turn_${ID(4)}`, `slot_${ID(7)}`]);
    assert.deepEqual(r.recent.map((x) => (x.kind === "discussion" ? x.turn.id : x.slot.id)), [`slot_${ID(5)}`, `slot_${ID(3)}`, `turn_${ID(2)}`]);
    assert.equal(r.nextCursor, null);
    // C-37a（汐 #157）：讨论项只带 Turn 摘要
    const d = r.recent.find((x) => x.kind === "discussion")!;
    assert.ok(d.kind === "discussion" && !("partialText" in d.turn) && !("approvalId" in d.turn));
  });

  it("preview is cut by code point and never leaves half an emoji", async () => {
    const long = "😀".repeat(150);
    const q = createActivityQuery({
      agentExists: () => true,
      projects: () => [project],
      discussion: () => ({ rounds: [{ ...round, task: long }], turns: [turn(2, "claude", "answered")] }),
      chat: async () => ({ conversations: [], messages: [], slots: [] }),
    });
    const p = (await q({ type: "agents.activity", agent: "claude" })).recent[0]!.preview!;
    assert.ok(p.length <= 200);
    assert.ok(!/[\uD800-\uDBFF]$/.test(p), "no dangling high surrogate");
    assert.equal(p, "😀".repeat(100));
  });

  it("a substitute's turn is listed under the one who answered, not the absent one", async () => {
    const q = fixture();
    const claude = await q({ type: "agents.activity", agent: "claude" });
    assert.ok(![...claude.current, ...claude.recent].some((x) => x.kind === "discussion" && x.turn.id === `turn_${ID(6)}`));
    const ds = await q({ type: "agents.activity", agent: "deepseek" });
    assert.equal(ds.recent.length, 1);
    assert.deepEqual(activityTags(ds.recent[0]!, (a) => (a === "claude" ? "C酱" : a)), ["讨论", "代 C酱 答"]);
  });

  it("a retracted message gives no preview (the original text never reaches the console)", async () => {
    const r = await fixture()({ type: "agents.activity", agent: "claude" });
    const item = r.recent.find((x) => x.kind === "chat" && x.slot.id === `slot_${ID(5)}`)!;
    assert.equal(item.preview, null);
    assert.ok(!JSON.stringify(r).includes("SENTINEL"));
    assert.deepEqual(activityPreview(item), { text: "（消息已撤回）", muted: true });
  });

  it("paging by (createdAt, id) has no gaps or repeats; before= returns no current", async () => {
    const q = fixture();
    const seen: string[] = [];
    let page = await q({ type: "agents.activity", agent: "claude", limit: 1 });
    assert.equal(page.current.length, 2);
    seen.push(...page.recent.map((x) => (x.kind === "discussion" ? x.turn.id : x.slot.id)));
    while (page.nextCursor) {
      page = await q({ type: "agents.activity", agent: "claude", limit: 1, before: page.nextCursor });
      assert.equal(page.current.length, 0);
      seen.push(...page.recent.map((x) => (x.kind === "discussion" ? x.turn.id : x.slot.id)));
    }
    assert.deepEqual(seen, [`slot_${ID(5)}`, `slot_${ID(3)}`, `turn_${ID(2)}`]);
    // 满页就给 cursor（C-37a），所以最后一页可能是空的
    const full = await q({ type: "agents.activity", agent: "claude", limit: 3 });
    assert.ok(full.nextCursor);
    const empty = await q({ type: "agents.activity", agent: "claude", limit: 3, before: full.nextCursor! });
    assert.deepEqual([empty.recent.length, empty.nextCursor], [0, null]);
  });

  it("unknown agent → not_found (through the bridge, so the response is schema-checked)", async () => {
    const bridge = createMockBridge({ tickMs: 1 });
    const r = await bridge.query({ type: "agents.activity", agent: "nobody" } as never);
    assert.equal(!r.ok && r.error, "not_found");
  });
});

describe("console state", () => {
  const base = async (): Promise<ActivityPage> => ({ agent: "claude", ...(await fixture()({ type: "agents.activity", agent: "claude" })) });

  it("a finished turn moves from current into recent, in order; other agents are ignored", async () => {
    const page = await base();
    const done = turn(4, "claude", "answered");
    const r = applyActivityEvent(page, { type: "turn.updated", turn: done });
    assert.equal(r.reload, false);
    assert.equal(r.page.current.length, 1);
    // 按 createdAt 插进去，不是按到达顺序放最前
    assert.deepEqual(r.page.recent.map((x) => (x.kind === "discussion" ? x.turn.id : x.slot.id)), [`slot_${ID(5)}`, `turn_${ID(4)}`, `slot_${ID(3)}`, `turn_${ID(2)}`]);
    const moved = r.page.recent[1]!;
    assert.equal(moved.kind === "discussion" && moved.turn.outcome, "answered");
    const other = applyActivityEvent(page, { type: "turn.updated", turn: turn(9, "codex", "running") });
    assert.equal(other.page, page);
    assert.equal(other.reload, false);
  });

  it("a retried slot goes back to current; a new one asks for a reload", async () => {
    const page = await base();
    const retried = applyActivityEvent(page, { type: "chat.slot.updated", slot: slot(3, "running", { attempt: 2 }) });
    assert.equal(retried.page.current.length, 3);
    assert.deepEqual(activityTags(retried.page.current.find((x) => x.kind === "chat" && x.slot.id === `slot_${ID(3)}`)!, (a) => a), ["单聊", "第 2 次"]);
    const fresh = applyActivityEvent(page, { type: "chat.slot.updated", slot: slot(20, "running") });
    assert.equal(fresh.reload, true);
  });

  it("load more drops items already on the first page", async () => {
    const page = await base();
    const more = appendRecent(page, { recent: [page.recent[2]!], nextCursor: null });
    assert.equal(more.recent.length, 3);
  });

  it("every turn outcome and slot outcome has a label (mock 下所有状态都能显示)", () => {
    for (const o of TurnOutcome.options) {
      const x: AgentActivityItem = { kind: "discussion", projectId: project.id, projectName: project.name, roundId: round.id, roundIndex: 3, turn: turn(2, "claude", o), preview: null };
      assert.ok(activityOutcome(x).label, o);
      assert.equal(activityTitle(x, (a) => a), "数据库写入路径 · 第 3 轮");
    }
    for (const o of ChatSlotOutcome.options) {
      const extra: Partial<ChatReplySlot> =
        o === "failed" ? { failure: { kind: "timed_out", message: "超时" } }
          : o === "unavailable" ? { unavailableReason: "offline", runId: null }
          : o === "absent_quota" ? { runId: null }
          : {};
      const x: AgentActivityItem = { kind: "chat", conversation: conv, slot: slot(3, o, extra), preview: null };
      assert.ok(activityOutcome(x).label, o);
    }
  });

  it("quota panel follows quotaState; unknown shows no numbers", () => {
    const st = (p: Partial<AgentStatus>): AgentStatus => ({
      agent: "claude", availability: "available", billing: "subscription", fiveHour: null, weekly: null, balance: null,
      contextUsedPercent: null, compactions: null, model: null, effort: null, updatedAt: T(0), ...p,
    });
    assert.equal(quotaView(undefined).state, "unknown");
    const unknown = quotaView(st({}));
    assert.equal(unknown.state, "unknown");
    assert.equal(unknown.rows.length, 0);
    assert.equal(quotaView(st({ weekly: { usedPercent: 100, resetsAt: null } })).state, "exhausted");
    assert.equal(quotaView(st({ billing: "api", balance: { amount: "0.00", currency: "CNY", spentThisMonth: null } })).state, "exhausted");
    const ok = quotaView(st({ fiveHour: { usedPercent: 60, resetsAt: null }, weekly: { usedPercent: 38, resetsAt: null } }));
    assert.deepEqual([ok.state, ok.rows.map((r) => r.label)], ["ok", ["5 小时", "每周"]]);
  });

  it("substitute choices: other agents who can discuss", () => {
    const agents = [
      { id: "claude", canDiscuss: true },
      { id: "deepseek", canDiscuss: true },
      { id: "codex", canDiscuss: false },
    ] as never;
    assert.deepEqual(substituteOptions(agents, "claude").map((a) => a.id), ["deepseek"]);
  });
});

describe("console through the mock (actions layer)", () => {
  async function setup(opts: MockOptions = {}) {
    const bridge = createMockBridge({ tickMs: 1, reviewerConfigured: true, seed: true, ...opts });
    const store = createStore(initialState);
    const actions = createActions(store, createClient(bridge));
    await actions.start();
    return { store, actions, bridge };
  }
  const until = async (check: () => boolean, ms = 2000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (check()) return;
      await sleep(5);
    }
    throw new Error("timed out waiting");
  };

  it("opens on the first agent with the seeded chat history; pause and substitute go through agent.update", async () => {
    const { store, actions } = await setup();
    await actions.agentConsole.open();
    const s = store.get();
    assert.equal(s.view, "console");
    assert.equal(s.console.agentId, "claude");
    assert.ok(s.console.activity && s.console.activity.recent.some((x) => x.kind === "chat"), "seeded chat replies show up");

    await actions.updateAgent({ id: "claude", pausedByUser: true });
    assert.equal(store.get().disc.status.claude?.availability, "paused_by_user");
    await actions.updateAgent({ id: "claude", pausedByUser: false });
    assert.equal(store.get().disc.status.claude?.availability, "available");
    await actions.updateAgent({ id: "claude", substitute: "deepseek" });
    assert.equal(store.get().disc.agents.find((a) => a.id === "claude")?.substitute, "deepseek");
  });

  it("a discussion turn shows up live and then lands in history", async () => {
    const { store, actions, bridge } = await setup({ tickMs: 10 });
    await actions.agentConsole.open();
    await actions.agentConsole.selectAgent("deepseek");
    const before = store.get().console.activity!.recent.length;
    const ok = async <T>(p: Promise<unknown>) => {
      const r = (await p) as { ok: boolean; data: T };
      assert.ok(r.ok);
      return r.data;
    };
    const p = await ok<{ id: string }>(bridge.command({ type: "project.create", name: "控制台测试" } as never));
    const { batch } = await ok<{ batch: ApprovalBatch }>(bridge.command({
      type: "round.draft", projectId: p.id, recipients: ["deepseek"], task: "说说怎么做", taskSource: "human",
      planVersionId: null, historyMode: "recent_with_summaries",
    } as never));
    await until(() => (store.get().console.activity?.current.length ?? 0) === 1);
    assert.equal(store.get().console.activity!.current[0]!.preview, "说说怎么做");
    await ok(bridge.command({
      type: "batch.approve", batchId: batch.id,
      expected: batch.items.map((i) => ({ approvalId: i.approvalId, contentHash: i.contentHash, model: i.model === null ? null : toRunModel(i.model) })),
    } as never));
    await until(() => store.get().console.activity!.current.length === 0 && store.get().console.activity!.recent.length === before + 1);
    const top = store.get().console.activity!.recent[0]!;
    assert.equal(top.kind === "discussion" && top.turn.outcome, "answered");
  });

  it("demo options: offline, unknown quota, and spentThisMonth is never made up", async () => {
    const { store } = await setup({ discussion: { offlineAgents: ["deepseek"], unknownQuota: ["codex"] } });
    const st = store.get().disc.status;
    assert.equal(st.deepseek?.availability, "offline");
    assert.equal(st.deepseek?.balance?.spentThisMonth, null);
    assert.equal(quotaView(st.codex).state, "unknown");
  });

  it("before the backend knows agents.activity, the console still opens without an error", async () => {
    const { store, actions, bridge } = await setup();
    const real = bridge.query;
    (bridge as { query: typeof real }).query = (async (req: { type: string }) =>
      req.type === "agents.activity" ? { ok: false, error: "validation_failed", message: "未知查询" } : real(req as never)) as never;
    await actions.agentConsole.open();
    assert.equal(store.get().console.activityAvailable, false);
    assert.equal(store.get().notice, null);
  });
});
