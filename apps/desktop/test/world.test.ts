import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openDatabase, WriteQueue, ulid } from "@room/db";
import { ControlEvent, WorldState, type CommandRequest, type WorldPlayerAction } from "@room/schemas";
import { WorldService } from "../src/main/world";

async function setup(residents = ["claude", "codex"], resetWorld = true) {
  const dir = mkdtempSync(join(tmpdir(), "room-world-main-"));
  const path = join(dir, "room.db");
  const db = openDatabase(path);
  const queue = new WriteQueue();
  const events: ControlEvent[] = [];
  const make = () => new WorldService({ db, queue, dbPath: path, emit: (e) => { events.push(ControlEvent.parse(e)); }, knownAgents: () => residents, agentName: (id) => id === "claude" ? "C酱" : id === "codex" ? "林离" : id, now: () => "2026-11-16T00:00:00.000Z" });
  let service = make();
  await service.start();
  const reset: CommandRequest<"world.reset"> = { type: "world.reset", requestId: `wact_${ulid()}`, worldId: null, confirm: true, settings: { residents, dayRealMinutes: 4, dailyCognitionLimit: 0 } };
  if (resetWorld) await service.reset(reset);
  return {
    db, queue, events, reset, get service() { return service; },
    restart: async () => { await service.stop(); service = make(); await service.start(); },
    close: async () => { await service.stop(); db.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}
function action(service: WorldService, act: WorldPlayerAction): CommandRequest<"world.act"> {
  const world = service.get().world!;
  return { type: "world.act", actionId: `wact_${ulid()}`, worldId: world.id, generation: world.generation, action: act };
}
function move(service: WorldService) {
  const world = service.get().world!;
  const room = world.places.find((p) => p.id === world.player.placeId)!;
  return action(service, { type: "move", to: room.neighbors[0]! });
}

test("world.get returns null settings only before a world, saved settings or configured residents exist", async () => {
  const agents: string[] = [];
  const h = await setup(agents, false);
  try {
    assert.deepEqual(WorldState.parse(h.service.get()), { world: null, scene: null, settings: null, budgets: [] });
    assert.equal((h.db.prepare("SELECT COUNT(*) AS n FROM world_settings").get() as { n: number }).n, 0, "reading the empty state does not manufacture saved settings");
    await assert.rejects(h.service.reset({ type: "world.reset", requestId: `wact_${ulid()}`, worldId: null, confirm: true }), /请先配置至少一位秘书/);
    await assert.rejects(h.service.reset(h.reset), /请选择已配置的秘书入住/, "explicit empty residents still cannot create a world");
    assert.equal(h.service.get().world, null);
    agents.push("claude", "codex", "third");
    const state = WorldState.parse(h.service.get());
    assert.equal(state.world, null);
    assert.deepEqual(state.settings, { residents: ["claude", "codex"], dayRealMinutes: 24, dailyCognitionLimit: 60 });
  } finally { await h.close(); }
});

test("world.get prefers saved settings over configured defaults even before a world starts", async () => {
  const agents = ["new-resident"];
  const h = await setup(agents, false);
  const saved = { residents: ["saved-resident"], dayRealMinutes: 90, dailyCognitionLimit: 7 };
  try {
    h.db.prepare("INSERT INTO world_settings(singleton, settings_json) VALUES (1, ?)").run(JSON.stringify(saved));
    assert.deepEqual(WorldState.parse(h.service.get()).settings, saved);
    agents.length = 0;
    assert.deepEqual(WorldState.parse(h.service.get()), { world: null, scene: null, settings: saved, budgets: [] });
  } finally { await h.close(); }
});

test("an existing world retains non-null saved settings after all configured residents are removed", async () => {
  const agents = ["claude", "codex"];
  const h = await setup(agents);
  try {
    const before = WorldState.parse(h.service.get());
    agents.length = 0;
    const after = WorldState.parse(h.service.get());
    assert.ok(after.world);
    assert.deepEqual(after.settings, before.settings);
    assert.notEqual(after.settings, null);
    h.db.exec("DELETE FROM world_settings");
    assert.throws(() => h.service.get(), /active world has no settings/, "a broken active world cannot become an empty start page");
  } finally { await h.close(); }
});

test("invalid saved settings still fail instead of becoming null or configured defaults", async () => {
  for (const agents of [[], ["claude"]]) {
    const h = await setup(agents, false);
    try {
      h.db.prepare("INSERT INTO world_settings(singleton, settings_json) VALUES (1, ?)").run(JSON.stringify({ residents: [], dayRealMinutes: 24, dailyCognitionLimit: 60 }));
      assert.throws(() => h.service.get(), { name: "ZodError" });
      h.db.prepare("UPDATE world_settings SET settings_json = ? WHERE singleton = 1").run("null");
      assert.throws(() => h.service.get(), { name: "ZodError" });
    } finally { await h.close(); }
  }
});

test("world reset and actions use persisted receipts, including response loss and different content", async () => {
  const h = await setup();
  try {
    const first = WorldState.parse(h.service.get());
    assert.deepEqual(await h.service.reset(h.reset), first);
    const req = move(h.service);
    const results = await Promise.all([h.service.act(req), h.service.act(req)]);
    assert.deepEqual(results[0], results[1]);
    assert.equal(results[0]!.accepted, true);
    assert.equal(h.service.events(first.world!.id, undefined, 100).items.filter((e) => e.type === "action").length, 1);
    const changed = { ...req, action: { type: "stop" as const } };
    assert.deepEqual(await h.service.act(changed), { accepted: false, reason: "duplicate_action" });
    await h.restart();
    assert.deepEqual(await h.service.act(req), results[0]);
    assert.deepEqual(await h.service.reset(h.reset), first, "reset receipt survives a new runtime session");
    assert.notEqual(h.service.get().world!.generation.session, first.world!.generation.session);
  } finally { await h.close(); }
});

test("world commit failure publishes nothing and retry does not leave a partial receipt or view", async () => {
  const h = await setup();
  try {
    const before = h.service.get();
    const count = h.events.length;
    const req = move(h.service);
    h.db.exec("CREATE TEMP TRIGGER world_fail BEFORE INSERT ON world_observations BEGIN SELECT RAISE(ABORT, 'injected observation failure'); END");
    await assert.rejects(h.service.act(req), /injected observation failure/);
    assert.deepEqual(h.service.get(), before);
    assert.equal(h.events.length, count);
    assert.equal((h.db.prepare("SELECT COUNT(*) AS n FROM world_receipts WHERE request_id = ?").get(req.actionId) as { n: number }).n, 0);
    h.db.exec("DROP TRIGGER world_fail");
    assert.equal((await h.service.act(req)).accepted, true);
  } finally { await h.close(); }
});

test("maintenance failure restores only its own pause; user pause and resume during backup win", async () => {
  const h = await setup();
  try {
    const id = h.service.get().world!.id;
    const stale = move(h.service);
    const now = h.service.get().world!.now;
    await assert.rejects(h.service.maintenance(async () => {
      assert.deepEqual(h.service.get().world!.run, { state: "paused", by: "maintenance" });
      await h.service.advance(5000);
      assert.equal(h.service.get().world!.now, now);
      throw new Error("backup failed");
    }), /backup failed/);
    assert.equal(h.service.get().world!.run.state, "running");
    assert.deepEqual(await h.service.act(stale), { accepted: false, reason: "stale_generation" });
    await h.service.maintenance(async () => { await h.service.pause(id); });
    assert.deepEqual(h.service.get().world!.run, { state: "paused", by: "user" });
    await h.service.maintenance(async () => { await h.service.resume(id); });
    assert.equal(h.service.get().world!.run.state, "running");
    await h.service.pause(id);
    await h.service.maintenance(async () => {});
    assert.deepEqual(h.service.get().world!.run, { state: "paused", by: "user" });
  } finally { await h.close(); }
});

test("switch failure restores the old world; successful switch permanently closes its writer", async () => {
  const h = await setup();
  try {
    await assert.rejects(h.service.beginSwitch(async () => { throw new Error("cannot write location"); }), /cannot write location/);
    assert.equal(h.service.get().world!.run.state, "running");
    const before = h.service.get().world!.now;
    assert.equal(await h.service.beginSwitch(async () => "switched"), "switched");
    await h.service.advance(5000);
    assert.equal(h.service.get().world!.now, before);
  } finally { await h.close(); }
});

test("stop racing a maintenance drain cannot enqueue a write after releasing the database lock", async () => {
  const h = await setup();
  try {
    let release!: () => void;
    const gate = h.queue.run(() => new Promise<void>((resolve) => { release = resolve; }));
    await Promise.resolve();
    let ranMaintenance = false;
    const maintaining = h.service.maintenance(async () => { ranMaintenance = true; });
    const rejection = assert.rejects(maintaining, /世界已经停止/);
    const stopping = h.service.stop();
    release();
    await Promise.all([gate, rejection, stopping]);
    const before = h.events.length;
    const count = (h.db.prepare("SELECT COUNT(*) AS n FROM world_receipts").get() as { n: number }).n;
    assert.deepEqual(await h.service.act(move(h.service)), { accepted: false, reason: "world_paused" });
    assert.equal((h.db.prepare("SELECT COUNT(*) AS n FROM world_receipts").get() as { n: number }).n, count);
    assert.equal(ranMaintenance, false);
    assert.equal(h.events.length, before);
  } finally { await h.close(); }
});

test("sleep, large gaps and reopen do not invent elapsed world time; pause persists", async () => {
  const h = await setup();
  try {
    const id = h.service.get().world!.id;
    const now = h.service.get().world!.now;
    await h.service.advance(3_600_000);
    assert.equal(h.service.get().world!.now, now);
    await h.service.suspend();
    await h.service.advance(5000);
    await h.service.resumeFromSuspend();
    assert.equal(h.service.get().world!.now, now);
    await h.service.advance(1000);
    assert.equal(h.service.get().world!.now, now + 6);
    await h.service.pause(id);
    await h.restart();
    assert.deepEqual(h.service.get().world!.run, { state: "paused", by: "user" });
    assert.equal(h.service.get().world!.now, now + 6);
  } finally { await h.close(); }
});

test("player scenes include the chosen resident first even with eight residents in the same room", async () => {
  const agents = Array.from({ length: 8 }, (_, i) => `resident-${i + 1}`);
  const h = await setup(agents);
  try {
    for (const agent of [...agents.slice(4), ...agents.slice(0, 4)]) {
      const world = h.service.get().world!;
      assert.ok(world.residents.every((r) => r.placeId === world.player.placeId));
      const request: CommandRequest<"world.talk"> = { type: "world.talk", actionId: `wact_${ulid()}`, worldId: world.id, generation: world.generation, agent };
      const opened = await h.service.talk(request);
      assert.equal(opened.result.accepted, true);
      assert.deepEqual(opened.scene!.origin, { kind: "player", agent });
      assert.deepEqual(opened.scene!.residents, [agent, ...agents.filter((other) => other !== agent).slice(0, 3)]);
      assert.deepEqual(await h.service.talk(request), opened, "the receipt preserves the chosen scene participants");
      assert.equal((await h.service.close({ type: "world.scene.close", actionId: `wact_${ulid()}`, worldId: world.id, generation: world.generation, sceneId: opened.scene!.id })).result.accepted, true);
      assert.deepEqual(h.service.scenes(world.id, undefined, 1).items[0]!.residents, opened.scene!.residents);
    }
  } finally { await h.close(); }
});

test("event scenes keep the first four same-room residents in their original order", async () => {
  const agents = Array.from({ length: 8 }, (_, i) => `resident-${i + 1}`);
  const h = await setup(agents);
  try {
    await h.service.advance(200);
    const { world, scene } = h.service.get();
    assert.ok(scene);
    assert.equal(scene.origin.kind, "event");
    assert.ok(world!.residents.every((resident) => resident.placeId === scene.placeId));
    assert.deepEqual(scene.residents, agents.slice(0, 4));
  } finally { await h.close(); }
});

test("a rule scene records one choice, expires alternatives, and stays read-only after restart", async () => {
  const h = await setup();
  try {
    let world = h.service.get().world!;
    const target = world.residents[0]!;
    if (world.player.placeId !== target.placeId) {
      const room = world.places.find((p) => p.id === world.player.placeId)!;
      if (!room.neighbors.includes(target.placeId)) await h.service.act(action(h.service, { type: "move", to: "living_room" }));
      await h.service.act(action(h.service, { type: "move", to: target.placeId }));
    }
    world = h.service.get().world!;
    const opened = await h.service.talk({ type: "world.talk", actionId: `wact_${ulid()}`, worldId: world.id, generation: world.generation, agent: target.agent });
    assert.equal(opened.result.accepted, true);
    assert.equal(opened.scene!.canType, false);
    const choose: CommandRequest<"world.scene.choose"> = { type: "world.scene.choose", actionId: `wact_${ulid()}`, worldId: world.id, generation: world.generation, sceneId: opened.scene!.id, optionId: "opt_watch" };
    const first = await h.service.choose(choose);
    assert.deepEqual(await h.service.choose(choose), first);
    assert.equal(first.scene!.past.filter((p) => p.outcome === "chosen").length, 1);
    const seq = h.service.get().world!.lastSeq;
    await h.restart();
    const history = h.service.scenes(world.id, undefined, 10).items;
    assert.equal(history.length, 1);
    assert.equal(history[0]!.state, "closed");
    assert.equal(h.service.get().world!.lastSeq, seq + 1, "only closes the old scene, never reruns its choice");
  } finally { await h.close(); }
});

test("two days of autonomous life produce disjoint evidence-backed reviews and keep observed history after view truncation", async () => {
  const h = await setup();
  try {
    while (h.service.get().world!.now < 2880) await h.service.advance(5000);
    const world = h.service.get().world!;
    const first = h.service.review(world.id, 1)!;
    const second = h.service.review(world.id, 2)!;
    assert.ok(first.items.length > 0 && second.items.length > 0);
    assert.ok(first.items.some((item) => item.text.includes("C酱") || item.text.includes("林离")));
    assert.ok([...first.items, ...second.items].every((item) => !/claude|codex/.test(item.text)));
    const firstSeqs = new Set(first.items.flatMap((item) => item.seqs));
    for (const item of second.items) for (const seq of item.seqs) assert.equal(firstSeqs.has(seq), false);
    for (const item of [...first.items, ...second.items]) for (const seq of item.seqs) {
      const stored = h.db.prepare("SELECT kind FROM world_events WHERE world_id = ? AND seq = ?").get(world.id, seq) as { kind: string };
      assert.equal(stored.kind, "activity_ended");
    }
    const invites = h.db.prepare("SELECT event_json FROM world_events WHERE world_id=? AND kind='action' AND json_extract(event_json,'$.action.type')='invite'").all(world.id) as { event_json: string }[];
    assert.ok(invites.length > 0, "residents initiate shared activities without a model or player command");
    const unique = new Set(invites.map((row) => { const e = JSON.parse(row.event_json); return `${Math.floor(e.at / 1440)}:${e.actor.agent}:${e.action.to.agent}`; }));
    assert.equal(unique.size, invites.length, "one invitation per direction and day, including after the recent view rolls over");
  } finally { await h.close(); }
});
