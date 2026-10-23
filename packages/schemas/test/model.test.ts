import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AgentModelSettings,
  AgentProfile,
  BatchItem,
  COMMANDS,
  DEFAULT_AGENT_MODEL_SETTINGS,
  ModelId,
  ModelOption,
  NodeHealth,
  RemoteErrorCode,
  StartRunRequest,
} from "../src/index";

const ID = "01JAAAAAAAAAAAAAAAAAAAAAAA";
const HASH = "b".repeat(64);

const claudeLevels = [
  { id: "low", displayName: "低", note: null },
  { id: "medium", displayName: "中等", note: "推荐" },
  { id: "high", displayName: "高", note: null },
  { id: "xhigh", displayName: "超高", note: null },
  { id: "max", displayName: "最高", note: "约 4 倍用量" },
];
const opus = { id: "claude-opus-5-5", displayName: "Opus 5.5", efforts: claudeLevels, defaultEffort: "medium" };

const health = {
  protocol: 1,
  nodeId: "user-pc",
  profiles: ["claude-review"],
  activeRuns: 0,
  maxConcurrentRuns: 2,
  leaseMs: 30_000,
  heartbeatMs: 5_000,
};

const startRun = {
  protocol: 1,
  runId: `run_${ID}`,
  profileId: "claude-review",
  snapshot: { id: `snap_${ID}`, content: "hi", contentHash: HASH },
  limits: { idleTimeoutMs: 60_000, totalTimeoutMs: 600_000 },
};

describe("model selection (C-40)", () => {
  it("ModelId cannot look like a CLI option or carry spaces / shell characters", () => {
    for (const ok of ["claude-opus-5-5", "deepseek-flash", "gpt-6.1-sol", "GPT-6_Astra"]) {
      assert.ok(ModelId.safeParse(ok).success, ok);
    }
    for (const bad of ["-m", "--model", "a b", "x;rm", "$(x)", "", "a/b"]) {
      assert.equal(ModelId.safeParse(bad).success, false, bad);
    }
  });

  it("ModelOption: defaultEffort must be one of efforts; no efforts means null", () => {
    assert.ok(ModelOption.safeParse(opus).success);
    assert.equal(ModelOption.safeParse({ ...opus, defaultEffort: "turbo" }).success, false);
    assert.equal(ModelOption.safeParse({ ...opus, defaultEffort: null }).success, false);
    assert.ok(ModelOption.safeParse({ ...opus, efforts: [], defaultEffort: null }).success);
    assert.equal(ModelOption.safeParse({ ...opus, efforts: [], defaultEffort: "low" }).success, false);
    assert.equal(ModelOption.safeParse({ ...opus, efforts: [...claudeLevels, claudeLevels[0]] }).success, false);
  });

  it("NodeHealth: profileModels is optional so old nodes still parse; profiles listed once", () => {
    assert.ok(NodeHealth.safeParse(health).success);
    const withModels = { ...health, profileModels: [{ profileId: "claude-review", models: [opus] }] };
    assert.ok(NodeHealth.safeParse(withModels).success);
    const dupProfile = { ...health, profileModels: [withModels.profileModels[0], withModels.profileModels[0]] };
    assert.equal(NodeHealth.safeParse(dupProfile).success, false);
    const dupModel = { ...health, profileModels: [{ profileId: "claude-review", models: [opus, opus] }] };
    assert.equal(NodeHealth.safeParse(dupModel).success, false);
  });

  it("StartRunRequest: model is optional, strict, and carries no command", () => {
    assert.ok(StartRunRequest.safeParse(startRun).success);
    assert.ok(StartRunRequest.safeParse({ ...startRun, model: { model: "claude-opus-5-5", effort: "medium" } }).success);
    assert.ok(StartRunRequest.safeParse({ ...startRun, model: { model: "claude-opus-5-5", effort: null } }).success);
    assert.equal(
      StartRunRequest.safeParse({ ...startRun, model: { model: "claude-opus-5-5", effort: "high", args: ["--x"] } }).success,
      false,
    );
    assert.equal(StartRunRequest.safeParse({ ...startRun, model: { model: "--dangerously", effort: null } }).success, false);
    assert.ok(RemoteErrorCode.options.includes("unknown_model"));
  });

  it("AgentModelSettings: fallback must differ from primary and needs a primary", () => {
    assert.ok(AgentModelSettings.safeParse(DEFAULT_AGENT_MODEL_SETTINGS).success);
    const effort = { chat: "medium", discussion: "medium", summary: "high" };
    assert.ok(
      AgentModelSettings.safeParse({ primaryModel: "claude-opus-5-5", fallbackModel: "claude-sonnet-5-5", effort }).success,
    );
    assert.ok(AgentModelSettings.safeParse({ primaryModel: "deepseek-flash", fallbackModel: null, effort }).success);
    assert.equal(
      AgentModelSettings.safeParse({ primaryModel: "claude-opus-5-5", fallbackModel: "claude-opus-5-5", effort }).success,
      false,
    );
    assert.equal(AgentModelSettings.safeParse({ primaryModel: null, fallbackModel: "claude-sonnet-5-5", effort }).success, false);
  });

  it("AgentProfile requires modelSettings; agent.update replaces it whole", () => {
    assert.ok("modelSettings" in AgentProfile.shape);
    const update = COMMANDS["agent.update"].request;
    assert.ok(update.safeParse({ type: "agent.update", id: "claude" }).success);
    assert.ok(
      update.safeParse({ type: "agent.update", id: "claude", modelSettings: DEFAULT_AGENT_MODEL_SETTINGS }).success,
    );
    assert.equal(
      update.safeParse({ type: "agent.update", id: "claude", modelSettings: { primaryModel: "x" } }).success,
      false,
    );
  });

  it("BatchItem.model: null for profile default, otherwise model + effort + usedFallback + effortSource", () => {
    const item = {
      recipient: "claude",
      onBehalfOf: null,
      approvalId: `apr_${ID}`,
      snapshotId: `snap_${ID}`,
      contentHash: HASH,
      differsFromOthers: false,
      tokenEstimate: 10,
    };
    assert.equal(BatchItem.safeParse(item).success, false, "model is required (null allowed)");
    assert.ok(BatchItem.safeParse({ ...item, model: null }).success);
    const sonnet = { model: "claude-sonnet-5-5", effort: "high", usedFallback: true, effortSource: "configured" };
    assert.ok(BatchItem.safeParse({ ...item, model: sonnet }).success);
    assert.ok(BatchItem.safeParse({ ...item, model: { ...sonnet, effortSource: "node_default" } }).success);
    assert.equal(BatchItem.safeParse({ ...item, model: { ...sonnet, usedFallback: undefined } }).success, false);
    assert.equal(BatchItem.safeParse({ ...item, model: { ...sonnet, effortSource: undefined } }).success, false);
    // 没有档位 <=> effort 为 null
    assert.ok(BatchItem.safeParse({ ...item, model: { ...sonnet, effort: null, effortSource: "none" } }).success);
    assert.equal(BatchItem.safeParse({ ...item, model: { ...sonnet, effort: null, effortSource: "configured" } }).success, false);
    assert.equal(BatchItem.safeParse({ ...item, model: { ...sonnet, effortSource: "none" } }).success, false);
  });

  it("batch.approve: the stamp covers model and effort for every item", () => {
    const approve = COMMANDS["batch.approve"].request;
    const base = { type: "batch.approve", batchId: `bat_${ID}` };
    const entry = { approvalId: `apr_${ID}`, contentHash: HASH };
    assert.equal(approve.safeParse({ ...base, expected: [entry] }).success, false, "model must be stated");
    assert.ok(approve.safeParse({ ...base, expected: [{ ...entry, model: null }] }).success);
    assert.ok(
      approve.safeParse({ ...base, expected: [{ ...entry, model: { model: "deepseek-flash", effort: "high" } }] }).success,
    );
  });
});
