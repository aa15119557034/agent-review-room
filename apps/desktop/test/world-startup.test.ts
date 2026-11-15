import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { acquireWorldLock, createConversation, openDatabase, ulid, WriteQueue } from "@room/db";
import type { ControlEvent, WorldSnapshot } from "@room/schemas";
import { WorldError, WorldService } from "../src/main/world";
import { WorkspaceService, verifyWorkspaceBackup } from "../src/main/workspace";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "room-world-startup-"));
  const data = join(root, "data"), out = join(root, "out"), dbPath = join(data, "room.db");
  mkdirSync(data); mkdirSync(out);
  const db = openDatabase(dbPath), queue = new WriteQueue(), events: ControlEvent[] = [];
  const services: WorldService[] = [];
  const make = (knownAgents = () => ["claude"]) => {
    const service = new WorldService({ db, queue, dbPath, knownAgents, emit: (event) => events.push(event) });
    services.push(service);
    return service;
  };
  const dirs: string[] = [];
  let activated: string | null | undefined;
  // Failed startup installs no world callbacks in bootstrap: exercise the
  // workspace's own real queue/idle checks and snapshot implementation.
  const workspace = new WorkspaceService({
    db, queue, userData: data, version: "test", revision: "test", checks: async () => [],
    chooseDirectory: async () => dirs.shift() ?? null, chooseSaveFile: async () => null,
    confirmSwitch: async () => true, activateDirectory: (target) => { activated = target; },
  });
  return {
    db, queue, dbPath, out, events, make, workspace, dirs, get activated() { return activated; },
    close: async () => { for (const service of services) await service.stop(); db.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

async function seed(service: WorldService): Promise<WorldSnapshot> {
  await service.start();
  return (await service.reset({ type: "world.reset", requestId: `wact_${ulid()}`, worldId: null, confirm: true })).world!;
}

async function startupFailure(service: WorldService): Promise<WorldError> {
  let failure: unknown;
  try { await service.start(); } catch (error) { failure = error; }
  assert.ok(failure instanceof WorldError);
  assert.equal(failure.code, "invalid_state");
  assert.match(failure.message, /世界启动失败/);
  assert.ok(failure.cause instanceof Error, "retain the actual startup failure for diagnosis");
  return failure;
}

async function assertUnavailable(service: WorldService, failure: WorldError, world: WorldSnapshot) {
  const sameFailure = (error: unknown) => error === failure;
  for (const read of [
    () => service.get(), () => service.residentView(world.id, "claude"),
    () => service.events(world.id, undefined, 10), () => service.scenes(world.id, undefined, 10), () => service.review(world.id, 1),
  ]) assert.throws(read, sameFailure);
  const base = { worldId: world.id, generation: world.generation, actionId: `wact_${ulid()}` };
  const sceneId = `wscn_${ulid()}`;
  const writes: (() => Promise<unknown>)[] = [
    () => service.start(),
    () => service.reset({ type: "world.reset", requestId: `wact_${ulid()}`, worldId: world.id, confirm: true }),
    () => service.saveSettings({ type: "world.settings.save", settings: { dayRealMinutes: 4, dailyCognitionLimit: 0 } }),
    () => service.act({ type: "world.act", ...base, action: { type: "stop" } }),
    () => service.talk({ type: "world.talk", ...base, agent: "claude" }),
    () => service.choose({ type: "world.scene.choose", ...base, sceneId, optionId: "opt_watch" }),
    () => service.say({ type: "world.scene.say", ...base, sceneId, text: "hello" }),
    () => service.close({ type: "world.scene.close", ...base, sceneId }),
    () => service.pause(world.id), () => service.resume(world.id), () => service.advance(1000),
    () => service.suspend(), () => service.resumeFromSuspend(),
    () => service.maintenance(async () => { assert.fail("unavailable world must not run a maintenance callback"); }),
    () => service.beginSwitch(async () => { assert.fail("unavailable world must not run a switch callback"); }),
  ];
  for (const write of writes) await assert.rejects(write(), sameFailure);
}

test("a competing world lock leaves the owner untouched and keeps chat storage and workspace backup available", async () => {
  const h = fixture();
  const secondDb = openDatabase(h.dbPath), secondQueue = new WriteQueue();
  const contender = new WorldService({ db: secondDb, queue: secondQueue, dbPath: h.dbPath, knownAgents: () => ["claude"], emit: () => assert.fail("failed world published an event") });
  try {
    const owner = h.make(), world = await seed(owner), before = owner.get(), count = h.events.length;
    const failure = await startupFailure(contender);
    assert.match((failure.cause as Error).message, /locked/);
    await assertUnavailable(contender, failure, world);
    await contender.stop();
    assert.throws(() => acquireWorldLock(h.dbPath), /locked/, "failed service cannot release the owner's lock");
    assert.deepEqual(owner.get(), before);
    assert.equal(h.events.length, count);
    const conversation = await createConversation(secondDb, secondQueue, { members: { kind: "direct", agent: "claude" }, title: null });
    assert.equal(conversation.kind, "direct");
    h.dirs.push(h.out);
    const backup = await h.workspace.backup();
    assert.ok(backup.path);
    verifyWorkspaceBackup(backup.path);
    const copy = openDatabase(join(backup.path, "room.db"), { readonly: true });
    try {
      assert.equal((copy.prepare("SELECT id FROM conversations").get() as { id: string }).id, conversation.id);
      const row = copy.prepare("SELECT current_json FROM worlds WHERE id=?").get(world.id) as { current_json: string };
      assert.deepEqual(JSON.parse(row.current_json).run, { state: "running" }, "backup does not pretend to pause the other scheduler");
    } finally { copy.close(); }
    assert.deepEqual(owner.get(), before);
    assert.equal((await h.workspace.openRestored(true)).cancelled, false);
    assert.equal(h.activated, null);
    assert.throws(() => acquireWorldLock(h.dbPath), /locked/);
  } finally { await contender.stop(); secondDb.close(); await h.close(); }
});

test("invalid saved world data stays an explicit failure while rollback releases its lock and workspace recovery remains usable", async () => {
  const h = fixture();
  try {
    const original = h.make(), world = await seed(original);
    await original.stop();
    const saved = (h.db.prepare("SELECT current_json FROM worlds WHERE id=?").get(world.id) as { current_json: string }).current_json;
    const corrupt = JSON.stringify({ now: "invalid stored state" });
    h.db.prepare("UPDATE worlds SET current_json=? WHERE id=?").run(corrupt, world.id);
    const failed = h.make(), count = h.events.length;
    const failure = await startupFailure(failed);
    assert.equal((failure.cause as Error).name, "ZodError");
    assert.equal(h.db.inTransaction, false);
    const release = acquireWorldLock(h.dbPath); release();
    await assertUnavailable(failed, failure, world);
    assert.equal(h.events.length, count);
    assert.equal((h.db.prepare("SELECT current_json FROM worlds WHERE id=?").get(world.id) as { current_json: string }).current_json, corrupt);
    const conversation = await createConversation(h.db, h.queue, { members: { kind: "direct", agent: "claude" }, title: null });
    assert.equal(conversation.kind, "direct", "failed startup must leave the shared DB queue usable");
    h.dirs.push(h.out);
    const backup = await h.workspace.backup();
    assert.ok(backup.path);
    h.dirs.push(backup.path, h.out);
    const restored = await h.workspace.restore();
    assert.ok(restored.path);
    const copy = openDatabase(join(restored.path, "room.db"), { readonly: true });
    try {
      assert.equal((copy.prepare("SELECT current_json FROM worlds WHERE id=?").get(world.id) as { current_json: string }).current_json, corrupt, "backup preserves damaged world data rather than silently resetting it");
    } finally { copy.close(); }
    h.dirs.push(restored.path);
    assert.equal((await h.workspace.openRestored()).cancelled, false);
    assert.equal(h.activated, restored.path);
    h.db.prepare("UPDATE worlds SET current_json=? WHERE id=?").run(saved, world.id);
    assert.throws(() => failed.get(), (error) => error === failure, "this failed instance never resumes implicitly");
    const replacement = h.make();
    await replacement.start();
    assert.equal(replacement.get().world!.id, world.id);
  } finally { await h.close(); }
});

test("an empty database starts without consulting residents; skipping startup remains distinct from startup failure", async () => {
  const h = fixture();
  try {
    const unstarted = h.make();
    assert.throws(() => unstarted.get(), /尚未启动/);
    await unstarted.stop();
    const empty = h.make(() => []);
    await empty.start();
    assert.throws(() => empty.get(), /请先配置至少一位秘书/, "preserve the existing zero-resident behavior, not a startup-failed state");
  } finally { await h.close(); }
});
