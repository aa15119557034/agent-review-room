# 世界 Run fence：HTTP 客户端适配

本片实现已合并的 #244 / #247 契约，范围仅在 `packages/remote-client`。不接通 desktop 启动入口，不启用真实模型。

- 构造时复制并冻结 ledger、world profile 预期与实际模型。world 预期没有 ledger 或明确模型时拒绝构造；旧普通 adapter 的 `runFence` 缺席。
- initialize 和受绑定的创建请求前核对 health 的 nodeId、ledgerId、source/target/recipe 和目标模型档位。当前只接受审定的 `deepseek-http-v1`；不按 profile 后缀或 readOnly 推断，不替换模型。节点仍须在最终准入处再次核对，客户端 health 不能代替节点检查。
- 所有创建重试携带同一序列化绑定；world 请求带聊天、工程或图片上下文时在发送前拒绝。409 mismatch 是终止拒绝，不删除字段重试。
- `runFence.cancel` 独立于生成 signal，要求 HTTP 202 及合法 `{ok:true}`，网络、状态、格式和超时错误向调用方抛出。内部流式清理可以尽力取消，但不能由此伪造公开取消成功或停止证明。
- `runFence.proof` 要求 HTTP 200、合法 schema、匹配 RunId 和原 ledger，并禁止缓存；missing/unconfirmed 原样返回。方法不查询 health、不创建会话、不要求原 profile 存在，可供重启后使用原连接配置对账。
- 停止事件、finished、列表缺席和租约结束不清理任何持久 world 绑定；该绑定与全局准入屏障由 desktop 后续实现管理。

## 实际验证

```text
node node_modules/tsx/dist/cli.mjs --test packages/remote-client/test/*.test.ts
tests 47 / pass 47 / fail 0

node node_modules/typescript/bin/tsc -p packages/remote-client/tsconfig.json --noEmit
exit 0

git diff --check
exit 0
```

新增 28 项真实 loopback HTTP 测试覆盖不可变绑定和重试、节点/ledger/recipe/model 错配、禁止上下文、节点最终409、无需原 profile 的对账、取消200/401/409/500/假成功/断网/响应体卡住、错误 proof 身份与状态，以及创建响应头被扣住时的独立取消。原有 19 项与真实 AgentServer/受控 CLI 的测试同时通过。新 profile 相关 HTTP handler 是契约测试节点，不声称已经联通生产固定 recipe 或真实供应商。
