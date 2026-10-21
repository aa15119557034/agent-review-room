import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ApprovalBatch, ControlEvent, Round, Turn } from "@room/schemas";
import { createMockBridge, type MockOptions } from "../mock/mock-backend";

/**
 * 讨论室 mock 按画布「0-B 一轮的状态与记录」走一遍。
 * mock 不是后端参考实现，但它是 UI 开发时的"契约可执行说明"，语义必须和 0-B 一致。
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function ok<T>(p: Promise<{ ok: true; data: T } | { ok: false; error: string; message: string }>): Promise<T> {
  const r = await p;
  if (!r.ok) throw new Error(`${r.error}: ${r.message}`);
  return r.data;
}

function setup(opts: MockOptions = {}) {
  const bridge = createMockBridge({ tickMs: 1, reviewerConfigured: true, ...opts });
  const events: ControlEvent[] = [];
  bridge.onEvent((e) => events.push(e));
  const cmd = <T = any>(req: Record<string, unknown>) => ok<T>(bridge.command(req as never) as never);
  const q = <T = any>(req: Record<string, unknown>) => ok<T>(bridge.query(req as never) as never);
  return { bridge, events, cmd, q };
}

const stamp = (b: ApprovalBatch) => ({
  type: "batch.approve",
  batchId: b.id,
  expected: b.items.map((i) => ({ approvalId: i.approvalId, contentHash: i.contentHash })),
});

async function until(check: () => Promise<boolean>, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(5);
  }
  throw new Error("timed out waiting");
}

async function newTopic(cmd: ReturnType<typeof setup>["cmd"]) {
  const p = await cmd<{ id: string }>({ type: "project.create", name: "群聊讨论模式怎么做" });
  return p.id;
}

const draftReq = (projectId: string, recipients = ["deepseek", "codex"]) => ({
  type: "round.draft", projectId, recipients, task: "各自说说怎么做", taskSource: "human",
  planVersionId: null, historyMode: "recent_with_summaries",
});

describe("discussion mock follows canvas 0-B", () => {
  it("draft → stamp → everyone answers → summary (stamped) → plan draft → confirm → finalize", async () => {
    const { bridge, cmd, q } = setup();
    const pid = await newTopic(cmd);
    const { round, batch } = await cmd<{ round: Round; batch: ApprovalBatch }>(draftReq(pid));
    assert.equal(round.state, "DRAFT");
    assert.equal(batch.items.length, 2);
    assert.ok(batch.items.every((i) => !i.differsFromOthers));

    await cmd(stamp(batch));
    await until(async () => (await q<{ round: Round }>({ type: "rounds.get", roundId: round.id })).round.state === "AWAITING_SUMMARY");

    const msgs = await q<{ kind: string }[]>({ type: "messages.list", projectId: pid });
    assert.equal(msgs.filter((m) => m.kind === "agent_reply").length, 2);

    const sumBatch = await cmd<ApprovalBatch>({ type: "round.summarize", roundId: round.id, summarizer: "claude" });
    assert.equal(sumBatch.kind, "summary");
    await cmd(stamp(sumBatch));
    await until(async () => (await q<{ round: Round }>({ type: "rounds.get", roundId: round.id })).round.state === "SUMMARIZED");

    const got = await q<{ summary: { answered: number; expected: number; planVersionId: string } }>({ type: "rounds.get", roundId: round.id });
    assert.deepEqual([got.summary.answered, got.summary.expected], [2, 2]);
    const [plan] = await q<{ id: string; state: string; contentHash: string }[]>({ type: "plans.list", projectId: pid });
    assert.equal(plan?.state, "DRAFT");

    const early = await bridge.command({ type: "plan.finalize", planVersionId: plan!.id, expectedContentHash: plan!.contentHash } as never);
    assert.equal(!early.ok && early.error, "invalid_state", "a draft must be confirmed before it can be finalized");
    await cmd({ type: "plan.confirm", planVersionId: plan!.id });
    const wrong = await bridge.command({ type: "plan.finalize", planVersionId: plan!.id, expectedContentHash: "0".repeat(64) } as never);
    assert.equal(!wrong.ok && wrong.error, "stale_snapshot");
    const fin = await cmd<{ state: string }>({ type: "plan.finalize", planVersionId: plan!.id, expectedContentHash: plan!.contentHash });
    assert.equal(fin.state, "FINAL");
  });

  it("a stale hash rejects the whole batch and nothing is sent", async () => {
    const { bridge, cmd, q } = setup();
    const pid = await newTopic(cmd);
    const { batch } = await cmd<{ batch: ApprovalBatch }>(draftReq(pid));
    const bad = stamp(batch);
    bad.expected[1]!.contentHash = "0".repeat(64);
    const r = await bridge.command(bad as never);
    assert.equal(!r.ok && r.error, "stale_snapshot");
    const runs = await q<unknown[]>({ type: "runs.list", projectId: pid });
    assert.equal(runs.length, 0);
  });

  it("only one open round per topic", async () => {
    const { bridge, cmd } = setup();
    const pid = await newTopic(cmd);
    await cmd(draftReq(pid));
    const r = await bridge.command(draftReq(pid) as never);
    assert.equal(!r.ok && r.error, "invalid_state");
  });

  it("pause stops everyone (paused) and resume needs a new stamp with the same content", async () => {
    const { cmd, q } = setup({ tickMs: 20 });
    const pid = await newTopic(cmd);
    const { round, batch } = await cmd<{ round: Round; batch: ApprovalBatch }>(draftReq(pid));
    await cmd(stamp(batch));
    await sleep(70);
    const paused = await cmd<Round>({ type: "round.pause", roundId: round.id });
    assert.equal(paused.state, "PAUSED");
    const { turns } = await q<{ turns: Turn[] }>({ type: "rounds.get", roundId: round.id });
    assert.ok(turns.every((t) => t.outcome === "paused"), turns.map((t) => t.outcome).join());
    const { batch: resume } = await cmd<{ batch: ApprovalBatch }>({ type: "round.resume", roundId: round.id });
    assert.equal(resume.kind, "resume");
    assert.equal(resume.items.length, 2);
    await cmd(stamp(resume));
    const r2 = await q<{ round: Round }>({ type: "rounds.get", roundId: round.id });
    assert.equal(r2.round.state, "RUNNING");
  });

  it("interrupt + supplement: old turn interrupted (partial kept) and superseded by a new turn", async () => {
    const { cmd, q } = setup({ tickMs: 20 });
    const pid = await newTopic(cmd);
    const { round, batch } = await cmd<{ round: Round; batch: ApprovalBatch }>(draftReq(pid));
    await cmd(stamp(batch));
    await sleep(90);
    const { batch: sup } = await cmd<{ batch: ApprovalBatch }>({
      type: "round.supplement", roundId: round.id, content: "重点讨论手机端盖章", mode: "restart_now", targets: ["deepseek"],
    });
    assert.equal(sup.kind, "supplement");
    const { turns } = await q<{ turns: Turn[] }>({ type: "rounds.get", roundId: round.id });
    const ds = turns.filter((t) => t.agent === "deepseek");
    assert.equal(ds[0]?.outcome, "interrupted");
    assert.ok(ds[0]?.partialText, "partial text kept");
    assert.equal(ds[0]?.supersededBy, ds[1]?.id);
    assert.equal(ds[1]?.outcome, "pending");
  });

  it("'only' supplement marks the recipient as having received extra information", async () => {
    const { cmd } = setup();
    const pid = await newTopic(cmd);
    const { round, batch } = await cmd<{ round: Round; batch: ApprovalBatch }>(draftReq(pid));
    await cmd(stamp(batch));
    const { batch: only } = await cmd<{ batch: ApprovalBatch }>({
      type: "round.supplement", roundId: round.id, content: "只给你看", mode: "only", targets: ["codex"],
    });
    assert.equal(only.items[0]?.differsFromOthers, true);
  });

  it("running out of quota midway = absent (quota), the others carry on, the round still finishes", async () => {
    const { cmd, q } = setup({ discussion: { quotaMidway: ["codex"] } });
    const pid = await newTopic(cmd);
    const { round, batch } = await cmd<{ round: Round; batch: ApprovalBatch }>(draftReq(pid));
    await cmd(stamp(batch));
    await until(async () => (await q<{ round: Round }>({ type: "rounds.get", roundId: round.id })).round.state === "AWAITING_SUMMARY");
    const { turns } = await q<{ turns: Turn[] }>({ type: "rounds.get", roundId: round.id });
    assert.equal(turns.find((t) => t.agent === "codex")?.outcome, "absent_quota");
    assert.equal(turns.find((t) => t.agent === "deepseek")?.outcome, "answered");
    const status = await q<{ agent: string; availability: string }[]>({ type: "agents.status" });
    assert.equal(status.find((s) => s.agent === "codex")?.availability, "absent_quota");
  });

  it("an absent agent cannot be drafted into a new round", async () => {
    const { bridge, cmd } = setup({ discussion: { absentAgents: ["codex"] } });
    const pid = await newTopic(cmd);
    const r = await bridge.command(draftReq(pid) as never);
    assert.equal(!r.ok && r.error, "agent_unavailable");
  });

  it("end round: unfinished turns become round_ended and pending stamps are cancelled", async () => {
    const { cmd, q } = setup({ tickMs: 20 });
    const pid = await newTopic(cmd);
    const { round, batch } = await cmd<{ round: Round; batch: ApprovalBatch }>(draftReq(pid));
    await cmd(stamp(batch));
    await sleep(70);
    const ended = await cmd<Round>({ type: "round.end", roundId: round.id });
    assert.equal(ended.state, "AWAITING_SUMMARY");
    const { turns } = await q<{ turns: Turn[] }>({ type: "rounds.get", roundId: round.id });
    assert.ok(turns.every((t) => t.outcome === "round_ended"));
  });

  it("void (改方向): round VOIDED with reason, records kept", async () => {
    const { cmd, q } = setup({ tickMs: 20 });
    const pid = await newTopic(cmd);
    const { round, batch } = await cmd<{ round: Round; batch: ApprovalBatch }>(draftReq(pid));
    await cmd(stamp(batch));
    await sleep(70);
    const v = await cmd<Round>({ type: "round.void", roundId: round.id, reason: "方向错了" });
    assert.equal(v.state, "VOIDED");
    assert.equal(v.voidReason, "方向错了");
    const { turns } = await q<{ turns: Turn[] }>({ type: "rounds.get", roundId: round.id });
    assert.equal(turns.length, 2, "turns kept");
  });

  it("every run ends with exactly one terminal event", async () => {
    const { cmd, q } = setup({ tickMs: 5, discussion: { quotaMidway: ["codex"] } });
    const pid = await newTopic(cmd);
    const { round, batch } = await cmd<{ round: Round; batch: ApprovalBatch }>(draftReq(pid));
    await cmd(stamp(batch));
    await sleep(30);
    await cmd({ type: "round.supplement", roundId: round.id, content: "补充", mode: "restart_now", targets: ["deepseek"] }).catch(() => undefined);
    await sleep(300);
    const runs = await q<{ id: string; state: string }[]>({ type: "runs.list", projectId: pid });
    for (const r of runs) {
      const evs = await q<{ type: string }[]>({ type: "runs.events", runId: r.id });
      const terminals = evs.filter((e) => ["completed", "error", "cancelled", "timed_out"].includes(e.type));
      if (r.state === "QUEUED") assert.equal(terminals.length, 0);
      else assert.equal(terminals.length, 1, `${r.id} ${r.state}`);
    }
  });
});

