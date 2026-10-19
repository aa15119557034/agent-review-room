# 任务板

## Phase 0 目标：完整跑通一次评审闭环

```
手动粘贴 Source Input → 选中一段 → Contribution → Prompt Preview
→ Prompt Snapshot (SHA-256) → Approve → Run → Reviewer API → 结果入库
```

验收标准见 V0.4 §36（下文写作 `AC-1` … `AC-10`）。

Phase 0 范围外的东西（自动抽取、多 Agent 并行、Graph、Synthesis、worktree、ACP、远端节点接入、手机网关、Persona、Memory、Workflow）**一律不做**。

---

## 第 0 步：你

- [ ] 在 VM 本地盘 clone 仓库，例如 `C:\dev\agent-review-room`（不要放在共享文件夹，原因见 README）
- [ ] 在 GitHub 上给 `main` 开启分支保护（要求 PR 才能合并）
- [ ] 准备 Reviewer 用的 API key，放进本地 `.env`
- [x] 批准 C-01a 契约草案、ADR-001（PR #1）
- [x] 批准 C-01b（Phase 0 实体 + IPC，PR #2）

## 第 1 步：契约（阻塞后续所有任务）

| ID | 负责 | 内容 | 状态 |
|---|---|---|---|
| **C-01a** | Claude | 状态转换表、AgentEvent、权限请求、远端协议、控制面 API、Adapter 接口 | ✅ 已合并（PR #1） |
| **C-01b** | Claude | Phase 0 实体：Message、Contribution、PromptSnapshot、Approval、Run 记录；IPC 频道清单 | ✅ 已合并（PR #2） |
| **S-01** | Claude | AgentServer 骨架 + 14 个测试（Phase 1 预研，不进入 Phase 0 主流程） | ✅ 完成 |

与契约并行：

| ID | 负责 | 内容 |
|---|---|---|
| **D-01** | DeepSeek | 在现有 pnpm workspace 上加 electron-vite + 空白 React 窗口；**验证 better-sqlite3 在当前 Electron 版本下能 rebuild 并打开数据库**；`pnpm install` 后 `pnpm test` 能跑通 S-01 的测试（Windows 上） |

## 第 2 步：后端（DeepSeek）

C-01 批准后开始。

| ID | 内容 | 验收 |
|---|---|---|
| **D-02** | `packages/db/`：Phase 0 表的 migration；WAL、busy_timeout、单写者队列、`BEGIN IMMEDIATE`、ULID；`runs.approval_id` 唯一约束 | AC-10 |
| **D-03** | `packages/core/`：按 `state-machines.ts` 查表实现状态机；测试覆盖**每一条非法转换** | AC-6, AC-9 |
| **D-04** | `packages/core/`：Prompt 拼装（随机 nonce 边界）、SHA-256、不可变 Snapshot；测试边界逃逸 | AC-3~5 |
| **D-05** | `packages/reviewer-client/`：实现 `AgentAdapter`（kind `"api"`）；只发送 `snapshot.content`；发送前重算 hash；key 只在 main 读取 | AC-7 |
| **D-06** | Run 生命周期：消费 Approval 和创建 Run 在同一事务；恰好一个终止事件；启动修复 STARTING/RUNNING → FAILED(interrupted) | AC-6, 8, 9 |
| **D-07** | `main/` IPC handler + `preload/` 桥接，格式用 `control-api.ts`，入参 Zod 校验 | — |

## 第 2 步：前端（Claude）

C-01 批准后开始，先对着 mock 开发。

| ID | 内容 | 验收 |
|---|---|---|
| **C-02** ✅ 已合并 | renderer 架构：状态管理；**IPC 客户端直接使用 `ControlCommand / ControlQuery / ControlEvent` 格式**（以后手机 App 复用）；mock 后端；整体布局 | — |
| **C-03** ✅ 已合并 | Source Input：粘贴 → 选中 → 创建 Contribution | AC-1, 2 |
| **C-04** ✅ 已合并 | Prompt Preview + 审批：完整原文、hash、token 估算；Approve 时带上 `expectedSnapshotHash` | AC-3, 6 |
| **C-05** ✅ 待合并 | Run 状态、Reviewer 结果、历史列表 | AC-8, 10 |

## 第 3 步：交叉审查

| ID | 审查方 | 对象 |
|---|---|---|
| **R-01** | Claude（新会话） | D-03、D-06：状态机完整性、终止事件唯一、崩溃恢复 |
| **R-02** | Claude（新会话） | D-04、D-05：边界逃逸、hash 一致、key 泄漏 |
| **R-03** | DeepSeek | C-03 ~ C-05：重复点击、空选择、状态不同步；补组件测试 |

## 第 4 步：验收（你）

- [ ] 用一段真实的 DeepSeek 输出跑一遍完整闭环
- [ ] 跑 V0.4 §38 的注入测试
- [ ] run 进行中强制关闭应用，重启后检查状态
- [ ] AC-1 ~ AC-10 全部通过 → Phase 0 完成

---

## Phase 1 待办（现在不做）

| ID | 负责 | 内容 |
|---|---|---|
| **D-08** | DeepSeek | 实现 `RemoteAgentAdapter`，严格按接口注释里的行为约定 |
| **D-09** | DeepSeek | AgentServer 加固：Windows 测试、cross-spawn、pid 文件清理孤儿、权限中继、等人时暂停 idle、TLS |
| **R-04** | Claude | 审查 D-08、D-09：断线、租约、裂脑、重复执行 |
| **D-10** | 待定 | 控制面网络网关（给手机 App 用） |

## 依赖关系

```
C-01a ✅ ─┐
C-01b ────┼─> D-02 ─> D-03 ─> D-06 ─> D-07 ─┐
          │          D-04 ─> D-05 ────────┘ ├─> R-01/R-02/R-03 ─> 验收
          └─> C-02 ─> C-03 ─> C-04 ─> C-05 ─┘
D-01（现在就可以开始）
```
