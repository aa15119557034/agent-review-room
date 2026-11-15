import type {
  WorldAction, WorldActionResult, WorldActivity, WorldActivityKind,
  WorldActor, WorldCommitment, WorldEvent, WorldGeneration, WorldItem,
  WorldObservation, WorldRejectReason, WorldResidentView, WorldSettings, WorldSnapshot,
} from "@room/schemas";
import { WORLD_MINUTES_PER_DAY } from "@room/schemas";

/** Rules are fixed for a saved world. IDs, wall time, persistence and delivery belong to the caller. */
export const WORLD_RULES_VERSION = "1";
const DURATION: Record<WorldActivityKind, number> = {
  cook: 30, eat: 15, read: 30, rest: 30, sleep: 120, tidy: 20, set_table: 10,
};
const TERMINAL = new Set<WorldCommitment["state"]>(["done", "cancelled", "declined", "expired"]);
type ResidentName = WorldResidentView["agent"];
const sameActor = (a: WorldActor, b: WorldActor): boolean =>
  a.kind === b.kind && (a.kind === "player" || (b.kind === "resident" && a.agent === b.agent));
const residentActor = (agent: ResidentName): WorldActor => ({ kind: "resident", agent });
const clamp = (n: number): number => Math.max(0, Math.min(100, n));

export function createWorld(input: {
  id: WorldSnapshot["id"]; generation: WorldGeneration; settings: WorldSettings; asOf: string;
}): WorldSnapshot {
  if (new Set(input.settings.residents).size !== input.settings.residents.length || input.settings.residents.length === 0) {
    throw new Error("A world needs distinct residents");
  }
  const rooms = input.settings.residents.map((agent, index) => ({
    id: `room_${index + 1}`, label: `${agent.slice(0, 37)}的房间`,
    neighbors: [index < 4 ? "living_room" : "kitchen"], owner: agent,
  }));
  return {
    id: input.id, generation: { ...input.generation }, rulesVersion: WORLD_RULES_VERSION,
    run: { state: "running" }, now: 480, asOf: input.asOf,
    minutesPerRealSecond: WORLD_MINUTES_PER_DAY / (input.settings.dayRealMinutes * 60), lastSeq: 1,
    places: [
      { id: "living_room", label: "客厅", neighbors: ["kitchen", ...rooms.slice(0, 4).map((room) => room.id)], owner: null },
      { id: "kitchen", label: "厨房", neighbors: ["living_room", ...rooms.slice(4).map((room) => room.id)], owner: null },
      ...rooms,
    ],
    residents: input.settings.residents.map((agent) => ({
      agent, placeId: "living_room", energy: 85, satiety: 65, mood: 65,
      activityId: null, cognition: { mode: "routine", reason: "offline" },
    })),
    player: { placeId: "living_room", activityId: null },
    items: [
      { kind: "unique", id: "pot", label: "锅", at: { kind: "place", placeId: "kitchen" }, usedBy: null },
      { kind: "unique", id: "book", label: "书", at: { kind: "place", placeId: "living_room" }, usedBy: null },
      { kind: "unique", id: "seat", label: "座位", at: { kind: "place", placeId: "living_room" }, usedBy: null },
      { kind: "stock", id: "ingredients", label: "食材", placeId: "kitchen", count: 16 },
      { kind: "stock", id: "meals", label: "饭", placeId: "kitchen", count: 0 },
    ],
    activities: [], commitments: [], sceneId: null,
  };
}

function assertRules(world: WorldSnapshot): void {
  if (world.rulesVersion !== WORLD_RULES_VERSION) throw new Error(`Unsupported world rules: ${world.rulesVersion}`);
}

function actorState(world: WorldSnapshot, actor: WorldActor) {
  return actor.kind === "player" ? world.player : world.residents.find((r) => r.agent === actor.agent);
}

function itemPlace(world: WorldSnapshot, item: WorldItem): string | undefined {
  return item.kind === "stock" ? item.placeId : item.at.kind === "place" ? item.at.placeId : actorState(world, item.at.by)?.placeId;
}

function stock(world: WorldSnapshot, id: string): Extract<WorldItem, { kind: "stock" }> {
  const item = world.items.find((i) => i.id === id);
  if (item?.kind !== "stock") throw new Error(`Missing stock in world: ${id}`);
  return item;
}

function reservation(activity: WorldActivity): { itemId: string; count: number }[] {
  if (activity.kind === "cook") return [{ itemId: "ingredients", count: 1 }];
  if (activity.kind === "eat") return [{ itemId: "meals", count: activity.participants.length }];
  return [];
}

function pruneCommitments(world: WorldSnapshot): void {
  world.commitments = world.commitments.filter((c) => !TERMINAL.has(c.state));
}

/** Mutates only the private working copy. All consumed stock is settled once, at the terminal event. */
function finishActivity(
  world: WorldSnapshot, activity: WorldActivity, completed: boolean,
  reason: WorldActivity["endReason"], events: WorldEvent[],
): void {
  const consumed = completed ? reservation(activity) : [];
  const produced = completed && activity.kind === "cook" ? [{ itemId: "meals", count: 4 }] : [];
  for (const held of reservation(activity)) {
    stock(world, held.itemId).count += held.count - (consumed.find((c) => c.itemId === held.itemId)?.count ?? 0);
  }
  for (const made of produced) stock(world, made.itemId).count += made.count;
  for (const participant of activity.participants) {
    const state = actorState(world, participant);
    if (state?.activityId === activity.id) state.activityId = null;
    if (participant.kind === "resident" && completed) {
      const resident = world.residents.find((r) => r.agent === participant.agent)!;
      if (activity.kind === "eat") resident.satiety = clamp(resident.satiety + 45);
      if (["read", "tidy", "set_table", "cook"].includes(activity.kind)) resident.mood = clamp(resident.mood + 4);
    }
  }
  for (const item of world.items) if (item.kind === "unique" && item.usedBy === activity.id) item.usedBy = null;
  for (const commitment of world.commitments) {
    if (commitment.activityId === activity.id) commitment.state = completed ? "done" : "cancelled";
  }
  world.activities = world.activities.filter((a) => a.id !== activity.id);
  pruneCommitments(world);
  events.push({
    type: "activity_ended", seq: ++world.lastSeq, at: world.now, placeId: activity.placeId,
    activity: { ...structuredClone(activity), state: completed ? "completed" : "cancelled", endReason: reason },
    produced, consumed,
  });
}

function requiredItem(kind: WorldActivityKind, selected: string | null): string | null {
  if (kind === "cook") return selected === null || selected === "pot" ? "pot" : selected;
  if (kind === "read") return selected ?? "book";
  return selected;
}

function startProblem(world: WorldSnapshot, actor: WorldActor, kind: WorldActivityKind, selected: string | null): WorldRejectReason | null {
  const state = actorState(world, actor)!;
  if (state.activityId !== null) return "actor_busy";
  if ((kind === "cook" || kind === "eat") && state.placeId !== "kitchen") return "not_allowed";
  if (kind === "set_table" && state.placeId !== "living_room") return "not_allowed";
  const itemId = requiredItem(kind, selected);
  if (itemId !== null) {
    if (!((kind === "cook" && itemId === "pot") || (kind === "read" && itemId === "book") || (kind === "rest" && itemId === "seat"))) return "not_allowed";
    const item = world.items.find((i) => i.id === itemId);
    if (item?.kind !== "unique") return "unknown_target";
    if (item.usedBy !== null) return "item_busy";
    if (itemPlace(world, item) !== state.placeId || (item.at.kind === "held" && !sameActor(item.at.by, actor))) return "item_not_here";
  }
  if (kind === "cook" && stock(world, "ingredients").count < 1) return "out_of_stock";
  if (kind === "eat" && stock(world, "meals").count < 1) return "out_of_stock";
  if (kind === "cook" && stock(world, "meals").count > 995) return "not_allowed";
  if (world.activities.length >= 20) return "not_allowed";
  return null;
}

/** Receipt/generation checks happen in main before calling this pure rules entry point. */
export function applyWorldAction(
  world: WorldSnapshot, actor: WorldActor, action: WorldAction,
  ids: { activityId?: WorldActivity["id"] | null; commitmentId?: WorldCommitment["id"] | null },
): { world: WorldSnapshot; events: WorldEvent[]; result: WorldActionResult } {
  assertRules(world);
  const rejected = (reason: WorldRejectReason) => ({ world, events: [] as WorldEvent[], result: { accepted: false as const, reason } });
  if (world.run.state !== "running") return rejected("world_paused");
  const originalActor = actorState(world, actor);
  if (!originalActor) return rejected("unknown_target");
  const w = structuredClone(world);
  const state = actorState(w, actor)!;
  let activityId: WorldActivity["id"] | null = null;
  let commitmentId: WorldCommitment["id"] | null = null;
  let ending: WorldActivity | undefined;
  const placeId = state.placeId;
  const busy = state.activityId !== null;

  switch (action.type) {
    case "move": {
      if (busy) return rejected("actor_busy");
      if (!w.places.some((p) => p.id === action.to)) return rejected("unknown_target");
      if (!w.places.find((p) => p.id === placeId)!.neighbors.includes(action.to)) return rejected("not_adjacent");
      state.placeId = action.to;
      break;
    }
    case "take": {
      if (busy) return rejected("actor_busy");
      const item = w.items.find((i) => i.id === action.itemId);
      if (!item) return rejected("unknown_target");
      if (item.kind !== "unique") return rejected("not_allowed");
      if (item.usedBy !== null) return rejected("item_busy");
      if (item.at.kind !== "place" || item.at.placeId !== placeId) return rejected("item_not_here");
      item.at = { kind: "held", by: structuredClone(actor) };
      break;
    }
    case "put": {
      if (busy) return rejected("actor_busy");
      const item = w.items.find((i) => i.id === action.itemId);
      if (!item) return rejected("unknown_target");
      if (item.kind !== "unique") return rejected("not_allowed");
      if (item.usedBy !== null) return rejected("item_busy");
      if (item.at.kind !== "held" || !sameActor(item.at.by, actor)) return rejected("item_not_here");
      item.at = { kind: "place", placeId };
      break;
    }
    case "start": {
      const problem = startProblem(w, actor, action.activity, action.itemId);
      if (problem) return rejected(problem);
      if (!ids.activityId) throw new Error("Starting an activity requires the caller's activityId");
      if (w.activities.some((a) => a.id === ids.activityId)) return rejected("not_allowed");
      activityId = ids.activityId;
      const itemId = requiredItem(action.activity, action.itemId);
      const activity: WorldActivity = {
        id: activityId, kind: action.activity, participants: [structuredClone(actor)], placeId,
        itemIds: itemId === null ? [] : [itemId], startedAt: w.now,
        endsAt: w.now + DURATION[action.activity], state: "running", endReason: null,
      };
      for (const held of reservation(activity)) stock(w, held.itemId).count -= held.count;
      if (itemId !== null) (w.items.find((i) => i.id === itemId) as Extract<WorldItem, { kind: "unique" }>).usedBy = activityId;
      state.activityId = activityId;
      w.activities.push(activity);
      const agreement = w.commitments.find((c) => sameActor(c.by, actor) && c.activity === action.activity &&
        c.state === "pending" && c.activityId === null && (c.dueAt === null || c.dueAt <= w.now));
      if (agreement) { agreement.activityId = activityId; commitmentId = agreement.id; }
      break;
    }
    case "join": {
      if (busy) return rejected("actor_busy");
      const activity = w.activities.find((a) => a.id === action.activityId);
      if (!activity || activity.state !== "running" || activity.endsAt <= w.now) return rejected("not_allowed");
      if (activity.placeId !== placeId) return rejected("not_same_place");
      if (["rest", "sleep"].includes(activity.kind) || activity.participants.length >= 8) return rejected("not_allowed");
      if (activity.kind === "eat") {
        if (stock(w, "meals").count < 1) return rejected("out_of_stock");
        stock(w, "meals").count -= 1;
      }
      activityId = activity.id;
      activity.participants.push(structuredClone(actor));
      state.activityId = activity.id;
      break;
    }
    case "stop": {
      const activity = w.activities.find((a) => a.id === state.activityId);
      if (!activity || !activity.participants.some((p) => sameActor(p, actor))) return rejected("not_allowed");
      activityId = activity.id;
      if (activity.participants.length === 1) ending = activity;
      else {
        activity.participants = activity.participants.filter((p) => !sameActor(p, actor));
        state.activityId = null;
        if (activity.kind === "eat") stock(w, "meals").count += 1;
        for (const c of w.commitments) if (c.activityId === activity.id && sameActor(c.by, actor)) c.state = "cancelled";
        pruneCommitments(w);
      }
      break;
    }
    case "invite": {
      const other = actorState(w, action.to);
      if (!other) return rejected("unknown_target");
      if (sameActor(actor, action.to)) return rejected("not_allowed");
      if (other.placeId !== placeId) return rejected("not_same_place");
      if (w.commitments.length >= 40 || w.commitments.some((c) => sameActor(c.by, action.to) && sameActor(c.to, actor) && c.activity === action.activity)) return rejected("not_allowed");
      if (!ids.commitmentId) throw new Error("Inviting requires the caller's commitmentId");
      if (w.commitments.some((c) => c.id === ids.commitmentId)) return rejected("not_allowed");
      commitmentId = ids.commitmentId;
      w.commitments.push({ id: commitmentId, by: structuredClone(action.to), to: structuredClone(actor),
        activity: action.activity, dueAt: null, state: "asked", activityId: null, createdAt: w.now });
      break;
    }
    case "answer": {
      const agreement = w.commitments.find((c) => c.id === action.commitmentId);
      if (!agreement || agreement.state !== "asked" || !sameActor(agreement.by, actor)) return rejected("not_allowed");
      if (actorState(w, agreement.to)?.placeId !== placeId) return rejected("not_same_place");
      if (action.answer === "later" && (action.dueAt === null || action.dueAt <= w.now)) return rejected("not_allowed");
      if (action.answer !== "later" && action.dueAt !== null) return rejected("not_allowed");
      commitmentId = agreement.id;
      agreement.state = action.answer === "accept" ? "pending" : action.answer === "later" ? "deferred" : "declined";
      agreement.dueAt = action.answer === "later" ? action.dueAt : action.answer === "accept" ? w.now : null;
      pruneCommitments(w);
      break;
    }
    case "cancel": {
      const agreement = w.commitments.find((c) => c.id === action.commitmentId);
      if (!agreement || TERMINAL.has(agreement.state) || (!sameActor(agreement.by, actor) && !sameActor(agreement.to, actor))) return rejected("not_allowed");
      commitmentId = agreement.id;
      activityId = agreement.activityId;
      ending = w.activities.find((a) => a.id === activityId);
      agreement.state = "cancelled";
      pruneCommitments(w);
      break;
    }
  }
  const first: WorldEvent = { type: "action", seq: ++w.lastSeq, at: w.now, placeId, actor: structuredClone(actor),
    action: structuredClone(action), activityId, commitmentId, sceneId: null, optionId: null };
  const events = [first];
  if (ending) finishActivity(w, ending, false, actor.kind === "player" ? "cancelled_by_player" : "cancelled_by_actor", events);
  return { world: w, events, result: { accepted: true, seq: first.seq } };
}

/** Absolute world minutes. Stepping in pieces has the same result as one advance to the same minute. */
export function advanceWorld(world: WorldSnapshot, to: number): { world: WorldSnapshot; events: WorldEvent[] } {
  assertRules(world);
  if (!Number.isSafeInteger(to) || to < world.now) throw new RangeError("World time must advance to a safe whole minute");
  if (world.run.state !== "running" || to === world.now) return { world, events: [] };
  const w = structuredClone(world);
  const events: WorldEvent[] = [];
  while (w.now < to) {
    w.now += 1;
    for (const r of w.residents) {
      const activity = w.activities.find((a) => a.id === r.activityId);
      if (activity?.kind === "sleep") r.energy = clamp(r.energy + 2);
      else if (activity?.kind === "rest") r.energy = clamp(r.energy + 1);
      else if (w.now % 20 === 0) r.energy = clamp(r.energy - 1);
      if (w.now % 8 === 0) r.satiety = clamp(r.satiety - 1);
      if (w.now % 15 === 0 && (r.energy < 15 || r.satiety < 15)) r.mood = clamp(r.mood - 1);
      else if (w.now % 60 === 0 && r.energy >= 30 && r.satiety >= 30) r.mood = clamp(r.mood + Math.sign(60 - r.mood));
    }
    for (const activity of [...w.activities].sort((a, b) => a.endsAt - b.endsAt || a.id.localeCompare(b.id))) {
      if (activity.endsAt <= w.now) finishActivity(w, activity, true, "done", events);
    }
    for (const agreement of w.commitments) {
      if (agreement.state === "asked" && w.now >= agreement.createdAt + 120) agreement.state = "expired";
      if (agreement.state === "deferred" && agreement.dueAt !== null && w.now >= agreement.dueAt) agreement.state = "pending";
      if (agreement.state === "pending" && agreement.activityId === null && w.now > (agreement.dueAt ?? agreement.createdAt) + 60) agreement.state = "expired";
    }
    pruneCommitments(w);
    if (w.now % WORLD_MINUTES_PER_DAY === 0) {
      const day = w.now / WORLD_MINUTES_PER_DAY;
      events.push({ type: "clock", seq: ++w.lastSeq, at: w.now, mark: "day_ended", day });
      events.push({ type: "clock", seq: ++w.lastSeq, at: w.now, mark: "day_started", day: day + 1 });
    }
  }
  return { world: w, events };
}

function walkToward(world: WorldSnapshot, from: string, target: string): WorldAction | null {
  if (from === target) return null;
  const queue: string[][] = [[from]];
  const seen = new Set([from]);
  while (queue.length) {
    const route = queue.shift()!;
    for (const next of world.places.find((p) => p.id === route.at(-1))?.neighbors ?? []) {
      if (seen.has(next)) continue;
      if (next === target) return { type: "move", to: route.length === 1 ? next : route[1]! };
      seen.add(next);
      queue.push([...route, next]);
    }
  }
  return null;
}

function knownReadingPlace(actor: WorldActor, currentPlace: string, view: WorldResidentView | undefined, ownEvents: readonly WorldEvent[]): string {
  const known = view?.knownItems.find((item) => item.itemId === "book");
  if (known?.at?.kind === "place") return known.at.placeId;
  if (known?.at?.kind === "held") {
    if (sameActor(known.at.by, actor)) return currentPlace;
    // A holder's current position is world truth, not this resident's knowledge.
    // Recover only the room where the observation supporting this belief occurred.
    const observed = ownEvents.find((event) => event.seq === known.seq) ?? view?.seen.find((event) => event.seq === known.seq);
    if (observed?.type === "action" && observed.action.type === "move") return observed.action.to;
    if (observed && observed.type !== "clock" && observed.type !== "said") return observed.placeId;
  }
  return "living_room";
}

function routineActivity(world: WorldSnapshot, actor: WorldActor, kind: WorldActivityKind, readingPlace: string): WorldAction | null {
  const place = actorState(world, actor)!.placeId;
  const target = kind === "cook" || kind === "eat" ? "kitchen" : kind === "sleep" && actor.kind === "resident" ? world.places.find((room) => room.owner === actor.agent)?.id :
    kind === "read" ? readingPlace : kind === "set_table" ? "living_room" : place;
  if (target === undefined) throw new Error("Resident has no bedroom");
  if (place !== target) return walkToward(world, place, target);
  const action: WorldAction = { type: "start", activity: kind, itemId: null };
  const problem = startProblem(world, actor, kind, null);
  // A visible occupied book still prompts a real proposal. The authority rejects it,
  // allowing the caller to present contention from committed events in this room.
  if (kind === "read" && problem === "item_busy") {
    const book = world.items.find((item) => item.id === "book");
    if (book && itemPlace(world, book) === place) return action;
  }
  return problem === null ? action : null;
}

/** Chooses one proposal, never mutates or commits. It does not chase items in unseen rooms. */
export function chooseWorldRoutine(
  world: WorldSnapshot, agent: ResidentName, ownEvents: readonly WorldEvent[] = [], view?: WorldResidentView,
): WorldAction | null {
  assertRules(world);
  if (world.run.state !== "running") return null;
  const r = world.residents.find((resident) => resident.agent === agent);
  if (!r) return null;
  const actor = residentActor(agent);
  const readingPlace = knownReadingPlace(actor, r.placeId, view?.worldId === world.id && view.agent === agent ? view : undefined, ownEvents);
  const propose = (kind: WorldActivityKind) => routineActivity(world, actor, kind, readingPlace);
  const asked = world.commitments.find((c) => c.state === "asked" && sameActor(c.by, actor) && actorState(world, c.to)?.placeId === r.placeId);
  if (asked) {
    const discretionary = !["eat", "rest", "sleep"].includes(asked.activity);
    if (discretionary && (r.energy < 15 || r.satiety < 15)) {
      return { type: "answer", commitmentId: asked.id, answer: "decline", dueAt: null };
    }
    const current = world.activities.find((a) => a.id === r.activityId);
    if (current) return { type: "answer", commitmentId: asked.id, answer: "later", dueAt: current.endsAt + 1 };
    if (discretionary && (r.energy < 40 || r.satiety < 35)) {
      // A familiar housemate gets a concrete later appointment when needs compete;
      // an acquaintance gets an honest refusal. Urgent needs always win above.
      const defer = asked.to.kind === "player" || worldFamiliarity(ownEvents, agent, asked.to.agent) >= 4;
      return { type: "answer", commitmentId: asked.id, answer: defer ? "later" : "decline", dueAt: defer ? world.now + 45 : null };
    }
    return { type: "answer", commitmentId: asked.id, answer: "accept", dueAt: null };
  }
  if (r.activityId !== null) return null;
  for (const agreement of world.commitments) {
    if (agreement.state !== "pending") continue;
    if (sameActor(agreement.by, actor) && agreement.activityId === null) {
      const proposed = propose(agreement.activity);
      if (proposed) return proposed;
      return null; // A due promise waits for its resource, rather than starting unrelated work.
    }
    if (sameActor(agreement.to, actor) && agreement.activityId === null) return null;
    if (sameActor(agreement.to, actor) && agreement.activityId !== null) {
      const activity = world.activities.find((a) => a.id === agreement.activityId);
      if (activity && !activity.participants.some((p) => sameActor(p, actor))) {
        if (r.placeId !== activity.placeId) return walkToward(world, r.placeId, activity.placeId);
        if (!["sleep", "rest"].includes(activity.kind) && (activity.kind !== "eat" || stock(world, "meals").count > 0)) return { type: "join", activityId: activity.id };
      }
    }
  }
  if (r.satiety < 50) {
    if (r.placeId !== "kitchen") return walkToward(world, r.placeId, "kitchen");
    const eating = propose("eat");
    if (eating) return eating;
    const cooking = propose("cook");
    if (cooking) return cooking;
    return propose("rest");
  }
  const hour = Math.floor((world.now % WORLD_MINUTES_PER_DAY) / 60);
  if (r.energy < 30 || hour >= 22 || hour < 7) return propose("sleep");
  const offset = world.residents.findIndex((resident) => resident.agent === agent);
  const dayStart = world.now - world.now % WORLD_MINUTES_PER_DAY;
  // The caller supplies this resident's observed history (at least this day's
  // invites). A short evening window and ordered pairs prevent mutual loops.
  if (world.now - dayStart >= 1080 && world.now - dayStart < 1110) {
    const together = world.residents.slice(offset + 1).find((other) => {
      const otherActor = residentActor(other.agent);
      const pair = (a: WorldActor, b: WorldActor) =>
        sameActor(a, actor) && sameActor(b, otherActor) || sameActor(a, otherActor) && sameActor(b, actor);
      return other.placeId === r.placeId &&
        !world.commitments.some((c) => pair(c.by, c.to)) &&
        !ownEvents.some((e) => e.at >= dayStart && e.type === "action" && e.action.type === "invite" && pair(e.actor, e.action.to));
    });
    if (together) {
      const activity = r.placeId === "living_room" ? "read" : r.placeId === "kitchen" && stock(world, "meals").count >= 2 ? "eat" : null;
      if (activity !== null) return { type: "invite", to: residentActor(together.agent), activity };
    }
  }
  const kind = (["read", "tidy", "rest"] as const)[(Math.floor(world.now / 30) + offset) % 3]!;
  return propose(kind) ?? propose("tidy");
}

function refreshVisibleItems(view: WorldResidentView, world: WorldSnapshot, room: string, at: number, seq: number): void {
  const visible = world.items.filter((item) => itemPlace(world, item) === room);
  for (const known of view.knownItems) {
    const wasHere = known.at?.kind === "place" ? known.at.placeId === room :
      known.at?.kind === "held" && actorState(world, known.at.by)?.placeId === room;
    if (wasHere && !visible.some((item) => item.id === known.itemId)) {
      known.at = null; known.count = null; known.asOf = at; known.seq = seq;
    }
  }
  for (const item of visible) {
    const known: WorldResidentView["knownItems"][number] = {
      itemId: item.id, at: item.kind === "unique" ? structuredClone(item.at) : { kind: "place", placeId: item.placeId },
      count: item.kind === "stock" ? item.count : null, asOf: at, seq,
    };
    const index = view.knownItems.findIndex((entry) => entry.itemId === item.id);
    if (index < 0) view.knownItems.push(known); else view.knownItems[index] = known;
  }
}

/** Reconstructs the visible physical changes of each event, without reading future state into earlier observations. */
function applyVisibleEvent(state: WorldSnapshot, event: WorldEvent, definitions: Map<string, WorldActivity>): void {
  state.now = event.at;
  if (event.type === "action") {
    const actor = actorState(state, event.actor);
    if (!actor) throw new Error("Event references an unknown actor");
    const action = event.action;
    if (action.type === "move") actor.placeId = action.to;
    if (action.type === "take" || action.type === "put") {
      const item = state.items.find((i) => i.id === action.itemId);
      if (item?.kind === "unique") item.at = action.type === "take" ? { kind: "held", by: structuredClone(event.actor) } : { kind: "place", placeId: event.placeId };
    }
    if (action.type === "start" && event.activityId !== null) {
      const definition = definitions.get(event.activityId);
      if (!definition) throw new Error("Activity event lacks its resulting activity");
      const activity: WorldActivity = { ...structuredClone(definition), participants: [structuredClone(event.actor)], state: "running", endReason: null };
      state.activities.push(activity);
      actor.activityId = activity.id;
      for (const held of reservation(activity)) stock(state, held.itemId).count -= held.count;
      for (const item of state.items) if (item.kind === "unique" && activity.itemIds.includes(item.id)) item.usedBy = activity.id;
    }
    if (action.type === "join") {
      const activity = state.activities.find((a) => a.id === action.activityId);
      if (activity && !activity.participants.some((a) => sameActor(a, event.actor))) {
        activity.participants.push(structuredClone(event.actor)); actor.activityId = activity.id;
        if (activity.kind === "eat") stock(state, "meals").count -= 1;
      }
    }
    if (action.type === "stop") {
      const activity = state.activities.find((a) => a.id === event.activityId);
      if (activity && activity.participants.length > 1) {
        activity.participants = activity.participants.filter((a) => !sameActor(a, event.actor)); actor.activityId = null;
        if (activity.kind === "eat") stock(state, "meals").count += 1;
      }
    }
  }
  if (event.type === "activity_ended") {
    const activity = state.activities.find((a) => a.id === event.activity.id);
    if (!activity) throw new Error("Terminal event references an inactive activity");
    for (const held of reservation(activity)) stock(state, held.itemId).count += held.count - (event.consumed.find((c) => c.itemId === held.itemId)?.count ?? 0);
    for (const made of event.produced) stock(state, made.itemId).count += made.count;
    for (const participant of activity.participants) {
      const actor = actorState(state, participant);
      if (actor?.activityId === activity.id) actor.activityId = null;
    }
    for (const item of state.items) if (item.kind === "unique" && item.usedBy === activity.id) item.usedBy = null;
    state.activities = state.activities.filter((a) => a.id !== activity.id);
  }
}

export function updateWorldViews(
  views: WorldResidentView[], before: WorldSnapshot, after: WorldSnapshot, events: WorldEvent[],
): { views: WorldResidentView[]; observations: WorldObservation[] } {
  if (before.id !== after.id) throw new Error("Views cannot cross world identities");
  const next = after.residents.map((resident): WorldResidentView => {
    const old = views.find((view) => view.worldId === after.id && view.agent === resident.agent);
    return old ? structuredClone(old) : { agent: resident.agent, worldId: after.id, knownItems: [], seen: [], heard: [] };
  });
  const observations: WorldObservation[] = [];
  const state = structuredClone(before);
  const definitions = new Map([...before.activities, ...after.activities].map((activity) => [activity.id, activity]));
  for (const event of events) if (event.type === "activity_ended") definitions.set(event.activity.id, event.activity);
  for (const event of events) {
    const oldPositions = new Map(state.residents.map((r) => [r.agent, r.placeId]));
    applyVisibleEvent(state, event, definitions);
    for (const view of next) {
      const room = state.residents.find((r) => r.agent === view.agent)!.placeId;
      const initial = event.type === "clock" && event.seq === 1;
      const visible = event.type === "clock" || oldPositions.get(view.agent) === event.placeId || room === event.placeId ||
        (event.type === "action" && event.action.type === "move" && room === event.action.to);
      if (!visible) continue;
      if (event.type === "said") {
        if (view.heard.some((heard) => heard.seq === event.seq)) continue;
        view.heard.unshift({ seq: event.seq, at: event.at, speaker: structuredClone(event.speaker), text: event.text });
        view.heard = view.heard.slice(0, 100);
        observations.push({ observer: view.agent, seq: event.seq, at: event.at, mode: "heard" });
        continue;
      }
      if (view.seen.some((seen) => seen.seq === event.seq)) continue;
      view.seen.unshift(structuredClone(event)); view.seen = view.seen.slice(0, 100);
      observations.push({ observer: view.agent, seq: event.seq, at: event.at, mode: "saw" });
      if (initial || event.type !== "clock") refreshVisibleItems(view, state, room, event.at, event.seq);
    }
  }
  return { views: next, observations };
}

/** Directed familiarity is derived from shared completed activities, never from model-assigned scores. */
export function worldFamiliarity(events: readonly WorldEvent[], from: ResidentName, to: ResidentName): number {
  if (from === to) return 0;
  const seen = new Set<number>();
  const spokenDays = new Set<number>();
  let value = 0;
  for (const event of events) {
    if (seen.has(event.seq)) continue;
    seen.add(event.seq);
    if (event.type === "activity_ended" && event.activity.state === "completed" &&
      event.activity.participants.some((p) => p.kind === "resident" && p.agent === from) &&
      event.activity.participants.some((p) => p.kind === "resident" && p.agent === to) && from !== to) value += 2;
    // The caller passes only this resident's observations. Hearing the other
    // person builds contact in this direction, once per world day, not per line.
    if (event.type === "said" && event.speaker.kind === "resident" && event.speaker.agent === to) {
      const day = Math.floor(event.at / WORLD_MINUTES_PER_DAY);
      if (!spokenDays.has(day)) { spokenDays.add(day); value += 1; }
    }
  }
  return clamp(value);
}
