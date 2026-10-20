# @room/reviewer-client — 负责：DeepSeek ｜ 审查：Claude

调用 Reviewer API（D-05）。只发送 `snapshot.content` 原文；发送前重新计算 hash，不一致就拒绝发送。

## 用法

```ts
import { createReviewerAdapter } from "@room/reviewer-client";

const adapter = createReviewerAdapter({
  apiKey,                 // 由 main 进程从本地配置读取，绝不进 renderer
  model: "deepseek-chat",
  baseUrl: "https://api.deepseek.com",
});

const caps = await adapter.initialize();   // { streaming: true, permissionRequests: false, readOnly: true }
const session = await adapter.startSession({ projectId });

for await (const event of adapter.run(session.sessionId, runId, { snapshotId, content, contentHash }, opts)) {
  // message_delta* → message_complete → completed（恰好一个终止事件）
}
```

## 不变量

1. **只发 `content` 原文**：请求体里 `messages[0].content === input.content`，不追加 system prompt、不裁剪（AC-7）。
2. **发送前重算 sha256**：与 `contentHash` 不一致立刻产出 `error(hash_mismatch)`，**一个请求都不发**。
3. **恰好一个终止事件**：`completed` / `error` / `cancelled` / `timed_out` 之一；任何异常都转成 `error`，迭代器不抛。
4. **key 不落日志**：本模块不打印、不写文件，只放在 Authorization 头里。
5. **可注入 fetch**：测试用 `fetchImpl`，生产用全局 fetch。

## 测试

```bash
pnpm --filter @room/reviewer-client test
```

覆盖：能力声明、hash 不匹配时不发请求、SSE 流解析与事件顺序、请求体裁剪（AC-7）、
HTTP 错误/网络异常/已 abort 都只产出一个终止事件。

## 流完整性（D-05b）

| 情况 | 行为 |
| --- | --- |
| 流结束但没收到 `[DONE]`，也没有 `finish_reason` | `error`（"stream ended unexpectedly"），**不会**当成完成 |
| `finish_reason === "length"`（被 max tokens 截断） | 先 `message_complete`（带截断前的内容），再 `error(output_limit_exceeded)` |
| 消费方 `break`（`iterator.return()`） | 中止请求并 `reader.cancel()`——Reviewer 不会继续生成、继续计费 |
| 连续 `idleTimeoutMs` 没有新数据 | `timed_out(kind: "idle")` |
| 超过 `totalTimeoutMs` | `timed_out(kind: "total")` |
| SSE 用 CRLF 分隔 | 先规范化为 LF 再解析 |

实现细节：`abort` 用一个 `Promise.race` 打断挂起的 `reader.read()`，否则 idle/total 超时要等下一块数据才生效。
