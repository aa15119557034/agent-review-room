# 任务板 · Phase 1A：讨论室

依据：`docs/design/ADR-002-讨论室模式.md`、契约 C-20（`packages/schemas/src/discussion.ts` 和 `control-api.ts` 的讨论室部分）。
界面：Design 画布《讨论室界面草案》v3（「0-A 页面结构」「0-B 一轮的状态与记录」是实现依据）。

## 1A 目标

```
新议题 → 勾选收件人、写本轮任务 → 确认页逐字查看、盖章
→ 几个 Agent 同时回答（可暂停 / 打断 / 补充 / 结束本轮）
→ C酱 汇总（同样要盖章）→ 方案 vN 草稿 → 你确认 → 下一轮 … → 盖章定稿
```

**验收**：一个真实议题跑 3 轮并盖章定稿；画布 0-B 的 13 种情况每种至少一条自动测试；每个 Run 恰好一个终止事件；重启后整个议题（轮、发言、汇总、方案版本）都能完整读回。

范围外（1B 以后）：额度显示、替补、参与者控制台、设置页的外观部分、执行阶段、手机端。

---

## 第 0 步：你

- [ ] 批准 ADR-002（合并 #26）
- [ ] 批准 C-20 契约（合并 #27）
- [ ] 在主控机上装 Codex 命令行并用 ChatGPT 账号登录（Claude 带着做，见 S-10）

## 第 1 步：契约

| ID | 负责 | 内容 | 状态 |
|---|---|---|---|
| **C-20** | Claude | 讨论室实体、轮 / 方案状态机、19 个命令、7 个查询、6 个事件 | PR #27，等批准 |

## 第 2 步：可以并行（C-20 合并后）

| ID | 负责 | 内容 | 依赖 | 验收 |
|---|---|---|---|---|
| **D-20** | DeepSeek | 迁移 v3：rounds / batches / turns / round_summaries / plan_versions / agents / nodes 表；messages.kind 和 failure_reason 的 CHECK **从 v3 起写成字面量**；`(batch_id, recipient)` 唯一；Turn 的 approval_id 唯一 | C-20 | 旧库升级后 Phase 0 数据完好；约束拦得住非法写入 |
| **D-21** | DeepSeek | 轮次编排（main）：一轮并行 N 个 Run；`batch.approve` 整批同一事务（hash 全对才发）；暂停 / 恢复 / 打断 / 结束本轮 / 重试 / 作废的语义照 0-B；额度用尽 → `absent_quota`；`agent_reply` / `summary` 和 Run 终态同一事务写入；全部讨论室命令和查询 | C-20、D-20 | 0-B 每一行一条测试；每个 Run 恰好一个终止事件 |
| **X-20** | Codex | `packages/core/src/discussion/`：给每个收件人拼 Prompt（角色设定 → 指令 → 带 nonce 的讨论记录 / 附件 / 方案 → 本轮任务）；讨论记录压缩（最近 2 轮全文，更早用汇总）并产出 `compressedRounds`；`differsFromOthers` 的判断；汇总请求的 Prompt 和结构化输出的解析（解析失败返回 null） | C-20 | 伪造结束标签不能闭合边界；同一输入两次拼装 hash 相同；压缩说明和实际发送内容一致 |
| **C-21** | Claude | 主页 · 讨论（顶栏导航、议题栏、时间线、右侧方案与参与者）+ mock 后端实现全部讨论室命令 | C-20 | Playwright 跑通 mock 下的一整轮 |
| **C-22** | Claude | 发送确认页（逐个收件人看全文、指纹、压缩说明、额外信息标记、盖章） | C-21 | 指纹不一致时盖不了章 |
| **C-23** | Claude | 一轮进行中（流式回答、暂停、打断、补充三种方式、结束本轮、作废） | C-21 | — |
| **C-24** | Claude | 汇总与方案版本（谁同意了什么、版本对照、确认、盖章定稿、派生） | C-21 | — |
| **S-10** | Claude | 节点：主控机本地 AgentServer（只监听 127.0.0.1）；`codex-discuss` profile（`codex exec`）、`deepseek-discuss` profile（API Key 只在节点上）；实测 Claude / Codex 的额度能不能读到，写进 README | — | 三个 Agent 各回答一次真实问题 |
| **X-21** | Codex | 端到端测试（`apps/desktop/e2e/`）：用 fake 节点跑完 0-B 的 13 种情况 | D-21、C-21 | — |

## 第 3 步：联调与验收

| ID | 负责 | 内容 |
|---|---|---|
| **R-20** | Claude（新会话） | 审 D-21 的编排：非法状态转换、终止事件唯一、错误路径、资源释放 |
| **R-21** | Codex | 审 C-20 契约和 D-20 迁移 |
| **A-1A** | 你 | 用一个真实议题跑 3 轮并定稿，写进《Phase 1A 验收记录》 |

## 注意

- Codex 在主控机上用自己的文件夹（例如 `E:\agent-review-room\codex`），和 DeepSeek 的 `dev` 分开，互不覆盖
- 所有 Agent 开工前读 `AGENTS.md`（Codex 会自动读取）
- 讨论室里 Agent 的回答也是不可信数据：拼 Prompt 时一律进边界，包括 C酱 的汇总
