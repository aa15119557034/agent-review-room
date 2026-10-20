import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  APPROVAL_TRANSITIONS,
  ApprovalState,
  COMMANDS,
  ControlCommand,
  ControlQuery,
  Message,
  PromptSnapshot,
  QUERIES,
  RUN_TRANSITIONS,
  RunState,
  TERMINAL_EVENT_TYPES,
  TextSelection,
  canTransition,
} from "../src/index";

const ID = "01JAAAAAAAAAAAAAAAAAAAAAAA";
const TS = "2026-10-20T00:00:00.000Z";
const HASH = "a".repeat(64);

function checkMachine<S extends string>(
  name: string,
  states: readonly S[],
  table: Readonly<Record<S, readonly S[]>>,
  initial: S,
  terminals: readonly S[],
) {
  describe(`${name} state machine`, () => {
    it("only references known states", () => {
      for (const from of states) for (const to of table[from]) assert.ok(states.includes(to), `${from} -> ${to}`);
    });
    it("terminal states have no outgoing transitions", () => {
      for (const t of terminals) assert.deepEqual(table[t], [], t);
    });
    it("every non-terminal state can reach a terminal state", () => {
      for (const s of states) {
        const seen = new Set<S>([s]);
        const queue = [s];
        let ok = terminals.includes(s);
        while (queue.length && !ok) {
          for (const n of table[queue.shift()!]) {
            if (terminals.includes(n)) ok = true;
            if (!seen.has(n)) (seen.add(n), queue.push(n));
          }
        }
        assert.ok(ok, `${s} cannot terminate`);
      }
    });
    it("every state is reachable from the initial state", () => {
      const seen = new Set<S>([initial]);
      const queue = [initial];
      while (queue.length) for (const n of table[queue.shift()!]) if (!seen.has(n)) (seen.add(n), queue.push(n));
      for (const s of states) assert.ok(seen.has(s), `${s} unreachable`);
    });
    it("has no self-loops", () => {
      for (const s of states) assert.ok(!canTransition(table, s, s), s);
    });
  });
}

checkMachine("Approval", ApprovalState.options, APPROVAL_TRANSITIONS, "DRAFT", ["REJECTED", "EXPIRED", "CANCELLED"]);
checkMachine("Run", RunState.options, RUN_TRANSITIONS, "QUEUED", ["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"]);

describe("control API registry", () => {
  for (const [name, reg] of [["COMMANDS", COMMANDS], ["QUERIES", QUERIES]] as const) {
    it(`${name}: each key equals its request's type literal`, () => {
      for (const [key, d] of Object.entries(reg)) assert.equal(d.request.shape.type.value, key);
    });
  }

  it("rejects unknown command types", () => {
    assert.equal(ControlCommand.safeParse({ type: "fs.deleteEverything" }).success, false);
  });

  it("approval.approve requires the snapshot hash the human saw", () => {
    assert.equal(ControlCommand.safeParse({ type: "approval.approve", approvalId: `apr_${ID}` }).success, false);
    assert.equal(
      ControlCommand.safeParse({ type: "approval.approve", approvalId: `apr_${ID}`, expectedSnapshotHash: HASH }).success,
      true,
    );
  });

  it("contribution.create does not accept client-supplied content", () => {
    const parsed = COMMANDS["contribution.create"].request.parse({
      type: "contribution.create",
      projectId: `proj_${ID}`,
      sourceMessageId: `msg_${ID}`,
      contributionType: "risk",
      title: "t",
      selection: { start: 0, end: 3 },
      content: "forged",
    });
    assert.ok(!("content" in parsed));
  });

  it("parses a query", () => {
    assert.equal(ControlQuery.safeParse({ type: "runs.events", runId: `run_${ID}`, afterSeq: -1 }).success, true);
  });
});

describe("entities", () => {
  it("reviewer_output messages must belong to a run", () => {
    const base = { id: `msg_${ID}`, projectId: `proj_${ID}`, content: "x", createdAt: TS, sourceAgent: "claude" };
    assert.equal(Message.safeParse({ ...base, kind: "reviewer_output" }).success, false);
    assert.equal(Message.safeParse({ ...base, kind: "reviewer_output", runId: `run_${ID}` }).success, true);
    assert.equal(Message.safeParse({ ...base, kind: "source_input" }).success, true);
  });

  it("selection must be non-empty and ordered", () => {
    assert.equal(TextSelection.safeParse({ start: 5, end: 5 }).success, false);
    assert.equal(TextSelection.safeParse({ start: 5, end: 2 }).success, false);
    assert.equal(TextSelection.safeParse({ start: 0, end: 1 }).success, true);
  });

  it("prompt snapshot accepts Phase 0 nulls and rejects short commit SHAs", () => {
    const snap = {
      id: `snap_${ID}`, projectId: `proj_${ID}`, content: "p", contentHash: HASH, nonce: "0123456789abcdef",
      contributionIds: [`c_${ID}`], taskInstruction: "review", reviewerAgent: "claude", adapterVersion: "1",
      tokenEstimate: 1, synthesisVersion: null, branch: null, commitSha: null, createdAt: TS,
    };
    assert.equal(PromptSnapshot.safeParse(snap).success, true);
    assert.equal(PromptSnapshot.safeParse({ ...snap, commitSha: "abc123" }).success, false);
  });

  it("terminal event types match the four Run terminal outcomes", () => {
    assert.deepEqual([...TERMINAL_EVENT_TYPES].sort(), ["cancelled", "completed", "error", "timed_out"]);
  });
});

describe("reviewer node settings", async () => {
  const { COMMANDS, NodeBaseUrl, QUERIES, ReviewerNodeSettings } = await import("../src/index");

  it("accepts a LAN address and rejects anything with a path, query or credentials", () => {
    assert.equal(NodeBaseUrl.safeParse("http://192.168.1.20:7420").success, true);
    assert.equal(NodeBaseUrl.safeParse("https://review-node.local:7420/").success, true);
    for (const bad of ["192.168.1.20:7420", "ftp://x:1", "http://a/b", "http://a?x=1", "http://u:p@a", "javascript:alert(1)"]) {
      assert.equal(NodeBaseUrl.safeParse(bad).success, false, bad);
    }
  });

  it("never returns the token, only whether it is configured", () => {
    const parsed = ReviewerNodeSettings.parse({
      baseUrl: "http://192.168.1.20:7420",
      profileId: "claude-review",
      tokenConfigured: true,
      token: "x".repeat(40),
    });
    assert.ok(!("token" in parsed));
    const get = QUERIES["settings.get"].response.parse({ reviewerNode: { ...parsed, token: "leak".repeat(10) } });
    assert.ok(!("token" in (get.reviewerNode ?? {})));
  });

  it("token is optional on update (keep existing) and must be long when given", () => {
    const req = COMMANDS["settings.updateReviewerNode"].request;
    const base = { type: "settings.updateReviewerNode", baseUrl: "http://10.0.0.5:7420", profileId: "claude-review" };
    assert.equal(req.safeParse(base).success, true);
    assert.equal(req.safeParse({ ...base, token: "short" }).success, false);
    assert.equal(req.safeParse({ ...base, token: "a".repeat(32) }).success, true);
    assert.equal(req.safeParse({ ...base, token: "a".repeat(31) + " " }).success, false, "no whitespace");
  });
});
