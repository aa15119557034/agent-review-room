# 世界固定 profile：节点实现

接在 #248 节点账本实现后，执行已合并的 #244 / #247 契约。江浩要求 C酱额度用尽期间由林离继续推进；本片尚待独立审查，不改本机节点配置、不启用真实供应商。

## 显式配置

在既有节点配置中可选增加映射，target 不另写到通用 profiles：

```json
{
  "worldProfiles": [{
    "profileId": "deepseek-world",
    "sourceChatProfileId": "deepseek-chat",
    "recipeVersion": "deepseek-http-v1"
  }]
}
```

同时必须已有合法 runFenceDir、source chat profile 与自己的凭据。没有映射不会增加能力；未校验通过的 source 不上报 world 能力。目标碰名、重复 source、映射链/环、未知 recipe 及非本节点秘书前缀均不生成映射。

## 固定边界

- 只接受与当前节点自身相同的直接 Node 可执行文件，及 LF 规范化 SHA-256 为 `6902836a665c878cc6adbab8f3937c78c04f71953838ab5f852ca58d9b581814` 的已审 bundled deepseek-chat.mjs。CRLF 与 LF 等价，其他脚本修改必须另行验证；不接受 cmd/npm 包装或 Node 启动参数。
- source 有明确非空模型目录，modelArgs/effortArgs 只有固定替换；逐一核对实际参数顺序确实执行每个声明选择。比如 model-args 标记之后仍有固定模型覆盖时，不能冒充所选模型。隐式默认 effort 未明确核实就报告 null。
- target 从固定字段构造，不复制 source 的通用命令参数、个人目录、记忆、图片、quota、resume 或任意环境。只保留必要系统环境及 source 的 DEEPSEEK_API_KEY 读取方式/优先级。声明 Node preload 等变量的 source 不生成能力。
- endpoint 沿用 source，禁止 URL 内嵌凭据、查询串及片段；HTTPS 或本机 loopback HTTP。max-tokens 保留 source 的 1–8192 有界值，未设时为 2048；超出范围不生成能力。目标执行超时上限不超过 120 秒。
- cwd 为该持久账本目录下的 world-empty；拒绝链接、别名或非空内容。脚本只处理当前 stdin，构造单条 user HTTP 消息，不执行回复里的 tool_calls。
- health 与最终准入都重新检查脚本、source、mapping、模型及 cwd。所有异步校验之后、admitted 之前重查，期间没有 await。固定 target 缺少绑定返回 400，普通/变化的目标收到旧世界预期返回 409/world_profile_mismatch。
- expectedWorldProfile 加入 Run 请求身份；无该字段的旧请求保持原 hash 格式。completed 仍不能代替持久 proof。

## 实际验证

```text
node node_modules/tsx/dist/cli.mjs --test apps/agent-server/test/*.test.ts
tests 243 / suites 46 / pass 243 / fail 0 / skipped 0

node node_modules/typescript/bin/tsc -p apps/agent-server/tsconfig.json --noEmit
exit 0

node apps/agent-server/scripts/bundle.mjs
dist/agent-server.mjs 432.1kb / exit 0
```

新增 24 项覆盖 wrapper/preload/改变脚本、参数顺序、目录诱饵、错误映射/recipe、缺绑定和额外上下文。两个真实 Node 子进程向本机假供应商分别发送 persona-1/persona-2，每个请求只有当前一条 user 消息和相同选定模型/effort；source 的工程/记忆/环境诱饵及父进程 NODE_OPTIONS 未混入执行。返回 tool_calls 不触发本地执行。相同 ledger 重启、把旧 target 换成普通 profile 后，旧请求返回 409 且供应商调用 0。

另用实际 dist/agent-server.mjs 从临时配置启动独立节点：health 映射正确，1 次真实子进程调用本机假供应商成功，proof 为 closed_process。未调用真实 DeepSeek、Claude 或 Codex 供应商；桌面持久绑定、全局屏障与真实模型质量仍是后续验收。
