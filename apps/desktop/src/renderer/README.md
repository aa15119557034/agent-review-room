# renderer/ — 负责：Claude ｜ 审查：DeepSeek

React UI。只通过 `window.room`（preload 暴露的 `RoomBridge`）与后端通信，类型全部来自 `@room/schemas`。

## 结构

```
renderer/
├─ index.html  main.tsx  styles.css
├─ lib/                     纯 TypeScript，不依赖 React，可单测
│  ├─ store.ts              极简状态容器（不引入第三方状态库）
│  ├─ state.ts              AppState、事件合并（按 seq 去重）、selector
│  ├─ client.ts             window.room 的薄封装，ok:false → ControlFailure
│  ├─ actions.ts            所有访问后端的操作；失败写入 state.notice，不向上抛
│  ├─ chat.ts               聊天（C-35）的状态、事件合并、时间线和 @ 规则（纯函数）
│  ├─ chat-actions.ts       聊天的操作（发送防重复、撤回、重试、转议题）
│  ├─ console.ts            秘书控制台（C-37）的状态、活动列表就地更新、额度显示（纯函数）
│  └─ console-actions.ts    秘书控制台的操作（查活动、翻页、跳到议题 / 会话）
├─ mock/mock-backend.ts     内存版后端，实现同一个 RoomBridge，遵守状态机，出参按契约校验
│                           （讨论室在 discussion-mock.ts，聊天在 chat-mock.ts，控制台的 agents.activity 在 activity-mock.ts）
├─ ui/                      React 组件（只读状态 + 调用 actions）
└─ test/                    逻辑层测试（node:test）
```

## 原则

- **业务状态只信后端。** Run 结束没有，只看 `run.state`，前端不自己推导
- **组件不直接碰 client。** 只调 `actions`，所以组件里不需要 try/catch
- **mock 只在浏览器里、而且 URL 带 `?mock` 时启用。** Electron 里如果 preload 没加载，显示错误页，绝不悄悄退回 mock
- 唯一强烈的颜色是朱红 `--seal`，只用于"批准"（C-04）

## 开发

```bash
# 逻辑层测试
pnpm exec tsx --test apps/desktop/src/renderer/test/*.test.ts

# 只开发 UI：用 vite 打开 renderer，在地址后加 ?mock
#   ?mock            预置演示数据
#   ?mock=empty      空白状态
#   ?mock&outcome=error   让 Reviewer 调用失败
#   聊天（顶栏「聊天」）：?mock 预置一个群聊和一个单聊；没点名时 Codex 会「这条没有回」
#   秘书控制台（顶栏「秘书」，C-37）：?mock&absent=codex 额度用完、&offline=deepseek 离线、
#     &unknownQuota=claude 额度读不到（都可以逗号分隔多位）；在讨论室起一轮能看到「正在答」
```

## 需要 D-01 提供的依赖

`apps/desktop/package.json` 里需要：`react`、`react-dom`（19.x）、`@types/react`、`@types/react-dom`、`@room/schemas`（workspace），以及 vite + `@vitejs/plugin-react`。renderer 的入口是 `src/renderer/index.html`，tsconfig 在 `src/renderer/tsconfig.json`。
