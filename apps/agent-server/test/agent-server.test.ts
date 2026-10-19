import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomInt } from "node:crypto";
import type { AddressInfo } from "node:net";
import { RemoteEvent, type StartRunRequest } from "@room/schemas";
import { ServerConfig } from "../src/config";
import { createAgentServer, type AgentServer } from "../src/server";

const TOKEN = "t".repeat(40);
const NODE = process.execPath;

const cfg = ServerConfig.parse({
  nodeId: "test-node",
  port: 1,
  maxConcurrentRuns: 2,
  leaseMs: 300,
  heartbeatMs: 100,
  killGraceMs: 200,
  profiles: {
    echo: { command: NODE, args: ["-e", "process.stdin.pipe(process.stdout)"], cwd: process.cwd() },
    sleep: { command: NODE, args: ["-e", "setTimeout(()=>{}, 60000)"], cwd: process.cwd() },
    fail: { command: NODE, args: ["-e", "process.exit(3)"], cwd: process.cwd() },
    silent: {
      command: NODE,
      args: ["-e", "setTimeout(()=>{}, 60000)"],
      cwd: process.cwd(),
      maxIdleTimeoutMs: 1000,
    },
  },
});

let agent: AgentServer;
let base: string;

before(async () => {
  agent = createAgentServer(cfg, TOKEN);
  await new Promise<void>((r) => agent.server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(agent.server.address() as AddressInfo).port}`;
});
after(() => agent.close());

const ULID = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const newRunId = () => "run_" + Array.from({ length: 26 }, () => ULID[randomInt(32)]).join("");
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const auth = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

function body(profileId: string, content = "hello", overrides: Partial<StartRunRequest> = {}) {
  return {
    protocol: 1,
    runId: newRunId(),
    profileId,
    snapshot: { id: "snap_" + newRunId().slice(4), content, contentHash: sha(content) },
    limits: { idleTimeoutMs: 30_000, totalTimeoutMs: 60_000 },
    ...overrides,
  };
}

const start = (b: unknown, headers: Record<string, string> = auth) =>
  fetch(`${base}/v1/runs`, { method: "POST", headers, body: JSON.stringify(b) });

/** 读事件流直到服务端关闭（遇到 terminal 时服务端会关闭），过滤掉 heartbeat */
async function readAll(runId: string, afterSeq = -1): Promise<RemoteEvent[]> {
  const res = await fetch(`${base}/v1/runs/${runId}/events?after=${afterSeq}`, { headers: auth });
  assert.equal(res.status, 200);
  const text = await res.text();
  return text
    .split("\n")
    .filter(Boolean)
    .map((l) => RemoteEvent.parse(JSON.parse(l)))
    .filter((e) => e.type !== "heartbeat");
}

const terminals = (es: RemoteEvent[]) => es.filter((e) => e.type === "terminal");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("auth & validation", () => {
  it("rejects missing token", async () => {
    const res = await start(body("echo"), { "content-type": "application/json" });
    assert.equal(res.status, 401);
  });

  it("rejects wrong token", async () => {
    const res = await start(body("echo"), { ...auth, authorization: "Bearer nope" });
    assert.equal(res.status, 401);
  });

  it("rejects a payload that tries to smuggle a command", async () => {
    const res = await start({ ...body("echo"), command: "rm -rf /" });
    assert.equal(res.status, 400);
  });

  it("rejects unknown profile", async () => {
    const res = await start(body("nope"));
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, "unknown_profile");
  });

  it("rejects hash mismatch before spawning", async () => {
    const b = body("echo", "real content");
    b.snapshot.contentHash = sha("something else");
    const res = await start(b);
    assert.equal(res.status, 422);
    assert.equal((await res.json()).error, "hash_mismatch");
  });
});

describe("run lifecycle", () => {
  it("streams stdin back as output and ends with exactly one completed terminal (UTF-8 safe)", async () => {
    const content = "请审查这段代码。".repeat(5000); // 足够大，会被切成多个 chunk
    const b = body("echo", content);
    assert.equal((await start(b)).status, 202);
    const events = await readAll(b.runId);
    assert.equal(events[0]?.type, "started");
    const out = events.flatMap((e) => (e.type === "output" ? [e.data] : [])).join("");
    assert.equal(out, content);
    assert.equal(terminals(events).length, 1);
    assert.deepEqual(events.at(-1), { ...events.at(-1), type: "terminal", result: { outcome: "completed", exitCode: 0 } });
    events.forEach((e, i) => assert.equal((e as { seq: number }).seq, i));
  });

  it("is idempotent on runId and rejects conflicting reuse", async () => {
    const b = body("echo");
    assert.equal((await start(b)).status, 202);
    const again = await start(b);
    assert.equal(again.status, 200);
    assert.equal((await again.json()).status, "already_exists");
    const conflict = await start({ ...b, snapshot: { ...b.snapshot, content: "x", contentHash: sha("x") } });
    assert.equal(conflict.status, 409);
    await readAll(b.runId);
  });

  it("reports non-zero exit as error", async () => {
    const b = body("fail");
    await start(b);
    const [t] = terminals(await readAll(b.runId));
    assert.equal(t?.type === "terminal" && t.result.outcome, "error");
    assert.deepEqual(t?.type === "terminal" && t.result, { outcome: "error", reason: "process_exit_nonzero", exitCode: 3 });
  });

  it("cancels a running process", async () => {
    const b = body("sleep");
    await start(b);
    const reading = readAll(b.runId);
    await sleep(100);
    const c = await fetch(`${base}/v1/runs/${b.runId}/cancel`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ reason: "user" }),
    });
    assert.equal(c.status, 202);
    const ts = terminals(await reading);
    assert.equal(ts.length, 1);
    assert.deepEqual(ts[0]?.type === "terminal" && ts[0].result, { outcome: "cancelled", reason: "user" });
  });

  it("times out on idle", async () => {
    const b = body("silent");
    b.limits.idleTimeoutMs = 5_000; // 节点会被 profile.maxIdleTimeoutMs=1000 截断
    await start(b);
    const ts = terminals(await readAll(b.runId));
    assert.deepEqual(ts[0]?.type === "terminal" && ts[0].result, { outcome: "timed_out", kind: "idle" });
  });
});

describe("network failure semantics", () => {
  it("kills the run when nobody is subscribed for leaseMs, and still delivers the terminal later", async () => {
    const b = body("sleep");
    await start(b);
    await sleep(cfg.leaseMs + 400); // 从不订阅 → 租约过期
    const ts = terminals(await readAll(b.runId));
    assert.equal(ts.length, 1);
    assert.deepEqual(ts[0]?.type === "terminal" && ts[0].result, {
      outcome: "error",
      reason: "lease_expired",
      exitCode: null,
    });
  });

  it("replays missed events on reconnect with ?after=", async () => {
    const b = body("echo", "abc");
    await start(b);
    const all = await readAll(b.runId);
    const resumed = await readAll(b.runId, 0);
    assert.deepEqual(resumed, all.slice(1));
  });

  it("sends heartbeats while a run is quiet", async () => {
    const b = body("sleep");
    await start(b);
    const ac = new AbortController();
    const res = await fetch(`${base}/v1/runs/${b.runId}/events`, { headers: auth, signal: ac.signal });
    const reader = res.body!.getReader();
    let text = "";
    const deadline = Date.now() + 1000;
    while (!text.includes('"heartbeat"') && Date.now() < deadline) {
      const { value } = await reader.read();
      text += new TextDecoder().decode(value);
    }
    ac.abort();
    assert.match(text, /"type":"heartbeat"/);
    await fetch(`${base}/v1/runs/${b.runId}/cancel`, { method: "POST", headers: auth, body: "{}" });
  });

  it("refuses new runs beyond maxConcurrentRuns", async () => {
    await sleep(cfg.killGraceMs + 300); // 等前面的 run 完全退出
    const a = body("sleep");
    const c = body("sleep");
    const d = body("sleep");
    assert.equal((await start(a)).status, 202);
    assert.equal((await start(c)).status, 202);
    const busy = await start(d);
    assert.equal(busy.status, 429);
    for (const r of [a, c]) {
      await fetch(`${base}/v1/runs/${r.runId}/cancel`, { method: "POST", headers: auth, body: "{}" });
      await readAll(r.runId);
    }
  });
});
