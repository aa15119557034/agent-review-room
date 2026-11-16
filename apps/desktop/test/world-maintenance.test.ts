import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, WriteQueue, ulid } from "@room/db";
import { WorkspaceService, type WorkspaceServiceDeps } from "../src/main/workspace";

function fixture(overrides: Partial<WorkspaceServiceDeps> = {}) {
  const root = mkdtempSync(join(tmpdir(), "room-world-maintenance-"));
  const data = join(root, "data"), out = join(root, "out");
  mkdirSync(data); mkdirSync(out);
  const db = openDatabase(join(data, "room.db")), queue = new WriteQueue();
  const deps: WorkspaceServiceDeps = {
    db, queue, userData: data, version: "test", revision: "test", checks: async () => [],
    chooseDirectory: async () => out, chooseSaveFile: async () => null,
    ...overrides,
  };
  return { db, queue, data, out, deps, service: new WorkspaceService(deps), close: () => { db.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("backup enters world maintenance outside the write queue and snapshots preceding writes", { timeout: 5_000 }, async () => {
  const f = fixture();
  try {
    const project = "proj_" + ulid();
    f.db.prepare("INSERT INTO projects(id,name,created_at) VALUES(?,?,?)").run(project, "before", "2026-11-16T00:00:00.000Z");
    let entered = false, finished = false;
    const service = new WorkspaceService({
      ...f.deps,
      withWorldMaintenance: async (work) => {
        entered = true;
        await f.queue.run(() => { f.db.prepare("UPDATE projects SET name='last accepted world write' WHERE id=?").run(project); });
        try { return await work(); } finally { finished = true; }
      },
    });
    const result = await service.backup();
    assert.equal(entered, true); assert.equal(finished, true); assert.ok(result.path);
    const copy = openDatabase(join(result.path, "room.db"), { readonly: true });
    try { assert.equal((copy.prepare("SELECT name FROM projects WHERE id=?").get(project) as { name: string }).name, "last accepted world write"); }
    finally { copy.close(); }
  } finally { f.close(); }
});

test("backup failure leaves maintenance through its finally and never publishes a partial copy", async () => {
  const f = fixture();
  try {
    f.db.prepare("INSERT INTO files(ref,sha256,name,mime,bytes,is_text,created_at) VALUES(?,?,?,'text/plain',1,1,?)")
      .run("file_" + ulid(), "b".repeat(64), "missing.txt", "2026-11-16T00:00:00.000Z");
    const calls: string[] = [];
    const service = new WorkspaceService({ ...f.deps, withWorldMaintenance: async (work) => {
      calls.push("pause"); try { return await work(); } finally { calls.push("restore intent"); }
    } });
    await assert.rejects(service.backup());
    assert.deepEqual(calls, ["pause", "restore intent"]);
    assert.deepEqual(readdirSync(f.out), []);
  } finally { f.close(); }
});

test("cancelling a chooser or declining a switch never pauses or stops the world", async () => {
  const f = fixture();
  try {
    let maintenance = 0, switches = 0, activations = 0;
    const service = new WorkspaceService({
      ...f.deps, chooseDirectory: async () => null, confirmSwitch: async () => false,
      activateDirectory: () => { activations++; },
      withWorldMaintenance: async (work) => { maintenance++; return work(); },
      withWorldSwitch: async (work) => { switches++; return work(); },
    });
    assert.equal((await service.backup()).cancelled, true);
    assert.equal((await service.openRestored()).cancelled, true);
    assert.equal((await service.openRestored(true)).cancelled, true);
    assert.deepEqual([maintenance, switches, activations], [0, 0, 0]);
  } finally { f.close(); }
});

test("a directory switch runs inside the world switch barrier and stops only after activation succeeds", { timeout: 5_000 }, async () => {
  const f = fixture();
  try {
    const calls: string[] = [];
    let fail = true;
    const service = new WorkspaceService({
      ...f.deps, confirmSwitch: async () => true,
      activateDirectory: () => { calls.push("activate"); if (fail) throw new Error("cannot save active directory"); },
      withWorldSwitch: async (work) => {
        calls.push("close admission");
        await f.queue.drain();
        try { const result = await work(); calls.push("stop old runtime"); return result; }
        catch (error) { calls.push("restore intent"); throw error; }
      },
    });
    await assert.rejects(service.openRestored(true), /cannot save/);
    assert.deepEqual(calls, ["close admission", "activate", "restore intent"]);
    calls.length = 0; fail = false;
    assert.equal((await service.openRestored(true)).cancelled, false);
    assert.deepEqual(calls, ["close admission", "activate", "stop old runtime"]);
  } finally { f.close(); }
});
