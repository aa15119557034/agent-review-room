import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import { NodeHealth, ProjectResearchRemoteEvent, RemoteEvent, StructuredRemoteEvent, type StartRunRequest } from "@room/schemas";
import { ServerConfig } from "../src/config";
import { createAgentServer } from "../src/server";
import { RoomJsonlParser } from "../src/parsers/room-jsonl";

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const id = () => randomBytes(13).toString("hex").toUpperCase();
const TOKEN = "test-controller-".repeat(3), KEY = "test-provider-secret-do-not-echo";
const TEXT = "# 原件 😀\n网页正文；搜索摘要不是这份原文。\n";
const auth = { authorization: "Bearer " + TOKEN, "content-type": "application/json" };

async function harness(mode = "ok") {
  const seen: { path: string; body: Record<string, unknown> }[] = [];
  let fetchReached!: () => void;
  const reached = new Promise<void>((resolve) => { fetchReached = resolve; });
  let held: ServerResponse | undefined;
  const provider = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text) as Record<string, unknown>;
    seen.push({ path: req.url!, body });
    assert.equal(req.headers.authorization, "Bearer " + KEY);
    if (req.url === "/v1/tools/search") {
      if (mode === "402" || mode === "429") return void res.writeHead(Number(mode)).end(KEY);
      if (mode === "bad-json") return void res.end("{broken");
      if (mode === "empty") return void res.end(JSON.stringify({ results: [] }));
      const url = mode === "private" ? "http://127.0.0.1/secrets" : "https://example.com/source";
      res.end(JSON.stringify({ results: [{ title: "<script>bad()</script>", url, summary: "Never use this as original", content: "ignored search content" }] }));
    } else {
      fetchReached();
      if (mode === "hold") { held = res; return; }
      if (mode === "404") return void res.writeHead(404).end(KEY);
      if (mode === "redirect") return void res.writeHead(302, { location: "http://127.0.0.1/secret" }).end();
      res.end(JSON.stringify({ title: mode === "unicode-title" ? "a".repeat(499) + "🧪结尾" : "<b>原始标题</b>", content: mode === "blank" ? " " : mode === "large" ? "x".repeat(512 * 1024 + 1) : mode === "unicode-large" ? "🧪".repeat(131073) : TEXT }));
    }
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const providerUrl = "http://127.0.0.1:" + (provider.address() as AddressInfo).port;
  const cfg = ServerConfig.parse({
    nodeId: "test-search", maxConcurrentRuns: 1, leaseMs: 2000, heartbeatMs: 100, killGraceMs: 100,
    profiles: {
      research: { command: process.execPath, args: [fileURLToPath(new URL("../bin/deepseek-search-fetch.mjs", import.meta.url)), "--base-url", providerUrl], cwd: process.cwd(), parser: "room-jsonl", searchFetch: "deepseek-v1", env: { DEEPSEEK_API_KEY: KEY } },
      legacy: { command: process.execPath, args: ["-e", "process.stdin.pipe(process.stdout)"], cwd: process.cwd() },
      unsolicited: { command: process.execPath, args: ["-e", `if (process.env.ROOM_STRUCTURED_RESULTS_VERSION) throw Error('configuration forged negotiation'); process.stdout.write(${JSON.stringify(JSON.stringify({ type: "done", text: "must not complete" }) + "\n" + JSON.stringify({ type: "result_display", result: { version: 1, block: { kind: "unsupported", originalKind: "test", reason: "unknown_display_kind" } } }) + (mode === "trailing" ? "" : "\n"))});`], cwd: process.cwd(), parser: "room-jsonl", env: { ROOM_STRUCTURED_RESULTS_VERSION: "1" } },
    },
  });
  const agent = createAgentServer(cfg, TOKEN);
  await new Promise<void>((resolve) => agent.server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + (agent.server.address() as AddressInfo).port;
  const input = (query = "测试公开资料"): StartRunRequest => ({ protocol: 1, runId: "run_" + id(), profileId: "research", structuredResults: { version: 1 }, snapshot: { id: "snap_" + id(), content: query, contentHash: sha(query) }, limits: { idleTimeoutMs: 10_000, totalTimeoutMs: 20_000 } });
  const start = (request: unknown) => fetch(base + "/v1/runs", { method: "POST", headers: auth, body: JSON.stringify(request) });
  const read = async (runId: string, after = -1, research = false) => {
    const res = await fetch(`${base}/v1/runs/${runId}/events?after=${after}`, { headers: auth });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(!text.includes(KEY));
    return text.split("\n").filter(Boolean).map((line) => (research ? ProjectResearchRemoteEvent : StructuredRemoteEvent).parse(JSON.parse(line))).filter((event) => event.type !== "heartbeat");
  };
  return { base, input, start, read, seen, reached, close: async () => { held?.destroy(); await agent.close(); provider.closeAllConnections(); await new Promise<void>((resolve) => provider.close(() => resolve())); } };
}

it("negotiates a project Search/Fetch run and returns original body, exact citation and observed usage once", async () => {
  const h = await harness();
  try {
    const health = NodeHealth.parse(await (await fetch(h.base + "/v1/health", { headers: auth })).json());
    assert.deepEqual(health.capabilities?.structuredResults, { version: 1, profiles: ["research"] });
    const request = h.input();
    assert.equal((await h.start(request)).status, 202);
    assert.equal((await h.start(request)).status, 200);
    assert.equal((await h.start({ ...request, structuredResults: undefined })).status, 409);
    const events = await h.read(request.runId);
    assert.equal(events[0]!.type, "started");
    assert.equal(events.filter((e) => e.type === "terminal").length, 1);
    const terminal = events.at(-1)!;
    assert.ok(terminal.type === "terminal" && terminal.result.outcome === "completed");
    assert.deepEqual(events.filter((e) => e.type === "message_complete").map((e) => e.text), [TEXT]);
    const blocks = events.flatMap((e) => e.type === "result_display" ? [e.result.block] : []);
    const citation = blocks.find((b) => b.kind === "citation");
    assert.equal(citation?.kind, "citation");
    if (citation?.kind === "citation") { assert.equal(citation.title, "<b>原始标题</b>"); assert.equal(citation.source.contentHash, sha(TEXT)); assert.equal(citation.source.version, sha(TEXT)); assert.equal(citation.source.status, "readable"); }
    const usage = blocks.find((b) => b.kind === "usage");
    if (usage?.kind !== "usage") assert.fail("missing usage");
    assert.deepEqual(usage.toolCalls, { status: "measured", value: 2 });
    assert.equal(usage.cost.status, "unknown");
    assert.equal(usage.inputTokens.status, "unknown");
    assert.deepEqual(h.seen, [{ path: "/v1/tools/search", body: { query: "测试公开资料", count: 1, need_content: false } }, { path: "/v1/tools/fetch", body: { url: "https://example.com/source" } }]);
    assert.deepEqual(await h.read(request.runId, 1), events.filter((e) => "seq" in e && e.seq > 1));
    assert.equal(h.seen.length, 2, "replay never reissues HTTP tools");
  } finally { await h.close(); }
});

it("research opt-in emits verified original before citation/usage and binds replay to mode and snapshot", async () => {
  const h = await harness("unicode-title");
  try {
    const health = NodeHealth.parse(await (await fetch(h.base + "/v1/health", { headers: auth })).json());
    assert.deepEqual(health.capabilities?.projectResearch, { version: 1, profiles: ["research"] });
    const request = { ...h.input("🧪".repeat(128)), projectResearch: { version: 1 } };
    assert.equal((await h.start(request)).status, 202);
    const events = await h.read(request.runId, -1, true);
    const complete = ProjectResearchRemoteEvent.parse(events.find((e) => e.type === "message_complete"));
    assert.ok(complete.type === "message_complete" && complete.source !== null);
    assert.equal(complete.text, TEXT);
    assert.equal(complete.source.contentHash, sha(TEXT));
    const citation = events.find((e) => e.type === "result_display" && e.result.block.kind === "citation");
    assert.ok(citation?.type === "result_display" && citation.result.block.kind === "citation");
    assert.ok(citation.seq > complete.seq);
    assert.equal(citation.result.block.title, "a".repeat(499));
    const usage = events.find((e) => e.type === "result_display" && e.result.block.kind === "usage");
    assert.ok(usage && usage.seq > citation.seq);
    assert.equal((await h.start(request)).status, 200);
    assert.equal((await h.start({ ...request, projectResearch: undefined })).status, 409);
    assert.equal((await h.start({ ...request, snapshot: { ...request.snapshot, id: "snap_" + id() } })).status, 409);
    assert.deepEqual(await h.read(request.runId, complete.seq, true), events.filter((event) => event.seq > complete.seq));
    assert.equal(h.seen.length, 2);
  } finally { await h.close(); }
});

for (const mode of ["empty", "404", "private", "unicode-large"]) {
  it(`research ${mode} reports no invented original and retains actual failed-call usage`, async () => {
    const h = await harness(mode);
    try {
      const request = { ...h.input(), projectResearch: { version: 1 } };
      assert.equal((await h.start(request)).status, 202);
      const events = await h.read(request.runId, -1, true);
      const complete = events.find((e) => e.type === "message_complete");
      if (mode === "empty") assert.ok(complete && "source" in complete && complete.source === null);
      else assert.equal(complete, undefined);
      assert.equal(events.some((e) => e.type === "result_display" && e.result.block.kind === "citation" && e.result.block.source.status === "readable"), false);
      const usage = events.find((e) => e.type === "result_display" && e.result.block.kind === "usage");
      assert.ok(usage?.type === "result_display" && usage.result.block.kind === "usage");
      assert.deepEqual(usage.result.block.toolCalls, { status: "measured", value: mode === "empty" || mode === "private" ? 1 : 2 });
      if (mode === "private") assert.ok(events.some((e) => e.type === "result_display" && e.result.block.kind === "tool_step" && e.result.block.stepId === "fetch" && e.result.block.status === "failed"));
    } finally { await h.close(); }
  });
}

it("research parser requires one original metadata record, including explicit null for empty results", () => {
  for (const done of [{ type: "done", text: "legacy" }, { type: "done", text: "x", source: {} }]) {
    const parser = new RoomJsonlParser(true);
    parser.push(JSON.stringify(done) + "\n");
    assert.equal(parser.finish().verdict.ok, false);
  }
  const parser = new RoomJsonlParser(true);
  parser.push(JSON.stringify({ type: "done", text: "empty", source: null }) + "\n");
  parser.push(JSON.stringify({ type: "done", text: "second", source: null }) + "\n");
  assert.equal(parser.finish().verdict.ok, false);
});

for (const mode of ["newline", "trailing"]) {
  it(`rejects unsolicited ${mode} display data even after done; local env cannot forge negotiation`, async () => {
    const h = await harness(mode);
    try {
      const request = { ...h.input(), profileId: "unsolicited", structuredResults: undefined };
      assert.equal((await h.start(request)).status, 202);
      const events = await h.read(request.runId), terminal = events.at(-1)!;
      assert.ok(terminal.type === "terminal" && terminal.result.outcome === "error");
      if (terminal.type === "terminal" && terminal.result.outcome === "error") assert.equal(terminal.result.message, "unnegotiated structured result");
      assert.equal(events.some((event) => event.type === "result_display" || event.type === "message_complete"), false);
      assert.equal(h.seen.length, 0);
    } finally { await h.close(); }
  });
}

it("rejects missing opt-in, unsupported profiles, chats and oversized queries before a paid call; legacy runs stay legacy", async () => {
  const h = await harness();
  try {
    for (const request of [ { ...h.input(), structuredResults: undefined }, { ...h.input(), profileId: "legacy" }, { ...h.input(), chat: { memory: null } }, h.input("x".repeat(129)), h.input("   ") ]) assert.equal((await h.start(request)).status, 400);
    assert.equal(h.seen.length, 0);
    const request = { ...h.input("legacy body"), profileId: "legacy", structuredResults: undefined };
    assert.equal((await h.start(request)).status, 202);
    const events = await h.read(request.runId);
    events.forEach((event) => RemoteEvent.parse(event));
    assert.equal(events.some((event) => event.type === "result_display"), false);
    assert.equal(h.seen.length, 0);
  } finally { await h.close(); }
});

for (const mode of ["empty", "402", "429", "404", "blank", "bad-json", "large", "private", "redirect"]) {
  it(`handles ${mode} without promoting summaries, leaking secrets, retrying or inventing readable content`, async () => {
    const h = await harness(mode);
    try {
      const request = h.input();
      assert.equal((await h.start(request)).status, 202);
      const events = await h.read(request.runId), terminal = events.at(-1)!;
      if (terminal.type !== "terminal") assert.fail("missing terminal");
      assert.equal(terminal.result.outcome, mode === "empty" ? "completed" : "error");
      if (mode === "402" || mode === "429") assert.ok(terminal.result.outcome === "error" && terminal.result.reason === "quota_exhausted");
      assert.equal(events.some((e) => e.type === "result_display" && e.result.block.kind === "citation" && e.result.block.source.status === "readable"), false);
      assert.equal(events.some((e) => e.type === "message_complete" && e.text.includes("Never use")), false);
      assert.equal(h.seen.length, ["404", "blank", "large", "redirect"].includes(mode) ? 2 : 1);
    } finally { await h.close(); }
  });
}

it("shares the existing Run slot and cancels an in-flight Fetch without publishing a late original", async () => {
  const h = await harness("hold");
  try {
    const request = h.input();
    assert.equal((await h.start(request)).status, 202);
    const reading = h.read(request.runId);
    await h.reached;
    assert.equal((await h.start(h.input())).status, 429);
    assert.equal((await fetch(`${h.base}/v1/runs/${request.runId}/cancel`, { method: "POST", headers: auth, body: JSON.stringify({ reason: "user" }) })).status, 202);
    const events = await reading;
    assert.equal(events.filter((e) => e.type === "terminal").length, 1);
    const terminal = events.at(-1)!;
    assert.ok(terminal.type === "terminal" && terminal.result.outcome === "cancelled");
    assert.equal(events.some((e) => e.type === "message_complete"), false);
    assert.equal(events.some((e) => e.type === "result_display" && e.result.block.kind === "citation" && e.result.block.source.status === "readable"), false);
    assert.equal(h.seen.length, 2);
  } finally { await h.close(); }
});

it("rejects malformed or executable structured blocks even if the child subsequently claims done", () => {
  for (const result of [{ version: 2, block: {} }, { version: 1, block: { kind: "execute", command: "whoami" } }, { version: 1, block: { kind: "tool_step", stepId: "x", tool: "x", status: "completed", summary: "x", command: "whoami" } }]) {
    const parser = new RoomJsonlParser();
    assert.deepEqual(parser.push(JSON.stringify({ type: "result_display", result }) + "\n"), []);
    parser.push(JSON.stringify({ type: "done", text: "not success" }) + "\n");
    assert.equal(parser.finish().verdict.ok, false);
  }
});
