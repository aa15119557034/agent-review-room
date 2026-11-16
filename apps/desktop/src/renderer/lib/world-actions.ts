import { WORLD_DAILY_COGNITION_DEFAULT, WORLD_DAY_REAL_MINUTES_DEFAULT } from "@room/schemas";
import type { ControlEvent, WorldActionResult, WorldActivityKind, WorldPlayerAction, WorldSceneResult } from "@room/schemas";
import type { RoomClient } from "./client";
import { newId } from "./ids";
import type { AppState } from "./state";
import type { Store } from "./store";
import {
  applyScene, applySnapshot, applyWorldState, dayOf, mergeEventsPage, pathTo, sameContext, worldContext, worldNow,
  type WorldContext, type WorldUiState,
} from "./world";

/**
 * 世界（C-54）的操作。和别处一样：组件只调这里，失败写进全局提示，不向上抛。
 * 被规则拒绝（accepted=false）不是失败，是正常结果：原因放在 world.rejected，由世界页自己显示。
 *
 * 每个请求发出时记下当时是哪一局哪一代（WorldContext）。回应回来时已经不是了，整份回应作废：
 * 推送和回应谁先到不一定，旧请求的回应不能盖掉新状态，旧意图也不能带进新的一局。
 */
export function createWorldActions(store: Store<AppState>, client: RoomClient, fail: (err: unknown) => void) {
  const set = (f: (w: WorldUiState) => WorldUiState) =>
    store.set((s) => {
      const world = f(s.world);
      return world === s.world ? s : { ...s, world };
    });
  const get = () => store.get().world;
  let nonce = 0;
  /** 防止连点「开始 / 重置」发两次 */
  let resetting = false;
  /** 时间线只让一个请求在读 */
  let readingEvents = false;

  const noteResult = (r: WorldActionResult) => {
    if (!r.accepted) set((w) => ({ ...w, rejected: { reason: r.reason, nonce: ++nonce } }));
    else set((w) => (w.rejected ? { ...w, rejected: null } : w));
    return r.accepted;
  };

  async function loadEvents(first: boolean) {
    const w = get();
    if (!w.world || readingEvents) return;
    if (!first && w.eventsBefore === null) return;
    readingEvents = true;
    const worldId = w.world.id;
    try {
      const page = await client.query({ type: "world.events", worldId, limit: 50, ...(first ? {} : { before: w.eventsBefore! }) });
      set((x) => mergeEventsPage(x, worldId, page, first));
    } catch (err) {
      fail(err);
    } finally {
      readingEvents = false;
    }
  }

  const context = () => worldContext(get());
  const stillIn = (ctx: WorldContext) => sameContext(ctx, context());
  /** 还是同一局、同一个会话（暂停继续不算换）。暂停 / 继续的回应用这个：它自己就会改 runSeq */
  const sameSession = (ctx: WorldContext) => {
    const now = context();
    return ctx !== null && now !== null && ctx.worldId === now.worldId && ctx.session === now.session;
  };

  async function load(retries = 2): Promise<void> {
    const ctx = context();
    try {
      const data = await client.query({ type: "world.get" });
      if (!stillIn(ctx)) {
        // 读的时候世界已经变了（重置、暂停继续…）：这份是旧的，不用它；按现在的重读
        if (retries > 0) return load(retries - 1);
        return void set((w) => (w.loaded ? w : { ...w, loaded: true }));
      }
      set((w) => applyWorldState(w, data));
      await loadEvents(true);
    } catch (err) {
      set((w) => ({ ...w, loaded: true }));
      fail(err);
    }
  }

  /**
   * 你的一个动作。bound = 这个动作是在哪一局哪一代下决定的；不给就用现在的。
   * 返回规则接没接受；世界没开、暂停着等情况由后端按原因拒绝。
   */
  async function act(action: WorldPlayerAction, bound: WorldContext = context()): Promise<boolean> {
    if (!bound || !stillIn(bound)) return false;
    try {
      const result = await client.command({
        type: "world.act", worldId: bound.worldId, generation: { session: bound.session, runSeq: bound.runSeq }, actionId: newId("wact"), action,
      });
      // 回应回来时已经换了局或代次：这次的结果和现在无关，不显示
      if (!stillIn(bound)) return false;
      return noteResult(result);
    } catch (err) {
      fail(err);
      return false;
    }
  }

  async function sceneCommand(run: (base: { worldId: string; generation: { session: string; runSeq: number }; actionId: string }) => Promise<WorldSceneResult>) {
    const ctx = context();
    if (!ctx) return false;
    try {
      const out = await run({ worldId: ctx.worldId, generation: { session: ctx.session, runSeq: ctx.runSeq }, actionId: newId("wact") });
      if (!stillIn(ctx)) return false;
      // 回执里的场景和推送来的走同一套检查（代次、是不是现在开着的那个、有没有关过）
      const scene = out.scene;
      if (scene) set((w) => applyScene(w, scene));
      return noteResult(out.result);
    } catch (err) {
      fail(err);
      return false;
    }
  }

  async function reset(residents?: string[]) {
    if (resetting) return;
    const w = get();
    // 还没配置秘书时后台给的 settings 是 null（C-59）：这时只有带着入住人选才能开始，其余用契约的默认值
    if (!w.loaded || (!w.settings && !residents)) return;
    const base = w.settings ?? { dayRealMinutes: WORLD_DAY_REAL_MINUTES_DEFAULT, dailyCognitionLimit: WORLD_DAILY_COGNITION_DEFAULT };
    resetting = true;
    const ctx = context();
    set((x) => ({ ...x, starting: true }));
    try {
      const data = await client.command({
        type: "world.reset",
        requestId: newId("wact"),
        worldId: w.world?.id ?? null,
        confirm: true,
        ...(residents ? { settings: { ...base, residents } } : {}),
      });
      // 回应到之前推送已经把新的一局送来了：同一局、同一个会话才照用（runSeq 交给 applySnapshot 判断）；
      // 局或会话对不上（中间又恢复 / 重开过）就不接这份旧回应，按现在的重读
      const now = context();
      const sameAsNow = now !== null && data.world !== null && now.worldId === data.world.id && now.session === data.world.generation.session;
      if (stillIn(ctx) || sameAsNow) {
        set((x) => applyWorldState(x, data));
        set((x) => (x.starting ? { ...x, starting: false } : x));
        // 较新的推送可能让整个开局回执被丢弃，而推送不含设置。重读当前状态，不能回填旧回执的设置。
        await load();
      } else {
        set((x) => ({ ...x, starting: false }));
        await load();
      }
    } catch (err) {
      set((x) => ({ ...x, starting: false }));
      fail(err);
    } finally {
      resetting = false;
    }
  }

  return {
    /** 点导航「世界」 */
    open() {
      store.set((s) => ({ ...s, view: "world" }));
      void load();
    },
    load,

    /** 第一次开始：住进来的是这几位 */
    start: (residents: string[]) => reset(residents),
    /** 重置 = 开新的一局（界面先问过了才调） */
    reset: () => reset(),

    async pause() {
      const ctx = context();
      if (!ctx) return;
      try {
        const next = await client.command({ type: "world.pause", worldId: ctx.worldId });
        if (sameSession(ctx)) set((w) => applySnapshot(w, next));
      } catch (err) {
        fail(err);
      }
    },
    async resume() {
      const ctx = context();
      if (!ctx) return;
      try {
        const next = await client.command({ type: "world.resume", worldId: ctx.worldId });
        if (sameSession(ctx)) set((w) => applySnapshot(w, next));
      } catch (err) {
        fail(err);
      }
    },

    /**
     * 走到某间屋：隔着别的屋就一间一间走，中途被拒绝就停下。
     * 整条路线绑在出发时的那一局那一代上：中途重置、暂停、恢复了，剩下的几步不走（旧的意图不带进新的世界）。
     */
    async goTo(placeId: string) {
      const world = get().world;
      const ctx = context();
      if (!world || !ctx) return;
      const path = pathTo(world.places, world.player.placeId, placeId);
      if (!path) return void set((w) => ({ ...w, rejected: { reason: "not_adjacent", nonce: ++nonce } }));
      for (const to of path) if (!(await act({ type: "move", to }, ctx))) return;
    },
    invite: (agent: string, activity: WorldActivityKind) => act({ type: "invite", to: { kind: "resident", agent }, activity }),
    /** 答复她对你的邀请。晚点 = 一小时后 */
    answer(commitmentId: string, answer: "accept" | "later" | "decline") {
      const world = get().world;
      const dueAt = answer === "later" && world ? worldNow(world, Date.now()) + 60 : null;
      return act({ type: "answer", commitmentId, answer, dueAt });
    },
    cancel: (commitmentId: string) => act({ type: "cancel", commitmentId }),
    join: (activityId: string) => act({ type: "join", activityId }),
    stop: () => act({ type: "stop" }),

    /** 找她说话（要先在同一间屋）。对话界面在 C-56 */
    talk: (agent: string) => sceneCommand((base) => client.command({ type: "world.talk", ...base, agent })),
    sceneChoose: (sceneId: string, optionId: string) => sceneCommand((base) => client.command({ type: "world.scene.choose", ...base, sceneId, optionId })),
    sceneSay: (sceneId: string, text: string) => sceneCommand((base) => client.command({ type: "world.scene.say", ...base, sceneId, text })),
    sceneClose: (sceneId: string) => sceneCommand((base) => client.command({ type: "world.scene.close", ...base, sceneId })),

    select: (agent: string | null) => set((w) => (w.selected === agent ? w : { ...w, selected: agent })),
    dismissRejected: () => set((w) => (w.rejected ? { ...w, rejected: null } : w)),
    loadMoreEvents: () => loadEvents(false),

    /** 「她知道什么」 */
    async showKnowledge(agent: string) {
      const world = get().world;
      if (!world) return;
      set((w) => ({ ...w, knowledge: { agent, data: null } }));
      try {
        const data = await client.query({ type: "world.residentView", worldId: world.id, agent });
        set((w) => (w.knowledge?.agent === agent && w.world?.id === world.id ? { ...w, knowledge: { agent, data } } : w));
      } catch (err) {
        set((w) => (w.knowledge?.agent === agent ? { ...w, knowledge: null } : w));
        fail(err);
      }
    },
    closeKnowledge: () => set((w) => (w.knowledge ? { ...w, knowledge: null } : w)),

    /** 打开某一天的回顾；不给就是昨天。那天还没结束时后端返回 null，界面显示「还没有」 */
    async showReview(day?: number) {
      const world = get().world;
      if (!world) return;
      const target = Math.max(1, day ?? dayOf(worldNow(world, Date.now())) - 1);
      set((w) => ({ ...w, reviewDay: target }));
      if (get().reviews[target]) return;
      try {
        const review = await client.query({ type: "world.review", worldId: world.id, day: target });
        if (review) set((w) => (w.world?.id === world.id ? { ...w, reviews: { ...w.reviews, [target]: review } } : w));
      } catch (err) {
        fail(err);
      }
    },
    closeReview: () => set((w) => (w.reviewDay === null ? w : { ...w, reviewDay: null })),

    /** 以前的对话。more = 接着读更早的 */
    async showScenes(more = false) {
      const world = get().world;
      const cur = get().pastScenes;
      if (!world || cur?.loading || (more && (!cur || cur.nextBefore === null))) return;
      set((w) => ({ ...w, pastScenes: { items: more ? (w.pastScenes?.items ?? []) : [], nextBefore: null, loading: true } }));
      try {
        const page = await client.query({ type: "world.scenes", worldId: world.id, limit: 10, ...(more && cur?.nextBefore ? { before: cur.nextBefore } : {}) });
        set((w) => (w.pastScenes && w.world?.id === world.id ? { ...w, pastScenes: { items: [...w.pastScenes.items, ...page.items], nextBefore: page.nextBefore, loading: false } } : w));
      } catch (err) {
        set((w) => (w.pastScenes ? { ...w, pastScenes: { ...w.pastScenes, loading: false } } : w));
        fail(err);
      }
    },
    closeScenes: () => set((w) => (w.pastScenes ? { ...w, pastScenes: null } : w)),

    /** 事件推来以后：时间线对不上就重读一次 */
    onEvent(e: ControlEvent) {
      if (!e.type.startsWith("world.")) return;
      const s = store.get();
      if (s.view === "world" && s.world.world && s.world.eventsStale) void loadEvents(true);
    },
  };
}
