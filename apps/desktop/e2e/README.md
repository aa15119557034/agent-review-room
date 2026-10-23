# 讨论室端到端测试（X-21 / X-33）

ADR-002 附录 A 的 13 种情况，一条测试对应一行，名字按行号：

```
0-B #1 盖章发送
0-B #2 所有人都有结局 → 待汇总
...
0-B #13 改方向作废
```

## 怎么跑

```
pnpm --filter @room/desktop test:e2e
```

从仓库根目录单独检查 e2e 类型：

```
pnpm exec tsc -p apps/desktop/e2e/tsconfig.json
```

## X-33 模型选择

依赖 C-40 契约、D-35 真后端和 C-41 同步后的工作树。只有 C-40 时，集成用例会在参与者设置或批次返回值的契约校验处失败。

`model-selection.test.ts` 继续走真的 dispatcher / DB / Orchestrator / HTTP adapter：

| 用例 | 验证 |
|---|---|
| #1 老节点 | 即使保存了模型设置，未报告 `profileModels` 时批次和 expected 仍是 null，HTTP StartRun 省略 model |
| #2 场合强度 | 同一 Codex profile 讨论用 medium、汇总用 high；节点默认特意设成 low；实际请求只有 model / effort |
| #3 备选 | health 只提供备选，批次标记 usedFallback，HTTP 请求用备选 id |
| #4～#7 指纹不匹配 | 只改最后一个收件人的 expected 模型、强度、选定值→null、null→选定值；hash 不变；整批 stale_snapshot、零新 Run / HTTP 请求；原值仍能批准且仅发出应有的两个 Run |

`harness.approveRequest()` 复用契约的 `toRunModel`，逐项从真实批次构造 expected。`FakeNode` 的模型能力可选上报，默认保持老节点行为；`starts` 保留实际 model 是否存在的区别。`fake-node.test.ts` 可独立验证这个 HTTP 记录边界，不需要 D-35：

```
pnpm --filter @room/desktop exec tsx --test e2e/fake-node.test.ts
pnpm --filter @room/desktop exec tsx --test e2e/model-selection.test.ts
```

## 用的是什么

- **假节点**：`fake-node.ts` 是一个本地 HTTP 服务，按 AgentServer 协议（`/v1/health`、`POST /v1/runs`、NDJSON 事件流、cancel）说话，行为按 profile 指定：`answer` / `hold` / `error` / `timeout` / `cancelled`。它不启动任何 CLI。
- **真后端**：`harness.ts` 用真的 DB、`createDispatcher`、`DiscussionService`、`RunOrchestrator`、`HttpRemoteAgentAdapter`（主控端走真的 remote-client，鉴权、事件流、cancel 都会走到）。
- 两个假节点：`user-pc`（claude-review）和 `controller-local`（deepseek-discuss / codex-discuss），和真机的节点划分一致。

## 两个已知的 1A 限制

- **#10 替补代答**：1A 的 `round.draft` 还没有选择替补的命令参数。测试在盖章前直接给 batch item / Turn 写上 `on_behalf_of`，再走真的审批和 Run。等契约加上替补参数后，这一段可以换成命令。
- **#9 只验证 `differsFromOthers` 和记录**：补充走 `userSupplement` 可信通道是 X-20（#65）的范围，0-B 第 9 行只要求「标他收到了额外信息、汇总里注明」。
