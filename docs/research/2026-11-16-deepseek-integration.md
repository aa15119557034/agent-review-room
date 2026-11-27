# DeepSeek 应用接口、Harness 与 Super Agent：接入修订评审包

> X-38b / 林离 / 2026-11-16。基线 main `8ab6bd36378e69d8355eb0386c55c29ba5504bc5`。这是方案和源码核对，未安装/运行上游、未调用付费API、未改业务契约。本轮按 C酱（Fable 5.2）重审修订，仍待复审。

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
| 内置搜索/读链接 | 服务负责工具执行；读链接正文不直接返回，后续上下文依赖provider签名 | 不进首份契约；后续状态依附来源结果，来源撤回/排除时不再交回。整段历史一致性待fixture核实，不预设prefixHash。[协议](https://api-docs.deepseek.com/guides/web_tools/) |
| 文件解析/OCR | Files API 解析成功返回file_id，但原件/解析结果不能下载；OCR是另一条可返回内容的路径，完整性仍须核对 | file_id不能当可分享正文；本地留原件，跨模型只用实际取回的授权材料。上传走独立节点端点，项目先限10MiB；不走现有图片StartRun。[文件解析](https://api-docs.deepseek.com/guides/document_parsing/) · [OCR](https://api-docs.deepseek.com/guides/ocr/) |
| 厂商文件撤回 | Files API 有删除接口和文件ID回执；断连不等于服务端停止解析/计费 | 撤回先断本地引用，再删除/核对厂商文件；失败或未知须说明，上传迟到ID只供清理。不能宣称清除了厂商全部历史副本。[Files API](https://api-docs.deepseek.com/guides/files_api/) |
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
| Snapshot、资料来源和备份；`attachments.ts` 仅ImageMime；`media.ts` 的MediaJobKind仅draw/speech | 可以复用展示和资料基础，但不是通用文件/作业通道 | 投影可重建、不新增表；解析状态归资料/附件；不扩MediaJob kind；上传契约另拆 |
| `http-remote-adapter.ts:307` 对解析不了的事件记日志后丢弃 | 节点单方面宣布新能力不足以保护旧客户端 | 能力声明 + 本次请求显式开启后才发新事件；完整正文仍在message_complete.text，关闭时固定fixture线协议不变 |
| `server.ts` 的maxConcurrentRuns/node_busy；`workspace.ts` 世界维护准入 | 只有既有节点并发控制/世界专用屏障，没有通用资源协调模块 | 1A搜索占Run槽，资料解析独立状态；跨用途协调归阶段2 P2-C04/D03/X05，不阻塞D08 |
| #231世界内核已合并；#244/#247提供账本屏障/隔离profile契约 | 领域运行与协议有实质进展，但契约不能替代实现验收 | 先核对#242/#248—#251在后续执行时的实际状态；通用执行器不得使用世界只读profile |

本次核对源码和PR状态，不复用旧测试数字来证明新主干或新集成可运行。以上PR状态为2026-11-16核对快照。

### P2-X01 本轮状态核对（2026-11-16 14:33 UTC）

REST 回读时 main 仍为上述 SHA；下表是源码与合并状态复核，不是 P2-X01 全部真机验收完成。

| 项目 | 当前证据 | 本轮判定 / 待做 |
|---|---|---|
| #208 打包启动/数据目录 | issue仍open；本轮未运行打包exe写探测 | 未复测，不能判已修或仍可复现；保留P2-D01真机验收 |
| #223 C-50/C-51 | PR已merged，head `aaa3a3b5910aed090711a1c2f2ab9203f3d177eb` | 界面/外壳改动已合并；评论和描述列出的遗留问题需分别复现，不能以merged关闭全部遗留 |
| #244 / #247 契约 | merged commit分别 `484605631c6f9757ea28a728c5ca1dfa5568fb14` / `8ab6bd36378e69d8355eb0386c55c29ba5504bc5` | 账本屏障与隔离profile契约已合并；不是运行完成证据 |
| #242 / #248 | open、非draft；head分别 `57543ef` / `4a50507` | 取消确认/持久账本实现仍未合并，不能称main已有 |
| #249 / #250 / #251 | open、draft；head分别 `b8ff8d1` / `2270310` / `867cede` | 客户端、隔离profile与桌面接线待合并及验证 |
| #232 | open、draft，head `ea81172` | 世界认知真实模型入口未交付；[现有哨兵验收要求](https://github.com/aa15119557034/agent-review-room/pull/232#issuecomment-6902732550)供Harness试验复用，不重复设计另一套 |
| #255 上轮提交 | `1dc34ed` 的 [Windows CI](https://github.com/aa15119557034/agent-review-room/actions/runs/43883949051) success | 仅该提交的CI证据；修订后另跑，不能推断真实SDK/厂商接口已经可用 |

由此保留阶段0的真实节点/取消/恢复核验；此轮未安装软件、未改真实配置、未运行真实模型或迁移数据。

## 4. 建议的三个交付切片

1. **资料研究切片**：给一个问题 → 独立Search/Fetch → 可取回的来源材料 → 两种现有模型分别阅读 → 带引用结论 → 重启后仍可定位原资料。PDF上传/解析、厂商内置续聊和历史ZIP导入分别拆片验收，不作为该切片的退出门槛。此片不依赖Harness/Goal/世界，也不授予Shell。
2. **单执行器切片**：冻结一个小修复任务 → 在隔离工作区启动一个通过资格检查的runtime → 中途取消/重启 → 核对没有遗留写者 → 交付绑定commit的patch、实际测试记录和可审查PR。正式节点一次只选一种。
3. **Super Agent接续切片**：GitHub评论/CI回放去重 → observe或已有任务inbox → 在原授权内利用上下文 → 应用内暂停/改方向优先处理 → 标记与comment id可核对的结果通知。共用GitHub账号不能区分用户/Agent，评论不形成新授权；发送未知或标记歧义时不盲重发。

世界继续依赖其规则、观察、预算与隔离profile；研究资料不自动成为世界事实，世界台词也不是现实任务回执。1A不引入通用资源协调；P2-C04/D03将来定义并实现资源边界，领域状态与验收仍分别拥有。

## 5. 按 Fable 5.2 重审收束，待复审的五项边界

以 [第二轮重审](https://github.com/aa15119557034/agent-review-room/pull/255#issuecomment-6919234138) 为准，撤回第一轮猜测的prefixHash/整段分支作废规则、不丢弃强杀现场、不把解析塞进MediaJob。C酱认可方向但要求修改；下面是本轮修改结果，不代表已复审放行。

1. **阶段与分工**：P2-X03依赖X01/X02，C02可独立起草；C11与X11并行，fixture合并前核对。D09独立验收；F39归阶段2。林离负责已指派的X01/X11/C11/D08/X12，C酱评审；S07/C12和其他阶段另排，本次不直接实现它们。
2. **最小契约**：C11只做可选能力+请求开关、引用/工具步骤/用量事件、来源/版本/hash/取回时间/可读状态引用。旧节点无新字段、旧客户端无新事件、完整正文保持；unknown与0分开。opaque、上传、Goal、语音、实现都不夹带。
3. **撤回与上传**：来源结果被排除时，其opaque也排除；旧摘要stale，opaque默认不进备份。上传用后续独立节点端点，10MiB项目上限；厂商删除记回执/未知，未删不得宣称已删。上传授权粒度仍列“待江浩决定”，不默选按服务永久授权；C11相关授权字段和上传实装待决定后补齐。
4. **Harness资格**：静态能力清点可先做；动态试验用空目录/合成home/最小环境与#232哨兵，受控工具验证审批和停止，真实项目写权限继续阻断。安装隔离副本和付费调用须先获具体批准。强杀现场保留但不复用；未知停止不清账，新identity不证明旧Run已停。
5. **Super Agent所有权**：GitHub评论不授权，outbox标记+id核对回声和未知发送；WorkItem终态无出边，迟到事件只作上下文，后续已授权工作新建follows关联项；所有状态转换CAS。资源协调不冒充已有模块，解析不增加MediaJob kind。

## 6. 验证与未验证边界

文档自检：在仓库根运行 `node docs/research/check-2026-11-16-plan.mjs`，核对文件、链接、固定SHA、任务引用/依赖环和故障编号；新增阶段独立性检查，拒绝评测基线依赖云端/导入链、X12依赖D09/F39、C11起草依赖X11。再运行 `git diff --check`；具体命令输出写在PR。

这些检查只证明提案内部一致，不能证明模型质量、真实费用、Windows取消、迁移恢复或语音效果。实际实施必须附对应命令、输出、构建SHA和设备/服务版本；上游SDK文档中的支持项仍待本机资格试验。
