# Agent 生态调研与项目取舍（2026-11-05）

作者：林离（Codex） · 任务：X-38 · 基线：main dd3f7d3（#205、#206 已合并）

> 补查更新：DeepSeek 官方原文已找到，初版检索对象判断错误已纠正。新增20项站外一手来源、官方原型与架构修订，见 [站外补充研究](2026-11-05-web-supplement.md)。首轮32个仓库的记录保留，来源索引现共33项。

## 结论

建议把项目从「多 Agent 协同评审室」逐步扩展为「本地优先、跨模型、交付可验证成果的个人工作台」。保留聊天、人格、讨论、资料与记忆，新增以目标为入口的工作流；Super Agent 是持续负责目标的协调角色。它可以委派任务，但任务状态、授权和验收由确定性控制面掌握。

优先做一个能从研究结论推进到代码修改、验证和 PR 的闭环。不要同时移植 DeerFlow、LangGraph、OpenHands、Letta 的全局调度与记忆系统。研究中最有价值的共同点是可恢复状态、清楚的工具边界、上下文管理和可检查成果，并非更多人格或更长提示词。

具体设计见 [ADR-007](../design/ADR-007-Super-Agent-工作台.md)，分工与验收见 [Phase 2 候选任务](../phase2-候选任务.md)。这些是提案，当前 Phase 1B 和冻结契约并未被本文件自动替代。

## 调研范围与证据边界

- 通过 GitHub REST 核对 32 个仓库的当前地址、提交、归档状态和 README；记录在 [来源索引](2026-11-05-agent-sources.json)。链接固定到本次读取的 SHA，避免未来主分支变化让判断失去依据。
- 对选定项目进一步读取 16 份实现、架构或 LICENSE 文件；另一次 Beads 架构文档路径读取失败，因此 Beads 的判断只基于已取得的 README，不能当完整源码评审。
- 同时读取官方产品页、OpenAI 与 Anthropic 工程文章及协议文档。商业功能表述来自供应方，不代表本机体验或第三方评测。
- 未安装这些框架、未执行上游代码、未跑跨模型基准；没有以 star 数或营销成功率作为架构决策依据。许可证字段只是初筛，实际复用时按所用目录与版本复核。
- 初版只在项目记录中寻找 DeepSeek 的 Super Agent 提案，误把官方团队方案当成项目内方案。补查已核对 [官方中文原文](https://zhuanlan.zhihu.com/p/2099987320443237060) 与 [X 译文](https://x.com/DeepSeekHarness/status/2116857257245987236)，并按原型对照更新 ADR；检索过程与架构变化见补充研究。

## 市场产品：借交互与交付流程，不照搬云服务边界

| 产品 / 官方来源 | 值得吸收 | 对本项目的调整 |
|---|---|---|
| [Claude / Cowork](https://claude.com/product/cowork) | 围绕文件和工具开展工作，过程中可继续引导 | 用目标、进度和成果承接任务；聊天仍是控制入口，执行详情可展开 |
| [ChatGPT Work](https://openai.com/chatgpt-work/) | 工作上下文、产物和后续工作衔接 | 项目资料可复用，但每次执行生成可追溯的上下文清单 |
| [Workspace agents](https://openai.com/business/workspace-agents/) | 可复用、可治理的工作流程 | 先做个人任务模板与授权范围，不提前搭建企业多租户系统 |
| [Manus](https://manus.im/features) | Wide Research、云端计算机、连接器和多种成果 | 研究任务可并行；文件、网页、代码成果采用统一验收入口，云端节点只是可选执行位置 |
| [Cherry Studio](https://github.com/CherryHQ/cherry-studio) / [Dify](https://github.com/langgenius/dify) | 多模型资料管理 / 工作流编辑与发布 | 前者借交互，后者借可视化表达；不默认继承其代码许可、运行栈或服务边界 |

这里的机会是把现有的跨模型讨论、个人身份和本地数据，连接到实际交付。第一版主界面不需要暴露 DAG、lease、SDK 等实现术语：用户主要看到「目标、正在做什么、需要关注什么、成果和验证」。开发者诊断中再呈现节点、事件与调用明细。

## GitHub 筛选矩阵

表中许可证是 GitHub 元数据初筛；特殊情况在后文说明。每行 README 都固定到本次获取的提交。标注「参考」不意味着接入依赖。

| 仓库（固定版本） | 许可初筛 | 采用层级 | 取舍 |
|---|---|---|---|
| [openai/codex](https://github.com/openai/codex/blob/e7f32cf1928a35a9232a633a51c2a03b5a7e2c72/README.md) | Apache-2.0 | 运行时首选试点 | 用 app-server 的线程、turn、审批事件替换纯文本接入；先只读，验证 Windows 与断线恢复 |
| [openai/openai-agents-js](https://github.com/openai/openai-agents-js/blob/35b24d72e525f08a0862ccb05de909d619198aae/README.md) | MIT | 编排参考 | manager-as-tool 和可序列化 RunState；不再引入第二套全局任务账本 |
| [anthropics/claude-agent-sdk-python](https://github.com/anthropics/claude-agent-sdk-python/blob/3be907edb9c86269d30d1427a77937dd788d6419/README.md) | MIT | 第二运行时参考 | 权限回调、hooks、session；项目优先考察 TypeScript 接口，Python 源码用于理解边界 |
| [anthropics/claude-quickstarts](https://github.com/anthropics/claude-quickstarts/blob/8ef47d719eba5379ff8f38133f5defcc499e856f/README.md) | MIT | 长任务方法 | initializer + 增量执行 + 可检查进度；旧示例 API 不能直接复制 |
| [anthropics/skills](https://github.com/anthropics/skills/blob/ca45fc496a3436251f191354091d557da31c15b5/README.md) | 未标明 | 技能格式参考 | 按需加载、固定版本；文档类 skills 并非统一开源许可 |
| [modelcontextprotocol/typescript-sdk](https://github.com/modelcontextprotocol/typescript-sdk/blob/1e608caeb5130b2ad0fa067c84b26a038c1c6e36/README.md) | NOASSERTION | 工具协议候选 | 工具发现与调用；当前 v2 已稳定，升级必须单独兼容性测试 |
| [agentclientprotocol/agent-client-protocol](https://github.com/agentclientprotocol/agent-client-protocol/blob/734309dc6ff8f5a3b93adca62826dd63cff85a26/README.md) | Apache-2.0 | 宿主协议候选 | 统一宿主与编码 Agent 会话；不能替代业务任务状态 |
| [a2aproject/A2A](https://github.com/a2aproject/A2A/blob/4735f4876449c6f381825d8a841b31b16c6ad0c4/README.md) | Apache-2.0 | 跨系统后置 | 异构 Agent 互操作；单机首版不需要同时实现 ACP 与 A2A |
| [microsoft/agent-framework](https://github.com/microsoft/agent-framework/blob/230a3aa0bba19b6bf5a7b4f427bcb25cb16c7105/README.md) | MIT | 设计参考 | 工作流检查点与可观测性；不为框架重写现有 TypeScript 控制面 |
| [google/adk-python](https://github.com/google/adk-python/blob/0192edd395986c6cc1a92ea9321be21ed32f0cfa/README.md) | Apache-2.0 | 设计参考 | 工作流与任务建模；Python 示例不是本项目的默认依赖 |
| [langchain-ai/deepagents](https://github.com/langchain-ai/deepagents/blob/5ed6d1c32f060143070b32826f87d2f83e569088/README.md) | MIT | 候选轻量 harness | 上下文隔离、文件与子任务；与其他 harness 择一验证 |
| [langchain-ai/langgraphjs](https://github.com/langchain-ai/langgraphjs/blob/6c7eefbc3d985664370cfbcd9786888a642fa23a/README.md) | MIT | 节点内可选 | 需要复杂图执行时才用；不与 SQLite 同时掌管全局终态 |
| [earendil-works/pi](https://github.com/earendil-works/pi/blob/5f6198c397936e90b0847dd620a62741ac984d34/README.md) | MIT | 轻量运行时备选 | RPC、树形会话与追加式压缩；可借机制，不强推替换 Codex |
| [anomalyco/opencode](https://github.com/anomalyco/opencode/blob/42be645ad71cd072398ef5f8053986c438512779/README.md) | MIT | 交互参考 | 计划与执行角色、可配置权限；权限仍由本项目控制面约束 |
| [aaif-goose/goose](https://github.com/aaif-goose/goose/blob/bfe8ccd23de1d2c47a4cb2970d522f093ae7f2ba/README.md) | Apache-2.0 | 桌面工具参考 | 多提供方、MCP/ACP；核对认证与平台能力后再接入 |
| [OpenHands/software-agent-sdk](https://github.com/OpenHands/software-agent-sdk/blob/28f4dfeeec4473060873185d301495d1c3743947/README.md) | MIT | 独立重型节点候选 | 工作区、事件、编码执行环境；不把整个 Python 服务嵌入桌面 |
| [cline/cline](https://github.com/cline/cline/blob/d3ecc4890e8f9bcb77182b96c77fa90575e8e145/README.md) | Apache-2.0 | 产品与执行参考 | CLI/IDE/桌面共享核心、工具审阅；不复制整个客户端 |
| [Aider-AI/aider](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/README.md) | Apache-2.0 | 代码上下文参考 | 有 token 预算的 repo map；只能定位证据，不能代替原文核验 |
| [obra/superpowers](https://github.com/obra/superpowers/blob/22f0b463e7a5e579904dd6211a520321035526f7/README.md) | MIT | 开发流程吸收 | 根因分析、分步实现、验证与复核；按任务风险使用，不安装整套强制流程 |
| [open-gsd/gsd-core](https://github.com/open-gsd/gsd-core/blob/d47f196d1c65998f258f3409d57ed82f1a779184/README.md) | MIT | 交接流程吸收 | 阶段记录、新上下文交接、结果验收；不把所有默认开关当授权 |
| [gastownhall/beads](https://github.com/gastownhall/beads/blob/6d713a74849f6168f5bbe973e0bfde64cfae8393/README.md) | MIT | 任务图吸收 | 依赖、原子认领与持久任务；当前基于 Dolt，不引入第二数据库 |
| [gastownhall/gastown](https://github.com/gastownhall/gastown/blob/466aa41c83ee73b1fa0eb79eb9d172fb1eca9476/README.md) | MIT | 组织模式后置 | 分派、回执、监督；不默认运行多层角色与大量 worker |
| [BloopAI/vibe-kanban](https://github.com/BloopAI/vibe-kanban/blob/08064e043c2d78ad123b473257ed867e7ce74768/README.md) | Apache-2.0 | 仅 UX 参考 | 看板、并行工作区与审阅；README 宣布停止发展，不作为新核心依赖 |
| [bytedance/deer-flow](https://github.com/bytedance/deer-flow/blob/4a53a36e32a7245e4ac2d5e80115ce7e31f8bd6c/README.md) | MIT | 最接近目标的参考 | Super Agent、子任务租约与报告契约；借控制机制，重型部署仅作为可选节点 |
| [langfuse/langfuse](https://github.com/langfuse/langfuse/blob/e5d4e9e5c83a0c01574cc84a31814be5abc9b196/README.md) | NOASSERTION | 观测可选导出 | 本地 trace 为准；外部平台失效不能阻塞任务，ee 目录另有许可 |
| [promptfoo/promptfoo](https://github.com/promptfoo/promptfoo/blob/e3e2bb871540ae153a630878ecb17e56cfb487e3/README.md) | MIT | 评测候选 | 固定数据集、断言、回归；调用真实模型的费用与数据出口仍需配置 |
| [mem0ai/mem0](https://github.com/mem0ai/mem0/blob/ed1f10fc87080f0b67f99be370817504888462ab/README.md) | Apache-2.0 | 记忆研究参考 | 检索与整合思想；不把托管产品基准当开源实现表现，不默认信任生成记忆 |
| [letta-ai/letta](https://github.com/letta-ai/letta/blob/8816d3a8516893bfdc0fa14bfb1235226012e295/README.md) | Apache-2.0 | 迁移线索 | 当前 README 指向 letta-code；旧 server 不能当最新默认方案 |
| [CherryHQ/cherry-studio](https://github.com/CherryHQ/cherry-studio/blob/abafc6f1212b0c0ff431c6cab21833d92f84ad56/README.md) | AGPL-3.0 | 产品 UX 参考 | 多模型、资料与 Agent 管理；AGPL 代码不直接并入当前闭源边界 |
| [langgenius/dify](https://github.com/langgenius/dify/blob/e1bca6369bddf6f69a720548bf1aea871ae26911/README.md) | NOASSERTION | 工作流 UX 参考 | 可视化节点、知识库与发布；附加许可与服务栈成本不适合作默认内核 |
| [openclaw/openclaw](https://github.com/openclaw/openclaw/blob/af7ea2ba51a906fe2e6e2dd6b7ad0ba101ba1a83/README.md) | MIT | 长期助手参考 | 本地 gateway、渠道、心跳与身份；事件缺口需刷新，不等同本项目序号回放 |
| [letta-ai/letta-code](https://github.com/letta-ai/letta-code/blob/ee6e2c588082cbd98d8db1e20b18096585afa5bf/README.md) | Apache-2.0 | 记忆连续性参考 | MemFS、分层 skills、持续身份；Cloud 默认与原生 Windows 自动反思限制需显式核对 |

## 深读后真正应该整合的机制

### 1. 官方运行时协议，优于不断扩展 CLI 输出解析

[Codex app-server 文档](https://github.com/openai/codex/blob/e7f32cf1928a35a9232a633a51c2a03b5a7e2c72/codex-rs/app-server/README.md)与[官方平台说明](https://developers.openai.com/blog/codex-as-a-platform)给出了线程、turn、事件和审批交互方向。它更适合工作台，但并不自动提供本项目的任务级交付保证。优先以单运行时只读任务验证：事件完整性、工具呈现、取消、恢复、Windows 启动及版本兼容。当前 codex-exec-json 文本解析保留为聊天路径，不在无法表达审批的旧协议上伪装支持自动执行。

### 2. Super Agent 负责协调；控制面负责事实

[OpenAI 编排文档](https://developers.openai.com/api/docs/guides/agents/orchestration)区分 manager 调工具与 handoff 转移控制。项目选择前者作为默认：目标负责人保留任务所有权，子执行者返回结构化回执。只有明确的用户会话切换才使用 handoff。

[Agents JS RunState](https://github.com/openai/openai-agents-js/blob/35b24d72e525f08a0862ccb05de909d619198aae/packages/agents-core/src/runState.ts)包含序列化版本与恢复状态。启示不是把整个状态对象写入现有表即可，而是需要持久化版本、迁移和恢复验证；模型 SDK 状态只属于 Attempt，不替代业务任务与审批账本。

### 3. DeerFlow 最值得借的是租约、回执和项目隔离

[DeerFlow 架构](https://github.com/bytedance/deer-flow/blob/4a53a36e32a7245e4ac2d5e80115ce7e31f8bd6c/backend/docs/ARCHITECTURE.md)、[lead agent](https://github.com/bytedance/deer-flow/blob/4a53a36e32a7245e4ac2d5e80115ce7e31f8bd6c/backend/packages/harness/deerflow/agents/lead_agent/agent.py)、[batch lease](https://github.com/bytedance/deer-flow/blob/4a53a36e32a7245e4ac2d5e80115ce7e31f8bd6c/backend/packages/harness/deerflow/subagents/batch_lease.py)及[report contract](https://github.com/bytedance/deer-flow/blob/4a53a36e32a7245e4ac2d5e80115ce7e31f8bd6c/backend/packages/harness/deerflow/subagents/report_contract.py)展示了比「写一个总指挥提示词」更多的工程工作：项目上下文来源、租约归属、取消清理、报告与证据句柄。

落地为本项目的不可变尝试记录、版本化输入、工具回执和独立验收。Agent 的“成功”只进入待验收状态。不要承诺外部操作 exactly-once：网络断开后创建 PR 是否成功可能未知，需要查询协调，不能盲目重发。DeerFlow 2.0 是一次重写，当前默认 Gateway 内嵌 LangGraph runtime，不能沿用旧部署图来估算接入成本。

### 4. 会话历史与模型上下文分开

[Pi session manager](https://github.com/earendil-works/pi/blob/5f6198c397936e90b0847dd620a62741ac984d34/packages/coding-agent/src/core/session-manager.ts)保留带 parentId 的历史条目与压缩记录；[Anthropic managed agents](https://www.anthropic.com/research/managed-agents)也强调会话、harness 和执行环境分离。项目可以维护完整审计历史，但给每次运行只提供足够的上下文。摘要是派生视图，不是把原始证据删除后留下的唯一事实。

[Letta Code](https://github.com/letta-ai/letta-code/blob/ee6e2c588082cbd98d8db1e20b18096585afa5bf/README.md)的 MemFS、身份连续性和按层加载 skills 值得借鉴；不把自主重写系统提示词和记忆直接作为默认功能。当前 README 明确 Cloud 为默认，并注明原生 Windows 自动反思默认关闭；不能宣称已适配本项目的本地长期记忆。

### 5. 子 Agent 隔离要同时覆盖上下文与权限

[DeepAgents 子任务实现](https://github.com/langchain-ai/deepagents/blob/5ed6d1c32f060143070b32826f87d2f83e569088/libs/deepagents/deepagents/middleware/subagents.py)值得借鉴的包括结构化结果、上下文分离和递归控制。隔离上下文不等于隔离系统权限。项目另加确定性约束：子任务权限必须是父授权与运行时能力的交集；角色提示词不能授予工具能力。

[Claude SDK client](https://github.com/anthropics/claude-agent-sdk-python/blob/3be907edb9c86269d30d1427a77937dd788d6419/src/claude_agent_sdk/client.py)提供权限回调与会话控制，但[官方权限文档](https://code.claude.com/docs/en/agent-sdk/permissions)中允许自动审批的工具列表，不等于唯一可用工具列表。接入要分别验证工具暴露、拒绝策略、交互审批和取消；不能只配一个 allowed_tools 就声称隔离完成。

### 6. 任务图与交接流程可以吸收，数据库与角色层级不必照搬

Beads 的依赖与认领、Gastown 的回执/监督、[GSD 架构](https://github.com/open-gsd/gsd-core/blob/d47f196d1c65998f258f3409d57ed82f1a779184/docs/ARCHITECTURE.md)的阶段记录与新上下文交接、Superpowers 的根因和验证流程，可以拆成项目自己的小功能。任务仍在 SQLite 事务中推进；默认一个执行者，按需要增加独立研究或复核，不把 Mayor/worker 等整套组织结构搬进个人工作台。

尤其不采用「未配置即启用」作为工具授权原则，也不强制每个微小文案修改都开启多 Agent、worktree 和完整测试。并行是可测量的优化，不是产品默认的成本放大器。

### 7. 代码地图、知识检索与记忆有不同职责

[Aider repo map](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/repomap.py)展示有 token 预算的代码定位；适合帮助找到定义和依赖，不代替读取真正要修改的文件。项目资料检索先建中文查询样本，比较现有 literal search、FTS 与混合检索后再决定；不能仅因为开源框架带向量库就引入一套服务。

Mem0 的公开基准不能直接归于开源版本，更不能把模型生成记忆当经过核实的项目事实。个人偏好、项目知识和任务证据必须分作用域，保留出处、版本、撤销与可见性检查。

### 8. 长任务的关键是外部进度与真实验收

[Anthropic 长运行 harness](https://www.anthropic.com/research/effective-harnesses-for-long-running-agents)与[示例实现](https://github.com/anthropics/claude-quickstarts/blob/8ef47d719eba5379ff8f38133f5defcc499e856f/autonomous-coding/agent.py)说明仅靠压缩聊天不足以持续推进任务。项目应记录完成项、未完成项、工件和下一步，恢复后重新检查实际工作区；示例中的旧 SDK 导入不能未经迁移直接采用。

[Agent evals](https://www.anthropic.com/research/demystifying-evals-for-ai-agents)强调结果与多次试验；[多 Agent 研究系统](https://www.anthropic.com/research/multi-agent-research-system)的收益主要来自可独立探索的研究任务，不能推断所有编码工作都应多 Agent。路线图因此先建立冻结任务集，再比较单执行者与带复核/并行的方案。

## 与当前项目的实际差距

| 现有基础 | 本次核对到的缺口 | 迭代动作 |
|---|---|---|
| Run / Round / Plan / Approval 与不可变 Snapshot | 缺少跨多次 Run 的目标与验收闭环 | 增量新增任务与成果契约，Attempt 引用原 Run，保留原状态机 |
| 远端适配器、事件序号与租约 | remote adapter 声明 permissionRequests=false；permission_request 被忽略；服务端权限路由返回 501 | 新能力协商和审批回传先单独做契约与运行时试点 |
| Codex JSONL 文本解析 | 工具/命令条目未成为完整执行证据 | 新适配器保留结构化事件；退出码与自然语言都不能单独判成功 |
| v24 pending intent 与恢复机制 | 已有局部事务恢复经验，但不等于通用外部动作可靠调度 | 借鉴事务意图，设计 outbox、回执与未知结果协调 |
| X-37 workspace、搜索、导出与恢复 | workspace 是只读聚合，不是任务调度器；搜索未等同语义检索 | UI 渐进加入目标/成果入口，检索以中文样本效果决定 |
| 多 persona 与记忆上下文 | 人格与执行权限容易混淆 | Persona 管表达和偏好，运行时能力与权限由控制面核验 |

代码依据：

- [remote adapter](../../packages/remote-client/src/http-remote-adapter.ts)
- [agent-server 路由](../../apps/agent-server/src/server.ts) 与 [聊天配置约束](../../apps/agent-server/src/config.ts)
- [Codex parser](../../apps/agent-server/src/parsers/codex-exec-json.ts)
- [v24 migration](../../packages/db/src/schema-v24.ts)
- [ADR-001](../design/ADR-001-远端执行节点.md)

目前聊天配置主动限制工具，是现有安全边界，不能简单解除限制冒充完成 Super Agent。执行型运行时需要独立能力声明与作用域授权。

## 维护与许可改变了筛选结果

- Pi、Goose、GSD、Beads、Gastown 有仓库迁移/重定向。索引同时保留 requested 与实际 repo，避免引用已经过时的归属。
- Vibe Kanban 的 archived=false 不能代表仍值得依赖；其 README 已宣布 sunsetting。产品状态需要读正文，不能只看 GitHub 的布尔字段。
- MCP TypeScript SDK 当前主分支是 v2 稳定版，LICENSE 包含新旧代码与文档的不同条款；不能按旧版 MIT 或 v2 alpha 的印象集成。
- Anthropic skills 不能整仓假定 Apache-2.0；文档类技能有 source-available 条款。Langfuse 的 ee 目录另有条款。Cherry Studio 为 AGPL-3.0，Dify 有附加条件。当前 PR 只写调研结论，不复制这些实现。
- Letta 主仓库 README 已转向 Letta Code，不能拿旧 server 架构当最新产品。promptfoo 已归属 OpenAI，Langfuse 已归属 ClickHouse；这次按现状记录，不再笼统称它们为独立私人团队。
- 公共 API、CLI 订阅认证、工具权限、模型费用不是同一能力。跨模型支持必须逐提供方验证，不能推断登录了聊天产品就能自动调用所有 SDK。

## 决策与不采用项

推荐顺序是：现有系统真机验收 → 目标/成果/事件与评测基线 → 一个执行运行时与消息接续 → 第二运行时与独立复核 → 项目知识/固定技能 → 有明确需求才做后台常驻与多设备。

第一条交付链为「研究目标 → 引用与决策 → 实现任务 → 独立工作区 → 验证结果 → PR/工件」。这与用户现有使用方式一致，也能直接检查模型是否真的完成工作。后续再扩展文档、表格、网页操作、ComfyUI 等不同节点；GPU、浏览器、工作区分别有资源锁和取消语义。

暂不采用：全量重写、默认多 Agent 层级、自动下载任意技能、把本地工具接口直接暴露公网、用向量库替代证据系统、仅因框架可用就新增微服务。自改提示词/技能只能产生有版本的建议，经过验证和既有授权边界再激活。

上游实现只提供设计证据，不证明本项目已获得相同能力。最终是否接入，以候选任务中的 Windows 实测、故障注入、权限边界、成果正确率和维护成本为准。
