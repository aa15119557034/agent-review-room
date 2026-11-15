import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { HttpRemoteAgentAdapter } from "@room/remote-client";
import { REMOTE_PROTOCOL_VERSION } from "@room/schemas";
import type { RemoteAgentAdapter, AgentInput, RunOptions, SessionConfig } from "@room/core";
import { ulid, WorldBudgetStore } from "@room/db";
import type { AgentEvent, WorldBudget, WorldCognitionMode, WorldCognitionReply } from "@room/schemas";
import { WorldCognitionRunner, WorldRunNotStoppedError, type WorldCognitionOutcome, type WorldCognitionRequest } from "../src/main/world-cognition";

const now = new Date(2026, 10, 16, 12);
const reply: WorldCognitionReply = { say: { intent: { kind: "respond", feeling: "glad" }, tone: "warm", expression: "neutral" }, propose: null };
const output = "```room-world\n" + JSON.stringify(reply) + "\n```";
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
function event(runId: string, seq: number, payload: Record<string, unknown>): AgentEvent {
  return { eventId: `${runId}-${seq}`, runId, seq, ts: now.toISOString(), ...payload } as AgentEvent;
}
async function* valid(runId: string): AsyncIterable<AgentEvent> {
  yield event(runId, 0, { type: "message_complete", text: output });
  yield event(runId, 1, { type: "completed" });
}

class FakeAdapter implements RemoteAgentAdapter {
  readonly id = "isolated-world-test";
  readonly kind = "remote" as const;
  readonly node = { nodeId: "fake", baseUrl: "http://127.0.0.1", profileId: "test-chat", heartbeatTimeoutMs: 500, reconnectGraceMs: 1000, requestTimeoutMs: 1000 };
  initialized = 0;
  sessions: SessionConfig[] = [];
  closed: string[] = [];
  runs: { runId: string; input: AgentInput; options: RunOptions }[] = [];
  initializeGate?: Promise<void>;
  sessionGate?: Promise<void>;
  closeGate?: Promise<void>;
  readonly enteredRun = deferred();
  readonly enteredClose = deferred();
  behavior: (runId: string, input: AgentInput, opts: RunOptions) => AsyncIterable<AgentEvent> = valid;
  async health() { return { protocol: REMOTE_PROTOCOL_VERSION, nodeId: "fake", profiles: ["test-chat"], activeRuns: 0, maxConcurrentRuns: 1, leaseMs: 100, heartbeatMs: 20 }; }
  async listRemoteRuns() { return []; }
  async reconcile() { return { orphansOnNode: [], missingOnNode: [] }; }
  async initialize() {
    this.initialized++;
    await this.initializeGate;
    return { streaming: true, permissionRequests: false, readOnly: true };
  }
  async startSession(config: SessionConfig) {
    this.sessions.push(config);
    await this.sessionGate;
    return { sessionId: "test-session", adapterId: this.id };
  }
  run(_sessionId: string, runId: string, input: AgentInput, options: RunOptions) {
    this.runs.push({ runId, input, options });
    this.enteredRun.resolve();
    return this.behavior(runId, input, options);
  }
  async closeSession(id: string) {
    this.enteredClose.resolve();
    await this.closeGate;
    this.closed.push(id);
  }
}

function fixture(resolve?: (agent: string, signal: AbortSignal) => Promise<RemoteAgentAdapter | null>) {
  const dir = mkdtempSync(join(tmpdir(), "room-world-cognition-"));
  const file = join(dir, "world-budget.sqlite");
  const budget = new WorldBudgetStore(file), adapter = new FakeAdapter();
  const current = { value: true }, foreground = { value: false };
  const replies: { reply: WorldCognitionReply; runId: string }[] = [];
  const modes: WorldCognitionMode[] = [], settled: WorldCognitionOutcome[] = [], budgets: WorldBudget[] = [];
  const runner = new WorldCognitionRunner({ budget, resolve: resolve ?? (async () => adapter), foregroundBusy: () => foreground.value, emitBudget: (value) => { budgets.push(value); }, now: () => now });
  const input = (changes: Partial<WorldCognitionRequest> = {}): WorldCognitionRequest => ({
    worldId: `world_${ulid()}`, generation: { session: `wses_${ulid()}`, runSeq: 0 },
    agent: "claude", sceneId: null, priority: "routine", limit: 60, prompt: "Only this resident's observations.",
    isCurrent: () => current.value,
    onReply: async (value, runId) => { replies.push({ reply: value, runId }); },
    onMode: async (mode) => { modes.push(mode); }, onSettled: async (value) => { settled.push(value); }, ...changes,
  });
  return { dir, file, budget, adapter, current, foreground, replies, modes, settled, budgets, runner, input,
    close: async () => { runner.cancel(); await runner.drain(); budget.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("world cognition reserves durably before a tool-free Run and only applies a complete valid result", async () => {
  const h = fixture();
  try {
    h.adapter.behavior = async function* (runId, input, opts) {
      assert.equal(h.budget.get("claude", 60, now).used, 1);
      assert.deepEqual(Object.keys(input).sort(), ["content", "contentHash", "snapshotId"]);
      assert.equal(input.contentHash, createHash("sha256").update(input.content, "utf8").digest("hex"));
      assert.match(input.snapshotId, /^snap_/);
      assert.deepEqual(await opts.onPermissionRequest({} as never), { decision: "deny", decidedBy: "system" });
      yield* valid(runId);
    };
    await h.runner.request(h.input());
    assert.deepEqual(h.replies.map((value) => value.reply), [reply]);
    assert.equal(h.replies[0]!.runId, h.adapter.runs[0]!.runId);
    assert.match(h.replies[0]!.runId, /^run_/);
    assert.deepEqual(h.settled, ["completed"]);
    assert.deepEqual(h.modes, [{ mode: "model" }]);
    assert.deepEqual(h.adapter.closed, ["test-session"]);
    assert.equal(h.budgets[0]!.used, 1);
    const secondConnection = new WorldBudgetStore(h.file);
    try { assert.equal(secondConnection.get("claude", 60, now).used, 1); } finally { secondConnection.close(); }
  } finally { await h.close(); }
});

test("malformed, contradictory and throwing streams never apply even a preceding complete JSON reply", async (t) => {
  const cases: Record<string, (runId: string) => AsyncIterable<AgentEvent>> = {
    "completed without message_complete": async function* (id) { yield event(id, 0, { type: "completed" }); },
    "message_complete without terminal": async function* (id) { yield event(id, 0, { type: "message_complete", text: output }); },
    "deltas do not count as complete": async function* (id) { yield event(id, 0, { type: "message_delta", text: output }); yield event(id, 1, { type: "completed" }); },
    "invalid structured reply": async function* (id) { yield event(id, 0, { type: "message_complete", text: "hello" }); yield event(id, 1, { type: "completed" }); },
    "legacy free-text reply": async function* (id) {
      const old = { say: { text: "饭做好了。", expression: "happy" }, propose: null };
      yield event(id, 0, { type: "message_complete", text: "```room-world\n" + JSON.stringify(old) + "\n```" });
      yield event(id, 1, { type: "completed" });
    },
    "wrong Run": async function* (_id) { yield* valid(`run_${ulid()}`); },
    "sequence gap": async function* (id) { yield event(id, 0, { type: "message_complete", text: output }); yield event(id, 2, { type: "completed" }); },
    "two complete messages": async function* (id) { yield event(id, 0, { type: "message_complete", text: output }); yield event(id, 1, { type: "message_complete", text: output }); yield event(id, 2, { type: "completed" }); },
    "event after completed": async function* (id) { yield* valid(id); yield event(id, 2, { type: "error", reason: "internal" }); },
    "throw after completed": async function* (id) { yield* valid(id); throw new Error("stream failure after completed"); },
  };
  for (const [name, behavior] of Object.entries(cases)) await t.test(name, async () => {
    const h = fixture();
    try {
      h.adapter.behavior = behavior;
      await h.runner.request(h.input());
      assert.equal(h.replies.length, 0);
      assert.deepEqual(h.settled, ["discarded"]);
      assert.deepEqual(h.modes, [{ mode: "model" }], "bad model output does not imply the node is offline");
      assert.equal(h.budget.get("claude", 60, now).used, 1);
      assert.deepEqual(h.adapter.closed, ["test-session"]);
    } finally { await h.close(); }
  });
});

test("cancel synchronously aborts and a deliberately late successful reply is discarded without refund", async () => {
  const h = fixture(), gate = deferred();
  try {
    h.adapter.behavior = async function* (id) { await gate.promise; yield* valid(id); };
    const requested = h.runner.request(h.input());
    await h.adapter.enteredRun.promise;
    h.runner.cancel();
    assert.equal(h.adapter.runs[0]!.options.signal.aborted, true);
    gate.resolve();
    await requested; await h.runner.drain();
    assert.equal(h.replies.length, 0);
    assert.deepEqual(h.settled, ["discarded"]);
    assert.equal(h.budget.get("claude", 60, now).used, 1);
    assert.deepEqual(h.adapter.closed, ["test-session"]);
  } finally { gate.resolve(); await h.close(); }
});

test("a stale generation receives neither a late reply nor a settlement that could rewrite the new scene", async () => {
  const h = fixture(), gate = deferred();
  try {
    h.adapter.behavior = async function* (id) { await gate.promise; yield* valid(id); };
    const requested = h.runner.request(h.input());
    await h.adapter.enteredRun.promise;
    h.current.value = false;
    gate.resolve(); await requested;
    assert.equal(h.replies.length, 0); assert.deepEqual(h.settled, []);
    assert.deepEqual(h.modes, [{ mode: "model" }]);
    assert.equal(h.budget.get("claude", 60, now).used, 1);
    assert.deepEqual(h.adapter.closed, ["test-session"]);
  } finally { gate.resolve(); await h.close(); }
});

test("a player preempts a routine but waits through closeSession; additional requests never form a queue", async () => {
  const old = new FakeAdapter(), player = new FakeAdapter(), responseGate = deferred(), closeGate = deferred();
  let resolves = 0;
  const h = fixture(async () => ++resolves === 1 ? old : player);
  try {
    old.closeGate = closeGate.promise;
    old.behavior = async function* (id) { await responseGate.promise; yield* valid(id); };
    const oldResult = h.runner.request(h.input());
    await old.enteredRun.promise;
    const playerResult = h.runner.request(h.input({ priority: "player" }));
    assert.equal(old.runs[0]!.options.signal.aborted, true);
    const dropped: WorldCognitionOutcome[] = [];
    await h.runner.request(h.input({ priority: "player", onSettled: async (value) => { dropped.push(value); } }));
    await h.runner.request(h.input({ onSettled: async (value) => { dropped.push(value); } }));
    assert.deepEqual(dropped, ["discarded", "busy_elsewhere"]);
    assert.equal(resolves, 1);
    responseGate.resolve(); await old.enteredClose.promise;
    assert.equal(player.runs.length, 0, "old session cleanup still owns execution");
    closeGate.resolve();
    await Promise.all([oldResult, playerResult]);
    assert.equal(resolves, 2); assert.equal(player.runs.length, 1);
    assert.equal(h.replies.length, 1);
    assert.equal(h.budget.get("claude", 60, now).used, 2);
    assert.deepEqual(h.settled, ["discarded", "completed"]);
  } finally { responseGate.resolve(); closeGate.resolve(); await h.close(); }
});

test("foreground takeover cancels the background, waits for cleanup and blocks another world request", async () => {
  const h = fixture(), gate = deferred(), closeGate = deferred();
  try {
    h.adapter.closeGate = closeGate.promise;
    h.adapter.behavior = async function* (id) { await gate.promise; yield* valid(id); };
    const requested = h.runner.request(h.input());
    await h.adapter.enteredRun.promise;
    h.foreground.value = true;
    let yielded = false;
    const yielding = h.runner.yieldToForeground().then(() => { yielded = true; });
    const skipped: WorldCognitionOutcome[] = [];
    await h.runner.request(h.input({ priority: "player", onSettled: async (value) => { skipped.push(value); } }));
    assert.deepEqual(skipped, ["busy_elsewhere"]);
    gate.resolve(); await h.adapter.enteredClose.promise;
    assert.equal(yielded, false);
    closeGate.resolve(); await Promise.all([requested, yielding]);
    assert.equal(h.adapter.runs.length, 1); assert.equal(h.replies.length, 0);
    assert.deepEqual(h.settled, ["busy_elsewhere"]);
    assert.deepEqual(h.modes.at(-1), { mode: "routine", reason: "busy_elsewhere" });
  } finally { gate.resolve(); closeGate.resolve(); await h.close(); }
});

test("foreground and generation are rechecked after resolution, initialization and session creation", async (t) => {
  for (const interruption of ["foreground", "stale"] as const) for (const stage of ["resolve", "initialize", "session"] as const) await t.test(`${interruption} during ${stage}`, async () => {
    const adapter = new FakeAdapter(), entered = deferred(), gate = deferred();
    const h = fixture(async () => { if (stage === "resolve") { entered.resolve(); await gate.promise; } return adapter; });
    try {
      if (stage === "initialize") {
        adapter.initialize = async () => { entered.resolve(); await gate.promise; return { streaming: true, permissionRequests: false, readOnly: true }; };
      }
      if (stage === "session") {
        adapter.startSession = async () => { entered.resolve(); await gate.promise; return { sessionId: "test-session", adapterId: adapter.id }; };
      }
      const requested = h.runner.request(h.input());
      await entered.promise;
      if (interruption === "foreground") h.foreground.value = true;
      else h.current.value = false;
      gate.resolve(); await requested;
      assert.equal(adapter.runs.length, 0);
      assert.equal(h.budget.get("claude", 60, now).used, 0);
      assert.deepEqual(h.settled, interruption === "foreground" ? ["busy_elsewhere"] : []);
      assert.equal(adapter.closed.length, stage === "session" ? 1 : 0);
    } finally { gate.resolve(); await h.close(); }
  });
});

test("drain also waits for asynchronous notifications of a request skipped by the foreground", async () => {
  const h = fixture(), entered = deferred(), gate = deferred();
  try {
    h.foreground.value = true;
    const requested = h.runner.request(h.input({ onMode: async () => { entered.resolve(); await gate.promise; } }));
    await entered.promise;
    let drained = false;
    const draining = h.runner.drain().then(() => { drained = true; });
    await Promise.resolve();
    assert.equal(drained, false);
    gate.resolve(); await Promise.all([requested, draining]);
    assert.equal(h.adapter.initialized, 0);
    assert.deepEqual(h.settled, ["busy_elsewhere"]);
  } finally { gate.resolve(); await h.close(); }
});

test("callback failure closes its session and releases admission for the next explicit request", async () => {
  const h = fixture();
  try {
    await assert.rejects(h.runner.request(h.input({ onReply: async () => { throw new Error("world commit failed"); } })), /world commit failed/);
    assert.deepEqual(h.settled, ["discarded"]);
    assert.equal(h.adapter.closed.length, 1);
    await h.runner.request(h.input());
    assert.equal(h.adapter.runs.length, 2);
    assert.equal(h.replies.length, 1);
    assert.deepEqual(h.settled, ["discarded", "completed"]);
  } finally { await h.close(); }
});

test("daily exhaustion and scene turn exhaustion settle differently and neither sends a Run", async () => {
  const h = fixture();
  try {
    await h.runner.request(h.input({ limit: 0 }));
    assert.deepEqual(h.settled, ["budget"]);
    assert.deepEqual(h.modes.at(-1), { mode: "routine", reason: "budget" });
    assert.equal(h.adapter.runs.length, 0);
    const sceneId = `wscn_${ulid()}`;
    for (let i = 0; i < 8; i++) assert.equal(h.budget.reserve({ runId: `run_${ulid()}`, agent: "claude", sceneId, limit: 60, now }).accepted, true);
    h.modes.length = 0; h.settled.length = 0;
    await h.runner.request(h.input({ sceneId }));
    assert.deepEqual(h.settled, ["scene_limit"]);
    assert.deepEqual(h.modes, [{ mode: "model" }]);
    assert.equal(h.adapter.runs.length, 0);
    assert.equal(h.budget.get("claude", 60, now).used, 8);
    assert.equal(h.adapter.closed.length, 2);
  } finally { await h.close(); }
});

test("a real SQLite reservation failure never dispatches or automatically retries", async () => {
  const h = fixture(), fault = new Database(h.file);
  try {
    fault.exec("CREATE TRIGGER fail_world_reservation BEFORE INSERT ON world_cognition_reservations BEGIN SELECT RAISE(ABORT, 'injected budget write failure'); END");
    await assert.rejects(h.runner.request(h.input()), /injected budget write failure/);
    assert.equal(h.adapter.runs.length, 0); assert.equal(h.budget.get("claude", 60, now).used, 0);
    assert.deepEqual(h.adapter.closed, ["test-session"]);
    assert.deepEqual(h.settled, ["discarded"]);
    fault.exec("DROP TRIGGER fail_world_reservation");
    await h.runner.request(h.input());
    assert.equal(h.adapter.runs.length, 1, "only the explicit next request can dispatch");
    assert.equal(h.budget.get("claude", 60, now).used, 1);
  } finally { fault.close(); await h.close(); }
});

test("unavailable nodes and explicit node failures fall back offline without pretending there was a reply", async () => {
  const missing = fixture(async () => null);
  try {
    await missing.runner.request(missing.input());
    assert.deepEqual(missing.settled, ["offline"]);
    assert.deepEqual(missing.modes, [{ mode: "routine", reason: "offline" }]);
    assert.equal(missing.budget.get("claude", 60, now).used, 0);
  } finally { await missing.close(); }
  const h = fixture();
  try {
    h.adapter.behavior = async function* (id) { yield event(id, 0, { type: "error", reason: "remote_lost" }); };
    await h.runner.request(h.input());
    assert.deepEqual(h.settled, ["offline"]);
    assert.deepEqual(h.modes.at(-1), { mode: "routine", reason: "offline" });
    assert.equal(h.replies.length, 0); assert.equal(h.budget.get("claude", 60, now).used, 1);
  } finally { await h.close(); }
});

async function remoteFixture(dropOnCancel = false) {
  let running = false, listUnavailable = false, runId = "", stream: ServerResponse | null = null;
  const connected = deferred(), cancelled = deferred();
  const server = createServer((req, res) => {
    const json = (value: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
    if (req.url === "/v1/health") return json({ protocol: REMOTE_PROTOCOL_VERSION, nodeId: "test-world-node", profiles: ["test-chat"], activeRuns: running ? 1 : 0, maxConcurrentRuns: 1, leaseMs: 100, heartbeatMs: 20 });
    if (req.method === "GET" && req.url === "/v1/runs") return listUnavailable ? json({ error: "internal", message: "unavailable" }, 503) : json(runId ? [{ runId, profileId: "test-chat", state: running ? "running" : "finished", lastSeq: 1, subscribers: stream === null ? 0 : 1 }] : []);
    if (req.method === "POST" && req.url === "/v1/runs") {
      let body = "";
      req.on("data", (chunk) => { body += String(chunk); });
      req.on("end", () => {
        if (running) return json({ error: "node_busy", message: "busy" }, 429);
        runId = (JSON.parse(body) as { runId: string }).runId; running = true;
        json({ runId, status: "created", eventsPath: `/v1/runs/${runId}/events` }, 202);
      });
      return;
    }
    if (req.url?.includes("/events?")) {
      stream = res;
      res.writeHead(200, { "content-type": "application/x-ndjson" }); res.flushHeaders();
      res.write(JSON.stringify({ type: "started", seq: 0, ts: now.toISOString() }) + "\n");
      connected.resolve();
      return;
    }
    if (req.url?.endsWith("/cancel")) {
      json({ accepted: true });
      if (dropOnCancel) stream?.destroy();
      else stream?.write(JSON.stringify({ type: "text_delta", seq: 1, ts: now.toISOString(), text: "late buffered output" }) + "\n");
      cancelled.resolve();
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing mock node address");
  const adapter = new HttpRemoteAgentAdapter({ nodeId: "test-world-node", baseUrl: `http://127.0.0.1:${address.port}`, profileId: "test-chat", token: "t".repeat(48), heartbeatTimeoutMs: 500, reconnectGraceMs: 1000, requestTimeoutMs: 1000, cancelConfirmMs: 250 });
  return {
    adapter, connected, cancelled,
    setListUnavailable: (value: boolean) => { listUnavailable = value; },
    finish: () => { running = false; stream?.end(JSON.stringify({ type: "terminal", seq: 2, ts: now.toISOString(), result: { outcome: "cancelled" } }) + "\n"); },
    close: async () => { running = false; stream?.destroy(); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); },
  };
}

test("real HTTP cancellation waits beyond buffered output for the remote terminal", { timeout: 10_000 }, async () => {
  const remote = await remoteFixture();
  const h = fixture(async () => remote.adapter);
  let requested: Promise<void> | undefined, yielding: Promise<void> | undefined;
  try {
    requested = h.runner.request(h.input());
    await remote.connected.promise;
    h.foreground.value = true;
    let yielded = false;
    yielding = h.runner.yieldToForeground().then(() => { yielded = true; });
    await remote.cancelled.promise;
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(yielded, false, "a buffered delta is not cancellation confirmation");
    remote.finish();
    await Promise.all([requested, yielding]);
    assert.equal(h.replies.length, 0);
    assert.equal(h.budget.get("claude", 60, now).used, 1);
  } finally {
    remote.finish();
    await Promise.allSettled([requested, yielding]);
    await h.close(); await remote.close();
  }
});

test("unconfirmed HTTP cancellation blocks later handoffs and new reservations until structured run state confirms release", { timeout: 10_000 }, async (t) => {
  for (const unavailable of [false, true]) await t.test(unavailable ? "run state endpoint unavailable" : "remote Run still active", async () => {
    const remote = await remoteFixture(true);
    const h = fixture(async () => remote.adapter);
    try {
      const requested = h.runner.request(h.input());
      const rejectedRequest = assert.rejects(requested, WorldRunNotStoppedError);
      await remote.connected.promise;
      remote.setListUnavailable(unavailable);
      h.foreground.value = true;
      const yielding = assert.rejects(h.runner.yieldToForeground(), WorldRunNotStoppedError);
      await remote.cancelled.promise;
      await Promise.all([rejectedRequest, yielding]);
      // The first failed request has already left #pending. The remote barrier remains.
      await assert.rejects(h.runner.yieldToForeground(), WorldRunNotStoppedError);
      h.foreground.value = false;
      await assert.rejects(h.runner.request(h.input()), WorldRunNotStoppedError);
      assert.equal(h.budget.get("claude", 60, now).used, 1);
      assert.equal(h.replies.length, 0);
      remote.finish(); remote.setListUnavailable(false);
      await h.runner.yieldToForeground();
    } finally {
      remote.finish(); remote.setListUnavailable(false);
      await h.close(); await remote.close();
    }
  });
});
