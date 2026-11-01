import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AgentStatus,
  ApprovalBatch,
  COMMANDS,
  ControlCommand,
  ControlEvent,
  ControlQuery,
  FailureReason,
  RemoteTerminal,
  Message,
  NodeInfo,
  PromptSnapshot,
  PLAN_TRANSITIONS,
  PlanState,
  QUERIES,
  ROUND_TRANSITIONS,
  RoundState,
  TERMINAL_TURN_OUTCOMES,
  TurnOutcome,
  canTransition,
  quotaState,
  RemoteProfileQuota,
  RoundSubstitutions,
} from "../src/index";

const ID = "01JAAAAAAAAAAAAAAAAAAAAAAA";
const TS = "2026-10-21T00:00:00.000Z";
const HASH = "b".repeat(64);

function reachableTerminal<S extends string>(table: Readonly<Record<S, readonly S[]>>, from: S, terminals: readonly S[]) {
  const seen = new Set<S>([from]);
  const queue = [from];
  while (queue.length) {
    const s = queue.shift()!;
    if (terminals.includes(s)) return true;
    for (const n of table[s]) if (!seen.has(n)) (seen.add(n), queue.push(n));
  }
  return false;
}

describe("round state machine (ADR-002 canvas 0-B)", () => {
  const terminals = ["SUMMARIZED", "VOIDED"] as const;
  it("terminal states are SUMMARIZED and VOIDED only", () => {
    for (const s of RoundState.options) {
      assert.equal(ROUND_TRANSITIONS[s].length === 0, (terminals as readonly string[]).includes(s), s);
    }
  });
  it("every state can still finish, and every non-terminal state can be voided (改方向)", () => {
    for (const s of RoundState.options) {
      assert.ok(reachableTerminal(ROUND_TRANSITIONS, s, terminals), s);
      if (!(terminals as readonly string[]).includes(s)) assert.ok(canTransition(ROUND_TRANSITIONS, s, "VOIDED"), s);
    }
  });
  it("pause / resume / end-round / failed summary are the only loops", () => {
    assert.ok(canTransition(ROUND_TRANSITIONS, "RUNNING", "PAUSED"));
    assert.ok(canTransition(ROUND_TRANSITIONS, "PAUSED", "RUNNING"));
    assert.ok(canTransition(ROUND_TRANSITIONS, "PAUSED", "AWAITING_SUMMARY"), "end round while paused");
    assert.ok(canTransition(ROUND_TRANSITIONS, "SUMMARIZING", "AWAITING_SUMMARY"), "summary failed → pick again");
    assert.ok(canTransition(ROUND_TRANSITIONS, "AWAITING_SUMMARY", "RUNNING"), "retry / supplement after everyone finished");
    assert.ok(!canTransition(ROUND_TRANSITIONS, "DRAFT", "AWAITING_SUMMARY"), "cannot summarize a round nobody answered");
    for (const s of RoundState.options) assert.ok(!canTransition(ROUND_TRANSITIONS, s, s), `${s} self-loop`);
  });
});

describe("plan version state machine", () => {
  it("SUPERSEDED is terminal; FINAL only leaves when a derived version is finalized; a draft must be confirmed first", () => {
    assert.deepEqual(PLAN_TRANSITIONS.FINAL, ["SUPERSEDED"]);
    assert.deepEqual(PLAN_TRANSITIONS.SUPERSEDED, []);
    assert.ok(!canTransition(PLAN_TRANSITIONS, "FINAL", "CURRENT"), "a finalized plan is never edited back");
    assert.ok(!canTransition(PLAN_TRANSITIONS, "DRAFT", "FINAL"));
    assert.ok(canTransition(PLAN_TRANSITIONS, "CURRENT", "FINAL"));
    for (const s of PlanState.options) assert.ok(reachableTerminal(PLAN_TRANSITIONS, s, ["FINAL", "SUPERSEDED"]), s);
  });
});

describe("turn outcomes", () => {
  it("everything except pending / running is terminal", () => {
    const nonTerminal = TurnOutcome.options.filter((o) => !(TERMINAL_TURN_OUTCOMES as readonly string[]).includes(o));
    assert.deepEqual(nonTerminal.sort(), ["pending", "running"]);
  });
  it("quota exhaustion is a failure reason (缺席), not a crash", () => {
    assert.ok(FailureReason.options.includes("quota_exhausted"));
    // 节点也能报告它（C-25），而且每个节点原因都能映射到 FailureReason（node_shutdown 除外，映射成 remote_lost）
    const terminal = RemoteTerminal.parse({ outcome: "error", reason: "quota_exhausted", exitCode: 1, message: "usage limit" });
    assert.equal(terminal.outcome, "error");
    const remoteReasons = (RemoteTerminal.options[1].shape.reason.options as readonly string[]).filter((r) => r !== "node_shutdown");
    for (const r of remoteReasons) assert.ok((FailureReason.options as readonly string[]).includes(r), r);
  });
});

describe("discussion messages", () => {
  const base = { id: `msg_${ID}`, projectId: `proj_${ID}`, content: "x", createdAt: TS };
  it("agent replies always belong to a round, a turn and a run", () => {
    const ok = {
      ...base,
      kind: "agent_reply",
      sourceAgent: "deepseek",
      onBehalfOf: null,
      roundId: `rnd_${ID}`,
      turnId: `turn_${ID}`,
      runId: `run_${ID}`,
    };
    assert.equal(Message.safeParse(ok).success, true);
    const { turnId: _t, ...noTurn } = ok;
    assert.equal(Message.safeParse(noTurn).success, false);
  });
  it("a substitute answer records who it stands in for", () => {
    const m = Message.parse({
      ...base,
      kind: "agent_reply",
      sourceAgent: "deepseek",
      onBehalfOf: "codex",
      roundId: `rnd_${ID}`,
      turnId: `turn_${ID}`,
      runId: `run_${ID}`,
    });
    assert.equal(m.kind === "agent_reply" && m.onBehalfOf, "codex");
  });
  it("human notes may be between rounds", () => {
    assert.equal(Message.safeParse({ ...base, kind: "human_note", roundId: null }).success, true);
  });
});

describe("discussion commands", () => {
  const draft = {
    type: "round.draft",
    projectId: `proj_${ID}`,
    recipients: ["deepseek", "codex"],
    task: "各自给出最终立场",
    taskSource: "summarizer_proposal",
    planVersionId: null,
    historyMode: "recent_with_summaries",
  };

  it("are all registered and routable", () => {
    for (const t of [
      "node.upsert", "node.test", "agent.update", "note.add", "round.draft", "round.redraft", "batch.approve",
      "batch.reject", "round.pause", "round.resume", "round.end", "round.supplement", "round.retry",
      "round.summarize", "round.void", "plan.create", "plan.confirm", "plan.edit", "plan.finalize", "plan.derive",
    ]) assert.ok(t in COMMANDS, t);
    for (const t of ["nodes.list", "agents.list", "agents.status", "rounds.list", "rounds.get", "batches.get", "plans.list"]) {
      assert.ok(t in QUERIES, t);
      assert.equal(ControlQuery.safeParse({ type: t, projectId: `proj_${ID}`, roundId: `rnd_${ID}`, batchId: `bat_${ID}` }).success, true, t);
    }
    assert.equal(ControlCommand.safeParse(draft).success, true);
  });

  it("plan.create (C-28) needs a project and non-empty content", () => {
    const ok = { type: "plan.create", projectId: `proj_${ID}`, content: "# 方案 v1", changeNote: "用户起草第一版" };
    assert.equal(ControlCommand.safeParse(ok).success, true);
    assert.equal(ControlCommand.safeParse({ ...ok, content: "" }).success, false);
    assert.equal(ControlCommand.safeParse({ ...ok, projectId: undefined }).success, false);
  });

  it("round.draft rejects duplicate or missing recipients", () => {
    assert.equal(ControlCommand.safeParse({ ...draft, recipients: ["deepseek", "deepseek"] }).success, false);
    assert.equal(ControlCommand.safeParse({ ...draft, recipients: [] }).success, false);
  });

  it("C-36: substitutes on round.draft / redraft / retry", () => {
    const sub = (absent: string, substitute: string) => ({ absent, substitute });
    assert.equal(ControlCommand.safeParse(draft).success, true, "omitted = automatic");
    assert.equal(ControlCommand.safeParse({ ...draft, substitutes: [] }).success, true, "empty = nobody substitutes");
    assert.equal(ControlCommand.safeParse({ ...draft, substitutes: [sub("codex", "claude")] }).success, true);
    assert.equal(ControlCommand.safeParse({ ...draft, substitutes: [{ ...sub("codex", "claude"), extra: 1 }] }).success, false, "strict");
    const bad = (xs: unknown, why: string) => assert.equal(RoundSubstitutions.safeParse(xs).success, false, why);
    bad([sub("codex", "codex")], "self");
    bad([sub("codex", "claude"), sub("codex", "deepseek")], "two substitutes for one person");
    bad([sub("codex", "claude"), sub("deepseek", "claude")], "one substitute for two people");
    bad([sub("codex", "claude"), sub("claude", "deepseek")], "no chains");
    assert.equal(ControlCommand.safeParse({ type: "round.redraft", roundId: `rnd_${ID}`, substitutes: [sub("codex", "claude")] }).success, true);
    assert.equal(ControlCommand.safeParse({ type: "round.retry", roundId: `rnd_${ID}`, agent: "codex" }).success, true);
    assert.equal(ControlCommand.safeParse({ type: "round.retry", roundId: `rnd_${ID}`, agent: "codex", substitute: "claude" }).success, true);
  });

  it("C-36: quotaState — unknown is not exhausted", () => {
    const w = (usedPercent: number) => ({ usedPercent });
    assert.equal(quotaState({ fiveHour: null, weekly: null }), "unknown");
    assert.equal(quotaState({ fiveHour: null, weekly: null, balance: null }), "unknown");
    assert.equal(quotaState({ fiveHour: w(99.9), weekly: null }), "ok");
    assert.equal(quotaState({ fiveHour: w(40), weekly: w(100) }), "exhausted");
    assert.equal(quotaState({ fiveHour: null, weekly: null, balance: { amount: "38.20" } }), "ok");
    assert.equal(quotaState({ fiveHour: null, weekly: null, balance: { amount: "0" } }), "exhausted");
    assert.equal(quotaState({ fiveHour: null, weekly: null, balance: { amount: "-1.5" } }), "exhausted");
    assert.equal(quotaState({ fiveHour: w(10), weekly: null, balance: { amount: "0.00" } }), "exhausted");
  });

  it("C-36: a node's quota may carry an API balance; old nodes without it still parse", () => {
    const base = { fiveHour: null, weekly: null, creditsInUse: null, readAt: TS };
    assert.ok(RemoteProfileQuota.safeParse(base).success, "old node");
    assert.ok(RemoteProfileQuota.safeParse({ ...base, balance: null }).success);
    assert.ok(RemoteProfileQuota.safeParse({ ...base, balance: { amount: "38.20", currency: "CNY" } }).success);
    for (const amount of ["", "1e3", "abc", "1.1234567", "１２"]) {
      assert.equal(RemoteProfileQuota.safeParse({ ...base, balance: { amount, currency: "CNY" } }).success, false, amount);
    }
    assert.equal(RemoteProfileQuota.safeParse({ ...base, balance: { amount: "1", currency: "" } }).success, false);
  });

  it("stamping a batch needs the expected hash of every item", () => {
    const approve = COMMANDS["batch.approve"].request;
    assert.equal(approve.safeParse({ type: "batch.approve", batchId: `bat_${ID}`, expected: [] }).success, false);
    assert.equal(
      approve.safeParse({ type: "batch.approve", batchId: `bat_${ID}`, expected: [{ approvalId: `apr_${ID}`, contentHash: HASH, model: null }] }).success,
      true,
    );
  });

  it("finalizing a plan is a stamp and checks the content hash", () => {
    assert.equal(COMMANDS["plan.finalize"].scope, "approve");
    assert.equal(COMMANDS["plan.finalize"].request.safeParse({ type: "plan.finalize", planVersionId: `plan_${ID}` }).success, false);
  });

  it("node settings never carry the token back out", () => {
    const n = NodeInfo.parse({ id: "user-pc", label: "你的电脑", baseUrl: "http://192.168.190.10:7420", tokenConfigured: true, token: "x".repeat(40) });
    assert.ok(!("token" in n));
  });
});

describe("discussion records", () => {
  it("a discussion snapshot has no contributions, but snapshot.create still needs at least one", () => {
    const snap = {
      id: `snap_${ID}`, projectId: `proj_${ID}`, content: "x", contentHash: HASH, nonce: "a".repeat(16),
      contributionIds: [], taskInstruction: "t", reviewerAgent: "deepseek", adapterVersion: "discussion-1",
      tokenEstimate: 1, synthesisVersion: null, branch: null, commitSha: null, createdAt: TS,
    };
    assert.equal(PromptSnapshot.safeParse(snap).success, true);
    assert.equal(COMMANDS["snapshot.create"].request.safeParse({
      type: "snapshot.create", projectId: `proj_${ID}`, contributionIds: [], taskInstruction: "t",
    }).success, false);
  });

  it("a batch marks recipients that got different content", () => {
    const b = ApprovalBatch.parse({
      id: `bat_${ID}`,
      projectId: `proj_${ID}`,
      roundId: `rnd_${ID}`,
      kind: "supplement",
      state: "READY_FOR_REVIEW",
      items: [{
        recipient: "codex", onBehalfOf: null, approvalId: `apr_${ID}`, snapshotId: `snap_${ID}`,
        contentHash: HASH, differsFromOthers: true, tokenEstimate: 1200, model: null,
      }],
      compressedRounds: [{ roundIndex: 1, summaryMessageId: `msg_${ID}`, summarizer: "claude" }],
      decidedVia: null,
      createdAt: TS,
      decidedAt: null,
    });
    assert.equal(b.items[0]?.differsFromOthers, true);
  });

  it("agent status allows every quota field to be unknown", () => {
    const s = AgentStatus.parse({
      agent: "codex", availability: "absent_quota", billing: "subscription",
      fiveHour: null, weekly: null, balance: null, contextUsedPercent: null, compactions: null,
      model: null, effort: null, updatedAt: TS,
    });
    assert.equal(s.weekly, null);
  });

  it("new events are part of the event stream", () => {
    assert.equal(ControlEvent.safeParse({ type: "round.updated", round: {} }).success, false);
    assert.ok(ControlEvent.options.some((o) => o.shape.type.value === "turn.updated"));
  });
});
