# 站外补查：DeepSeek 原案、官方工程文章与作者实践

2026-11-05 · X-38 · 林离 · 对 #207 初版的纠正与补充

## 先纠正范围与结论

上一轮并非只读 GitHub：OpenAI/Anthropic 的工程文章、官方产品页和 Manus 产品页已进入报告。但整体仍以仓库为主，独立作者的设计论证、近期产品变化、社交首发检索不足。更关键的是，我把用户所指的 DeepSeek 官方 Super-agent 方案，主要按项目内汐的提案去检索，导致漏掉明确存在的官方原文。这是检索对象判断错误，不是原文不存在。

本轮已通过 Browser Use 读到 [DeepSeek 认证机构账号的中文原文](https://zhuanlan.zhihu.com/p/2099987320443237060)，首次发布为北京时间 2026-10-31 22:55，另核对了 [DeepSeek Harness 官方 X 帖](https://x.com/DeepSeekHarness/status/2116857257245987236)，发布时间为北京时间 2026-11-01 19:37，正文标明是中文文章的机器翻译。普通网页抓取对两站曾返回 403；浏览器能读公开文章，但旧的 X /i/article 路径仍跳登录。没有登录，也没有把转载页冒充原始来源。

本轮补充 **20 项一手站外来源**（其中两项是同一 DeepSeek 文章的中英文入口，不算两份独立证据），另读 DeepSeek 原型的六份领域/设计/部署文档和三个实现文件。原型固定到 [8c32a9d](https://github.com/deepseek-ai/dsh-superagent-prototype/tree/8c32a9dc5d72c033816c6a8110b37f40cf94fba4)。合计仓库覆盖从 32 增至 33；不宣称已遍历每家公司的所有社交动态或看过视频访谈。

## DeepSeek：哪些已确认，哪些尚不能声称实现

| 证据层 | 已确认的内容 | 不能推导的结论 |
|---|---|---|
| 官方文章第2—6节 | 交互协调与隔离执行分层；事件路由；异步多渠道；计算/状态/环境分离；独立监督 | 五部分全部已经向公众开放 |
| 官方文章第4.1节 | 异步任务机制已在 Harness 实现，但尚未默认开启 | 当前本机版本可以直接用该机制 |
| 官方文章第7节 | 合成消息与模拟工作耗时下的调度实验；每方案5次 | 真实修复正确率、生产稳定性或本项目收益已证明 |
| 官方文章结语与原型README | 内部实例运行；公开代码只实现部分设计，经过公开适配，是研究原型 | 它等同内部实现、正式产品或可直接生产部署 |
| 原型代码/文档 | 明确的准入策略、任务授权、上下文订阅、工作分派和持久发送记录 | 任务目录、账号包装器或提示词就是操作系统沙箱 |

文章中约300条消息仅约20条工作请求，编码由耗时工具模拟；p50/p95是调度完成时间，不是代码质量指标。Router 压测还使用 mock Worker。本文不引用其相对提升数字作为接入收益承诺。本文中的工程取舍是本项目建议，不是 DeepSeek 对我们的背书。

## 原型中可以落地的机制与必要修正

下列事实来自固定版本的 [领域模型](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/docs/001-domain.md)、[授权](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/docs/002-authorization.md)、[执行](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/docs/003-execution.md)、[架构](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/docs/007-architecture.md)与对应实现；均为静态核对，未运行原型。

1. **路由不是包办所有计划。** Router 维护跨任务连续性、接活和对外回复，Worker 处理具体任务；已有 Thread 的后续消息可直接交给负责它的 Worker。项目因此把交互路由与目标内部规划拆开，避免所有工具过程重新塞回总会话。
2. **能看见不等于能接受命令。** Subscription 只提供上下文，Mandate 说明为什么允许这项工作。新候选走准入，范围内后续输入直接续办，超范围退回。项目把这些语义落到已有目标授权与新事件契约，不简单复制同名表。
3. **主动工作先可观察。** 原型的 off / observe / auto 区分主动推断与明确请求。项目先记录建议动作与是否值得做，检验误触发/通知噪声后再对特定规则开启自动处理。用户已明确授权的工作不被 observe 阻塞。
4. **让控制输入始终可达。** 原型用异步 shell、后台任务和控制输入优先级维持响应。项目采用独立的接收/取消路径与持久 inbox；执行资源饱和不应阻塞停止与修改目标，不直接复制其秒数、并发额外槽和 tmux 假设。
5. **发送有状态，但不能承诺网络恰好一次。** [outbox.ts](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/app/outbox.ts)在本地事务中记发送意图，外部发送后再 settle。两步之间崩溃仍有未知窗口。项目保留外部查询/幂等键或 unknown 人工核对，不盲目重发评论。
6. **授权撤销与终态更严格。** 原型可重新打开结束 Ticket，且一些授权变化只通知活跃任务、恢复前才强制核验。项目保留原 Run 终态，新的后续工作对应新 Attempt/必要时新目标修订；下一次动作检查当前授权，过期事件不能重新开始已取消工作。
7. **不复制全权限或自动合并。** 原型部署文档明确用操作员 OS 身份和 danger-full-access；命令包装器可被绝对路径绕过，合并条件部分属于提示词。项目继续使用节点能力与作用域授权，不能把工具名拦截当沙箱；仍由江浩合并。
8. **独立监测，不给第二个万能 Agent。** 先程序发现无进展/丢租约/取消未确认，再按需用模型解释证据。监测输出不得修改验收器或自行解除暂停；异常恢复必须经过同一执行用例。

原型的 [src/app/sessions.ts](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/app/sessions.ts)与 [src/core/engine.ts](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/core/engine.ts)也被读取用于核对角色工具与事件命令。其整个依赖树、数据库并发及 Windows 兼容性没有在本轮审计或验证。

## 其他方案的站外补充

以下每项均区分“作者/供应方主张”与“本项目决定”；不把官方博客当独立性能评测。

| 来源 | 站外新信息及其对方案的影响 |
|---|---|
| [DeepSeek Harness 产品与文档入口](https://www.deepseek.com/harness/)（访问于2026-11-05） | 公开预览和 Windows 下载存在，不证明 Super-agent 插件的本机适配 |
| [OpenAI Harness engineering](https://openai.com/index/harness-engineering/)（2026-02-11） | 知识目录、可执行架构约束、可被 Agent 观察的 UI/日志/测试环境 |
| [OpenAI Agents SDK 新能力](https://openai.com/index/the-next-evolution-of-the-agents-sdk/)（2026-04-15） | harness 与受控执行环境的组合；不能推断 TS 与 Python 同步或复用订阅认证 |
| [Anthropic Claude Duet](https://claude.com/resources/articles/claude-duet)（访问于2026-11-05） | 研究预览；持续入口、离线后台工作、关注事项通知 |
| [Anthropic 上下文工程](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)（2025-09-29） | 按任务选择压缩、结构化笔记、子任务隔离 |
| [Anthropic 高级工具使用](https://www.anthropic.com/research/advanced-tool-use)（2025-11-24） | 按需工具发现与程序化调用；不全量塞入工具描述 |
| [Manus 上下文工程经验](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)（2025-07-18） | 稳定前缀、确定性序列化、文件化上下文与失败信息；不照抄旧价格 |
| [LangChain 新上下文挑战](https://www.langchain.com/blog/context-engineering-challenges-late-2026)（2026-11-02） | 主动但不扰人、异步回流、记忆选择和目标偏离仍需评测 |
| [Pi 作者的最小 Agent 设计](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/)（2025-11-30） | 极简核心可借；跨厂商历史转换是尽力而为，YOLO 与 tmux 假设不采用 |
| [Pi 作者的项目归属更新](https://mariozechner.at/posts/2026-04-08-ive-sold-out/)（2026-04-08） | 核心 MIT、仓库迁移；未来附加产品不能一概按核心许可判断 |
| [Superpowers 作者的7.0回顾](https://blog.fsck.com/2026/10/09/what-a-year/)（2026-10-09） | 明确目标时减少流程阻力；按模型变化调整方法，而非固化仪式 |
| [Letta Agents SDK](https://www.letta.com/blog/introducing-the-letta-agent-sdk/)（2026-08-17） | 本地/自托管/云端状态后端；把 Letta 从纯记忆参考提升为后续有状态执行器备选 |
| [Letta 生产记忆评测](https://www.letta.com/blog/evaluating-memory-in-production-agents/)（2026-07-28） | 分别测记忆使用与生成；私有任务和 LLM 判分不能当本项目模型排名 |
| [Letta Mods](https://www.letta.com/blog/introducing-mods/)（2026-06-24） | 自适应 harness 有价值；这里只允许形成版本化建议，不默认热改控制面 |
| [Cline SDK 重构经验](https://cline.bot/blog/introducing-cline-sdk-the-upgraded-agent-runtime)（2026-05-13） | 运行时从 UI 解耦；TypeScript SDK 升为自定义执行器候选，需独立验证 |
| [OpenHands SDK 设计](https://www.openhands.dev/blog/introducing-the-openhands-software-agent-sdk)（2025-11-05） | 嵌入式工作流、会话持久化、本地/远端工作空间 |
| [OpenHands Verification Stack](https://www.openhands.dev/blog/20260506-the-verification-stack)（2026-06-22） | 轨迹级复核与仓库审查/QA分层；critic不能代替实际验证 |
| [Cursor 多 Agent 长期实验](https://cursor.com/blog/scaling-agents)（2026-01-14） | 角色分离和过度协调的代价；大规模实验不等于个人项目应启数百worker |

来源的读取方式和日期记录在 [站外来源索引](2026-11-05-web-sources.json)。此前已深入的 DeerFlow 实现、协议 SDK 与各类检索/评测项目仍沿用 [首轮报告](2026-11-05-agent-ecosystem.md)；没有新增独立站外证据的项目不冒称补查完成，也不因没有博客就排除。

## 需要改变的架构判断

**提前事件基础，后置持续部署。** 原路线图把定时/多渠道笼统放在最后，容易让首版目标体系仍然绑定单次对话。现在把事件身份、归属、订阅、异步结果回流与通知策略提前到阶段1—2；真正的独立后台进程、云端状态、手机/IM多入口仍在阶段5立项。先在当前桌面生命周期内完成 GitHub 后续评论与 CI 事件的接续，不能宣称关机仍工作。

**既比较质量，也比较注意力成本。** 原基准主要看交付成功、误报与恢复；新增任务处理中修改方向、事件重复/乱序、审批等待时到达结果、未授权评论、bot回声、通知重复等场景。记录有用通知比例、漏掉必须处理事项、停止响应、人工转述次数、Router调用量；合成调度与真实交付分别报告。

**运行时候选扩展，但不增加并行接入负担。** Cline 的 TypeScript SDK 和 Letta 的有状态 SDK 都比“只借 UI / 记忆概念”更值得做后续候选。它们可与 Pi / DeepAgents / Agents SDK 参加同一个受限 spike，仍然一次只选一个 API/harness。现有 Codex app-server 第一试点不因博客榜单改动；DeepSeek Harness 作为原生运行时能力清点的一部分。

**上下文可复用，授权不可被缓存掩盖。** Manus 的稳定前缀和追加历史适合减少重复；工具发现按需加载适合限制上下文。两者有张力，不硬套一个统一方案：记录运行时工具集与策略版本，在提供方支持的方式下测效果。策略撤销、来源变更和权限收紧必须使缓存/摘要失效；不能为了缓存命中继续使用旧授权。

**学习要可回退。** Letta 的 Mods 展示运行时适应方向，但我们不让 Agent 热改控制面和验收标准。先从真实失败形成有来源的技能/记忆候选，在留出任务上验证后再激活版本，保留撤回与回归路径。记忆基准新增“取回正确事实”和“生成/清理正确记忆”两类，不用一家私有评分榜决定默认模型。

**规划职责与执行能力分离，比组织层级更重要。** Cursor 实验展示扁平协作、锁与协调角色都可能产生瓶颈，不能只学其并发规模。项目维持小并发与显式资源所有权；UI 和部署可替换，业务状态所有权不变。OpenAI、Cline 和 OpenHands 的经验共同支持可观察环境、独立运行时与分层验收，但不要求立刻把桌面改成云平台。

## 本轮落实与边界

- ADR-007 已替换“原提案未找到”，加入正式原文对照、事件路由和监督边界。
- 候选任务增加事件契约、输入/通知队列、GitHub Source、待处理事项、故障与注意力评测；没有增加自动合并或全权限运行要求。
- 补充研究作为 #207 的后续提交，保留初版历史与本轮纠正说明；PR 描述也同步更新，避免旧结论留在入口。
- 本轮没有运行原型、接入社交账号、创建监控任务或安装插件。公开文章与源码提供设计证据，运行结果仍需后续实际验证。
