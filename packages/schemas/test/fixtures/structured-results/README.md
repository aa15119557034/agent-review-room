# P2-X11 首批 fixture

这些全部是匿名合成数据，**不是实际云端调用或性能结果**。不含密钥、私聊、厂商签名或真实节点配置。

| 文件 | 来源/覆盖 |
|---|---|
| legacy-health.json / legacy-start.json / legacy-accepted.json / legacy-events.ndjson | 未修改主干 `77e31174b14036d94988e33e0809c0447efa182d` 的 schemas.parse + JSON.stringify，protocol=1，关闭结构化结果 |
| provenance.json | 上述固定字节的 SHA-256、基线、编码方式；不要在新 schemas 上重生成旧样本来消除回归 |
| enabled-events.ndjson | C11 v1 合成正向流：步骤、可读/缺件引用、unsupported、完整正文、累计用量、原 terminal |
| deepseek-search-fetch.json | 2026-11-16 核对 [官方 Search/Fetch 文档](https://api-docs.deepseek.com/guides/search/) 后编写的匿名形状样本；含期望来源引用，不含适配器实现 |

上游源码参考固定到 [chat-demo 5d5dd754](https://github.com/deepseek-ai/chat-demo/tree/5d5dd754ebc1948e977ddb880a9eb5aa25f37b4c)。托管 API 没有据此固定服务端构建版本；仅记录 `/v1/tools/search`、`/v1/tools/fetch` 与文档核对日期，不冒充服务版本 pin。

Search 的摘要和 Fetch 的正文分别处理；`content` 为空不生成 readable 引用。示例错误也是合成的，HTTP 404 不推断为资料已删除。用量没有返回时 unknown；示例中的工具次数为合成观测值，不以结果条数代替调用次数。

`structured-results.test.ts` 核对固定字节、hash、协商矩阵、未知/越界输入、事件/实体挂载和样本内容对应关系。坏 SSE、真实旧客户端、重连/撤回/切库、供应商映射和计费不在本次已验证范围，随实现接线补齐。
