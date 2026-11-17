import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { sha256Hex } from "@room/core";
import { openDatabase, readResearchPlan, transitionRun, WriteQueue, type RunRow } from "@room/db";
import { ProjectResearchStartRunRequest, type ControlEvent } from "@room/schemas";
import { Repository } from "../src/main/repository";
import { SettingsStore } from "../src/main/settings";
import { RunOrchestrator } from "../src/main/orchestrator";
import { ProjectResearchService } from "../src/main/project-research";
import { researchResultSink } from "../src/main/research-results";
import { createDispatcher } from "../src/main/ipc";
import { NodeService, resolveRunTarget } from "../src/main/nodes";

const ts = "2026-11-17T01:00:00.000Z", text = "原件\r\n  🧪\n", nodeId = "research-node", baseUrl = "http://127.0.0.1:7419", token = "t".repeat(40);
const source = { source: { kind: "web" as const, url: "https://example.com/source" }, version: sha256Hex(text), contentHash: sha256Hex(text), retrievedAt: ts, status: "readable" as const };
const started = { type: "started" as const, seq: 0, ts };
const original = { type: "message_complete" as const, seq: 2, ts, text, source };
const citation = { type: "result_display" as const, seq: 3, ts, result: { version: 1 as const, block: { kind: "citation" as const, citationId: "source", source } } };
const terminal = { type: "terminal" as const, seq: 4, ts, result: { outcome: "completed" as const, exitCode: 0 as const } };
const health = { protocol: 1, nodeId, profiles: ["research"], activeRuns: 0, maxConcurrentRuns: 1, leaseMs: 20000, heartbeatMs: 5000, capabilities: { structuredResults: { version: 1, profiles: ["research"] }, projectResearch: { version: 1, profiles: ["research"] } } };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
async function fixture(options: { start?: boolean; stream?: unknown[] } = {}) {
  const db = openDatabase(":memory:"), queue = new WriteQueue(), repo = new Repository(db, queue);
  const settings = new SettingsStore(join(mkdtempSync(join(tmpdir(), "room-research-main-")), "settings.json"), { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() });
  await repo.upsertNodeRow({ id: nodeId, label: "Research", baseUrl });
  settings.upsertNode(nodeId, { baseUrl, token });
  const project = await repo.createProject("research");
  const events: ControlEvent[] = [], requests: { path: string; body: unknown }[] = [];
  const finished = deferred<void>();
  let healthWork: () => Promise<unknown> = async () => health;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    requests.push({ path, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (path === "/v1/health") return Response.json(await healthWork());
    if (path.endsWith("/events")) return new Response((options.stream ?? [started, original, original, citation, terminal]).map((e) => JSON.stringify(e)).join("\n") + "\n");
    return new Response(null, { status: 202 });
  }) as typeof fetch;
  let service!: ProjectResearchService;
  const emit = (event: ControlEvent) => { events.push(event); if (event.type === "run.updated" && ["COMPLETED", "FAILED", "CANCELLED"].includes(event.run.state)) finished.resolve(); };
  const orchestrator = new RunOrchestrator({ db, queue, getRun: (id) => db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunRow | undefined, emit, adapterFactory: async (run, signal) => service.createAdapter(run, signal) });
  service = new ProjectResearchService({ db, queue, repo, settings, emit, fetchImpl, orchestrator: options.start ? orchestrator : { start: async () => {} } });
  const dispatcher = createDispatcher({ repo, settings, orchestrator, nodes: new NodeService({ repo, settings }), discussion: {} as never, research: service, appVersion: "test", recoveredRuns: 0, emit });
  const prepare = () => service.prepare({ type: "research.prepare", projectId: project.id, nodeId, profileId: "research", query: "🧪 公开资料" });
  const approve = (preview: Awaited<ReturnType<typeof prepare>>) => service.approve({ type: "research.approve", approvalId: preview.approval.id, expectedSnapshotHash: preview.snapshot.contentHash, expectedResearchHash: preview.researchHash });
  return { db, queue, repo, settings, project, service, orchestrator, dispatcher, events, requests, finished, prepare, approve, setHealth: (work: typeof healthWork) => { healthWork = work; } };
}
async function sinkFixture() {
  const f = await fixture(), preview = await f.prepare(), approved = await f.approve(preview);
  await transitionRun(f.db, f.queue, approved.run.id, "QUEUED", "STARTING");
  await transitionRun(f.db, f.queue, approved.run.id, "STARTING", "RUNNING", { substate: "active" });
  const request = ProjectResearchStartRunRequest.parse({ protocol: 1, runId: approved.run.id, profileId: "research", structuredResults: { version: 1 }, projectResearch: { version: 1 }, snapshot: { id: preview.snapshot.id, content: preview.snapshot.content, contentHash: preview.snapshot.contentHash }, limits: { idleTimeoutMs: 10000, totalTimeoutMs: 20000 } });
  const controller = new AbortController(), diagnostics: string[] = [], changed: (string | null)[] = [];
  let valid = true;
  const sink = researchResultSink({ db: f.db, queue: f.queue, request, signal: controller.signal, assertContext: () => { if (!valid) throw new Error("context invalidated"); }, diagnostic: (reason) => diagnostics.push(reason), changed: (id) => changed.push(id) });
  await sink(started);
  return { ...f, preview, approved, request, controller, sink, diagnostics, changed, invalidate: () => { valid = false; } };
}

it("prepares without dispatch or secrets, then IPC approval persists one original and no reviewer output through the real orchestrator/adapter", async () => {
  const f = await fixture({ start: true });
  try {
    const preview = await f.prepare();
    assert.equal(f.requests.filter((r) => r.path !== "/v1/health").length, 0);
    assert.equal(preview.snapshot.content, "🧪 公开资料");
    assert.equal(JSON.stringify(preview).includes(token), false);
    const results = await Promise.all([1, 2].map(() => f.dispatcher.handleCommand({ type: "research.approve", approvalId: preview.approval.id, expectedSnapshotHash: preview.snapshot.contentHash, expectedResearchHash: preview.researchHash })));
    assert.equal(results.filter((r) => r.ok).length, 1);
    await f.finished.promise;
    await f.queue.drain();
    const run = f.repo.listRuns(f.project.id, 100)[0]!;
    assert.equal(run.state, "COMPLETED");
    assert.equal(f.repo.listMessages(f.project.id).length, 1);
    assert.equal(f.repo.listMessages(f.project.id)[0]!.kind, "source_input");
    assert.equal(f.repo.listMessages(f.project.id)[0]!.content, text);
    assert.equal(f.events.filter((e) => e.type === "message.created").length, 1);
    const result = await f.dispatcher.handleQuery({ type: "research.result", projectId: f.project.id, runId: run.id });
    assert.ok(result.ok);
    assert.equal(f.requests.filter((r) => r.path === "/v1/runs").length, 1);
    const posted = f.requests.find((r) => r.path === "/v1/runs")!.body as Record<string, unknown>;
    assert.deepEqual(posted["projectResearch"], { version: 1 });
    assert.deepEqual(posted["structuredResults"], { version: 1 });
    assert.throws(() => resolveRunTarget(f.db, f.settings, f.db.prepare("SELECT * FROM runs WHERE id = ?").get(run.id) as RunRow), /research.approve/);
    const other = await f.repo.createProject("other");
    assert.equal((await f.dispatcher.handleQuery({ type: "research.preview", projectId: other.id, snapshotId: preview.snapshot.id })).ok, false);
  } finally { f.service.invalidate(); await f.queue.drain(); f.db.close(); }
});

for (const phase of ["prepare-health", "prepare-queue", "approve-health", "approve-queue"] as const) {
  it(`invalidates ${phase} during await while the old DB is still open; no late plan/run reaches either workspace`, async () => {
    const f = await fixture(), newDb = openDatabase(":memory:");
    try {
      const preview = phase.startsWith("approve") ? await f.prepare() : null;
      const release = deferred<void>(), entered = deferred<void>();
      if (phase.endsWith("health")) f.setHealth(async () => { entered.resolve(); await release.promise; return health; });
      else { void f.queue.run(async () => { entered.resolve(); await release.promise; }); }
      const pending = preview ? f.approve(preview) : f.prepare();
      const rejected = assert.rejects(pending, /工作区已切换/);
      await entered.promise;
      if (phase.endsWith("queue")) {
        for (let attempt = 0; attempt < 50 && f.queue.pending < 2; attempt++) await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(f.queue.pending, 2, "the operation must actually be waiting for the writer before switching");
      }
      // A real directory switch invalidates the old service before the DB closes/relaunches.
      f.service.invalidate();
      release.resolve();
      await rejected;
      await f.queue.drain();
      assert.equal(f.repo.listRuns(f.project.id, 100).length, 0);
      assert.equal((f.db.prepare("SELECT count(*) AS n FROM prompt_snapshots").get() as { n: number }).n, preview ? 1 : 0);
      assert.equal((newDb.prepare("SELECT count(*) AS n FROM prompt_snapshots").get() as { n: number }).n, 0);
      if (preview) assert.equal(f.repo.getApproval(preview.approval.id).state, "READY_FOR_REVIEW");
      assert.equal(f.requests.some((r) => r.path === "/v1/runs"), false);
    } finally { f.db.close(); newDb.close(); }
  });
}

it("rejects capability loss and a target change after health without consuming approval", async () => {
  const f = await fixture();
  try {
    const preview = await f.prepare();
    f.setHealth(async () => ({ ...health, capabilities: undefined }));
    await assert.rejects(f.approve(preview), /尚未提供/);
    f.setHealth(async () => { f.settings.upsertNode(nodeId, { baseUrl, token: "x".repeat(40) }); return health; });
    await assert.rejects(f.approve(preview), /配置已变化/);
    assert.equal(f.repo.getApproval(preview.approval.id).state, "READY_FOR_REVIEW");
    assert.equal(f.repo.listRuns(f.project.id, 100).length, 0);
    assert.ok(readResearchPlan(f.db, preview.snapshot.id));
  } finally { f.db.close(); }
});

it("rejects early citation forever on replay, but accepts the exact committed original and subsequent citation", async () => {
  const f = await sinkFixture();
  try {
    const early = { ...citation, seq: 1 };
    await f.sink(early);
    await f.sink(original);
    await f.sink(early);
    assert.deepEqual(f.diagnostics, ["citation_before_original"]);
    assert.equal(f.service.result({ type: "research.result", projectId: f.project.id, runId: f.approved.run.id }).blocks.length, 0);
    await assert.rejects(f.sink({ ...early, result: { ...early.result, block: { ...early.result.block, title: "changed replay" } } }), /changed payload/);
    await f.sink(citation);
    await f.sink(terminal);
    await f.sink({ ...citation, seq: 5 });
    assert.equal(f.service.result({ type: "research.result", projectId: f.project.id, runId: f.approved.run.id }).blocks.length, 1);
    assert.ok(f.diagnostics.includes("after_terminal"));
  } finally { f.db.close(); }
});

for (const action of ["cancel", "switch", "close"] as const) {
  it(`drops an uncommitted original when ${action} happens while it waits for the writer`, async () => {
    const f = await sinkFixture();
    const release = deferred<void>(), entered = deferred<void>();
    void f.queue.run(async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    const pending = f.sink(original);
    const rejected = assert.rejects(pending, /cancelled|closed|invalidated/);
    if (action === "cancel") f.controller.abort();
    else { f.invalidate(); if (action === "close") f.db.close(); }
    release.resolve();
    await rejected;
    await f.queue.drain();
    assert.equal(f.changed.length, 0);
    if (f.db.open) { assert.equal(f.repo.listMessages(f.project.id).length, 0); f.db.close(); }
  });
}

it("lets already queued original commit ahead of normal terminal, while cancellation after commit keeps the original", async () => {
  const f = await sinkFixture(), release = deferred<void>(), entered = deferred<void>();
  try {
    void f.queue.run(async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    const saving = f.sink(original), ending = f.sink(terminal);
    release.resolve();
    await Promise.all([saving, ending]);
    f.controller.abort();
    await assert.rejects(f.sink({ ...original, seq: 6 }), /cancelled/);
    assert.equal(f.repo.listMessages(f.project.id).length, 1);
    assert.equal(f.repo.listMessages(f.project.id)[0]!.content, text);
  } finally { f.db.close(); }
});

it("a malformed or forged original fails the run without reconnect/retry or publishing a result", async () => {
  const badSource = { ...source, version: "0".repeat(64), contentHash: "0".repeat(64) };
  const f = await fixture({ start: true, stream: [started, { ...original, source: badSource }, citation, terminal] });
  try {
    await f.approve(await f.prepare());
    await f.finished.promise;
    await f.queue.drain();
    assert.equal(f.repo.listRuns(f.project.id, 100)[0]!.state, "FAILED");
    assert.equal(f.repo.listMessages(f.project.id).length, 0);
    assert.equal(f.requests.filter((r) => r.path.endsWith("/events")).length, 1);
    assert.equal(f.requests.filter((r) => r.path === "/v1/runs").length, 1);
  } finally { f.db.close(); }
});
