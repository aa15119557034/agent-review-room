import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PlanVersion, Round, RoundSummary } from "@room/schemas";
import { diffLines, initialDiscussion, stages } from "../lib/discussion";

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
