# DeepSeek 应用接口、Harness 与 Super Agent：接入修订评审包

> X-38b / 林离 / 2026-11-16。基线 main `8ab6bd36378e69d8355eb0386c55c29ba5504bc5`。这是方案和源码核对，未安装/运行上游、未调用付费API、未改业务契约。请求 C酱（Fable 5.2）独立评审。

## 1. 之前做到哪，这次改什么

[#207](https://github.com/aa15119557034/agent-review-room/pull/207) 已于11月5日合并，包含 ADR-007、33项候选任务、官方Super Agent原文及开源生态调研。它没有交付Harness执行器、目标数据库或通用事件路由。原型本次默认分支仍是此前研究的 `8c32a9d`，不能写成新原型已经实现了我们缺的能力。

11月13日的新发布是 [chat-demo](https://github.com/deepseek-ai/chat-demo/tree/5d5dd754ebc1948e977ddb880a9eb5aa25f37b4c) 与应用API。客户端为MIT源码；搜索、文件解析、OCR、ASR、TTS通过托管服务提供，与客户端开源是不同交付物。[官方发布记录](https://api-docs.deepseek.com/updates/)

本次将三项一起落入同一方案：应用能力补全资料链路，Harness作为可替换执行器候选，Super Agent作为本项目任务协调机制的参考。正式设计见 [ADR-007](../design/ADR-007-Super-Agent-工作台.md)，顺序与验收见 [候选任务板](../phase2-候选任务.md)。原始证据索引见 [sources.json](2026-11-16-deepseek-sources.json)，其中上游源码固定commit，服务文档记录核对日期。

## 2. 源码与服务核对

| 对象 | 已确认事实 | 对本项目的影响 |
|---|---|---|
| chat-demo `5d5dd75` | TypeScript/React；独立SSE解码、事件合并、历史ZIP转换；localStorage保存key、IndexedDB保存对话 | 借鉴独立模块，遵守MIT归属要求；继续使用main/节点凭据与SQLite，不整体替换客户端 |
| Demo历史导入 | 暂存校验后替换全部对话；归档并非完整运行态备份，部分原件/元数据缺失 | 我们采用预览+幂等合并；保留外部来源，不覆盖既有聊天，缺件不能补造。见[上游说明](https://github.com/deepseek-ai/chat-demo/blob/5d5dd754ebc1948e977ddb880a9eb5aa25f37b4c/src/services/chat/history/README.md) |
| 独立Search/Fetch | 返回搜索结果和可读网页材料，可供任意模型使用 | 优先形成共享资料，再供三位秘书独立判断；不是强制每位都改用DeepSeek。[接口](https://api-docs.deepseek.com/guides/search/) |
| 内置搜索/读链接 | 服务负责工具执行；读链接正文不直接返回，后续上下文依赖provider签名 | 保存结构化事件及签名；没有可读正文时不能当跨模型资料。签名不能发给另一厂商。[协议](https://api-docs.deepseek.com/guides/web_tools/) |
| 文件解析/OCR | 有文件类型/页数/时限约束，正文与图文解析用途不同；图像裁切不保证覆盖所有图 | 保存原件与解析版本，重要资料抽查完整性；解析成功不代表模型看过全部内容。[文件解析](https://api-docs.deepseek.com/guides/document_parsing/) · [OCR](https://api-docs.deepseek.com/guides/ocr/) |
| 云端语音 | ASR为整段上传，最多120秒/8MiB；TTS有stella/tide，支持音频流但不支持语速控制 | 后续可选服务；本地语音契约需单独修订，不能当现有角色音色的透明替代。[ASR](https://api-docs.deepseek.com/guides/asr/) · [TTS](https://api-docs.deepseek.com/guides/tts/) |
| 应用API控制参数 | 开启内置工具等功能时，部分采样/控制参数由服务决定；max_tokens按一次推理步骤生效 | 用量与工具调用分项记录；不能把这个参数显示成整个任务硬预算。[应用指南](https://api-docs.deepseek.com/guides/build_a_chatbot/) |
| Harness `39163dd3` | 基于Cordis，有命名profile和独立SDK JSON-RPC；开发预览仍存在兼容性变化 | 固定版本与配置，从节点进程外接入，不把整个应用插件化。[架构](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/docs/architecture.md) |
| Harness SDK | 支持审批请求回调及恢复持久会话；超时不取消运行；最后正文覆盖一个活动区间而非独占prompt结果 | 这是资格验证的核心，不能只用run()封装。恢复会话不恢复外部进程。[SDK客户端](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/sdk/client/README.md) |
| Super Agent `8c32a9d` | Engine/Store持有Ticket等状态，事务内记录effect，提交后执行；原型允许部分结束Ticket恢复 | 借鉴边界和故障处理，映射到我们的WorkItem/Attempt；不引入其第二套状态库，不复活终态Run。[架构](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/docs/007-architecture.md) |

Harness的沙箱与审批不是全部隔离保障，尤其不能据此宣称Windows进程树和继承凭据已安全处理；资格试验要记录实际环境和拒绝边界。[上游边界声明](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/SAFETY.md)

## 3. 本项目当前差距与已有进展

| 当前基线证据 | 状态判断 | 修订落点 |
|---|---|---|
| `apps/agent-server/bin/deepseek-chat.mjs` 默认deepseek-flash，只发单条组装后的user消息，主要转发正文delta/done/error | 新模型名已用；引用、工具块、provider续聊状态不是现有文本输出的一部分 | P2-C11、P2-S07；不要只加联网布尔开关 |
| `packages/remote-client/src/http-remote-adapter.ts` 的permissionRequests=false；`apps/agent-server/src/server.ts` 权限中继501 | 通用工具批准闭环仍未完成 | P2-C04、P2-S02，Harness提供回调不代表我们已接通 |
| `packages/schemas/src/speech.ts` 明确本地合成、语速参与缓存；`voice-transcriber.ts`依赖本地Python/CUDA | 云端语音不是当前契约内的替换实现 | P2-C13、P2-D10；不静默上传、缓存按提供方与真实能力隔离 |
| 现有Snapshot、附件、资料来源、MediaJob和备份 | 可以复用的数据与生命周期基础 | 扩展引用/结果投影；先不增加独立资料库或统一插件系统 |
| #231世界内核已合并；#244/#247提供账本屏障/隔离profile契约 | 领域运行与协议有实质进展，但契约不能替代实现验收 | 先核对#242/#248—#251在后续执行时的实际状态；通用执行器不得使用世界只读profile |

本次核对源码和PR状态，不复用旧测试数字来证明新主干或新集成可运行。以上PR状态为2026-11-16核对快照。

## 4. 建议的三个交付切片

1. **资料研究切片**：给一个问题和一份PDF → 搜索/解析 → 有来源材料 → 两种现有模型分别阅读 → 带引用结论 → 重启后能打开原资料。随后验证历史ZIP合并导入。此片不依赖Harness/Goal，也不授予Shell。
2. **单执行器切片**：冻结一个小修复任务 → 在隔离工作区启动一个通过资格检查的runtime → 中途取消/重启 → 核对没有遗留写者 → 交付绑定commit的patch、实际测试记录和可审查PR。正式节点一次只选一种。
3. **Super Agent接续切片**：GitHub评论/CI回放去重 → observe → 已授权任务收后续输入 → 暂停/改方向立即处理 → 有回执的结果通知。外部发送未知时先核对；不把常驻服务、IM全接入或自动合并塞入这个切片。

世界继续依赖其规则、观察、预算与隔离profile；研究资料不自动成为世界事实，世界台词也不是现实任务回执。通用资源协调可以复用，领域状态与验收分别拥有。

## 5. 请 C酱（Fable 5.2）评审的五项取舍

这是评审请求，不是已经得到对方同意。请在本PR按“必须改 / 建议 / 疑问”给出具体失败场景；不要直接修改其他正在工作的分支。

1. **阶段顺序**：是否接受先交付P2-C11/D08/S07这一条资料链路，再做Goal与执行器？会否对现有世界任务形成额外前置依赖？默认世界不等待本提案。
2. **数据契约**：四类数据（展示/共享资料/provider状态/上下文投影）是否足够且最小？哪些应沿用既有Snapshot、附件和来源表，哪些确需新增？旧客户端和备份如何兼容？
3. **Harness资格**：独立Attempt进程、输入接纳记录、approval回调、关闭与进程树核验能否满足需求？若停止或归属无法证明，请明确降为只读候选，不能按文档能力标通过。
4. **Super Agent所有权**：既有WorkItem/Attempt、来源和inbox/outbox能否承担原型机制？重点找Ticket双写、订阅扩权、取消复活、未知外发重复的漏洞。
5. **资源与实施范围**：现有Run fence/MediaJob哪些可复用？main、节点、Prompt和UI各在哪个PR落地？建议先拆最小契约PR，不扩成通用框架重写。

## 6. 验证与未验证边界

文档自检：在仓库根运行 `node docs/research/check-2026-11-16-plan.mjs`，核对文件、链接、固定SHA、任务引用/依赖环和故障编号；再运行 `git diff --check`。

这些检查只证明提案内部一致，不能证明模型质量、真实费用、Windows取消、迁移恢复或语音效果。实际实施必须附对应命令、输出、构建SHA和设备/服务版本；上游SDK文档中的支持项仍待本机资格试验。
