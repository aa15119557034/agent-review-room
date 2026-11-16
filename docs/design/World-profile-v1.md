# 世界隔离 profile 与公开 Run fence 接口 v1

状态：契约提议，尚未获合并。接在已合并的 [Run-fence v1](Run-fence-v1.md)（#244）后；本次只有 wire schema、接口类型、校验测试和说明，不实现节点 recipe、客户端方法或桌面接线，不启用真实世界模型。

## 1. 范围与准入依据

世界模型只通过节点明确声明且经过实际校验的固定隔离 profile 执行。`-chat` 后缀、`AgentCapabilities.readOnly` 或配置里的布尔值都不能替代隔离验证。传输仍是现有 Text Run、RunModel、AgentEvent 与 WorldCognitionReply，不新增 WorldRun 或通用 profile 框架。

首版认可的 recipe 标识为 `deepseek-http-v1`：直接 Node 进程运行经过核验的 bundled `deepseek-chat.mjs`，一次 stdin 对应一次纯 HTTP 请求。该脚本已有两次独立本地假服务 Run 的探针依据，不等于供应商性能、回答质量或本契约运行时验收已经通过。

当前 Codex 0.163.0 的收紧 CLI 配置仍向模型注册 functions.exec/apply_patch；read-only 拒绝写入后仍可继续模型循环，不能声明零工具。Claude 候选配置尚未在本机实测。两者目前都不报世界能力；不得因缺能力改用另一位秘书、别人的节点、另一个模型或未获选择的付费 API。

## 2. Health 声明与默认模型

新增 `NodeHealth.capabilities.worldProfiles?: WorldProfileCapability[]`，最多 64 条。缺席或空数组表示没有映射，不补默认能力。每条为：

| 字段 | 类型 | 含义 |
|---|---|---|
| profileId | ProfileId | 固定隔离 target |
| sourceChatProfileId | ProfileId | 同一节点上该居民原本使用的聊天 profile |
| recipeVersion | WorldProfileRecipeId | 稳定的执行语义版本，首版只认可 deepseek-http-v1 |
| sourceDefaultModel | RunModel 或 null | 节点核实的 source 实际默认 model/effort；null 表示不能肯定 |

**sourceDefaultModel 是节点必须依据实际执行配置核实的声明。schema 只能检查格式和已声明目录的一致性，不能验证真实命令、凭据、默认模型或隔离。** 不能给 world 单独指定一个默认，再声称 source 一样。source 使用隐式默认且本字段为 null 时，首版不派发。

模型目录复用已有 `profileModels` / `ModelOption`。有非空映射时，schema 检查：

- source 与 target 都在 profiles 中；target 唯一、source 唯一，二者不能相同，任一 source 不能是另一个 target（拒绝映射链及环）。
- target 有明确的非空模型目录，且不同时出现在 memoryProfiles/imageProfiles；同一 health 要有 runFence v1。
- 非 null 的 sourceDefaultModel 必须在 target 目录中合法；source 若已声明非空模型目录，也必须一致。effort 为 null 仅用于该模型无档位，不能悄悄改档。
- source 的目录缺席或为空时，不能靠 schema 证明实际默认；节点仍须核实自己的声明。普通 source 的个人记忆能力可以保留，不能传给 target。

只在新字段存在时增加以上约束，不顺手改变旧 health 的扩展字段处理或其他目录规则。未来 recipe 标识可以解析，但调用方不认识/未实现该 recipe 时必须拒绝世界派发，不能把“可解析”当“已隔离”。

## 3. 创建请求必须绑定隔离映射

StartRunRequest 增加可选的严格对象：

```json
{"expectedWorldProfile":{"sourceChatProfileId":"deepseek-chat","recipeVersion":"deepseek-http-v1"}}
```

世界创建仍带原 protocol、RunId、snapshot、limits，以及 target profileId；同时必须携带 #244 的 expectedLedgerId 和显式 RunModel。expectedWorldProfile 参与同 RunId 请求身份/hash/幂等比较。

ledger 身份在配置重启时可以保持不变。只带 profileId + ledgerId 不能防止节点重启后同名 profile 被普通 CLI 替换。因此节点在所有 await 校验之后、持久 admitted 之前，再核对 `profileId + sourceChatProfileId + recipeVersion` 是否匹配当前经校验的固定注册表。缺失、改变或停用返回 **409 / world_profile_mismatch**，绝不退成普通执行；改变执行语义不能沿用原 recipeVersion。

带 expectedWorldProfile 的 wire 请求必须：

- 有 expectedLedgerId 和显式 model/effort，source 与 target 不同；kind 省略或为 text。
- 没有 chat（包括 memory:null）、snapshot.commitSha、attachments、imageSlot 或 kind:image。不能静默丢弃后继续执行。

普通旧请求不带新字段时，schema 行为不变。但固定 world target 收到缺 expectation、ledger 或 model 的请求，节点仍须返回 400 bad_request；这一点依赖节点注册表，schema 无法仅凭 profile 名称判定。普通 profile 收到 expectation 必须返回 world_profile_mismatch。模型/档位不在目录仍使用现有 unknown_model；拒绝后不换模型、去掉字段或生成新 Run 重试。

## 4. 节点 recipe 的执行边界

固定构造器生成 target，不从通用 Profile 原样复制任意参数：

- 直接启动经过核验的 Node 可执行文件和 bundled 脚本，不用 cmd/npm/shell wrapper；脚本变更后重新核验。禁止 NODE_OPTIONS/NODE_PATH 等 preload 或任意命令覆盖。
- 固定空 cwd，一次进程只处理当前 stdin；不加载工程 AGENTS、个人 memory、聊天历史、MCP、hook、skill、插件或旧会话，不支持 resume。
- API key/endpoint 来自同一 source 的既有本地配置；不借别人的凭据/provider。wire 和日志不包含 key。必要系统环境及业务参数分别用固定白名单构造，不复制任意 env/args/modelArgs。
- 可变业务输入仅限已验证的同 provider endpoint、选择的 model/effort 和有界 max-tokens；禁止 content-json 图片模式、额外脚本、工具或后台任务。
- 只发本次 prompt 的一条 user 消息，不注册工具，不执行模型输出里的工具调用，不产生后代执行或持久会话。
- 首先按该居民自己的 source chat 选择规则解析实际模型一次；target 只核对同一个 model/effort，不再 fallback。已有显式选择原样保留；只有核实的 sourceDefaultModel 才能补 source 隐式默认。不能核实就不可用。
- 每次准入都验证固定 recipe，不仅在 health 请求时检查；未经验证的 source 配置不生成映射。

这套 recipe 与 Run fence 是两个条件。closed_process 只证明直接受管 Node 进程关闭，不保证供应商服务器停止此前已收到的推理或不再计费；reservation 不退。只有派发时绑定了已审定的执行范围，桌面才可用匹配 proof 解除本地模型准入屏障。

## 5. core 公开的可选能力对象

RemoteNodeConfig 增加 `expectedLedgerId?: RemoteRunLedgerId` 和 `expectedWorldProfile?: WorldProfileExpectation`；派发 adapter 构造后绑定不变。RemoteAgentAdapter 增加可选 `readonly runFence?: RemoteRunFenceAccess`：

```ts
interface RemoteRunFenceAccess {
  readonly ledgerId: RemoteRunLedgerId;
  cancel(runId: RunId, reason?: string, signal?: AbortSignal): Promise<void>;
  proof(runId: RunId, signal?: AbortSignal): Promise<RemoteRunProof>;
}
```

旧 adapter 可以没有这个对象。世界 Runner 只依赖 core 接口，不能引入 HttpRemoteAgentAdapter 或根据具体实现类判断：

1. 能力对象的存在不是节点支持证明。新派发 initialize 必须核对精确 nodeId、ledgerId、world 映射/recipe 及模型；失败不能去掉绑定重试。所有 start 网络重试和内部取消携带原绑定。
2. cancel 用调用方提供的独立、有界清理 signal，不复用已 abort 的生成 signal。仅 202 + 合法 CancelRunResponse 才 resolve；HTTP、网络、格式错误 reject，不吞成成功。CancelRunResponse 给已有 `{ok:true}` 命名，wire 不变，也不是停止 proof。
3. proof 校验 schema、精确 RunId 和 ledgerId。404、读取失败、错配 reject；missing/unconfirmed 原样返回，不能清屏障。已有 runs 列表缺席、finished、terminal、租约经过均不能代替 proof。
4. 对账不要求 startSession，也不要求原 profile 仍在节点上；使用原 nodeId/baseUrl/凭据与 ledger/RunId。不能改用居民当前新目标去取消、证明旧 Run。
5. 流式 adapter 可以尽力发送取消并结束本地迭代器；这不允许 public cancel 吞异常，也不允许 completed 事件直接解除持久绑定。

本次仅增加接口和纠正旧租约注释，不实现上述方法。

## 6. 桌面后续接线与最小实现片

world-node 精确匹配居民自己的 chatProfileId → sourceChatProfileId，不再依赖后缀；核对同 nodeId/baseUrl/凭据。解析期间用户暂停、改配置或取消则丢弃本次。source 模型不确定、target 不支持同一档位、能力缺席均不发请求。

沿用 #244 的 world-usage.sqlite reservation + pending binding 同事务，另保存实际 RunModel 与 expectedWorldProfile/recipe。恢复时不猜旧执行范围，不重放旧 prompt；完成事件也必须取得匹配肯定 proof 并持久保存确认。全部未解决绑定构成 chat/discussion/world 共用的模型准入屏障，规则世界与只读 UI 可继续。新能力或新 ledger 不能为旧绑定作证。

后续分片：节点小型固定 recipe 构造器与 server 最终准入；remote-client 的 runFence 方法；desktop resolver、持久绑定和全局屏障。复用现有 deepseek-chat 脚本、传输、节点身份和模型目录，不新增通用调度/profile 模块。每片等待对应契约合并，不在本次接 index 启用。

## 7. 验收

本次 schema 测试覆盖旧字段兼容、映射存在性/唯一性、自映射/链/环、非法 source 默认模型/档位、world 请求不携带聊天/工程/图片上下文；这些不证明运行时隔离。

后续实现必须补以下真实 HTTP/临时存储/可控进程反例：

- 手填 `-chat` 或 readOnly 不产生能力；当前 Codex/未测 Claude 不报告映射。
- health 后保持同 ledger 重启并将同名 target 换成普通配置：迟到 POST 被拒绝，目标 spawn 0。
- 新字段缺失、非法附加上下文、source 默认未知或 target 缺同一模型档位：拒绝，不降级。
- 假供应商两次不同 persona/证据互不串联；工程/记忆/MCP/hook 注入诱饵不进入请求或产生本地工作。
- public cancel 无原会话/profile 也可对账；错误响应 reject，成功接收仍等 proof；错误 RunId/ledger/404 不解锁。
- 所有重试/取消携带原绑定；completed 或 finished 不绕过持久 proof；kill 失败/no close 与真实 close 正反控。

实际实现、供应商调用、跨重启恢复、前台屏障和长期资源表现均不在本次契约测试的验证范围。
