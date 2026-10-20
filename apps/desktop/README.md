# apps/desktop

Electron 外壳（electron-vite + React）。

- 主进程：`src/main/` （DeepSeek）
- preload：`src/preload/` （DeepSeek）
- 渲染进程：`src/renderer/` （Claude）

## 脚本

```bash
pnpm --filter @room/desktop dev            # 开发模式（vite dev server + electron）
pnpm --filter @room/desktop build          # 产出 out/{main,preload,renderer}
pnpm --filter @room/desktop start          # 预览构建产物
pnpm --filter @room/desktop typecheck      # 主进程 + preload 类型检查
pnpm --filter @room/desktop verify:sqlite  # better-sqlite3 × Electron 冒烟测试
```

## better-sqlite3

`better-sqlite3@13` 发布的是 **Node-API** 预编译件（`prebuilds/win32-x64.node` 等），
ABI 稳定，**当前不需要 `electron-rebuild`**：Electron 44.9.0（ABI 149）直接加载成功。

`verify:sqlite` 会真的在 Electron 主进程里建库、开 WAL、写读一行再退出，
输出见 `scripts/sqlite-smoke.cjs`。如果以后换成不带 Node-API 预编译件的原生模块，
再启用 `rebuild:native`（`electron-rebuild -f -w <模块名>`）。

### 已知环境坑

从 Electron 应用派生的终端里会继承 `ELECTRON_RUN_AS_NODE=1`，
此时直接执行 `electron xxx` 会退化成普通 Node 进程，`require("electron")` 拿不到 `app`。
`scripts/verify-sqlite.mjs` 已经在启动前摘掉这个变量，所以用 npm script 跑不受影响。

## 当前状态

preload **刻意没有暴露任何 IPC 频道**：真正的 `RoomBridge` 由 D-07 按
`packages/schemas` 的 `control-api.ts` / `ipc.ts` 实现。
在那之前，窗口加载的 renderer 会显示 `没有找到后端` 的兜底页，这是 C-02 的设计行为，不是故障。

## 已知环境坑（dev）

从 Electron 应用派生的终端（例如 DSH 自己的终端）会继承 `ELECTRON_RUN_AS_NODE=1`，
此时 `electron-vite dev` 会把主进程当普通 Node 跑，报 `Cannot read properties of undefined (reading 'isPackaged')`。
启动前先摘掉：

```powershell
Remove-Item env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
pnpm --filter @room/desktop dev
```

## 退出时的 run 取消

`before-quit` 会对所有在跑的 run 发 `abort()`，但**不等待节点确认**——
进程退出后 abort 很可能还没送到节点。真正兜底的是节点侧的租约过期（默认 20s）。
Phase 0 接受这个取舍：关窗要快，宁可让节点多跑一会儿。
