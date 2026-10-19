# Agent 评审室

由人类掌控、可审计的多 Agent 协同评审工作台。Electron + React + Node.js + SQLite。

当前阶段：**Phase 0（最小闭环）**。设计冻结于 V0.4，之后的变更以 ADR 形式记录。

| 文档 | 内容 |
|---|---|
| `docs/分工.md` | 谁负责什么、目录所有权、GitHub 协作流程 |
| `docs/phase0-任务.md` | 任务板和依赖关系 |
| `docs/design/V0.4-frozen.txt` | 冻结的设计文档 |
| `docs/design/ADR-001-远端执行节点.md` | 控制面与执行面分离（提议中） |
| `AGENTS.md` / `CLAUDE.md` | 给 Agent 的工作规则 |

## 目录

```
agent-review-room/
├─ AGENTS.md  CLAUDE.md  README.md
├─ .github/pull_request_template.md
├─ docs/
│  ├─ 分工.md  phase0-任务.md
│  ├─ contracts/                     契约的人类可读说明
│  └─ design/                        V0.4 + ADR
├─ apps/
│  ├─ desktop/src/
│  │  ├─ main/                       DeepSeek：主进程、IPC handler
│  │  ├─ preload/                    DeepSeek：contextBridge
│  │  └─ renderer/                   Claude：React UI
│  └─ agent-server/                  DeepSeek（骨架已完成）：远端执行节点
└─ packages/
   ├─ schemas/                       契约：Zod 类型、状态转换表、协议、控制面 API
   ├─ core/                          状态机、Prompt、Snapshot；adapter/ 下是接口（契约）
   ├─ db/                            SQLite
   └─ reviewer-client/               Reviewer API 调用
```

## 开发

```bash
git clone https://github.com/aa15119557034/agent-review-room.git
cd agent-review-room
pnpm install
pnpm typecheck
pnpm test
```

## ⚠️ 不要把仓库放在 VMware 共享文件夹里

请 clone 到 VM 本地盘，例如 `C:\dev\agent-review-room`。原因：

1. SQLite 的 WAL 模式不支持网络文件系统，数据库可能损坏。运行时的 `.db` 放在 Electron userData（`%APPDATA%`）里
2. pnpm 依赖硬链接和符号链接，在共享文件夹上经常失败或很慢
3. node-gyp 编译 better-sqlite3 时，路径里有空格或中文容易出错
