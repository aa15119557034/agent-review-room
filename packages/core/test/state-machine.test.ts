import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  APPROVAL_TRANSITIONS,
  ApprovalState,
  RUN_TRANSITIONS,
  RunState,
} from "@room/schemas";
import {
  approvalNextStates,
  assertTransition,
  canHaveFailureReason,
  canHaveSubstate,
  IllegalTransitionError,
  isTerminalApprovalState,
  isTerminalRunState,
  transitionApproval,
  transitionRun,
} from "../src/state-machine";

/**
 * 覆盖**每一条**转换组合（合法与非法），而不是挑几条写。
 * 表里没列出来的就是非法，这是契约的定义方式。
 */

describe("approval state machine", () => {
  it("accepts exactly the transitions in the contract table", () => {
    let allowed = 0;
    for (const from of ApprovalState.options) {
      for (const to of ApprovalState.options) {
        const expected = APPROVAL_TRANSITIONS[from].includes(to);
        if (expected) {
          allowed += 1;
          assert.equal(transitionApproval(from, to), to);
        } else {
          assert.throws(
            () => transitionApproval(from, to),
            (error: unknown) =>
              error instanceof IllegalTransitionError &&
              error.entity === "approval" &&
              error.from === from &&
              error.to === to,
            `${from} -> ${to} must be rejected`,
          );
        }
      }
    }
    // 表里一共 2+4+2 条边，防止测试本身写飘
    assert.equal(allowed, 8);
  });

  it("treats REJECTED / EXPIRED / CANCELLED as terminal", () => {
    for (const state of ["REJECTED", "EXPIRED", "CANCELLED"] as const) {
      assert.equal(isTerminalApprovalState(state), true);
      assert.deepEqual(approvalNextStates(state), []);
    }
    assert.equal(isTerminalApprovalState("DRAFT"), false);
    assert.equal(isTerminalApprovalState("READY_FOR_REVIEW"), false);
    assert.equal(isTerminalApprovalState("APPROVED"), false, "APPROVED 还能 EXPIRED/CANCELLED");
  });
});

describe("run state machine", () => {
  it("accepts exactly the transitions in the contract table", () => {
    let allowed = 0;
    for (const from of RunState.options) {
      for (const to of RunState.options) {
        const expected = RUN_TRANSITIONS[from].includes(to);
        if (expected) {
          allowed += 1;
          assert.equal(transitionRun(from, to), to);
        } else {
          assert.throws(
            () => transitionRun(from, to),
            (error: unknown) => error instanceof IllegalTransitionError,
            `${from} -> ${to} must be rejected`,
          );
        }
      }
    }
    assert.equal(allowed, 3 + 4 + 4);
  });

  it("treats all four terminal states as terminal", () => {
    for (const state of ["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"] as const) {
      assert.equal(isTerminalRunState(state), true);
    }
    for (const state of ["QUEUED", "STARTING", "RUNNING"] as const) {
      assert.equal(isTerminalRunState(state), false);
    }
  });

  it("cannot leave a terminal state — one terminal event only (AC-9)", () => {
    for (const terminal of ["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"] as const) {
      for (const to of RunState.options) {
        assert.throws(() => transitionRun(terminal, to), IllegalTransitionError);
      }
    }
  });
});

describe("guards", () => {
  it("rejects unknown state names instead of crashing with a TypeError", () => {
    assert.throws(
      () => assertTransition(APPROVAL_TRANSITIONS, "approval", "NOPE" as never, "APPROVED"),
      (error: unknown) => error instanceof IllegalTransitionError && error.from === "NOPE",
    );
  });

  it("only allows substate while RUNNING", () => {
    assert.equal(canHaveSubstate("RUNNING"), true);
    for (const state of ["QUEUED", "STARTING", "COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"] as const) {
      assert.equal(canHaveSubstate(state), false);
    }
  });

  it("only allows failure_reason while FAILED", () => {
    assert.equal(canHaveFailureReason("FAILED"), true);
    for (const state of ["QUEUED", "STARTING", "RUNNING", "COMPLETED", "CANCELLED", "TIMED_OUT"] as const) {
      assert.equal(canHaveFailureReason(state), false);
    }
  });
});
