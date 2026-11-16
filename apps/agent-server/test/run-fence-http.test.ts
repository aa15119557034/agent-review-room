import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { NodeHealth, RemoteRunProof, type StartRunRequest } from "@room/schemas";
import { ServerConfig } from "../src/config";
import { RunLedger } from "../src/run-ledger";
import { createAgentServer } from "../src/server";

const windows = { skip: process.platform !== "win32" };
const id = (n: number) => "run_" + String(n).padStart(26, "0");
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(t: TestContext, verifyCommit?: () => Promise<void>, exitCode = 0) {
  const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "room-fence-http-")));
  const dir = join(root, "ledger"); fs.mkdirSync(dir);
  const marker = join(root, "executions.txt"), script = join(root, "child.cjs");
  fs.writeFileSync(script, "require('node:fs').appendFileSync(" + JSON.stringify(marker) + ", 'started\\n');setTimeout(()=>process.exit(" + exitCode + "),10);");
  let ledger = await RunLedger.initialize(dir);
  const cfg = ServerConfig.parse({ nodeId: "fence-test", runFenceDir: dir, maxConcurrentRuns: 1, finishedRunTtlMs: 1,
    profiles: { fake: { command: process.execPath, args: [script], cwd: root, verifyCommit: Boolean(verifyCommit) } } });
  const token = "non-secret-test-token".repeat(2);
  const headers = { authorization: "Bearer " + token, "content-type": "application/json" };
  const make = () => createAgentServer(cfg, token, undefined, { ledger, verifyCommit, closeWaitMs: 1000 });
  let app = make(), base = "";
  async function listen() {
    await new Promise<void>(resolve => app.server.listen(0, "127.0.0.1", resolve));
    const address = app.server.address(); assert.ok(address && typeof address !== "string");
    base = "http://127.0.0.1:" + address.port;
  }
  await listen();
  t.after(async () => { await app.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const request = async (path: string, body?: unknown) => {
    const response = await fetch(base + path, { headers, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) });
    return { status: response.status, headers: response.headers, body: await response.json() as Record<string, unknown> };
  };
  const body = (n: number): StartRunRequest => ({ protocol: 1, runId: id(n), profileId: "fake", expectedLedgerId: ledger.ledgerId,
    snapshot: { id: "snap_" + String(n).padStart(26, "0"), content: "fixture", contentHash: createHash("sha256").update("fixture").digest("hex"), ...(verifyCommit ? { commitSha: "a".repeat(40) } : {}) },
    limits: { idleTimeoutMs: 1000, totalTimeoutMs: 2000 },
  });
  const proof = async (n: number) => RemoteRunProof.parse((await request("/v1/runs/" + id(n) + "/proof")).body);
  async function waitFor(n: number, status: RemoteRunProof["status"]) {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) { const current = await proof(n); if (current.status === status) return current; await delay(10); }
    throw new Error("proof did not become " + status);
  }
  return { root, dir, marker, cfg, headers, body, request, proof, waitFor, get base() { return base; }, get ledger() { return ledger; }, get app() { return app; },
    executions: () => fs.existsSync(marker) ? fs.readFileSync(marker, "utf8").trim().split("\n").length : 0,
    reopen: async () => { await app.close(); ledger = await RunLedger.open(dir); app = make(); await listen(); },
  };
}

test("held creation body, unknown cancel, restart and late POST never spawn", windows, async t => {
  const h = await fixture(t);
  const health = NodeHealth.parse((await h.request("/v1/health")).body);
  assert.equal(health.capabilities?.runFence?.ledgerId, h.ledger.ledgerId);
  const bytes = JSON.stringify(h.body(1));
  let release!: () => void;
  const late = new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const req = httpRequest(h.base + "/v1/runs", { method: "POST", headers: h.headers }, response => {
      let data = ""; response.on("data", chunk => { data += chunk; }); response.on("end", () => resolve({ status: response.statusCode!, body: JSON.parse(data) }));
    });
    req.on("error", reject); req.write(bytes.slice(0, 20)); release = () => req.end(bytes.slice(20));
  });
  const cancelled = await h.request("/v1/runs/" + id(1) + "/cancel", { expectedLedgerId: h.ledger.ledgerId });
  assert.equal(cancelled.status, 202);
  const proof = await h.request("/v1/runs/" + id(1) + "/proof");
  assert.equal(proof.headers.get("cache-control"), "no-store"); assert.equal(proof.body.status, "fenced_never_started");
  release(); assert.equal((await late).body.error, "run_fenced");
  await h.reopen();
  assert.equal((await h.request("/v1/runs", h.body(1))).body.error, "run_fenced");
  assert.equal((await h.proof(1)).status, "fenced_never_started"); assert.equal(h.executions(), 0);
  assert.equal((await h.request("/v1/runs/not-an-id/proof")).status, 400);
  assert.equal((await h.request("/v1/runs", { ...h.body(2), expectedLedgerId: "rled_" + "0".repeat(26) })).body.error, "run_ledger_mismatch");
  assert.equal((await h.request("/v1/runs/" + id(2) + "/cancel", { expectedLedgerId: "rled_" + "0".repeat(26) })).body.error, "run_ledger_mismatch");
  assert.equal((await h.proof(2)).status, "missing");
});

test("cancellation and competing requests are rechecked after asynchronous commit validation", windows, async t => {
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const h = await fixture(t, async () => { entered(); await gate; });
  const start = h.request("/v1/runs", h.body(1)); await waiting;
  assert.equal((await h.request("/v1/runs/" + id(1) + "/cancel", { expectedLedgerId: h.ledger.ledgerId })).status, 202);
  release(); assert.equal((await start).body.error, "run_fenced"); assert.equal(h.executions(), 0);
  const pair = await Promise.all([h.request("/v1/runs", h.body(2)), h.request("/v1/runs", h.body(2))]);
  assert.deepEqual(pair.map(result => result.status).sort(), [200, 202]);
  await h.waitFor(2, "closed_process"); assert.equal(h.executions(), 1);
});

test("normal and nonzero close are persistent closed_process; TTL never permits re-execution", windows, async t => {
  let sweep: (() => void) | undefined;
  const interval = globalThis.setInterval;
  t.mock.method(globalThis, "setInterval", ((fn: () => void, ms: number, ...args: unknown[]) => {
    if (ms === 30_000) sweep = fn;
    return interval(fn, ms, ...args);
  }) as typeof setInterval);
  const h = await fixture(t, undefined, 7);
  assert.equal((await h.request("/v1/runs", h.body(1))).status, 202);
  await h.waitFor(1, "closed_process"); await delay(5); assert.ok(sweep); sweep();
  assert.deepEqual((await h.request("/v1/runs")).body, []);
  assert.equal((await h.request("/v1/runs", h.body(1))).body.error, "run_fenced");
  await h.reopen(); assert.equal((await h.proof(1)).status, "closed_process"); assert.equal(h.executions(), 1);
});

test("recovered admissions retain capacity and cannot become never_started from cancellation", windows, async t => {
  const h = await fixture(t);
  h.ledger.admit(id(1), "a".repeat(64)); await h.reopen();
  assert.equal((await h.proof(1)).status, "unconfirmed");
  assert.equal((await h.request("/v1/health")).body.activeRuns, 1);
  assert.equal((await h.request("/v1/runs", h.body(2))).body.error, "node_busy");
  assert.equal((await h.request("/v1/runs/" + id(1) + "/cancel", { expectedLedgerId: h.ledger.ledgerId })).status, 202);
  assert.equal((await h.proof(1)).status, "unconfirmed"); assert.equal(h.executions(), 0);
});

test("write failure cannot acknowledge cancellation or spawn, and closing blocks awaited admission", windows, async t => {
  const h = await fixture(t);
  const write = t.mock.method(fs, "writeSync", (() => { throw new Error("injected durable write failure"); }) as typeof fs.writeSync);
  assert.equal((await h.request("/v1/runs", h.body(1))).status, 500);
  write.mock.restore();
  assert.equal((await h.request("/v1/runs/" + id(2) + "/cancel", { expectedLedgerId: h.ledger.ledgerId })).status, 500);
  assert.equal((await h.request("/v1/runs/" + id(1) + "/proof")).status, 500); assert.equal(h.executions(), 0);
});

test("closing during await prevents new execution and the old writer is sealed before owner release", windows, async t => {
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const h = await fixture(t, async () => { entered(); await gate; });
  const request = h.request("/v1/runs", h.body(1)); await waiting;
  const closed = h.app.close(); release(); assert.equal((await request).status, 503); await closed;
  assert.throws(() => h.ledger.fence(id(2)), /unavailable/);
  const next = await RunLedger.open(h.dir);
  assert.equal(next.proof(id(1)).status, "missing"); assert.equal(h.executions(), 0); await next.close();
});


test("known pre-spawn and explicit process creation failures persist never_started evidence", windows, async t => {
  const h = await fixture(t);
  h.cfg.profiles.fake!.command = join(h.root, "definitely-missing.exe");
  assert.equal((await h.request("/v1/runs", h.body(1))).status, 202);
  await h.waitFor(1, "fenced_never_started");
  h.cfg.profiles.fake!.command = process.execPath;
  h.cfg.profiles.fake!.cwd = join(h.root, "missing-directory");
  assert.equal((await h.request("/v1/runs", h.body(2))).status, 202);
  await h.waitFor(2, "fenced_never_started");
  assert.equal(h.executions(), 0);
  await h.reopen();
  assert.equal((await h.proof(1)).status, "fenced_never_started");
  assert.equal((await h.proof(2)).status, "fenced_never_started");
});


test("failed close-evidence commit cannot publish stale capability/proof or release admission capacity", windows, async t => {
  const h = await fixture(t);
  const sync = fs.fsyncSync; let count = 0;
  t.mock.method(fs, "fsyncSync", (fd: number) => { if (++count === 3) throw new Error("injected close-evidence fsync"); sync(fd); });
  assert.equal((await h.request("/v1/runs", h.body(1))).status, 202);
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const list = (await h.request("/v1/runs")).body as unknown as { state: string }[];
    if (list[0]?.state === "finished") break;
    await delay(10);
  }
  assert.equal(((await h.request("/v1/runs")).body as unknown as { state: string }[])[0]?.state, "finished", "direct child can finish even when durable evidence fails");
  t.mock.restoreAll();
  const health = await h.request("/v1/health");
  assert.equal(health.status, 500); assert.equal(health.body.capabilities, undefined);
  assert.equal((await h.request("/v1/runs/" + id(1) + "/proof")).status, 500);
  assert.equal((await h.request("/v1/runs", h.body(2))).status, 500, "isFinished cannot release a poisoned ledger's admission barrier");
  assert.equal(h.executions(), 1);
});
