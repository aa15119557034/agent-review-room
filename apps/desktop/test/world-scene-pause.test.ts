import assert from "node:assert/strict";
import { test } from "node:test";
import { openDatabase, WorldStore, WriteQueue, ulid } from "@room/db";
import { ControlEvent, type CommandRequest, type WorldScene } from "@room/schemas";
import { WorldService } from "../src/main/world";

async function setup() {
  const db = openDatabase(":memory:");
  const queue = new WriteQueue(), events: ControlEvent[] = [];
  const service = new WorldService({ db, queue, emit: (event) => events.push(ControlEvent.parse(event)), knownAgents: () => ["claude"] });
  await service.start();
  await service.reset({ type: "world.reset", worldId: null, requestId: `wact_${ulid()}`, confirm: true });
  const world = service.get().world!;
  const talk: CommandRequest<"world.talk"> = { type: "world.talk", worldId: world.id, generation: world.generation, actionId: `wact_${ulid()}`, agent: "claude" };
  const opened = await service.talk(talk);
  return { db, queue, service, events, talk, opened, stop: async () => { await service.stop(); db.close(); } };
}
function closeRequest(service: WorldService): CommandRequest<"world.scene.close"> {
  const { world, scene } = service.get();
  return { type: "world.scene.close", worldId: world!.id, generation: world!.generation, sceneId: scene!.id, actionId: `wact_${ulid()}` };
}

test("pause preserves a scene and resume publishes its rebound generation after the snapshot", async () => {
  const h = await setup();
  try {
    const { world, scene } = h.service.get();
    const choose: CommandRequest<"world.scene.choose"> = { type: "world.scene.choose", worldId: world!.id, generation: world!.generation, actionId: `wact_${ulid()}`, sceneId: scene!.id, optionId: scene!.options[0]!.id };
    await h.service.pause(world!.id);
    assert.deepEqual(h.service.get().scene, scene);
    assert.deepEqual(h.service.get().world!.generation, world!.generation);
    assert.deepEqual((await h.service.choose(choose)).result, { accepted: false, reason: "world_paused" });
    const index = h.events.length;
    await h.service.resume(world!.id);
    const resumed = h.service.get();
    assert.equal(resumed.world!.generation.runSeq, world!.generation.runSeq + 1);
    assert.deepEqual(resumed.scene, { ...scene, generation: resumed.world!.generation });
    assert.deepEqual(h.events.slice(index).map((event) => event.type), ["world.updated", "world.scene.updated"]);
    assert.deepEqual(await h.service.talk(h.talk), h.opened, "an old receipt keeps its original generation and options");
    assert.deepEqual(h.service.get().scene, resumed.scene, "replaying that receipt cannot overwrite the current scene");
    assert.deepEqual((await h.service.choose({ ...choose, actionId: `wact_${ulid()}` })).result, { accepted: false, reason: "stale_generation" });
    await h.service.resume(world!.id);
    assert.deepEqual(h.service.get().world!.generation, resumed.world!.generation, "resume while already running is not another generation");
  } finally { await h.stop(); }
});

test("closing while user-paused is allowed and resume cannot reopen that scene", async () => {
  const h = await setup();
  try {
    const id = h.service.get().world!.id;
    await h.service.pause(id);
    const request = closeRequest(h.service), result = await h.service.close(request);
    assert.equal(result.result.accepted, true);
    assert.equal(result.scene!.state, "closed");
    assert.equal(h.service.get().scene, null);
    await h.service.resume(id);
    assert.equal(h.service.get().scene, null);
    assert.deepEqual(await h.service.close(request), result);
    assert.equal(h.service.scenes(id, undefined, 10).items[0]!.id, request.sceneId);
  } finally { await h.stop(); }
});

test("maintenance blocks close and turns a waiting scene open exactly once after recovery", async () => {
  const h = await setup();
  try {
    const { world, scene } = h.service.get();
    const waiting: WorldScene = { ...scene!, state: "waiting", canType: true };
    await h.queue.run(() => {
      h.db.exec("BEGIN IMMEDIATE");
      new WorldStore(h.db).saveScene(world!.id, waiting);
      h.db.exec("COMMIT");
    });
    await assert.rejects(h.service.maintenance(async () => {
      assert.deepEqual(h.service.get().scene, waiting);
      assert.deepEqual((await h.service.close(closeRequest(h.service))).result, { accepted: false, reason: "world_paused" });
      throw new Error("backup failed");
    }), /backup failed/);
    const resumed = h.service.get().scene!;
    assert.equal(resumed.state, "open");
    assert.equal(resumed.lines.length, waiting.lines.length + 1);
    assert.deepEqual(resumed.lines.slice(0, -1), waiting.lines);
    assert.deepEqual(resumed.options, waiting.options);
    assert.deepEqual(resumed.past, waiting.past);
    assert.equal(resumed.lines.at(-1)!.source, "rule");
    assert.deepEqual(resumed.generation, h.service.get().world!.generation);
    await h.service.maintenance(async () => {});
    assert.deepEqual(h.service.get().scene!.lines, resumed.lines);
  } finally { await h.stop(); }
});

test("sleep preserves the scene and user pause; a new runtime session closes it", async () => {
  const h = await setup();
  try {
    const { world, scene } = h.service.get();
    await h.service.pause(world!.id);
    await h.service.suspend();
    await h.service.resumeFromSuspend();
    assert.deepEqual(h.service.get().scene, scene);
    assert.deepEqual(h.service.get().world!.run, { state: "paused", by: "user" });
    await h.service.resume(world!.id);
    await h.service.suspend();
    const generation = h.service.get().world!.generation;
    await h.service.resumeFromSuspend();
    assert.equal(h.service.get().scene!.id, scene!.id);
    assert.equal(h.service.get().world!.generation.runSeq, generation.runSeq + 1);
    assert.equal(h.service.get().world!.now, world!.now);
    await h.service.stop();
    const reopened = new WorldService({ db: h.db, queue: h.queue, emit: () => {}, knownAgents: () => ["claude"] });
    await reopened.start();
    assert.equal(reopened.get().scene, null);
    assert.equal(reopened.scenes(world!.id, undefined, 10).items[0]!.state, "closed");
    await reopened.stop();
  } finally { await h.stop(); }
});
