# @room/remote-client — 主控端的执行节点客户端

负责：Claude（S-03，原 D-08）｜ 审查：DeepSeek

`HttpRemoteAgentAdapter` 实现 `RemoteAgentAdapter`（接口和行为约定见 `packages/core/src/adapter/remote-agent-adapter.ts`），通过局域网调用执行节点上的 AgentServer。

## D-07 怎么用

```ts
import { HttpRemoteAgentAdapter, testReviewerNode } from "@room/remote-client";

// settings.testReviewerNode
const result = await testReviewerNode({ baseUrl, token, profileId });   // → NodeTestResult

// Reviewer
const reviewer = new HttpRemoteAgentAdapter({
  nodeId: "review-node",
  baseUrl,                 // 设置页填写的地址
  profileId,               // 例如 "claude-review"
  token,                   // main 进程从 safeStorage 读出，不要放进 renderer / SQLite / 日志
  heartbeatTimeoutMs: 15_000,   // ≥ 3 × 节点 heartbeatMs（默认 5s）
  reconnectGraceMs: 30_000,     // 必须 > 节点 leaseMs（默认 20s），initialize() 会检查
  requestTimeoutMs: 10_000,
});
await reviewer.initialize();   // 检查连通、profile 存在、租约 < 宽限期
for await (const event of reviewer.run(sessionId, runId, input, opts)) { … }
```

`run()` 产出的就是契约里的 `AgentEvent`：`status` / `message_delta` / `message_complete` / `output`，最后**恰好一个**终止事件。

## 保证（13 个集成测试，跑真实 AgentServer + 可以"拔网线"的代理）

- 端到端：流式文字 → 权威结果 → completed，seq 从 0 连续
- 内容和指纹不一致时**不发任何请求**
- 节点返回被截断的流 → `error(incomplete_output)`，不会变成 completed
- Token 错 / profile 不存在 → `remote_rejected`，带人能看懂的说明
- 节点连不上 → 重试后 `connection_lost`
- **短暂断网**：状态 active → disconnected → active，重连补发，文字不丢不重，正常完成
- **断网超过节点租约**：节点自己停下，重连后报告 `lease_expired`
- **断网超过宽限期**：报告 `connection_lost`，并且节点上的评审确实已经停了
- 取消：由节点确认（不是 unconfirmed）
- 消费方中途停止读取：节点也会被通知取消，不在后台继续消耗额度
- `initialize()` 拒绝"租约 ≥ 宽限期"的不安全配置
- `reconcile()` 找出节点上的孤儿 run 和节点已不认识的 run
