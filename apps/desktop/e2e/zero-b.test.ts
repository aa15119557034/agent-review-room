import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ulid } from "@room/db";
import {
  ANSWER_JSON,
  approve,
  approveOf,
  draft,
  failure,
  makeE2E,
  roundState,
  runEvents,
  sha,
  sleep,
  turnRows,
  waitFor,
  waitRoundDone,
  type BatchLike,
  type E2E,
} from "./harness";

/**
 * X-21：0-B 的 13 种情况（ADR-002 附录 A），一条测试对应一行（#10 由 X-32 拆成 a～d）。
 * 节点是本地假 AgentServer，主控端是真的 dispatcher / DiscussionService / Orchestrator / DB。
 */

const OK_QUOTA = {
  fiveHour: { usedPercent: 20, windowMinutes: 300, resetsAt: null },
  weekly: { usedPercent: 30, windowMinutes: 10_080, resetsAt: null },
  creditsInUse: false,
  readAt: "2026-11-02T00:00:00.000Z",
};
const EXHAUSTED = { ...OK_QUOTA, fiveHour: { usedPercent: 100, windowMinutes: 300, resetsAt: null } };

/** 这一轮就此作废（记录保留），好开下一轮 */
async function closeRound(h: E2E, roundId: string): Promise<void> {
  const voided = await h.dispatcher.handleCommand({ type: "round.void", roundId, reason: "开下一轮" });
  assert.equal(voided.ok, true, JSON.stringify(voided));
}

async function openRound(
  h: E2E,
  recipients: string[],
  extra: Parameters<typeof draft>[2] = {},
): Promise<{ roundId: string; batch: BatchLike }> {
  const result = (await draft(h, recipients, extra)) as { ok: boolean; data?: { round: { id: string }; batch: BatchLike } };
  assert.equal(result.ok, true, JSON.stringify(result));
  return { roundId: result.data!.round.id, batch: result.data!.batch };
}

function stateOfRun(h: E2E, runId: string): string {
  return (h.db.prepare("SELECT state FROM runs WHERE id = ?").get(runId) as { state: string }).state;
}

function terminalsOf(h: E2E, runId: string): number {
  return runEvents(h, runId).filter((e) =>
    ["completed", "error", "cancelled", "timed_out"].includes(e.type),
  ).length;
}

async function waitTurn(h: E2E, roundId: string, agent: string, outcome: string): Promise<void> {
  await waitFor(
    () =>
      (
        h.db
          .prepare("SELECT outcome FROM turns WHERE round_id = ? AND agent = ? AND is_summary = 0 ORDER BY rowid DESC LIMIT 1")
          .get(roundId, agent) as { outcome: string }
      ).outcome === outcome,
    agent + " " + outcome,
  );
}

function runIdOf(h: E2E, roundId: string, agent: string): string {
  return (h.db.prepare("SELECT run_id FROM turns WHERE round_id = ? AND agent = ? AND is_summary = 0").get(roundId, agent) as { run_id: string }).run_id;
}

describe("0-B 一轮的状态与记录（X-21）", () => {
  it("0-B #1 盖章发送：一次批准、每人一个 Run、指纹，盖章后内容不能改", async () => {
    const h = await makeE2E();
    const { roundId, batch } = await openRound(h, ["claude", "codex"]);
    assert.equal(batch.kind, "initial");
    assert.equal(batch.state, "READY_FOR_REVIEW");
    assert.equal(batch.items.length, 2);

    const snapshots = h.db.prepare("SELECT content, content_hash, reviewer_agent FROM prompt_snapshots ORDER BY reviewer_agent").all() as {
      content: string;
      content_hash: string;
      reviewer_agent: string;
    }[];
    assert.equal(snapshots.length, 2);
    assert.ok(snapshots.every((s) => s.content_hash === sha(s.content)));
    assert.notEqual(snapshots[0]!.content_hash, snapshots[1]!.content_hash, "每个人收到的内容不同");

    await approveOf(h, { data: { batch } });
    await waitFor(() => roundState(h, roundId) === "RUNNING", "running");
    assert.equal(roundState(h, roundId), "RUNNING");
    assert.equal((h.db.prepare("SELECT count(*) AS n FROM runs").get() as { n: number }).n, 2);

    const again = await h.dispatcher.handleCommand({ type: "round.redraft", roundId });
    assert.equal(failure(again).error, "invalid_state", "盖章后内容不能改");
    await h.close();
  });

  it("0-B #2 所有人都有结局 → 待汇总，每个 Run 恰好一个结局", async () => {
    const h = await makeE2E({
      userPc: { "claude-review": { kind: "answer", text: "claude 答" } },
      controller: {
        "codex-discuss": { kind: "error", reason: "process_exit_nonzero", message: "boom" },
        "deepseek-discuss": { kind: "error", reason: "quota_exhausted" },
      },
    });
    const { roundId, batch } = await openRound(h, ["claude", "codex", "deepseek"]);
    await approveOf(h, { data: { batch } });
    await waitRoundDone(h, roundId, "AWAITING_SUMMARY");

    const turns = turnRows(h, roundId);
    assert.deepEqual(
      Object.fromEntries(turns.map((t) => [t.agent, t.outcome])),
      { claude: "answered", codex: "failed", deepseek: "absent_quota" },
    );
    for (const turn of turns) {
      const runId = (h.db.prepare("SELECT run_id FROM turns WHERE id = ?").get(turn.id) as { run_id: string }).run_id;
      assert.equal(terminalsOf(h, runId), 1, turn.agent + " 恰好一个终止事件");
    }
    await h.close();
  });

  it("0-B #3 结束本轮：没答完的立刻停，Turn round_ended，已写部分保留", async () => {
    const h = await makeE2E({
      userPc: { "claude-review": { kind: "hold", deltas: ["Claude 写到一半"] } },
      controller: { "codex-discuss": { kind: "hold", deltas: ["Codex 写到一半"] } },
    });
    const { roundId, batch } = await openRound(h, ["claude", "codex"]);
    await approveOf(h, { data: { batch } });
    await waitFor(() => stateOfRun(h, runIdOf(h, roundId, "claude")) === "RUNNING", "claude running");
    await waitFor(
      () => (h.db.prepare("SELECT count(*) AS n FROM run_events WHERE type = 'message_delta'").get() as { n: number }).n >= 2,
      "partial deltas",
    );

    const ended = await h.dispatcher.handleCommand({ type: "round.end", roundId });
    assert.equal(ended.ok, true, JSON.stringify(ended));
    await waitRoundDone(h, roundId, "AWAITING_SUMMARY");
    const turns = turnRows(h, roundId);
    assert.ok(turns.every((t) => t.outcome === "round_ended"));
    assert.ok(turns.some((t) => (t.partial_text ?? "").includes("写到一半")), "已写部分保留");
    await h.close();
  });

  it("0-B #4 打断 + 补充：旧 Turn interrupted + 新批次/新 Run/新指纹，两段都在", async () => {
    const h = await makeE2E({
      userPc: { "claude-review": { kind: "answer", text: "claude 答" } },
      controller: { "deepseek-discuss": { kind: "hold", deltas: ["DeepSeek 第一段"] } },
    });
    const { roundId, batch } = await openRound(h, ["claude", "deepseek"]);
    await approveOf(h, { data: { batch } });
    await waitFor(() => stateOfRun(h, runIdOf(h, roundId, "deepseek")) === "RUNNING", "deepseek running");
    await waitFor(
      () => (h.db.prepare("SELECT count(*) AS n FROM run_events WHERE type = 'message_delta'").get() as { n: number }).n >= 1,
      "partial",
    );

    const added = (await h.dispatcher.handleCommand({
      type: "round.supplement",
      roundId,
      content: "再补一句：先看失败路径",
      mode: "restart_now",
      targets: ["deepseek"],
    })) as { ok: boolean; data: { batch: BatchLike; note: { kind: string } } };
    assert.equal(added.ok, true, JSON.stringify(added));
    assert.equal(added.data.note.kind, "human_note");
    assert.equal(added.data.batch.kind, "supplement");
    assert.equal(added.data.batch.items.length, 1);

    const deepseekTurns = turnRows(h, roundId).filter((t) => t.agent === "deepseek");
    assert.equal(deepseekTurns[0]!.outcome, "interrupted");
    assert.ok((deepseekTurns[0]!.partial_text ?? "").includes("第一段"));
    assert.equal(deepseekTurns[1]!.outcome, "pending");

    h.nodes.controller.setBehavior("deepseek-discuss", { kind: "answer", text: "deepseek 重答" });
    await approveOf(h, { data: { batch: added.data.batch } });
    await waitFor(
      () => (h.db.prepare("SELECT outcome FROM turns WHERE round_id = ? AND agent = 'deepseek' ORDER BY rowid DESC LIMIT 1").get(roundId) as { outcome: string }).outcome === "answered",
      "deepseek answered",
    );
    assert.equal(h.nodes.controller.starts.filter((s) => s.profileId === "deepseek-discuss").length, 2, "两段都发了 Run");
    await h.close();
  });

  it("0-B #5 全部暂停：正在答的立刻停，Turn paused，计时停", async () => {
    const h = await makeE2E({
      userPc: { "claude-review": { kind: "hold", deltas: ["C 半页"] } },
      controller: { "codex-discuss": { kind: "hold", deltas: ["X 半页"] } },
    });
    const { roundId, batch } = await openRound(h, ["claude", "codex"]);
    await approveOf(h, { data: { batch } });
    await waitFor(() => stateOfRun(h, runIdOf(h, roundId, "claude")) === "RUNNING", "running");
    await sleep(80);

    const paused = await h.dispatcher.handleCommand({ type: "round.pause", roundId });
    assert.equal(paused.ok, true, JSON.stringify(paused));
    assert.equal(roundState(h, roundId), "PAUSED");
    const ones = turnRows(h, roundId);
    assert.ok(ones.every((t) => t.outcome === "paused"), "Turn 都是 paused");
    const round = h.db.prepare("SELECT started_at, active_ms FROM rounds WHERE id = ?").get(roundId) as { started_at: string | null; active_ms: number };
    assert.equal(round.started_at, null, "计时停");
    assert.ok(round.active_ms >= 0);
    await h.close();
  });

  it("0-B #6 恢复：内容不变，resume 批次，新 Run，计时接着算", async () => {
    const h = await makeE2E({
      userPc: { "claude-review": { kind: "hold", deltas: ["C 半页"] } },
      controller: { "codex-discuss": { kind: "hold", deltas: ["X 半页"] } },
    });
    const { roundId, batch } = await openRound(h, ["claude", "codex"]);
    await approveOf(h, { data: { batch } });
    await waitFor(() => stateOfRun(h, runIdOf(h, roundId, "claude")) === "RUNNING", "running");
    await h.dispatcher.handleCommand({ type: "round.pause", roundId });
    assert.equal(roundState(h, roundId), "PAUSED");
    const before = h.db.prepare("SELECT active_ms FROM rounds WHERE id = ?").get(roundId) as { active_ms: number };

    h.nodes.userPc.setBehavior("claude-review", { kind: "answer", text: "恢复后答" });
    h.nodes.controller.setBehavior("codex-discuss", { kind: "answer", text: "恢复后答" });
    const resumed = (await h.dispatcher.handleCommand({ type: "round.resume", roundId })) as {
      ok: boolean;
      data: { batch: BatchLike; round: { state: string } };
    };
    assert.equal(resumed.ok, true, JSON.stringify(resumed));
    assert.equal(resumed.data.batch.kind, "resume");
    assert.equal(resumed.data.round.state, "PAUSED", "盖章前还是暂停中");
    const snapshotBefore = h.db.prepare("SELECT content_hash FROM prompt_snapshots ORDER BY created_at LIMIT 1").get() as { content_hash: string };

    await approveOf(h, { data: { batch: resumed.data.batch } });
    await waitRoundDone(h, roundId, "AWAITING_SUMMARY");
    const after = h.db.prepare("SELECT active_ms FROM rounds WHERE id = ?").get(roundId) as { active_ms: number };
    assert.ok(after.active_ms >= before.active_ms, "计时接着算");
    const snapshotAfter = h.db.prepare("SELECT content FROM prompt_snapshots WHERE reviewer_agent = 'claude' ORDER BY created_at DESC LIMIT 1").get() as { content: string };
    assert.ok(snapshotAfter.content.includes("各自说说怎么做"), "内容不变还是同一轮任务");
    assert.ok(snapshotBefore.content_hash.length === 64);
    await h.close();
  });

  it("0-B #7 额度用尽：Run FAILED(quota_exhausted) → Turn absent_quota，其他人继续", async () => {
    const h = await makeE2E({
      userPc: { "claude-review": { kind: "answer", text: "C 答" } },
      controller: {
        "codex-discuss": { kind: "error", reason: "quota_exhausted" },
        "deepseek-discuss": { kind: "answer", text: "D 答" },
      },
    });
    const { roundId, batch } = await openRound(h, ["claude", "codex", "deepseek"]);
    await approveOf(h, { data: { batch } });
    await waitRoundDone(h, roundId, "AWAITING_SUMMARY");
    const turns = turnRows(h, roundId);
    assert.equal(turns.find((t) => t.agent === "codex")!.outcome, "absent_quota");
    assert.equal(turns.find((t) => t.agent === "claude")!.outcome, "answered");
    assert.equal(turns.find((t) => t.agent === "deepseek")!.outcome, "answered");
    const codexRun = runIdOf(h, roundId, "codex");
    assert.equal(stateOfRun(h, codexRun), "FAILED");
    await h.close();
  });

  it("0-B #8 超时 / 出错：Turn 可单独重试（retry 批次，新 Run）", async () => {
    const h = await makeE2E({
      userPc: { "claude-review": { kind: "answer", text: "C 答" } },
      controller: {
        "codex-discuss": [{ kind: "error", reason: "internal" }, { kind: "answer", text: "重试后答" }],
        "deepseek-discuss": { kind: "timeout", timeoutKind: "idle" },
      },
    });
    const { roundId, batch } = await openRound(h, ["claude", "codex", "deepseek"]);
    await approveOf(h, { data: { batch } });
    await waitRoundDone(h, roundId, "AWAITING_SUMMARY");
    assert.equal(turnRows(h, roundId).find((t) => t.agent === "deepseek")!.outcome, "timed_out");

    const retried = (await h.dispatcher.handleCommand({ type: "round.retry", roundId, agent: "codex" })) as {
      ok: boolean;
      data: BatchLike;
    };
    assert.equal(retried.ok, true, JSON.stringify(retried));
    assert.equal(retried.data.kind, "retry");
    const approvedRetry = await approve(h, retried.data);
    assert.equal(approvedRetry.ok, true, JSON.stringify(approvedRetry) + " / " + JSON.stringify(turnRows(h, roundId)));
    await waitTurn(h, roundId, "codex", "answered");
    assert.equal(h.nodes.controller.starts.filter((s) => s.profileId === "codex-discuss").length, 2);
    await h.close();
  });

  it("0-B #9 补充只发给一个人：differsFromOthers = true，额外信息进时间线", async () => {
    const h = await makeE2E({
      userPc: { "claude-review": { kind: "answer", text: "C 答" } },
      controller: { "codex-discuss": { kind: "hold" } },
    });
    const { roundId, batch } = await openRound(h, ["claude", "codex"]);
    await approveOf(h, { data: { batch } });
    await waitFor(() => stateOfRun(h, runIdOf(h, roundId, "codex")) === "RUNNING", "codex running");
    await waitTurn(h, roundId, "claude", "answered");

    const added = (await h.dispatcher.handleCommand({
      type: "round.supplement",
      roundId,
      content: "只给 Codex 的额外信息",
      mode: "only",
      targets: ["codex"],
    })) as { ok: boolean; data: { batch: BatchLike; note: { kind: string } } };
    assert.equal(added.ok, true, JSON.stringify(added));
    assert.equal(added.data.batch.items.length, 1);
    assert.equal(added.data.batch.items[0]!.recipient, "codex");
    assert.equal(added.data.batch.items[0]!.differsFromOthers, true);
    assert.equal(added.data.note.kind, "human_note");

    const snapshot = h.db.prepare("SELECT content FROM prompt_snapshots ORDER BY created_at DESC LIMIT 1").get() as { content: string };
    assert.match(snapshot.content, /只给 Codex 的额外信息/, "补充内容要发给 Codex");
    await h.close();
  });

  // X-32：#10 不再写库模拟，走 D-32 的真命令：节点上报额度 → 自动缺席 → 替补派发 / 重试替补
  it("0-B #10a 自动替补：额度用尽的人按 AgentProfile.substitute 派给替补，onBehalfOf 记录，替补不能当汇总者", async () => {
    const h = await makeE2E({
      userPc: { "claude-review": { kind: "answer", text: "替补答" } },
      controller: { "deepseek-discuss": { kind: "answer", text: "D 答" } },
      controllerQuota: { "codex-discuss": EXHAUSTED, "deepseek-discuss": OK_QUOTA },
      userPcQuota: { "claude-review": OK_QUOTA },
    });
    const set = await h.dispatcher.handleCommand({ type: "agent.update", id: "codex", substitute: "claude" });
    assert.equal(set.ok, true, JSON.stringify(set));

    const { roundId, batch } = await openRound(h, ["codex", "deepseek"]);
    const items = batch.items.map((item) => ({ recipient: item.recipient, onBehalfOf: item.onBehalfOf }));
    assert.deepEqual(
      items.sort((a, b) => a.recipient.localeCompare(b.recipient)),
      [
        { recipient: "claude", onBehalfOf: "codex" },
        { recipient: "deepseek", onBehalfOf: null },
      ],
    );
    const round = h.db.prepare("SELECT recipients FROM rounds WHERE id = ?").get(roundId) as { recipients: string };
    assert.deepEqual(JSON.parse(round.recipients), ["codex", "deepseek"], "轮里还是原来的收件人");

    await approveOf(h, { data: { batch } });
    await waitRoundDone(h, roundId, "AWAITING_SUMMARY");
    const turns = turnRows(h, roundId);
    assert.equal(turns.find((t) => t.agent === "codex"), undefined, "缺席的人不起 Run");
    const claude = turns.find((t) => t.agent === "claude")!;
    assert.equal(claude.outcome, "answered");
    assert.equal(claude.on_behalf_of, "codex");
    assert.equal(h.nodes.controller.starts.filter((s) => s.profileId === "codex-discuss").length, 0);

    const rejected = await h.dispatcher.handleCommand({ type: "round.summarize", roundId, summarizer: "claude" });
    assert.equal(failure(rejected).error, "invalid_state", "替补不能当汇总者");
    await h.close();
  });

  it("0-B #10b 显式替补：substitutes 指定谁替谁；[] = 不替 → 缺席的人 agent_unavailable；替补自己也用完 → agent_unavailable", async () => {
    const h = await makeE2E({
      userPc: { "claude-review": { kind: "answer", text: "C 答" } },
      controller: { "deepseek-discuss": { kind: "answer", text: "替补答" } },
      controllerQuota: { "codex-discuss": EXHAUSTED, "deepseek-discuss": OK_QUOTA },
      userPcQuota: { "claude-review": OK_QUOTA },
    });
    await h.dispatcher.handleCommand({ type: "agent.update", id: "codex", substitute: "claude" });

    const none = await draft(h, ["codex", "claude"], { substitutes: [] });
    assert.equal(failure(none).error, "agent_unavailable", "[] 表示谁都不替");

    const { roundId, batch } = await openRound(h, ["codex", "claude"], {
      substitutes: [{ absent: "codex", substitute: "deepseek" }],
    });
    const deepseek = batch.items.find((item) => item.recipient === "deepseek")!;
    assert.equal(deepseek.onBehalfOf, "codex", "显式指定的替补优先于 AgentProfile.substitute");
    await approveOf(h, { data: { batch } });
    await waitRoundDone(h, roundId, "AWAITING_SUMMARY");
    assert.equal(turnRows(h, roundId).find((t) => t.agent === "deepseek")!.on_behalf_of, "codex");

    // 替补自己也额度用完：下一轮发不出去（不做替补链）
    await closeRound(h, roundId);
    h.nodes.controller.setQuota("deepseek-discuss", EXHAUSTED);
    const chained = await draft(h, ["codex", "claude"], { substitutes: [{ absent: "codex", substitute: "deepseek" }] });
    assert.equal(failure(chained).error, "agent_unavailable");
    await h.close();
  });

  it("0-B #10c 答到一半额度用完：round.retry 带 substitute 让替补代答，旧 Turn 被接上，不能再派第二个替补", async () => {
    const h = await makeE2E({
      userPc: { "claude-review": { kind: "answer", text: "替补接着答" } },
      controller: {
        "codex-discuss": { kind: "error", reason: "quota_exhausted" },
        "deepseek-discuss": { kind: "answer", text: "D 答" },
      },
      userPcQuota: { "claude-review": OK_QUOTA },
      controllerQuota: { "codex-discuss": OK_QUOTA, "deepseek-discuss": OK_QUOTA },
    });
    const { roundId, batch } = await openRound(h, ["codex", "deepseek"]);
    await approveOf(h, { data: { batch } });
    await waitRoundDone(h, roundId, "AWAITING_SUMMARY");
    const absent = turnRows(h, roundId).find((t) => t.agent === "codex")!;
    assert.equal(absent.outcome, "absent_quota");

    const self = await h.dispatcher.handleCommand({ type: "round.retry", roundId, agent: "codex", substitute: "codex" });
    assert.equal(failure(self).error, "validation_failed", "不能自己替自己");

    const retried = (await h.dispatcher.handleCommand({ type: "round.retry", roundId, agent: "codex", substitute: "claude" })) as {
      ok: boolean;
      data: BatchLike;
    };
    assert.equal(retried.ok, true, JSON.stringify(retried));
    assert.equal(retried.data.kind, "retry");
    assert.equal(retried.data.items[0]!.recipient, "claude");
    assert.equal(retried.data.items[0]!.onBehalfOf, "codex");
    const superseded = h.db.prepare("SELECT superseded_by FROM turns WHERE id = ?").get(absent.id) as { superseded_by: string | null };
    assert.ok(superseded.superseded_by, "旧的缺席 Turn 被替补的新 Turn 接上");

    const again = await h.dispatcher.handleCommand({ type: "round.retry", roundId, agent: "codex", substitute: "deepseek" });
    assert.equal(failure(again).error, "invalid_state", "已经在重试了，不能再派第二个替补");

    const approved = await approve(h, retried.data);
    assert.equal(approved.ok, true, JSON.stringify(approved));
    await waitTurn(h, roundId, "claude", "answered");
    assert.equal(turnRows(h, roundId).find((t) => t.agent === "claude")!.on_behalf_of, "codex");
    const rejected = await h.dispatcher.handleCommand({ type: "round.summarize", roundId, summarizer: "claude" });
    assert.equal(failure(rejected).error, "invalid_state", "替补不能当汇总者");
    await h.close();
  });

  it("0-B #10d 粘滞缺席：quota_exhausted 之后读不到额度仍算缺席，读到 ok 才恢复", async () => {
    const h = await makeE2E({
      userPc: { "claude-review": { kind: "answer", text: "C 答" } },
      controller: { "codex-discuss": [{ kind: "error", reason: "quota_exhausted" }, { kind: "answer", text: "恢复后答" }] },
      userPcQuota: { "claude-review": OK_QUOTA },
      controllerQuota: { "codex-discuss": OK_QUOTA },
    });
    const first = await openRound(h, ["codex", "claude"]);
    await approveOf(h, { data: { batch: first.batch } });
    await waitRoundDone(h, first.roundId, "AWAITING_SUMMARY");
    assert.equal(turnRows(h, first.roundId).find((t) => t.agent === "codex")!.outcome, "absent_quota");

    await closeRound(h, first.roundId);
    // 节点读不到额度（404 = 未知）：未知不清粘滞缺席，Codex 没设替补 → 发不出去
    h.nodes.controller.setQuota("codex-discuss", null);
    const blocked = await draft(h, ["codex", "claude"], { task: "第二轮" });
    assert.equal(failure(blocked).error, "agent_unavailable");
    assert.match(failure(blocked).message, /没配额度来源/, "404 时理由里提示节点没配额度来源");

    // 读到 ok 才恢复
    h.nodes.controller.setQuota("codex-discuss", { ...OK_QUOTA, readAt: new Date().toISOString() });
    const reopened = await draft(h, ["codex", "claude"], { task: "第二轮" });
    assert.equal((reopened as { ok: boolean }).ok, true, JSON.stringify(reopened));
    await h.close();
  });

  it("0-B #11 汇总（成功 + 失败退回）", async () => {
    const h = await makeE2E({
      controller: { "deepseek-discuss": { kind: "answer", text: "D 答" } },
      userPc: { "claude-review": { kind: "answer", text: ANSWER_JSON } },
    });
    const first = await openRound(h, ["deepseek"]);
    await approveOf(h, { data: { batch: first.batch } });
    await waitRoundDone(h, first.roundId, "AWAITING_SUMMARY");
    const requested = (await h.dispatcher.handleCommand({ type: "round.summarize", roundId: first.roundId, summarizer: "claude" })) as {
      ok: boolean;
      data: BatchLike;
    };
    assert.equal(requested.ok, true, JSON.stringify(requested));
    await approve(h, requested.data as BatchLike);
    await waitRoundDone(h, first.roundId, "SUMMARIZED");
    const summary = h.db.prepare("SELECT answered, expected, plan_version_id FROM round_summaries WHERE round_id = ?").get(first.roundId) as {
      answered: number;
      expected: number;
      plan_version_id: string;
    };
    assert.equal(summary.answered, 1);
    assert.equal(summary.expected, 1);
    assert.ok(summary.plan_version_id);
    assert.equal((h.db.prepare("SELECT count(*) AS n FROM messages WHERE kind = 'summary'").get() as { n: number }).n, 1);

    // 汇总失败：轮退回 AWAITING_SUMMARY，不写 summary / RoundSummary
    const second = await openRound(h, ["deepseek"], { task: "再来一轮" });
    h.nodes.userPc.setBehavior("claude-review", { kind: "error", reason: "internal" });
    await approveOf(h, { data: { batch: second.batch } });
    await waitRoundDone(h, second.roundId, "AWAITING_SUMMARY");
    const requestFail = (await h.dispatcher.handleCommand({ type: "round.summarize", roundId: second.roundId, summarizer: "claude" })) as {
      ok: boolean;
      data: BatchLike;
    };
    assert.equal(requestFail.ok, true);
    await approve(h, requestFail.data);
    await waitRoundDone(h, second.roundId, "AWAITING_SUMMARY");
    assert.equal((h.db.prepare("SELECT count(*) AS n FROM round_summaries WHERE round_id = ?").get(second.roundId) as { n: number }).n, 0);
    await h.close();
  });

  it("0-B #12 盖章定稿：方案 vN → FINAL（校验 contentHash），可派生 vN+1", async () => {
    const h = await makeE2E({
      controller: { "deepseek-discuss": { kind: "answer", text: "D 答" } },
      userPc: { "claude-review": { kind: "answer", text: ANSWER_JSON } },
    });
    const first = await openRound(h, ["deepseek"]);
    await approveOf(h, { data: { batch: first.batch } });
    await waitRoundDone(h, first.roundId, "AWAITING_SUMMARY");
    const requested = (await h.dispatcher.handleCommand({ type: "round.summarize", roundId: first.roundId, summarizer: "claude" })) as {
      ok: boolean;
      data: BatchLike;
    };
    await approve(h, requested.data as BatchLike);
    await waitRoundDone(h, first.roundId, "SUMMARIZED");
    const plan = h.db.prepare("SELECT id, content_hash FROM plan_versions WHERE state = 'DRAFT'").get() as { id: string; content_hash: string };

    const confirmed = await h.dispatcher.handleCommand({ type: "plan.confirm", planVersionId: plan.id });
    assert.equal(confirmed.ok, true, JSON.stringify(confirmed));
    const wrong = await h.dispatcher.handleCommand({ type: "plan.finalize", planVersionId: plan.id, expectedContentHash: "0".repeat(64) });
    assert.equal(failure(wrong).error, "stale_snapshot");
    const finalized = await h.dispatcher.handleCommand({ type: "plan.finalize", planVersionId: plan.id, expectedContentHash: plan.content_hash });
    assert.equal(finalized.ok, true, JSON.stringify(finalized));
    assert.equal((h.db.prepare("SELECT state FROM plan_versions WHERE id = ?").get(plan.id) as { state: string }).state, "FINAL");

    const derived = (await h.dispatcher.handleCommand({ type: "plan.derive", planVersionId: plan.id })) as {
      ok: boolean;
      data: { version: number; parentId: string };
    };
    assert.equal(derived.ok, true, JSON.stringify(derived));
    assert.equal(derived.data.version, 2);
    assert.equal(derived.data.parentId, plan.id);
    await h.close();
  });

  it("0-B #13 改方向作废：Round VOIDED + reason，记录保留，基于它的方案草稿 SUPERSEDED", async () => {
    const h = await makeE2E({
      controller: { "deepseek-discuss": { kind: "hold", deltas: ["D 半页"] } },
    });
    const { roundId, batch } = await openRound(h, ["deepseek"]);
    await approveOf(h, { data: { batch } });
    await waitFor(() => stateOfRun(h, runIdOf(h, roundId, "deepseek")) === "RUNNING", "running");

    const planId = "plan_" + ulid();
    h.db.prepare(
      "INSERT INTO plan_versions (id, project_id, version, state, content, content_hash, change_note, based_on_round_id, drafted_by_kind, drafted_by_agent, created_at) " +
        "VALUES (?, ?, 1, 'DRAFT', '# 基于这一轮的草稿', ?, '', ?, 'agent', 'claude', ?)",
    ).run(planId, h.projectId, sha("# 基于这一轮的草稿"), roundId, new Date().toISOString());

    const voided = await h.dispatcher.handleCommand({ type: "round.void", roundId, reason: "方向错了" });
    assert.equal(voided.ok, true, JSON.stringify(voided));
    assert.equal(roundState(h, roundId), "VOIDED");
    const round = h.db.prepare("SELECT void_reason FROM rounds WHERE id = ?").get(roundId) as { void_reason: string };
    assert.equal(round.void_reason, "方向错了");
    assert.equal((h.db.prepare("SELECT state FROM plan_versions WHERE id = ?").get(planId) as { state: string }).state, "SUPERSEDED");
    assert.ok(turnRows(h, roundId).every((t) => t.outcome === "round_ended"));
    assert.ok((h.db.prepare("SELECT count(*) AS n FROM run_events").get() as { n: number }).n > 0, "记录保留");
    await h.close();
  });
});
