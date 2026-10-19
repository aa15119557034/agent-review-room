# 契约说明（人类可读版）

真正的定义以代码为准：`packages/schemas/src/` 和 `packages/core/src/adapter/`。本文只解释"怎么用"和"为什么这样设计"。

## Phase 0 闭环 = 7 次调用

```
renderer                                   main / core                       Reviewer API
   │ project.create {name}                     │
   │──────────────────────────────────────────▶│ → Project
   │ source.add {projectId, sourceAgent, content}
   │──────────────────────────────────────────▶│ → Message(source_input)              AC-1
   │ contribution.create {…, selection}        │
   │──────────────────────────────────────────▶│ 按 selection 截取 content → Contribution   AC-2
   │ snapshot.create {contributionIds, taskInstruction}
   │──────────────────────────────────────────▶│ 拼 prompt + nonce + SHA-256
   │                                           │ → {PromptSnapshot, Approval(READY_FOR_REVIEW)}  AC-3/4/5
   │ （用户在 Prompt Preview 里看原文、hash、token 估算）
   │ approval.approve {approvalId, expectedSnapshotHash}
   │──────────────────────────────────────────▶│ 一个事务内：Approval→APPROVED + 新建 Run(QUEUED)
   │                                           │ → {Approval, Run}                     AC-6
   │◀─── event run.updated (STARTING/RUNNING) ─│──── snapshot.content 原样发送 ────▶│ AC-7
   │◀─── event run.event (message_delta …) ────│◀─────────── 流式返回 ──────────────│
   │◀─── event message.created (reviewer_output)│ 结果入库                             AC-8
   │◀─── event run.updated (COMPLETED) ────────│ 恰好一个终止事件                       AC-9
   │ （重启后用 *.list / runs.events 重新加载）                                         AC-10
```

## IPC：只有三个频道

| 频道 | 方向 | 内容 |
|---|---|---|
| `room:command` | renderer → main | `ControlCommand`，返回 `ControlResult` |
| `room:query` | renderer → main | `ControlQuery`，返回 `ControlResult` |
| `room:event` | main → renderer | `ControlEvent` |

renderer 里只用 `window.room.command / query / onEvent`，类型从登记表自动推导。

### 命令

| type | 作用 | scope |
|---|---|---|
| `project.create` | 新建项目 | author |
| `source.add` | 粘贴 Source 输入 | author |
| `contribution.create` | 选中一段标记为 Contribution | author |
| `snapshot.create` | 生成不可变 Snapshot + 待审批的 Approval | author |
| `approval.approve` | 批准并创建 Run | approve |
| `approval.reject` | 拒绝 | approve |
| `run.cancel` | 取消 | cancel |
| `permission.decide` | 回答权限请求（Phase 0 不会用到） | permission |

### 查询

`system.status`、`projects.list`、`messages.list`、`contributions.list`、`snapshots.get`、`approvals.list`、`runs.list`、`runs.get`、`runs.events`

### 事件

`message.created`、`approval.updated`、`run.updated`、`run.event`、`permission.requested`

## 几个刻意的设计

**1. Contribution 的 content 由后端截取，renderer 不提交。**
renderer 只发 `selection {start, end}`。这样"Contribution 内容一定来自原文"就是系统保证的，不依赖前端的正确性。

**2. 批准必须带 `expectedSnapshotHash`。**
如果用户看着的 prompt 和数据库里当前的不一致（比如另一个窗口重新生成了 snapshot，或者以后手机上停留着旧页面），批准会被拒绝，返回 `stale_snapshot`。

**3. 生成新 Snapshot 会让旧的待审批项过期。**
同一项目中，尚未产生 Run 的 READY_FOR_REVIEW / APPROVED Approval 会变成 EXPIRED。这是 Phase 0 版本的 V0.4 §18 第 4 条（"prompt snapshot 被重新生成"）。

**4. 批准和创建 Run 在同一个事务里。**
`runs.approval_id` 唯一约束保证一个 Approval 最多产生一个 Run，双击"批准"也不会跑两次。

**5. 错误不 throw，统一返回 `{ok: false, error, message}`。**
`message` 不包含密钥，也不包含 prompt 原文。

**6. API key 永远不离开 main 进程。**
renderer 只能通过 `system.status` 知道"有没有配置"。

## 与 V0.4 文档的差异

| V0.4 | 契约 | 原因 |
|---|---|---|
| `prompt_snapshots.run_id` | 去掉 | Snapshot 先于 Run 存在；Run 通过 `snapshotId` 引用 Snapshot |
| Contribution 有 `thread_id` | Phase 0 去掉 | Phase 0 没有 thread，以后加字段时 `schemaVersion` 递增 |
| Approval 有 `requested_by / reviewed_by` | 改为 `decidedVia` | Phase 0 只有一个人；记录用哪个客户端审批，为手机审批留痕 |
