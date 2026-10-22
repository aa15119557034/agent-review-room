import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AgentEvent, PlanVersion, Round, RoundSummary, Turn } from "@room/schemas";
import { canDerive, diffLines, displayedPlan, initialDiscussion, planForNextRound, stages, turnText } from "../lib/discussion";

const TS = "2026-10-21T00:00:00.000Z";
const round = (index: number, state: Round["state"]): Round => ({
  id: `rnd_${index}`, projectId: "proj_1", index, state, task: "t", taskSource: "human", recipients: ["deepseek"],
  planVersionId: null, historyMode: "full", voidReason: state === "VOIDED" ? "x" : null, activeMs: 0,
  createdAt: TS, startedAt: null, finishedAt: null,
});

describe("plan diff", () => {
  it("marks added, removed and unchanged lines in order", () => {
    const out = diffLines("1. a\n2. b\n3. c", "1. a\n2. B\n3. c\n4. d");
    assert.deepEqual(out.map((l) => `${l.kind[0]}:${l.text}`), ["s:1. a", "r:2. b", "a:2. B", "s:3. c", "a:4. d"]);
  });
  it("first version is all additions", () => {
    assert.ok(diffLines("", "x\ny").filter((l) => l.kind === "added").length === 2);
  });
});

describe("stage bar", () => {
  it("shows rounds, summaries with plan versions, voided rounds and the final stage", () => {
    const plan = { id: "plan_1", version: 1, state: "CURRENT" } as PlanVersion;
    const sum = { roundId: "rnd_1", planVersionId: "plan_1" } as RoundSummary;
    const d = { ...initialDiscussion, rounds: [round(1, "SUMMARIZED"), round(2, "VOIDED"), round(3, "RUNNING")], summaries: [sum], plans: [plan] };
    const labels = stages(d).map((s) => `${s.label}/${s.state}`);
    assert.deepEqual(labels, ["议题/done", "第 1 轮/done", "汇总 v1/done", "第 2 轮/voided", "第 3 轮/current", "定稿/todo", "执行/todo"]);
  });
});

describe("turn text", () => {
  const turn = (outcome: Turn["outcome"], partialText: string | null) =>
    ({ id: "turn_1", outcome, partialText, runId: "run_1" }) as unknown as Turn;
  const delta = (seq: number, text: string) =>
    ({ eventId: `e${seq}`, runId: "run_1", seq, ts: TS, type: "message_delta", text }) as AgentEvent;
  const evs = [delta(0, "已经写了"), delta(1, "一半")];

  it("a stopped turn keeps what was already written even if the record has no partialText", () => {
    assert.deepEqual(turnText(turn("paused", null), null, evs), { text: "已经写了一半", live: false });
  });
  it("the stored partialText wins over the stream", () => {
    assert.equal(turnText(turn("interrupted", "记录里的"), null, evs).text, "记录里的");
  });
  it("a running turn streams live", () => {
    assert.deepEqual(turnText(turn("running", null), null, evs), { text: "已经写了一半", live: true });
  });
});

describe("which plan goes where (after finalize)", () => {
  const plan = (version: number, state: PlanVersion["state"]) => ({ id: `plan_${version}`, version, state }) as unknown as PlanVersion;
  const withPlans = (...plans: PlanVersion[]) => ({ ...initialDiscussion, plans });

  it("after finalizing, the next round carries the latest FINAL", () => {
    assert.equal(planForNextRound(withPlans(plan(1, "SUPERSEDED"), plan(2, "FINAL")))?.id, "plan_2");
  });
  it("CURRENT wins over an older FINAL; unconfirmed drafts are never attached", () => {
    assert.equal(planForNextRound(withPlans(plan(1, "FINAL"), plan(2, "CURRENT"), plan(3, "DRAFT")))?.id, "plan_2");
    assert.equal(planForNextRound(withPlans(plan(1, "DRAFT"))), null);
  });
  it("the side panel shows the newest active version, not the first FINAL in the list", () => {
    assert.equal(displayedPlan(withPlans(plan(1, "FINAL"), plan(2, "CURRENT")))?.id, "plan_2");
  });
  it("derive is offered only on the newest version, and only once it is FINAL", () => {
    const d = withPlans(plan(1, "FINAL"), plan(2, "DRAFT"));
    assert.equal(canDerive(d, plan(1, "FINAL")), false, "v2 already exists");
    assert.equal(canDerive(withPlans(plan(1, "SUPERSEDED"), plan(2, "FINAL")), plan(2, "FINAL")), true);
  });
});
