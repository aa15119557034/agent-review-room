import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ApprovalBatch, PlanVersion, Project, Round, Turn } from "@room/schemas";
import { createMockBridge } from "../mock/mock-backend";
import { createActions } from "../lib/actions";
import { createClient } from "../lib/client";
import { initialState, type AppState } from "../lib/state";
import { createStore, type Store } from "../lib/store";
import { boardSeq, groupTopics, statusFor, todoCount, topicStatus, withDigest, type TopicDigest } from "../lib/topic-board";
import { initialDiscussion } from "../lib/discussion";

/** C-38 讨论室标签：议题一句话状态、等你处理、只用讨论室标签走完一轮 */

const T = (min: number) => new Date(Date.UTC(2026, 10, 2, 8, min)).toISOString();
const project: Project = { id: "proj_1", name: "汇总卡怎么排版", fromConversationId: null, createdAt: T(0) };
const names: Record<string, string> = { deepseek: "汐", codex: "林离", claude: "C酱" };
const name = (id: string) => names[id] ?? id;

const round = (state: Round["state"], index = 1) => ({ id: `rnd_${index}`, projectId: project.id, index, state, createdAt: T(index) }) as Round;
const batch = (kind: ApprovalBatch["kind"], state: ApprovalBatch["state"] = "READY_FOR_REVIEW", roundId = "rnd_1") =>
  ({ id: `bat_${kind}`, projectId: project.id, roundId, kind, state, createdAt: T(2), decidedAt: null }) as unknown as ApprovalBatch;
const turn = (agent: string, outcome: Turn["outcome"], isSummary = false, roundId = "rnd_1") =>
  ({ id: `turn_${agent}_${isSummary}`, roundId, agent, outcome, isSummary, createdAt: T(3) }) as unknown as Turn;
const plan = (version: number, state: PlanVersion["state"]) =>
  ({ id: `plan_${version}`, projectId: project.id, version, state, createdAt: T(10 + version), decidedAt: null }) as unknown as PlanVersion;
const digest = (g: Partial<TopicDigest>): TopicDigest => ({ rounds: [], batches: [], turns: [], plans: [], ...g });
const status = (g: Partial<TopicDigest>) => topicStatus(project, digest(g), name);

describe("topic one-line status (C-38)", () => {
  it("no rounds and no plan = not started; no data yet = its own 'loading' group, not 'not started'", () => {
    assert.deepEqual([status({}).group, status({}).line], ["new", "还没开始"]);
    const loading = topicStatus(project, undefined, name);
    assert.deepEqual([loading.group, loading.line], ["loading", "读取中…"]);
    assert.equal(topicStatus(project, undefined, name, true).line, "读不出来，点开看看");
  });

  it("a slower, older fetch cannot overwrite a newer cache entry (汐 #162 评审 2)", () => {
    const older = boardSeq(); // 先开始取（t≈200）
    const newer = boardSeq(); // 后来离开议题时按实时数据留缓存（t≈220）
    let board = withDigest(initialDiscussion.board, "p", digest({ rounds: [round("RUNNING")] }), newer);
    board = withDigest(board, "p", digest({ rounds: [round("DRAFT")], batches: [batch("initial")] }), older); // t≈230 才回来
    assert.equal(board.topics["p"]!.rounds[0]!.state, "RUNNING");
    // 读到数据就清掉「读不出来」
    const failed = { ...initialDiscussion.board, failed: { p: true } };
    assert.equal(withDigest(failed, "p", digest({}), boardSeq()).failed["p"], undefined);
  });

  it("a batch waiting for the stamp is a to-do whatever the round is doing", () => {
    const s = status({ rounds: [round("DRAFT")], batches: [batch("initial")] });
    assert.equal(s.group, "todo");
    assert.equal(s.line, "第 1 轮等你盖章");
    assert.deepEqual(s.todos.map((t) => t.kind), ["stamp"]);

    const sup = status({ rounds: [round("RUNNING")], batches: [batch("supplement")], turns: [turn("deepseek", "running")] });
    assert.equal(sup.line, "第 1 轮补充等你盖章");
    const sum = status({ rounds: [round("AWAITING_SUMMARY")], batches: [batch("summary")], turns: [turn("deepseek", "answered")] });
    // 汇总已经起草等盖章：只算一件事，不再提示「请人汇总」
    assert.deepEqual(sum.todos.map((t) => t.label), ["第 1 轮汇总等你盖章"]);
  });

  it("stamped / cancelled batches are not to-dos", () => {
    const s = status({ rounds: [round("RUNNING")], batches: [batch("initial", "APPROVED"), batch("retry", "CANCELLED")], turns: [] });
    assert.equal(s.group, "active");
    assert.equal(s.line, "第 1 轮 · 进行中");
  });

  it("running round names who is answering; summarizing names the summarizer", () => {
    const s = status({ rounds: [round("RUNNING", 2)], turns: [turn("deepseek", "running", false, "rnd_2"), turn("codex", "answered", false, "rnd_2")] });
    assert.equal(s.line, "第 2 轮 · 汐回答中");
    const sum = status({ rounds: [round("SUMMARIZING")], turns: [turn("deepseek", "answered"), turn("claude", "running", true)] });
    assert.equal(sum.line, "第 1 轮 · C酱汇总中");
    assert.equal(status({ rounds: [round("PAUSED")] }).line, "第 1 轮 · 已暂停");
  });

  it("everyone done: ask for a summary; nobody answered: offer to change direction", () => {
    const s = status({ rounds: [round("AWAITING_SUMMARY")], turns: [turn("deepseek", "answered"), turn("codex", "timed_out")] });
    assert.deepEqual([s.group, s.todos[0]?.kind], ["todo", "summarize"]);
    const none = status({ rounds: [round("AWAITING_SUMMARY")], turns: [turn("deepseek", "failed")] });
    assert.deepEqual([none.group, none.todos[0]?.kind], ["todo", "void"]);
  });

  it("plans: newest draft waits for you; current is active; final is final", () => {
    const done = [round("SUMMARIZED")];
    assert.equal(status({ rounds: done, plans: [plan(1, "DRAFT")] }).line, "方案 v1 草稿等你确认");
    assert.deepEqual([status({ rounds: done, plans: [plan(1, "CURRENT")] }).group], ["active"]);
    const fin = status({ rounds: done, plans: [plan(1, "FINAL")] });
    assert.deepEqual([fin.group, fin.line], ["final", "v1 已定稿"]);
    // 定稿后派生出的新草稿：又等你确认
    assert.equal(status({ rounds: done, plans: [plan(1, "FINAL"), plan(2, "DRAFT")] }).group, "todo");
    assert.equal(status({ rounds: [round("VOIDED")] }).line, "第 1 轮已作废");
  });

  it("groups keep the order 等你处理 → 进行中 → 还没开始 → 已定稿, newest first inside a group", () => {
    const ps: Project[] = ["a", "b", "c", "d"].map((x, i) => ({ ...project, id: x, name: x, createdAt: T(i) }));
    const by: Record<string, Partial<TopicDigest>> = {
      a: { rounds: [round("SUMMARIZED")], plans: [plan(1, "FINAL")] },
      b: {},
      c: { rounds: [round("DRAFT")], batches: [batch("initial")] },
      d: {},
    };
    const g = groupTopics(ps, (p) => topicStatus(p, digest(by[p.id]!), name));
    assert.deepEqual(g.map((x) => [x.group, x.items.map((i) => i.project.id)]), [["todo", ["c"]], ["new", ["d", "b"]], ["final", ["a"]]]);
  });
});

// ---------------------------------------------------------------- 接 mock：只用讨论室标签走完一轮

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await sleep(5);
  }
  throw new Error("timed out waiting");
}

const st = (s: AppState, pid: string) => statusFor(s.disc, s.currentProjectId, s.projects.find((p) => p.id === pid)!);

describe("discussion tab against the mock (C-38 acceptance)", () => {
  async function setup() {
    const bridge = createMockBridge({ tickMs: 1, reviewerConfigured: true });
    const store: Store<AppState> = createStore(initialState);
    const actions = createActions(store, createClient(bridge));
    await actions.start();
    return { store, actions, bridge };
  }

  it("send → summary → finalize, driven only by the tab's to-dos and the existing buttons", async () => {
    const { store, actions } = await setup();
    await actions.createProject("另一个议题");
    await actions.createProject("汇总卡怎么排版");
    const pid = store.get().currentProjectId!;
    assert.equal(st(store.get(), pid).line, "还没开始");

    // 发送：写任务、选人 → 起草（会直接打开确认页，先关掉，从「等你处理」再进）
    actions.setComposerText("汇总卡要不要分栏？");
    await actions.draftRound();
    actions.closeConfirm();
    let todo = st(store.get(), pid).todos;
    assert.deepEqual(todo.map((t) => t.kind), ["stamp"]);
    assert.equal(todoCount(store.get().disc, pid, store.get().projects), 1);

    await actions.openTodo(todo[0]!);
    assert.equal(store.get().disc.confirm?.batch.id, todo[0]!.kind === "stamp" ? todo[0]!.batchId : "");
    assert.equal(store.get().disc.ui.pane, "topic");
    await actions.approveBatch();
    await until(() => st(store.get(), pid).group === "todo" && st(store.get(), pid).todos[0]?.kind === "summarize");

    // 汇总：原来的「请 C酱 汇总」→ 盖章
    const roundId = store.get().disc.rounds[0]!.id;
    await actions.summarize(roundId, "claude");
    actions.closeConfirm();
    todo = st(store.get(), pid).todos;
    assert.deepEqual(todo.map((t) => t.label), ["第 1 轮汇总等你盖章"]);
    await actions.openTodo(todo[0]!);
    await actions.approveBatch();
    await until(() => st(store.get(), pid).todos[0]?.kind === "confirm_plan");

    // 定稿：确认这一版 → 盖章定稿
    const draft = store.get().disc.plans.find((p) => p.state === "DRAFT")!;
    await actions.confirmPlan(draft.id);
    const current = store.get().disc.plans.find((p) => p.state === "CURRENT")!;
    await actions.finalizePlan(current.id, current.contentHash);
    const done = st(store.get(), pid);
    assert.deepEqual([done.group, done.line, done.todos.length], ["final", "v1 已定稿", 0]);
    assert.equal(todoCount(store.get().disc, pid, store.get().projects), 0);

    // 换到别的议题：离开的议题保留最后的状态，不用重读
    const other = store.get().projects.find((p) => p.id !== pid)!;
    await actions.selectProject(other.id);
    assert.equal(st(store.get(), pid).line, "v1 已定稿");
  });

  it("activity in a topic you are not looking at shows up in the list", async () => {
    const { store, actions, bridge } = await setup();
    await actions.createProject("后台的议题");
    const back = store.get().currentProjectId!;
    await actions.createProject("正在看的议题");
    assert.notEqual(store.get().currentProjectId, back);

    const r = await bridge.command({
      type: "round.draft", projectId: back, recipients: ["deepseek"], task: "看一下", taskSource: "human",
      planVersionId: null, historyMode: "recent_with_summaries",
    });
    assert.ok(r.ok);
    await until(() => st(store.get(), back).todos[0]?.kind === "stamp");
    assert.equal(todoCount(store.get().disc, store.get().currentProjectId, store.get().projects), 1);
  });

  it("a topic that fails to load at start is retried once, then shown as unreadable (not 'not started')", async () => {
    const bridge = createMockBridge({ tickMs: 1, reviewerConfigured: true });
    const a = await bridge.command({ type: "project.create", name: "一" });
    const b = await bridge.command({ type: "project.create", name: "二" });
    const c = await bridge.command({ type: "project.create", name: "三" });
    assert.ok(a.ok && b.ok && c.ok);
    await bridge.command({
      type: "round.draft", projectId: c.data.id, recipients: ["codex"], task: "看一下", taskSource: "human",
      planVersionId: null, historyMode: "recent_with_summaries",
    });
    // 二：一直读不到；三：第一次读不到，重试成功
    let cFails = 1;
    const flaky = {
      ...bridge,
      query: async (req: { type: string; projectId?: string }) => {
        if (req.type === "rounds.list" && req.projectId === b.data.id) return { ok: false, error: "internal", message: "忙" };
        if (req.type === "rounds.list" && req.projectId === c.data.id && cFails-- > 0) return { ok: false, error: "internal", message: "忙" };
        return bridge.query(req as never);
      },
    } as typeof bridge;
    const store = createStore(initialState);
    const actions = createActions(store, createClient(flaky));
    await actions.start();
    await until(() => st(store.get(), c.data.id).group === "todo" && !!store.get().disc.board.failed[b.data.id], 4000);
    const bs = st(store.get(), b.data.id);
    assert.deepEqual([bs.group, bs.line], ["loading", "读不出来，点开看看"]);
    assert.equal(todoCount(store.get().disc, store.get().currentProjectId, store.get().projects), 1);
  });

  it("topics that already exist at start are read once for the list", async () => {
    const bridge = createMockBridge({ tickMs: 1, reviewerConfigured: true });
    const a = await bridge.command({ type: "project.create", name: "一" });
    const b = await bridge.command({ type: "project.create", name: "二" });
    assert.ok(a.ok && b.ok);
    await bridge.command({
      type: "round.draft", projectId: b.data.id, recipients: ["codex"], task: "看一下", taskSource: "human",
      planVersionId: null, historyMode: "recent_with_summaries",
    });
    const store = createStore(initialState);
    await createActions(store, createClient(bridge)).start();
    // 打开的是第一个议题；第二个靠 loadBoard 读出来
    assert.equal(store.get().currentProjectId, a.data.id);
    await until(() => st(store.get(), b.data.id).group === "todo");
  });
});
