import assert from "node:assert/strict";
import { test } from "node:test";
import { WorldClock } from "../src/main/world-clock";

function fixture(advance?: (elapsed: number) => Promise<void>) {
  let now = 0, nextId = 0, discontinuities = 0;
  const timers = new Map<number, () => void>();
  const elapsed: number[] = [], errors: unknown[] = [];
  const clock = new WorldClock({
    now: () => now,
    setTimer: (callback) => { const id = ++nextId; timers.set(id, callback); return id; },
    clearTimer: (timer) => { timers.delete(timer as number); },
    advance: async (value) => { elapsed.push(value); await advance?.(value); },
    onDiscontinuity: async () => { discontinuities++; },
    onError: (error) => { errors.push(error); },
  });
  const fire = async (at: number) => {
    now = at;
    const entry = timers.entries().next().value;
    assert.ok(entry, "a tick is scheduled");
    timers.delete(entry[0]); entry[1]();
    // The callback and its async rule operation settle without real time passing.
    for (let i = 0; i < 8; i++) await Promise.resolve();
  };
  return { clock, timers, elapsed, errors, fire, setNow: (at: number) => { now = at; }, discontinuities: () => discontinuities };
}

test("world clock uses elapsed monotonic time and does not catch up while stopped", async () => {
  const f = fixture();
  f.clock.start(); f.clock.start();
  assert.equal(f.timers.size, 1);
  await f.fire(1_250);
  assert.deepEqual(f.elapsed, [1_250]);
  await f.clock.stop();
  assert.equal(f.timers.size, 0);
  f.setNow(1_000_000); f.clock.start();
  await f.fire(1_001_000);
  assert.deepEqual(f.elapsed, [1_250, 1_000]);
  await f.clock.stop();
});

test("world clock treats sleep-sized gaps and backwards clocks as discontinuities", async () => {
  const f = fixture(); f.clock.start();
  await f.fire(60_000);
  await f.fire(59_000);
  await f.fire(60_000);
  assert.equal(f.discontinuities(), 2);
  assert.deepEqual(f.elapsed, [1_000]);
  await f.clock.stop();
});

test("world clock never overlaps advances and stop waits for the accepted write", async () => {
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  const f = fixture(async () => pending); f.clock.start();
  await f.fire(1_000);
  assert.equal(f.timers.size, 0);
  let stopped = false;
  const stopping = f.clock.stop().then(() => { stopped = true; });
  await Promise.resolve(); assert.equal(stopped, false);
  finish(); await stopping;
  assert.equal(stopped, true); assert.equal(f.timers.size, 0);
  assert.deepEqual(f.elapsed, [1_000]);
});

test("world clock reports a failed advance and stops scheduling instead of retrying it", async () => {
  const failure = new Error("write failed");
  const f = fixture(async () => { throw failure; }); f.clock.start();
  await f.fire(1_000); await f.clock.stop();
  assert.deepEqual(f.errors, [failure]);
  assert.equal(f.timers.size, 0);
});
