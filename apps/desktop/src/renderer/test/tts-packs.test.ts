import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ControlEvent } from "@room/schemas";
import { createMockBridge, type MockOptions } from "../mock/mock-backend";
import { createActions } from "../lib/actions";
import { createClient } from "../lib/client";
import { applyEvent, initialState, type AppState } from "../lib/state";
import { createStore } from "../lib/store";

/** #209：语音包导入 mock 按契约 #212 走一遍：读状态 → 导入 → 进度事件 → 装好；失败给原因码；同时只能导入一个 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await sleep(5);
  }
  assert.fail("等不到");
}
function setup(opts: MockOptions = {}) {
  const bridge = createMockBridge({ tickMs: 2, reviewerConfigured: true, ...opts });
  const store = createStore<AppState>(initialState);
  const events: ControlEvent[] = [];
  bridge.onEvent((e) => {
    events.push(e);
    store.set((s) => applyEvent(s, e));
  });
  const actions = createActions(store, createClient(bridge));
  return { store, actions, events };
}

describe("语音包", () => {
  it("读状态：运行环境已装、模型没装", async () => {
    const { store, actions } = setup();
    await actions.ttsPacks.load();
    const packs = store.get().ttsPacks!;
    assert.deepEqual(packs.map((p) => [p.kind, p.state]), [["runtime", "installed"], ["model", "missing"]]);
  });

  it("导入：extracting → checking → 装好，期间推 tts.packs.updated", async () => {
    const { store, actions, events } = setup();
    await actions.ttsPacks.load();
    assert.equal(await actions.ttsPacks.import("model", "zip"), null);
    assert.equal(store.get().ttsPacks![1]!.progress?.phase, "extracting");
    await until(() => store.get().ttsPacks![1]!.state === "installed");
    const phases = events.flatMap((e) => (e.type === "tts.packs.updated" ? [e.packs[1]!.progress?.phase ?? "idle"] : []));
    assert.ok(phases.includes("extracting") && phases.includes("checking"), phases.join(","));
    assert.equal(store.get().ttsPacks![1]!.progress, null);
  });

  it("导入进行中再导入 → PACK_BUSY", async () => {
    const { actions } = setup();
    await actions.ttsPacks.load();
    await actions.ttsPacks.import("model", "folder");
    assert.equal(await actions.ttsPacks.import("runtime", "zip"), "PACK_BUSY");
  });

  it("失败给原因码，状态里留 failed，之后可以重试", async () => {
    const { store, actions } = setup({ ttsPacks: { failOnce: "PACK_NO_SPACE" } });
    await actions.ttsPacks.load();
    assert.equal(await actions.ttsPacks.import("model", "zip"), "PACK_NO_SPACE");
    await until(() => store.get().ttsPacks![1]!.progress?.phase === "failed");
    assert.equal(store.get().ttsPacks![1]!.progress?.error, "PACK_NO_SPACE");
    assert.equal(store.get().ttsPacks![1]!.state, "missing");
    assert.equal(await actions.ttsPacks.import("model", "zip"), null);
    await until(() => store.get().ttsPacks![1]!.state === "installed");
  });
});
