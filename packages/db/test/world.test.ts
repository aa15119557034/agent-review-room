import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { WorldScene, WorldSnapshot, type WorldEvent, type WorldSettings } from "@room/schemas";
import { acquireWorldLock, currentVersion, MIGRATIONS, openDatabase, ulid, WorldStore, WriteQueue, writeTransaction } from "../src/index";

const settings: WorldSettings = { residents: ["claude", "codex"], dayRealMinutes: 24, dailyCognitionLimit: 60 };
const generation = { session: "wses_" + ulid(), runSeq: 0 };
const now = "2026-11-16T00:00:00.000Z";

function initial(): WorldSnapshot {
  return WorldSnapshot.parse({
    id: "world_" + ulid(), generation, rulesVersion: "test-v1", run: { state: "running" },
    now: 0, asOf: now, minutesPerRealSecond: 1, lastSeq: 0,
    places: [{ id: "living_room", label: "Living room", neighbors: [], owner: null }],
    residents: settings.residents.map((agent) => ({ agent, placeId: "living_room", energy: 100, satiety: 100, mood: 50, activityId: null, cognition: { mode: "routine", reason: "offline" } })),
    player: { placeId: "living_room", activityId: null }, items: [], activities: [], commitments: [], sceneId: null,
  });
}

function fixture(t: TestContext) {
  const parent = realpathSync.native(tmpdir());
  const dir = mkdtempSync(join(parent, "room-world-test-"));
  const path = join(dir, "room.db");
  const db = openDatabase(path);
  const store = new WorldStore(db, generation);
  const queue = new WriteQueue();
  t.after(() => {
    if (db.open) db.close();
    assert.equal(dirname(resolve(dir)), parent);
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return { db, store, queue, path, dir };
}

function said(seq: number, text = "Hello"): WorldEvent {
  return { type: "said", seq, at: seq, placeId: "living_room", speaker: { kind: "resident", agent: "claude" }, text, sceneId: null };
}

function scene(state: "open" | "closed" = "closed"): WorldScene {
  return WorldScene.parse({
    id: "wscn_" + ulid(), generation, origin: { kind: "player", agent: "claude" }, placeId: "living_room",
    residents: ["claude"], lines: [], options: [], past: [], canType: false, state, openedAt: 1, createdAt: now,
  });
}

test("v26 migration adds world storage without changing existing records", (t) => {
  const { db, path } = fixture(t);
  db.close();
  // Build a real v26 database independently instead of resetting user_version on a v27 schema.
  rmSync(path);
  const old = new Database(path);
  old.pragma("foreign_keys = ON");
  for (const migration of MIGRATIONS.filter((m) => m.version <= 26)) {
    if (migration.disableForeignKeys) old.pragma("foreign_keys = OFF");
    old.transaction(() => { migration.up(old); old.pragma("user_version = " + migration.version); })();
    old.pragma("foreign_keys = ON");
  }
  old.prepare("INSERT INTO projects(id, name, created_at) VALUES (?, ?, ?)").run("proj_world_legacy", "Keep me", now);
  old.close();
  const migrated = openDatabase(path);
  try {
    assert.equal(currentVersion(migrated), 27);
    assert.equal((migrated.prepare("SELECT name FROM projects WHERE id = ?").get("proj_world_legacy") as { name: string }).name, "Keep me");
    assert.equal(new WorldStore(migrated).load(), null);
    assert.deepEqual(migrated.pragma("foreign_key_check"), []);
    assert.ok(existsSync(path + ".bak-v26"));
  } finally { migrated.close(); }
});

test("rollback covers state, history, observations, views and the replay receipt", async (t) => {
  const { db, store, queue } = fixture(t);
  const world = initial();
  await writeTransaction(db, queue, () => store.create(world, settings));
  const requestId = "wact_" + ulid();
  const view = { agent: "codex", worldId: world.id, knownItems: [], seen: [], heard: [{ seq: 1, at: 1, speaker: { kind: "resident" as const, agent: "claude" }, text: "Hello" }] };
  await assert.rejects(writeTransaction(db, queue, () => {
    store.save({ ...world, now: 1, lastSeq: 1 });
    store.append(world.id, [said(1)], [{ observer: "codex", seq: 1, at: 1, mode: "heard" }], [view]);
    store.putReceipt(requestId, "request", { accepted: true, seq: 1 });
    throw new Error("injected commit failure");
  }), /injected commit failure/);
  assert.deepEqual(store.load()!.world, world);
  assert.deepEqual(store.events(world.id).items, []);
  assert.equal(store.view(world.id, "codex"), null);
  assert.equal(store.getReceipt(requestId), null);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM world_observations").get() as { n: number }).n, 0);
  assert.throws(() => store.save(world), /require a transaction/);
});

test("reset preserves old history and exact receipts, while sessions are not persisted", async (t) => {
  const { db, store, queue } = fixture(t);
  const first = initial(), second = initial(), requestId = "wact_" + ulid();
  const originalResult = { world: first, scene: null, settings, budgets: [] };
  await writeTransaction(db, queue, () => {
    store.create(first, settings);
    store.append(first.id, [said(1)], [], []);
    store.save({ ...first, lastSeq: 1 });
    store.putReceipt(requestId, "first reset request", originalResult);
    store.create(second, settings);
  });
  const freshGeneration = { session: "wses_" + ulid(), runSeq: 3 };
  assert.equal(store.load(freshGeneration)!.world.id, second.id);
  assert.deepEqual(store.load(freshGeneration)!.world.generation, freshGeneration);
  assert.deepEqual(store.getReceipt(requestId), { request: "first reset request", result: originalResult });
  assert.equal(store.events(first.id).items[0]!.seq, 1);
  assert.throws(() => db.transaction(() => store.putReceipt(requestId, "different", null))(), /UNIQUE/);
  const json = db.prepare("SELECT initial_json, current_json FROM worlds WHERE id = ?").get(first.id) as { initial_json: string; current_json: string };
  assert.equal("generation" in JSON.parse(json.initial_json), false);
  assert.equal("generation" in JSON.parse(json.current_json), false);
  const reopened = new WorldStore(db);
  assert.notEqual(reopened.load()!.world.generation.session, generation.session);
});

test("event sequences are continuous and one activity cannot settle twice", async (t) => {
  const { db, store, queue } = fixture(t);
  const world = initial();
  await writeTransaction(db, queue, () => store.create(world, settings));
  await assert.rejects(writeTransaction(db, queue, () => store.append(world.id, [said(2)], [], [])), /contiguous/);
  const ended: WorldEvent = {
    type: "activity_ended", seq: 1, at: 20, placeId: "living_room",
    activity: { id: "wavt_" + ulid(), kind: "rest", participants: [{ kind: "resident", agent: "claude" }], placeId: "living_room", itemIds: [], startedAt: 0, endsAt: 20, state: "completed", endReason: "done" },
    produced: [], consumed: [],
  };
  await writeTransaction(db, queue, () => store.append(world.id, [ended], [], []));
  await assert.rejects(writeTransaction(db, queue, () => store.append(world.id, [{ ...ended, seq: 2 }], [], [])), /UNIQUE/);
  assert.throws(() => db.prepare("UPDATE world_events SET seq = 10").run(), /immutable/);
  await assert.rejects(writeTransaction(db, queue, () => store.append(world.id, [], [{ observer: "codex", seq: 1, at: 20, mode: "heard" }], [])), /said event/);
  assert.deepEqual(store.events(world.id).items, [ended]);
});

test("observed history is chronological and isolated by resident and world beyond the recent view", async (t) => {
  const { db, store, queue } = fixture(t);
  const world = initial(), other = initial();
  const events = Array.from({ length: 103 }, (_, index) => said(index + 1));
  const observations = events.filter((event) => event.seq !== 2).map((event) => ({ observer: "codex", seq: event.seq, at: event.at, mode: "heard" as const }));
  await writeTransaction(db, queue, () => {
    store.create(world, settings);
    store.append(world.id, events, [...observations, { observer: "claude", seq: 2, at: 2, mode: "heard" }], [
      { agent: "codex", worldId: world.id, knownItems: [], seen: [], heard: [] },
    ]);
    store.create(other, settings);
    store.append(other.id, [said(1, "Other world")], [{ observer: "codex", seq: 1, at: 1, mode: "heard" }], []);
  });
  assert.deepEqual(store.observedEvents(world.id, "codex"), events.filter((event) => event.seq !== 2));
  assert.deepEqual(store.observedEvents(world.id, "claude"), [events[1]]);
  assert.deepEqual(store.observedEvents(other.id, "codex"), [said(1, "Other world")]);
  assert.deepEqual(store.observedEvents(other.id, "claude"), []);
  await assert.rejects(writeTransaction(db, queue, () => {
    store.append(world.id, [said(104, "Rolled back")], [{ observer: "codex", seq: 104, at: 104, mode: "heard" }], []);
    throw new Error("observation rollback");
  }), /observation rollback/);
  assert.equal(store.observedEvents(world.id, "codex").at(-1)!.seq, 103);
});

test("keyset pagination has no overlap and scenes/reviews survive reopening", async (t) => {
  const { db, store, queue, path } = fixture(t);
  const world = initial();
  const closed = [scene(), scene(), scene()], open = scene("open");
  const review = { day: 1, items: [{ seqs: [1, 2], text: "Two greetings", source: "rule" as const }] };
  await writeTransaction(db, queue, () => {
    store.create(world, settings);
    store.append(world.id, [said(1), said(2), said(3)], [], []);
    for (const entry of [...closed, open]) store.saveScene(world.id, entry);
    store.saveReview(world.id, review);
  });
  const page = store.events(world.id, undefined, 2);
  assert.deepEqual(page.items.map((e) => e.seq), [3, 2]);
  assert.equal(page.nextBefore, 2);
  assert.deepEqual(store.events(world.id, page.nextBefore!, 2).items.map((e) => e.seq), [1]);
  assert.equal(store.events(world.id, 2, 2).nextBefore, null);
  const scenes = store.scenes(world.id, undefined, 2);
  assert.deepEqual(scenes.items.map((s) => s.id), closed.slice().reverse().slice(0, 2).map((s) => s.id));
  assert.deepEqual(store.scenes(world.id, scenes.nextBefore!, 2).items.map((s) => s.id), [closed[0]!.id]);
  assert.equal(store.getScene(world.id, open.id)!.state, "open");
  db.close();
  const reopened = openDatabase(path);
  try {
    assert.deepEqual(new WorldStore(reopened).review(world.id, 1), review);
    assert.deepEqual(new WorldStore(reopened).getScene(world.id, closed[0]!.id), closed[0]);
  } finally { reopened.close(); }
});

test("invalid stored JSON shapes fail visibly instead of returning empty state", async (t) => {
  const { db, store, queue } = fixture(t);
  await writeTransaction(db, queue, () => store.create(initial(), settings));
  db.prepare("UPDATE worlds SET current_json = '{}' WHERE id = ?").run(store.load()!.world.id);
  assert.throws(() => store.load());
  db.prepare("UPDATE world_settings SET settings_json = '{\"dailyCognitionLimit\":\"broken\"}'").run();
  assert.throws(() => store.settings());
});

test("scheduler lock rejects duplicate connections and aliases but does not lock room.db writes or backups", (t) => {
  const { db, path, dir } = fixture(t);
  const release = acquireWorldLock(path);
  t.after(release);
  assert.throws(() => acquireWorldLock(path), /locked/);
  const competingConnection = new Database(path + ".world-lock.sqlite", { timeout: 0 });
  try { assert.throws(() => competingConnection.exec("BEGIN EXCLUSIVE"), /locked/); }
  finally { competingConnection.close(); }
  const alias = join(dir, "alias");
  symlinkSync(dir, alias, "junction");
  assert.throws(() => acquireWorldLock(join(alias, "room.db")), /locked/);
  db.prepare("INSERT INTO projects(id, name, created_at) VALUES (?, ?, ?)").run("proj_during_lock", "Writing still works", now);
  const backup = join(dir, "copy.db");
  db.prepare("VACUUM INTO ?").run(backup);
  const releaseCopy = acquireWorldLock(backup);
  releaseCopy();
  release();
  release();
  const again = acquireWorldLock(path);
  again();
  assert.ok(readdirSync(dir).includes("room.db.world-lock.sqlite"));
});

test("a real crashed process releases its scheduler lock without deleting the lock database", { timeout: 15_000 }, async (t) => {
  const { path } = fixture(t);
  const moduleUrl = new URL("../src/world.ts", import.meta.url).href;
  const source = `import { acquireWorldLock } from ${JSON.stringify(moduleUrl)}; const release = acquireWorldLock(${JSON.stringify(path)}); process.on('exit', release); process.stdout.write('LOCKED\\n'); setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
    cwd: fileURLToPath(new URL("../../..", import.meta.url)), windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr!.on("data", (chunk) => { stderr += String(chunk); });
  try {
    await new Promise<void>((resolveReady, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("child lock timeout: " + stderr)); }, 10_000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error("child exited before lock: " + code + " " + stderr)); });
    child.stdout!.once("data", (chunk) => {
      clearTimeout(timer);
      if (String(chunk).includes("LOCKED")) resolveReady(); else reject(new Error("unexpected child output"));
    });
    });
    assert.throws(() => { const unexpected = acquireWorldLock(path); unexpected(); }, /locked/);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
  }
  const release = acquireWorldLock(path);
  release();
  assert.ok(existsSync(path + ".world-lock.sqlite"));
});
