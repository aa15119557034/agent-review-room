import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ControlEvent, WorldEvent, WorldSnapshot } from "@room/schemas";
import { createMockBridge } from "../mock/mock-backend";
import { createActions } from "../lib/actions";
import { createClient } from "../lib/client";
import { applyEvent, initialState, type AppState } from "../lib/state";
import { createStore } from "../lib/store";
import {
  applySnapshot, applyWorldEvent, clockText, commitmentViews, dayClockText, dayOf, dayPhase, eventText, initialWorld,
  mergeEventsPage, pathTo, residentLine, worldNames, worldNow, type WorldUiState,
} from "../lib/world";

/**
 * 世界（C-54）：界面逻辑 + 演示后台按契约 C-53 走一遍。
 * 演示后台的时间不自己走（autoTick: false），用 bridge.world.advance(分钟) 推，所以每一步都是确定的。
 */

const tick = () => new Promise((r) => setTimeout(r, 0));

function setup(world: { seed?: boolean; offline?: string[]; dailyLimit?: number } = {}) {
  const bridge = createMockBridge({ tickMs: 2, reviewerConfigured: true, world: { seed: true, autoTick: false, ...world } });
  const store = createStore<AppState>(initialState);
  const events: ControlEvent[] = [];
  bridge.onEvent((e) => {
    events.push(e);
    store.set((s) => applyEvent(s, e));
  });
  const client = createClient(bridge);
  const actions = createActions(store, client);
  const w = () => store.get().world;
  const snap = () => w().world!;
  /** 推进时间，并等事件都进了状态 */
  const advance = async (minutes: number) => {
    bridge.world.advance(minutes);
    await tick();
  };
  const resident = (agent: string) => snap().residents.find((r) => r.agent === agent)!;
  const stock = (id: string) => {
    const it = snap().items.find((i) => i.id === id)!;
    return it.kind === "stock" ? it.count : -1;
  };
  const book = () => snap().items.find((i) => i.id === "book") as Extract<WorldSnapshot["items"][number], { kind: "unique" }>;
  const base = () => ({ worldId: snap().id, generation: snap().generation });
  return { bridge, store, events, client, actions, w, snap, advance, resident, stock, book, base };
}

async function opened(world: Parameters<typeof setup>[0] = {}) {
  const t = setup(world);
  await t.actions.world.load();
  await tick();
  return t;
}

describe("世界：界面逻辑", () => {
  it("时钟：按快照插值，暂停时不走", () => {
    const base = { now: 420, asOf: "2026-11-15T00:00:00.000Z", minutesPerRealSecond: 1 };
    const at = Date.parse(base.asOf);
    assert.equal(worldNow({ ...base, run: { state: "running" } }, at + 90_000), 510);
    assert.equal(worldNow({ ...base, run: { state: "paused", by: "user" } }, at + 90_000), 420);
    assert.equal(worldNow({ ...base, run: { state: "running" } }, at - 5_000), 420);
    assert.equal(clockText(420), "07:00");
    assert.equal(dayClockText(1440 + 65), "第 2 天 01:05");
    assert.equal(dayOf(1439), 1);
    assert.deepEqual([dayPhase(300), dayPhase(480), dayPhase(720), dayPhase(1200), dayPhase(1380)], ["night", "morning", "day", "evening", "night"]);
  });

  it("走路：隔着客厅要走两步，走不到是 null", () => {
    const places = [
      { id: "living_room", label: "客厅", neighbors: ["kitchen", "room_a"], owner: null },
      { id: "kitchen", label: "厨房", neighbors: ["living_room"], owner: null },
      { id: "room_a", label: "A 的房间", neighbors: ["living_room"], owner: "a" },
      { id: "attic", label: "阁楼", neighbors: [], owner: null },
    ];
    assert.deepEqual(pathTo(places, "kitchen", "room_a"), ["living_room", "room_a"]);
    assert.deepEqual(pathTo(places, "kitchen", "kitchen"), []);
    assert.equal(pathTo(places, "kitchen", "attic"), null);
  });

  it("旧快照不盖新的；换了一局清掉上一局的时间线", async () => {
    const t = await opened();
    const first = t.snap();
    await t.advance(30);
    const later = t.snap();
    assert.ok(later.lastSeq > first.lastSeq);
    assert.equal(applySnapshot(t.w(), first), t.w(), "同一代里更旧的快照丢掉");
    assert.ok(t.w().events.length > 0);
    const other = applySnapshot(t.w(), { ...first, id: "world_01HZZZZZZZZZZZZZZZZZZZZZZZ" });
    assert.equal(other.events.length, 0);
    assert.equal(other.eventsStale, true);
  });

  it("事件按序号合并：重复的丢掉，中间缺了标记要重读", () => {
    const world = { id: "world_01HZZZZZZZZZZZZZZZZZZZZZZZ" } as WorldSnapshot;
    const ev = (seq: number): WorldEvent => ({ type: "clock", seq, at: 0, mark: "day_started", day: 1 });
    let s: WorldUiState = { ...initialWorld, world };
    s = mergeEventsPage(s, world.id, { items: [ev(2), ev(1)], nextBefore: null }, true);
    s = applyWorldEvent(s, { type: "world.event", worldId: world.id, event: ev(3) });
    assert.deepEqual(s.events.map((e) => e.seq), [3, 2, 1]);
    assert.equal(applyWorldEvent(s, { type: "world.event", worldId: world.id, event: ev(3) }), s);
    assert.equal(applyWorldEvent(s, { type: "world.event", worldId: "world_01HYYYYYYYYYYYYYYYYYYYYYYY", event: ev(4) }), s);
    assert.equal(s.eventsStale, false);
    s = applyWorldEvent(s, { type: "world.event", worldId: world.id, event: ev(6) });
    assert.equal(s.eventsStale, true);
  });
});

describe("世界：演示后台按契约走", () => {
  it("打开就在家里：三间屋以上、两位居民、屋里有东西；什么都不做她们自己过", async () => {
    const t = await opened();
    assert.ok(t.snap().places.length >= 3);
    assert.equal(t.snap().residents.length, 2);
    assert.ok(t.snap().items.some((i) => i.id === "book"));
    assert.equal(t.snap().lastSeq, 1);
    await t.advance(180);
    const kinds = new Set(t.w().events.filter((e) => e.type === "action").map((e) => (e.type === "action" ? e.action.type : "")));
    assert.ok(kinds.has("move") && kinds.has("start"), "她们自己走动、自己开始做事");
    const seqs = t.w().events.map((e) => e.seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => b - a));
    assert.equal(seqs[0], t.snap().lastSeq);
  });

  it("做饭：开始时占用食材，做好了才多出饭；吃完饭少一份", async () => {
    const t = await opened();
    assert.equal(t.stock("meal"), 0);
    assert.equal(t.stock("ingredients"), 6);
    // 早饭点：第一位去厨房做饭
    for (let i = 0; i < 40 && !t.snap().activities.some((a) => a.kind === "cook"); i++) await t.advance(1);
    const cook = t.snap().activities.find((a) => a.kind === "cook")!;
    assert.ok(cook, "有人开始做饭");
    assert.equal(t.stock("ingredients"), 4, "食材先占用");
    assert.equal(t.stock("meal"), 0, "没做好之前没有饭");
    await t.advance(cook.endsAt - cook.startedAt);
    const ended = t.w().events.find((e) => e.type === "activity_ended" && e.activity.id === cook.id);
    assert.ok(ended && ended.type === "activity_ended");
    assert.deepEqual(ended.produced, [{ itemId: "meal", count: 2 }]);
    assert.deepEqual(ended.consumed, [{ itemId: "ingredients", count: 2 }]);
    assert.equal(t.w().events.filter((e) => e.type === "activity_ended" && e.activity.id === cook.id).length, 1);
    await t.advance(90);
    const ate = t.w().events.filter((e) => e.type === "activity_ended" && e.activity.kind === "eat" && e.activity.endReason === "done");
    assert.ok(ate.length >= 1, "做好以后有人吃了");
    const eaten = ate.reduce((n, e) => n + (e.type === "activity_ended" ? e.consumed.reduce((m, c) => m + c.count, 0) : 0), 0);
    const eating = t.snap().activities.filter((a) => a.kind === "eat").reduce((n, a) => n + a.participants.length, 0);
    assert.equal(t.stock("meal"), 2 - eaten - eating, "饭 = 做出来的 − 吃掉的 − 正在吃占着的");
  });

  it("你走动：不相连的屋走不过去；goTo 一间一间走", async () => {
    const t = await opened();
    assert.equal(t.snap().player.placeId, "living_room");
    await t.actions.world.goTo("kitchen");
    await tick();
    assert.equal(t.snap().player.placeId, "kitchen");
    const direct = await t.client.command({ type: "world.act", ...t.base(), actionId: "wact_01HZZZZZZZZZZZZZZZZZZZZZZ1", action: { type: "move", to: "room_claude" } });
    assert.deepEqual(direct, { accepted: false, reason: "not_adjacent" });
    await t.actions.world.goTo("room_claude");
    await tick();
    assert.equal(t.snap().player.placeId, "room_claude");
    assert.equal(t.w().rejected, null);
  });

  it("邀她一起看书：空着就答应，真的去看；你过去加入就是一起看；书只在一处", async () => {
    const t = await opened();
    await t.actions.world.goTo("room_claude");
    assert.equal(t.resident("claude").placeId, "room_claude");
    assert.equal(await t.actions.world.invite("claude", "read"), true);
    await tick();
    assert.equal(t.snap().commitments[0]?.state, "asked");
    await t.advance(3);
    assert.equal(t.snap().commitments[0]?.state, "pending", "答应了，还没开始");
    // 书在客厅：她走过去开始看
    await t.advance(3);
    let read = t.snap().activities.find((a) => a.kind === "read")!;
    assert.ok(read, "她真的开始看了");
    assert.equal(read.placeId, "living_room");
    assert.equal(t.book().usedBy, read.id);
    const views = commitmentViews(t.snap(), worldNames(t.snap(), (a) => a));
    assert.equal(views.length, 1);
    assert.equal(views[0]!.cancellable, true);
    // 你也过去，加入
    await t.actions.world.goTo("living_room");
    assert.equal(await t.actions.world.join(read.id), true);
    await tick();
    read = t.snap().activities.find((a) => a.kind === "read")!;
    assert.equal(read.participants.length, 2);
    assert.equal(t.snap().player.activityId, read.id);
    // 你手上有事的时候走不了
    await t.actions.world.goTo("kitchen");
    assert.equal(t.w().rejected?.reason, "actor_busy");
    await t.advance(read.endsAt - t.snap().now);
    assert.equal(t.snap().commitments.length, 0, "做完了，约定到终态");
    assert.equal(t.book().usedBy, null);
    assert.equal(t.snap().player.activityId, null);
  });

  it("邀正忙着的她：说晚点，到点真的有下文", async () => {
    const t = await opened();
    for (let i = 0; i < 40 && !t.snap().activities.some((a) => a.kind === "cook"); i++) await t.advance(1);
    const cook = t.snap().activities.find((a) => a.kind === "cook")!;
    const chef = cook.participants[0]!;
    assert.ok(chef.kind === "resident");
    await t.actions.world.goTo("kitchen");
    assert.equal(await t.actions.world.invite(chef.agent, "set_table"), true);
    await t.advance(3);
    const c = t.snap().commitments.find((x) => x.activity === "set_table")!;
    assert.equal(c.state, "deferred");
    assert.equal(c.dueAt, cook.endsAt + 5);
    assert.ok(t.w().events.some((e) => e.type === "said" && e.speaker.kind === "resident" && e.speaker.agent === chef.agent));
    await t.advance(cook.endsAt + 60 - t.snap().now);
    assert.ok(t.w().events.some((e) => e.type === "action" && e.action.type === "start" && e.action.activity === "set_table"), "忙完以后真的去摆餐桌了");
  });

  it("同一个 actionId 再发一次不重复生效；内容不一样按 duplicate_action 拒绝", async () => {
    const t = await opened();
    const req = { type: "world.act" as const, ...t.base(), actionId: "wact_01HZZZZZZZZZZZZZZZZZZZZZZ2", action: { type: "move" as const, to: "kitchen" } };
    const a = await t.client.command(req);
    const b = await t.client.command(req);
    assert.deepEqual(a, b);
    assert.equal(a.accepted, true);
    await tick();
    assert.equal(t.w().events.filter((e) => e.type === "action" && e.actor.kind === "player").length, 1);
    const c = await t.client.command({ ...req, action: { type: "move", to: "living_room" } });
    assert.deepEqual(c, { accepted: false, reason: "duplicate_action" });
  });

  it("暂停：时间不走、操作被拒绝；继续后代次变了，旧代次的操作作废", async () => {
    const t = await opened();
    await t.advance(10);
    const before = t.base();
    await t.actions.world.pause();
    const at = t.snap().now;
    const seq = t.snap().lastSeq;
    assert.deepEqual(t.snap().run, { state: "paused", by: "user" });
    assert.equal(t.snap().minutesPerRealSecond, 0);
    await t.advance(60);
    assert.equal(t.snap().now, at);
    assert.equal(t.snap().lastSeq, seq);
    assert.equal(await t.actions.world.goTo("kitchen"), undefined);
    assert.equal(t.w().rejected?.reason, "world_paused");
    await t.actions.world.resume();
    assert.equal(t.snap().generation.runSeq, before.generation.runSeq + 1);
    assert.equal(t.snap().generation.session, before.generation.session);
    const stale = await t.client.command({ type: "world.act", ...before, actionId: "wact_01HZZZZZZZZZZZZZZZZZZZZZZ3", action: { type: "move", to: "kitchen" } });
    assert.deepEqual(stale, { accepted: false, reason: "stale_generation" });
    await t.actions.world.goTo("kitchen");
    await tick();
    assert.equal(t.snap().player.placeId, "kitchen");
    assert.equal(t.w().rejected, null);
  });

  it("重置：新的一局、序号从 1 开始、时间线清空；同一个 requestId 重发不会再重置一次", async () => {
    const t = await opened();
    await t.advance(120);
    const old = t.snap().id;
    await t.actions.world.reset();
    await tick();
    assert.notEqual(t.snap().id, old);
    assert.equal(t.snap().lastSeq, 1);
    assert.deepEqual(t.w().events.map((e) => e.seq), [1]);
    const requestId = "wact_01HZZZZZZZZZZZZZZZZZZZZZZ4";
    const first = await t.client.command({ type: "world.reset", requestId, worldId: t.snap().id, confirm: true });
    const again = await t.client.command({ type: "world.reset", requestId, worldId: t.snap().id, confirm: true });
    assert.equal(again.world!.id, first.world!.id);
    await assert.rejects(t.client.command({ type: "world.reset", requestId: "wact_01HZZZZZZZZZZZZZZZZZZZZZZ5", worldId: old, confirm: true }), /刷新/);
  });

  it("还没开始：world 是 null，选好住进来的人以后开始", async () => {
    const t = await opened({ seed: false });
    assert.equal(t.w().loaded, true);
    assert.equal(t.w().world, null);
    assert.deepEqual(t.w().settings?.residents, ["claude", "codex"]);
    await t.actions.world.start(["claude", "deepseek"]);
    await tick();
    assert.deepEqual(t.snap().residents.map((r) => r.agent), ["claude", "deepseek"]);
    assert.equal(t.w().starting, false);
    assert.equal(t.w().selected, "claude");
  });

  it("她知道什么：书被挪走时不在场的人不知道新位置；只有亲眼看到的才算", async () => {
    const t = await opened();
    // 演示后台的作息里，居民偶尔会把书拿回自己房间。等到有人把书放进自己房间为止
    const putInOwnRoom = () =>
      t.w().events.find((e) => e.type === "action" && e.action.type === "put" && e.actor.kind === "resident" && e.placeId.startsWith("room_"));
    for (let i = 0; i < 1500 && !putInOwnRoom(); i++) await t.advance(1);
    const put = putInOwnRoom();
    assert.ok(put && put.type === "action" && put.actor.kind === "resident", "一天之内有人把书拿回了房间");
    const mover = put.actor.agent;
    const other = t.snap().residents.find((r) => r.agent !== mover)!.agent;
    const view = async (agent: string) => client.query({ type: "world.residentView", worldId: t.snap().id, agent });
    const client = t.client;
    const a = (await view(mover)).knownItems.find((k) => k.itemId === "book")!;
    assert.deepEqual(a.at, { kind: "place", placeId: put.placeId }, "挪书的人知道在哪");
    assert.equal(a.seq, put.seq);
    const bView = await view(other);
    const b = bView.knownItems.find((k) => k.itemId === "book")!;
    assert.notDeepEqual(b.at, a.at, "另一位没进过那间屋：不知道书在那里");
    assert.ok(b.seq < put.seq, "她知道的还是之前亲眼看到的");
    assert.equal(bView.seen.some((e) => e.seq === put.seq), false);
    assert.ok(bView.seen.every((e) => e.type !== "said"), "听到的话不混进看到的事里");
  });

  it("节点不在线：世界照样过，她按作息生活，界面拿得到原因；找她说话明说没法回应", async () => {
    const t = await opened({ offline: ["claude"] });
    assert.deepEqual(t.resident("claude").cognition, { mode: "routine", reason: "offline" });
    assert.deepEqual(t.resident("codex").cognition, { mode: "model" });
    await t.advance(120);
    assert.ok(t.w().events.some((e) => e.type === "action" && e.actor.kind === "resident" && e.actor.agent === "claude"));
    await t.actions.world.goTo(t.resident("claude").placeId);
    assert.equal(await t.actions.world.talk("claude"), true);
    const sc = t.w().scene!;
    assert.equal(sc.canType, false);
    assert.equal(sc.lines[0]?.source, "rule");
    assert.equal(sc.lines[0]?.speaker, null);
    assert.equal(t.snap().sceneId, sc.id);
    assert.equal(await t.actions.world.sceneClose(sc.id), true);
    await tick();
    assert.equal(t.w().scene, null);
    assert.equal(t.snap().sceneId, null);
  });

  it("找她说话：要在同一间屋；问饭的进度她说的是真实进度；选项只能用一次", async () => {
    const t = await opened();
    for (let i = 0; i < 40 && !t.snap().activities.some((a) => a.kind === "cook"); i++) await t.advance(1);
    const cook = t.snap().activities.find((a) => a.kind === "cook")!;
    const chef = cook.participants[0]!;
    assert.ok(chef.kind === "resident");
    assert.equal(await t.actions.world.talk(chef.agent), false);
    assert.equal(t.w().rejected?.reason, "not_same_place");
    await t.actions.world.goTo("kitchen");
    assert.equal(await t.actions.world.talk(chef.agent), true);
    const sc = t.w().scene!;
    const left = cook.endsAt - t.snap().now;
    assert.match(sc.lines[0]!.text, new RegExp(`还要 ${left} 分钟`));
    assert.equal(await t.actions.world.sceneSay(sc.id, "饭好了吗"), true);
    assert.equal(t.w().scene!.state, "waiting");
    await t.advance(2);
    const reply = t.w().scene!.lines.at(-1)!;
    assert.equal(reply.source, "model");
    assert.match(reply.text, /饭还没好/);
    assert.equal(t.w().scene!.state, "open");
    const said = t.w().events.filter((e) => e.type === "said" && e.sceneId === sc.id);
    assert.equal(said.length, 3, "开场一句、你一句、她回一句，都留了事件");
    // 选「邀她一起看书」：走同一套规则，留下约定
    assert.equal(await t.actions.world.sceneChoose(sc.id, "opt_read"), true);
    await tick();
    assert.ok(t.snap().commitments.some((c) => c.activity === "read" && c.state === "asked"));
    assert.equal(await t.actions.world.sceneChoose(sc.id, "opt_read"), false);
    assert.equal(t.w().rejected?.reason, "option_expired");
    assert.equal(t.snap().commitments.filter((c) => c.activity === "read").length, 1, "连点两次不会邀两次");
  });

  it("过到第二天：有昨天的回顾，每一条都指回事件", async () => {
    const t = await opened();
    await t.advance(1440 - 420 + 5);
    assert.equal(dayOf(t.snap().now), 2);
    await t.actions.world.showReview();
    const review = t.w().reviews[1]!;
    assert.equal(t.w().reviewDay, 1);
    assert.ok(review.items.length > 0);
    const seqs = new Set((await t.client.query({ type: "world.events", worldId: t.snap().id, limit: 100 })).items.map((e) => e.seq));
    for (const item of review.items.slice(-5)) for (const s of item.seqs) assert.ok(seqs.has(s) || s < Math.min(...seqs));
    // 时间线翻页能读到更早的
    const before = t.w().events.length;
    await t.actions.world.loadMoreEvents();
    assert.ok(t.w().events.length >= before);
  });

  it("给人看的话：事件和居民状态换成一句话", async () => {
    const t = await opened();
    await t.advance(60);
    const names = worldNames(t.snap(), (a) => (a === "claude" ? "C酱" : "林离"));
    const lines = t.w().events.map((e) => eventText(e, names));
    assert.ok(lines.some((l) => /^(C酱|林离)去了/.test(l)));
    assert.ok(lines.every((l) => !/room_|wavt_|undefined/.test(l)), "不漏内部 id");
    assert.match(residentLine(t.resident("claude"), t.snap(), names), /^在/);
  });
});
