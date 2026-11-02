import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHoldController, HOLD_TO_CONFIRM_MS, type HoldTimers } from "../lib/hold-to-confirm";

/** C-33 按住盖章：用假时钟逐条核任务板的验收 */

function fakeClock() {
  let now = 0;
  let seq = 0;
  const pending = new Map<number, { at: number; callback: () => void }>();
  const timers: HoldTimers = {
    set(callback, ms) {
      const id = ++seq;
      pending.set(id, { at: now + ms, callback });
      return id;
    },
    clear(handle) {
      pending.delete(handle as number);
    },
  };
  const advance = (ms: number) => {
    const target = now + ms;
    for (;;) {
      const due = [...pending.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      pending.delete(due[0]);
      now = due[1].at;
      due[1].callback();
    }
    now = target;
  };
  return { timers, advance, pendingCount: () => pending.size };
}

const setup = (disabled = false) => {
  const clock = fakeClock();
  let calls = 0;
  const phases: string[] = [];
  const hold = createHoldController({ onComplete: () => void calls++, onPhase: (p) => phases.push(p), timers: clock.timers, disabled });
  return { clock, hold, phases, calls: () => calls };
};

describe("hold to seal (C-33)", () => {
  it("fires once after a full second", () => {
    const { clock, hold, calls } = setup();
    hold.press();
    clock.advance(HOLD_TO_CONFIRM_MS - 1);
    assert.equal(calls(), 0);
    clock.advance(1);
    assert.equal(calls(), 1);
    assert.equal(hold.phase, "done");
  });

  it("releasing at 999ms sends nothing, even after the clock moves on", () => {
    const { clock, hold, calls } = setup();
    hold.press();
    clock.advance(999);
    hold.cancel();
    clock.advance(5_000);
    assert.equal(calls(), 0);
    assert.equal(hold.phase, "idle");
    assert.equal(clock.pendingCount(), 0, "timer cleared");
  });

  it("leaving, blur, hidden page (all = cancel) restart the count from zero", () => {
    const { clock, hold, calls } = setup();
    hold.press();
    clock.advance(800);
    hold.cancel();
    hold.press();
    clock.advance(800);
    assert.equal(calls(), 0, "800 + 800 is not one full hold");
    clock.advance(200);
    assert.equal(calls(), 1);
  });

  it("turning grey mid-hold clears it, and a grey button cannot be pressed", () => {
    const { clock, hold, calls } = setup();
    hold.press();
    clock.advance(500);
    hold.setDisabled(true);
    clock.advance(5_000);
    assert.equal(calls(), 0);
    hold.press();
    clock.advance(5_000);
    assert.equal(calls(), 0);
    hold.setDisabled(false);
    hold.press();
    clock.advance(HOLD_TO_CONFIRM_MS);
    assert.equal(calls(), 1);

    const grey = setup(true);
    grey.hold.press();
    grey.clock.advance(5_000);
    assert.equal(grey.calls(), 0);
  });

  it("a full hold sends only once: pressing again or repeated presses do nothing until reset", () => {
    const { clock, hold, calls } = setup();
    hold.press();
    hold.press(); // 键盘连发 / 重复 pointerdown 不会叠第二个计时器
    clock.advance(HOLD_TO_CONFIRM_MS);
    hold.press();
    clock.advance(HOLD_TO_CONFIRM_MS * 3);
    assert.equal(calls(), 1);
    hold.reset();
    hold.press();
    clock.advance(HOLD_TO_CONFIRM_MS);
    assert.equal(calls(), 2, "after reset (new target) it can seal again");
  });

  it("a click (press + immediate release) never seals", () => {
    const { clock, hold, calls } = setup();
    for (let i = 0; i < 20; i++) {
      hold.press();
      clock.advance(50);
      hold.cancel();
    }
    clock.advance(10_000);
    assert.equal(calls(), 0);
  });

  it("dispose clears a running hold", () => {
    const { clock, hold, calls } = setup();
    hold.press();
    hold.dispose();
    clock.advance(5_000);
    assert.equal(calls(), 0);
  });

  it("reports phases for the progress bar", () => {
    const { clock, hold, phases } = setup();
    hold.press();
    hold.cancel();
    hold.press();
    clock.advance(HOLD_TO_CONFIRM_MS);
    assert.deepEqual(phases, ["holding", "idle", "holding", "done"]);
  });
});
