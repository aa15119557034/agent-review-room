import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { installGlobalGuards } from "../lib/guards";

/** 假的 window：只记监听器，够测拖放防护的判断 */
function fakeWindow() {
  const listeners = new Map<string, (e: unknown) => void>();
  return {
    target: {
      addEventListener: (type: string, fn: (e: unknown) => void) => listeners.set(type, fn),
      removeEventListener: (type: string) => listeners.delete(type),
    } as unknown as Window,
    fire(type: string, init: { types?: string[]; editable?: boolean; defaultPrevented?: boolean }) {
      const e = {
        defaultPrevented: init.defaultPrevented ?? false,
        prevented: false,
        target: { closest: () => (init.editable ? {} : null) },
        dataTransfer: { types: init.types ?? [], dropEffect: "copy" },
        preventDefault() {
          this.prevented = true;
        },
      };
      listeners.get(type)?.(e);
      return e;
    },
    count: () => listeners.size,
  };
}

describe("installGlobalGuards：拖文件不让页面跳转", () => {
  it("文件拖到不接收文件的地方：dragover 和 drop 都拦掉，光标显示「不能放」", () => {
    const w = fakeWindow();
    installGlobalGuards(w.target);
    const over = w.fire("dragover", { types: ["Files"] });
    assert.equal(over.prevented, true);
    assert.equal(over.dataTransfer.dropEffect, "none");
    assert.equal(w.fire("drop", { types: ["Files"] }).prevented, true);
  });

  it("文件拖到输入框上也拦（否则照样会打开那个文件）", () => {
    const w = fakeWindow();
    installGlobalGuards(w.target);
    assert.equal(w.fire("drop", { types: ["Files"], editable: true }).prevented, true);
  });

  it("往输入框里拖文字不受影响", () => {
    const w = fakeWindow();
    installGlobalGuards(w.target);
    assert.equal(w.fire("dragover", { types: ["text/plain"], editable: true }).prevented, false);
    assert.equal(w.fire("drop", { types: ["text/plain"], editable: true }).prevented, false);
  });

  it("组件自己处理过的 drop 不再插手", () => {
    const w = fakeWindow();
    installGlobalGuards(w.target);
    const e = w.fire("dragover", { types: ["Files"], defaultPrevented: true });
    assert.equal(e.prevented, false);
    assert.equal(e.dataTransfer.dropEffect, "copy");
  });

  it("返回的函数能卸掉监听", () => {
    const w = fakeWindow();
    const off = installGlobalGuards(w.target);
    assert.equal(w.count(), 2);
    off();
    assert.equal(w.count(), 0);
  });
});
