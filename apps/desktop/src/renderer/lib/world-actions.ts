import type { ControlEvent, WorldActionResult, WorldActivityKind, WorldPlayerAction, WorldSceneResult } from "@room/schemas";
import type { RoomClient } from "./client";
import { newId } from "./ids";
import type { AppState } from "./state";
import type { Store } from "./store";
import { applySnapshot, applyWorldState, dayOf, mergeEventsPage, pathTo, worldNow, type WorldUiState } from "./world";

/**
 * 世界（C-54）的操作。和别处一样：组件只调这里，失败写进全局提示，不向上抛。
 * 被规则拒绝（accepted=false）不是失败，是正常结果：原因放在 world.rejected，由世界页自己显示。
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

  async function load() {
    try {
      const data = await client.query({ type: "world.get" });
      set((w) => applyWorldState(w, data));
      await loadEvents(true);
    } catch (err) {
      set((w) => ({ ...w, loaded: true }));
      fail(err);
    }
  }

  /** 你的一个动作。返回规则接没接受；世界没开、暂停着等情况由后端按原因拒绝 */
  async function act(action: WorldPlayerAction): Promise<boolean> {
    const world = get().world;
    if (!world) return false;
    try {
      const result = await client.command({ type: "world.act", worldId: world.id, generation: world.generation, actionId: newId("wact"), action });
      return noteResult(result);
    } catch (err) {
      fail(err);
      return false;
    }
  }

  async function sceneCommand(run: (base: { worldId: string; generation: { session: string; runSeq: number }; actionId: string }) => Promise<WorldSceneResult>) {
    const world = get().world;
    if (!world) return false;
    try {
      const out = await run({ worldId: world.id, generation: world.generation, actionId: newId("wact") });
      const scene = out.scene;
      if (scene) set((w) => (w.world?.id !== world.id ? w : { ...w, scene: scene.state === "closed" ? (w.scene?.id === scene.id ? null : w.scene) : scene }));
      return noteResult(out.result);
    } catch (err) {
      fail(err);
      return false;
    }
  }

  async function reset(residents?: string[]) {
    if (resetting) return;
    const w = get();
    if (!w.settings) return;
    resetting = true;
    set((x) => ({ ...x, starting: true }));
    try {
      const data = await client.command({
        type: "world.reset",
        requestId: newId("wact"),
        worldId: w.world?.id ?? null,
        confirm: true,
        ...(residents ? { settings: { ...w.settings, residents } } : {}),
      });
      set((x) => applyWorldState(x, data));
      await loadEvents(true);
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
      const world = get().world;
      if (!world) return;
      try {
        const next = await client.command({ type: "world.pause", worldId: world.id });
        set((w) => applySnapshot(w, next));
      } catch (err) {
        fail(err);
      }
    },
    async resume() {
      const world = get().world;
      if (!world) return;
      try {
        const next = await client.command({ type: "world.resume", worldId: world.id });
        set((w) => applySnapshot(w, next));
      } catch (err) {
        fail(err);
      }
    },

    /** 走到某间屋：隔着别的屋就一间一间走，中途被拒绝就停下 */
    async goTo(placeId: string) {
      const world = get().world;
      if (!world) return;
      const path = pathTo(world.places, world.player.placeId, placeId);
      if (!path) return void set((w) => ({ ...w, rejected: { reason: "not_adjacent", nonce: ++nonce } }));
      for (const to of path) if (!(await act({ type: "move", to }))) return;
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
