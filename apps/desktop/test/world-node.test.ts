import assert from "node:assert/strict";
import test from "node:test";
import type { RemoteAgentAdapter } from "@room/core";
import type { HttpRemoteAgentAdapter } from "@room/remote-client";
import { AgentProfile, DEFAULT_AGENT_MODEL_SETTINGS, NodeHealth, REMOTE_PROTOCOL_VERSION, type ProfileModels } from "@room/schemas";
import type { Repository } from "../src/main/repository";
import type { SettingsStore } from "../src/main/settings";
import { resolveWorldNode, worldNodeConfigured } from "../src/main/world-node";

type AdapterOptions = ConstructorParameters<typeof HttpRemoteAgentAdapter>[0];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function resident(id: string, nodeId: string): AgentProfile {
  return AgentProfile.parse({
    id, displayName: id, color: "#557799", avatarRef: null, roleNote: "", canDiscuss: true,
    canSummarize: true, canExecute: false, nodeId, profileId: id + "-discuss", pausedByUser: false,
    substitute: null, modelSettings: structuredClone(DEFAULT_AGENT_MODEL_SETTINGS), chatPersona: "",
    chatProfileId: id + "-chat", memorySource: { nodeFolder: false },
  });
}

class ProbeAdapter implements RemoteAgentAdapter {
  readonly id = "world-node-test";
  readonly kind = "remote" as const;
  readonly node: RemoteAgentAdapter["node"];
  initialized = 0;
  constructor(readonly options: AdapterOptions, private readonly probe: (signal?: AbortSignal) => Promise<NodeHealth>) {
    this.node = { nodeId: options.nodeId, profileId: options.profileId, baseUrl: options.baseUrl,
      heartbeatTimeoutMs: options.heartbeatTimeoutMs ?? 15_000, reconnectGraceMs: options.reconnectGraceMs ?? 30_000, requestTimeoutMs: options.requestTimeoutMs ?? 5_000 };
  }
  health(signal?: AbortSignal) { return this.probe(signal); }
  async listRemoteRuns() { throw new Error("resolution must not list Runs"); }
  async reconcile() { throw new Error("resolution must not reconcile Runs"); }
  async initialize() { this.initialized++; throw new Error("the cognition runner owns initialization"); }
  async startSession() { throw new Error("resolution must not open a session"); }
  async *run() { throw new Error("resolution must not dispatch"); }
  async closeSession() { throw new Error("resolution must not close a runner session"); }
}

function fixture() {
  const agents = [resident("claude", "node-a"), resident("codex", "node-b")];
  const rows = new Map<string, ReturnType<Repository["getNodeRow"]>>([
    ["node-a", { id: "node-a", base_url: "http://127.0.0.1:18001" }],
    ["node-b", { id: "node-b", base_url: "http://127.0.0.1:18002" }],
  ]);
  const credentials = new Map<string, ReturnType<SettingsStore["getNode"]>>([
    ["node-a", { baseUrl: "http://127.0.0.1:18001", token: "fake-a-credential" }],
    ["node-b", { baseUrl: "http://127.0.0.1:18002", token: "fake-b-credential" }],
  ]);
  const health = NodeHealth.parse({ protocol: REMOTE_PROTOCOL_VERSION, nodeId: "node-a",
    profiles: ["claude-chat", "claude-discuss", "codex-chat"], activeRuns: 0, maxConcurrentRuns: 1, leaseMs: 100, heartbeatMs: 20 });
  const state = { probe: async (_signal?: AbortSignal): Promise<NodeHealth> => structuredClone(health) };
  const made: ProbeAdapter[] = [], probes: (AbortSignal | undefined)[] = [], credentialReads: string[] = [];
  const deps: Parameters<typeof resolveWorldNode>[0] = {
    repo: {
      // Repository queries return fresh parsed records; mutating test configuration
      // must not mutate the resolver's captured pre-probe agent object.
      listAgents: () => structuredClone(agents),
      getNodeRow: (id) => structuredClone(rows.get(id)),
    },
    settings: { getNode: (id) => { credentialReads.push(id); return structuredClone(credentials.get(id) ?? null); } },
    makeAdapter: (options) => {
      const adapter = new ProbeAdapter(structuredClone(options), async (signal) => { probes.push(signal); return state.probe(signal); });
      made.push(adapter);
      return adapter;
    },
  };
  return { agents, rows, credentials, health, state, made, probes, credentialReads, deps };
}

function models(profileId: string, modelIds: string[], efforts = ["low", "high"]): ProfileModels {
  return { profileId, models: modelIds.map((id) => ({ id, displayName: id,
    efforts: efforts.map((effort) => ({ id: effort, displayName: effort, note: "" })), defaultEffort: efforts[0] ?? null })) };
}

test("world resolution probes only this resident's chat profile and credentials, returning an uninitialized adapter", async () => {
  const h = fixture(), controller = new AbortController();
  assert.equal(worldNodeConfigured(h.deps, "claude"), true);
  assert.equal(h.made.length, 0, "configured checks do not contact a node");
  const resolved = await resolveWorldNode(h.deps, "claude", controller.signal);
  assert.equal(resolved, h.made[1]);
  assert.equal(h.made.length, 2, "one probe adapter and one uninitialized Run adapter");
  assert.deepEqual(h.probes, [controller.signal]);
  for (const adapter of h.made) {
    assert.equal(adapter.options.nodeId, "node-a");
    assert.equal(adapter.options.profileId, "claude-chat");
    assert.equal(adapter.options.baseUrl, "http://127.0.0.1:18001");
    assert.equal(adapter.options.token, "fake-a-credential");
    assert.equal(adapter.initialized, 0);
  }
  assert.ok(h.credentialReads.every((id) => id === "node-a"));
  assert.equal(h.made[1]!.options.model, undefined);
});

test("paused, missing and mismatched configuration never probes or borrows another resident's profile", async (t) => {
  const cases: Record<string, (h: ReturnType<typeof fixture>) => void> = {
    "unknown resident": (h) => { h.agents.splice(0, 1); },
    "paused resident": (h) => { h.agents[0]!.pausedByUser = true; },
    "missing node binding": (h) => { h.agents[0]!.nodeId = null; },
    "missing chat profile despite configured discussion": (h) => { h.agents[0]!.chatProfileId = null; },
    "discussion profile put in chat slot": (h) => { h.agents[0]!.chatProfileId = "claude-discuss"; },
    "missing node record": (h) => { h.rows.delete("node-a"); },
    "missing node address": (h) => { h.rows.get("node-a")!.base_url = null; },
    "missing credential": (h) => { h.credentials.set("node-a", null); },
    "credential and database addresses disagree": (h) => { h.credentials.get("node-a")!.baseUrl = "http://127.0.0.1:19001"; },
  };
  for (const [name, change] of Object.entries(cases)) await t.test(name, async () => {
    const h = fixture(); change(h);
    assert.equal(worldNodeConfigured(h.deps, "claude"), false);
    assert.equal(await resolveWorldNode(h.deps, "claude", new AbortController().signal), null);
    assert.equal(h.made.length, 0);
    assert.equal(h.probes.length, 0);
    assert.equal(h.credentialReads.includes("node-b"), false);
  });
});

test("changes during a successful health probe invalidate the old target rather than returning a stale adapter", async (t) => {
  const cases: Record<string, (h: ReturnType<typeof fixture>) => void> = {
    "resident paused": (h) => { h.agents[0]!.pausedByUser = true; },
    "resident deleted": (h) => { h.agents.splice(0, 1); },
    "chat profile changed": (h) => { h.agents[0]!.chatProfileId = "claude-new-chat"; },
    "node binding changed": (h) => { h.agents[0]!.nodeId = "node-b"; },
    "credential removed": (h) => { h.credentials.set("node-a", null); },
    "credential rotated": (h) => { h.credentials.get("node-a")!.token = "fake-rotated-credential"; },
    "both saved addresses changed consistently": (h) => {
      h.rows.get("node-a")!.base_url = "http://127.0.0.1:19001";
      h.credentials.get("node-a")!.baseUrl = "http://127.0.0.1:19001";
    },
    "chat model selection changed": (h) => { h.agents[0]!.modelSettings.primaryModel = "new-model"; },
  };
  for (const [name, change] of Object.entries(cases)) await t.test(name, async () => {
    const h = fixture(), entered = deferred(), released = deferred();
    h.state.probe = async () => { entered.resolve(); await released.promise; return h.health; };
    const resolving = resolveWorldNode(h.deps, "claude", new AbortController().signal);
    await entered.promise;
    change(h); released.resolve();
    assert.equal(await resolving, null);
    assert.equal(h.made.length, 1, "no Run adapter built from stale probe credentials");
  });
});

test("abort prevents probing, and cancellation during an uncooperative probe invalidates its later success", async () => {
  const before = fixture(), already = new AbortController(); already.abort();
  assert.equal(await resolveWorldNode(before.deps, "claude", already.signal), null);
  assert.equal(before.made.length, 0);
  const during = fixture(), entered = deferred(), released = deferred(), controller = new AbortController();
  during.state.probe = async (signal) => {
    assert.equal(signal, controller.signal); entered.resolve(); await released.promise; return during.health;
  };
  const resolving = resolveWorldNode(during.deps, "claude", controller.signal);
  await entered.promise; controller.abort(); released.resolve();
  assert.equal(await resolving, null);
  assert.equal(during.made.length, 1);
});

test("probe failure is propagated without a replacement, and a missing advertised chat profile is unavailable", async () => {
  const failed = fixture(), problem = new Error("fake node unavailable");
  failed.state.probe = async () => { throw problem; };
  await assert.rejects(resolveWorldNode(failed.deps, "claude", new AbortController().signal), (error) => error === problem);
  assert.equal(failed.made.length, 1);
  const missing = fixture(); missing.health.profiles = ["claude-discuss", "codex-chat"];
  assert.equal(await resolveWorldNode(missing.deps, "claude", new AbortController().signal), null);
  assert.equal(missing.made.length, 1);
});

test("model selection reads the chat profile and chat effort, never the discussion or summary setting", async () => {
  const h = fixture();
  h.agents[0]!.modelSettings = { primaryModel: "preferred", fallbackModel: "fallback", effort: { chat: "high", discussion: "low", summary: "low" } };
  h.health.profileModels = [models("claude-discuss", ["preferred"]), models("codex-chat", ["preferred"]), models("claude-chat", ["fallback"])];
  const resolved = await resolveWorldNode(h.deps, "claude", new AbortController().signal);
  assert.equal(resolved, h.made[1]);
  assert.deepEqual(h.made[1]!.options.model, { model: "fallback", effort: "high" });
  assert.equal(h.made[0]!.options.model, undefined, "health probe is independent of model selection");
});

test("chat model selection honors primary, node-default effort, no-effort models and legacy profile defaults", async (t) => {
  const cases: { name: string; configure: (h: ReturnType<typeof fixture>) => void; expected: AdapterOptions["model"] }[] = [
    { name: "primary model wins", configure: () => {}, expected: { model: "preferred", effort: "high" } },
    { name: "unsupported chat effort uses node default", configure: (h) => { h.agents[0]!.modelSettings.effort.chat = "ultra"; }, expected: { model: "preferred", effort: "low" } },
    { name: "model has no effort levels", configure: (h) => { h.health.profileModels = [models("claude-chat", ["preferred"], [])]; }, expected: { model: "preferred", effort: null } },
    { name: "no configured selection follows profile", configure: (h) => { h.agents[0]!.modelSettings = structuredClone(DEFAULT_AGENT_MODEL_SETTINGS); }, expected: undefined },
    { name: "legacy health has no model catalog", configure: (h) => { delete h.health.profileModels; }, expected: undefined },
    { name: "fixed profile has empty catalog", configure: (h) => { h.health.profileModels = [models("claude-chat", [])]; }, expected: undefined },
  ];
  for (const { name, configure, expected } of cases) await t.test(name, async () => {
    const h = fixture();
    h.agents[0]!.modelSettings = { primaryModel: "preferred", fallbackModel: "fallback", effort: { chat: "high", discussion: "low", summary: "low" } };
    h.health.profileModels = [models("claude-chat", ["preferred", "fallback"])];
    configure(h); NodeHealth.parse(h.health);
    assert.equal(await resolveWorldNode(h.deps, "claude", new AbortController().signal), h.made[1]);
    assert.equal(h.made.length, 2);
    assert.deepEqual(h.made[1]!.options.model, expected);
  });
});

test("unavailable configured models do not fall back to another profile or its default model", async () => {
  const h = fixture();
  h.agents[0]!.modelSettings = { primaryModel: "preferred", fallbackModel: "fallback", effort: { chat: "high", discussion: "low", summary: "low" } };
  h.health.profileModels = [models("claude-chat", ["unconfigured-model"]), models("claude-discuss", ["preferred", "fallback"])];
  assert.equal(await resolveWorldNode(h.deps, "claude", new AbortController().signal), null);
  assert.equal(h.made.length, 1);
});
