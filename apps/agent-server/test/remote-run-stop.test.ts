import assert from "node:assert/strict";
import cp, { type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunLedger } from "../src/run-ledger";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import { test, type TestContext } from "node:test";
import { NodeHealth, RemoteEvent, RemoteRunSummary } from "@room/schemas";
import { ServerConfig } from "../src/config";
import { RemoteRun } from "../src/remote-run";
import { createAgentServer } from "../src/server";

class FakeChild extends EventEmitter {
  readonly pid = 2147483000;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  alive = true;
  closeEvents = 0;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  close() {
    if (!this.alive) return;
    this.alive = false;
    this.exitCode = 0;
    this.stdin.destroy(); this.stdout.end(); this.stderr.end();
    this.closeEvents++;
    this.emit("close", 0);
  }
}

async function fixture(t: TestContext, closeWaitMs?: number, fenced = false) {
  const fenceDir = fenced ? realpathSync.native(mkdtempSync(join(tmpdir(), "room-stop-fence-"))) : undefined;
  const ledger = fenceDir ? await RunLedger.initialize(fenceDir) : undefined;
  const children: FakeChild[] = [], runs: RemoteRun[] = [], warnings: string[] = [];
  let killCalls = 0;
  // Exercise the production HTTP/RemoteRun path, but never launch a CLI or
  // execute taskkill. A failed kill deliberately leaves the fake child alive.
  t.mock.method(cp, "spawn", ((file: string) => {
    assert.equal(file, process.execPath);
    const child = new FakeChild(); children.push(child);
    queueMicrotask(() => child.emit("spawn"));
    return child as unknown as ChildProcess;
  }) as typeof cp.spawn);
  t.mock.method(cp, "execFile", ((file: string, _args: string[], _options: unknown, callback: (error: Error) => void) => {
    assert.equal(file, "taskkill");
    killCalls++;
    callback(new Error("simulated taskkill failure; no real command executed"));
    return new EventEmitter();
  }) as typeof cp.execFile);
  // Non-Windows CI uses process groups instead of taskkill; fail that signal
  // too without addressing any real PID.
  t.mock.method(process, "kill", ((_pid: number) => { killCalls++; throw new Error("simulated process-group kill failure"); }) as typeof process.kill);
  t.mock.method(console, "warn", (line: string) => { warnings.push(line); });
  syncBuiltinESMExports();
  const originalStart = RemoteRun.prototype.start;
  t.mock.method(RemoteRun.prototype, "start", function (this: RemoteRun) { runs.push(this); originalStart.call(this); });
  const cfg = ServerConfig.parse({
    nodeId: "stop-proof-test", port: 1, maxConcurrentRuns: 1,
    ...(fenceDir ? { runFenceDir: fenceDir } : {}),
    leaseMs: 30_000, heartbeatMs: 1000, killGraceMs: 200,
    profiles: { fake: { command: process.execPath, args: [], cwd: process.cwd() } },
  });
  const token = "fake-stop-proof-token".repeat(2);
  const app = createAgentServer(cfg, token, undefined, { ledger, warn: (line) => warnings.push(line), ...(closeWaitMs === undefined ? {} : { closeWaitMs }) });
  let closed = false;
  t.after(async () => {
    try {
      for (const child of children) child.close();
      if (!closed) await app.close();
    } finally { t.mock.restoreAll(); syncBuiltinESMExports(); if (fenceDir) rmSync(fenceDir, { recursive: true, force: true }); }
  });
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const address = app.server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const id = (n: number) => "run_" + String(n).padStart(26, "0");
  const request = async (path: string, body?: unknown) => {
    const response = await fetch(base + path, { headers, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  return {
    children, runs, warnings, cfg, id, fenceDir, proof: (n: number) => request(`/v1/runs/${id(n)}/proof`), get killCalls() { return killCalls; },
    start: (n: number) => request("/v1/runs", {
      protocol: 1, runId: id(n), profileId: "fake",
      snapshot: { id: "snap_" + String(n).padStart(26, "0"), content: "fixture", contentHash: createHash("sha256").update("fixture").digest("hex") },
      limits: { idleTimeoutMs: 30_000, totalTimeoutMs: 60_000 },
    }),
    cancel: (n: number) => request(`/v1/runs/${id(n)}/cancel`, {}),
    list: async () => RemoteRunSummary.array().parse((await request("/v1/runs")).body),
    health: async () => NodeHealth.parse((await request("/v1/health")).body),
    events: async (n: number) => {
      const response = await fetch(base + `/v1/runs/${id(n)}/events`, { headers });
      assert.equal(response.status, 200);
      return (await response.text()).trim().split("\n").map((line) => RemoteEvent.parse(JSON.parse(line)));
    },
    close: async () => { await app.close(); closed = true; },
  };
}

test("cancel timeout cannot manufacture a terminal or release capacity before child close", { timeout: 15_000 }, async (t) => {
  const h = await fixture(t);
  assert.equal((await h.start(1)).status, 202);
  assert.equal(h.children.length, 1);
  assert.equal(h.runs[0]!.isFinished, false);
  assert.equal((await h.cancel(1)).status, 202);
  assert.equal(h.killCalls, 1);
  // Cross the old unconditional finish deadline with no close event at all.
  await new Promise((resolve) => setTimeout(resolve, h.cfg.killGraceMs + 5_200));
  assert.equal(h.children[0]!.alive, true);
  assert.equal(h.children[0]!.closeEvents, 0);
  assert.equal(h.runs[0]!.isFinished, false);
  assert.equal((await h.list()).find((run) => run.runId === h.id(1))!.state, "running");
  assert.equal((await h.health()).activeRuns, 1);
  assert.equal((await h.start(2)).status, 429);
  assert.equal(h.children.length, 1, "busy node does not spawn the second request");

  // Positive control: real close notification releases exactly this Run.
  h.children[0]!.close();
  assert.equal(h.runs[0]!.isFinished, true);
  assert.equal((await h.list()).find((run) => run.runId === h.id(1))!.state, "finished");
  assert.equal((await h.health()).activeRuns, 0);
  const terminal = (await h.events(1)).filter((event) => event.type === "terminal");
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0]!.result.outcome, "cancelled");
  assert.equal((await h.start(2)).status, 202);
  assert.equal(h.children.length, 2);
  h.children[1]!.close();
});

test("bounded server shutdown reports an unconfirmed stop without inventing a terminal", async (t) => {
  const h = await fixture(t, 0);
  assert.equal((await h.start(1)).status, 202);
  await h.close();
  assert.equal(h.children[0]!.alive, true);
  assert.equal(h.children[0]!.closeEvents, 0);
  assert.equal(h.runs[0]!.isFinished, false);
  assert.ok(h.warnings.some((line) => line.includes(h.id(1)) && line.includes("没有 terminal")));
  h.children[0]!.close();
  assert.equal(h.runs[0]!.isFinished, true);
});


test("persistent proof waits for close and a sealed old writer cannot change the next owner's ledger", { skip: process.platform !== "win32" }, async t => {
  const h = await fixture(t, 0, true);
  assert.equal((await h.start(1)).status, 202);
  await h.cancel(1);
  assert.equal((await h.proof(1)).body.status, "unconfirmed");
  assert.equal((await h.health()).activeRuns, 1);
  h.children[0]!.close();
  assert.equal((await h.proof(1)).body.status, "closed_process");
  assert.equal((await h.start(2)).status, 202);
  await h.close();
  const next = await RunLedger.open(h.fenceDir!);
  try {
    assert.equal(next.proof(h.id(2)).status, "unconfirmed");
    h.children[1]!.close();
    assert.equal(next.proof(h.id(2)).status, "unconfirmed", "old owner cannot append after releasing its pipe locks");
    assert.equal(next.unconfirmedCount, 1);
  } finally { await next.close(); }
});
