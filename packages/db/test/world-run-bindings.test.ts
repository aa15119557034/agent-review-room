import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import Database from "better-sqlite3";
import { WorldBudgetStore, ulid } from "../src/index";

const now = new Date("2026-11-16T08:00:00.000Z");
function fixture(t: TestContext) {
  const parent = fs.realpathSync.native(tmpdir()), root = fs.mkdtempSync(join(parent, "room-world-bindings-")), path = join(root, "world-usage.sqlite");
  const store = new WorldBudgetStore(path);
  t.after(() => { store.close(); assert.equal(dirname(resolve(root)), parent); fs.rmSync(root, { recursive: true, force: true }); });
  const input = () => ({ runId: "run_" + ulid(), agent: "deepseek", limit: 10, now, sceneId: "wscn_" + ulid(), binding: {
    worldId: "world_" + ulid(), generation: { session: "wses_" + ulid(), runSeq: 3 },
    nodeId: "source-node", baseUrl: "http://127.0.0.1:7420", profileId: "deepseek-world", ledgerId: "rled_" + ulid(),
    worldProfile: { sourceChatProfileId: "deepseek-chat", recipeVersion: "deepseek-http-v1" }, model: { model: "deepseek-flash", effort: "high" },
  } });
  return { store, path, root, input };
}

test("original dispatch and budget are one durable reservation; pending survives reopen", t => {
  const h = fixture(t), input = h.input();
  assert.equal(h.store.reserveBound(input).budget.used, 1);
  assert.deepEqual(h.store.pending(), [{ runId: input.runId, agent: input.agent, sceneId: input.sceneId, reservedAt: now.toISOString(), binding: input.binding }]);
  h.store.close(); const reopened = new WorldBudgetStore(h.path);
  try {
    assert.equal(reopened.get(input.agent, 10, now).used, 1);
    assert.deepEqual(reopened.pending()[0]!.binding, input.binding);
    assert.equal(reopened.reserveBound(input).budget.used, 1);
    for (const changed of [{ ...input.binding, nodeId: "other-node" }, { ...input.binding, model: { model: "other", effort: null } }]) {
      assert.throws(() => reopened.reserveBound({ ...input, binding: changed }), /cannot change/);
    }
    assert.equal(reopened.reserveBound(h.input()).reason, "pending");
    reopened.confirmStopped({ runId: input.runId, ledgerId: input.binding.ledgerId, status: "closed_process" }, now);
    assert.deepEqual(reopened.pending(), []);
    assert.equal(reopened.get(input.agent, 10, now).used, 1, "proof does not refund usage");
    assert.equal(reopened.reserveBound(h.input()).accepted, true);
  } finally { reopened.close(); }
});

test("binding write failure rolls back budget; positive-proof write failure keeps the barrier", t => {
  const h = fixture(t), inspector = new Database(h.path), input = h.input();
  try {
    inspector.exec("CREATE TRIGGER reject_binding AFTER INSERT ON world_cognition_bindings BEGIN SELECT RAISE(ABORT, 'binding failed'); END");
    assert.throws(() => h.store.reserveBound(input), /binding failed/);
    assert.equal(h.store.get(input.agent, 10, now).used, 0); assert.deepEqual(h.store.pending(), []);
    inspector.exec("DROP TRIGGER reject_binding"); h.store.reserveBound(input);
    inspector.exec("CREATE TRIGGER reject_proof AFTER UPDATE ON world_cognition_bindings BEGIN SELECT RAISE(ABORT, 'proof failed'); END");
    assert.throws(() => h.store.confirmStopped({ runId: input.runId, ledgerId: input.binding.ledgerId, status: "fenced_never_started" }), /proof failed/);
    assert.equal(h.store.pending().length, 1); assert.equal(h.store.reserveBound(h.input()).reason, "pending");
  } finally { inspector.close(); }
});

test("missing/unconfirmed, wrong identity and unknown execution scope never clear binding", t => {
  const h = fixture(t), input = h.input(); h.store.reserveBound(input);
  for (const status of ["missing", "unconfirmed"] as const) assert.throws(() => h.store.confirmStopped({ runId: input.runId, ledgerId: input.binding.ledgerId, status }), /positive/);
  assert.throws(() => h.store.confirmStopped({ runId: input.runId, ledgerId: "rled_" + ulid(), status: "closed_process" }), /original scope/);
  assert.throws(() => h.store.confirmStopped({ runId: "run_" + ulid(), ledgerId: input.binding.ledgerId, status: "closed_process" }), /no recorded/);
  assert.equal(h.store.pending().length, 1);
  const wrong = h.input(); wrong.binding.worldProfile.recipeVersion = "unreviewed";
  assert.throws(() => h.store.reserveBound(wrong), /verified isolated/);
});

test("legacy reservations remain unresolved after v1 upgrade, with no invented execution identity", t => {
  const h = fixture(t), input = h.input(); h.store.reserve(input); h.store.close();
  const old = new Database(h.path);
  old.exec("DROP TABLE world_cognition_bindings"); old.pragma("user_version = 1"); old.close();
  const upgraded = new WorldBudgetStore(h.path);
  try {
    assert.equal(upgraded.pending()[0]!.binding, null);
    assert.equal(upgraded.get(input.agent, 10, now).used, 1);
    assert.throws(() => upgraded.reserveBound(input), /cannot change or be guessed/);
    assert.equal(upgraded.reserveBound(h.input()).reason, "pending");
    assert.throws(() => upgraded.confirmStopped({ runId: input.runId, ledgerId: input.binding.ledgerId, status: "closed_process" }), /no recorded/);
  } finally { upgraded.close(); }
});

test("a second live connection sees a new binding and cannot start another model", t => {
  const h = fixture(t), second = new WorldBudgetStore(h.path), input = h.input();
  try {
    h.store.reserveBound(input);
    assert.equal(second.pending().length, 1);
    assert.equal(second.reserveBound(h.input()).reason, "pending");
    second.confirmStopped({ runId: input.runId, ledgerId: input.binding.ledgerId, status: "fenced_never_started" });
    assert.deepEqual(h.store.pending(), []);
    assert.equal(h.store.reserveBound(h.input()).accepted, true);
  } finally { second.close(); }
});
