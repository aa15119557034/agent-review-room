import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { RoomBridge } from "@room/schemas";
import { createActions } from "./lib/actions";
import { createClient } from "./lib/client";
import { setMediaResolver } from "./lib/media";
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
const list = (v: string | null) => (v ? v.split(",").map((x) => x.trim()).filter(Boolean) : []);

function pickBridge(): { bridge: RoomBridge; isMock: boolean } | null {
  const real = (window as { room?: RoomBridge }).room;
  if (real) return { bridge: real, isMock: false };
  const params = new URLSearchParams(location.search);
  if (params.has("mock")) {
    const quota = params.get("quota");
    const bridge = createMockBridge({
      seed: params.get("mock") !== "empty",
      reviewerOutcome: params.get("outcome") === "error" ? "error" : "complete",
      // ?reviewer=off 强制"未配置"；否则看演示数据里有没有设置节点（?mock 有，?mock=empty 没有）
      ...(params.get("reviewer") === "off" ? { reviewerConfigured: false } : {}),
      // 秘书控制台（C-37）演示：?absent=codex 额度用完、?offline=deepseek 连不上、?unknownQuota=claude 额度读不到（逗号分隔多位）
      discussion: {
        absentAgents: list(params.get("absent")),
        offlineAgents: list(params.get("offline")),
        unknownQuota: list(params.get("unknownQuota")),
      },
      // 多模态：?quota=90 林离额度 90%（?quota=unknown 读不到）、?comfyui=off 本机没开
      media: {
        ...(quota !== null ? { codexQuotaPercent: quota === "unknown" ? null : Number(quota) } : {}),
        ...(params.get("comfyui") === "off" ? { comfyui: false } : {}),
      },
    });
    // 浏览器里没有 room-image:// 和 room-audio://，mock 的图片和声音换成 data: 地址
    setMediaResolver(bridge.mediaUrl);
    return { bridge, isMock: true };
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
