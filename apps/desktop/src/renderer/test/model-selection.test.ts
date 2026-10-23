import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AgentModelSettings,
  DEFAULT_AGENT_MODEL_SETTINGS,
  NodeHealth,
  toRunModel,
  type ApprovalBatch,
  type BatchModel,
  type ModelOption,
  type Round,
} from "@room/schemas";
import { createMockBridge, type MockOptions } from "../mock/mock-backend";
import { MOCK_PROFILE_MODELS } from "../mock/discussion-mock";
import { modelsFor, pickModel } from "../lib/models";
import { RECOMMENDED_AGENTS, RECOMMENDED_MODELS } from "../lib/presets";

/** C-41：模型选择的挑选规则（照 C-40 的注释）和 mock 里的确认 / 盖章 */

const level = (id: string) => ({ id, displayName: id, note: null });
const opus: ModelOption = { id: "opus", displayName: "Opus", efforts: ["low", "medium", "high"].map(level), defaultEffort: "medium" };
const sonnet: ModelOption = { id: "sonnet", displayName: "Sonnet", efforts: ["low", "medium"].map(level), defaultEffort: "low" };
const flat: ModelOption = { id: "flat", displayName: "Flat", efforts: [], defaultEffort: null };
const settings: AgentModelSettings = {
  primaryModel: "opus",
  fallbackModel: "sonnet",
  effort: { chat: "medium", discussion: "medium", summary: "high" },
};

describe("pickModel (C-40 rules)", () => {
  it("follows the profile when the node reports nothing, the profile is fixed, or no primary is set", () => {
    assert.deepEqual(pickModel(settings, undefined, "discussion"), { ok: true, model: null });
    assert.deepEqual(pickModel(settings, [], "discussion"), { ok: true, model: null });
    assert.deepEqual(pickModel(DEFAULT_AGENT_MODEL_SETTINGS, [opus], "discussion"), { ok: true, model: null });
  });

  it("uses the primary with the occasion's effort", () => {
    assert.deepEqual(pickModel(settings, [opus, sonnet], "discussion"), {
      ok: true, model: { model: "opus", effort: "medium", usedFallback: false, effortSource: "configured" },
    });
    assert.deepEqual(pickModel(settings, [opus, sonnet], "summary"), {
      ok: true, model: { model: "opus", effort: "high", usedFallback: false, effortSource: "configured" },
    });
  });

  it("falls back, and marks an effort the fallback lacks as node_default", () => {
    assert.deepEqual(pickModel(settings, [sonnet], "summary"), {
      ok: true, model: { model: "sonnet", effort: "low", usedFallback: true, effortSource: "node_default" },
    });
  });

  it("models without levels get effort null / none", () => {
    assert.deepEqual(pickModel({ ...settings, primaryModel: "flat", fallbackModel: null }, [flat], "chat"), {
      ok: true, model: { model: "flat", effort: null, usedFallback: false, effortSource: "none" },
    });
  });

  it("neither available → not ok, naming the models", () => {
    const r = pickModel(settings, [flat], "discussion");
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.message : "", /opus、sonnet/);
  });

  it("retry / resume reuse the previous model while the node still has it", () => {
    const prev: BatchModel = { model: "sonnet", effort: "medium", usedFallback: true, effortSource: "configured" };
    assert.deepEqual(pickModel(settings, [opus, sonnet], "discussion", prev), { ok: true, model: prev });
    // 原来的模型没了 → 按规则重选
    const r = pickModel(settings, [opus], "discussion", prev);
    assert.equal(r.ok && r.model?.model, "opus");
  });

  it("modelsFor reads the profile's entry only", () => {
    const health = NodeHealth.parse({
      protocol: 1, nodeId: "n", profiles: ["a", "b"], activeRuns: 0, maxConcurrentRuns: 1, leaseMs: 1000, heartbeatMs: 100,
      profileModels: [{ profileId: "a", models: [opus] }],
    });
    assert.deepEqual(modelsFor(health, "a"), [opus]);
    assert.equal(modelsFor(health, "b"), undefined);
    assert.equal(modelsFor({ ...health, profileModels: undefined }, "a"), undefined);
  });
});

describe("recommended settings (江浩 2026-10-23)", () => {
  it("are valid and match what the user decided", () => {
    for (const s of Object.values(RECOMMENDED_MODELS)) assert.ok(AgentModelSettings.safeParse(s).success);
    assert.deepEqual(RECOMMENDED_MODELS.deepseek, {
      primaryModel: "deepseek-flash", fallbackModel: null, effort: { chat: "high", discussion: "high", summary: "high" },
    });
    for (const id of ["claude", "codex"] as const) {
      assert.deepEqual(RECOMMENDED_MODELS[id].effort, { chat: "medium", discussion: "medium", summary: "high" });
      assert.notEqual(RECOMMENDED_MODELS[id].fallbackModel, null);
    }
    for (const a of RECOMMENDED_AGENTS) assert.ok(a.modelSettings, `${a.id} 没带模型设置`);
  });

  it("every recommended model and level exists in the mock node's catalog", () => {
    for (const a of RECOMMENDED_AGENTS) {
      const models = MOCK_PROFILE_MODELS.find((p) => p.profileId === a.profileId)!.models;
      const s = a.modelSettings!;
      for (const m of [s.primaryModel, s.fallbackModel].filter((x) => x !== null)) {
        const opt = models.find((x) => x.id === m);
        assert.ok(opt, `${a.id}: ${m}`);
        for (const e of Object.values(s.effort)) assert.ok(opt.efforts.some((l) => l.id === e), `${a.id}: ${m} 没有 ${e}`);
      }
    }
  });
});

// ------------------------------------------------------------------ mock 里走一遍

async function ok<T>(p: Promise<{ ok: true; data: T } | { ok: false; error: string; message: string }>): Promise<T> {
  const r = await p;
  if (!r.ok) throw new Error(`${r.error}: ${r.message}`);
  return r.data;
}

function setup(discussion: MockOptions["discussion"] = {}) {
  const bridge = createMockBridge({ tickMs: 1, reviewerConfigured: true, discussion });
  const cmd = <T = any>(req: Record<string, unknown>) => ok<T>(bridge.command(req as never) as never);
  return { bridge, cmd };
}

async function draft(cmd: ReturnType<typeof setup>["cmd"], recipients = ["claude", "deepseek", "codex"]) {
  const p = await cmd<{ id: string }>({ type: "project.create", name: "模型选择" });
  return cmd<{ round: Round; batch: ApprovalBatch }>({
    type: "round.draft", projectId: p.id, recipients, task: "说说看", taskSource: "human",
    planVersionId: null, historyMode: "recent_with_summaries",
  });
}

/** 盖章后 mock 会接着模拟回答；等这一轮停下来，免得测试结束后还有计时器在跑 */
async function settle(bridge: ReturnType<typeof setup>["bridge"], roundId: string) {
  const end = Date.now() + 2000;
  while (Date.now() < end) {
    const r = await bridge.query({ type: "rounds.get", roundId } as never);
    if (r.ok && (r.data as { round: Round }).round.state !== "RUNNING") return;
    await new Promise((x) => setTimeout(x, 5));
  }
  throw new Error("timed out waiting");
}

const expected = (b: ApprovalBatch) =>
  b.items.map((i) => ({ approvalId: i.approvalId, contentHash: i.contentHash, model: i.model === null ? null : toRunModel(i.model) }));

describe("discussion mock with model selection", () => {
  it("draft picks each person's model and discussion effort", async () => {
    const { cmd } = setup();
    const { batch } = await draft(cmd);
    const by = Object.fromEntries(batch.items.map((i) => [i.recipient, i.model]));
    assert.deepEqual(by["claude"], { model: "claude-opus-5-5", effort: "medium", usedFallback: false, effortSource: "configured" });
    assert.deepEqual(by["deepseek"], { model: "deepseek-flash", effort: "high", usedFallback: false, effortSource: "configured" });
    assert.deepEqual(by["codex"], { model: "gpt-6.1-sol", effort: "medium", usedFallback: false, effortSource: "configured" });
  });

  it("missing primary → fallback is marked; nothing available → agent_unavailable", async () => {
    const { cmd } = setup({ missingModels: ["gpt-6.1-sol"] });
    const { batch } = await draft(cmd, ["codex"]);
    assert.deepEqual(batch.items[0]!.model, { model: "gpt-6-astra", effort: "medium", usedFallback: true, effortSource: "configured" });

    // 汐的 profile 只有一个模型：它没了 = models 为空 = 跟随 profile，不算不可用
    const fixed = setup({ missingModels: ["deepseek-flash"] });
    assert.equal((await draft(fixed.cmd, ["deepseek"])).batch.items[0]!.model, null);

    // 节点有模型，但首选和备选都不在里面
    const none = setup();
    await none.cmd({
      type: "agent.update", id: "codex",
      modelSettings: { primaryModel: "gpt-9", fallbackModel: "gpt-8", effort: { chat: null, discussion: null, summary: null } },
    });
    const p = await none.cmd<{ id: string }>({ type: "project.create", name: "x" });
    const r = await none.bridge.command({
      type: "round.draft", projectId: p.id, recipients: ["codex"], task: "t", taskSource: "human",
      planVersionId: null, historyMode: "recent_with_summaries",
    } as never);
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.error, "agent_unavailable");
    assert.match(!r.ok ? r.message : "", /gpt-9、gpt-8/);
  });

  it("old node without profileModels → model null, stamp with null works", async () => {
    const { cmd, bridge } = setup({ noProfileModels: true });
    const { round, batch } = await draft(cmd, ["claude"]);
    assert.equal(batch.items[0]!.model, null);
    const res = await cmd<{ batch: ApprovalBatch }>({ type: "batch.approve", batchId: batch.id, expected: expected(batch) });
    assert.equal(res.batch.state, "APPROVED");
    await settle(bridge, round.id);
  });

  it("stamp is refused when model, effort, or null-ness differs, naming who and what", async () => {
    const { bridge, cmd } = setup();
    const { round, batch } = await draft(cmd, ["claude"]);
    const base = expected(batch)[0]!;
    const tries = [
      { e: { ...base, model: { model: "claude-sonnet-5-5", effort: "medium" } }, what: /C酱 的模型/ },
      { e: { ...base, model: { model: "claude-opus-5-5", effort: "max" } }, what: /C酱 的思考强度/ },
      { e: { ...base, model: null }, what: /C酱 的模型/ },
    ];
    for (const t of tries) {
      const r = await bridge.command({ type: "batch.approve", batchId: batch.id, expected: [t.e] } as never);
      assert.equal(r.ok, false);
      assert.equal(!r.ok && r.error, "stale_snapshot");
      assert.match(!r.ok ? r.message : "", t.what);
    }
    const okRes = await cmd<{ batch: ApprovalBatch }>({ type: "batch.approve", batchId: batch.id, expected: [base] });
    assert.equal(okRes.batch.state, "APPROVED");
    await settle(bridge, round.id);
  });

  it("summary uses the summary effort", async () => {
    const { cmd, bridge } = setup();
    const { round, batch } = await draft(cmd, ["deepseek"]);
    await cmd({ type: "batch.approve", batchId: batch.id, expected: expected(batch) });
    await settle(bridge, round.id);
    const sum = await cmd<ApprovalBatch>({ type: "round.summarize", roundId: round.id, summarizer: "claude" });
    assert.deepEqual(sum.items[0]!.model, { model: "claude-opus-5-5", effort: "high", usedFallback: false, effortSource: "configured" });
  });

  it("node.test reports the catalog so the settings page can show it", async () => {
    const { cmd } = setup();
    const r = await cmd<{ reachable: boolean; health: unknown }>({
      type: "node.test", id: "user-pc", baseUrl: "http://192.168.190.10:7420", profileId: "claude-review",
    });
    assert.ok(r.reachable);
    const health = NodeHealth.parse(r.health);
    assert.deepEqual(modelsFor(health, "claude-review")?.map((m) => m.id), ["claude-opus-5-5", "claude-sonnet-5-5"]);
  });
});
