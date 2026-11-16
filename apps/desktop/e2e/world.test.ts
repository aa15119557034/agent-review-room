import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { openDatabase, ulid, WriteQueue } from "@room/db";
import {
  ControlEvent, WorldActionResult, WorldEventsPage, WorldResidentView, WorldSceneResult,
  WorldScenesPage, WorldSettings, WorldSnapshot, WorldState, type ControlResult,
} from "@room/schemas";
import { createDispatcher, type IpcDeps } from "../src/main/ipc";
import { WorldService } from "../src/main/world";

function stock(world: WorldSnapshot, id: string): number {
  const item = world.items.find((entry) => entry.id === id);
  assert.ok(item?.kind === "stock");
  return item.count;
}

test("SIGKILL of the actual world writer preserves a cooking activity and settles it once after recovery", { timeout: 15_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "room-world-crash-"));
  const dbPath = join(dir, "room.db");
  const child = spawn(process.execPath, [
    "--import", "tsx", fileURLToPath(new URL("./fixtures/world-crash-child.ts", import.meta.url)), dbPath,
  ], { cwd: fileURLToPath(new URL("../../..", import.meta.url)), windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let output = "";
  child.stdout!.on("data", (chunk: Buffer) => { output = (output + chunk.toString()).slice(-8_000); });
  child.stderr!.on("data", (chunk: Buffer) => { output = (output + chunk.toString()).slice(-8_000); });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  let db: ReturnType<typeof openDatabase> | undefined;
  let world: WorldService | undefined;
  try {
    const ready = await new Promise<{ pid: number; snapshot: WorldSnapshot }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`world child did not become ready: ${output}`)), 8_000);
      child.once("error", reject);
      child.once("message", (message: unknown) => {
        clearTimeout(timer);
        try {
          assert.ok(message !== null && typeof message === "object");
          const value = message as { type: unknown; pid: unknown; snapshot: unknown };
          assert.equal(value.type, "cooking");
          assert.equal(typeof value.pid, "number");
          resolve({ pid: value.pid as number, snapshot: WorldSnapshot.parse(value.snapshot) });
        } catch (error) { reject(error); }
      });
      void closed.then(({ code, signal }) => {
        clearTimeout(timer);
        reject(new Error(`world child exited before ready (${code}/${signal}): ${output}`));
      });
    });
    assert.equal(ready.pid, child.pid, "kill the SQLite writer, not a tsx wrapper process");
    assert.ok(statSync(dbPath + "-wal").size > 0, "the writer still owns an unclosed WAL");
    assert.equal(child.kill("SIGKILL"), true);
    const exit = await closed;
    assert.ok(exit.code !== 0 || exit.signal !== null, "the child must not shut down gracefully");
    t.diagnostic(`SIGKILL terminated SQLite writer PID ${ready.pid}; exit ${exit.code}/${exit.signal}`);

    db = openDatabase(dbPath);
    const queue = new WriteQueue();
    const makeWorld = () => new WorldService({
      db: db!, dbPath, queue, emit: (event) => { ControlEvent.parse(event); }, knownAgents: () => ["claude"],
      now: () => "2036-11-16T00:00:00.000Z",
    });
    world = makeWorld();
    await world.start();
    const saved = ready.snapshot;
    const recovered = WorldSnapshot.parse(world.get().world);
    assert.equal(recovered.id, saved.id);
    assert.notEqual(recovered.generation.session, saved.generation.session);
    assert.notEqual(recovered.asOf, saved.asOf);
    assert.equal(recovered.now, saved.now, "ten wall-clock years do not advance the simulation");
    assert.deepEqual(recovered.activities, saved.activities);
    assert.deepEqual(recovered.commitments, saved.commitments);
    assert.deepEqual(recovered.items, saved.items);
    const cooking = recovered.activities.find((activity) => activity.kind === "cook")!;
    const remainingMs = (cooking.endsAt - recovered.now) / recovered.minutesPerRealSecond * 1_000;
    assert.ok(remainingMs > 0 && remainingMs <= 5_000);
    await world.advance(remainingMs);
    const completed = WorldSnapshot.parse(world.get().world);
    assert.equal(completed.now, cooking.endsAt);
    assert.equal(completed.activities.some((activity) => activity.id === cooking.id), false);
    assert.equal(stock(completed, "ingredients"), stock(saved, "ingredients"), "the reserved ingredient is not consumed a second time");
    assert.equal(stock(completed, "meals"), stock(saved, "meals") + 4);
    const endings = () => world!.events(saved.id, undefined, 100).items.filter((event) => event.type === "activity_ended" && event.activity.id === cooking.id);
    assert.equal(endings().length, 1);
    const ending = endings()[0]!;
    assert.ok(ending.type === "activity_ended");
    assert.deepEqual(ending.produced, [{ itemId: "meals", count: 4 }]);
    assert.deepEqual(ending.consumed, [{ itemId: "ingredients", count: 1 }]);

    await world.stop();
    db.close();
    db = openDatabase(dbPath);
    world = makeWorld();
    await world.start();
    await world.advance(1_000);
    assert.equal(endings().length, 1, "reopening the completed activity cannot repeat its terminal event");
    assert.equal(stock(world.get().world!, "meals"), stock(saved, "meals") + 4);
    assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
    await world?.stop();
    db?.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

function unused<T>(name: string): T {
  return new Proxy({}, { get: (_target, property) => { throw new Error(`world dispatcher unexpectedly accessed ${name}.${String(property)}`); } }) as T;
}

async function dispatcherFixture() {
  const dir = mkdtempSync(join(tmpdir(), "room-world-dispatcher-"));
  const dbPath = join(dir, "room.db"), db = openDatabase(dbPath), queue = new WriteQueue();
  const events: ControlEvent[] = [];
  const emit = (event: ControlEvent) => { events.push(ControlEvent.parse(event)); };
  const world = new WorldService({ db, dbPath, queue, emit, knownAgents: () => ["claude", "codex"] });
  await world.start();
  const dispatcher = createDispatcher({
    world, emit, appVersion: "world-e2e", recoveredRuns: 0,
    repo: unused<IpcDeps["repo"]>("repo"), settings: unused<IpcDeps["settings"]>("settings"),
    orchestrator: unused<IpcDeps["orchestrator"]>("orchestrator"),
    discussion: unused<IpcDeps["discussion"]>("discussion"), nodes: unused<IpcDeps["nodes"]>("nodes"),
  });
  const data = (result: ControlResult<unknown>): unknown => {
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.ok(result.ok);
    return result.data;
  };
  return {
    db, world, events, dispatcher,
    command: async (request: unknown) => data(await dispatcher.handleCommand(request)),
    query: async (request: unknown) => data(await dispatcher.handleQuery(request)),
    close: async () => { await world.stop(); db.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test("world dispatcher serves the playable flow and keeps resident observations narrower than the global timeline", async () => {
  const h = await dispatcherFixture();
  try {
    assert.equal(WorldState.parse(await h.query({ type: "world.get" })).world, null);
    const started = WorldState.parse(await h.command({
      type: "world.reset", requestId: `wact_${ulid()}`, worldId: null, confirm: true,
      settings: { residents: ["claude", "codex"], dayRealMinutes: 4, dailyCognitionLimit: 0 },
    }));
    const id = started.world!.id;
    const base = () => ({ actionId: `wact_${ulid()}`, worldId: id, generation: h.world.get().world!.generation });
    const talked = WorldSceneResult.parse(await h.command({ type: "world.talk", ...base(), agent: "claude" }));
    assert.equal(talked.result.accepted, true);
    assert.ok(talked.scene);
    assert.equal(talked.scene.canType, false);
    const spoken = WorldSceneResult.parse(await h.command({ type: "world.scene.say", ...base(), sceneId: talked.scene.id, text: "你好" }));
    assert.deepEqual(spoken.result, { accepted: false, reason: "not_allowed" }, "routine-only mode does not fabricate model replies");
    const chosen = WorldSceneResult.parse(await h.command({ type: "world.scene.choose", ...base(), sceneId: talked.scene.id, optionId: "opt_watch" }));
    assert.equal(chosen.result.accepted, true);
    const closed = WorldSceneResult.parse(await h.command({ type: "world.scene.close", ...base(), sceneId: talked.scene.id }));
    assert.equal(closed.scene!.state, "closed");
    const history = WorldScenesPage.parse(await h.query({ type: "world.scenes", worldId: id }));
    assert.equal(history.items[0]!.id, talked.scene.id);

    const invited = WorldActionResult.parse(await h.command({ type: "world.act", ...base(), action: { type: "invite", to: { kind: "resident", agent: "claude" }, activity: "cook" } }));
    assert.equal(invited.accepted, true);
    await h.world.advance(1_000);
    const current = WorldState.parse(await h.query({ type: "world.get" }));
    assert.ok(current.world!.activities.some((activity) => activity.kind === "cook"));
    const cookView = WorldResidentView.parse(await h.query({ type: "world.residentView", worldId: id, agent: "claude" }));
    const otherView = WorldResidentView.parse(await h.query({ type: "world.residentView", worldId: id, agent: "codex" }));
    assert.ok(cookView.knownItems.some((item) => item.itemId === "pot"));
    assert.equal(otherView.knownItems.some((item) => item.itemId === "pot"), false);
    const full = WorldEventsPage.parse(await h.query({ type: "world.events", worldId: id }));
    const cookEvent = full.items.find((event) => event.type === "action" && event.action.type === "start" && event.action.activity === "cook");
    assert.ok(cookEvent);
    assert.ok(cookView.seen.some((event) => event.seq === cookEvent.seq));
    assert.equal(otherView.seen.some((event) => event.seq === cookEvent.seq), false);
    const page = WorldEventsPage.parse(await h.query({ type: "world.events", worldId: id, limit: 2 }));
    assert.equal(page.items.length, 2); assert.ok(page.nextBefore);
    const older = WorldEventsPage.parse(await h.query({ type: "world.events", worldId: id, limit: 2, before: page.nextBefore }));
    assert.ok(older.items.every((event) => event.seq < page.items.at(-1)!.seq));
    assert.equal(await h.query({ type: "world.review", worldId: id, day: 1 }), null);

    const paused = WorldSnapshot.parse(await h.command({ type: "world.pause", worldId: id }));
    assert.deepEqual(paused.run, { state: "paused", by: "user" });
    const cannotMove = WorldActionResult.parse(await h.command({ type: "world.act", ...base(), action: { type: "move", to: "kitchen" } }));
    assert.deepEqual(cannotMove, { accepted: false, reason: "world_paused" });
    assert.equal(WorldSnapshot.parse(await h.command({ type: "world.resume", worldId: id })).run.state, "running");
    const settings = WorldSettings.parse(await h.command({ type: "world.settings.save", settings: { dayRealMinutes: 8, dailyCognitionLimit: 0 } }));
    assert.equal(settings.dayRealMinutes, 8);
    assert.deepEqual(settings.residents, ["claude", "codex"]);
    assert.ok(h.events.some((event) => event.type === "world.event"));
    assert.ok(h.events.some((event) => event.type === "world.scene.updated"));
  } finally { await h.close(); }
});

test("world dispatcher rejects malformed or privileged renderer input before writing and maps missing resident views", async () => {
  const h = await dispatcherFixture();
  try {
    const created = WorldState.parse(await h.command({
      type: "world.reset", requestId: `wact_${ulid()}`, worldId: null, confirm: true,
      settings: { residents: ["claude"], dayRealMinutes: 4, dailyCognitionLimit: 0 },
    }));
    const before = created.world!;
    const base = { actionId: `wact_${ulid()}`, worldId: before.id, generation: before.generation };
    const changes = () => (h.db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
    const beforeChanges = changes();
    for (const command of [
      { type: "world.act", ...base, actor: { kind: "resident", agent: "claude" }, action: { type: "move", to: "kitchen" } },
      { type: "world.act", ...base, action: { type: "start", activity: "cook", itemId: "pot" } },
      { type: "world.act", actionId: base.actionId, worldId: before.id, action: { type: "move", to: "kitchen" } },
      { type: "world.reset", requestId: `wact_${ulid()}`, worldId: before.id, confirm: false },
      { type: "world.settings.save", settings: { dayRealMinutes: 8, dailyCognitionLimit: 0, residents: ["codex"] } },
    ]) {
      const result = await h.dispatcher.handleCommand(command);
      assert.equal(result.ok, false); assert.ok(!result.ok); assert.equal(result.error, "validation_failed");
    }
    for (const query of [
      { type: "world.events", worldId: before.id, limit: 101 },
      { type: "world.residentView", worldId: before.id },
      { type: "world.get", includeSecrets: true },
    ]) {
      const result = await h.dispatcher.handleQuery(query);
      assert.equal(result.ok, false); assert.ok(!result.ok); assert.equal(result.error, "validation_failed");
    }
    assert.equal(changes(), beforeChanges, "invalid IPC inputs never enter the writer");
    const missing = await h.dispatcher.handleQuery({ type: "world.residentView", worldId: before.id, agent: "codex" });
    assert.equal(missing.ok, false); assert.ok(!missing.ok); assert.equal(missing.error, "not_found");
    assert.deepEqual(WorldState.parse(await h.query({ type: "world.get" })).world, before);
  } finally { await h.close(); }
});
