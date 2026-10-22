# 0-B 端到端测试（X-21）

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

## 用的是什么

- **假节点**：`fake-node.ts` 是一个本地 HTTP 服务，按 AgentServer 协议（`/v1/health`、`POST /v1/runs`、NDJSON 事件流、cancel）说话，行为按 profile 指定：`answer` / `hold` / `error` / `timeout` / `cancelled`。它不启动任何 CLI。
- **真后端**：`harness.ts` 用真的 DB、`createDispatcher`、`DiscussionService`、`RunOrchestrator`、`HttpRemoteAgentAdapter`（主控端走真的 remote-client，鉴权、事件流、cancel 都会走到）。
- 两个假节点：`user-pc`（claude-review）和 `controller-local`（deepseek-discuss / codex-discuss），和真机的节点划分一致。

## 两个已知的 1A 限制

- **#10 替补代答**：1A 的 `round.draft` 还没有选择替补的命令参数。测试在盖章前直接给 batch item / Turn 写上 `on_behalf_of`，再走真的审批和 Run。等契约加上替补参数后，这一段可以换成命令。
- **#9 只验证 `differsFromOthers` 和记录**：补充走 `userSupplement` 可信通道是 X-20（#65）的范围，0-B 第 9 行只要求「标他收到了额外信息、汇总里注明」。
