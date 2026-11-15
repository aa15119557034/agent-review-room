import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { openDatabase, ulid, WorldBudgetStore } from "../src/index";

const runId = () => "run_" + ulid();
const sceneId = () => "wscn_" + ulid();
const now = new Date(2026, 10, 16, 12, 0, 0);

function fixture(t: TestContext) {
  const parent = realpathSync.native(tmpdir());
  const dir = mkdtempSync(join(parent, "room-world-budget-"));
  const path = join(dir, "world-usage.sqlite");
  const store = new WorldBudgetStore(path);
  t.after(() => {
    store.close();
    assert.equal(dirname(resolve(dir)), parent);
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return { store, path, dir };
}

test("daily budget reserves before dispatch, preserves use after lower limits and reopens", (t) => {
  const { store, path } = fixture(t);
  assert.deepEqual(store.reserve({ runId: runId(), agent: "claude", limit: 0, now }), {
    accepted: false, budget: store.get("claude", 0, now), reason: "budget",
  });
  assert.equal(store.reserve({ runId: runId(), agent: "claude", limit: 2, now }).budget.used, 1);
  assert.equal(store.reserve({ runId: runId(), agent: "claude", limit: 2, now }).budget.used, 2);
  assert.equal(store.reserve({ runId: runId(), agent: "claude", limit: 2, now }).accepted, false);
  assert.equal(store.get("claude", 0, now).used, 2);
  assert.equal(store.get("codex", 2, now).used, 0);
  store.close();
  const reopened = new WorldBudgetStore(path);
  try {
    assert.equal(reopened.get("claude", 2, now).used, 2);
    assert.equal(reopened.reserve({ runId: runId(), agent: "claude", limit: 2, now }).reason, "budget");
  } finally { reopened.close(); }
});

test("Run retransmission is idempotent across limits and days but cannot change agent or scene", (t) => {
  const { store } = fixture(t);
  const id = runId(), scene = sceneId();
  assert.equal(store.reserve({ runId: id, agent: "claude", sceneId: scene, limit: 1, now }).accepted, true);
  assert.equal(store.reserve({ runId: id, agent: "claude", sceneId: scene, limit: 0, now }).accepted, true);
  assert.equal(store.get("claude", 1, now).used, 1);
  const tomorrow = new Date(2026, 10, 17, 0, 1);
  const replay = store.reserve({ runId: id, agent: "claude", sceneId: scene, limit: 1, now: tomorrow });
  assert.equal(replay.accepted, true);
  assert.equal(replay.budget.used, 0);
  assert.equal(store.get("claude", 1, now).used, 1);
  assert.throws(() => store.reserve({ runId: id, agent: "codex", sceneId: scene, limit: 1, now }), /another agent or scene/);
  assert.throws(() => store.reserve({ runId: id, agent: "claude", sceneId: sceneId(), limit: 1, now }), /another agent or scene/);
  assert.throws(() => store.reserve({ runId: id, agent: "claude", limit: 1, now }), /another agent or scene/);
  const noScene = runId();
  assert.equal(store.reserve({ runId: noScene, agent: "codex", limit: 1, now }).accepted, true);
  assert.equal(store.reserve({ runId: noScene, agent: "codex", sceneId: null, limit: 0, now }).budget.used, 1);
});

test("one scene allows eight starts across residents and days, including failed and cancelled Runs", (t) => {
  const { store } = fixture(t);
  const scene = sceneId();
  const requests = Array.from({ length: 8 }, (_, index) => ({
    runId: runId(), agent: index % 2 === 0 ? "claude" : "codex", sceneId: scene,
    limit: 20, now: new Date(2026, 10, 16 + Math.floor(index / 4), 12),
  }));
  // No completion callback/refund exists: cancellation or invalid replies leave reservations intact.
  for (const request of requests) assert.equal(store.reserve(request).accepted, true);
  const denied = store.reserve({ runId: runId(), agent: "claude", sceneId: scene, limit: 20, now });
  assert.equal(denied.reason, "scene");
  assert.equal(denied.budget.used, 2);
  assert.equal(store.reserve(requests[0]!).accepted, true);
  assert.equal(store.reserve({ runId: runId(), agent: "claude", sceneId: sceneId(), limit: 20, now }).accepted, true);
});

test("usage follows local calendar dates and next local midnight, not world time or rolling 24 hours", (t) => {
  const { store } = fixture(t);
  const late = new Date(2026, 10, 16, 23, 59, 59, 999);
  const midnight = new Date(2026, 10, 17, 0, 0, 0, 0);
  const before = store.reserve({ runId: runId(), agent: "claude", limit: 1, now: late });
  assert.equal(before.budget.day, "2026-11-16");
  assert.equal(before.budget.resetsAt, midnight.toISOString());
  const after = store.reserve({ runId: runId(), agent: "claude", limit: 1, now: midnight });
  assert.equal(after.accepted, true);
  assert.equal(after.budget.day, "2026-11-17");
  assert.equal(after.budget.resetsAt, new Date(2026, 10, 18, 0, 0).toISOString());
  // Moving the clock back selects retained history, it does not clear that day's use.
  assert.equal(store.reserve({ runId: runId(), agent: "claude", limit: 1, now: late }).reason, "budget");
  assert.throws(() => store.get("claude", 1, new Date(NaN)), /invalid world budget date/);
});

test("local midnight accounts for 23-hour and 25-hour days without changing the parent clock", { timeout: 15_000 }, async (t) => {
  const { dir } = fixture(t);
  const moduleUrl = new URL("../src/world-budget.ts", import.meta.url).href;
  const source = `import assert from 'node:assert/strict';
    import { WorldBudgetStore } from ${JSON.stringify(moduleUrl)};
    const store = new WorldBudgetStore(${JSON.stringify(join(dir, "dst-usage.sqlite"))});
    try {
      for (const [month,day,hours] of [[2,8,23],[10,1,25]]) {
        const midnight = new Date(2026,month,day);
        const budget = store.get('claude',1,midnight);
        assert.equal((Date.parse(budget.resetsAt)-midnight.getTime())/3600000,hours);
        assert.equal(budget.resetsAt,new Date(2026,month,day+1).toISOString());
      }
    } finally { store.close(); }`;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
    cwd: fileURLToPath(new URL("../../..", import.meta.url)), windowsHide: true,
    env: { ...process.env, TZ: "America/New_York" }, stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stdout!.resume(); child.stderr!.on("data", (chunk) => { stderr += String(chunk); });
  const [code] = await once(child, "exit");
  assert.equal(code, 0, stderr);
});

test("a ledger write failure rolls back the reservation and throws before permission to dispatch", (t) => {
  const { store, path } = fixture(t);
  const inspector = new Database(path);
  const id = runId();
  try {
    inspector.exec("CREATE TRIGGER reject_budget_write AFTER INSERT ON world_cognition_reservations BEGIN SELECT RAISE(ABORT, 'injected ledger failure'); END");
    assert.throws(() => store.reserve({ runId: id, agent: "claude", limit: 1, now }), /injected ledger failure/);
    assert.equal(store.get("claude", 1, now).used, 0);
    assert.equal((inspector.prepare("SELECT COUNT(*) AS count FROM world_cognition_reservations").get() as { count: number }).count, 0);
    inspector.exec("DROP TRIGGER reject_budget_write");
    assert.equal(store.reserve({ runId: id, agent: "claude", limit: 1, now }).accepted, true);
    assert.equal(store.get("claude", 1, now).used, 1);
  } finally { inspector.close(); }
});

test("restoring an older room database leaves the separate usage ledger intact", (t) => {
  const { store, path, dir } = fixture(t);
  const roomPath = join(dir, "room.db"), backupPath = join(dir, "old-room.db");
  let room = openDatabase(roomPath);
  room.prepare("VACUUM INTO ?").run(backupPath);
  room.close();
  assert.equal(store.reserve({ runId: runId(), agent: "claude", limit: 1, now }).accepted, true);
  copyFileSync(backupPath, roomPath);
  room = openDatabase(roomPath);
  try {
    assert.equal(store.get("claude", 1, now).used, 1);
    assert.throws(() => new WorldBudgetStore(roomPath), /not a supported world budget ledger/);
    const reopened = new WorldBudgetStore(path);
    try { assert.equal(reopened.reserve({ runId: runId(), agent: "claude", limit: 1, now }).reason, "budget"); }
    finally { reopened.close(); }
  } finally { room.close(); }
  assert.throws(() => new WorldBudgetStore(":memory:"), /persistent sidecar/);
});

function message(child: ChildProcess, kind: string): Promise<Record<string, unknown>> {
  return new Promise((resolveMessage, reject) => {
    const cleanup = () => { child.off("message", receive); child.off("exit", exited); child.off("error", failed); };
    const receive = (value: unknown) => {
      if (typeof value !== "object" || value === null || !("kind" in value) || value.kind !== kind) return;
      cleanup();
      resolveMessage(value as Record<string, unknown>);
    };
    const exited = (code: number | null) => { cleanup(); reject(new Error("budget child exited before " + kind + ": " + code)); };
    const failed = (error: Error) => { cleanup(); reject(error); };
    child.on("message", receive); child.once("exit", exited); child.once("error", failed);
  });
}

test("two real competing processes cannot both consume the last daily slot", { timeout: 20_000 }, async (t) => {
  const { store, path } = fixture(t);
  const moduleUrl = new URL("../src/world-budget.ts", import.meta.url).href;
  const children = [runId(), runId()].map((id) => {
    const source = `import { WorldBudgetStore } from ${JSON.stringify(moduleUrl)};
      const store = new WorldBudgetStore(${JSON.stringify(path)});
      process.send({kind:'ready'});
      process.once('message', () => {
        process.send({kind:'attempt'});
        try {
          const result = store.reserve({runId:${JSON.stringify(id)},agent:'claude',limit:1,now:new Date(${JSON.stringify(now.toISOString())})});
          store.close(); process.send({kind:'result',result}, () => process.disconnect());
        } catch(error) {
          store.close(); process.send({kind:'result',error:String(error)}, () => process.disconnect());
        }
      });`;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
      cwd: fileURLToPath(new URL("../../..", import.meta.url)), windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    child.stdout!.resume(); child.stderr!.resume();
    return child;
  });
  const blocker = new Database(path);
  try {
    await Promise.all(children.map((child) => message(child, "ready")));
    blocker.exec("BEGIN IMMEDIATE");
    const attempted = Promise.all(children.map((child) => message(child, "attempt")));
    const results = Promise.all(children.map((child) => message(child, "result")));
    for (const child of children) child.send("go");
    await attempted;
    blocker.exec("COMMIT");
    const replies = await results;
    for (const reply of replies) assert.equal(reply.error, undefined);
    const accepted = replies.map((reply) => (reply.result as { accepted: boolean }).accepted);
    assert.deepEqual(accepted.sort(), [false, true]);
    assert.equal(store.get("claude", 1, now).used, 1);
  } finally {
    if (blocker.inTransaction) blocker.exec("ROLLBACK");
    blocker.close();
    await Promise.all(children.map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }));
  }
});
