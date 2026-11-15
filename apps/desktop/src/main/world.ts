import { applyWorldAction, advanceWorld, chooseWorldRoutine, createWorld, updateWorldViews } from "@room/core";
import { WorldStore, acquireWorldLock, ulid, type SqliteDatabase, type WriteQueue } from "@room/db";
import {
  WORLD_DAILY_COGNITION_DEFAULT, WORLD_DAY_REAL_MINUTES_DEFAULT,
  type CommandRequest, type ControlErrorCode, type ControlEvent,
  type WorldAction, type WorldActionResult, type WorldActor, type WorldDayReview, type WorldEvent,
  type WorldGeneration, type WorldScene, type WorldSceneResult, type WorldSettings, type WorldSnapshot, type WorldState,
} from "@room/schemas";

const player: WorldActor = { kind: "player" };
const generation = (): WorldGeneration => ({ session: `wses_${ulid()}`, runSeq: 0 });
const equalGeneration = (a: WorldGeneration, b: WorldGeneration): boolean => a.session === b.session && a.runSeq === b.runSeq;
const denied = (reason: Extract<WorldActionResult, { accepted: false }>["reason"]): WorldActionResult => ({ accepted: false, reason });
const activityNames = { cook: "做饭", eat: "吃饭", read: "看书", rest: "休息", sleep: "睡觉", tidy: "整理房间", set_table: "摆餐桌" };

interface WorldDeps {
  db: SqliteDatabase;
  queue: WriteQueue;
  emit: (event: ControlEvent) => void;
  knownAgents: () => string[];
  agentName?: (agent: string) => string;
  dbPath?: string;
  now?: () => string;
}

export class WorldError extends Error {
  constructor(readonly code: ControlErrorCode, message: string, options?: ErrorOptions) { super(message, options); this.name = "WorldError"; }
}

/** 世界唯一写入口。事务里重新读取、裁决、保存；COMMIT 后才发布，网络和计时器不进入事务。 */
export class WorldService {
  readonly #store: WorldStore;
  readonly #deps: WorldDeps;
  #generation = generation();
  #release: (() => void) | null = null;
  #started = false;
  #startError: WorldError | null = null;
  #stopped = false;
  #barriers = 0;
  #suspended = false;
  #fraction = 0;
  readonly #observedHistory = new Map<string, WorldEvent[]>();

  constructor(deps: WorldDeps) {
    this.#deps = deps;
    this.#store = new WorldStore(deps.db);
  }

  #now(): string { return this.#deps.now?.() ?? new Date().toISOString(); }
  #load() { return this.#store.load(this.#generation); }
  #settings(): WorldSettings {
    const saved = this.#store.settings();
    if (saved) return saved;
    const residents = this.#deps.knownAgents().slice(0, 2);
    if (!residents.length) throw new WorldError("invalid_state", "请先配置至少一位秘书，再开始小屋生活");
    return {
      residents,
      dayRealMinutes: WORLD_DAY_REAL_MINUTES_DEFAULT,
      dailyCognitionLimit: WORLD_DAILY_COGNITION_DEFAULT,
    };
  }
  #world(id?: string): WorldSnapshot {
    const world = this.#load()?.world;
    if (!world || (id !== undefined && world.id !== id)) throw new WorldError("not_found", "这一局已经不在当前资料里");
    return world;
  }
  #stamp(world: WorldSnapshot): WorldSnapshot {
    return { ...world, asOf: this.#now(), minutesPerRealSecond: world.run.state === "running" ? 24 / this.#settings().dayRealMinutes : 0 };
  }
  #requireStarted(): void {
    if (this.#startError) throw this.#startError;
    if (!this.#started) throw new WorldError("invalid_state", "世界服务尚未启动");
  }
  #available(): boolean { this.#requireStarted(); return !this.#stopped && this.#barriers === 0 && !this.#suspended; }
  async #transaction<T>(work: (out: ControlEvent[]) => T): Promise<T> {
    return this.#deps.queue.run(() => {
      if (this.#startError) throw this.#startError;
      if (this.#stopped) throw new WorldError("invalid_state", "世界已经停止");
      const out: ControlEvent[] = [];
      const savedGeneration = this.#generation;
      const savedFraction = this.#fraction;
      this.#deps.db.exec("BEGIN IMMEDIATE");
      let result: T;
      try {
        result = work(out);
        this.#deps.db.exec("COMMIT");
      } catch (error) {
        if (this.#deps.db.inTransaction) this.#deps.db.exec("ROLLBACK");
        this.#generation = savedGeneration;
        this.#fraction = savedFraction;
        this.#observedHistory.clear();
        throw error;
      }
      const finalSnapshots = new Map<string, number>();
      out.forEach((event, index) => { if (event.type === "world.updated") finalSnapshots.set(event.world.id, index); });
      if (!this.#stopped) out.forEach((event, index) => {
        if (event.type !== "world.updated" || finalSnapshots.get(event.world.id) === index) this.#deps.emit(event);
      });
      return result;
    });
  }

  async start(): Promise<void> {
    if (this.#startError) throw this.#startError;
    if (this.#started || this.#stopped) throw new WorldError("invalid_state", "世界服务不能重复启动");
    try {
      if (this.#deps.dbPath) this.#release = acquireWorldLock(this.#deps.dbPath);
      await this.#transaction((out) => {
        const saved = this.#load();
        if (!saved) return;
        let world = saved.world;
        world = this.#closeScene(world, out);
        if (world.run.state === "paused" && world.run.by === "maintenance") world = { ...world, run: { state: "running" } };
        this.#commit(world, this.#stamp(world), [], out);
      });
      this.#started = true;
    } catch (error) {
      this.#startError = new WorldError("invalid_state", "世界启动失败，暂时不可用；请检查启动日志后重启应用", { cause: error });
      this.#release?.();
      this.#release = null;
      throw this.#startError;
    }
  }

  get(): WorldState {
    this.#requireStarted();
    const world = this.#load()?.world ?? null;
    return { world, scene: world?.sceneId ? this.#store.getScene(world.id, world.sceneId) : null, settings: this.#settings(), budgets: [] };
  }
  residentView(worldId: string, agent: string) {
    this.#requireStarted();
    const view = this.#store.view(worldId, agent);
    if (!view) throw new WorldError("not_found", "没有这位居民在这一局里的观察");
    return view;
  }
  events(worldId: string, before: number | undefined, limit: number) { this.#requireStarted(); return this.#store.events(worldId, before, limit); }
  scenes(worldId: string, before: string | undefined, limit: number) { this.#requireStarted(); return this.#store.scenes(worldId, before, limit); }
  review(worldId: string, day: number) { this.#requireStarted(); return this.#store.review(worldId, day); }

  async reset(request: CommandRequest<"world.reset">): Promise<WorldState> {
    if (!this.#available()) throw new WorldError("invalid_state", "世界正在维护，请稍后再开始");
    const next = generation();
    const result = await this.#transaction((out) => {
      const previous = this.#store.getReceipt(request.requestId);
      if (previous) {
        if (previous.request !== JSON.stringify(request)) throw new WorldError("invalid_state", "同一个重置编号不能用于不同请求");
        return { value: previous.result as WorldState, fresh: false };
      }
      const old = this.#load()?.world;
      if ((old?.id ?? null) !== request.worldId) throw new WorldError("invalid_state", "当前这一局已经变化，请重新打开世界");
      const settings = request.settings ?? this.#settings();
      if (settings.residents.length === 0 || new Set(settings.residents).size !== settings.residents.length || settings.residents.some((a) => !this.#deps.knownAgents().includes(a))) {
        throw new WorldError("validation_failed", "请选择已配置的秘书入住");
      }
      if (old) this.#closeScene(old, out);
      const world = createWorld({ id: `world_${ulid()}`, generation: next, settings, asOf: this.#now() });
      const opened: WorldEvent = { type: "clock", seq: 1, at: world.now, mark: "day_started", day: Math.floor(world.now / 1440) + 1 };
      this.#store.create({ ...world, lastSeq: 0 }, settings);
      const observations = updateWorldViews([], world, world, [opened]);
      this.#store.append(world.id, [opened], observations.observations, observations.views);
      this.#store.save(world);
      const value: WorldState = { world, scene: null, settings, budgets: [] };
      this.#store.putReceipt(request.requestId, JSON.stringify(request), value);
      this.#generation = next;
      this.#fraction = 0;
      this.#observedHistory.clear();
      out.push({ type: "world.event", worldId: world.id, event: opened }, { type: "world.updated", world });
      return { value, fresh: true };
    });
    return result.value;
  }

  /** 每个用户动作先读回执，再检查代次；排队期间发生的状态变化在事务内重新裁决。 */
  async act(request: CommandRequest<"world.act">): Promise<WorldActionResult> {
    this.#requireStarted();
    if (this.#stopped) return denied("world_paused");
    const admitted = this.#available();
    return this.#transaction((out) => {
      const receipt = this.#store.getReceipt(request.actionId);
      if (receipt) return receipt.request === JSON.stringify(request) ? receipt.result as WorldActionResult : denied("duplicate_action");
      const world = this.#load()?.world;
      const rejection = this.#check(world, request.worldId, request.generation, admitted);
      const result = rejection ?? this.#action(world!, player, request.action, out);
      this.#store.putReceipt(request.actionId, JSON.stringify(request), result);
      return result;
    });
  }
  #check(world: WorldSnapshot | undefined, id: string, gen: WorldGeneration, admitted: boolean, allowUserPause = false): WorldActionResult | null {
    if (!world || world.id !== id || !equalGeneration(world.generation, gen)) return denied("stale_generation");
    const userPaused = allowUserPause && world.run.state === "paused" && world.run.by === "user";
    if (!admitted || this.#stopped || (world.run.state !== "running" && !userPaused)) return denied("world_paused");
    return null;
  }
  #action(world: WorldSnapshot, actor: WorldActor, action: WorldAction, out: ControlEvent[], sceneId: string | null = null, optionId: string | null = null): WorldActionResult {
    const transition = applyWorldAction(world, actor, action, { activityId: `wavt_${ulid()}`, commitmentId: `wcom_${ulid()}` });
    if (transition.result.accepted) {
      const events = transition.events.map((event): WorldEvent => event.type === "action" ? { ...event, sceneId, optionId } : event);
      this.#commit(world, transition.world, events, out);
      this.#triggerScene(transition.world.id, events, out);
    }
    return transition.result;
  }
  #commit(before: WorldSnapshot, after: WorldSnapshot, events: WorldEvent[], out: ControlEvent[]): WorldSnapshot {
    const world = this.#stamp(after);
    // Views contain observations, not the live clock or gauges. An empty event
    // batch cannot change them and must not rewrite every resident's history.
    const previous = events.length ? before.residents.map((r) => this.#store.view(before.id, r.agent)).filter((v) => v !== null) : [];
    const observed = events.length ? updateWorldViews(previous, before, world, events) : { observations: [], views: [] };
    const observers = new Set(observed.observations.map((observation) => observation.observer));
    this.#store.save(world);
    if (events.length) this.#store.append(world.id, events, observed.observations, observed.views.filter((view) => observers.has(view.agent)));
    for (const observation of observed.observations) {
      const cache = this.#observedHistory.get(`${world.id}:${observation.observer}`);
      if (cache) cache.push(events.find((event) => event.seq === observation.seq)!);
    }
    for (const event of events) out.push({ type: "world.event", worldId: world.id, event });
    out.push({ type: "world.updated", world });
    for (const event of events) if (event.type === "clock" && event.mark === "day_ended") this.#makeReview(world, event.day, event.seq, out);
    return world;
  }

  async advance(elapsedMs: number): Promise<void> {
    if (!this.#available() || !Number.isFinite(elapsedMs) || elapsedMs <= 0 || elapsedMs > 5000) return;
    const ticket = this.#generation;
    await this.#transaction((out) => {
      const saved = this.#load();
      if (!saved || !this.#available() || !equalGeneration(ticket, this.#generation) || saved.world.run.state !== "running") return;
      const total = this.#fraction + elapsedMs * (24 / saved.settings.dayRealMinutes) / 1000;
      const minutes = Math.floor(total);
      let world = saved.world;
      for (let step = 0; step < minutes; step++) {
        const transition = advanceWorld(world, world.now + 1);
        world = this.#commit(world, transition.world, transition.events, out);
        this.#triggerScene(world.id, transition.events, out);
        for (const resident of world.residents) {
          world = this.#world();
          const key = `${world.id}:${resident.agent}`;
          let ownEvents = this.#observedHistory.get(key);
          if (!ownEvents) { ownEvents = this.#store.observedEvents(world.id, resident.agent); this.#observedHistory.set(key, ownEvents); }
          const action = chooseWorldRoutine(world, resident.agent, ownEvents, this.#store.view(world.id, resident.agent) ?? undefined);
          if (action) {
            const result = this.#action(world, { kind: "resident", agent: resident.agent }, action, out);
            if (!result.accepted && result.reason === "item_busy" && action.type === "start") this.#contention(world, resident.agent, action.itemId ?? (action.activity === "read" ? "book" : "pot"), out);
          }
        }
        world = this.#world();
      }
      this.#fraction = total - minutes;
    });
  }

  async pause(worldId: string): Promise<WorldSnapshot> { return this.#setUserRun(worldId, false); }
  async resume(worldId: string): Promise<WorldSnapshot> { return this.#setUserRun(worldId, true); }
  async #setUserRun(worldId: string, running: boolean): Promise<WorldSnapshot> {
    this.#requireStarted();
    if (this.#stopped) throw new WorldError("invalid_state", "世界已经停止");
    const result = await this.#transaction((out) => {
      const world = this.#world(worldId);
      const willRun = running && this.#barriers === 0 && !this.#suspended;
      const changed = willRun && world.run.state === "paused" ? this.#resumeWorld(world, out) :
        this.#commit(world, { ...world, run: willRun ? { state: "running" } : { state: "paused", by: running ? "maintenance" : "user" } }, [], out);
      this.#fraction = 0;
      return changed;
    });
    return result;
  }
  async saveSettings(request: CommandRequest<"world.settings.save">): Promise<WorldSettings> {
    if (!this.#available()) throw new WorldError("invalid_state", "世界正在维护");
    return this.#transaction((out) => {
      const settings = { ...this.#settings(), ...request.settings };
      this.#store.saveSettings(settings);
      const world = this.#load()?.world;
      if (world) this.#commit(world, world, [], out);
      return settings;
    });
  }

  async maintenance<T>(work: () => Promise<T>): Promise<T> {
    this.#requireStarted();
    if (this.#stopped) throw new WorldError("invalid_state", "世界已经停止");
    this.#barriers++;
    try {
      await this.#deps.queue.drain();
      if (this.#stopped) throw new WorldError("invalid_state", "世界已经停止");
      await this.#autoPause();
      if (this.#stopped) throw new WorldError("invalid_state", "世界已经停止");
      return await work();
    } finally {
      this.#barriers--;
      if (!this.#stopped && this.#barriers === 0 && !this.#suspended) await this.#autoResume();
    }
  }
  async #autoPause(): Promise<void> {
    await this.#transaction((out) => {
      const saved = this.#load();
      if (!saved) return;
      const world = saved.world;
      this.#commit(world, { ...world, run: world.run.state === "running" ? { state: "paused", by: "maintenance" } : world.run }, [], out);
      this.#fraction = 0;
    });
  }
  async #autoResume(): Promise<void> {
    await this.#transaction((out) => {
      const world = this.#load()?.world;
      if (!world || world.run.state !== "paused" || world.run.by !== "maintenance") return;
      this.#resumeWorld(world, out);
      this.#fraction = 0;
    });
  }
  #resumeWorld(world: WorldSnapshot, out: ControlEvent[]): WorldSnapshot {
    const next = { ...this.#generation, runSeq: this.#generation.runSeq + 1 };
    let scene: WorldScene | null = null;
    if (world.sceneId) {
      const previous = this.#store.getScene(world.id, world.sceneId);
      if (!previous || previous.state === "closed") throw new WorldError("internal", "当前场景记录缺失或已结束");
      scene = { ...previous, generation: next, state: "open", lines: previous.state === "waiting" ? [
        ...previous.lines, { speaker: null, source: "rule", expression: "neutral", seq: null, text: "刚才的回应没有接上，可以重新说一句。" },
      ] : previous.lines };
      this.#store.saveScene(world.id, scene);
    }
    const changed = this.#commit(world, { ...world, generation: next, run: { state: "running" } }, [], out);
    this.#generation = next;
    // The renderer must see the new snapshot generation before the scene.
    if (scene) out.push({ type: "world.scene.updated", scene });
    return changed;
  }
  async suspend(): Promise<void> {
    this.#requireStarted();
    this.#suspended = true;
    await this.#deps.queue.drain();
    if (!this.#stopped) await this.#autoPause();
  }
  async resumeFromSuspend(): Promise<void> {
    this.#requireStarted();
    this.#suspended = false;
    if (!this.#stopped && this.#barriers === 0) await this.#autoResume();
  }
  async beginSwitch<T>(work: () => Promise<T>): Promise<T> {
    return this.maintenance(async () => {
      const result = await work();
      await this.stop();
      return result;
    });
  }
  async stop(): Promise<void> {
    this.#stopped = true;
    await this.#deps.queue.drain();
    this.#release?.();
    this.#release = null;
  }

  async talk(request: CommandRequest<"world.talk">): Promise<WorldSceneResult> {
    return this.#sceneCommand(request, (world, out) => {
      const resident = world.residents.find((r) => r.agent === request.agent);
      if (!resident) return { result: denied("unknown_target"), scene: null };
      if (resident.placeId !== world.player.placeId) return { result: denied("not_same_place"), scene: null };
      if (world.sceneId) return { result: denied("not_allowed"), scene: this.#store.getScene(world.id, world.sceneId) };
      const activity = world.activities.find((a) => a.id === resident.activityId);
      const text = activity ? `她正在${activityNames[activity.kind]}，还需要 ${Math.max(0, activity.endsAt - world.now)} 分钟。` : "她暂时没有正在做的事。";
      return this.#openScene(world, { kind: "player", agent: resident.agent }, resident.placeId, text + " 她现在按作息生活，暂时不能回应文字。", out);
    });
  }
  async choose(request: CommandRequest<"world.scene.choose">): Promise<WorldSceneResult> {
    return this.#sceneCommand(request, (world, out) => {
      const scene = this.#store.getScene(world.id, request.sceneId);
      if (!scene || scene.state === "closed" || world.sceneId !== scene.id) return { result: denied("scene_closed"), scene };
      const option = scene.options.find((o) => o.id === request.optionId);
      if (!option) return { result: denied("option_expired"), scene };
      const result = option.act ? this.#action(world, option.act.actor, option.act.action, out, scene.id, option.id) : null;
      world = this.#world();
      const event: WorldEvent = { type: "scene", seq: world.lastSeq + 1, at: world.now, placeId: scene.placeId, sceneId: scene.id, step: "chose", optionId: option.id, result };
      const updated: WorldScene = {
        ...scene, options: [],
        past: [...scene.past, ...scene.options.map((o) => ({ option: o, outcome: o.id === option.id ? "chosen" as const : "expired" as const, seq: o.id === option.id ? event.seq : null }))],
        lines: [...scene.lines, { speaker: null, source: "rule", expression: "neutral", seq: null, text: result === null ? "你决定先看看。" : result.accepted ? "请求已记下，后续行动以小屋里的实际进展为准。" : `情况已变化，这个选项未执行：${reasonText(result.reason)}` }],
      };
      this.#store.saveScene(world.id, updated);
      this.#commit(world, { ...world, lastSeq: event.seq }, [event], out);
      out.push({ type: "world.scene.updated", scene: updated });
      return { result: { accepted: true, seq: event.seq }, scene: updated };
    });
  }
  async say(request: CommandRequest<"world.scene.say">): Promise<WorldSceneResult> {
    return this.#sceneCommand(request, (world) => ({ result: denied("not_allowed"), scene: this.#store.getScene(world.id, request.sceneId) }));
  }
  async close(request: CommandRequest<"world.scene.close">): Promise<WorldSceneResult> {
    return this.#sceneCommand(request, (world, out) => {
      const scene = this.#store.getScene(world.id, request.sceneId);
      if (!scene || scene.state === "closed" || world.sceneId !== scene.id) return { result: denied("scene_closed"), scene };
      const closed = this.#closeScene(world, out);
      return { result: { accepted: true, seq: closed.lastSeq }, scene: this.#store.getScene(world.id, scene.id) };
    });
  }
  async #sceneCommand(
    request: CommandRequest<"world.talk" | "world.scene.choose" | "world.scene.say" | "world.scene.close">,
    work: (world: WorldSnapshot, out: ControlEvent[]) => WorldSceneResult,
  ): Promise<WorldSceneResult> {
    this.#requireStarted();
    if (this.#stopped) return { result: denied("world_paused"), scene: null };
    const admitted = this.#available();
    return this.#transaction((out) => {
      const receipt = this.#store.getReceipt(request.actionId);
      if (receipt) return receipt.request === JSON.stringify(request) ? receipt.result as WorldSceneResult : { result: denied("duplicate_action"), scene: null };
      const world = this.#load()?.world;
      const rejection = this.#check(world, request.worldId, request.generation, admitted, request.type === "world.scene.close");
      const result = rejection ? { result: rejection, scene: null } : work(world!, out);
      this.#store.putReceipt(request.actionId, JSON.stringify(request), result);
      return result;
    });
  }
  #openScene(world: WorldSnapshot, origin: WorldScene["origin"], placeId: string, text: string, out: ControlEvent[]): WorldSceneResult {
    const samePlace = world.residents.filter((r) => r.placeId === placeId).map((r) => r.agent);
    const residents = (origin.kind === "player" ? [origin.agent, ...samePlace.filter((agent) => agent !== origin.agent)] : samePlace).slice(0, 4);
    if (!residents.length) return { result: denied("unknown_target"), scene: null };
    const options: WorldScene["options"] = [];
    if (origin.kind === "player") {
      options.push({ id: "opt_read", label: "邀她一起看书", act: { actor: player, action: { type: "invite", to: { kind: "resident", agent: origin.agent }, activity: "read" } } });
      options.push({ id: "opt_table", label: "邀她一起摆餐桌", act: { actor: player, action: { type: "invite", to: { kind: "resident", agent: origin.agent }, activity: "set_table" } } });
      const active = world.activities.find((a) => a.participants.some((p) => p.kind === "resident" && p.agent === origin.agent));
      if (active) options.push({ id: "opt_join", label: "和她一起做", act: { actor: player, action: { type: "join", activityId: active.id } } });
    }
    options.push({ id: "opt_watch", label: "先看看", act: null });
    const scene: WorldScene = { id: `wscn_${ulid()}`, generation: world.generation, origin, placeId, residents, lines: [{ speaker: null, text, source: "rule", expression: "neutral", seq: null }], options, past: [], canType: false, state: "open", openedAt: world.now, createdAt: this.#now() };
    const event: WorldEvent = { type: "scene", seq: world.lastSeq + 1, at: world.now, placeId, sceneId: scene.id, step: "opened", optionId: null, result: null };
    this.#store.saveScene(world.id, scene);
    this.#commit(world, { ...world, sceneId: scene.id, lastSeq: event.seq }, [event], out);
    out.push({ type: "world.scene.updated", scene });
    return { result: { accepted: true, seq: event.seq }, scene };
  }
  #closeScene(world: WorldSnapshot, out: ControlEvent[]): WorldSnapshot {
    if (!world.sceneId) return world;
    const scene = this.#store.getScene(world.id, world.sceneId);
    if (!scene) throw new WorldError("internal", "当前场景记录缺失");
    const closed: WorldScene = { ...scene, state: "closed", canType: false, options: [], past: [...scene.past, ...scene.options.map((option) => ({ option, outcome: "expired" as const, seq: null }))] };
    const event: WorldEvent = { type: "scene", seq: world.lastSeq + 1, at: world.now, placeId: scene.placeId, sceneId: scene.id, step: "closed", optionId: null, result: null };
    this.#store.saveScene(world.id, closed);
    const saved = this.#commit(world, { ...world, sceneId: null, lastSeq: event.seq }, [event], out);
    out.push({ type: "world.scene.updated", scene: closed });
    return saved;
  }
  #triggerScene(worldId: string, events: WorldEvent[], out: ControlEvent[]): void {
    const world = this.#world(worldId);
    if (world.sceneId) return;
    const cooked = events.find((e): e is Extract<WorldEvent, { type: "activity_ended" }> => e.type === "activity_ended" && e.activity.kind === "cook");
    if (cooked) this.#openScene(world, { kind: "event", cause: "cook_result", seq: cooked.seq }, cooked.placeId, cooked.activity.state === "completed" ? `饭做好了，添了 ${cooked.produced.reduce((n, p) => n + p.count, 0)} 份。` : "这次做饭中断了，剩余食材和锅已按实际进度结算。", out);
    if (cooked) return;
    const joined = events.find((e): e is Extract<WorldEvent, { type: "action" }> => e.type === "action" && e.action.type === "join");
    if (joined) {
      const current = world.activities.find((a) => a.id === joined.activityId);
      let previouslyTogether = false;
      if (current) for (const event of this.#history(worldId, joined.seq)) {
        if (event.type === "activity_ended" && event.activity.state === "completed" && current.participants.every((p) => event.activity.participants.some((other) => JSON.stringify(p) === JSON.stringify(other)))) {
          previouslyTogether = true;
          break;
        }
      }
      if (current && !previouslyTogether) {
        this.#openScene(world, { kind: "event", cause: "first_together", seq: joined.seq }, current.placeId, `这次有人一起${activityNames[current.kind]}了。等事情做完，小屋会留下这段共同经历。`, out);
        return;
      }
    }
    const resting = events.find((e): e is Extract<WorldEvent, { type: "action" }> => e.type === "action" && e.actor.kind === "resident" && e.action.type === "start");
    if (resting?.actor.kind === "resident") {
      const resident = world.residents.find((r) => resting.actor.kind === "resident" && r.agent === resting.actor.agent)!;
      if ((resident.energy < 15 || resident.satiety < 15 || resident.mood < 15) && !this.#sceneToday(world, "low_state", resident.agent)) {
        this.#openScene(world, { kind: "event", cause: "low_state", seq: resting.seq }, resident.placeId, resident.energy < 15 ? "她很累了，想先好好休息。" : resident.satiety < 15 ? "她有些饿，正在想办法照顾自己。" : "她的心情有些低落，想缓一缓。", out);
        return;
      }
    }
    const ended = events.find((e) => e.type === "clock" && e.mark === "day_ended");
    if (ended && ended.type === "clock") this.#openScene(world, { kind: "event", cause: "day_review", seq: ended.seq }, world.residents[0]!.placeId, `第 ${ended.day} 天结束了。今天的生活回顾已保存，可以在回顾中查看实际发生的事。`, out);
  }
  #contention(world: WorldSnapshot, agent: string, itemId: string, out: ControlEvent[]): void {
    world = this.#world(world.id);
    if (world.sceneId || this.#sceneToday(world, "item_contention", agent)) return;
    const item = world.items.find((i) => i.id === itemId);
    if (item?.kind !== "unique" || !item.usedBy) return;
    const activity = world.activities.find((a) => a.id === item.usedBy);
    const resident = world.residents.find((r) => r.agent === agent);
    if (!activity || activity.placeId !== resident?.placeId) return;
    for (const event of this.#history(world.id)) {
      if (event.type !== "action" || event.activityId !== activity.id || event.action.type !== "start") continue;
      this.#openScene(world, { kind: "event", cause: "item_contention", seq: event.seq }, activity.placeId, `${item.label}正有人在用，后来的人需要等一等，或先做别的事。`, out);
      break;
    }
  }
  #sceneToday(world: WorldSnapshot, cause: Extract<WorldScene["origin"], { kind: "event" }>["cause"], agent: string): boolean {
    for (const event of this.#history(world.id)) {
      if (event.at < Math.floor(world.now / 1440) * 1440) break;
      if (event.type !== "scene" || event.step !== "opened") continue;
      const scene = this.#store.getScene(world.id, event.sceneId);
      if (scene?.origin.kind === "event" && scene.origin.cause === cause && scene.residents.includes(agent)) return true;
    }
    return false;
  }
  *#history(worldId: string, before?: number): Generator<WorldEvent> {
    let cursor = before;
    for (;;) {
      const page = this.#store.events(worldId, cursor, 100);
      yield* page.items;
      if (page.nextBefore === null) break;
      cursor = page.nextBefore;
    }
  }
  #makeReview(world: WorldSnapshot, day: number, endSeq: number, out: ControlEvent[]): void {
    const items: WorldDayReview["items"] = [];
    for (const event of this.#history(world.id, endSeq)) {
      if ((event.type === "clock" && event.mark === "day_started" && event.day === day) || items.length >= 40) break;
      if (event.type !== "activity_ended") continue;
      const names = event.activity.participants.map((p) => p.kind === "player" ? "你" : this.#deps.agentName?.(p.agent) ?? p.agent);
      const participants = names.length > 3 ? `${names.slice(0, 3).join("、")}等 ${names.length} 人` : names.join("、");
      items.push({ seqs: [event.seq], source: "rule", text: `${participants}的${activityNames[event.activity.kind]}${event.activity.state === "completed" ? "完成了" : "结束了"}。` });
    }
    const review: WorldDayReview = { day, items: items.reverse() };
    this.#store.saveReview(world.id, review);
    out.push({ type: "world.review.created", worldId: world.id, review });
  }
}

function reasonText(reason: Extract<WorldActionResult, { accepted: false }>["reason"]): string {
  return ({ stale_generation: "这次操作已经过期", world_paused: "世界已暂停", unknown_target: "目标已不存在", not_adjacent: "要先走到相邻房间", not_same_place: "不在同一间屋", actor_busy: "正在做别的事", item_busy: "物品正在被使用", item_not_here: "物品不在这里", out_of_stock: "数量不够", not_allowed: "现在做不了这件事", scene_closed: "这段对话已结束", option_expired: "选项已失效", duplicate_action: "这个操作编号已经用过" })[reason];
}
