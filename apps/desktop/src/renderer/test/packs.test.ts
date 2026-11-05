import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ControlEvent } from "@room/schemas";
import { createMockBridge, type MockOptions } from "../mock/mock-backend";
import { createActions } from "../lib/actions";
import { createClient } from "../lib/client";
import { applyEvent, initialState, type AppState } from "../lib/state";
import { createStore } from "../lib/store";

/** #209：包导入 mock 按契约 #214 走一遍：读列表 → 导入（指定 / 自动认）→ 进度事件 → 装好；失败给原因码；同时只能导入一个 */

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
  const pack = (id: string) => store.get().packs!.find((p) => p.id === id)!;
  return { store, actions, events, pack };
}

describe("包导入", () => {
  it("读列表：运行环境已装，模型和补丁没装；列表不是写死两项", async () => {
    const { store, actions } = setup();
    await actions.packs.load();
    assert.deepEqual(store.get().packs!.map((p) => [p.id, p.state]), [["tts-runtime", "installed"], ["tts-model", "missing"], ["patch-2026-11", "missing"]]);
  });

  it("指定包导入：extracting → checking → 装好，期间推 packs.updated", async () => {
    const { actions, events, pack } = setup();
    await actions.packs.load();
    assert.equal(await actions.packs.import("tts-model", "zip"), null);
    assert.equal(pack("tts-model").progress?.phase, "extracting");
    await until(() => pack("tts-model").state === "installed");
    const phases = events.flatMap((e) => (e.type === "packs.updated" ? [e.packs[1]!.progress?.phase ?? "idle"] : []));
    assert.ok(phases.includes("extracting") && phases.includes("checking"), phases.join(","));
    assert.equal(pack("tts-model").progress, null);
  });

  it("id = null：程序自己认包（演示里认第一个没装的）", async () => {
    const { actions, pack } = setup();
    await actions.packs.load();
    assert.equal(await actions.packs.import(null, "folder"), null);
    await until(() => pack("tts-model").state === "installed");
    assert.equal(pack("patch-2026-11").state, "missing");
  });

  it("全装好了再自动识别 → PACK_UNKNOWN，什么也不改", async () => {
    const { actions, pack } = setup({ packs: { installed: ["tts-runtime", "tts-model", "patch-2026-11"] } });
    await actions.packs.load();
    assert.equal(await actions.packs.import(null, "zip"), "PACK_UNKNOWN");
    assert.equal(pack("tts-model").progress, null);
  });

  it("导入进行中再导入 → PACK_BUSY", async () => {
    const { actions } = setup();
    await actions.packs.load();
    await actions.packs.import("tts-model", "folder");
    assert.equal(await actions.packs.import("patch-2026-11", "zip"), "PACK_BUSY");
  });

  it("失败给原因码，状态里留 failed，之后可以重试", async () => {
    const { actions, pack } = setup({ packs: { failOnce: "PACK_NO_SPACE" } });
    await actions.packs.load();
    assert.equal(await actions.packs.import("tts-model", "zip"), "PACK_NO_SPACE");
    await until(() => pack("tts-model").progress?.phase === "failed");
    assert.equal(pack("tts-model").progress?.error, "PACK_NO_SPACE");
    assert.equal(pack("tts-model").state, "missing");
    assert.equal(await actions.packs.import("tts-model", "zip"), null);
    await until(() => pack("tts-model").state === "installed");
  });
});
