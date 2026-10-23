import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { COMMANDS, type AgentModelSettings, type AgentProfile, type ModelOption } from "@room/schemas";
import {
  ANSWER_JSON,
  approve,
  approveRequest,
  draft,
  failure,
  makeE2E,
  waitRoundDone,
  type E2E,
} from "./harness";

const CODEX_SETTINGS: AgentModelSettings = {
  primaryModel: "gpt-6.1-sol",
  fallbackModel: "gpt-6-astra",
  effort: { chat: "medium", discussion: "medium", summary: "high" },
};
const CLAUDE_SETTINGS: AgentModelSettings = {
  primaryModel: "claude-opus-5-5",
  fallbackModel: "claude-sonnet-5-5",
  effort: { chat: "medium", discussion: "medium", summary: "high" },
};

function modelOptions(ids: string[]): ModelOption[] {
  return ids.map((id) => ({
    id,
    displayName: id,
    efforts: [
      { id: "low", displayName: "低", note: null },
      { id: "medium", displayName: "中等", note: null },
      { id: "high", displayName: "高", note: null },
    ],
    // 明确设成 low，防止漏传配置时碰巧得到要求的 medium / high。
    defaultEffort: "low",
  }));
}

const CODEX_MODELS = modelOptions(["gpt-6.1-sol", "gpt-6-astra"]);
const CLAUDE_MODELS = modelOptions(["claude-opus-5-5", "claude-sonnet-5-5"]);

async function setModelSettings(h: E2E, id: AgentProfile["id"], modelSettings: AgentModelSettings): Promise<void> {
  const result = await h.dispatcher.handleCommand({ type: "agent.update", id, modelSettings });
  assert.ok(result.ok, JSON.stringify(result));
  const agent = COMMANDS["agent.update"].response.parse(result.data);
  assert.deepEqual(agent.modelSettings, modelSettings, "D-35 必须保存并返回参与者的模型设置");
}

async function openRound(h: E2E, recipients: string[]) {
  const result = await draft(h, recipients);
  assert.ok(result.ok, JSON.stringify(result));
  return COMMANDS["round.draft"].response.parse(result.data);
}

function launchCounts(h: E2E) {
  return {
    runs: (h.db.prepare("SELECT count(*) AS n FROM runs").get() as { n: number }).n,
    starts: h.nodes.userPc.starts.length + h.nodes.controller.starts.length,
    requests: [...h.nodes.userPc.requests, ...h.nodes.controller.requests].filter((r) => r === "POST /v1/runs").length,
  };
}

describe("X-33 模型选择：盖章 → 真后端 → HTTP 假节点", () => {
  it("X-33 #1 老节点：批次与 expected 为 null，实际 StartRun 省略 model", async (t) => {
    const h = await makeE2E();
    t.after(() => h.close());
    await setModelSettings(h, "claude", CLAUDE_SETTINGS);
    await setModelSettings(h, "codex", CODEX_SETTINGS);

    const { round, batch } = await openRound(h, ["claude", "codex"]);
    assert.deepEqual(batch.items.map((item) => item.model), [null, null]);
    const command = approveRequest(batch);
    assert.deepEqual(command.expected.map((item) => item.model), [null, null]);
    const approved = await h.dispatcher.handleCommand(command);
    assert.ok(approved.ok, JSON.stringify(approved));
    await waitRoundDone(h, round.id, "AWAITING_SUMMARY");

    const starts = [...h.nodes.userPc.starts, ...h.nodes.controller.starts];
    assert.equal(starts.length, 2);
    for (const start of starts) assert.equal(Object.hasOwn(start, "model"), false, "必须省略字段，不能发送 null");
  });

  it("X-33 #2 同一参与者：讨论用 medium，汇总用 high，只传 RunModel", async (t) => {
    const h = await makeE2E({
      controllerModels: [{ profileId: "codex-discuss", models: CODEX_MODELS }],
      controller: { "codex-discuss": [
        { kind: "answer", text: "先把失败路径测清楚" },
        { kind: "answer", text: ANSWER_JSON },
      ] },
    });
    t.after(() => h.close());
    await setModelSettings(h, "codex", CODEX_SETTINGS);
    const enabled = await h.dispatcher.handleCommand({ type: "agent.update", id: "codex", canSummarize: true });
    assert.ok(enabled.ok, JSON.stringify(enabled));

    const { round, batch } = await openRound(h, ["codex"]);
    assert.deepEqual(batch.items[0]!.model, {
      model: "gpt-6.1-sol", effort: "medium", usedFallback: false, effortSource: "configured",
    });
    const approved = await approve(h, batch);
    assert.ok(approved.ok, JSON.stringify(approved));
    await waitRoundDone(h, round.id, "AWAITING_SUMMARY");

    const requested = await h.dispatcher.handleCommand({ type: "round.summarize", roundId: round.id, summarizer: "codex" });
    assert.ok(requested.ok, JSON.stringify(requested));
    const summary = COMMANDS["round.summarize"].response.parse(requested.data);
    assert.equal(summary.kind, "summary");
    assert.deepEqual(summary.items[0]!.model, {
      model: "gpt-6.1-sol", effort: "high", usedFallback: false, effortSource: "configured",
    });
    const summaryApproved = await approve(h, summary);
    assert.ok(summaryApproved.ok, JSON.stringify(summaryApproved));
    await waitRoundDone(h, round.id, "SUMMARIZED");

    assert.deepEqual(h.nodes.controller.starts.map((start) => start.model), [
      { model: "gpt-6.1-sol", effort: "medium" },
      { model: "gpt-6.1-sol", effort: "high" },
    ], "检查实际 HTTP 请求，不只检查批次；来源标记不能传到节点");
    assert.ok(h.nodes.controller.starts.every((start) => start.profileId === "codex-discuss"));
    assert.equal(h.nodes.userPc.starts.length, 0);
  });

  it("X-33 #3 首选不可用：批次标记备选，节点收到备选 id 和 medium", async (t) => {
    const h = await makeE2E({
      controllerModels: [{ profileId: "codex-discuss", models: CODEX_MODELS.slice(1) }],
    });
    t.after(() => h.close());
    await setModelSettings(h, "codex", CODEX_SETTINGS);
    const { round, batch } = await openRound(h, ["codex"]);
    assert.deepEqual(batch.items[0]!.model, {
      model: "gpt-6-astra", effort: "medium", usedFallback: true, effortSource: "configured",
    });

    const approved = await approve(h, batch);
    assert.ok(approved.ok, JSON.stringify(approved));
    await waitRoundDone(h, round.id, "AWAITING_SUMMARY");
    assert.equal(h.nodes.controller.starts.length, 1);
    assert.deepEqual(h.nodes.controller.starts[0]!.model, { model: "gpt-6-astra", effort: "medium" });
  });

  const changes = [
    { name: "模型", kind: "model" },
    { name: "强度", kind: "effort" },
    { name: "选定模型改成 null", kind: "to_null" },
    { name: "null 改成选定模型", kind: "from_null" },
  ] as const;

  for (const [index, change] of changes.entries()) {
    it(`X-33 #${index + 4} 只改 expected 的${change.name}：整批 stale_snapshot，零新 Run / HTTP 派发`, async (t) => {
      const h = await makeE2E(change.kind === "from_null" ? {} : {
        userPcModels: [{ profileId: "claude-review", models: CLAUDE_MODELS }],
        controllerModels: [{ profileId: "codex-discuss", models: CODEX_MODELS }],
      });
      t.after(() => h.close());
      await setModelSettings(h, "claude", CLAUDE_SETTINGS);
      await setModelSettings(h, "codex", CODEX_SETTINGS);
      const { round, batch } = await openRound(h, ["claude", "codex"]);
      const command = approveRequest(batch);
      // 改最后一项，验证前面正确的项也没有被部分批准 / 派发。
      const codex = batch.items.find((item) => item.recipient === "codex");
      assert.ok(codex);
      const target = command.expected.find((item) => item.approvalId === codex.approvalId);
      assert.ok(target);
      command.expected = [...command.expected.filter((item) => item !== target), target];
      if (change.kind === "from_null") {
        assert.equal(target.model, null);
        target.model = { model: "gpt-6.1-sol", effort: "medium" };
      } else {
        assert.ok(target.model);
        if (change.kind === "model") target.model = { ...target.model, model: "gpt-6-astra" };
        if (change.kind === "effort") target.model = { ...target.model, effort: "high" };
        if (change.kind === "to_null") target.model = null;
      }
      for (const item of command.expected) {
        const original = batch.items.find((candidate) => candidate.approvalId === item.approvalId);
        assert.ok(original);
        assert.equal(item.contentHash, original.contentHash);
      }

      const before = launchCounts(h);
      assert.deepEqual(before, { runs: 0, starts: 0, requests: 0 });
      const approvalStates = batch.items.map((item) => h.repo.getApproval(item.approvalId).state);
      const rejected = await h.dispatcher.handleCommand(command);
      assert.equal(failure(rejected).error, "stale_snapshot", JSON.stringify(rejected));
      assert.deepEqual(launchCounts(h), before, "没有 DB Run，也不能发出被假节点拒绝的 HTTP 请求");
      assert.equal(h.orchestrator.activeCount(), 0);
      assert.deepEqual(h.repo.getBatch(batch.id), batch, "批次和原始指纹不变");
      assert.deepEqual(batch.items.map((item) => h.repo.getApproval(item.approvalId).state), approvalStates);
      assert.ok(h.repo.listTurnsByBatch(batch.id).every((turn) => turn.runId === null));

      // 同一批次还能用原值批准，证明拒绝没有消费任一审批；随后只能出现这两个 Run。
      const approved = await approve(h, batch);
      assert.ok(approved.ok, JSON.stringify(approved));
      await waitRoundDone(h, round.id, "AWAITING_SUMMARY");
      assert.deepEqual(launchCounts(h), { runs: 2, starts: 2, requests: 2 });
    });
  }
});
