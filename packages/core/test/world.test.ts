import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  WorldEvent, WorldResidentView, WorldSettings, WorldSnapshot,
  type WorldAction, type WorldActor,
} from "@room/schemas";
import { advanceWorld, applyWorldAction, chooseWorldRoutine, createWorld, updateWorldViews, worldFamiliarity } from "../src/world";

const A: WorldActor = { kind: "resident", agent: "claude" };
const B: WorldActor = { kind: "resident", agent: "codex" };
const U: WorldActor = { kind: "player" };
const suffix = (n: number) => n.toString().padStart(26, "0");
const ids = (n: number) => ({ activityId: `wavt_${suffix(n)}`, commitmentId: `wcom_${suffix(n)}` });

function initial(): WorldSnapshot {
  return createWorld({
    id: `world_${suffix(1)}`, generation: { session: `wses_${suffix(1)}`, runSeq: 0 },
    settings: { residents: ["claude", "codex"], dailyCognitionLimit: 0, dayRealMinutes: 24 },
    asOf: "2026-11-16T00:00:00.000Z",
  });
}

function fixture(start = initial()) {
  let world = start;
  const first: WorldEvent = { type: "clock", seq: 1, at: world.now, mark: "day_started", day: 1 };
  let views = updateWorldViews([], world, world, [first]).views;
  const events: WorldEvent[] = [first];
  let counter = 1;
  const apply = (actor: WorldActor, action: WorldAction) => {
    const original = structuredClone(world);
    const result = applyWorldAction(world, actor, action, ids(counter++));
    assert.deepEqual(world, original, "the input state was not mutated");
    const observations = updateWorldViews(views, world, result.world, result.events);
    world = result.world; views = observations.views; events.push(...result.events);
    WorldSnapshot.parse(world);
    result.events.forEach((event) => WorldEvent.parse(event));
    views.forEach((view) => WorldResidentView.parse(view));
    return result;
  };
  const act = (actor: WorldActor, action: WorldAction) => {
    const result = apply(actor, action);
    assert.equal(result.result.accepted, true, JSON.stringify(result.result));
    return result;
  };
  const advance = (to: number) => {
    const original = structuredClone(world);
    const result = advanceWorld(world, to);
    assert.deepEqual(world, original);
    views = updateWorldViews(views, world, result.world, result.events).views;
    world = result.world; events.push(...result.events);
    WorldSnapshot.parse(world);
    result.events.forEach((event) => WorldEvent.parse(event));
    return result;
  };
  return { get world() { return world; }, get views() { return views; }, events, apply, act, advance };
}

function count(world: WorldSnapshot, itemId: string): number {
  const item = world.items.find((i) => i.id === itemId);
  assert.equal(item?.kind, "stock");
  return (item as Extract<WorldSnapshot["items"][number], { kind: "stock" }>).count;
}

function holder(world: WorldSnapshot, itemId: string) {
  const item = world.items.find((i) => i.id === itemId);
  assert.equal(item?.kind, "unique");
  return item as Extract<WorldSnapshot["items"][number], { kind: "unique" }>;
}

describe("world authority and resource settlement", () => {
  it("creates an explicit world with an initial sequence and only observes the starting room", () => {
    const h = fixture();
    assert.equal(h.world.now, 480);
    assert.equal(h.world.rulesVersion, "2");
    assert.equal(h.world.lastSeq, 1);
    assert.equal(h.world.player.placeId, "living_room");
    assert.deepEqual(h.views[0]!.knownItems.map((i) => i.itemId), ["book", "seat"]);
    assert.equal(h.views[0]!.knownItems.some((i) => i.itemId === "ingredients"), false);
    const repeat = updateWorldViews(h.views, h.world, h.world, h.events);
    assert.deepEqual(repeat.views, h.views);
    assert.deepEqual(repeat.observations, []);
  });

  it("fits eight valid resident names and routes each resident to the bedroom owned by them", () => {
    const residents = ["a".repeat(64), "assistant-two", "three", "four", "five", "six", "seven", "eight"];
    const settings = WorldSettings.parse({ residents, dayRealMinutes: 24, dailyCognitionLimit: 0 });
    const base = initial();
    let world = createWorld({ id: base.id, generation: base.generation, asOf: base.asOf, settings });
    WorldSnapshot.parse(world);
    assert.equal(world.places.length, 10);
    assert.deepEqual(world.places.filter((room) => room.owner !== null).map((room) => room.id),
      ["room_1", "room_2", "room_3", "room_4", "room_5", "room_6", "room_7", "room_8"]);
    for (const place of world.places) {
      assert.ok(place.neighbors.length <= 5);
      assert.ok(place.label.length <= 40);
      for (const neighbor of place.neighbors) assert.ok(world.places.find((room) => room.id === neighbor)!.neighbors.includes(place.id));
    }
    world = { ...world, now: 1320 };
    let serial = 1;
    for (const agent of residents) {
      const ownRoom = world.places.find((room) => room.owner === agent)!;
      for (let step = 0; step < 3; step += 1) {
        const choice = chooseWorldRoutine(world, agent);
        assert.ok(choice);
        const result = applyWorldAction(world, { kind: "resident", agent }, choice, ids(serial++));
        assert.equal(result.result.accepted, true);
        world = result.world;
        WorldSnapshot.parse(world);
        if (choice.type === "start") {
          assert.equal(choice.activity, "sleep");
          break;
        }
      }
      const resident = world.residents.find((entry) => entry.agent === agent)!;
      assert.equal(resident.placeId, ownRoom.id);
      assert.equal(world.activities.find((activity) => activity.id === resident.activityId)!.kind, "sleep");
    }
  });

  it("serializes contention at the rules boundary and never mutates rejected input", () => {
    const h = fixture();
    h.act(A, { type: "take", itemId: "book" });
    const before = h.world;
    const denied = h.apply(B, { type: "take", itemId: "book" });
    assert.deepEqual(denied.result, { accepted: false, reason: "item_not_here" });
    assert.equal(denied.world, before);
    assert.deepEqual(denied.events, []);
    assert.deepEqual(holder(h.world, "book").at, { kind: "held", by: A });
    h.act(A, { type: "put", itemId: "book" });
    h.act(B, { type: "take", itemId: "book" });
    assert.deepEqual(holder(h.world, "book").at, { kind: "held", by: B });
  });

  it("reserves ingredients, cancels without food, refunds once and never resurrects the activity", () => {
    const h = fixture();
    h.act(A, { type: "move", to: "kitchen" });
    const start = h.act(A, { type: "start", activity: "cook", itemId: null });
    const activity = h.world.activities[0]!;
    assert.equal(count(h.world, "ingredients"), 15);
    assert.equal(count(h.world, "meals"), 0);
    assert.equal(holder(h.world, "pot").usedBy, activity.id);
    assert.equal(start.events.some((event) => event.type === "activity_ended"), false);
    h.advance(activity.endsAt - 1);
    const cancellation = h.act(A, { type: "stop" });
    const end = cancellation.events.find((event) => event.type === "activity_ended");
    assert.ok(end?.type === "activity_ended");
    assert.deepEqual(end.consumed, []);
    assert.equal(end.activity.state, "cancelled");
    assert.equal(count(h.world, "ingredients"), 16);
    assert.equal(holder(h.world, "pot").usedBy, null);
    assert.equal(h.apply(A, { type: "stop" }).result.accepted, false);
    h.advance(activity.endsAt + 30);
    assert.equal(count(h.world, "ingredients"), 16);
    assert.equal(count(h.world, "meals"), 0);
    assert.equal(h.events.filter((event) => event.type === "activity_ended").length, 1);
  });

  it("commits one cumulative consumption and one production, then both residents can eat", () => {
    const h = fixture();
    for (const actor of [A, B, U]) h.act(actor, { type: "move", to: "kitchen" });
    h.act(A, { type: "start", activity: "cook", itemId: null });
    const cook = h.world.activities[0]!;
    assert.deepEqual(h.apply(B, { type: "start", activity: "cook", itemId: null }).result, { accepted: false, reason: "item_busy" });
    h.act(U, { type: "join", activityId: cook.id });
    h.advance(cook.endsAt);
    assert.equal(count(h.world, "ingredients"), 15);
    assert.equal(count(h.world, "meals"), 4);
    const terminal = h.events.find((event) => event.type === "activity_ended");
    assert.ok(terminal?.type === "activity_ended");
    assert.deepEqual(terminal.consumed, [{ itemId: "ingredients", count: 1 }]);
    h.advance(cook.endsAt);
    assert.equal(h.events.filter((event) => event.type === "activity_ended").length, 1);
    h.act(A, { type: "start", activity: "eat", itemId: null });
    const meal = h.world.activities[0]!;
    h.act(B, { type: "join", activityId: meal.id });
    assert.equal(count(h.world, "meals"), 2);
    h.advance(meal.endsAt);
    assert.equal(count(h.world, "meals"), 2);
    const ate = h.events.filter((event) => event.type === "activity_ended").at(-1)!;
    assert.ok(ate.type === "activity_ended");
    assert.deepEqual(ate.consumed, [{ itemId: "meals", count: 2 }]);
    assert.ok(h.world.residents.every((r) => r.satiety > 80));
    assert.equal(worldFamiliarity(h.events, "claude", "codex"), 2);
    assert.equal(worldFamiliarity([...h.events, ...h.events], "claude", "codex"), 2);
  });

  it("leaving a shared meal refunds only the departing participant and leaves the other eating", () => {
    const h = fixture();
    h.act(A, { type: "move", to: "kitchen" });
    h.act(B, { type: "move", to: "kitchen" });
    h.act(A, { type: "start", activity: "cook", itemId: null });
    h.advance(h.world.activities[0]!.endsAt);
    h.act(A, { type: "start", activity: "eat", itemId: null });
    const meal = h.world.activities[0]!;
    h.act(B, { type: "join", activityId: meal.id });
    h.act(B, { type: "stop" });
    assert.equal(count(h.world, "meals"), 3);
    assert.deepEqual(h.world.activities[0]!.participants, [A]);
    h.advance(meal.endsAt);
    assert.equal(count(h.world, "meals"), 3);
    assert.equal(h.world.residents.find((r) => r.agent === "codex")!.activityId, null);
  });

  it("refuses impossible movement, remote joins, held items and resource-free cooking claims", () => {
    const h = fixture();
    assert.deepEqual(h.apply(A, { type: "move", to: "missing" }).result, { accepted: false, reason: "unknown_target" });
    assert.deepEqual(h.apply(A, { type: "start", activity: "cook", itemId: null }).result, { accepted: false, reason: "not_allowed" });
    h.act(A, { type: "take", itemId: "book" });
    assert.deepEqual(h.apply(B, { type: "start", activity: "read", itemId: "book" }).result, { accepted: false, reason: "item_not_here" });
    h.act(A, { type: "start", activity: "read", itemId: "book" });
    assert.deepEqual(h.apply(A, { type: "move", to: "kitchen" }).result, { accepted: false, reason: "actor_busy" });
    h.act(B, { type: "move", to: "kitchen" });
    assert.deepEqual(h.apply(B, { type: "join", activityId: h.world.activities[0]!.id }).result, { accepted: false, reason: "not_same_place" });
    assert.deepEqual(h.apply(B, { type: "move", to: "room_2" }).result, { accepted: false, reason: "not_adjacent" });
    assert.deepEqual(h.apply(B, { type: "start", activity: "eat", itemId: null }).result, { accepted: false, reason: "out_of_stock" });
  });
});

describe("world time and invitations", () => {
  it("restocks at midnight with reservations included, preserving chunking and either terminal outcome", () => {
    const start = { ...initial(), now: 1430 };
    for (const item of start.items) if (item.kind === "stock" && item.id === "ingredients") item.count = 2;
    const h = fixture(start);
    h.act(A, { type: "move", to: "kitchen" });
    h.act(A, { type: "start", activity: "cook", itemId: null });
    const saved = structuredClone(h.world);
    const midnight = advanceWorld(saved, 1440);
    assert.equal(count(midnight.world, "ingredients"), 15, "one of the sixteen ingredients remains reserved");
    assert.equal(midnight.world.activities.length, 1);
    const direct = advanceWorld(saved, 1460);
    const split = advanceWorld(midnight.world, 1460);
    assert.deepEqual(split.world, direct.world);
    assert.deepEqual([...midnight.events, ...split.events], direct.events);
    assert.equal(count(direct.world, "ingredients"), 15);
    assert.equal(count(direct.world, "meals"), 4);
    assert.equal(direct.events.filter((event) => event.type === "activity_ended").length, 1);
    assert.deepEqual(advanceWorld(direct.world, 1460).events, []);
    const cancelled = applyWorldAction(midnight.world, A, { type: "stop" }, ids(99));
    assert.equal(cancelled.result.accepted, true);
    assert.equal(count(cancelled.world, "ingredients"), 16, "a midnight reservation refund cannot create a seventeenth ingredient");
    assert.equal(count(cancelled.world, "meals"), 0);
    assert.equal(applyWorldAction(cancelled.world, A, { type: "stop" }, ids(100)).result.accepted, false);
    assert.equal(count(advanceWorld(cancelled.world, 1460).world, "ingredients"), 16);
    const paused: WorldSnapshot = { ...saved, run: { state: "paused", by: "user" }, minutesPerRealSecond: 0 };
    assert.equal(advanceWorld(paused, 1500).world, paused, "paused time cannot replenish supplies");
  });

  it("settles cooking exactly at midnight before replenishing the new day's ingredients", () => {
    const h = fixture({ ...initial(), now: 1410 });
    h.act(A, { type: "move", to: "kitchen" });
    h.act(A, { type: "start", activity: "cook", itemId: null });
    const result = h.advance(1440);
    assert.deepEqual(result.events.map((event) => event.type === "clock" ? event.mark : event.type),
      ["activity_ended", "day_ended", "day_started"]);
    assert.equal(count(h.world, "ingredients"), 16);
    assert.equal(count(h.world, "meals"), 4);
    assert.equal(h.world.activities.length, 0);
  });

  it("keeps version one saves readable and advancing without retroactive restocking", () => {
    const start = { ...initial(), rulesVersion: "1", now: 1430 };
    for (const item of start.items) if (item.kind === "stock" && item.id === "ingredients") item.count = 2;
    const h = fixture(WorldSnapshot.parse(JSON.parse(JSON.stringify(start))));
    h.act(A, { type: "move", to: "kitchen" });
    h.act(A, { type: "start", activity: "cook", itemId: null });
    h.advance(1440);
    assert.equal(h.world.rulesVersion, "1");
    assert.equal(count(h.world, "ingredients"), 1);
    h.act(A, { type: "stop" });
    assert.equal(count(h.world, "ingredients"), 2);
    assert.equal(count(advanceWorld(h.world, 2880).world, "ingredients"), 2);
    assert.throws(() => advanceWorld({ ...h.world, rulesVersion: "999" }, 2880), /Unsupported world rules/);
  });

  it("lets a hungry resident finish the route to bed without bouncing back to an empty kitchen", () => {
    for (const now of [1320, 600]) {
      const start = { ...initial(), now };
      start.residents[0]!.placeId = "kitchen";
      start.residents[0]!.satiety = 10;
      start.residents[0]!.energy = now === 600 ? 20 : 85;
      for (const item of start.items) if (item.kind === "stock") item.count = 0;
      const h = fixture(start);
      for (const to of ["living_room", "room_1"]) {
        const choice = chooseWorldRoutine(h.world, "claude");
        assert.deepEqual(choice, { type: "move", to });
        h.act(A, choice!);
        h.advance(h.world.now + 1);
      }
      const choice = chooseWorldRoutine(h.world, "claude");
      assert.deepEqual(choice, { type: "start", activity: "sleep", itemId: null });
      h.act(A, choice!);
      h.advance(h.world.activities[0]!.endsAt);
      assert.equal(h.world.residents[0]!.placeId, "room_1");
      assert.equal(count(h.world, "ingredients"), now === 1320 ? 16 : 0);
    }
  });

  it("advance is deterministic across chunk boundaries and paused time does not move", () => {
    const h = fixture();
    h.act(A, { type: "move", to: "kitchen" });
    h.act(A, { type: "start", activity: "cook", itemId: null });
    const direct = advanceWorld(h.world, 1500);
    const first = advanceWorld(h.world, 510);
    const second = advanceWorld(first.world, 1500);
    assert.deepEqual(second.world, direct.world);
    assert.deepEqual([...first.events, ...second.events], direct.events);
    assert.deepEqual(direct.events.filter((e) => e.type === "clock").map((e) => e.type === "clock" && [e.mark, e.day]), [["day_ended", 1], ["day_started", 2]]);
    const paused: WorldSnapshot = { ...h.world, run: { state: "paused", by: "user" }, minutesPerRealSecond: 0 };
    assert.equal(advanceWorld(paused, 2000).world, paused);
    assert.deepEqual(applyWorldAction(paused, A, { type: "stop" }, {}).result, { accepted: false, reason: "world_paused" });
    assert.throws(() => advanceWorld(h.world, 479), RangeError);
  });

  it("a busy resident defers, resumes the promise when due, and completes a real shared activity", () => {
    const h = fixture();
    h.act(A, { type: "start", activity: "read", itemId: null });
    const reading = h.world.activities[0]!;
    h.act(U, { type: "invite", to: A, activity: "set_table" });
    const agreement = h.world.commitments[0]!;
    assert.equal(agreement.state, "asked");
    assert.deepEqual(h.apply(B, { type: "answer", commitmentId: agreement.id, answer: "accept", dueAt: null }).result, { accepted: false, reason: "not_allowed" });
    const reply = chooseWorldRoutine(h.world, "claude");
    assert.ok(reply?.type === "answer" && reply.answer === "later");
    h.act(A, reply);
    assert.equal(h.world.commitments[0]!.state, "deferred");
    const restored = JSON.parse(JSON.stringify(h.world)) as WorldSnapshot;
    assert.deepEqual(advanceWorld(restored, reading.endsAt + 1), advanceWorld(h.world, reading.endsAt + 1));
    h.advance(reading.endsAt + 1);
    assert.equal(h.world.commitments[0]!.state, "pending");
    const plan = chooseWorldRoutine(h.world, "claude");
    assert.deepEqual(plan, { type: "start", activity: "set_table", itemId: null });
    h.act(A, plan!);
    const table = h.world.activities[0]!;
    assert.equal(h.world.commitments[0]!.activityId, table.id);
    h.act(U, { type: "join", activityId: table.id });
    h.advance(table.endsAt);
    assert.deepEqual(h.world.commitments, []);
    assert.deepEqual(h.apply(A, { type: "answer", commitmentId: agreement.id, answer: "accept", dueAt: null }).result, { accepted: false, reason: "not_allowed" });
  });

  it("only invitation parties can cancel, and cancellation cannot revive on a later minute", () => {
    const h = fixture();
    h.act(U, { type: "invite", to: A, activity: "read" });
    const id = h.world.commitments[0]!.id;
    h.act(A, { type: "answer", commitmentId: id, answer: "later", dueAt: 600 });
    assert.deepEqual(h.apply(B, { type: "cancel", commitmentId: id }).result, { accepted: false, reason: "not_allowed" });
    h.act(U, { type: "cancel", commitmentId: id });
    h.advance(620);
    assert.deepEqual(h.world.commitments, []);
    assert.deepEqual(h.apply(A, { type: "answer", commitmentId: id, answer: "accept", dueAt: null }).result, { accepted: false, reason: "not_allowed" });
    assert.equal(h.events.filter((event) => event.type === "action" && event.commitmentId === id).length, 3);
  });

  it("expires unanswered invitations and does not invent actions while advancing time", () => {
    const h = fixture();
    h.act(U, { type: "invite", to: A, activity: "read" });
    h.advance(601);
    assert.deepEqual(h.world.commitments, []);
    assert.deepEqual(h.world.activities, []);
    assert.equal(h.events.filter((event) => event.type === "action").length, 1);
  });

  it("runs a complete model-free day with legacy resource accounting", () => {
    const h = fixture({ ...initial(), rulesVersion: "1" });
    for (let minute = 481; minute <= 1600; minute += 1) {
      h.advance(minute);
      for (const agent of ["claude", "codex"] as const) {
        const view = h.views.find((v) => v.agent === agent)!;
        const choice = chooseWorldRoutine(h.world, agent, view.seen, view);
        if (choice) {
          const result = h.apply({ kind: "resident", agent }, choice);
          if (!result.result.accepted) assert.equal(result.result.reason, "item_busy");
        }
      }
    }
    const completed = h.events.filter((e) => e.type === "activity_ended" && e.activity.state === "completed");
    for (const kind of ["cook", "eat", "read", "sleep"]) assert.ok(completed.some((e) => e.type === "activity_ended" && e.activity.kind === kind), kind);
    assert.ok(h.world.residents.every((r) => r.energy > 0 && r.satiety > 0));
    const consumed = h.events.flatMap((e) => e.type === "activity_ended" ? e.consumed : []);
    assert.equal(count(h.world, "ingredients"), 16 - consumed.filter((c) => c.itemId === "ingredients").reduce((sum, c) => sum + c.count, 0) - h.world.activities.filter((a) => a.kind === "cook").length);
    assert.equal(h.events.at(-1)!.seq, h.world.lastSeq);
  });

  for (const rulesVersion of ["1", "2"]) it(`replays version ${rulesVersion} action IDs and time without double settlement or restocking`, () => {
    const savedInitial = { ...initial(), rulesVersion };
    const h = fixture(structuredClone(savedInitial));
    h.act(U, { type: "invite", to: A, activity: "set_table" });
    const appointment = h.world.commitments[0]!.id;
    h.act(A, { type: "answer", commitmentId: appointment, answer: "later", dueAt: 550 });
    h.act(A, { type: "move", to: "kitchen" });
    h.act(A, { type: "start", activity: "cook", itemId: null });
    h.advance(499);
    h.act(A, { type: "stop" });
    h.act(A, { type: "start", activity: "cook", itemId: null });
    h.advance(529);
    h.act(B, { type: "move", to: "kitchen" });
    h.act(A, { type: "start", activity: "eat", itemId: null });
    h.act(B, { type: "join", activityId: h.world.activities[0]!.id });
    h.advance(545);
    h.act(A, { type: "move", to: "living_room" });
    h.advance(550);
    h.act(A, chooseWorldRoutine(h.world, "claude")!);
    h.act(U, { type: "join", activityId: h.world.activities[0]!.id });
    h.advance(1500);
    h.act(U, { type: "invite", to: A, activity: "read" });
    h.act(A, { type: "answer", commitmentId: h.world.commitments[0]!.id, answer: "later", dueAt: 1560 });
    h.advance(1515);

    let replay = JSON.parse(JSON.stringify(savedInitial)) as WorldSnapshot;
    const replayed: WorldEvent[] = [h.events[0]!];
    for (const event of h.events) {
      if (event.type !== "action") continue;
      const elapsed = advanceWorld(replay, event.at);
      replay = elapsed.world; replayed.push(...elapsed.events);
      const step = applyWorldAction(replay, event.actor, event.action, {
        activityId: event.activityId, commitmentId: event.commitmentId,
      });
      assert.equal(step.result.accepted, true);
      replay = step.world; replayed.push(...step.events);
    }
    const elapsed = advanceWorld(replay, h.world.now);
    replay = elapsed.world; replayed.push(...elapsed.events);
    // Terminal records are expected outputs of advance/stop, never replay inputs.
    // Applying them again would double the meals or refund cancelled ingredients.
    assert.deepEqual(replayed, h.events);
    assert.deepEqual(replay, h.world, "gauges, reservations, possessions and the remaining appointment all match");
    assert.equal(count(replay, "ingredients"), rulesVersion === "1" ? 15 : 16);
    assert.equal(count(replay, "meals"), 2);
    assert.equal(replay.commitments[0]!.state, "deferred");
    assert.equal(replayed.filter((e) => e.type === "activity_ended").length, 4);
  });

  it("keeps eight residents eating and sleeping for three days and eating again after the last night", () => {
    const agents = ["claude", "codex", "three", "four", "five", "six", "seven", "eight"];
    const base = initial();
    let world = createWorld({ id: base.id, generation: base.generation, asOf: base.asOf,
      settings: { residents: agents, dayRealMinutes: 4, dailyCognitionLimit: 0 } });
    const began = world.now;
    const events: WorldEvent[] = [{ type: "clock", seq: 1, at: began, mark: "day_started", day: 1 }];
    let views = updateWorldViews([], world, world, events).views;
    let serial = 1;
    // Allow existing two-hour sleep activities to finish, then verify breakfast recovery too.
    for (let minute = began + 1; minute <= began + 3 * 1440 + 180; minute++) {
      const elapsed = advanceWorld(world, minute);
      if (elapsed.events.length) views = updateWorldViews(views, world, elapsed.world, elapsed.events).views;
      world = elapsed.world; events.push(...elapsed.events);
      for (const agent of agents) {
        const view = views.find((entry) => entry.agent === agent)!;
        const choice = chooseWorldRoutine(world, agent, view.seen, view);
        if (!choice) continue;
        const result = applyWorldAction(world, { kind: "resident", agent }, choice, ids(serial++));
        if (!result.result.accepted) { assert.equal(result.result.reason, "item_busy"); continue; }
        views = updateWorldViews(views, world, result.world, result.events).views;
        world = result.world; events.push(...result.events);
      }
      if (minute % 1440 === 0) WorldSnapshot.parse(world);
    }
    WorldSnapshot.parse(world);
    views.forEach((view) => WorldResidentView.parse(view));
    events.forEach((event) => WorldEvent.parse(event));
    const completed = events.filter((event) => event.type === "activity_ended" && event.activity.state === "completed");
    for (let day = 0; day < 3; day++) for (const agent of agents) for (const kind of ["eat", "sleep"]) {
      assert.ok(completed.some((event) => event.type === "activity_ended" && event.activity.kind === kind &&
        event.at > began + day * 1440 && event.at <= began + (day + 1) * 1440 &&
        event.activity.participants.some((actor) => actor.kind === "resident" && actor.agent === agent)), `${agent} completes ${kind} on interval ${day + 1}`);
    }
    for (const agent of agents) assert.ok(completed.some((event) => event.type === "activity_ended" && event.activity.kind === "eat" &&
      event.at > began + 3 * 1440 && event.activity.participants.some((actor) => actor.kind === "resident" && actor.agent === agent)), `${agent} eats after the final night`);
    assert.ok(world.residents.every((resident) => resident.energy > 0 && resident.satiety > 0));
    assert.ok(count(world, "ingredients") >= 0 && count(world, "ingredients") <= 16);
  });

  it("skipLeisure leaves a healthy idle resident free without changing default leisure or evening invitations", () => {
    for (const now of [480, 510, 540, 1080]) {
      const h = fixture({ ...initial(), now });
      const view = h.views.find((entry) => entry.agent === "claude")!;
      const before = structuredClone(h.world);
      const normal = chooseWorldRoutine(h.world, "claude", view.seen, view);
      assert.ok(normal, "the default still proposes an idle activity or an evening invitation");
      assert.deepEqual(chooseWorldRoutine(h.world, "claude", view.seen, view, { skipLeisure: false }), normal);
      assert.equal(chooseWorldRoutine(h.world, "claude", view.seen, view, { skipLeisure: true }), null);
      assert.deepEqual(h.world, before);
    }
  });

  it("skipLeisure preserves food, sleep, invitation answers, due promises and joining", () => {
    const choose = (h: ReturnType<typeof fixture>, agent: string) => {
      const view = h.views.find((entry) => entry.agent === agent)!;
      return chooseWorldRoutine(h.world, agent, view.seen, view, { skipLeisure: true });
    };
    const hungry = initial();
    hungry.residents[0]!.satiety = 20;
    const food = fixture(hungry);
    assert.deepEqual(choose(food, "claude"), { type: "move", to: "kitchen" });
    food.act(A, choose(food, "claude")!);
    assert.deepEqual(choose(food, "claude"), { type: "start", activity: "cook", itemId: null });
    food.act(A, choose(food, "claude")!);

    const tired = initial();
    tired.residents[0]!.energy = 20;
    const sleep = fixture(tired);
    assert.deepEqual(choose(sleep, "claude"), { type: "move", to: "room_1" });
    sleep.act(A, choose(sleep, "claude")!);
    assert.deepEqual(choose(sleep, "claude"), { type: "start", activity: "sleep", itemId: null });
    sleep.act(A, choose(sleep, "claude")!);

    const h = fixture();
    h.act(A, { type: "start", activity: "read", itemId: null });
    h.act(B, { type: "invite", to: A, activity: "set_table" });
    const answer = choose(h, "claude");
    assert.ok(answer?.type === "answer" && answer.answer === "later" && answer.dueAt !== null);
    h.act(A, answer);
    h.advance(answer.dueAt);
    assert.deepEqual(choose(h, "claude"), { type: "start", activity: "set_table", itemId: null });
    h.act(A, choose(h, "claude")!);
    assert.deepEqual(choose(h, "codex"), { type: "join", activityId: h.world.activities[0]!.id });
    h.act(B, choose(h, "codex")!);
    assert.deepEqual(h.world.activities[0]!.participants, [A, B]);
  });

  it("invites a housemate in the evening, shares the activity, and does not repeat or reciprocate that day", () => {
    const h = fixture({ ...initial(), now: 1080 });
    const choose = (agent: string) => chooseWorldRoutine(h.world, agent, h.views.find((v) => v.agent === agent)!.seen);
    const proposal = choose("claude");
    assert.deepEqual(proposal, { type: "invite", to: B, activity: "read" });
    h.act(A, proposal!);
    const reply = choose("codex");
    assert.ok(reply?.type === "answer" && reply.answer === "accept");
    h.act(B, reply);
    assert.equal(choose("claude"), null, "the inviter waits instead of taking the agreed book first");
    h.act(B, choose("codex")!);
    h.act(A, choose("claude")!);
    const together = h.world.activities[0]!;
    assert.equal(together.participants.length, 2);
    h.act(A, { type: "stop" });
    h.act(B, { type: "stop" });
    assert.notEqual(choose("claude")?.type, "invite");
    assert.notEqual(choose("codex")?.type, "invite");
    const tomorrow = { ...initial(), now: 2520 };
    assert.equal(chooseWorldRoutine(tomorrow, "claude", h.views[0]!.seen)?.type, "invite");
    assert.notEqual(chooseWorldRoutine({ ...initial(), now: 1110 }, "claude")?.type, "invite");
  });

  it("lets a hungry inviter prepare food while the accepted activity has not started", () => {
    const start = initial();
    start.residents[0]!.satiety = 20;
    const h = fixture(start);
    h.act(A, { type: "invite", to: B, activity: "read" });
    const agreement = h.world.commitments[0]!;
    h.act(B, { type: "answer", commitmentId: agreement.id, answer: "accept", dueAt: null });
    const waiting = structuredClone(h.world);
    const move = chooseWorldRoutine(h.world, "claude");
    assert.deepEqual(move, { type: "move", to: "kitchen" });
    assert.deepEqual(h.world, waiting, "choosing a need does not change the promise");
    assert.deepEqual(chooseWorldRoutine(h.world, "codex"), { type: "start", activity: "read", itemId: null }, "the invitee's fulfillment rule is unchanged");
    h.act(A, move!);
    const cook = chooseWorldRoutine(h.world, "claude");
    assert.deepEqual(cook, { type: "start", activity: "cook", itemId: null });
    h.act(A, cook!);
    assert.equal(h.world.commitments[0]!.activityId, null, "preparing food does not fulfill the reading invitation");
    assert.equal(holder(h.world, "book").usedBy, null, "the inviter does not take the promised book");
    assert.equal(count(h.world, "ingredients"), 15);
  });

  it("lets a tired inviter go to bed while the accepted activity has not started", () => {
    const start = initial();
    start.residents[0]!.energy = 20;
    const h = fixture(start);
    h.act(A, { type: "invite", to: B, activity: "read" });
    const agreement = h.world.commitments[0]!;
    h.act(B, { type: "answer", commitmentId: agreement.id, answer: "accept", dueAt: null });
    const move = chooseWorldRoutine(h.world, "claude");
    assert.deepEqual(move, { type: "move", to: "room_1" });
    h.act(A, move!);
    const sleep = chooseWorldRoutine(h.world, "claude");
    assert.deepEqual(sleep, { type: "start", activity: "sleep", itemId: null });
    h.act(A, sleep!);
    assert.equal(h.world.commitments[0]!.activityId, null);
    assert.equal(h.world.activities[0]!.kind, "sleep");
    assert.equal(holder(h.world, "book").usedBy, null);
  });

  it("uses only the resident's shared experiences to defer a discretionary invitation when tired", () => {
    const h = fixture();
    for (let i = 0; i < 2; i += 1) {
      h.act(A, { type: "start", activity: "set_table", itemId: null });
      h.act(B, { type: "join", activityId: h.world.activities[0]!.id });
      h.advance(h.world.activities[0]!.endsAt);
    }
    h.act(B, { type: "invite", to: A, activity: "read" });
    const tired = structuredClone(h.world);
    tired.residents[0]!.energy = 35;
    const withoutExperience = chooseWorldRoutine(tired, "claude", []);
    assert.ok(withoutExperience?.type === "answer" && withoutExperience.answer === "decline");
    const familiar = chooseWorldRoutine(tired, "claude", h.views.find((v) => v.agent === "claude")!.seen);
    assert.ok(familiar?.type === "answer" && familiar.answer === "later" && familiar.dueAt === tired.now + 45);
    tired.residents[0]!.energy = 10;
    const urgent = chooseWorldRoutine(tired, "claude", h.events);
    assert.ok(urgent?.type === "answer" && urgent.answer === "decline");
  });

  it("accumulates heard contact directionally at most once per speaker per world day", () => {
    const heard: WorldEvent[] = [
      { type: "said", seq: 2, at: 480, placeId: "living_room", speaker: B, text: "早上好。", sceneId: null },
      { type: "said", seq: 3, at: 481, placeId: "living_room", speaker: B, text: "一起看书吗？", sceneId: null },
      { type: "said", seq: 4, at: 1920, placeId: "living_room", speaker: B, text: "今天也一起吃饭吧。", sceneId: null },
    ];
    assert.equal(worldFamiliarity(heard.slice(0, 2), "claude", "codex"), 1);
    assert.equal(worldFamiliarity([...heard, ...heard], "claude", "codex"), 2);
    assert.equal(worldFamiliarity(heard, "codex", "claude"), 0, "the other direction does not receive invented experience");
    assert.equal(worldFamiliarity(heard, "codex", "codex"), 0);
  });

  it("proposes visible book contention but never reveals an occupied book in another room", () => {
    const h = fixture({ ...initial(), now: 540 });
    h.act(B, { type: "start", activity: "read", itemId: null });
    const proposal = chooseWorldRoutine(h.world, "claude");
    assert.deepEqual(proposal, { type: "start", activity: "read", itemId: null });
    assert.deepEqual(h.apply(A, proposal!).result, { accepted: false, reason: "item_busy" });
    h.act(B, { type: "stop" });
    h.act(B, { type: "take", itemId: "book" });
    h.act(B, { type: "move", to: "room_2" });
    h.act(B, { type: "start", activity: "read", itemId: null });
    assert.notDeepEqual(chooseWorldRoutine(h.world, "claude"), proposal);
  });
});

describe("per-resident observation and old beliefs", () => {
  it("reveals midnight replenishment only in the kitchen and keeps later cooking changes in event order", () => {
    const start = { ...initial(), now: 1430 };
    for (const item of start.items) if (item.kind === "stock" && item.id === "ingredients") item.count = 2;
    const h = fixture(start);
    h.act(A, { type: "move", to: "kitchen" });
    h.act(B, { type: "move", to: "kitchen" });
    h.act(B, { type: "move", to: "living_room" });
    const oldKnowledge = structuredClone(h.views[1]!.knownItems.find((item) => item.itemId === "ingredients"));
    h.act(A, { type: "start", activity: "cook", itemId: null });
    const before = structuredClone(h.world), beforeViews = structuredClone(h.views);
    const midnight = h.advance(1440);
    const dayStarted = midnight.events.find((event) => event.type === "clock" && event.mark === "day_started")!;
    const known = h.views[0]!.knownItems.find((item) => item.itemId === "ingredients")!;
    assert.equal(known.count, 15);
    assert.equal(known.seq, dayStarted.seq);
    assert.deepEqual(h.views[1]!.knownItems.find((item) => item.itemId === "ingredients"), oldKnowledge);
    const cook = h.act(A, { type: "stop" });
    assert.equal(h.views[0]!.knownItems.find((item) => item.itemId === "ingredients")!.count, 16);
    const combined = updateWorldViews(beforeViews, before, h.world, [...midnight.events, ...cook.events]);
    assert.deepEqual(combined.views, h.views, "a batched midnight and refund reveal the same ordered evidence");
    assert.deepEqual(h.views[1]!.knownItems.find((item) => item.itemId === "ingredients"), oldKnowledge);
  });

  it("observes a scene's physical action but not its opened, chose, or closed UI history", () => {
    const h = fixture();
    const opened: WorldEvent = { type: "scene", seq: 2, at: h.world.now, placeId: "living_room", sceneId: `wscn_${suffix(1)}`,
      step: "opened", optionId: null, result: null };
    const action = applyWorldAction({ ...h.world, lastSeq: opened.seq }, A, { type: "start", activity: "read", itemId: null }, ids(1));
    assert.equal(action.result.accepted, true);
    const chose: WorldEvent = { ...opened, seq: 4, step: "chose", optionId: "opt_read", result: action.result };
    const closed: WorldEvent = { ...opened, seq: 5, step: "closed" };
    const events = [opened, ...action.events, chose, closed];
    events.forEach((event) => WorldEvent.parse(event));
    const observed = updateWorldViews(h.views, h.world, { ...action.world, lastSeq: closed.seq }, events);
    assert.deepEqual(observed.observations.map((observation) => [observation.observer, observation.seq, observation.mode]),
      [["claude", 3, "saw"], ["codex", 3, "saw"]]);
    for (const view of observed.views) {
      assert.deepEqual(view.seen.map((event) => event.seq), [3, 1]);
      assert.equal(view.knownItems.find((item) => item.itemId === "book")!.seq, 3, "UI history cannot become item evidence");
      assert.deepEqual(view.heard, []);
    }
  });

  it("reads where the resident last saw the book while an uninformed housemate searches the old room", () => {
    const h = fixture();
    h.act(B, { type: "move", to: "room_2" });
    h.act(A, { type: "take", itemId: "book" });
    h.act(A, { type: "move", to: "room_1" });
    h.act(A, { type: "put", itemId: "book" });
    h.act(A, { type: "move", to: "living_room" });
    h.act(U, { type: "invite", to: A, activity: "read" });
    h.act(A, { type: "answer", commitmentId: h.world.commitments[0]!.id, answer: "accept", dueAt: null });
    h.act(U, { type: "move", to: "room_2" });
    h.act(U, { type: "invite", to: B, activity: "read" });
    h.act(B, { type: "answer", commitmentId: h.world.commitments.find((c) => c.by.kind === "resident" && c.by.agent === "codex")!.id, answer: "accept", dueAt: null });
    const choose = (agent: string) => {
      const view = h.views.find((v) => v.agent === agent)!;
      return chooseWorldRoutine(h.world, agent, view.seen, view);
    };
    assert.deepEqual(choose("claude"), { type: "move", to: "room_1" });
    assert.deepEqual(choose("codex"), { type: "move", to: "living_room" });
    h.act(A, choose("claude")!);
    assert.deepEqual(choose("claude"), { type: "start", activity: "read", itemId: null });
    h.act(A, choose("claude")!);
    assert.equal(h.world.activities[0]!.placeId, "room_1", "the accepted invitation starts at the known book location");
    h.act(B, choose("codex")!);
    const viewB = h.views.find((v) => v.agent === "codex")!;
    assert.equal(viewB.knownItems.find((item) => item.itemId === "book")!.at, null);
    assert.equal(choose("codex"), null, "not finding the book does not reveal its actual room");
    h.act(U, { type: "move", to: "living_room" });
    const told: WorldEvent = { type: "said", seq: h.world.lastSeq + 1, at: h.world.now, placeId: "living_room", speaker: U, text: "书在一号房间。", sceneId: null };
    const heard = updateWorldViews(h.views, h.world, { ...h.world, lastSeq: told.seq }, [told]).views.find((v) => v.agent === "codex")!;
    assert.equal(heard.knownItems.find((item) => item.itemId === "book")!.at, null);
    assert.equal(chooseWorldRoutine(h.world, "codex", [...heard.seen, told], heard), null);
    h.act(A, { type: "stop" });
    h.act(B, { type: "move", to: "room_1" });
    h.act(B, { type: "move", to: "living_room" });
    assert.deepEqual(choose("codex"), { type: "move", to: "room_1" }, "firsthand discovery updates subsequent navigation");
  });

  it("uses the last observed room of a holder and never follows their hidden current position", () => {
    const h = fixture();
    h.act(B, { type: "take", itemId: "book" });
    h.act(B, { type: "move", to: "room_1" });
    const visit = h.act(A, { type: "move", to: "room_1" });
    h.act(A, { type: "move", to: "living_room" });
    h.act(A, { type: "move", to: "kitchen" });
    h.act(B, { type: "move", to: "living_room" });
    h.act(B, { type: "move", to: "room_2" });
    h.act(U, { type: "move", to: "kitchen" });
    h.act(U, { type: "invite", to: A, activity: "read" });
    h.act(A, { type: "answer", commitmentId: h.world.commitments[0]!.id, answer: "accept", dueAt: null });
    const firstView = h.views.find((v) => v.agent === "claude")!;
    assert.equal(firstView.knownItems.find((item) => item.itemId === "book")!.seq, visit.events[0]!.seq);
    const choose = (world = h.world) => {
      const view = h.views.find((v) => v.agent === "claude")!;
      return chooseWorldRoutine(world, "claude", view.seen, view);
    };
    assert.deepEqual(choose(), { type: "move", to: "living_room" });
    h.act(A, choose()!);
    assert.deepEqual(choose(), { type: "move", to: "room_1" });
    const unseenChange = structuredClone(h.world);
    unseenChange.residents.find((r) => r.agent === "codex")!.placeId = "kitchen";
    assert.deepEqual(choose(unseenChange), choose(), "changing only hidden truth cannot change the navigation proposal");
  });

  it("can read a self-held book in the current room", () => {
    const h = fixture({ ...initial(), now: 540 });
    h.act(A, { type: "take", itemId: "book" });
    h.act(A, { type: "move", to: "room_1" });
    const view = h.views.find((v) => v.agent === "claude")!;
    assert.deepEqual(chooseWorldRoutine(h.world, "claude", view.seen, view), { type: "start", activity: "read", itemId: null });
  });

  it("keeps a hidden move out of B's view and routine, then stores only the words B actually hears", () => {
    const h = fixture();
    h.act(B, { type: "move", to: "room_2" });
    h.act(A, { type: "take", itemId: "book" });
    h.act(A, { type: "move", to: "room_1" });
    h.act(A, { type: "put", itemId: "book" });
    const viewB = h.views.find((v) => v.agent === "codex")!;
    assert.deepEqual(viewB.knownItems.find((i) => i.itemId === "book")!.at, { kind: "place", placeId: "living_room" });
    assert.equal(viewB.seen.some((e) => e.type === "action" && e.actor.kind === "resident" && e.actor.agent === "claude"), false);
    const next = chooseWorldRoutine(h.world, "codex");
    assert.notDeepEqual(next, { type: "move", to: "room_1" });
    h.act(A, { type: "move", to: "living_room" });
    h.act(B, { type: "move", to: "living_room" });
    const missing = h.views.find((v) => v.agent === "codex")!.knownItems.find((i) => i.itemId === "book")!;
    assert.equal(missing.at, null, "seeing the empty old room reveals absence, not the new room");
    const said: WorldEvent = { type: "said", seq: h.world.lastSeq + 1, at: h.world.now, placeId: "living_room", speaker: A, text: "我把书收起来了。", sceneId: null };
    const updated = updateWorldViews(h.views, h.world, { ...h.world, lastSeq: said.seq }, [said]);
    const b = updated.views.find((v) => v.agent === "codex")!;
    assert.equal(b.knownItems.find((i) => i.itemId === "book")!.at, null);
    assert.deepEqual(b.heard[0], { seq: said.seq, at: said.at, speaker: A, text: said.text });
    assert.equal(b.seen.some((e) => e.seq === said.seq), false);
    assert.ok(updated.observations.every((o) => o.mode === "heard"));
  });

  it("arrival sees current objects and each observation names the event that exposed them", () => {
    const h = fixture();
    assert.equal(h.views[0]!.knownItems.some((i) => i.itemId === "pot"), false);
    const arrival = h.act(A, { type: "move", to: "kitchen" });
    const a = h.views.find((v) => v.agent === "claude")!;
    assert.equal(a.knownItems.find((i) => i.itemId === "pot")!.seq, arrival.events[0]!.seq);
    assert.equal(a.knownItems.find((i) => i.itemId === "ingredients")!.count, 16);
    assert.equal(h.views.find((v) => v.agent === "codex")!.knownItems.some((i) => i.itemId === "ingredients"), false);
  });

  it("does not refresh someone else's room from a day clock or a later terminal event", () => {
    const h = fixture();
    h.act(A, { type: "move", to: "kitchen" });
    h.act(A, { type: "start", activity: "cook", itemId: null });
    h.advance(1450);
    const b = h.views.find((v) => v.agent === "codex")!;
    assert.equal(b.knownItems.some((i) => i.itemId === "meals"), false);
    assert.equal(b.seen.some((e) => e.type === "activity_ended"), false);
    assert.ok(b.seen.some((e) => e.type === "clock" && e.day === 2));
  });

  it("a new world ignores old views even when resident names and event numbers match", () => {
    const h = fixture();
    h.act(A, { type: "move", to: "kitchen" });
    const fresh = { ...initial(), id: `world_${suffix(2)}` };
    const initialEvent: WorldEvent = { type: "clock", seq: 1, at: 480, mark: "day_started", day: 1 };
    const result = updateWorldViews(h.views, fresh, fresh, [initialEvent]);
    assert.ok(result.views.every((v) => v.worldId === fresh.id));
    assert.ok(result.views.every((v) => v.knownItems.every((i) => i.itemId !== "ingredients")));
    assert.throws(() => updateWorldViews(h.views, h.world, fresh, []), /world identities/);
  });
});
