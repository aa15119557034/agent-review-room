import {
  WORLD_DAILY_COGNITION_DEFAULT,
  WORLD_DAY_REAL_MINUTES_DEFAULT,
  WORLD_MINUTES_PER_DAY,
  WORLD_SCENE_MAX_MODEL_TURNS,
  type ControlEvent,
  type WorldAction,
  type WorldActionResult,
  type WorldActivity,
  type WorldActivityKind,
  type WorldActor,
  type WorldBudget,
  type WorldCommitment,
  type WorldDayReview,
  type WorldEvent,
  type WorldGeneration,
  type WorldItem,
  type WorldItemLocation,
  type WorldObservation,
  type WorldPlace,
  type WorldRejectReason,
  type WorldResidentView,
  type WorldScene,
  type WorldSceneOption,
  type WorldSettings,
  type WorldSnapshot,
  type WorldState,
} from "@room/schemas";
import { ACTIVITY_DOING, ACTIVITY_LABEL, REJECT_TEXT, clockText } from "../lib/world";
import { MockError, id, now as isoNow } from "./util";

/**
 * 世界的内存实现（C-54 界面开发用，契约 C-53）。**演示用，不是 X-40 规则内核的参考**：
 * 数值（做饭多久、体力怎么掉）、作息、她怎么答复邀约都是随手定的，台词是写死的几句。
 *
 * 和契约对齐的部分（界面要靠它们）：
 * - 你的操作和居民的动作走同一个 apply()，拒绝原因用 WorldRejectReason
 * - 一局 = 一个 WorldId，seq 从 1 连续；重置开新的一局；同一个 actionId / requestId 重发返回第一次的结果
 * - 代次 = { session, runSeq }，暂停再继续 runSeq 加一，对不上的操作按 stale_generation 拒绝
 * - 材料开始时占用、结束时结算一次（activity_ended 的 consumed / produced）
 * - 观察按「当时在不在同一间屋」记；residentView 只从她自己的观察里出
 *
 * 时间：autoTick（默认开）时第一次有人读世界才开始按现实时间走；测试里关掉，用 advance(分钟) 一步步推。
 */
export interface WorldMockOptions {
  /** 预置一局已经在过的世界。false = 还没开始，界面显示「开始」 */
  seed?: boolean;
  autoTick?: boolean;
  /** 这些居民的节点不在线：按作息生活，不回话 */
  offline?: string[];
  /** 每位每天的思考次数上限 */
  dailyLimit?: number;
}

interface Ctx {
  emit(e: ControlEvent): void;
  agents(): { id: string; displayName: string }[];
}

const PLAYER: WorldActor = { kind: "player" };
const res = (agent: string): WorldActor => ({ kind: "resident", agent });
const same = (a: WorldActor, b: WorldActor) => a.kind === b.kind && (a.kind === "player" || (b.kind === "resident" && a.agent === b.agent));

const DURATION: Record<WorldActivityKind, number> = { cook: 45, eat: 30, read: 60, rest: 30, sleep: 480, tidy: 30, set_table: 15 };
/** 和 X-40 当前的数一致：16 份食材，一份做 4 份饭，没有每日补给，用完就是用完了 */
const COOK_USES = 1;
const COOK_MAKES = 4;
const INGREDIENTS_AT_START = 16;
const START_MINUTE = 7 * 60;
const SNAPSHOT_EVERY = 15;

interface Known { at: WorldItemLocation | null; count: number | null; asOf: number; seq: number }
type Goal = { place: string; then: WorldAction | null; commitmentId: string | null };
interface Resident {
  agent: string;
  placeId: string;
  energy: number;
  satiety: number;
  mood: number;
  activityId: string | null;
  known: Map<string, Known>;
  goal: Goal | null;
  thinkAt: number;
  /** 这一顿（第几天 + 早中晚）已经处理过，不再反复去找吃的 */
  meal: string | null;
  /** 没吃上（没饭也做不了）以后，过了这个时间再去找吃的 */
  foodRetryAt: number;
  turn: number;
}
interface Running { activity: WorldActivity; reserved: { itemId: string; count: number }[] }
interface PendingReply { sceneId: string; agent: string; at: number; text: string }

interface World {
  id: string;
  generation: WorldGeneration;
  paused: "user" | "maintenance" | null;
  now: number;
  carry: number;
  lastReal: number;
  lastSnapshotAt: number;
  seq: number;
  places: WorldPlace[];
  residents: Resident[];
  player: { placeId: string; activityId: string | null };
  items: WorldItem[];
  running: Map<string, Running>;
  commitments: WorldCommitment[];
  events: WorldEvent[];
  observations: WorldObservation[];
  scenes: WorldScene[];
  sceneId: string | null;
  sceneTurns: Map<string, number>;
  replies: PendingReply[];
  reviews: Map<number, WorldDayReview>;
  results: Map<string, { key: string; result: unknown }>;
}

export function createWorldMock(ctx: Ctx, options: WorldMockOptions = {}) {
  const offline = new Set(options.offline ?? []);
  let settings: WorldSettings;
  /** 个人房间的 id 是 room_1..room_8（和 X-40 一致），不从名字拼：名字可以有连字符、可以很长，地点 id 不行。归谁看 owner */
  const roomOf = (agent: string) => `room_${settings.residents.indexOf(agent) + 1}`;
  let w: World | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let dirty = false;
  const receipts = new Map<string, WorldState>();
  const used = new Map<string, number>();
  let budgetDay = "";

  const name = (agent: string) => ctx.agents().find((a) => a.id === agent)?.displayName ?? agent;
  const who = (a: WorldActor) => (a.kind === "player" ? "你" : name(a.agent));

  function defaults(): WorldSettings {
    const known = ctx.agents().map((a) => a.id);
    const prefer = ["claude", "codex"].filter((a) => known.includes(a));
    return {
      dayRealMinutes: WORLD_DAY_REAL_MINUTES_DEFAULT,
      dailyCognitionLimit: options.dailyLimit ?? WORLD_DAILY_COGNITION_DEFAULT,
      residents: prefer.length ? prefer : known.length ? known.slice(0, 2) : ["claude", "codex"],
    };
  }

  // ---------------------------------------------------------------- 用量（按本地自然日，记在世界之外）

  function localDay(d = new Date()) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  function rollBudget() {
    const today = localDay();
    if (today !== budgetDay) {
      budgetDay = today;
      used.clear();
    }
  }
  function budgets(): WorldBudget[] {
    rollBudget();
    const next = new Date();
    next.setHours(24, 0, 0, 0);
    return settings.residents.map((agent) => ({
      agent, day: budgetDay, used: used.get(agent) ?? 0, limit: settings.dailyCognitionLimit, resetsAt: next.toISOString(),
    }));
  }
  const canThink = (agent: string) => {
    rollBudget();
    return !offline.has(agent) && (used.get(agent) ?? 0) < settings.dailyCognitionLimit;
  };
  /** 发之前先记账；记不上（用完了、不在线）就不发 */
  function spend(agent: string): boolean {
    if (!canThink(agent)) return false;
    used.set(agent, (used.get(agent) ?? 0) + 1);
    ctx.emit({ type: "world.budget.updated", budgets: budgets() });
    return true;
  }

  // ---------------------------------------------------------------- 建一局

  function build(): World {
    const agents = settings.residents;
    const places: WorldPlace[] = [
      { id: "living_room", label: "客厅", neighbors: ["kitchen", ...agents.map(roomOf)], owner: null },
      { id: "kitchen", label: "厨房", neighbors: ["living_room"], owner: null },
      ...agents.map((a) => ({ id: roomOf(a), label: `${name(a)}的房间`, neighbors: ["living_room"], owner: a })),
    ];
    const at = (placeId: string): WorldItemLocation => ({ kind: "place", placeId });
    const items: WorldItem[] = [
      { kind: "unique", id: "book", label: "小说", at: at("living_room"), usedBy: null },
      { kind: "unique", id: "pot", label: "锅", at: at("kitchen"), usedBy: null },
      { kind: "unique", id: "table", label: "餐桌", at: at("kitchen"), usedBy: null },
      { kind: "stock", id: "ingredients", label: "食材", placeId: "kitchen", count: INGREDIENTS_AT_START },
      { kind: "stock", id: "meal", label: "饭", placeId: "kitchen", count: 0 },
    ];
    return {
      id: id("world"),
      generation: { session: id("wses"), runSeq: 0 },
      paused: null,
      now: START_MINUTE,
      carry: 0,
      lastReal: Date.now(),
      lastSnapshotAt: START_MINUTE,
      seq: 0,
      places,
      residents: agents.map((agent, i) => ({
        agent, placeId: roomOf(agent), energy: 82 - i * 6, satiety: 48 + i * 8, mood: 66 + i * 4,
        activityId: null, known: new Map(), goal: null, thinkAt: START_MINUTE + 1 + i * 3, meal: null, foodRetryAt: 0, turn: i,
      })),
      player: { placeId: "living_room", activityId: null },
      items,
      running: new Map(),
      commitments: [],
      events: [],
      observations: [],
      scenes: [],
      sceneId: null,
      sceneTurns: new Map(),
      replies: [],
      reviews: new Map(),
      results: new Map(),
    };
  }

  function open() {
    w = build();
    commit({ type: "clock", mark: "day_started", day: 1 });
    // 开局时每个人都知道家里东西原来放在哪（第 7 条验收：之后被挪了，不在场的人不知道）
    for (const r of w.residents) for (const it of w.items) learn(r, it.id, 1);
  }

  // ---------------------------------------------------------------- 小工具

  const world = (): World => {
    if (!w) throw new MockError("not_found", "世界还没有开始");
    return w;
  };
  const resident = (agent: string) => w!.residents.find((r) => r.agent === agent);
  const item = (itemId: string) => w!.items.find((i) => i.id === itemId);
  const stock = (itemId: string) => {
    const it = item(itemId);
    return it?.kind === "stock" ? it : undefined;
  };
  const placeOf = (a: WorldActor) => (a.kind === "player" ? w!.player.placeId : resident(a.agent)?.placeId);
  const activityOf = (a: WorldActor) => (a.kind === "player" ? w!.player.activityId : (resident(a.agent)?.activityId ?? null));
  const setActivity = (a: WorldActor, activityId: string | null) => {
    if (a.kind === "player") w!.player.activityId = activityId;
    else {
      const r = resident(a.agent);
      if (r) r.activityId = activityId;
    }
  };
  const asleep = (r: Resident) => (r.activityId ? w!.running.get(r.activityId)?.activity.kind === "sleep" : false);
  const round = (v: number) => Math.max(0, Math.min(100, Math.round(v)));
  const bump = (a: WorldActor, key: "energy" | "satiety" | "mood", by: number) => {
    if (a.kind !== "resident") return;
    const r = resident(a.agent);
    if (r) r[key] = Math.max(0, Math.min(100, r[key] + by));
  };

  function snapshot(): WorldSnapshot {
    const x = world();
    return {
      id: x.id,
      generation: { ...x.generation },
      rulesVersion: "mock-1",
      run: x.paused ? { state: "paused", by: x.paused } : { state: "running" },
      now: x.now,
      asOf: isoNow(),
      minutesPerRealSecond: x.paused ? 0 : rate(),
      lastSeq: x.seq,
      places: x.places,
      residents: x.residents.map((r) => ({
        agent: r.agent, placeId: r.placeId, energy: round(r.energy), satiety: round(r.satiety), mood: round(r.mood), activityId: r.activityId,
        cognition: offline.has(r.agent)
          ? { mode: "routine", reason: "offline" }
          : canThink(r.agent) ? { mode: "model" } : { mode: "routine", reason: "budget" },
      })),
      player: { ...x.player },
      items: x.items,
      activities: [...x.running.values()].map((r) => r.activity),
      commitments: x.commitments.filter((c) => c.state === "asked" || c.state === "pending" || c.state === "deferred"),
      sceneId: x.sceneId,
    };
  }
  const rate = () => WORLD_MINUTES_PER_DAY / (settings.dayRealMinutes * 60);
  const state = (): WorldState => ({
    world: w ? snapshot() : null,
    scene: w?.sceneId ? (w.scenes.find((s) => s.id === w!.sceneId) ?? null) : null,
    settings,
    budgets: budgets(),
  });
  function push() {
    dirty = false;
    if (!w) return;
    w.lastSnapshotAt = w.now;
    ctx.emit({ type: "world.updated", world: snapshot() });
  }
  const pushScene = (sc: WorldScene) => ctx.emit({ type: "world.scene.updated", scene: structuredClone(sc) });

  // ---------------------------------------------------------------- 事件和观察

  /** 她从 seq 这条亲眼看到的事件里，知道了这样东西现在在哪 */
  function learn(r: Resident, itemId: string, seq: number, missing = false) {
    const it = item(itemId);
    if (!it) return;
    if (missing) r.known.set(itemId, { at: null, count: null, asOf: w!.now, seq });
    else if (it.kind === "stock") r.known.set(itemId, { at: { kind: "place", placeId: it.placeId }, count: it.count, asOf: w!.now, seq });
    else r.known.set(itemId, { at: structuredClone(it.at), count: null, asOf: w!.now, seq });
  }
  const visibleIn = (placeId: string) =>
    w!.items.filter((i) => (i.kind === "stock" ? i.placeId === placeId : i.at.kind === "place" ? i.at.placeId === placeId : placeOf(i.at.by) === placeId));

  type Draft =
    | { type: "action"; actor: WorldActor; action: WorldAction; placeId: string; activityId?: string | null; commitmentId?: string | null; sceneId?: string | null; optionId?: string | null; alsoSeenIn?: string }
    | { type: "activity_ended"; placeId: string; activity: WorldActivity; produced: { itemId: string; count: number }[]; consumed: { itemId: string; count: number }[] }
    | { type: "said"; placeId: string; speaker: WorldActor; text: string; sceneId?: string | null }
    | { type: "clock"; mark: "day_started" | "day_ended"; day: number }
    | { type: "scene"; placeId: string; sceneId: string; step: "opened" | "chose" | "closed"; optionId?: string | null; result?: WorldActionResult | null };

  function commit(d: Draft): number {
    const x = w!;
    const seq = ++x.seq;
    const base = { seq, at: x.now };
    let event: WorldEvent;
    let also: string | undefined;
    switch (d.type) {
      case "action":
        also = d.alsoSeenIn;
        event = { ...base, type: "action", placeId: d.placeId, actor: d.actor, action: d.action, activityId: d.activityId ?? null, commitmentId: d.commitmentId ?? null, sceneId: d.sceneId ?? null, optionId: d.optionId ?? null };
        break;
      case "activity_ended":
        event = { ...base, type: "activity_ended", placeId: d.placeId, activity: d.activity, produced: d.produced, consumed: d.consumed };
        break;
      case "said":
        event = { ...base, type: "said", placeId: d.placeId, speaker: d.speaker, text: d.text, sceneId: d.sceneId ?? null };
        break;
      case "clock":
        event = { ...base, type: "clock", mark: d.mark, day: d.day };
        break;
      case "scene":
        event = { ...base, type: "scene", placeId: d.placeId, sceneId: d.sceneId, step: d.step, optionId: d.optionId ?? null, result: d.result ?? null };
        break;
    }
    x.events.push(event);
    // 谁看到了：当时在这间屋（走动时出发和到达的两间都算）、醒着的居民。场景的开合只是界面记录，不算谁的观察
    if (event.type !== "scene") {
      const here = "placeId" in event ? [event.placeId, also].filter(Boolean) : null;
      for (const r of x.residents) {
        const actorIsSelf = event.type === "action" && same(event.actor, res(r.agent));
        if (here && !here.includes(r.placeId)) continue;
        if (asleep(r) && !actorIsSelf && event.type !== "activity_ended") continue;
        x.observations.push({ observer: r.agent, seq, at: x.now, mode: event.type === "said" ? "heard" : "saw" });
        if (event.type === "action") {
          const a = event.action;
          if (a.type === "take" || a.type === "put") learn(r, a.itemId, seq);
          if (a.type === "start" && a.itemId) learn(r, a.itemId, seq);
          // 自己动手开始做一件事：占用了多少材料她自己清楚
          if (a.type === "start" && actorIsSelf) for (const it of visibleIn(r.placeId)) learn(r, it.id, seq);
          // 自己走进一间屋：看到屋里有什么
          if (a.type === "move" && actorIsSelf) for (const it of visibleIn(r.placeId)) learn(r, it.id, seq);
          // 看到别人带着东西进出
          if (a.type === "move" && !actorIsSelf) for (const it of x.items) if (it.kind === "unique" && it.at.kind === "held" && same(it.at.by, event.actor)) learn(r, it.id, seq);
        }
        if (event.type === "activity_ended") for (const p of [...event.produced, ...event.consumed]) learn(r, p.itemId, seq);
      }
    }
    ctx.emit({ type: "world.event", worldId: x.id, event: structuredClone(event) });
    dirty = true;
    return seq;
  }
  const say = (speaker: WorldActor, text: string, sceneId: string | null = null) =>
    commit({ type: "said", placeId: placeOf(speaker) ?? w!.player.placeId, speaker, text, sceneId });

  // ---------------------------------------------------------------- 规则：一个动作能不能做，做了改什么

  const reject = (reason: WorldRejectReason): WorldActionResult => ({ accepted: false, reason });
  const terminal = (c: WorldCommitment) => !["asked", "pending", "deferred"].includes(c.state);

  function apply(actor: WorldActor, action: WorldAction, via: { sceneId?: string | null; optionId?: string | null } = {}): WorldActionResult {
    const x = world();
    const here = placeOf(actor);
    if (!here) return reject("unknown_target");
    const ok = (extra: { activityId?: string | null; commitmentId?: string | null; alsoSeenIn?: string } = {}): WorldActionResult => ({
      accepted: true,
      seq: commit({ type: "action", actor, action, placeId: placeOf(actor)!, ...via, ...extra }),
    });
    switch (action.type) {
      case "move": {
        const from = x.places.find((p) => p.id === here)!;
        if (!x.places.some((p) => p.id === action.to)) return reject("unknown_target");
        if (activityOf(actor)) return reject("actor_busy");
        if (!from.neighbors.includes(action.to)) return reject("not_adjacent");
        if (actor.kind === "player") x.player.placeId = action.to;
        else resident(actor.agent)!.placeId = action.to;
        return ok({ alsoSeenIn: here });
      }
      case "take": {
        const it = item(action.itemId);
        if (!it) return reject("unknown_target");
        if (it.kind !== "unique") return reject("not_allowed");
        if (it.at.kind !== "place" || it.at.placeId !== here) return reject("item_not_here");
        if (it.usedBy) return reject("item_busy");
        if (it.id !== "book") return reject("not_allowed");
        it.at = { kind: "held", by: actor };
        return ok();
      }
      case "put": {
        const it = item(action.itemId);
        if (!it) return reject("unknown_target");
        if (it.kind !== "unique" || it.at.kind !== "held" || !same(it.at.by, actor)) return reject("item_not_here");
        if (it.usedBy) return reject("item_busy");
        it.at = { kind: "place", placeId: here };
        return ok();
      }
      case "start": {
        if (activityOf(actor)) return reject("actor_busy");
        const kind = action.activity;
        const reserved: { itemId: string; count: number }[] = [];
        const uses: string[] = [];
        const free = (itemId: string): WorldRejectReason | null => {
          const it = item(itemId);
          if (!it || it.kind !== "unique") return "unknown_target";
          const reachable = it.at.kind === "place" ? it.at.placeId === here : same(it.at.by, actor);
          if (!reachable) return "item_not_here";
          return it.usedBy ? "item_busy" : null;
        };
        if (kind === "cook" || kind === "eat" || kind === "set_table") {
          if (here !== "kitchen") return reject("not_allowed");
        }
        if (kind === "sleep" && (actor.kind !== "resident" || here !== roomOf(actor.agent))) return reject("not_allowed");
        if (kind === "cook") {
          const bad = free("pot");
          if (bad) return reject(bad);
          if ((stock("ingredients")?.count ?? 0) < COOK_USES) return reject("out_of_stock");
          uses.push("pot");
          reserved.push({ itemId: "ingredients", count: COOK_USES });
        }
        if (kind === "eat") {
          if ((stock("meal")?.count ?? 0) < 1) return reject("out_of_stock");
          reserved.push({ itemId: "meal", count: 1 });
        }
        if (kind === "set_table") {
          const bad = free("table");
          if (bad) return reject(bad);
          uses.push("table");
        }
        if (kind === "read") {
          if (action.itemId !== "book") return reject(action.itemId ? "not_allowed" : "unknown_target");
          const bad = free("book");
          if (bad) return reject(bad);
          uses.push("book");
        }
        const activityId = id("wavt");
        let endsAt = x.now + DURATION[kind];
        if (kind === "sleep") {
          const day = Math.floor(x.now / WORLD_MINUTES_PER_DAY) * WORLD_MINUTES_PER_DAY;
          const wake = x.now % WORLD_MINUTES_PER_DAY < START_MINUTE ? day + START_MINUTE : day + WORLD_MINUTES_PER_DAY + START_MINUTE;
          endsAt = Math.max(x.now + 60, wake);
        }
        for (const r of reserved) stock(r.itemId)!.count -= r.count;
        for (const u of uses) (item(u) as Extract<WorldItem, { kind: "unique" }>).usedBy = activityId;
        x.running.set(activityId, {
          activity: { id: activityId, kind, participants: [actor], placeId: here, itemIds: uses, startedAt: x.now, endsAt, state: "running", endReason: null },
          reserved,
        });
        setActivity(actor, activityId);
        return ok({ activityId });
      }
      case "stop": {
        const activityId = activityOf(actor);
        const run = activityId ? x.running.get(activityId) : undefined;
        if (!run) return reject("not_allowed");
        const result = ok({ activityId });
        setActivity(actor, null);
        run.activity.participants = run.activity.participants.filter((p) => !same(p, actor));
        if (run.activity.participants.length === 0) settle(run, actor.kind === "player" ? "cancelled_by_player" : "cancelled_by_actor");
        else if (run.activity.kind === "eat") {
          // 一起吃时中途走开的那位：她那一份退回去
          const meal = run.reserved.find((r) => r.itemId === "meal");
          if (meal && meal.count > 0) {
            meal.count -= 1;
            stock("meal")!.count += 1;
          }
        }
        return result;
      }
      case "invite": {
        const target = action.to.kind === "player" ? PLAYER : resident(action.to.agent) ? action.to : null;
        if (!target || same(target, actor)) return reject("unknown_target");
        if (placeOf(target) !== here) return reject("not_same_place");
        const c: WorldCommitment = { id: id("wcom"), by: target, to: actor, activity: action.activity, dueAt: null, state: "asked", activityId: null, createdAt: x.now };
        x.commitments.push(c);
        return ok({ commitmentId: c.id });
      }
      case "answer": {
        const c = x.commitments.find((k) => k.id === action.commitmentId);
        if (!c) return reject("unknown_target");
        if (c.state !== "asked" || !same(c.by, actor)) return reject("not_allowed");
        c.state = action.answer === "accept" ? "pending" : action.answer === "later" ? "deferred" : "declined";
        c.dueAt = action.answer === "later" ? action.dueAt : null;
        return ok({ commitmentId: c.id });
      }
      case "join": {
        const run = x.running.get(action.activityId);
        if (!run) return reject("unknown_target");
        if (run.activity.placeId !== here) return reject("not_same_place");
        if (activityOf(actor)) return reject("actor_busy");
        if (run.activity.kind === "sleep") return reject("not_allowed");
        if (run.activity.kind === "eat") {
          if ((stock("meal")?.count ?? 0) < 1) return reject("out_of_stock");
          stock("meal")!.count -= 1;
          run.reserved.find((r) => r.itemId === "meal")!.count += 1;
        }
        run.activity.participants = [...run.activity.participants, actor];
        setActivity(actor, run.activity.id);
        // 你答应过她的那件事：加入就算履行了
        const c = x.commitments.find((k) => k.state === "pending" && same(k.by, actor) && k.activity === run.activity.kind && run.activity.participants.some((p) => same(p, k.to)));
        if (c) c.activityId = run.activity.id;
        return ok({ activityId: run.activity.id, commitmentId: c?.id ?? null });
      }
      case "cancel": {
        const c = x.commitments.find((k) => k.id === action.commitmentId);
        if (!c) return reject("unknown_target");
        if (terminal(c) || !(same(c.by, actor) || same(c.to, actor))) return reject("not_allowed");
        c.state = "cancelled";
        return ok({ commitmentId: c.id });
      }
    }
  }

  /** 活动结算：每个活动只有一条 activity_ended，材料在这里结一次 */
  function settle(run: Running, reason: NonNullable<WorldActivity["endReason"]>) {
    const x = w!;
    const a = run.activity;
    const done = reason === "done";
    x.running.delete(a.id);
    for (const itemId of a.itemIds) {
      const it = item(itemId);
      if (it?.kind === "unique" && it.usedBy === a.id) it.usedBy = null;
    }
    const produced: { itemId: string; count: number }[] = [];
    const consumed: { itemId: string; count: number }[] = [];
    if (done) {
      for (const r of run.reserved) if (r.count > 0) consumed.push({ ...r });
      if (a.kind === "cook") {
        stock("meal")!.count += COOK_MAKES;
        produced.push({ itemId: "meal", count: COOK_MAKES });
      }
    } else {
      for (const r of run.reserved) stock(r.itemId)!.count += r.count;
    }
    for (const p of a.participants) {
      setActivity(p, null);
      if (!done) continue;
      if (a.kind === "eat") bump(p, "satiety", 55);
      if (a.kind === "rest") bump(p, "energy", 12);
      if (a.kind === "read") bump(p, "mood", a.participants.length > 1 ? 12 : 7);
      if (a.kind === "tidy" || a.kind === "set_table") bump(p, "mood", 3);
      if (a.kind === "cook") bump(p, "mood", 5);
    }
    const ended: WorldActivity = { ...a, state: done ? "completed" : "cancelled", endReason: reason };
    commit({ type: "activity_ended", placeId: a.placeId, activity: ended, produced, consumed });
    for (const c of x.commitments) {
      if (c.activityId !== a.id || terminal(c)) continue;
      c.state = done ? "done" : "cancelled";
    }
    for (const p of a.participants) {
      if (p.kind !== "resident") continue;
      const r = resident(p.agent);
      if (r) r.thinkAt = x.now + 2;
    }
  }

  // ---------------------------------------------------------------- 居民自己怎么过（演示用的简单作息）

  const mealKey = (minute: number) => {
    const h = Math.floor((minute % WORLD_MINUTES_PER_DAY) / 60);
    const slot = h >= 7 && h < 9 ? "早" : h >= 12 && h < 14 ? "午" : h >= 18 && h < 20 ? "晚" : null;
    return slot ? `${Math.floor(minute / WORLD_MINUTES_PER_DAY)}${slot}` : null;
  };

  function stepToward(r: Resident, place: string): boolean {
    if (r.placeId === place) return true;
    // 这间小屋里任何两间屋最多隔着客厅
    const here = w!.places.find((p) => p.id === r.placeId)!;
    const next = here.neighbors.includes(place) ? place : "living_room";
    apply(res(r.agent), { type: "move", to: next });
    return r.placeId === place;
  }

  function act(r: Resident) {
    const x = w!;
    const me = res(r.agent);
    if (r.activityId || x.now < r.thinkAt) return;

    // 1. 答应了别人的事：走过去，开始做
    const due = x.commitments.find((c) => c.state === "pending" && same(c.by, me) && c.activityId === null);
    if (due) {
      const target = placeOf(due.to);
      // 看书要去她知道的书所在的那间屋；厨房里的事去厨房；别的去找邀她的人
      const book = r.known.get("book")?.at;
      const where =
        due.activity === "cook" || due.activity === "eat" || due.activity === "set_table" ? "kitchen"
        : due.activity === "read" && book?.kind === "place" ? book.placeId
        : (target ?? r.placeId);
      if (!stepToward(r, where)) return;
      const result = apply(me, { type: "start", activity: due.activity, itemId: due.activity === "read" ? "book" : null });
      if (result.accepted) {
        // 不替你行动：她开始以后，你要一起做就自己点「加入」
        due.activityId = r.activityId;
      } else {
        say(me, `${ACTIVITY_LABEL[due.activity]}做不了：${REJECT_TEXT[result.reason]}`);
        due.state = "cancelled";
        commit({ type: "action", actor: me, action: { type: "cancel", commitmentId: due.id }, placeId: r.placeId, commitmentId: due.id });
        r.thinkAt = x.now + 5;
      }
      return;
    }

    // 2. 正往哪儿走、到了要做什么
    if (r.goal) {
      const goal = r.goal;
      if (!stepToward(r, goal.place)) return;
      r.goal = null;
      if (!goal.then) return void (r.thinkAt = x.now + 4);
      const result = apply(me, goal.then);
      // 拿到书以后带去另一间屋放下
      if (result.accepted && goal.then.type === "take") {
        const to = r.placeId === roomOf(r.agent) ? "living_room" : roomOf(r.agent);
        r.goal = { place: to, then: { type: "put", itemId: goal.then.itemId }, commitmentId: null };
        return;
      }
      if (!result.accepted) {
        if (goal.then.type === "take") {
          say(me, result.reason === "item_busy" ? "书有人在看，我晚点再拿。" : "咦，书不在这儿了？");
          if (result.reason !== "item_busy") learn(r, "book", x.seq, true);
        }
        if (goal.then.type === "start" && goal.then.activity === "read") {
          const book = item("book");
          const reader = book?.kind === "unique" && book.usedBy ? x.running.get(book.usedBy)?.activity.participants[0] : undefined;
          if (result.reason === "item_busy" && reader) say(me, `书${who(reader)}在看，我等会儿再看。`);
          else {
            // 她以为书在这里，其实被挪走了
            say(me, "咦，书不在这儿了？");
            learn(r, "book", x.seq, true);
          }
        } else if (goal.then.type === "start" && goal.then.activity === "cook") {
          say(me, result.reason === "out_of_stock" ? "食材不够了，做不了饭。" : "锅有人在用，我等一下。");
          if (result.reason === "out_of_stock") r.foodRetryAt = x.now + 180;
        }
        r.thinkAt = x.now + 12;
      }
      return;
    }

    const hour = Math.floor((x.now % WORLD_MINUTES_PER_DAY) / 60);
    const go = (place: string, then: WorldAction | null) => void (r.goal = { place, then, commitmentId: null });
    const start = (activity: WorldActivityKind, itemId: string | null = null): WorldAction => ({ type: "start", activity, itemId });

    // 3. 该睡了
    if (hour >= 22 || hour < 7) return go(roomOf(r.agent), start("sleep"));

    // 4. 到饭点或者饿了：有饭就吃，没饭就做
    const key = mealKey(x.now);
    if (((key && r.meal !== key) || r.satiety < 30) && x.now >= r.foodRetryAt) {
      const cooking = [...x.running.values()].some((k) => k.activity.kind === "cook");
      if ((stock("meal")?.count ?? 0) > 0) {
        if (key) r.meal = key;
        return go("kitchen", start("eat"));
      }
      // 有人在做了：过去等着，做好再吃
      if (cooking) return go("kitchen", null);
      return go("kitchen", start("cook"));
    }

    // 5. 累了歇会儿
    if (r.energy < 25) return void apply(me, start("rest"));

    // 6. 空档：轮着来
    r.turn += 1;
    switch (r.turn % 6) {
      case 0: {
        const k = r.known.get("book");
        if (k?.at?.kind === "place") return go(k.at.placeId, start("read", "book"));
        return void apply(me, start("tidy"));
      }
      case 1:
        return go("living_room", start("tidy"));
      case 2: {
        const other = x.residents.find((o) => o.agent !== r.agent && o.placeId === r.placeId && !asleep(o));
        if (other) say(me, r.mood > 60 ? `${name(other.agent)}，今天感觉不错。` : `${name(other.agent)}，我有点没精神。`);
        r.thinkAt = x.now + 15;
        return;
      }
      case 4: {
        // 把书从客厅拿回自己房间，或者从自己房间放回客厅（第 7 条验收：不在场的人不知道书被挪了）
        const k = r.known.get("book");
        if (k?.at?.kind === "place") return go(k.at.placeId, { type: "take", itemId: "book" });
        return void apply(me, start("rest"));
      }
      default:
        return go(r.placeId === "living_room" ? roomOf(r.agent) : "living_room", start("rest"));
    }
  }

  /** 被邀的居民怎么答：睡着或太累 → 来不了；手上有事 → 晚点；否则答应 */
  function answer(c: WorldCommitment) {
    if (c.by.kind !== "resident") return;
    const r = resident(c.by.agent);
    if (!r) return;
    const me = res(r.agent);
    const run = r.activityId ? w!.running.get(r.activityId) : undefined;
    spend(r.agent);
    if (run?.activity.kind === "sleep" || r.energy < 15) {
      apply(me, { type: "answer", commitmentId: c.id, answer: "decline", dueAt: null });
      if (run?.activity.kind !== "sleep") say(me, "我太累了，这次来不了。");
    } else if (run) {
      const dueAt = run.activity.endsAt + 5;
      apply(me, { type: "answer", commitmentId: c.id, answer: "later", dueAt });
      say(me, `等我把手上的事做完，${clockText(dueAt)} 左右。`);
    } else {
      apply(me, { type: "answer", commitmentId: c.id, answer: "accept", dueAt: null });
      say(me, "好啊。");
      r.goal = null;
      r.thinkAt = w!.now;
    }
  }

  function review(day: number) {
    const x = w!;
    const from = (day - 1) * WORLD_MINUTES_PER_DAY;
    const items: WorldDayReview["items"] = [];
    for (const e of x.events) {
      if (e.at < from || e.at >= from + WORLD_MINUTES_PER_DAY || items.length >= 40) continue;
      if (e.type === "activity_ended" && e.activity.endReason === "done" && e.activity.kind !== "sleep") {
        const names = e.activity.participants.map(who).join("和");
        const made = e.produced.length ? `，做出了 ${e.produced[0]!.count} 份饭` : "";
        items.push({ seqs: [e.seq], text: `${clockText(e.at)} ${names}${ACTIVITY_LABEL[e.activity.kind]}${made}`, source: "rule" });
      }
      if (e.type === "action" && e.action.type === "answer" && e.commitmentId) {
        const c = x.commitments.find((k) => k.id === e.commitmentId);
        if (!c) continue;
        const how = e.action.answer === "accept" ? "答应了" : e.action.answer === "later" ? "说晚点" : "说来不了";
        items.push({ seqs: [e.seq], text: `${clockText(e.at)} ${who(c.to)}邀${who(c.by)}${ACTIVITY_LABEL[c.activity]}，${who(c.by)}${how}`, source: "rule" });
      }
    }
    const r: WorldDayReview = { day, items };
    x.reviews.set(day, r);
    ctx.emit({ type: "world.review.created", worldId: x.id, review: r });
  }

  /** 世界往前走一分钟 */
  function minute() {
    const x = w!;
    x.now += 1;
    if (x.now % WORLD_MINUTES_PER_DAY === 0) {
      const day = x.now / WORLD_MINUTES_PER_DAY;
      commit({ type: "clock", mark: "day_ended", day });
      review(day);
      commit({ type: "clock", mark: "day_started", day: day + 1 });
    }
    for (const r of x.residents) {
      const kind = r.activityId ? x.running.get(r.activityId)?.activity.kind : undefined;
      r.energy = Math.max(0, Math.min(100, r.energy + (kind === "sleep" ? 0.16 : kind === "rest" ? 0.25 : -0.07)));
      r.satiety = Math.max(0, r.satiety - (kind === "sleep" ? 0.03 : 0.11));
      if (r.satiety < 20 || r.energy < 15) r.mood = Math.max(0, r.mood - 0.08);
    }
    for (const run of [...x.running.values()]) if (run.activity.endsAt <= x.now) settle(run, "done");
    for (const c of x.commitments) {
      if (c.state === "deferred" && c.dueAt !== null && c.dueAt <= x.now) {
        c.state = "pending";
        dirty = true;
        if (c.by.kind === "resident") {
          say(c.by, `${who(c.to)}，我忙完了，这就来。`);
          const r = resident(c.by.agent);
          if (r) {
            r.goal = null;
            r.thinkAt = x.now;
          }
        }
      } else if (c.state === "asked" && x.now - c.createdAt >= 2 && c.by.kind === "resident") answer(c);
      else if (c.state === "asked" && x.now - c.createdAt > 90) {
        c.state = "expired";
        dirty = true;
      } else if (c.state === "pending" && c.activityId === null && x.now - c.createdAt > 240) {
        c.state = "expired";
        dirty = true;
      }
    }
    for (const r of x.residents) act(r);
    // 她开始吃饭、你也在厨房：邀你一起（给「等你答复」留一个演示入口）
    for (const run of x.running.values()) {
      const a = run.activity;
      if (a.kind !== "eat" || a.startedAt !== x.now || x.player.placeId !== a.placeId || x.player.activityId) continue;
      const host = a.participants[0]!;
      if (host.kind !== "resident" || x.commitments.some((c) => !terminal(c) && same(c.by, PLAYER))) continue;
      if ((stock("meal")?.count ?? 0) < 1) continue;
      if (apply(host, { type: "invite", to: PLAYER, activity: "eat" }).accepted) say(host, "一起吃吗？");
    }
    for (const reply of x.replies.filter((p) => p.at <= x.now)) {
      x.replies = x.replies.filter((p) => p !== reply);
      const sc = x.scenes.find((s) => s.id === reply.sceneId);
      if (!sc || sc.state !== "waiting") continue;
      const seq = say(res(reply.agent), reply.text, sc.id);
      sc.lines.push({ speaker: res(reply.agent), text: reply.text, expression: "neutral", source: "model", seq });
      sc.state = "open";
      pushScene(sc);
    }
    if (x.now - x.lastSnapshotAt >= SNAPSHOT_EVERY) dirty = true;
  }

  function advance(minutes: number) {
    if (!w || w.paused) return;
    for (let i = 0; i < minutes; i++) minute();
    if (dirty) push();
  }

  function catchUp() {
    if (!w || w.paused) return;
    const real = Date.now();
    const total = w.carry + ((real - w.lastReal) / 1000) * rate();
    w.lastReal = real;
    const whole = Math.min(Math.floor(total), 120);
    w.carry = total - Math.floor(total);
    if (whole > 0) advance(whole);
  }
  function ensureTicking() {
    if (options.autoTick === false || timer) return;
    if (w) w.lastReal = Date.now();
    timer = setInterval(catchUp, 500);
    (timer as { unref?: () => void }).unref?.();
  }

  // ---------------------------------------------------------------- 场景（你找她说话）

  function openScene(agent: string): { sc: WorldScene; openedSeq: number } {
    const x = w!;
    const r = resident(agent)!;
    const me = res(agent);
    const run = r.activityId ? x.running.get(r.activityId) : undefined;
    const online = spend(agent);
    const sc: WorldScene = {
      id: id("wscn"),
      generation: { ...x.generation },
      origin: { kind: "player", agent },
      placeId: r.placeId,
      residents: [agent],
      lines: [],
      options: [],
      past: [],
      canType: online,
      state: "open",
      openedAt: x.now,
      createdAt: isoNow(),
    };
    x.scenes.push(sc);
    x.sceneId = sc.id;
    x.sceneTurns.set(sc.id, online ? 1 : 0);
    const openedSeq = commit({ type: "scene", placeId: sc.placeId, sceneId: sc.id, step: "opened" });
    if (!online) {
      const why = offline.has(agent) ? "她现在不在线" : "她今天的思考次数用完了";
      sc.lines.push({ speaker: null, text: `${name(agent)}${run ? ACTIVITY_DOING[run.activity.kind] : "在这里"}。${why}，没法回应你说的话。`, expression: "neutral", source: "rule", seq: null });
    } else {
      const text = run
        ? run.activity.kind === "cook"
          ? `我在做饭，大概还要 ${Math.max(1, run.activity.endsAt - x.now)} 分钟才好。`
          : `我${ACTIVITY_DOING[run.activity.kind]}呢。怎么了？`
        : "嗯？怎么了？";
      sc.lines.push({ speaker: me, text, expression: r.energy < 25 ? "tired" : r.mood > 70 ? "happy" : "neutral", source: "model", seq: say(me, text, sc.id) });
    }
    const opts: WorldSceneOption[] = [];
    if (run?.activity.kind !== "sleep") opts.push({ id: "opt_read", label: "邀她一起看书", act: { actor: PLAYER, action: { type: "invite", to: me, activity: "read" } } });
    if (!run) opts.push({ id: "opt_rest", label: "劝她去休息一会儿", act: { actor: me, action: { type: "start", activity: "rest", itemId: null } } });
    opts.push({ id: "opt_bye", label: "没事了", act: null });
    sc.options = opts;
    return { sc, openedSeq };
  }

  function closeScene(sc: WorldScene): number {
    const x = w!;
    sc.past = [...sc.past, ...sc.options.map((option) => ({ option, outcome: "expired" as const, seq: null }))];
    sc.options = [];
    sc.state = "closed";
    if (x.sceneId === sc.id) x.sceneId = null;
    x.replies = x.replies.filter((p) => p.sceneId !== sc.id);
    return commit({ type: "scene", placeId: sc.placeId, sceneId: sc.id, step: "closed" });
  }

  function replyTo(agent: string, text: string): string {
    const r = resident(agent)!;
    const run = r.activityId ? w!.running.get(r.activityId) : undefined;
    if (/饭|吃|饿/.test(text)) {
      if (run?.activity.kind === "cook") return `饭还没好，大概还要 ${Math.max(1, run.activity.endsAt - w!.now)} 分钟。`;
      const k = r.known.get("meal");
      return k?.count ? `我上次看到厨房里还有 ${k.count} 份饭。` : "我上次看的时候厨房里没有做好的饭。";
    }
    if (/书|小说/.test(text)) {
      const k = r.known.get("book");
      if (!k?.at) return "书？我不清楚现在在哪。";
      const at = k.at;
      return at.kind === "place" ? `我记得书在${w!.places.find((p) => p.id === at.placeId)?.label ?? "某个地方"}。` : `我看到是${who(at.by)}拿着。`;
    }
    if (/累|休息|睡/.test(text)) return r.energy < 40 ? "是有点累了，一会儿去歇歇。" : "我还好，不累。";
    return "嗯，我知道了。";
  }

  // ---------------------------------------------------------------- 你的操作：防重复、代次、暂停

  function guarded<T>(req: { worldId: string; generation: WorldGeneration; actionId: string }, key: unknown, run: () => T, rejected: (reason: WorldRejectReason) => T): T {
    const x = world();
    if (req.worldId !== x.id) throw new MockError("not_found", "这一局已经不在了");
    const k = JSON.stringify(key);
    const seen = x.results.get(req.actionId);
    if (seen) return seen.key === k ? (structuredClone(seen.result) as T) : rejected("duplicate_action");
    catchUp();
    let result: T;
    if (req.generation.session !== x.generation.session || req.generation.runSeq !== x.generation.runSeq) result = rejected("stale_generation");
    else if (x.paused) result = rejected("world_paused");
    else result = run();
    x.results.set(req.actionId, { key: k, result: structuredClone(result) });
    if (dirty) push();
    return result;
  }
  const sceneResult = (result: WorldActionResult, sceneId: string | null) => ({
    result,
    scene: sceneId ? structuredClone(w!.scenes.find((s) => s.id === sceneId) ?? null) : null,
  });

  settings = defaults();
  const init = () => {
    settings = defaults();
    w = null;
    used.clear();
    receipts.clear();
    if (options.seed) open();
  };
  init();

  return {
    /** 测试用：世界往前走这么多分钟（暂停时不动） */
    advance,
    /** 测试用：让某位居民的节点掉线 / 回来 */
    setOffline(agent: string, off: boolean) {
      if (off) offline.add(agent);
      else offline.delete(agent);
      if (w) push();
    },
    queries: {
      async "world.get"() {
        ensureTicking();
        catchUp();
        return state();
      },
      async "world.residentView"(req: { worldId: string; agent: string }): Promise<WorldResidentView> {
        const x = world();
        const r = resident(req.agent);
        if (req.worldId !== x.id || !r) throw new MockError("not_found", "没有这位居民");
        const mine = x.observations.filter((o) => o.observer === r.agent).reverse();
        const bySeq = (seq: number) => x.events[seq - 1]!;
        return {
          agent: r.agent,
          worldId: x.id,
          knownItems: [...r.known.entries()].map(([itemId, k]) => ({ itemId, ...structuredClone(k) })),
          seen: mine.filter((o) => o.mode === "saw").slice(0, 100).map((o) => bySeq(o.seq)),
          heard: mine.filter((o) => o.mode === "heard").slice(0, 100).flatMap((o) => {
            const e = bySeq(o.seq);
            return e.type === "said" ? [{ seq: e.seq, at: e.at, speaker: e.speaker, text: e.text }] : [];
          }),
        };
      },
      async "world.events"(req: { worldId: string; before?: number; limit: number }) {
        const x = world();
        if (req.worldId !== x.id) throw new MockError("not_found", "这一局已经不在了");
        const upTo = Math.min(req.before ? req.before - 1 : x.seq, x.seq);
        const items = x.events.slice(Math.max(0, upTo - req.limit), upTo).reverse();
        const last = items[items.length - 1]?.seq ?? 1;
        return { items, nextBefore: last > 1 ? last : null };
      },
      async "world.scenes"(req: { worldId: string; before?: string; limit: number }) {
        const x = world();
        if (req.worldId !== x.id) throw new MockError("not_found", "这一局已经不在了");
        const closed = x.scenes.filter((s) => s.state === "closed").reverse();
        const from = req.before ? closed.findIndex((s) => s.id === req.before) + 1 : 0;
        const items = closed.slice(from, from + req.limit);
        return { items, nextBefore: from + req.limit < closed.length ? items[items.length - 1]!.id : null };
      },
      async "world.review"(req: { worldId: string; day: number }) {
        const x = world();
        if (req.worldId !== x.id) throw new MockError("not_found", "这一局已经不在了");
        return x.reviews.get(req.day) ?? null;
      },
    },
    commands: {
      async "world.act"(req: { worldId: string; generation: WorldGeneration; actionId: string; action: WorldAction }) {
        return guarded<WorldActionResult>(req, req.action, () => apply(PLAYER, req.action), reject);
      },
      async "world.talk"(req: { worldId: string; generation: WorldGeneration; actionId: string; agent: string }) {
        return guarded(req, ["talk", req.agent], () => {
          const x = w!;
          const r = resident(req.agent);
          if (!r) return sceneResult(reject("unknown_target"), null);
          if (x.sceneId) return sceneResult(reject("actor_busy"), x.sceneId);
          if (r.placeId !== x.player.placeId) return sceneResult(reject("not_same_place"), null);
          const { sc, openedSeq } = openScene(req.agent);
          pushScene(sc);
          return sceneResult({ accepted: true, seq: openedSeq }, sc.id);
        }, (reason) => sceneResult(reject(reason), null));
      },
      async "world.scene.choose"(req: { worldId: string; generation: WorldGeneration; actionId: string; sceneId: string; optionId: string }) {
        return guarded(req, ["choose", req.sceneId, req.optionId], () => {
          const x = w!;
          const sc = x.scenes.find((s) => s.id === req.sceneId);
          if (!sc) return sceneResult(reject("unknown_target"), null);
          if (sc.state === "closed") return sceneResult(reject("scene_closed"), sc.id);
          const option = sc.options.find((o) => o.id === req.optionId);
          if (!option) return sceneResult(reject(sc.past.some((p) => p.option.id === req.optionId) ? "option_expired" : "unknown_target"), sc.id);
          const outcome = option.act ? apply(option.act.actor, option.act.action, { sceneId: sc.id, optionId: option.id }) : null;
          const seq = commit({ type: "scene", placeId: sc.placeId, sceneId: sc.id, step: "chose", optionId: option.id, result: outcome });
          sc.past = [
            ...sc.past,
            { option, outcome: "chosen" as const, seq },
            ...sc.options.filter((o) => o !== option).map((o) => ({ option: o, outcome: "expired" as const, seq: null })),
          ];
          sc.options = [];
          if (!option.act) closeScene(sc);
          else {
            const text = outcome!.accepted ? (option.act.action.type === "invite" ? "你问了她，等她答复。" : "她照做了。") : `没成：${REJECT_TEXT[outcome!.reason]}`;
            sc.lines.push({ speaker: null, text, expression: "neutral", source: "rule", seq: null });
            sc.options = [{ id: `opt_done_${sc.past.length}`, label: "好", act: null }];
          }
          pushScene(sc);
          return sceneResult({ accepted: true, seq }, sc.id);
        }, (reason) => sceneResult(reject(reason), req.sceneId));
      },
      async "world.scene.say"(req: { worldId: string; generation: WorldGeneration; actionId: string; sceneId: string; text: string }) {
        return guarded(req, ["say", req.sceneId, req.text], () => {
          const x = w!;
          const sc = x.scenes.find((s) => s.id === req.sceneId);
          if (!sc) return sceneResult(reject("unknown_target"), null);
          if (sc.state === "closed") return sceneResult(reject("scene_closed"), sc.id);
          if (sc.state === "waiting") return sceneResult(reject("actor_busy"), sc.id);
          if (!sc.canType) return sceneResult(reject("not_allowed"), sc.id);
          const agent = sc.residents[0]!;
          const seq = say(PLAYER, req.text, sc.id);
          sc.lines.push({ speaker: PLAYER, text: req.text, expression: "neutral", source: "user", seq });
          const turns = x.sceneTurns.get(sc.id) ?? 0;
          if (turns >= WORLD_SCENE_MAX_MODEL_TURNS || !spend(agent)) {
            sc.canType = false;
            sc.lines.push({ speaker: null, text: `${name(agent)}现在没法再回应了。`, expression: "neutral", source: "rule", seq: null });
          } else {
            x.sceneTurns.set(sc.id, turns + 1);
            sc.state = "waiting";
            x.replies.push({ sceneId: sc.id, agent, at: x.now + 2, text: replyTo(agent, req.text) });
          }
          pushScene(sc);
          return sceneResult({ accepted: true, seq }, sc.id);
        }, (reason) => sceneResult(reject(reason), req.sceneId));
      },
      async "world.scene.close"(req: { worldId: string; generation: WorldGeneration; actionId: string; sceneId: string }) {
        return guarded(req, ["close", req.sceneId], () => {
          const sc = w!.scenes.find((s) => s.id === req.sceneId);
          if (!sc) return sceneResult(reject("unknown_target"), null);
          if (sc.state === "closed") return sceneResult(reject("scene_closed"), sc.id);
          const seq = closeScene(sc);
          pushScene(sc);
          return sceneResult({ accepted: true, seq }, sc.id);
        }, (reason) => sceneResult(reject(reason), req.sceneId));
      },
      async "world.pause"(req: { worldId: string }) {
        const x = world();
        if (req.worldId !== x.id) throw new MockError("not_found", "这一局已经不在了");
        catchUp();
        if (!x.paused) {
          x.paused = "user";
          push();
        }
        return snapshot();
      },
      async "world.resume"(req: { worldId: string }) {
        const x = world();
        if (req.worldId !== x.id) throw new MockError("not_found", "这一局已经不在了");
        if (x.paused) {
          x.paused = null;
          x.generation = { session: x.generation.session, runSeq: x.generation.runSeq + 1 };
          x.lastReal = Date.now();
          x.carry = 0;
          push();
        }
        return snapshot();
      },
      async "world.reset"(req: { requestId: string; worldId: string | null; settings?: WorldSettings }) {
        const receipt = receipts.get(req.requestId);
        if (receipt) return structuredClone(receipt);
        if ((w?.id ?? null) !== req.worldId) throw new MockError("invalid_state", "世界已经变了，请刷新后再试");
        if (req.settings) {
          const known = new Set(ctx.agents().map((a) => a.id));
          if (req.settings.residents.some((a) => !known.has(a))) throw new MockError("validation_failed", "没有这位秘书");
          settings = structuredClone(req.settings);
        }
        open();
        ensureTicking();
        const result = state();
        receipts.set(req.requestId, structuredClone(result));
        push();
        return result;
      },
      async "world.settings.save"(req: { settings: Omit<WorldSettings, "residents"> }) {
        catchUp();
        settings = { ...settings, ...req.settings };
        if (w) push();
        ctx.emit({ type: "world.budget.updated", budgets: budgets() });
        return settings;
      },
    },
    reset() {
      if (timer) clearInterval(timer);
      timer = null;
      init();
    },
  };
}
