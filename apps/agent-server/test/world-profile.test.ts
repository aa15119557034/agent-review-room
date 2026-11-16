import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { NodeHealth, RemoteRunProof, WORLD_PROFILE_RECIPE_DEEPSEEK_HTTP_V1, type StartRunRequest } from "@room/schemas";
import { ServerConfig } from "../src/config";
import { createAgentServer } from "../src/server";
import { RunLedger } from "../src/run-ledger";
import { worldProfiles } from "../src/world-profile";
import { requestHashOf } from "../src/remote-run";

const windows = { skip: process.platform !== "win32" };
const script = fileURLToPath(new URL("../bin/deepseek-chat.mjs", import.meta.url));
const mapping = { profileId: "deepseek-world", sourceChatProfileId: "deepseek-chat", recipeVersion: WORLD_PROFILE_RECIPE_DEEPSEEK_HTTP_V1 };
const model = { model: "deepseek-fixture", effort: "high" };
const id = (n: number) => "run_" + String(n).padStart(26, "0");
const digest = (content: string) => createHash("sha256").update(content).digest("hex");
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function config(root: string, base = "http://127.0.0.1:1") {
  return ServerConfig.parse({ nodeId: "world-fixture", runFenceDir: root, worldProfiles: [mapping], leaseMs: 5000,
    profiles: { "deepseek-chat": { command: process.execPath, args: [script, "--base-url", base, "--model", model.model, "--effort", model.effort], cwd: root,
      parser: "room-jsonl", envAllowlist: [], envFiles: { DEEPSEEK_API_KEY: join(root, "key-fixture") },
      models: [{ id: model.model, displayName: "Fixture", efforts: [{ id: "high", displayName: "High", note: null }], defaultEffort: "high" }],
      modelArgs: ["--model", "{model}"], effortArgs: ["--effort", "{effort}"],
    } },
  });
}
function temp(t: TestContext, cleanup = true) {
  const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "room-world-profile-")));
  fs.writeFileSync(join(root, "key-fixture"), "local-fixture-key-only");
  if (cleanup) t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}

test("fixed recipe preserves source defaults and isolates process environment/cwd", t => {
  const root = temp(t), cfg = config(root), source = cfg.profiles["deepseek-chat"]!;
  source.memory = { dir: "memory/deepseek", provider: "folder" };
  source.env["UNRELATED_SECRET"] = "never-copy";
  source.envAllowlist.push("USERPROFILE", "HOME", "CODEX_HOME");
  const result = worldProfiles(cfg).get(mapping.profileId)!;
  assert.deepEqual(result.capability, { ...mapping, sourceDefaultModel: model });
  assert.equal(result.profile.command, fs.realpathSync.native(process.execPath));
  assert.deepEqual(result.profile.args, ["--input-type=module", "--eval", fs.readFileSync(script, "utf8").replace(/\r\n/g, "\n"), "--", "world-fixed-recipe", "--base-url", "http://127.0.0.1:1", "--max-tokens", "2048"]);
  assert.equal(result.profile.memory, undefined); assert.equal(result.profile.images, undefined);
  assert.deepEqual(result.profile.env, {}); assert.deepEqual(result.profile.envFiles, { DEEPSEEK_API_KEY: join(root, "key-fixture") });
  assert.deepEqual(fs.readdirSync(result.profile.cwd), []);
  assert.ok(!result.profile.envAllowlist.includes("HOME"));
  fs.writeFileSync(join(result.profile.cwd, "AGENTS.md"), "must not run from a nonempty directory");
  assert.equal(worldProfiles(cfg).size, 0);
});

test("unverified sources, wrappers, preload, arguments, mappings and scripts never advertise", async t => {
  for (const variant of ["no-opt-in", "no-ledger", "wrapper", "node-option", "unknown-script", "changed-script", "parser", "modelArgs", "effort-order", "duplicate", "chain", "collision", "recipe", "image-mode", "tokens", "url-key", "preload", "missing-key"] as const) await t.test(variant, t => {
    const root = temp(t), cfg = config(root), p = cfg.profiles["deepseek-chat"]!;
    if (variant === "no-opt-in") delete cfg.worldProfiles;
    if (variant === "no-ledger") delete cfg.runFenceDir;
    if (variant === "wrapper") p.command = "cmd.exe";
    if (variant === "node-option") p.args.unshift("--import", "bait.mjs");
    if (variant === "unknown-script") p.args[0] = join(root, "absent.mjs");
    if (variant === "changed-script") { p.args[0] = join(root, "changed.mjs"); fs.writeFileSync(p.args[0], fs.readFileSync(script, "utf8") + "\n// changed"); }
    if (variant === "parser") p.parser = "raw";
    if (variant === "modelArgs") p.modelArgs.unshift("--import", "hook.mjs");
    if (variant === "effort-order") { p.args.splice(1, 0, "{model-args}"); p.models[0]!.efforts.push({ id: "low", displayName: "Low", note: null }); }
    if (variant === "duplicate") cfg.worldProfiles!.push({ ...mapping });
    if (variant === "chain") cfg.worldProfiles!.push({ ...mapping, profileId: "deepseek-chat", sourceChatProfileId: "another-chat" });
    if (variant === "collision") cfg.profiles[mapping.profileId] = p;
    if (variant === "recipe") cfg.worldProfiles![0]!.recipeVersion = "future-recipe";
    if (variant === "image-mode") p.args.push("--input-format", "content-json");
    if (variant === "tokens") p.args.push("--max-tokens", "999999999");
    if (variant === "url-key") p.args[p.args.indexOf("--base-url") + 1] = "https://secret@example.com";
    if (variant === "preload") p.envAllowlist.push("NODE_OPTIONS");
    if (variant === "missing-key") p.envFiles = {};
    assert.equal(worldProfiles(cfg).size, 0);
  });
});

test("an unverified implicit effort stays unknown, and world identity changes request hash", t => {
  const root = temp(t), cfg = config(root), p = cfg.profiles["deepseek-chat"]!;
  p.args.splice(p.args.indexOf("--effort"), 2);
  assert.equal(worldProfiles(cfg).get(mapping.profileId)!.capability.sourceDefaultModel, null);
  const req = { profileId: mapping.profileId, snapshot: { contentHash: digest("fixture") } } as StartRunRequest;
  const world = { ...req, expectedWorldProfile: { sourceChatProfileId: mapping.sourceChatProfileId, recipeVersion: mapping.recipeVersion } };
  assert.notEqual(requestHashOf(req), requestHashOf(world));
  assert.notEqual(requestHashOf(world), requestHashOf({ ...world, expectedWorldProfile: { ...world.expectedWorldProfile, sourceChatProfileId: "other-chat" } }));
});

async function fixture(t: TestContext) {
  const root = temp(t, false), ledgerDir = join(root, "ledger"); fs.mkdirSync(ledgerDir);
  const requests: { headers: Record<string, unknown>; body: Record<string, unknown> }[] = [];
  const providerErrors: unknown[] = [];
  const provider = createServer((req, res) => { void (async () => {
    assert.equal(req.url, "/chat/completions");
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push({ headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end('data: {"choices":[{"delta":{"content":"fixture reply","tool_calls":[{"function":{"name":"shell","arguments":"bait"}}]},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  })().catch(error => { providerErrors.push(error); res.destroy(); }); });
  let app: ReturnType<typeof createAgentServer>;
  t.after(async () => { await app?.close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); fs.rmSync(root, { recursive: true, force: true }); assert.deepEqual(providerErrors, []); });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  const pa = provider.address(); assert.ok(pa && typeof pa !== "string");
  const cfg = config(root, `http://127.0.0.1:${pa.port}`); cfg.runFenceDir = ledgerDir;
  let ledger = await RunLedger.initialize(ledgerDir);
  const token = "world-fixture-token".repeat(3);
  app = createAgentServer(cfg, token, undefined, { ledger }); let base = "";
  async function listen() { await new Promise<void>(resolve => app.server.listen(0, "127.0.0.1", resolve)); const a = app.server.address(); assert.ok(a && typeof a !== "string"); base = `http://127.0.0.1:${a.port}`; }
  await listen();
  async function request(path: string, data?: unknown) { const res = await fetch(base + path, { headers: { authorization: "Bearer " + token, "content-type": "application/json" }, ...(data === undefined ? {} : { method: "POST", body: JSON.stringify(data) }) }); return { status: res.status, body: await res.json() as Record<string, unknown> }; }
  const body = (n: number, content = "resident " + n): StartRunRequest => ({ protocol: 1, runId: id(n), profileId: mapping.profileId, model,
    expectedLedgerId: ledger.ledgerId, expectedWorldProfile: { sourceChatProfileId: mapping.sourceChatProfileId, recipeVersion: mapping.recipeVersion },
    snapshot: { id: "snap_" + String(n).padStart(26, "0"), content, contentHash: digest(content) }, limits: { idleTimeoutMs: 2000, totalTimeoutMs: 5000 } });
  async function completed(n: number) { const until = Date.now() + 5000; while (Date.now() < until) { const p = RemoteRunProof.parse((await request(`/v1/runs/${id(n)}/proof`)).body); if (p.status === "closed_process") return; await delay(10); } throw new Error("child did not close"); }
  return { root, cfg, request, body, completed, requests, get ledger() { return ledger; }, get ledgerId() { return ledger.ledgerId; }, reopen: async () => { await app.close(); ledger = await RunLedger.open(ledgerDir); app = createAgentServer(cfg, token, undefined, { ledger }); await listen(); } };
}

test("real fixed child sends only current persona and the selected same model to fake provider", windows, async t => {
  const h = await fixture(t), p = h.cfg.profiles["deepseek-chat"]!;
  fs.writeFileSync(join(h.root, "AGENTS.md"), "AGENTS_PRIVATE_BAIT");
  fs.writeFileSync(join(h.root, "memory.txt"), "MEMORY_PRIVATE_BAIT");
  const canary = join(h.root, "preload.cjs"), marker = join(h.root, "preload-executed");
  fs.writeFileSync(canary, "require('node:fs').writeFileSync(" + JSON.stringify(marker) + ", 'bad');");
  const before = process.env["NODE_OPTIONS"];
  process.env["NODE_OPTIONS"] = "--require=" + JSON.stringify(canary);
  t.after(() => { if (before === undefined) delete process.env["NODE_OPTIONS"]; else process.env["NODE_OPTIONS"] = before; });
  p.env["PRIVATE_MEMORY"] = "ENV_PRIVATE_BAIT";
  const health = NodeHealth.parse((await h.request("/v1/health")).body);
  assert.deepEqual(health.capabilities?.worldProfiles, [{ ...mapping, sourceDefaultModel: model }]);
  for (const n of [1, 2]) { assert.equal((await h.request("/v1/runs", h.body(n, "persona-" + n))).status, 202); await h.completed(n); }
  assert.equal(h.requests.length, 2);
  for (const [i, req] of h.requests.entries()) {
    assert.equal(req.headers.authorization, "Bearer local-fixture-key-only");
    assert.deepEqual(req.body, { model: model.model, reasoning_effort: model.effort, messages: [{ role: "user", content: "persona-" + (i + 1) }], stream: true, max_tokens: 2048 });
  }
  assert.equal(fs.existsSync(marker), false);
  assert.deepEqual(fs.readdirSync(join(h.cfg.runFenceDir!, "world-empty")), []);
});

test("world target requires every binding and rejects extra context without spawning", windows, async t => {
  const h = await fixture(t);
  for (const field of ["expectedWorldProfile", "expectedLedgerId", "model"] as const) { const b = h.body(1); delete b[field]; assert.equal((await h.request("/v1/runs", b)).status, 400); }
  for (const extra of [{ chat: { memory: null } }, { kind: "image" }, { snapshot: { ...h.body(1).snapshot, commitSha: "a".repeat(40) } }]) assert.equal((await h.request("/v1/runs", { ...h.body(1), ...extra })).status, 400);
  assert.equal((await h.request("/v1/runs", { ...h.body(1), model: { model: "wrong", effort: null } })).body.error, "unknown_model");
  h.cfg.profiles["ordinary"] = h.cfg.profiles["deepseek-chat"]!;
  assert.equal((await h.request("/v1/runs", { ...h.body(1), profileId: "ordinary" })).body.error, "world_profile_mismatch");
  assert.equal(h.requests.length, 0);
  assert.equal((await h.request(`/v1/runs/${id(1)}/proof`)).body.status, "missing");
});

test("filesystem replacement after admission cannot change the verified child code", windows, async t => {
  const h = await fixture(t), copy = join(h.root, "audited-copy.mjs"), marker = join(h.root, "unreviewed-code-ran");
  fs.copyFileSync(script, copy);
  h.cfg.profiles["deepseek-chat"]!.args[0] = copy;
  const admit = h.ledger.admit.bind(h.ledger);
  h.ledger.admit = (runId, hash) => {
    admit(runId, hash);
    // Model an independent deployment rewriting the source between the final
    // check and Node opening its entry point. Never modify the repository file.
    fs.writeFileSync(copy, "import { writeFileSync } from 'node:fs'; writeFileSync(" + JSON.stringify(marker) + ", 'unreviewed'); process.stdin.resume();");
  };
  assert.equal((await h.request("/v1/runs", h.body(1, "verified-byte-positive-control"))).status, 202);
  await h.completed(1);
  assert.equal(fs.existsSync(marker), false);
  assert.equal(h.requests.length, 1, "the audited code must still execute, not merely suppress every run");
  assert.deepEqual(h.requests[0]!.body, { model: model.model, reasoning_effort: model.effort, messages: [{ role: "user", content: "verified-byte-positive-control" }], stream: true, max_tokens: 2048 });
  assert.equal(NodeHealth.parse((await h.request("/v1/health")).body).capabilities?.worldProfiles?.length ?? 0, 0, "later admission rejects the now changed source file");
});

test("same-ledger restart with ordinary replacement rejects the old world expectation", windows, async t => {
  const h = await fixture(t), old = h.body(1), before = h.ledgerId;
  assert.equal(NodeHealth.parse((await h.request("/v1/health")).body).capabilities?.worldProfiles?.length, 1);
  h.cfg.worldProfiles = [];
  h.cfg.profiles[mapping.profileId] = h.cfg.profiles["deepseek-chat"]!;
  await h.reopen(); assert.equal(h.ledgerId, before);
  const response = await h.request("/v1/runs", old);
  assert.equal(response.status, 409); assert.equal(response.body.error, "world_profile_mismatch");
  assert.equal(h.requests.length, 0); assert.equal((await h.request(`/v1/runs/${id(1)}/proof`)).body.status, "missing");
});
