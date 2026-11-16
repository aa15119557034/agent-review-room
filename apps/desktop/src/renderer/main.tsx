import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { RoomBridge } from "@room/schemas";
import { createActions } from "./lib/actions";
import { createClient } from "./lib/client";
import { installGlobalGuards } from "./lib/guards";
import { setMediaResolver } from "./lib/media";
import { initialState } from "./lib/state";
import { createStore } from "./lib/store";
import { createMockBridge } from "./mock/mock-backend";
import { App } from "./ui/App";
import { ErrorBoundary } from "./ui/ErrorBoundary";
import { AppProvider } from "./ui/hooks";
import "./styles.css";
import "./theme-apple.css";
import "./polish.css";
import "./sources.css";

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
      // 讨论室标签（C-38）演示：?topics 再建几个处在不同阶段的议题
      demoTopics: params.has("topics"),
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
      // 世界（C-54）：?worldOffline=claude 这位的节点不在线、?worldBudget=0 今天的思考次数用完、?world=new 还没开始
      world: {
        offline: list(params.get("worldOffline")),
        ...(params.get("worldBudget") !== null ? { dailyLimit: Number(params.get("worldBudget")) } : {}),
        ...(params.get("world") === "new" ? { seed: false } : {}),
      },
    });
    // 浏览器里没有 room-image:// 和 room-audio://，mock 的图片和声音换成 data: 地址
    setMediaResolver(bridge.mediaUrl);
    return { bridge, isMock: true };
  }
  return null;
}

// 把文件拖到窗口里不让页面跳走（Electron 默认会打开那个文件）
installGlobalGuards();

const root = createRoot(document.getElementById("root")!);
const picked = pickBridge();

if (!picked) {
  root.render(
    <div className="splash splash-failed" role="alert">
      <h1>应用没有正常启动</h1>
      <p>界面连不上应用的本地服务。请完全退出后重新打开；如果还是这样，请重新安装。</p>
    </div>,
  );
} else {
  const store = createStore(initialState);
  const actions = createActions(store, createClient(picked.bridge));
  // mock 的 ?topics 演示议题建好之后再读列表
  // 演示数据建失败也照常启动，不能停在「正在连接后端…」
  void Promise.resolve((picked.bridge as { topicsSeeded?: Promise<void> }).topicsSeeded)
    .catch(() => {})
    .then(() => actions.start());
  root.render(
    <StrictMode>
      <ErrorBoundary>
        <AppProvider store={store} actions={actions} isMock={picked.isMock}>
          <App />
        </AppProvider>
      </ErrorBoundary>
    </StrictMode>,
  );
}
