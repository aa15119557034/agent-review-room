import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomInt } from "node:crypto";
import { createServer } from "node:http";
import { createServer as createTcpServer, connect, type Server as TcpServer, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { attachmentImageBlock, attachmentImageSlotMarker, attachmentManifestBlock, type AgentEvent } from "@room/schemas";
// 集成测试：直接使用真实的 AgentServer（测试专用的相对路径引用）
import { ServerConfig } from "../../../apps/agent-server/src/config";
import { createAgentServer, type AgentServer } from "../../../apps/agent-server/src/server";
import { HttpRemoteAgentAdapter, testReviewerNode } from "../src/index";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE = join(here, "../../../apps/agent-server/test/fixtures/fake-claude.mjs");
const TOKEN = "t".repeat(48);
const ULID = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ulid = () => Array.from({ length: 26 }, () => ULID[randomInt(32)]).join("");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

const cleanups: (() => Promise<void> | void)[] = [];
after(async () => {
  for (const c of cleanups.reverse()) await c();
});

// ---------------------------------------------------------------- 可以"拔网线"的 TCP 代理

class CuttableProxy {
  private sockets = new Set<Socket>();
  private refusing = false;
  readonly server: TcpServer;
  constructor(private targetPort: number) {
    this.server = createTcpServer((client) => {
      if (this.refusing) return client.destroy();
      const upstream = connect(this.targetPort, "127.0.0.1");
      for (const s of [client, upstream]) {
        this.sockets.add(s);
        s.on("close", () => this.sockets.delete(s));
        s.on("error", () => {});
      }
      client.pipe(upstream).pipe(client);
    });
  }
  async listen(): Promise<number> {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", () => r()));
    return (this.server.address() as AddressInfo).port;
  }
  /** 断开所有连接，并在 ms 毫秒内拒绝新连接 */
  async cut(ms: number) {
    this.refusing = true;
    for (const s of this.sockets) s.destroy();
    await sleep(ms);
    this.refusing = false;
  }
  close() {
    for (const s of this.sockets) s.destroy();
    return new Promise<void>((r) => this.server.close(() => r()));
  }
}

// ---------------------------------------------------------------- 环境

async function setup(opts: { leaseMs?: number; heartbeatMs?: number; grace?: number; hbTimeout?: number } = {}) {
  const profile = (mode: string, extra: Record<string, string> = {}) => ({
    command: process.execPath,
    args: [FAKE],
    cwd: here,
    parser: "claude-stream-json",
    env: { FAKE_MODE: mode, ...extra },
  });
  const cfg = ServerConfig.parse({
    nodeId: "node-test",
    leaseMs: opts.leaseMs ?? 1500,
    heartbeatMs: opts.heartbeatMs ?? 150,
    killGraceMs: 200,
    maxConcurrentRuns: 4,
    profiles: {
      "claude-ok": profile("success"),
      "claude-slow": profile("slow", { FAKE_CHUNKS: "15", FAKE_DELAY_MS: "100" }),
      "claude-long": profile("slow", { FAKE_CHUNKS: "200", FAKE_DELAY_MS: "100" }),
      "claude-truncated": profile("truncated"),
    },
  });
  const agent: AgentServer = createAgentServer(cfg, TOKEN);
  await new Promise<void>((r) => agent.server.listen(0, "127.0.0.1", () => r()));
  const serverPort = (agent.server.address() as AddressInfo).port;
  const proxy = new CuttableProxy(serverPort);
  const port = await proxy.listen();
  cleanups.push(() => proxy.close(), () => agent.close());

  const adapter = (profileId: string, token = TOKEN, extra: Partial<ConstructorParameters<typeof HttpRemoteAgentAdapter>[0]> = {}) =>
    new HttpRemoteAgentAdapter({
      nodeId: "node-test",
      baseUrl: `http://127.0.0.1:${port}`,
      profileId,
      token,
      heartbeatTimeoutMs: opts.hbTimeout ?? 600,
      reconnectGraceMs: opts.grace ?? 3000,
      requestTimeoutMs: 2000,
      reconnectDelayMs: 100,
      ...extra,
    });
  return { agent, proxy, port, adapter, serverPort };
}

function input(content = "请审查这段代码") {
  return { snapshotId: "snap_" + ulid(), content, contentHash: sha(content) };
}

async function collect(
  a: HttpRemoteAgentAdapter,
  opts: { signal?: AbortSignal; during?: (events: AgentEvent[]) => Promise<void> | void; inp?: ReturnType<typeof input>; runId?: string } = {},
) {
  const events: AgentEvent[] = [];
  const runId = (opts.runId ?? "run_" + ulid()) as `run_${string}`;
  for await (const e of a.run("s", runId as never, opts.inp ?? input(), {
    signal: opts.signal ?? new AbortController().signal,
    onPermissionRequest: async () => ({ decision: "deny", decidedBy: "system" }),
    idleTimeoutMs: 10_000,
    totalTimeoutMs: 30_000,
  })) {
    events.push(e);
    await opts.during?.(events);
  }
  return { events, runId };
}

const TERMINAL = ["completed", "error", "cancelled", "timed_out"];
const terminals = (es: AgentEvent[]) => es.filter((e) => TERMINAL.includes(e.type));
const text = (es: AgentEvent[]) => es.flatMap((e) => (e.type === "message_delta" ? [e.text] : [])).join("");
const finalText = (es: AgentEvent[]) => es.find((e) => e.type === "message_complete");
function assertWellFormed(es: AgentEvent[]) {
  es.forEach((e, i) => assert.equal(e.seq, i, "seq strictly increasing from 0"));
  assert.equal(terminals(es).length, 1, "exactly one terminal event");
  assert.ok(TERMINAL.includes(es.at(-1)!.type), "terminal event is last");
}

// ---------------------------------------------------------------- 测试

describe("HttpRemoteAgentAdapter", () => {
  it("runs end to end: streamed text, authoritative message, completed", async () => {
    const { adapter } = await setup();
    const a = adapter("claude-ok");
    assert.deepEqual(await a.initialize(), { streaming: true, permissionRequests: false, readOnly: true });
    const inp = input("请审查：并发写入");
    const { events } = await collect(a, { inp });
    assertWellFormed(events);
    const expected = `收到 ${inp.content.length} 个字符。风险😀：并发写入。`;
    assert.equal(text(events), expected);
    assert.equal(finalText(events)?.type === "message_complete" && finalText(events)?.text, expected);
    assert.equal(events.at(-1)?.type, "completed");
    assert.equal(events[0]?.type === "status" && events[0].substate, "active");
  });

  it("refuses to send when content and hash disagree (no network call)", async () => {
    let calls = 0;
    const { adapter } = await setup();
    const a = adapter("claude-ok", TOKEN, { fetchImpl: (...args) => (calls++, fetch(...args)) });
    const { events } = await collect(a, { inp: { snapshotId: "snap_" + ulid(), content: "a", contentHash: sha("b") } });
    assertWellFormed(events);
    assert.equal(events[0]?.type === "error" && events[0].reason, "hash_mismatch");
    assert.equal(calls, 0);
  });

  it("a truncated reviewer stream becomes error(incomplete_output), never completed", async () => {
    const { adapter } = await setup();
    const { events } = await collect(adapter("claude-truncated"));
    assertWellFormed(events);
    assert.ok(text(events).length > 0);
    assert.equal(finalText(events), undefined);
    const t = events.at(-1)!;
    assert.equal(t.type === "error" && t.reason, "incomplete_output");
  });

  it("wrong token / unknown profile are rejected with a clear message", async () => {
    const { adapter } = await setup();
    const bad = await collect(adapter("claude-ok", "x".repeat(40)));
    assertWellFormed(bad.events);
    const t1 = bad.events.at(-1)!;
    assert.ok(t1.type === "error" && t1.reason === "remote_rejected" && /Token/.test(t1.message ?? ""));
    const unknown = await collect(adapter("nope"));
    const t2 = unknown.events.at(-1)!;
    assert.ok(t2.type === "error" && t2.reason === "remote_rejected" && /nope/.test(t2.message ?? ""));
  });

  it("unreachable node ends as connection_lost after retrying the start", async () => {
    const a = new HttpRemoteAgentAdapter({
      nodeId: "x", baseUrl: "http://127.0.0.1:9", profileId: "claude-ok", token: TOKEN,
      heartbeatTimeoutMs: 500, reconnectGraceMs: 1000, requestTimeoutMs: 500, reconnectDelayMs: 20,
    });
    const { events } = await collect(a);
    assertWellFormed(events);
    const t = events.at(-1)!;
    assert.ok(t.type === "error" && t.reason === "connection_lost" && /无法连接/.test(t.message ?? ""));
  });

  it("reconnects after a short network cut without losing or duplicating text", async () => {
    const { adapter, proxy } = await setup({ leaseMs: 1500, grace: 3000, hbTimeout: 600 });
    let cut = false;
    const { events } = await collect(adapter("claude-slow"), {
      during: async (es) => {
        if (!cut && es.filter((e) => e.type === "message_delta").length === 4) {
          cut = true;
          void proxy.cut(500); // 500ms 内拒绝连接：小于节点租约 1500ms，节点继续跑
        }
      },
    });
    assertWellFormed(events);
    const subs = events.flatMap((e) => (e.type === "status" ? [e.substate] : []));
    assert.deepEqual(subs, ["active", "disconnected", "active"], `status sequence ${subs}`);
    const expected = Array.from({ length: 15 }, (_, i) => `第${i}段；`).join("");
    assert.equal(text(events), expected, "deltas after reconnect: no loss, no duplicates");
    assert.equal(finalText(events)?.type === "message_complete" && finalText(events)?.text, expected);
    assert.equal(events.at(-1)?.type, "completed");
  });

  it("a cut longer than the node lease: node stops itself, adapter reports lease_expired after reconnecting", async () => {
    const { adapter, proxy } = await setup({ leaseMs: 600, grace: 4000, hbTimeout: 400 });
    let cut = false;
    const { events } = await collect(adapter("claude-long"), {
      during: async (es) => {
        if (!cut && es.some((e) => e.type === "message_delta")) {
          cut = true;
          void proxy.cut(1500);
        }
      },
    });
    assertWellFormed(events);
    const t = events.at(-1)!;
    assert.equal(t.type === "error" && t.reason, "lease_expired");
  });

  it("a cut longer than the grace period ends as connection_lost (node has already stopped)", async () => {
    const { adapter, proxy, agent } = await setup({ leaseMs: 500, grace: 1200, hbTimeout: 300 });
    let cut = false;
    const { events, runId } = await collect(adapter("claude-long"), {
      during: async (es) => {
        if (!cut && es.some((e) => e.type === "message_delta")) {
          cut = true;
          void proxy.cut(3000);
        }
      },
    });
    assertWellFormed(events);
    const t = events.at(-1)!;
    assert.equal(t.type === "error" && t.reason, "connection_lost");
    // 不会出现"本地判失败、节点还在跑"：节点上的 run 已经结束
    const list = await (await fetch(`http://127.0.0.1:${(agent.server.address() as AddressInfo).port}/v1/runs`, { headers: { authorization: `Bearer ${TOKEN}` } })).json() as { runId: string; state: string }[];
    assert.equal(list.find((r) => r.runId === runId)?.state, "finished");
  });

  it("cancel via AbortSignal is confirmed by the node", async () => {
    const { adapter } = await setup();
    const ac = new AbortController();
    const { events } = await collect(adapter("claude-long"), {
      signal: ac.signal,
      during: (es) => {
        if (es.filter((e) => e.type === "message_delta").length === 2) ac.abort();
      },
    });
    assertWellFormed(events);
    const t = events.at(-1)!;
    assert.equal(t.type, "cancelled");
    assert.equal(t.type === "cancelled" && t.reason, "用户取消", "confirmed by node, not 'unconfirmed'");
  });

  it("if the consumer stops reading, the node is told to cancel (no background quota use)", async () => {
    const { adapter, serverPort } = await setup();
    const a = adapter("claude-long");
    const runId = "run_" + ulid();
    let n = 0;
    for await (const e of a.run("s", runId as never, input(), {
      signal: new AbortController().signal,
      onPermissionRequest: async () => ({ decision: "deny", decidedBy: "system" }),
      idleTimeoutMs: 10_000,
      totalTimeoutMs: 30_000,
    })) {
      if (e.type === "message_delta" && ++n === 2) break;
    }
    await sleep(800);
    const list = await (await fetch(`http://127.0.0.1:${serverPort}/v1/runs`, { headers: { authorization: `Bearer ${TOKEN}` } })).json() as { runId: string; state: string }[];
    assert.equal(list.find((r) => r.runId === runId)?.state, "finished");
  });

  it("initialize refuses an unsafe lease/grace configuration", async () => {
    const { adapter } = await setup({ leaseMs: 5000 });
    await assert.rejects(adapter("claude-ok", TOKEN, { reconnectGraceMs: 3000 }).initialize(), /租约/);
  });

  it("reconcile finds orphans on the node and runs the node no longer knows", async () => {
    const { adapter } = await setup();
    const a = adapter("claude-long");
    const ac = new AbortController();
    const runId = "run_" + ulid();
    const it = a.run("s", runId as never, input(), {
      signal: ac.signal,
      onPermissionRequest: async () => ({ decision: "deny", decidedBy: "system" }),
      idleTimeoutMs: 10_000,
      totalTimeoutMs: 30_000,
    })[Symbol.asyncIterator]();
    await it.next();
    await it.next();
    const report = await a.reconcile(["run_" + ulid()] as never);
    assert.deepEqual(report.orphansOnNode, [runId]);
    assert.equal(report.missingOnNode.length, 1);
    ac.abort();
    while (!(await it.next()).done) {}
  });
});

describe("testReviewerNode (settings page)", () => {
  it("reports reachable / profile / unauthorized / no token / unreachable", async () => {
    const { port } = await setup();
    const baseUrl = `http://127.0.0.1:${port}`;
    const ok = await testReviewerNode({ baseUrl, token: TOKEN, profileId: "claude-ok" });
    assert.equal(ok.reachable && ok.profileAvailable, true);
    assert.equal(ok.reachable && ok.health.nodeId, "node-test");
    const missing = await testReviewerNode({ baseUrl, token: TOKEN, profileId: "nope" });
    assert.equal(missing.reachable && missing.profileAvailable, false);
    const bad = await testReviewerNode({ baseUrl, token: "y".repeat(40), profileId: "claude-ok" });
    assert.equal(!bad.reachable && bad.error, "unauthorized");
    const none = await testReviewerNode({ baseUrl, token: null, profileId: "claude-ok" });
    assert.equal(!none.reachable && none.error, "no_token");
    const down = await testReviewerNode({ baseUrl: "http://127.0.0.1:9", token: TOKEN, profileId: "claude-ok", timeoutMs: 500 });
    assert.equal(!down.reachable && down.error, "unreachable");
  });
});

describe("C-40 StartRun.model", () => {
  it("model 原样放进 StartRun；没有 model 时字段整个省略", async () => {
    const bodies: Record<string, unknown>[] = [];
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        if (req.method === "POST" && req.url === "/v1/runs") {
          const body = JSON.parse(raw) as Record<string, unknown>;
          bodies.push(body);
          res.writeHead(202, { "content-type": "application/json" });
          res.end(JSON.stringify({ runId: body.runId, status: "accepted", eventsPath: "/v1/runs/" + String(body.runId) + "/events" }));
          return;
        }
        if (req.method === "GET" && req.url?.includes("/events")) {
          res.writeHead(200, { "content-type": "application/x-ndjson" });
          res.write(JSON.stringify({ type: "terminal", seq: 0, ts: new Date().toISOString(), result: { outcome: "completed", exitCode: 0 } }) + "\n");
          res.end();
          return;
        }
        res.writeHead(404);
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as AddressInfo).port;
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));

    const make = (model?: { model: string; effort: string | null }) =>
      new HttpRemoteAgentAdapter({
        nodeId: "node-test",
        baseUrl: "http://127.0.0.1:" + port,
        profileId: "claude-ok",
        token: TOKEN,
        heartbeatTimeoutMs: 1_000,
        reconnectGraceMs: 3_000,
        requestTimeoutMs: 1_000,
        ...(model === undefined ? {} : { model }),
      });

    const withModel = make({ model: "deepseek-flash", effort: "high" });
    const content = "hello";
    for await (const _event of withModel.run("s", ("run_" + ulid()) as never, { snapshotId: "snap_" + ulid(), content, contentHash: sha(content) } as never, {
      signal: new AbortController().signal,
      onPermissionRequest: async () => ({ decision: "deny", decidedBy: "system" }),
      idleTimeoutMs: 10_000,
      totalTimeoutMs: 20_000,
    })) {
      // 只需要触发一次 StartRun
    }
    assert.deepEqual(bodies[0]!.model, { model: "deepseek-flash", effort: "high" });

    const without = make();
    for await (const _event of without.run("s", ("run_" + ulid()) as never, { snapshotId: "snap_" + ulid(), content, contentHash: sha(content) } as never, {
      signal: new AbortController().signal,
      onPermissionRequest: async () => ({ decision: "deny", decidedBy: "system" }),
      idleTimeoutMs: 10_000,
      totalTimeoutMs: 20_000,
    })) {
      // 同上
    }
    assert.equal("model" in bodies[1]!, false);
  });

  it("带图：attachments / imageSlot 原样放进 StartRun；成对、清单、图片块、sha256 有一项不对就一个字都不发（C-42h）", async () => {
    const bodies: Record<string, unknown>[] = [];
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        if (req.method === "POST" && req.url === "/v1/runs") {
          const body = JSON.parse(raw) as Record<string, unknown>;
          bodies.push(body);
          res.writeHead(202, { "content-type": "application/json" });
          res.end(JSON.stringify({ runId: body.runId, status: "accepted", eventsPath: "/v1/runs/" + String(body.runId) + "/events" }));
          return;
        }
        if (req.method === "GET" && req.url?.includes("/events")) {
          res.writeHead(200, { "content-type": "application/x-ndjson" });
          res.write(JSON.stringify({ type: "terminal", seq: 0, ts: new Date().toISOString(), result: { outcome: "completed", exitCode: 0 } }) + "\n");
          res.end();
          return;
        }
        res.writeHead(404);
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as AddressInfo).port;
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const adapter = new HttpRemoteAgentAdapter({
      nodeId: "node-test",
      baseUrl: "http://127.0.0.1:" + port,
      profileId: "claude-ok",
      token: TOKEN,
      heartbeatTimeoutMs: 1_000,
      reconnectGraceMs: 3_000,
      requestTimeoutMs: 1_000,
    });
    const runOnce = async (inp: Record<string, unknown>) => {
      const events: AgentEvent[] = [];
      for await (const e of adapter.run("s", ("run_" + ulid()) as never, inp as never, {
        signal: new AbortController().signal,
        onPermissionRequest: async () => ({ decision: "deny", decidedBy: "system" }),
        idleTimeoutMs: 10_000,
        totalTimeoutMs: 20_000,
      })) events.push(e);
      return events;
    };

    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
    const image = { index: 1, mime: "image/png", bytes: png.length, sha256: createHash("sha256").update(png).digest("hex"), data: png.toString("base64") };
    const nonce = "0123456789abcdef";
    const slot = attachmentImageSlotMarker(nonce);
    const content = attachmentManifestBlock([image] as never) + "历史……\n" + attachmentImageBlock(nonce, 1) + "\n当前消息：看看这张图";
    const good = { snapshotId: "snap_" + ulid(), content, contentHash: sha(content), attachments: [image], imageSlot: slot };

    const ok = await runOnce(good);
    assert.equal(ok.at(-1)!.type, "completed");
    assert.equal(bodies.length, 1);
    assert.deepEqual(bodies[0]!.attachments, [image], "图片原样带上");
    assert.equal(bodies[0]!.imageSlot, slot);
    assert.equal((bodies[0]!.snapshot as { content: string }).content, content, "content 一个字不改");

    // 不带图：两个字段都不出现
    await runOnce({ snapshotId: "snap_" + ulid(), content: "hi", contentHash: sha("hi") });
    assert.equal("attachments" in bodies[1]! || "imageSlot" in bodies[1]!, false);

    const bad: [string, Record<string, unknown>][] = [
      ["只有图没有标记", { ...good, imageSlot: undefined }],
      ["只有标记没有图", { ...good, attachments: undefined }],
      ["sha256 对不上", { ...good, attachments: [{ ...image, sha256: "0".repeat(64) }] }],
      ["bytes 和实际不符", { ...good, attachments: [{ ...image, bytes: 999 }] }],
      ["编号不连续", { ...good, attachments: [image, { ...image, index: 3, sha256: "1".repeat(64) }] }],
      ["content 没有图片资料块", (() => {
        const c = attachmentManifestBlock([image] as never) + "当前消息：看看这张图";
        return { ...good, content: c, contentHash: sha(c) };
      })()],
    ];
    for (const [what, inp] of bad) {
      const events = await runOnce(inp);
      const last = events.at(-1)!;
      assert.equal(last.type, "error", what);
      assert.equal((last as { reason: string }).reason, "hash_mismatch", what);
      assert.match((last as { message: string }).message, /^发送前校验失败：/, what);
      assertWellFormed(events);
    }
    assert.equal(bodies.length, 2, "坏输入一个请求都没发");
  });
});
