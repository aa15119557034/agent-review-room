import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AGENT_ACTIVITY_PREVIEW_MAX, AgentActivityItem, ControlQuery, QUERIES } from "../src/index";

const ID = "01JAAAAAAAAAAAAAAAAAAAAAAA";
const TS = "2026-11-01T00:00:00.000Z";

const turn = {
  id: `turn_${ID}`, agent: "deepseek", onBehalfOf: "claude", isSummary: false,
  outcome: "running", replyMessageId: null, supersededBy: null, createdAt: TS, finishedAt: null,
};
const conversation = {
  id: `conv_${ID}`, kind: "direct", members: ["deepseek"], title: null, pinned: false, muted: false,
  lastReadMessageId: null, lastActivityAt: TS, createdAt: TS,
};
const slot = {
  id: `slot_${ID}`, conversationId: `conv_${ID}`, userMessageId: `cmsg_${ID}`, agent: "deepseek", required: false,
  outcome: "running", runId: `run_${ID}`, attempt: 1, replyMessageId: null, failure: null,
  unavailableReason: null, createdAt: TS, finishedAt: null,
};

describe("C-37a agents.activity", () => {
  it("discussion and chat items parse; preview is capped and nullable", () => {
    const disc = { kind: "discussion", projectId: `proj_${ID}`, projectName: "议题", roundId: `rnd_${ID}`, roundIndex: 2, turn, preview: "问题" };
    assert.ok(AgentActivityItem.safeParse(disc).success);
    assert.ok(AgentActivityItem.safeParse({ ...disc, preview: null }).success);
    assert.equal(AgentActivityItem.safeParse({ ...disc, preview: "字".repeat(AGENT_ACTIVITY_PREVIEW_MAX + 1) }).success, false);
    // 按码点数，不按 UTF-16 单元（林离 #163）：101～200 个 emoji 都合法，201 个不合法
    for (const n of [101, AGENT_ACTIVITY_PREVIEW_MAX]) {
      assert.ok(AgentActivityItem.safeParse({ ...disc, preview: "😀".repeat(n) }).success, `${n} emoji`);
    }
    assert.equal(AgentActivityItem.safeParse({ ...disc, preview: "😀".repeat(AGENT_ACTIVITY_PREVIEW_MAX + 1) }).success, false);
    assert.equal(AgentActivityItem.safeParse({ ...disc, extra: 1 }).success, false, "strict");
    // 汐 #157：列表里不带 partialText（最长 200 万字）
    assert.equal(AgentActivityItem.safeParse({ ...disc, turn: { ...turn, partialText: "半截" } }).success, false, "no partialText");
    const chat = { kind: "chat", conversation, slot, preview: null };
    assert.ok(AgentActivityItem.safeParse(chat).success);
    assert.ok(AgentActivityItem.safeParse({ ...chat, preview: "😀".repeat(101) }).success, "chat preview counts code points too");
    assert.equal(AgentActivityItem.safeParse({ ...chat, preview: "😀".repeat(AGENT_ACTIVITY_PREVIEW_MAX + 1) }).success, false);
    assert.equal(AgentActivityItem.safeParse({ ...chat, kind: "discussion" }).success, false);
  });

  it("query is registered; cursor accepts turn or slot ids only", () => {
    assert.ok("agents.activity" in QUERIES);
    assert.ok(ControlQuery.safeParse({ type: "agents.activity", agent: "claude" }).success);
    assert.ok(ControlQuery.safeParse({ type: "agents.activity", agent: "claude", limit: 50, before: { createdAt: TS, id: `slot_${ID}` } }).success);
    assert.ok(ControlQuery.safeParse({ type: "agents.activity", agent: "claude", before: { createdAt: TS, id: `turn_${ID}` } }).success);
    assert.equal(ControlQuery.safeParse({ type: "agents.activity", agent: "claude", before: { createdAt: TS, id: `run_${ID}` } }).success, false);
    assert.equal(ControlQuery.safeParse({ type: "agents.activity", agent: "claude", limit: 101 }).success, false);
  });
});
