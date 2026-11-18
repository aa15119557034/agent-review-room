import {
  WORLD_MINUTES_PER_DAY,
  type ControlEvent,
  type WorldAction,
  type WorldActivity,
  type WorldActivityKind,
  type WorldActor,
  type WorldBudget,
  type WorldCommitment,
  type WorldDayReview,
  type WorldEvent,
  type WorldItem,
  type WorldPlace,
  type WorldRejectReason,
  type WorldResident,
  type WorldResidentView,
  type WorldScene,
  type WorldSettings,
  type WorldSnapshot,
  type WorldState,
} from "@room/schemas";

/**
 * 世界（ADR-008 / C-54）在 renderer 里的状态、事件合并和显示用的纯函数。不依赖 React。
 *
 * 规矩和别处一样：世界里发生了什么只信后端。这里不推导任何事实（谁在哪、饭有几份），
 * 只做两件事：把后端推来的东西按「局 + 序号」合并，和把它们换成给人看的话。
 * 唯一自己算的是时钟：按快照的 now / asOf / 流速插值，不用后端每一刻都推。
 */

/** 时间线在界面里平时最多留多少条；往前翻页时会跟着变大 */
export const WORLD_EVENTS_KEEP = 300;

export interface WorldUiState {
  /** world.get 读过没有。没读过时界面显示「正在打开」而不是「还没开始」 */
  loaded: boolean;
  world: WorldSnapshot | null;
  /** 现在开着的场景（剧情界面在 C-56） */
  scene: WorldScene | null;
  /**
   * 对话框从 scene.lines 的第几句开始显示：最近一次更新新添的那几句的开头。
   * 她一次回话 main 是一起提交的（闲聊、事实句、动作没做成的说明），要一起看到；见 currentLines
   */
  sceneFrom: number;
  settings: WorldSettings | null;
  budgets: WorldBudget[];
  /** 时间线，新的在前。同一局内 seq 严格递减 */
  events: WorldEvent[];
  /** 还有没有更早的可以翻；null = 到头了 */
  eventsBefore: number | null;
  /** 时间线最多留多少条。平时是 WORLD_EVENTS_KEEP；往前翻页时跟着变大，重读第一页时复位 */
  eventsLimit: number;
  /** 已经关掉的场景（最近 30 个）。迟到的回执或推送不能让它们再开起来 */
  closedScenes: string[];
  /** 推来的事件和手里的对不上（中间缺了），要重新读一次时间线 */
  eventsStale: boolean;
  /** 已读到的每天回顾，按第几天存 */
  reviews: Record<number, WorldDayReview>;
  /** 右边在看哪位居民 */
  selected: string | null;
  /** 「她知道什么」：正在看谁的；data 还没读到是 null */
  knowledge: { agent: string; data: WorldResidentView | null } | null;
  /** 打开着的回顾是第几天；null = 没开 */
  reviewDay: number | null;
  /** 「以前的对话」：已经结束的场景，新的在前；null = 没开。只重放显示，不改世界 */
  pastScenes: { items: WorldScene[]; nextBefore: string | null; loading: boolean } | null;
  /** 最近一次操作被规则拒绝的原因，显示在世界页里，不占用全局错误条 */
  rejected: { reason: WorldRejectReason; nonce: number } | null;
  /** 正在开始 / 重置 */
  starting: boolean;
}

export const initialWorld: WorldUiState = {
  loaded: false,
  world: null,
  scene: null,
  sceneFrom: 0,
  settings: null,
  budgets: [],
  events: [],
  eventsBefore: null,
  eventsLimit: WORLD_EVENTS_KEEP,
  closedScenes: [],
  eventsStale: false,
  reviews: {},
  selected: null,
  knowledge: null,
  reviewDay: null,
  pastScenes: null,
  rejected: null,
  starting: false,
};

/** 换了一局（重置、第一次开始）：上一局的时间线、回顾、视角都不带过来 */
function enterWorld(state: WorldUiState, world: WorldSnapshot): WorldUiState {
  return {
    ...state,
    world,
    scene: null,
    sceneFrom: 0,
    events: [],
    eventsBefore: null,
    eventsLimit: WORLD_EVENTS_KEEP,
    closedScenes: [],
    eventsStale: true,
    reviews: {},
    knowledge: null,
    reviewDay: null,
    pastScenes: null,
    rejected: null,
    selected: world.residents.some((r) => r.agent === state.selected) ? state.selected : (world.residents[0]?.agent ?? null),
  };
}

/**
 * 一个请求发出时世界是哪一局、哪一代。回应回来时如果已经不是这一局这一代了，**整份回应都作废**：
 * 不拿它盖快照，也不拿它盖设置、用量、场景。不同会话之间不比大小（会话 id 是随机的，也不看墙上的钟），只看「还是不是发出时那一个」。
 */
export type WorldContext = { worldId: string; session: string; runSeq: number } | null;

export const worldContext = (state: Pick<WorldUiState, "world">): WorldContext =>
  state.world ? { worldId: state.world.id, session: state.world.generation.session, runSeq: state.world.generation.runSeq } : null;

export const sameContext = (a: WorldContext, b: WorldContext) =>
  a === null || b === null ? a === b : a.worldId === b.worldId && a.session === b.session && a.runSeq === b.runSeq;

/**
 * 用一份快照更新状态。返回原来的 state 对象 = 这份快照被丢掉了。
 * - 同一局同一个会话里，runSeq 不能倒退；runSeq 相同时，lastSeq 更小、或 lastSeq 相同但 asOf 更早的丢掉
 *   （命令的返回和事件推送谁先到不一定）
 * - 换了会话（重启、恢复、切换）：推送是按顺序来的，照收。迟到的查询 / 命令回应由发起方按 WorldContext 挡掉，不靠这里猜
 */
export function applySnapshot(state: WorldUiState, world: WorldSnapshot): WorldUiState {
  const cur = state.world;
  if (!cur || cur.id !== world.id) return enterWorld(state, world);
  if (cur.generation.session === world.generation.session) {
    if (world.generation.runSeq < cur.generation.runSeq) return state;
    if (world.generation.runSeq === cur.generation.runSeq) {
      if (world.lastSeq < cur.lastSeq) return state;
      if (world.lastSeq === cur.lastSeq && world.asOf < cur.asOf) return state;
    }
  }
  // 场景关了（sceneId 变成 null 或换了）而手里还拿着旧的：放下
  const scene = state.scene && state.scene.id === world.sceneId ? state.scene : null;
  return { ...state, world, scene };
}

/**
 * world.get / world.reset 的整份结果。调用方先按 WorldContext 确认这份回应没过期。
 * 里面的快照如果比手里的旧（被 applySnapshot 丢掉），设置、用量、场景也一起不用：它们是和那份旧快照同一时刻的。
 */
/**
 * 这份 world.get / world.reset 结果里的快照比手里的旧（推送先到了）。applyWorldState 会整份不用，
 * 设置也不收：回应在路上时设置可能又保存过（林离 #265）。调用方要按现在的状态重读一次，补上设置。
 */
export const isStaleState = (state: WorldUiState, data: WorldState) => data.world !== null && applySnapshot(state, data.world) === state;

export function applyWorldState(state: WorldUiState, data: WorldState): WorldUiState {
  const done: WorldUiState = { ...state, loaded: true, starting: false };
  if (!data.world) {
    return {
      ...done, settings: data.settings, budgets: data.budgets,
      world: null, scene: null, events: [], eventsBefore: null, eventsLimit: WORLD_EVENTS_KEEP, reviews: {}, knowledge: null, reviewDay: null, pastScenes: null,
    };
  }
  const next = applySnapshot(done, data.world);
  if (next === done) {
    // 快照比手里的旧（推送先到、世界又往前走了一步）：设置、用量、场景都不用。
    // 只有一种情况要留：手里还没有设置（刚开局，开局的回应比推送晚到），这一局的设置只能从这份回应里来
    return done.settings === null && done.world?.id === data.world.id ? { ...done, settings: data.settings } : done;
  }
  const withRest: WorldUiState = { ...next, settings: data.settings, budgets: data.budgets };
  if (!data.scene) return withRest;
  const withScene = applyScene(withRest, data.scene);
  // 整份读回来的、之前手里没有的场景（重开程序、重读）：不知道哪几句是一起来的，只显示最后一句
  return withScene.scene && state.scene?.id !== withScene.scene.id ? { ...withScene, sceneFrom: Math.max(0, withScene.scene.lines.length - 1) } : withScene;
}

/**
 * 一份场景（推送来的，或者命令回执里带的）能不能用。两条路走同一套检查，回执不能绕过去：
 * - 关闭的：记下这个 id，手里拿着的是它就放下。之后同一个 id 的「开着」再来也不认
 * - 开着的：代次要和现在的世界一样；快照说现在开着别的场景时不认；已经关过的不认
 */
export function applyScene(state: WorldUiState, sc: WorldScene): WorldUiState {
  const world = state.world;
  if (!world) return state;
  if (sc.state === "closed") {
    const closedScenes = state.closedScenes.includes(sc.id) ? state.closedScenes : [sc.id, ...state.closedScenes].slice(0, 30);
    if (state.scene?.id !== sc.id && closedScenes === state.closedScenes) return state;
    return { ...state, closedScenes, scene: state.scene?.id === sc.id ? null : state.scene };
  }
  if (state.closedScenes.includes(sc.id)) return state;
  if (sc.generation.session !== world.generation.session || sc.generation.runSeq !== world.generation.runSeq) return state;
  if (world.sceneId !== null && world.sceneId !== sc.id) return state;
  // 同一场对话多了几句：从新添的第一句开始显示。句数没变（继续后改挂代次、状态变化）保持原样；新的一场从头
  const held = state.scene?.id === sc.id ? state.scene : null;
  const sceneFrom = !held ? 0 : sc.lines.length > held.lines.length ? held.lines.length : Math.min(state.sceneFrom, Math.max(0, sc.lines.length - 1));
  return { ...state, scene: sc, sceneFrom };
}

/**
 * 一页时间线（新的在前）并进来。first = 从最新开始读的那一页：以它为准重建。
 * 翻更早的一页时窗口跟着变大（eventsLimit 加上这一页），不然刚读回来的旧页会被立刻裁掉、游标却往前走了。
 */
export function mergeEventsPage(
  state: WorldUiState,
  worldId: string,
  page: { items: WorldEvent[]; nextBefore: number | null },
  first: boolean,
): WorldUiState {
  if (state.world?.id !== worldId) return state;
  const bySeq = new Map<number, WorldEvent>();
  for (const e of first ? [] : state.events) bySeq.set(e.seq, e);
  for (const e of page.items) bySeq.set(e.seq, e);
  // 读第一页期间推来的更新的事件留着
  if (first) for (const e of state.events) if (!bySeq.has(e.seq) && e.seq > (page.items[0]?.seq ?? 0)) bySeq.set(e.seq, e);
  const events = [...bySeq.values()].sort((a, b) => b.seq - a.seq);
  const eventsLimit = first ? Math.max(WORLD_EVENTS_KEEP, events.length) : Math.max(state.eventsLimit, events.length);
  return { ...state, events, eventsLimit, eventsBefore: page.nextBefore, eventsStale: false };
}

/** 把后端推来的世界事件合并进状态。纯函数 */
export function applyWorldEvent(state: WorldUiState, event: ControlEvent): WorldUiState {
  switch (event.type) {
    case "world.updated":
      return applySnapshot(state, event.world);
    case "world.event": {
      if (state.world?.id !== event.worldId) return state;
      const top = state.events[0]?.seq ?? 0;
      if (event.event.seq <= top) return state;
      // 时间线还没读过第一页（eventsStale）时也先收着，读回来再对齐
      const gap = state.events.length > 0 && event.event.seq !== top + 1;
      const all = [event.event, ...state.events];
      const events = all.length > state.eventsLimit ? all.slice(0, state.eventsLimit) : all;
      return {
        ...state,
        events,
        // 裁掉了最旧的：游标退回到留下的最旧一条，再翻页从那里接着读，中间不留洞
        eventsBefore: events.length < all.length ? events[events.length - 1]!.seq : state.eventsBefore,
        eventsStale: state.eventsStale || gap,
      };
    }
    case "world.scene.updated":
      return applyScene(state, event.scene);
    case "world.review.created":
      if (state.world?.id !== event.worldId) return state;
      return { ...state, reviews: { ...state.reviews, [event.review.day]: event.review } };
    case "world.budget.updated":
      return { ...state, budgets: event.budgets };
    default:
      return state;
  }
}

// ---------------------------------------------------------------- 时钟

/** 现在世界里是第几分钟：按快照插值。暂停时流速是 0，停在 now */
export function worldNow(world: Pick<WorldSnapshot, "now" | "asOf" | "minutesPerRealSecond" | "run">, realNowMs: number): number {
  if (world.run.state !== "running") return world.now;
  const elapsed = Math.max(0, (realNowMs - Date.parse(world.asOf)) / 1000);
  return world.now + Math.floor(elapsed * world.minutesPerRealSecond);
}

export const dayOf = (minutes: number) => Math.floor(minutes / WORLD_MINUTES_PER_DAY) + 1;

export function clockText(minutes: number): string {
  const m = ((minutes % WORLD_MINUTES_PER_DAY) + WORLD_MINUTES_PER_DAY) % WORLD_MINUTES_PER_DAY;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** 「第 2 天 07:35」 */
export const dayClockText = (minutes: number) => `第 ${dayOf(minutes)} 天 ${clockText(minutes)}`;

/** 一天里的时段，画面的光线按它换 */
export function dayPhase(minutes: number): "night" | "morning" | "day" | "evening" {
  const h = Math.floor((minutes % WORLD_MINUTES_PER_DAY) / 60);
  if (h < 6 || h >= 22) return "night";
  if (h < 9) return "morning";
  if (h < 18) return "day";
  return "evening";
}

/** 活动做到哪了，0–1 */
export function activityProgress(a: Pick<WorldActivity, "startedAt" | "endsAt">, now: number): number {
  const span = a.endsAt - a.startedAt;
  if (span <= 0) return 1;
  return Math.min(1, Math.max(0, (now - a.startedAt) / span));
}

// ---------------------------------------------------------------- 给人看的话

export const ACTIVITY_LABEL: Record<WorldActivityKind, string> = {
  cook: "做饭",
  eat: "吃饭",
  read: "看书",
  rest: "休息",
  sleep: "睡觉",
  tidy: "收拾屋子",
  set_table: "摆餐桌",
};

/** 「正在…」的说法 */
export const ACTIVITY_DOING: Record<WorldActivityKind, string> = {
  cook: "在做饭",
  eat: "在吃饭",
  read: "在看书",
  rest: "在休息",
  sleep: "在睡觉",
  tidy: "在收拾屋子",
  set_table: "在摆餐桌",
};

/** 你能邀她做的事（睡觉、休息不用邀） */
export const INVITABLE: readonly WorldActivityKind[] = ["read", "set_table", "cook", "eat", "tidy"];

/** 规则拒绝的原因。界面只显示这些话，不让模型解释 */
export const REJECT_TEXT: Record<WorldRejectReason, string> = {
  stale_generation: "世界刚刚暂停过或恢复过，这一步没有生效，请再点一次。",
  world_paused: "世界现在暂停着，先按「继续」。",
  unknown_target: "找不到这个地方、东西或人。",
  not_adjacent: "那间屋和这里不相连，要先走到中间的屋子。",
  not_same_place: "要先走到同一间屋里。",
  actor_busy: "正在做别的事，先停下来才行。",
  item_busy: "那样东西正被别人用着。",
  item_not_here: "那样东西不在这里。",
  out_of_stock: "数量不够了（比如食材或饭）。",
  not_allowed: "这件事不能在这里这样做。",
  scene_closed: "这段对话已经结束了。",
  option_expired: "情况已经变了，这个选项失效了。",
  duplicate_action: "这一步和刚才发出的对不上，请再点一次。",
};

export interface WorldNames {
  agent(id: string): string;
  place(id: string): string;
  item(id: string): string;
}

/** 屋子显示的名字。有主人的卧室按主人的显示名来叫（后台给的 label 里是内部名，比如 claude） */
export const placeLabel = (place: Pick<WorldPlace, "label" | "owner">, agentName: (id: string) => string): string =>
  place.owner === null ? place.label : `${agentName(place.owner)}的房间`;

export function worldNames(world: Pick<WorldSnapshot, "places" | "items"> | null, agentName: (id: string) => string): WorldNames {
  const places = new Map((world?.places ?? []).map((p) => [p.id, placeLabel(p, agentName)]));
  const items = new Map((world?.items ?? []).map((i) => [i.id, i.label]));
  return {
    agent: agentName,
    place: (id) => places.get(id) ?? "某个地方",
    item: (id) => items.get(id) ?? "某样东西",
  };
}

export const actorName = (a: WorldActor, n: WorldNames) => (a.kind === "player" ? "你" : n.agent(a.agent));
const sameActor = (a: WorldActor, b: WorldActor) =>
  a.kind === b.kind && (a.kind === "player" || (b.kind === "resident" && a.agent === b.agent));
export const isPlayer = (a: WorldActor) => a.kind === "player";

function actionText(actor: WorldActor, action: WorldAction, n: WorldNames): string {
  const who = actorName(actor, n);
  switch (action.type) {
    case "move":
      return `${who}去了${n.place(action.to)}`;
    case "take":
      return `${who}拿起了${n.item(action.itemId)}`;
    case "put":
      return `${who}放下了${n.item(action.itemId)}`;
    case "start":
      return `${who}开始${ACTIVITY_LABEL[action.activity]}${action.itemId ? `（${n.item(action.itemId)}）` : ""}`;
    case "stop":
      return `${who}停下了手里的事`;
    case "invite":
      return `${who}邀${actorName(action.to, n)}${ACTIVITY_LABEL[action.activity]}`;
    case "answer":
      return action.answer === "accept" ? `${who}答应了` : action.answer === "later" ? `${who}说晚点（${clockText(action.dueAt ?? 0)}）` : `${who}说来不了`;
    case "join":
      return `${who}加入了进来`;
    case "cancel":
      return `${who}取消了约定`;
  }
}

const END_TEXT: Record<NonNullable<WorldActivity["endReason"]>, string> = {
  done: "",
  cancelled_by_actor: "自己停下了",
  cancelled_by_player: "被你叫停了",
  interrupted: "被打断了",
  missing_resource: "东西不够，没做成",
  world_reset: "世界重置了",
};

/** 时间线上的一行。said 返回说话人和原话，别的返回一句陈述 */
export function eventText(e: WorldEvent, n: WorldNames): string {
  switch (e.type) {
    case "action":
      return actionText(e.actor, e.action, n);
    case "activity_ended": {
      const who = e.activity.participants.map((p) => actorName(p, n)).join("和");
      const what = ACTIVITY_LABEL[e.activity.kind];
      if (e.activity.endReason !== "done") return `${who}${what}没做完：${END_TEXT[e.activity.endReason ?? "interrupted"]}`;
      const made = e.produced.map((p) => `多了 ${p.count} 份${n.item(p.itemId)}`).join("，");
      const used = e.consumed.map((p) => `用掉 ${p.count} 份${n.item(p.itemId)}`).join("，");
      const extra = [made, used].filter(Boolean).join("，");
      return `${who}${what}完了${extra ? `：${extra}` : ""}`;
    }
    case "said":
      return `${actorName(e.speaker, n)}：「${e.text}」`;
    case "clock":
      return e.mark === "day_started" ? `第 ${e.day} 天开始了` : `第 ${e.day} 天结束了`;
    case "scene":
      return e.step === "opened" ? "开始了一段对话" : e.step === "closed" ? "对话结束了" : "你做了选择";
  }
}

/** 时间线上不单独占一行的事件（场景的开合由对话界面自己表现） */
export const isTimelineNoise = (e: WorldEvent) => e.type === "scene";

/** 这位居民现在的一句话状态：「在厨房做饭」「在客厅」 */
export function residentLine(r: WorldResident, world: Pick<WorldSnapshot, "activities" | "places" | "items">, n: WorldNames): string {
  const act = r.activityId ? world.activities.find((a) => a.id === r.activityId) : undefined;
  const place = n.place(r.placeId);
  if (!act) return `在${place}`;
  const withWho = act.participants
    .filter((p) => !(p.kind === "resident" && p.agent === r.agent))
    .map((p) => actorName(p, n));
  return `在${place}${withWho.length ? `和${withWho.join("、")}一起` : ""}${ACTIVITY_LABEL[act.kind]}`;
}

/** 为什么她现在不是靠模型在行动；靠模型时是 null */
export function cognitionNote(r: WorldResident): string | null {
  if (r.cognition.mode === "model") return null;
  switch (r.cognition.reason) {
    case "offline":
      return "她现在不在线，按平常的作息生活";
    case "budget":
      return "今天的思考次数用完了，按平常的作息生活";
    case "busy_elsewhere":
      return "她正在聊天或讨论室里忙，这边先按作息生活";
  }
}

/** 状态数的档位，给颜色和读屏用 */
export const gaugeLevel = (v: number): "low" | "mid" | "high" => (v < 25 ? "low" : v < 60 ? "mid" : "high");

export interface CommitmentView {
  id: string;
  text: string;
  /** 等你答复（她邀的你） */
  awaitingYou: boolean;
  /** 和你有关、你可以取消 */
  cancellable: boolean;
  state: WorldCommitment["state"];
}

const COMMITMENT_STATE: Record<WorldCommitment["state"], string> = {
  asked: "等答复",
  pending: "答应了，还没开始",
  deferred: "说了晚点",
  declined: "来不了",
  done: "做完了",
  cancelled: "取消了",
  expired: "过期了",
};

/** 快照里还没到终态的约定，换成界面上的一行 */
export function commitmentViews(world: Pick<WorldSnapshot, "commitments" | "activities">, n: WorldNames): CommitmentView[] {
  const player: WorldActor = { kind: "player" };
  return world.commitments.map((c) => {
    const mine = sameActor(c.by, player) || sameActor(c.to, player);
    const due = c.state === "deferred" && c.dueAt !== null ? `，说好 ${clockText(c.dueAt)}` : "";
    // 答应了以后：约定上挂着一个还在进行的活动，才算「正在做」。不看台词、不按时间猜
    const doing = c.state === "pending" && c.activityId !== null && world.activities.some((a) => a.id === c.activityId && a.state === "running");
    return {
      id: c.id,
      text: `${actorName(c.to, n)}邀${actorName(c.by, n)}${ACTIVITY_LABEL[c.activity]}：${doing ? "正在做" : COMMITMENT_STATE[c.state]}${due}`,
      awaitingYou: c.state === "asked" && sameActor(c.by, player),
      cancellable: mine && (c.state === "asked" || c.state === "pending" || c.state === "deferred"),
      state: c.state,
    };
  });
}

/** 从 from 走到 to 要依次经过哪些屋（不含 from）。走不到返回 null；已经在那里返回 [] */
export function pathTo(places: readonly WorldPlace[], from: string, to: string): string[] | null {
  if (from === to) return [];
  const byId = new Map(places.map((p) => [p.id, p]));
  const prev = new Map<string, string>();
  const queue = [from];
  const seen = new Set([from]);
  while (queue.length) {
    const cur = queue.shift()!;
    for (const next of byId.get(cur)?.neighbors ?? []) {
      if (seen.has(next) || !byId.has(next)) continue;
      seen.add(next);
      prev.set(next, cur);
      if (next === to) {
        const path = [to];
        for (let p = prev.get(to); p && p !== from; p = prev.get(p)) path.unshift(p);
        return path;
      }
      queue.push(next);
    }
  }
  return null;
}

/** 一间屋里的东西：放在这里的，不含谁手里拿着的 */
export function itemsIn(world: Pick<WorldSnapshot, "items">, placeId: string): WorldItem[] {
  return world.items.filter((i) => (i.kind === "stock" ? i.placeId === placeId : i.at.kind === "place" && i.at.placeId === placeId));
}

/** 某个人手里拿着的东西 */
export function itemsHeldBy(world: Pick<WorldSnapshot, "items">, actor: WorldActor): WorldItem[] {
  return world.items.filter((i) => i.kind === "unique" && i.at.kind === "held" && sameActor(i.at.by, actor));
}

/** 「她知道什么」里一样东西的说法 */
export function knownItemText(k: WorldResidentView["knownItems"][number], n: WorldNames): string {
  const where = k.at === null ? "不知道在哪" : k.at.kind === "place" ? `在${n.place(k.at.placeId)}` : `在${actorName(k.at.by, n)}手里`;
  const count = k.count === null ? "" : `，${k.count} 份`;
  return `${n.item(k.itemId)}：${where}${count}（${dayClockText(k.asOf)}看到的）`;
}

/** 这位居民今天的思考次数，「12 / 60」；没有记录返回 null */
export function budgetText(budgets: readonly WorldBudget[], agent: string): string | null {
  const b = budgets.find((x) => x.agent === agent);
  return b ? `${b.used} / ${b.limit}` : null;
}

/** 场景里现在该显示的那一句：最后一句。没有台词时是 null */
export const currentLine = (scene: Pick<WorldScene, "lines">) => scene.lines[scene.lines.length - 1] ?? null;

/** 对话框里一次最多显示几句（闲聊、事实句、动作没做成的说明） */
export const SCENE_SHOWN_MAX = 3;

/**
 * 对话框里现在该显示的台词：最近一次更新新添的那几句（from = WorldUiState.sceneFrom），最多 SCENE_SHOWN_MAX 句。
 * 她一次回话可能是「闲聊（chat）→ 程序按证据写的话（model）→ 动作没做成的说明（rule）」，main 一起提交，
 * 这里一起显示，后一句不盖掉前一句。按「哪次更新带来的」分，不按说话人或 source 猜：台词上没有回话的 id，
 * 相邻两句是同一个人说的也不等于是同一次回话。
 */
export function currentLines(scene: Pick<WorldScene, "lines">, from: number): WorldScene["lines"] {
  const n = scene.lines.length;
  if (n === 0) return [];
  const start = Math.max(Math.min(Math.max(0, from), n - 1), n - SCENE_SHOWN_MAX);
  return scene.lines.slice(start);
}

/** 一间屋是哪一类，画面按它铺地板和摆设 */
export function placeKind(p: Pick<WorldPlace, "id" | "owner">): "bedroom" | "kitchen" | "living" {
  if (p.owner !== null) return "bedroom";
  return p.id === "kitchen" ? "kitchen" : "living";
}

/** 这个人最近（几分钟内）在场景之外说的一句话，画在头顶；没有是 null */
export function recentSaying(events: readonly WorldEvent[], actor: WorldActor, now: number, withinMinutes = 6): string | null {
  for (const e of events) {
    if (e.at < now - withinMinutes) return null;
    if (e.type === "said" && e.sceneId === null && sameActor(e.speaker, actor)) return e.text;
  }
  return null;
}
