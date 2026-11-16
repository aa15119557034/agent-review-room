import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CancelRunRequest, NodeHealth, RemoteErrorResponse, RemoteRunFenceCapability,
  RemoteRunLedgerId, RemoteRunProof, RemoteRunSummary, StartRunRequest, StartRunResponse,
} from "../src/index";

const id = "00000000000000000000000001";
const ledgerId = `rled_${id}`, runId = `run_${id}`;
const health = {
  protocol: 1, nodeId: "test-node", profiles: ["claude-chat"], activeRuns: 0,
  maxConcurrentRuns: 1, leaseMs: 5000, heartbeatMs: 1000,
};
const start = {
  protocol: 1, runId, profileId: "claude-chat",
  snapshot: { id: `snap_${id}`, content: "fixture", contentHash: "a".repeat(64) },
  limits: { idleTimeoutMs: 30_000, totalTimeoutMs: 60_000 },
};

test("legacy health, start and cancellation remain valid without inferred fence capability", () => {
  const oldHealth = NodeHealth.parse(health);
  assert.equal(oldHealth.capabilities?.runFence, undefined);
  assert.deepEqual(StartRunRequest.parse(start), start);
  assert.deepEqual(CancelRunRequest.parse({}), {});
  assert.deepEqual(CancelRunRequest.parse({ reason: "cancel" }), { reason: "cancel" });
  // Existing health extension handling stays unchanged; only new shapes are strict.
  const extended = NodeHealth.parse({ ...health, futureField: "ignored", capabilities: { quota: true, futureCapability: true } });
  assert.deepEqual(extended.capabilities, { quota: true });
});

test("fence support advertises an explicit version and persistent ledger identity", () => {
  const capability = { version: 1, ledgerId };
  assert.deepEqual(RemoteRunFenceCapability.parse(capability), capability);
  assert.deepEqual(NodeHealth.parse({ ...health, capabilities: { runFence: capability } }).capabilities?.runFence, capability);
  for (const value of [true, {}, { version: 1 }, { version: 2, ledgerId }, { version: 1, ledgerId: runId }, { ...capability, readOnly: true }]) {
    assert.equal(RemoteRunFenceCapability.safeParse(value).success, false);
    assert.equal(NodeHealth.safeParse({ ...health, capabilities: { runFence: value } }).success, false);
  }
});

test("protected creation and cancellation carry the expected ledger without weakening other validation", () => {
  assert.equal(StartRunRequest.parse({ ...start, expectedLedgerId: ledgerId }).expectedLedgerId, ledgerId);
  assert.deepEqual(CancelRunRequest.parse({ reason: "yield", expectedLedgerId: ledgerId }), { reason: "yield", expectedLedgerId: ledgerId });
  for (const bad of [null, "", runId, "rled_../other", `rled_${"I".repeat(26)}`]) {
    assert.equal(RemoteRunLedgerId.safeParse(bad).success, false);
    assert.equal(StartRunRequest.safeParse({ ...start, expectedLedgerId: bad }).success, false);
    assert.equal(CancelRunRequest.safeParse({ expectedLedgerId: bad }).success, false);
  }
  assert.equal(StartRunRequest.safeParse({ ...start, expectedLedgerId: ledgerId, command: "shell" }).success, false);
  assert.equal(CancelRunRequest.safeParse({ expectedLedgerId: ledgerId, eraseLedger: true }).success, false);
});

test("proof has four explicit states bound to a ledger and Run, with no inferred stronger guarantee", () => {
  for (const status of ["missing", "unconfirmed", "fenced_never_started", "closed_process"] as const) {
    const proof = { runId, ledgerId, status };
    assert.deepEqual(RemoteRunProof.parse(proof), proof);
    assert.equal(RemoteRunProof.safeParse({ ...proof, processTreeStopped: true }).success, false);
    assert.equal(RemoteRunProof.safeParse({ ...proof, token: "must not be included" }).success, false);
    assert.equal(RemoteRunProof.safeParse({ ...proof, ledgerId: undefined }).success, false);
    assert.equal(RemoteRunProof.safeParse({ ...proof, runId: "../another-run" }).success, false);
  }
  for (const status of ["finished", "cancelled", "safe_to_run", "stopped_tree"]) {
    assert.equal(RemoteRunProof.safeParse({ runId, ledgerId, status }).success, false);
  }
});

test("existing run list and start response retain their shapes and cannot stand in for a proof", () => {
  for (const state of ["running", "finished"] as const) {
    const summary = { runId, profileId: "claude-chat", state, lastSeq: 3, subscribers: 0 };
    assert.deepEqual(RemoteRunSummary.parse(summary), summary);
    assert.equal(RemoteRunProof.safeParse(summary).success, false);
  }
  for (const status of ["accepted", "already_exists"] as const) {
    const response = { runId, status, eventsPath: `/v1/runs/${runId}/events` };
    assert.deepEqual(StartRunResponse.parse(response), response);
  }
});

test("ledger mismatch and consumed Run rejection use explicit error codes", () => {
  for (const error of ["run_ledger_mismatch", "run_fenced"] as const) {
    const response = { error, message: "request was not admitted" };
    assert.deepEqual(RemoteErrorResponse.parse(response), response);
  }
});
