import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { RoomBridge } from "@room/schemas";
import { createActions } from "./lib/actions";
import { createClient } from "./lib/client";
import { initialState } from "./lib/state";
import { createStore } from "./lib/store";
import { createMockBridge } from "./mock/mock-backend";
import { App } from "./ui/App";
import { AppProvider } from "./ui/hooks";
import "./styles.css";

/**
 * 选择后端：
 * - Electron 里 preload 提供 window.room → 用真实后端
 * - 浏览器里打开且 URL 带 ?mock → 用内存 mock（开发 UI 用）
 * - 都没有 → 显示错误。绝不在 Electron 里悄悄退回 mock，否则用户会以为评审真的发出去了
 */
function pickBridge(): { bridge: RoomBridge; isMock: boolean } | null {
  const real = (window as { room?: RoomBridge }).room;
  if (real) return { bridge: real, isMock: false };
  const params = new URLSearchParams(location.search);
  if (params.has("mock")) {
    return {
      bridge: createMockBridge({
        seed: params.get("mock") !== "empty",
        reviewerOutcome: params.get("outcome") === "error" ? "error" : "complete",
      }),
      isMock: true,
    };
  }
  return null;
}

const root = createRoot(document.getElementById("root")!);
const picked = pickBridge();

if (!picked) {
  root.render(
    <div className="splash splash-failed" role="alert">
      <h1>没有找到后端</h1>
      <p>preload 脚本没有加载，应用无法工作。请重新安装或联系开发者。</p>
      <p>开发 UI 时可以在浏览器地址后加 <code>?mock</code> 使用演示数据。</p>
    </div>,
  );
} else {
  const store = createStore(initialState);
  const actions = createActions(store, createClient(picked.bridge));
  void actions.start();
  root.render(
    <StrictMode>
      <AppProvider store={store} actions={actions} isMock={picked.isMock}>
        <App />
      </AppProvider>
    </StrictMode>,
  );
}
