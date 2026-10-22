# Phase 1A 验收记录

> 记录时间：2026-10-23（Asia/Shanghai）
> 记录人：DeepSeek（后端）
> 验收依据：ADR-002（讨论室模式）、画布 0-B（附录 A）、《Phase 1A 任务》
> 代码版本：`main` @ `d24927b`（#65 supplement 接线、#66 派生限制、#67 汇总父版本、#68 定稿后的方案 UI、#69 X-21 e2e 均已合并）
> 应用构建：`pnpm --filter @room/desktop build` 的 `out/`

## 1. 环境

| 项 | 值 |
| --- | --- |
| 主控端 | Windows，Electron 44.9.0，`@room/desktop` 构建产物 |
| 用户电脑节点 | `http://192.168.190.10:7420`，profile `claude-review`（C酱） |
| 本机节点 | `http://127.0.0.1:7420`，profile `deepseek-discuss`（DeepSeek）、`codex-discuss`（Codex） |
| 参与者 | C酱 → user-pc / claude-review（可汇总）；DeepSeek、Codex → controller-local |
| 数据库 | `%APPDATA%\@room\desktop\room.db`（SQLite，WAL） |
| 设置 | userData `settings.json`，Token 经 `safeStorage` 加密，界面只显示「已保存（不显示）」 |

> 三轮和 e2e 的过程记录、截图都在 **#58**：https://github.com/aa15119557034/agent-review-room/issues/58

## 2. 验收范围

1. A-1A：用一个真实议题跑 **3 轮**，每轮汇总，最后方案 **v2 定稿**。
2. 「重启后整个话题完整读回」：重启应用前后，话题的全部数据 digest 一致。
3. X-21：0-B 的 **13 种情况**在 `apps/desktop/e2e/` 用假节点各跑一遍。
4. 单元测试 / 类型检查全绿。

## 3. 三轮讨论

议题：**联调准备 · 讨论室第一次试跑**（`proj_01M5HVQXAN0964MT9REWB330EG`）。

| 轮 | 任务 | 回答 | 汇总 | 方案 |
| --- | --- | --- | --- | --- |
| 第 1 轮 | 用三句话说说这个讨论室最需要改进的地方 | 483 / 409 / 150 字 | `report` 解析（7 要点 / 5 风险 / 6 遗漏 / 3 备选 / 3 额外说明） | `planContent = null`（当时的汇总 Prompt 还没要求方案；#62 已修） |
| 第 2 轮 | 第 1 轮汇总列出了 5 条风险。请每人挑最认同和最不认同的各一条……（最多 5 句） | 502 / 341 / 196 字 | `report` 解析（6 要点 / 5 风险 / 5 遗漏 / 4 备选 / 3 额外说明） | **v1 生成**（1,106 字，`changeNote = 由第 2 轮汇总生成`）→ 确认 → 定稿 |
| 第 3 轮 | 基于方案 v1（已定稿），指出最该先做和最该删掉/推迟的各一项，给出 v2 修改建议（最多 5 句） | 881 / 572 / 535 字 | `report` 解析（8 要点 / 5 风险 / 5 遗漏 / 3 备选） | **v2 生成**（1,602 字，`changeNote = 由第 3 轮汇总生成`，`parent = v1`）→ 确认 → 定稿 |

最终状态：

```
rounds:  1 SUMMARIZED / 2 SUMMARIZED / 3 SUMMARIZED
turns:   12 answered + 3 rejected（第 3 轮 redraft 前那一批被取消）
messages: 9 条 agent_reply + 3 条 summary
plans:   v1 SUPERSEDED（"被新定稿的版本取代"）
         v2 FINAL（parent = v1）
runs:    12 个，每个恰好 1 个终止事件
```

三个观察：

- 第 2 轮 Codex 读到 `orchestrator.ts:161` 已经处理 `QUEUED`，在回答里指出第 1 轮的判断「已过时」——讨论记录确实发到了它手里。
- 第 3 轮 C酱 和 DeepSeek 都主张先做第 1 项故障注入验证、把第 5 项移出 v2；Codex 指出第 3 项 Prompt 轮次校验其实已经存在。v2 按这些意见收敛了范围。
- 汇总的交叉态度如实记成 `not_addressed`，没有替人表态。

### 3.1 过程中的两个插曲

- **v1 被提前定稿**：第 2 轮汇总出 v1 后，用户先「确认」再「盖章定稿」，v1 变成 FINAL。后来起草第 3 轮时，renderer 只找 `CURRENT` 方案，导致第 3 轮第一次起草 `planVersionId = null`。临时把这一轮（还是 DRAFT）的 `plan_version_id` 指到 v1，再走 `round.redraft` 重拼 Prompt，确认页里就有正式的方案块了。#68 已经补上「定稿后的方案也能带进下一轮」，后续不需要这个手工步骤。
- **派生版本被连点叠出**：用户连点「从 v1 派生下一版」，产生了 v2…v12 的空克隆（内容与 v1 相同），其中 v3–v6 同时是 DRAFT。已修：#66 让 `plan.derive` 先作废其它 DRAFT、且只能从最新有效版本派生；真机库里的 v2…v12 已删除，第 3 轮汇总产生的 v13 已改号为 **v2**（parent = v1）。这是测试数据的修复，不是代码行为。

## 4. 重启后完整读回

做法：

1. 用最新 `main` 重新构建并启动应用。
2. 运行 `apps/desktop/scripts/readback-digest.mjs`，把话题的 rounds / messages / summaries / plans / turns / runs / 计数归一化成 JSON，算 sha256（前 16 位）。
3. `taskkill /PID <主进程> /T /F` 关掉应用（连同 renderer），重新启动同一个构建。
4. 再跑一次同样的脚本，比较 digest 和计数。

命令：

```
$ node apps/desktop/scripts/readback-digest.mjs
```

重启前：

```json
{
  "project": "联调准备 · 讨论室第一次试跑",
  "digest": "922f1a76c575b45c",
  "counts": {
    "rounds": 3, "messages": 12, "summaries": 3, "plans": 2,
    "turns": 15, "runs": 12, "batches": 7, "snapshots": 15, "runEvents": 3131
  },
  "plans": ["1:SUPERSEDED", "2:FINAL"],
  "rounds": ["1:SUMMARIZED", "2:SUMMARIZED", "3:SUMMARIZED"]
}
```

重启后：**digest 仍然是 `922f1a76c575b45c`，所有计数一模一样。**

界面读回（重启后截图，见 #58）：

- 议题名、三条轮次、`汇总 v1` / `汇总 v2` / `定稿 v2` 都在
- 第 1、2、3 轮的发言和汇总都能展开
- 方案 v2 是 FINAL，v1 是 SUPERSEDED

> 过程中还在两个更早的构建上各重启过一次，digest 也都是 `922f1a76c575b45c`。

## 5. X-21：0-B 的 13 种情况

命令：

```
$ pnpm --filter @room/desktop test:e2e
▶ 0-B 一轮的状态与记录（X-21）
  ✔ 0-B #1 盖章发送：一次批准、每人一个 Run、指纹，盖章后内容不能改
  ✔ 0-B #2 所有人都有结局 → 待汇总，每个 Run 恰好一个结局
  ✔ 0-B #3 结束本轮：没答完的立刻停，Turn round_ended，已写部分保留
  ✔ 0-B #4 打断 + 补充：旧 Turn interrupted + 新批次/新 Run/新指纹，两段都在
  ✔ 0-B #5 全部暂停：正在答的立刻停，Turn paused，计时停
  ✔ 0-B #6 恢复：内容不变，resume 批次，新 Run，计时接着算
  ✔ 0-B #7 额度用尽：Run FAILED(quota_exhausted) → Turn absent_quota，其他人继续
  ✔ 0-B #8 超时 / 出错：Turn 可单独重试（retry 批次，新 Run）
  ✔ 0-B #9 补充只发给一个人：differsFromOthers = true，额外信息进时间线
  ✔ 0-B #10 替补代答：onBehalfOf 记录，替补不能当汇总者
  ✔ 0-B #11 汇总（成功 + 失败退回）
  ✔ 0-B #12 盖章定稿：方案 vN → FINAL（校验 contentHash），可派生 vN+1
  ✔ 0-B #13 改方向作废：Round VOIDED + reason，记录保留，基于它的方案草稿 SUPERSEDED
✔ 0-B 一轮的状态与记录（X-21）
ℹ tests 13
ℹ pass 13
ℹ fail 0
ℹ duration_ms 2259.6076
```

- **第 10 条：部分覆盖（直接写库模拟替补）**。1A 的 `round.draft` 还没有「选择替补」的命令参数；测试在盖章前直接给 batch item / Turn 写 `on_behalf_of`，再走真的审批、Run、结算和「替补不能当汇总者」的校验。等契约加上替补参数后改成命令。
- 第 9 条按 0-B 只验证 `differsFromOthers` 和记录；补充走 `userSupplement` 可信通道属于 X-20（#65），由 core 的单测覆盖。
- 假节点是本地 HTTP 服务，按 AgentServer 协议（health / 启动 / NDJSON 事件流 + after 补发 + heartbeat / cancel），行为按 profile 配 `answer` / `hold` / `error`（含 `quota_exhausted`）/ `timeout` / `cancelled`；主控端用的是真的 `HttpRemoteAgentAdapter`。
- PR #69 已合并（`d24927b`）。

## 6. 单元测试 / 类型检查

```
$ pnpm -r test
packages/schemas         42 pass
packages/core            54 pass
apps/agent-server        59 pass
packages/reviewer-client 15 pass
packages/db             127 pass
packages/remote-client   13 pass
apps/desktop             73 pass
（全部 fail 0）

$ pnpm -r typecheck
（无输出）
```

## 7. 验收对照

| 项 | 结果 |
| --- | --- |
| 一个真实议题跑 3 轮 | ✅ 3 轮全部 `SUMMARIZED` |
| 每轮都有汇总 | ✅ 3 条 `summary` 消息 + 3 条 `RoundSummary`，`report` 都能解析 |
| 每个 Run 恰好一个终止事件 | ✅ 12 个 Run 全满足 |
| 方案版本链 | ✅ v1 → v2，v2 为 FINAL，v1 SUPERSEDED |
| 盖章后内容不可改 | ✅ 第 1 轮盖章后 `round.redraft` 返回 `invalid_state`；定稿校验 contentHash |
| 重启后完整读回 | ✅ digest `922f1a76c575b45c` 前后一致 |
| 0-B 的 13 种情况 | ✅ 13/13；第 10 条部分覆盖（见 §5） |
| 单元测试 / 类型检查 | ✅ §6 |

## 8. 已知限制 / 后续

1. **替补**：契约还没有 `round.draft` 的替补参数，0-B #10 只做到「写库模拟 + 下游校验」。
2. **额度**：1A 没有额度接口，界面显示「额度未知」；缺席判断用的是「上一次发言结局」的 5 小时近似。
3. **方案版本号**：v2 是数据修复后的编号（v13 → v2），因为中间有 11 个误操作产生的空克隆被删除。代码侧 #66 已经阻止再次发生。
4. **Token**：截图里 Token 输入框都是「已保存（不显示）」；controller-local 的 Token 是主进程从 `agent-server.token` 直接读入输入框的，没有经过对话或日志。
5. 手机端、执行阶段、任务拆分不在 1A 范围。

## 9. 结论

**Phase 1A 通过**：真实 3 轮讨论 + 方案 v2 定稿 + 重启完整读回 + 0-B 13 种情况端到端测试（第 10 条部分覆盖）全部完成；单元测试和类型检查全绿。可以进入 Phase 1B（执行阶段）的准备工作。
