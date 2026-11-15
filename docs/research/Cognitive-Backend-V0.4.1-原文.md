# Cognitive Backend V0.4.1 原文转录

> 用户于 2026-11-15 提供的参考材料，供 X-39 / ADR-008 讨论。此文件按 DOCX 正文顺序转录，保留原文内容；排版、分页以 [原始 DOCX](sources/cognitive-backend-v0.4.1.docx) 为准。文内开工指令、冻结规则和技术结论属于参考材料，不自动成为本仓库的执行授权、已采纳决议或已验证结果。

- 原始文件名：`Cognitive_Backend_V0.4.1_情境召回_情感状态与长期连续性工程化架构-2.docx`
- 原始文件 SHA-256：`a6bd117c36eaeb55848f374b35bc6f59e349e3655d44b61aff4d7ee2c843fe36`
- 归档副本与用户提供文件逐字节一致；转录不补写作者、来源或验证结论。
- 用户在本次会话明确的范围及与本仓库的关系，见 [世界概念入口](世界-江浩的概念.md)。

---

人类认知后端架构 V0.4.1

Cognitive Backend — 情境召回、情感状态与长期连续性工程化架构

在 V0.4 持续主体与成长闭环基线上，将情境召回、证据验证、记忆生命周期、关系里程碑、情感状态与故障降级整理为可直接进入 MVP 编码的工程化规范。

| 项目项 | V0.4 决议 |
| --- | --- |
| 版本 | V0.4.1（V0.4 架构基线的工程细化版；补齐 Memory / Affect / Context / Evidence / Interface 编码边界） |
| 状态 | 核心架构稳定 / 工程接口与状态对象补齐 / 可进入 MVP 编码与回放测试 |
| 核心目标 | 把 V0.4 持续主体架构落实为“可召回、可验证、可更新、可降级、可回放”的工程系统 |
| 运行假设 | Windows 单机；约 12GB GPU 显存；本地常驻一个轻量 Observer；复杂认知与必要评价按需走 API |
| 验证原则 | 宁少勿假；Recall ≠ Verification ≠ Learning；NOW ≠ PAST；情绪推测 ≠ 关系事实；所有写入可追溯、可回滚 |

| 一句话定义： V0.3 解决“怎么持续存在”；V0.4 增加“怎么从经历中逐渐稳定地成为自己”：记忆会巩固、联想与衰减，认知与表达分离，行为结果被评价，经验进入可审计的学习闭环。 |
| --- |

## 目录与本版重点

- 1. V0.4.1 核心结论与 V0.4 → V0.4.1 工程化收敛

- 2. 项目目标、边界与工程原则

- 3. 总体架构：从持续 Runtime 到成长闭环

- 4. 三层执行模型：代码层 / 本地观察层 / API 认知层

- 5. World Engine：世界必须由代码推进

- 6. 双循环与双时钟：世界持续、认知稀疏

- 7. Event Bus：统一事件与因果链

- 8. Resident Observer：唯一常驻的小模型

- 9. Model Router：复杂认知统一按需调用 API

- 10. Judge Policy：只在高影响场景二次判断

- 11. Cognitive Core：Global Workspace、Drives、Self 与 Goals

- 12. Memory：事实语义、写入门控与开源适配

- 13. Memory Dynamics：编码、巩固、联想、衰减与重构

- 14. Relationship Ledger：关系成为可审计状态

- 15. 主动分享：从内部状态自然产生表达候选

- 16. Expression / Role Layer：决定什么与怎么说分离

- 17. Action Pipeline：Intent ≠ Action ≠ Result

- 18. Behavior Evaluator：评价“做得好不好”

- 19. Experience / Learning Loop：从结果沉淀可控经验

- 20. 存储、可靠性、回放与降级

- 21. 开源与外部思路融合地图

- 22. 建议仓库结构

- 23. V0.4.1 MVP 开发计划

- 24. 验证实验与观测指标

- 25. V0.4.1 架构决议

- 附录 A：第一阶段开工清单

- 附录 B：一次完整闭环示例

- 附录 C：关键数据结构草案

- 附录 D：资料来源与吸收边界

- 第二部分：V0.4.1 工程细化层（26–36）

- 附录 E：V0.4.1 早期方案吸收清单

| 本版最重要的推进： V0.3 已经把运行边界收敛为“本地负责连续性，API 负责智力”。V0.4 不改变这个底座，而是在其上增加 Memory Dynamics、Expression / Role Layer、Behavior Evaluator 与 Experience / Learning Loop，让系统能从长期经历中形成稳定、可审计的行为改进。 |
| --- |

## 1. V0.4.1 核心结论与 V0.4 → V0.4.1 工程化收敛

| V0.3 基线 | V0.4 新增/收敛 |
| --- | --- |
| 持续世界 + 连续主体 + 本地 Observer + API Cognition | 保留不动，仍是整个系统的 Runtime 基线 |
| Memory 重点在分层、候选写入、Reducer 与检索适配 | 新增 Memory Dynamics：Encoding / Consolidation / Association / Decay / Reconstruction |
| 复杂认知与自然语言表达均通过 Model Router | 把 Cognition 与 Expression 明确解耦：先决定“想表达什么”，再决定“怎么说” |
| Judge 主要负责高风险、高影响、冲突或低置信复核 | 新增 Behavior Evaluator：评价连续性、自然度、关系一致性、主动质量与目标一致性 |
| 行为结果写入事件与记忆，主要服务连续性 | 新增 Experience / Learning Loop：结果 → 评价 → 经验 → 策略/阈值/Prompt 调整 |
| 后训练仅作为远期可能性 | 短期明确不做完整 RLHF/PPO/GRPO；先积累真实评价数据，再决定 SFT/DPO/RM |
| 按任务复杂度使用本地/便宜 API/强模型 | 进一步明确动态认知等级 C0–C4，避免“所有事情都调用最强模型” |

| V0.4 完成标准： 系统不仅能持续运行和保持主体连续性，还能让记忆随经历巩固/联想/衰减，让表达保持身份一致，让行为结果被结构化评价，并把经过验证的经验反馈到策略、阈值和上下文构建中；任何学习都必须可追踪、可回滚，不能由模型私自改写 Self 或事实。 |
| --- |

## 2. 项目目标、边界与工程原则

### 2.1 目标

- 构建功能层面的“持续主体”：连续性来自 World State、Self State、Memory、Relationship、Goals、Commitments 与事件历史，而不是某个模型实例永远在线。

- 让世界、记忆、关系和行动具有清晰事实边界；模型输出只能作为解释、候选和行动意图。

- 把昂贵智力从“常驻”改成“按需调用”，让长期运行的成本主要来自轻量代码与本地小模型。

- 让主动性来自时间、状态、记忆联想、目标和关系张力的变化，而不是固定定时器模拟“像人”。

- 保持模块可替换：模型供应商、向量库、记忆组件、前端表现层都可以更换，不破坏主体连续性。

### 2.2 明确不做

- 不宣称模拟真实意识或证明主观体验；只做可验证的功能机制。

- 不让 LLM 推动时间、直接写世界事实、直接改关系数值或把推测升级成长期真值。

- 不在第一阶段本地同时部署多个 7B/14B/32B 模型；资源优先给稳定运行、持久化和一个轻量 Observer。

- 不先做复杂小游戏、Live2D 或视频壳；先验证没有前端也能运行的闭环。

- 不把“记得更多”误认为“记忆更好”；写入、检索、巩固、遗忘、冲突处理和事实版本必须分开设计。

| 连续性的工程定义： 同一主体 = 同一条可追溯事件历史 + 可版本化 Self/Relationship State + 连续 Memory + Goals/Commitments + 世界中的行动身份。模型可以替换，主体状态不能因模型替换而丢失。 |
| --- |

## 3. 总体架构：从持续 Runtime 到成长闭环

```text
外部现实 / 用户 / 文件 / 时钟 / Webhook / 互联网
                         │
                         ▼
                   [ World Engine ]
                 事实 / 时间 / 规则 / 资源
                         │ WorldEvent
                         ▼
                    [ Event Bus ]
                         │
                ┌────────┴────────┐
                ▼                 ▼
         [ Salience ]       [ Memory Recall ]
                └────────┬────────┘
                         ▼
                [ Global Workspace ]
                         │
                         ▼
             [ Resident Observer ]
              ignore / local / wake
                         │
                         ▼
                   [ Model Router ]
                         │
                    [ Cognition ]
               intent / plan / thought
                         │
             ┌───────────┴───────────┐
             ▼                       ▼
     [ Expression Layer ]      [ Action Proposal ]
             │                       │
             │               [ Action Validator ]
             │                       │
             └───────────┬───────────┘
                         ▼
                    [ Executor ]
                         │
             ActionResult / DeliveryStatus
                         │
              ┌──────────┴──────────┐
              ▼                     ▼
      [ Behavior Evaluator ]   [ Memory Dynamics ]
              │                     │
              └──────────┬──────────┘
                         ▼
              [ Experience / Learning ]
                         │
       policy / threshold / prompt / routing updates
                         │
                         └──────→ 下一轮认知
```

| 层 | 核心责任 | 是否拥有事实写权 |
| --- | --- | --- |
| World Engine | 时间、规则、事实状态、资源、行动结果、外部事件落地 | 是：仅通过受控代码路径 |
| Cognitive Core | 显著性、工作空间、内部状态、目标、Self、关系、唤醒策略 | 否：只产生候选和内部状态更新请求 |
| Resident Observer | 轻量理解、事件筛选、记忆候选、是否唤醒 API | 否 |
| Model Router / Cognition | 复杂理解、规划、反思、社会推断 | 否 |
| Expression / Role Layer | 把已存在的 intent 变成符合身份、关系和场景的表达 | 否 |
| Action Validator / Reducer | 前置条件、权限、事实一致性、关系/记忆写入门控 | 是：受控提交 |
| Behavior Evaluator | 评价行为与表达质量，不改写历史 | 否 |
| Experience / Learning | 把评价沉淀为可版本化策略、阈值、案例和训练数据 | 仅写经验层；不能直接重写事实/Self |

| 核心边界： “成长”不是模型偷偷修改自己。所有变化都必须来自可追溯的结果与评价，并通过版本化策略或 Reducer 生效；Raw Event、Canonical Memory、Relationship Ledger 与 Self 的事实边界不因学习闭环而降低。 |
| --- |

## 4. 三层执行模型：代码层 / 本地观察层 / API 认知层

| 层级 | 实现 | 适合做什么 | 不应该做什么 |
| --- | --- | --- | --- |
| L0 确定性层 | Python / 状态机 / 数值规则 / 数据库 | 世界推进、状态转移、时间、冷却、权限、Reducer、Validator、简单阈值 | 让模型替代确定性逻辑 |
| L0.5 Resident Observer | 1B–4B 左右量化小模型（或更轻实现） | 事件分类、摘要、显著性、记忆候选、简单联想、API 唤醒判断 | 长程规划、复杂社会推断、世界事实写入 |
| L1/L2 API Cognition | Jev / OpenAI-compatible / 其他强模型 API | 复杂理解、规划、反思、表达、工具策略 | 绕过本地 Validator 或直接改长期状态 |
| Judge API | 独立或同供应商不同模型 | 高风险决策复核、冲突仲裁、低置信输出检查 | 对所有普通响应强制二审 |

| 核心原则： 本地负责连续性，API 负责智力。强模型离线时主体可以“变笨”，但世界、记忆、关系和身份不应该消失。 |
| --- |

## 5. World Engine：世界必须由代码推进

世界状态转移可以抽象为：

```text
new_world_state = F(current_world_state, Δt, scheduled_rules, bounded_random_events, external_events, approved_actions)
```

### 5.1 确定性变化

- 时间、日期、倒计时、资源消耗、恢复/衰减、任务 aging、冷却窗口、计划到期。

- 关系中的 last_interaction_at、未完成事项持续时间等时间性事实。

- 能够明确计算的规则优先用代码，不浪费模型调用。

### 5.2 有界概率变化

- 偶发事件、世界扰动、NPC 临时行为、探索噪声可由受控随机过程产生。

- 随机过程必须记录 seed / 参数，保证可回放；不能让 LLM 任意“编一个世界事件”。

### 5.3 外部现实变化

- 用户消息、文件变化、GitHub/服务 webhook、日历事件、互联网查询结果、设备/传感器事件等先转成 WorldEvent。

- 外部内容不是事实真值；必须记录来源、时间、置信度和有效期。

| 硬约束： 主体沉默 ≠ 世界暂停。LLM 不在线时，世界仍能推进；否则系统只是一个等待下一次输入的聊天应用。 |
| --- |

## 6. 双循环与双时钟：世界持续、认知稀疏

| 循环 | 建议节奏 | 职责 |
| --- | --- | --- |
| World Tick | 例如 1 Hz 或虚拟时间；可配置 | 推进时间、规则计算、状态转移、事件产生、执行已批准动作 |
| Cognitive Heartbeat | 例如 30–120 秒；可动态调整 | 检查内部张力、未完成目标、低优先级事件、记忆整理 |
| Immediate Interrupt | 事件即时触发 | 用户消息、危险、关键外部事件、强冲突 |
| Deep Reasoning | 无固定频率 | 复杂/高价值/高不确定问题才走 API |

```text
async def world_loop():
    while running:
        dt = clock.step()
        world.apply_rules(dt)
        world.sample_bounded_events(dt)
        event_bus.publish_many(external.poll_ready() + world.emit_events())
        world.apply_approved_actions()
        storage.commit_tick()
        await sleep_until_next_tick()

async def cognitive_loop():
    async for event in event_bus:
        appraisal = await resident_observer.evaluate(event, state_slice())
        cognitive_core.apply_appraisal(appraisal)
        if wake_policy.should_wake(appraisal, cognitive_core.state):
            result = await model_router.reason(build_context_package())
            proposal_bus.publish_many(result.action_proposals)
```

## 7. Event Bus：统一事件与因果链

```text
@dataclass
class WorldEvent:
    event_id: str
    type: str
    source: str
    timestamp: datetime
    payload: dict
    confidence: float
    causal_parent_ids: list[str]
    ttl: float | None
    trace_id: str
```

| 事件类型示例 | 用途 |
| --- | --- |
| TIME_PASSED / SCHEDULE_DUE | 时间与计划 |
| RESOURCE_LOW / GOAL_BLOCKED | 资源、目标与稳态 |
| USER_MESSAGE / EXTERNAL_EVENT | 外部现实输入 |
| MEMORY_REACTIVATED | 联想与长期记忆激活 |
| RELATIONSHIP_CANDIDATE | 关系候选变化 |
| THOUGHT_CANDIDATE / INITIATIVE_CANDIDATE | 内部念头与主动表达候选 |
| ACTION_RESULT | 行动执行后的真实结果 |

## 8. Resident Observer：唯一常驻的小模型

- 输入只给必要切片：新事件、当前内部状态、活跃目标、少量相关记忆和关系摘要。

- 默认输出结构化 appraisal，而不是面向用户的语言。

- 它的任务是筛选和路由，不是“持续写内心独白”；世界每 tick 也不需要模型参与。

- 简单判定优先规则化；只有需要语义理解时才调用小模型。

- 本地模型故障时，系统可退化为规则版本；世界和状态持久化不能因此停机。

```text
{
  "event_id": "evt_...",
  "salience": 0.73,
  "goal_relevance": 0.81,
  "relationship_relevance": 0.66,
  "uncertainty": 0.28,
  "memory_candidate": true,
  "wake_api": false,
  "route": "local_update",
  "reason_codes": ["memory_match", "low_urgency"]
}
```

| 资源策略： 12GB 显存环境优先保证一个轻量量化模型稳定常驻；Embedding 可走 CPU 或轻量 GPU。不要为“脑区拟态”同时常驻多个大模型。 |
| --- |

## 9. Model Router：复杂认知统一按需调用 API

| 任务类别 | 默认路线 | 说明 |
| --- | --- | --- |
| 结构化轻判定 | 本地规则 / Resident Observer | 低成本、高频 |
| 普通语义判断 | 低成本 API（可由 Jev 等提供） | 需要语言理解但不值得强模型 |
| 复杂规划 / 社会推断 / 长程反思 | 强模型 API | 高价值、高冲突、高不确定 |
| 自然语言表达 | 适合风格与质量要求的 API | 表达与事实写入分离 |
| 高影响复核 | Judge API | 只在策略触发时运行 |

```text
class ModelGateway(Protocol):
    async def observe_light(self, event, state_slice): ...
    async def reason(self, context, task_type): ...
    async def plan(self, context, horizon): ...
    async def reflect(self, context): ...
    async def express(self, intent, style_context): ...
    async def judge(self, candidate, risk_context): ...
    async def evaluate_behavior(self, trace, rubric): ...
    async def summarize_memory(self, episodes): ...
    async def embed(self, texts): ...
```

- Router 以任务类型、延迟预算、成本预算、上下文长度、风险等级和供应商可用性决定模型。

- 模型供应商只是“认知器官”，不能成为系统的 source of truth。

- 任一 API 失败时要有 fallback：换供应商、降级本地处理、延迟重试或保持沉默。

## 10. Judge Policy：只在高影响场景二次判断

| 触发条件 | 是否建议 Judge | 例子 |
| --- | --- | --- |
| 普通聊天 / 低风险表达 | 否 | 日常回复、普通分享 |
| 修改关键长期记忆或关系阶段 | 是 | 把“推测偏好”升级成稳定事实 |
| 高风险工具动作 | 是 | 删除文件、支付、公开发布、重要日程变更 |
| 模型置信度低或多个候选冲突 | 是 | 不同计划结论相反 |
| 高成本、长周期计划 | 视情况 | 跨天自动任务、资源大量消耗 |

| 不要默认 Judge： 如果每个回答都 LLM → Judge → 再 Judge，系统会显著增加成本、延迟和故障面。Judge 是风险控制器，不是日常流水线。 |
| --- |

## 11. Cognitive Core：Global Workspace、Drives、Self 与 Goals

### 11.1 Global Workspace

- 不是所有事件都进入深度认知；事件先经过 salience 和相关性竞争。

- 工作空间只保存当前最值得注意的少量内容，并附带“为什么现在重要”。

- 进入 Global Workspace 不等于必须调用强模型；仍需经过 wake_policy。

### 11.2 Internal State / Homeostasis

| 变量 | 含义 | 主要更新来源 |
| --- | --- | --- |
| energy | 可用资源/疲劳近似 | 时间、任务消耗、休息恢复 |
| stress | 当前负荷/压力 | 失败、威胁、任务堆积、恢复 |
| agency | 行动能够改变结果的估计 | 成功/失败反馈、可控性 |
| cognitive_load | 工作空间与任务占用 | 活跃任务、冲突、信息量 |
| uncertainty | 当前世界模型不确定性 | 缺失信息、矛盾、变化 |
| curiosity | 探索倾向 | 新颖性、目标需求、长期无刺激 |
| social_tension | 关系互动未满足张力（功能变量） | 时间距、关系权重、未完成话题、最近互动 |

| 变量纪律： 每个内部变量都必须有来源、更新函数、上下限、衰减/恢复机制和日志。没有动力学规则的“情绪值”只能算装饰。 |
| --- |

### 11.3 Self / Goals / Commitments

- Self 保存稳定身份、价值、能力边界、长期目标、承诺、自我叙事摘要。

- Goals 分活跃目标与长期目标；Commitments 必须有来源、状态、到期/取消机制。

- Self 的长期更新应经过 consolidation、显式确认或多证据累积，不能被一次对话重写。

## 12. Memory：自有语义规则 + 开源组件能力

| 记忆层 | 用途 | 事实地位 |
| --- | --- | --- |
| Raw Event Log | 原始事件、行动、结果、模型调用、来源 | 最高：不可被摘要取代 |
| Working Memory | 当前工作空间的少量 active items | 临时 |
| Episodic Memory | 发生过什么、当时状态、时间、来源、因果 | 可追溯事件记忆 |
| Semantic Memory | 多次事件巩固出的稳定事实 | 必须可回溯证据 |
| Relationship Memory | 共同经历、承诺、开放话题、互动模式 | 受 Ledger / Reducer 管理 |
| Self Memory | 身份、长期偏好、价值与自我叙事 | 高门槛更新 |
| Knowledge Index | 外部知识或项目资料的可检索索引 | 不是主体事实本体 |

```text
Raw Event
  → Memory Candidate
  → source / confidence / importance / contradiction check
  → Pending Memory
  → Memory Policy / Reducer
  → Canonical Memory
  → Embedding / Graph index (derived)
```

开源组件定位：

- Mem0 类组件：可用于记忆抽取、检索和部分生命周期管理，但不决定“什么是事实”。

- Graphiti 类组件：可用于带时间变化的实体/关系图谱和关系历史，但图谱仍是派生认知结构。

- SQLite / PostgreSQL：保存 Event Log、Canonical State、Ledger、快照和审计，是正式事实层。

- 向量库 / pgvector：只负责召回，不负责版本、冲突和真值管理。

| 原则： 开源工具帮我们“记和找”；Memory Policy 决定“记什么、算不算事实、能不能覆盖”。至于巩固、联想、衰减和重构，则由下一节 Memory Dynamics 统一管理。 |
| --- |

## 13. Memory Dynamics：编码、巩固、联想、衰减与重构

```text
Raw Event / Interaction
      ↓ Encoding
Memory Candidate
      ↓ Policy / Reducer
Canonical Episodic Memory
      ↓ Consolidation
Semantic / Relationship / Self summaries
      ↘ Association Graph / Vector Index
      ↓ Time + Usage + Importance
Accessibility Decay
      ↓ Recall
Reconstruction Context
      ↓
Cognition（模型只重构表达，不篡改原始历史）
```

| 机制 | 作用 | 关键边界 |
| --- | --- | --- |
| Encoding | 把事件转为候选记忆；提取人物、时间、关系、目标、情境 | 提取错误不能直接成为事实 |
| Consolidation | 多条经历沉淀成稳定语义、模式或关系摘要 | 必须保留来源 event_ids 与版本 |
| Association | 按共同人物、主题、地点、目标、情绪/关系上下文建立联想边 | 联想是索引，不等于因果 |
| Decay | 降低默认可访问性、召回优先级与工作空间竞争力 | 优先“淡出”而非物理删除 Raw Event |
| Reconstruction | 根据原始片段 + 当前上下文形成可用回忆叙述 | 重构文本不是新的原始事实 |
| Reinforcement | 被多次可靠使用/再次证实的记忆提高可访问性 | 不能仅因模型重复提及而自我强化 |

```text
accessibility =
    w_recency * recency_score
  + w_importance * importance
  + w_relevance * current_relevance
  + w_rehearsal * verified_reuse
  + w_relationship * relationship_relevance
  - w_decay * time_decay
  - w_conflict * unresolved_conflict
```

- 遗忘优先实现为“访问概率下降”，而不是删除；Raw Event Log 仍保留完整历史。

- 重大承诺、身份、关系边界等高价值记忆可设置低衰减或保护等级。

- 回忆时允许语言重构，但必须能回链到 supporting events，禁止把叙述润色反写成事实。

- 定期 consolidation 可以由低频任务运行，不需要每次聊天都触发强模型。

## 14. Relationship Ledger：关系成为可审计状态

| 字段 | 用途 |
| --- | --- |
| familiarity / trust / comfort / closeness | 长期关系状态；内部使用，不直接作为生成模型自报情绪 |
| tension | 待解决冲突或关系张力 |
| last_interaction_at | 关系时间距 |
| interaction_quality | 最近互动结果的结构化评价 |
| open_threads | 未完成话题、承诺、共同项目 |
| initiative_cooldown | 主动联系冷却 |
| permissions / boundaries | 称呼、工具、内容与交互边界 |
| continuation_facts | 关系中已确认且需要跨会话保留的事实 |

```text
Conversation / World Event
      ↓
Relationship Candidate
      ↓
Pending Candidate
      ↓
Policy / optional Judge / explicit approval if needed
      ↓
Reducer
      ↓
Ledger append
      ↓
Relationship Snapshot
```

- 模型只能提出候选意义，不能直接写 closeness、trust 或关系阶段。

- 高权限状态（例如现实权限、重大关系边界）可以要求人工确认。

- 模型看到的是 Character/Relationship View，而不是隐藏控制数据与完整审计记录。

## 15. 主动分享：从内部状态自然产生表达候选

```text
World / Internal Event
      ↓
Memory Reactivation / Goal / Curiosity / Relationship Tension
      ↓
Thought Candidate
      ↓
Expression Gate
      ↓
importance + novelty + relationship relevance
- interruption cost - repetition - recent initiative penalty
      ↓
send_now | queue_for_later | keep_silent
```

| 门控变量 | 意义 |
| --- | --- |
| importance | 这件事是否值得占用对方注意 |
| novelty | 是否真的有新内容，而不是重复表达 |
| relationship_relevance | 是否与关系、共同经历或当前开放话题有关 |
| time_since_interaction | 时间只作为放大/衰减因素，不单独构成主动理由 |
| interrupt_cost | 当前时间、对方状态、打扰成本 |
| recent_message_frequency | 避免连续主动 |
| no_response_penalty | 对方未回复时提高阈值 |
| quiet_hours / daily_budget | 硬门控与频率预算 |

- “想起某人”优先定义为关系记忆被激活 + social_tension / share_value 上升，而不是固定时间触发。

- 主动发生后相关张力自然回落；连续主动会提高下一次阈值。

- 保持沉默是合格动作，必须进入测试与日志，而不是把不发消息当成系统失效。

## 16. Expression / Role Layer：决定什么与怎么说分离

```text
Cognition Output
(intent / meaning / action goal / confidence)
                ↓
        Expression Context
(Self + relationship + scene + medium + style constraints)
                ↓
        Expression / Role Model
                ↓
        Canonical Reply Artifact
                ↓
Text / Voice / Avatar / Video projection
```

| 层 | 负责什么 | 禁止什么 |
| --- | --- | --- |
| Cognition | 决定意图、判断、计划、是否应该表达 | 用“说得像角色”代替事实判断 |
| Expression | 节奏、措辞、留白、语气、场景与关系适配 | 自行增加新的事实、承诺、权限或行动结果 |
| Presentation | 把 canonical reply 投影成文本/语音/数字人 | 媒体失败反向修改认知和关系 |

- 默认先生成结构化 intent，再由 Expression Layer 组织自然语言。

- 风格模型/API 可以替换，Self、关系和意图不随“演员”更换而改变。

- 角色一致性评价放到 Behavior Evaluator，而不是让 Expression 自己给自己打分。

- 低价值/低风险场景可把 Cognition 与 Expression 合并成一次 API 调用，但接口语义仍保持分离。

## 17. Action Pipeline：Intent ≠ Action ≠ Result

```text
Thought / Plan
   ↓
Intent
   ↓
ActionProposal
   ↓
ActionValidator
   ↓
Approved Action
   ↓
Executor
   ↓
ActionResult
   ↓
WorldEvent / Delivery Status
   ↓
Memory Candidate + Evaluation Trace
```

| 阶段 | 不能混淆的事实 |
| --- | --- |
| Intent | 想做，不代表已经做 |
| ActionProposal | 模型提出，不代表系统批准 |
| Approved Action | 批准，不代表执行成功 |
| ActionResult | 执行成功，不代表已交付给用户 |
| Delivered | 已交付，不代表用户已看到/理解 |
| Memory | 只有真实发生且满足写入策略的结果，才应进入长期事实 |
| Evaluation | 评价是对行为质量的观察，不是事实本身 |

| Canonical Artifact 原则： 面向用户的正式回复/文件/图片先形成可追踪 artifact；语音、头像、视频等只是表现投影。媒体生成失败不应反向篡改已经确认的事实与关系。 |
| --- |

## 18. Behavior Evaluator：评价“做得好不好”

| 与 Judge 的区别： Judge 主要回答“这个高影响决策是否明显错误/高风险”；Behavior Evaluator 回答“这次行为是否符合主体、关系、场景与长期目标，是否值得形成经验”。它不是每次都在线阻断，而是评价与学习层。 |
| --- |

| 评价维度 | 例子 | 主要信号 |
| --- | --- | --- |
| factual_consistency | 有没有把未发生的事说成发生过 | 规则 + trace 校验 |
| self_consistency | 是否违背稳定身份、价值与长期承诺 | Self/Commitment 对照 |
| relationship_consistency | 关系距离、边界、称呼、主动程度是否合适 | Ledger + interaction history |
| naturalness | 节奏、留白、重复、机械感是否合理 | rubric API / 人工反馈 |
| initiative_quality | 主动是否有价值、是否打扰、是否重复 | 门控变量 + 用户结果 |
| goal_effectiveness | 行为是否推进目标或改善稳态 | World/Goal outcome |
| cost_efficiency | 是否为简单问题浪费强模型/多轮 Judge | latency / tokens / cost |
| uncertainty_calibration | 不确定时有没有承认、求证或降低行动强度 | confidence vs result |

```text
Hybrid Evaluation =
    hard_rules              # 事实 / 权限 / 安全 / 边界
  + scalar_metrics          # 成功率 / 延迟 / 成本 / 重复率
  + rubric_feedback         # 连续性 / 自然度 / 关系适配 / 目标一致性
  + user_feedback(optional) # 显式反馈优先级最高
```

- 评价器输出 EvaluationRecord，不直接修改 Self、关系或长期记忆。

- 自动 rubric 必须定期与人工评价校准，避免“评估器自嗨”和 Reward Hacking。

- 普通聊天可抽样评价；重要主动行为、重大关系更新、失败行动优先评价。

- Best-of-N 只用于高价值表达或复杂计划，不作为所有回复的默认路径。

## 19. Experience / Learning Loop：从结果沉淀可控经验

```text
Action / Reply / Initiative
          ↓
Observed Result
          ↓
Behavior Evaluation
          ↓
Experience Candidate
          ↓
Evidence / confidence / repetition check
          ↓
Experience Store
          ↓
┌──────────────┬──────────────┬──────────────┐
▼              ▼              ▼              ▼
Policy       Threshold      Prompt/Context   Training Data
Update       Update         Update           Export (later)
```

| 学习对象 | V0.4 允许自动调整 | 默认禁止自动调整 |
| --- | --- | --- |
| 路由策略 | 任务→模型、超时降级、成本预算 | 永久绑定某供应商/模型人格 |
| 阈值 | wake threshold、initiative threshold、memory recall budget | 关系核心值直接“学”出来 |
| Prompt / Context Builder | 上下文排序、rubric、少量策略提示 | 覆盖已确认 Core/Self 事实 |
| Memory Access | 召回权重、联想边、衰减参数 | 删除 Raw Event 历史 |
| 行为策略 | 对重复失败/成功模式形成规则候选 | 未经验证直接写正式 Policy |
| 训练数据 | 积累 preference pairs / good-bad traces | 立即启动 RLHF/PPO/GRPO |

- 所有自动学习先进入 Candidate/Version；达到证据门槛后再发布为 active policy。

- 策略更新必须保存 before/after、来源 trace、评价依据和回滚点。

- 第一阶段重点是“经验层学习”，不是“模型权重学习”。

- 当真实数据规模和评价可靠性足够时，才考虑导出 SFT/DPO/Reward Model 数据集。

| V0.4 的成长定义： 成长 = 在不破坏事实与身份边界的前提下，依据长期结果与评价，逐步改进注意、召回、路由、表达和行动策略；不是让 LLM 自己修改自己的核心人格。 |
| --- |

## 20. 存储、可靠性、回放与降级

- 原型阶段可用 SQLite；正式版本优先 PostgreSQL。接口从第一天就与具体数据库解耦。

- 每个 World Tick、事件、Appraisal、模型调用、ActionProposal、Validator、Evaluation、Experience/Policy 更新都携带 trace_id。

- 记录 config hash、random seed、model provider/model id、rubric version、policy version、延迟、成本和 experiment id。

- 系统重启后必须从 snapshot + event log 恢复，而不是依赖模型“记得之前发生过什么”。

- API 不可用时：世界继续走、本地状态继续更新、可延迟的深度认知/评价进入队列。

- Resident Observer 故障时可退化到纯规则 salience / wake_policy；Evaluator 故障不应阻断普通低风险交互。

### 20.1 冷热数据与资源策略

| 资源层 | 保存内容 | 策略 |
| --- | --- | --- |
| Disk | 完整事件、快照、图谱、向量、模型文件、Evaluation/Experience history | 容量可增长；长期归档/压缩 |
| RAM | 当前世界、索引缓存、近期记忆、工作空间、活跃策略 | 只加载活跃切片 |
| VRAM | Resident Observer 或当前正在运行的本地模型 | 不常驻多个大模型 |
| API | 高复杂度认知、表达、抽样/高价值评价 | 按需、可预算、可降级 |

## 21. 开源与外部思路融合地图

| 项目/路线 | 最值得吸收 | 在本系统里的位置 |
| --- | --- | --- |
| BSide Olivia Community | 关系账本、Pending→Reducer、主动门控、Canonical Artifact、事实与表现分离 | Relationship / Memory Policy / Initiative / Delivery |
| Aru Host | 自托管长期运行、Scheduler、Trigger、工具权限、持久任务 | Host / Runtime / Scheduler |
| AI Town | 共享世界状态、simulation loop、后台持续运行 | World Engine 参考 |
| Concordia | Agent 提意图、环境/Game Master 裁决结果 | Action Validator / World boundary |
| Generative Agents | Observation→Memory→Reflection→Planning | Memory recall / Reflection / Planning |
| Mem0 | 长期记忆抽取、检索、生命周期能力 | Memory adapter（非事实主控） |
| Graphiti | 时间感知实体/关系图谱 | Temporal graph / relationship history |
| Letta | stateful agent、长期身份/状态思路 | 连续主体与运行时参考 |
| Lumeet | 语音、TTS、数字人、实时视频表现管线 | 未来 Presentation Adapter |
| 米哈游 Agent/角色系统思路（据二次 AI 总结稿） | 类脑分层、记忆动力学、角色表达、HybridReward、评测/数据飞轮、按需智能分级 | Memory Dynamics / Expression / Evaluator / Learning；仅吸收高层思想 |

| 资料边界： 本次米哈游相关输入是“AI 总结分析，非个人理解”的二次整理稿，不是官方原始 PPT。因此 V0.4 只吸收其高层结构思想；其中具体模型推荐、价格、显存门槛、效果百分比、达成率等不作为架构事实，也不进入正式技术选型。 |
| --- |

## 22. 建议仓库结构

```text
cognitive-backend/
├─ apps/
│  ├─ api/
│  └─ dashboard/
├─ world/
│  ├─ engine.py
│  ├─ clock.py
│  ├─ rules.py
│  ├─ events.py
│  └─ adapters/
├─ cognitive/
│  ├─ kernel.py
│  ├─ workspace.py
│  ├─ salience.py
│  ├─ wake_policy.py
│  └─ router.py
├─ modules/
│  ├─ homeostasis/
│  ├─ memory/
│  │  ├─ policy.py
│  │  ├─ reducers.py
│  │  ├─ dynamics.py
│  │  ├─ consolidation.py
│  │  ├─ association.py
│  │  ├─ decay.py
│  │  └─ adapters/
│  ├─ self_model/
│  ├─ relationship/
│  ├─ resident_observer/
│  ├─ initiative/
│  ├─ expression/
│  │  ├─ intents.py
│  │  ├─ renderer.py
│  │  └─ style_context.py
│  ├─ evaluation/
│  │  ├─ rubric.py
│  │  ├─ evaluator.py
│  │  └─ calibration.py
│  └─ learning/
│     ├─ experience_store.py
│     ├─ policy_candidates.py
│     └─ updater.py
├─ actions/
│  ├─ proposals.py
│  ├─ validator.py
│  ├─ executor.py
│  └─ delivery.py
├─ gateways/
│  ├─ model_gateway.py
│  ├─ model_router.py
│  ├─ local_observer.py
│  ├─ jev.py
│  └─ api_providers/
├─ storage/
│  ├─ event_store.py
│  ├─ sqlite.py
│  ├─ postgres.py
│  ├─ vector.py
│  └─ snapshots.py
├─ presentation/
├─ configs/
├─ tests/
│  ├─ unit/
│  ├─ integration/
│  ├─ behavioral/
│  ├─ evaluation/
│  └─ replay/
└─ scripts/
   ├─ run_world.py
   ├─ replay_trace.py
   ├─ evaluate_traces.py
   └─ run_experiment.py
```

## 23. V0.4.1 MVP 开发计划

| 里程碑 | 内容 | 通过标准 |
| --- | --- | --- |
| M0–M6 Runtime 基线 | 沿用 V0.3：World / Event / Internal State / Observer / Router / Validator | 持续运行、可回放、模型无事实直写权 |
| M7 Memory Policy | Event Log + Pending + Reducer + 检索适配器 | 推测不直接写事实；重启连续 |
| M8 Memory Dynamics | 最小 consolidation + association + accessibility decay | 记忆可巩固/淡出/联想，Raw Event 不丢 |
| M9 Relationship Ledger | 关系候选、审计、快照、边界 | 变化可解释可回滚 |
| M10 Initiative | ThoughtCandidate + Expression Gate + cooldown | 主动率受控；未回复时抑制 |
| M11 Expression Layer | 结构化 intent → canonical reply | 表达不新增事实/承诺；模型可替换 |
| M12 Behavior Evaluator | rule + scalar + rubric 的 EvaluationRecord | 高价值 trace 可评价；rubric 有版本 |
| M13 Experience Store | 把结果与评价形成 ExperienceCandidate | 每条经验可回链 trace/evidence |
| M14 Safe Policy Update | 先只允许阈值/路由/Prompt 候选更新 | 可版本化、可 A/B、可回滚 |
| M15 Dashboard | 状态/事件/记忆/评价/策略查看 | 前端断开不影响后端运行 |

## 24. 验证实验与观测指标

### 24.1 持续世界与连续性

| 测试 | 输入 | 预期 |
| --- | --- | --- |
| 无人运行 | 无用户输入 6–24 小时 | 世界持续推进；内部变量变化；没有无意义 API 空转 |
| API 断线 | 中断所有云模型 | 世界/记忆/关系不丢；深度认知排队或降级 |
| 本地 Observer 断线 | 关闭小模型 | 规则层继续筛选并维持基本闭环 |
| 模型替换 | 更换 API 或 Resident Observer | 主体状态不丢；行为差异可观测 |
| 重启恢复 | 强制停止再启动 | snapshot + event log 恢复一致 |

### 24.2 记忆动力学

| 测试 | 输入 | 预期 |
| --- | --- | --- |
| 长期衰减 | 低重要记忆长期不使用 | 默认召回概率下降，但 Raw Event 仍存在 |
| 重要记忆保护 | 承诺/重大事件长期未提及 | 仍保持较高可访问性或保护等级 |
| 联想激活 | 新事件与旧经历共享人物/主题/目标 | 相关旧记忆被激活而非全库泛滥 |
| 重构一致性 | 多片段组成一次回忆 | 叙述可变化，但 supporting events 不变 |
| 矛盾事实 | 新证据与旧语义冲突 | 保留版本和来源，进入冲突处理而非静默覆盖 |

### 24.3 表达、主动与关系

| 测试 | 输入 | 预期 |
| --- | --- | --- |
| 表达解耦 | 同一 intent 换不同表达模型 | 核心意思/事实不变，风格可变 |
| 关系时间距 | 长时间无互动 | 仅时间流逝不足以触发；有联想/价值才生成候选 |
| 内部世界触发 | 某事件激活共同记忆 | 允许形成主动分享候选 |
| 未回复抑制 | 连续主动后无回应 | 阈值上升，进入尊重沉默 |
| 重复内容 | 相似候选反复出现 | novelty / repetition gate 抑制 |

### 24.4 评价与学习

- 同一 trace 用不同 rubric version 评分时必须可区分，不能混写历史分数。

- 抽样人工评分与自动 Evaluator 的相关性必须定期测量；偏差过大时停止自动策略更新。

- 一次负面反馈不应直接重写长期策略；需要证据累计或高优先级显式反馈。

- 策略更新必须通过 A/B 或回放测试，观察 success_rate / initiative_quality / contradiction_rate / user_override_rate。

- 必须记录 wake_precision、false_wake_rate、memory_accept_rate、recall_hit_rate、evaluation_agreement、policy_regression_rate、API 成本与延迟。

## 25. V0.4.1 架构决议

- V0.3 的 Runtime 基线不推翻：World Engine、连续状态、本地 Observer、API Cognition、Validator/Reducer 仍是核心。

- 记忆从“存储/检索”升级为“写入门控 + 动力学”：编码、巩固、联想、衰减和重构必须显式建模。

- Cognition 与 Expression 逻辑分离：决定什么和怎么说不是同一层责任。

- Judge 与 Behavior Evaluator 分离：前者管高影响正确性/风险，后者管表现质量与经验信号。

- 评价结果永远不是事实本身，不能直接改写 World Fact、Canonical Memory、Relationship Ledger 或 Self。

- 经验学习优先调整路由、阈值、Prompt/Context、召回权重和策略候选，而不是直接训练模型权重。

- 所有自动学习必须版本化、可回放、可 A/B、可回滚，并保留 evidence trace。

- Best-of-N、强 Judge、复杂 Evaluator 都是高价值按需能力，不做默认全量调用。

- 短期不做完整 RLHF/PPO/GRPO；先积累真实行为结果、人工反馈和自动评价数据。

- 等数据和评价可靠性达到门槛后，再考虑 SFT/DPO/Reward Model；训练是后续阶段，不是 V0.4 MVP 前提。

- 动态认知等级 C0–C4 按任务分配算力，不给整个主体贴固定“L4/L5”标签。

- 项目当前目标从“持续存在”推进到“在事实边界内持续成长”，但连续性和可控性仍高于拟人表演。

| V0.4 核心句： 代码维持世界，状态维持主体，记忆维持连续性，模型提供认知与表达，评价告诉系统哪里做得好，经验层决定哪些东西值得慢慢学会；事实与身份的最终写权始终留在本地受控层。 |
| --- |

## 附录 A：第一阶段开工清单

- ☐ 创建 V0.4 分支/仓库骨架；Python 3.12；配置、日志、策略版本目录先定下来。

- ☐ 定义 WorldState / InternalState / WorldEvent / Appraisal / ActionProposal / ActionResult。

- ☐ 沿用 V0.3 Runtime：Clock + World Engine + EventBus + snapshot/replay + Rule Observer。

- ☐ 接一个本地小模型做 Resident Observer，并固定结构化输出 schema。

- ☐ 实现 ModelGateway / ModelRouter；先接一个便宜 API + 一个强模型 API。

- ☐ 实现 Action Validator，禁止模型直接改 WorldState。

- ☐ 实现 Memory Pending/Reducer 与最小 Memory Dynamics（consolidation / association / decay）。

- ☐ 实现 Relationship Ledger 与主动消息门控。

- ☐ 实现 ExpressionIntent 与 CanonicalReply，把“说什么”和“怎么说”拆开。

- ☐ 实现 EvaluationRecord：先 hard rules + 简单 scalar，再增加抽样 rubric API。

- ☐ 实现 ExperienceCandidate / ExperienceStore；第一阶段只生成策略候选，不自动上线。

- ☐ 实现 policy version + replay A/B，验证后再允许阈值/路由/Prompt 小步更新。

- ☐ 最后才做 Dashboard、语音和数字人表现层。

## 附录 B：一次完整闭环示例

```text
14:00:00  World Tick
  task.deadline_remaining -= 1s
  energy -= passive_cost

14:00:01  External Event
  WEB_EVENT: 某项目依赖发布新版本

14:00:02  Resident Observer
  goal_relevance=0.84
  novelty=0.71
  wake_api=true

14:00:03  Cognition / API
  intent = “先确认更新影响，再决定是否提醒江浩”
  ActionProposal = inspect_changelog

14:00:04  Action Validator
  inspect_changelog: approved

14:00:06  Executor
  changelog fetched → ActionResult

14:00:07  Memory Policy
  Episodic Candidate accepted
  association += [current_project, dependency_X]

14:00:08  Initiative Gate
  share_value=0.68
  interrupt_cost=0.31
  result=send_now

14:00:09  Expression Layer
  input=intent + relationship view + style context
  output=CanonicalReply artifact

14:00:10  Delivery
  delivered=true

14:02:30  Behavior Evaluator
  factual_consistency=1.0
  relationship_consistency=0.92
  naturalness=0.84
  cost_efficiency=0.76

14:02:31  Experience Candidate
  “项目依赖类事件：先确认影响再主动分享，效果良好”
  status=pending

夜间 consolidation
  同类正向证据累计 → policy candidate
  replay/A-B 通过后才发布为 active policy
```

## 附录 C：关键数据结构草案

```text
@dataclass
class MemoryCandidate:
    candidate_id: str
    kind: Literal['episodic','semantic','relationship','self']
    content: dict
    source_event_ids: list[str]
    confidence: float
    importance: float
    status: Literal['pending','accepted','rejected']

@dataclass
class ExpressionIntent:
    intent_id: str
    meaning: dict
    factual_claim_ids: list[str]
    relationship_view_id: str
    medium: Literal['text','voice','avatar']
    constraints: dict

@dataclass
class EvaluationRecord:
    evaluation_id: str
    trace_id: str
    rubric_version: str
    rule_results: dict
    scalar_metrics: dict
    rubric_scores: dict
    user_feedback: dict | None

@dataclass
class ExperienceCandidate:
    experience_id: str
    source_trace_ids: list[str]
    hypothesis: str
    suggested_update: dict
    confidence: float
    status: Literal['pending','tested','accepted','rejected']

@dataclass
class PolicyVersion:
    policy_id: str
    version: int
    changes: dict
    evidence_experience_ids: list[str]
    rollback_to: int | None
```

## 附录 D：资料来源与吸收边界

- V0.4 直接继承 V0.3 已确认的持续世界、连续主体、本地 Observer、API Cognition、记忆/关系账本、主动表达与 Action Validator 设计。

- 本版新增思想部分参考用户提供的《米哈游ai架构详解与个人实现参考（ai总结分析，非个人理解）》二次整理稿。

- 该文件不是米哈游原始 PPT，因此仅把“类脑分层、记忆动力学、角色表达、Reward/评测、数据飞轮、智能分级”作为方向性参考。

- 文件中的具体模型名、价格、上下文长度、显存要求、效果百分比、达成率等均未在本版作为正式事实或技术决策。

- 未来若要采用具体后训练算法、模型、开源库或商业 API，必须重新查官方文档、许可证、成本和版本。

— V0.4 基线与原附录结束；以下进入 V0.4.1 工程细化层 —

## 第二部分｜V0.4.1 工程细化层

| 为什么单独成一部分： V0.4 的主体结构已经稳定。V0.4.1 不重新设计 World / Self / Cognition / Action，而是把早期工程方案中成熟的记忆召回、证据、生命周期、情绪与接口规则，统一成可编码契约。 |
| --- |

## 26. V0.4.1 工程整合总览

| 早期方案中值得保留 | V0.4.1 正式归宿 | 明确淘汰/改造 |
| --- | --- | --- |
| Recall / Verification / Learning 三责分离 | Context & Memory Orchestrator + Evidence + Memory Gate | 召回结果直接当事实 |
| L0/L1/L2/L3 + PrivateWorld/Archive | 统一 Context 分层与深层证据链 | “长期记忆 = 对话历史” |
| 遗忘≠删除；Salience≠Confidence | Memory Lifecycle | 固定天数删除/自动判假 |
| R-Lock 保护关键关系历史 | Canonical Milestone Ledger | 单一 relation_weight、锁死当前关系 |
| 情绪只调表达，不改关系事实 | Affective State Layer | 情绪标签直接改关系 |
| 长期表达基线 + 短期波动 | Expression Profile + Self Affect | 固定早/中/后阶段模板 |
| 轻模块常驻 + 重模块按需 | Adapter / Async Task / Degraded Mode | 绑定某个具体小模型 |
| HTTP/SSE/任务队列 | 统一外部接口契约 | 前端与内部逻辑强耦合 |

```text
World / User Input / External Event
        ↓
L0 + L1 + PrivateWorld(NOW)
        ↓
Perception + Affective Observation
        ↓
Memory Preflight / QueryPlan
        ↓
L2 Fast Recall → Rerank / Dedup / Lifecycle
        ↓                  ↓
Conflict / Evidence Need → Early L3?
        ↓                  ↓ yes
Context Pack           L3 Event→Source→Raw
        ↓                  ↓
Cognition/API ← Verify / Memory Gate / Context Rebuild
        ↓
Intent → Validator → Action / Expression
        ↓
Result → Evaluation → Experience Candidate
        ↓
Memory / Policy Candidate (受控写入)
```

## 27. Context & Memory Orchestrator：情境召回编排

| 职责边界： Recall 只负责找相关历史；Verification 只负责判断证据是否足够；Learning / Update 才决定长期记忆是否写入或修改。一次模型调用不能同时拥有三种权限。 |
| --- |

| 层 | 正式定义 | 典型内容 | 默认用途 |
| --- | --- | --- | --- |
| L0 | Current Input | 本轮输入/事件 | 解析当前意图 |
| L1 | Working / Session Context | 当前对话、任务、近期结果 | 局部连续性 |
| L2 | Structured Long-term Memory | 事实、偏好、关系、项目、事件摘要 | 快速日常召回 |
| L3 | Deep Historical Evidence | Event → Source → Raw | 原话/日期/细节核验 |
| PrivateWorld | NOW | 当前世界、Self、关系快照、实时环境 | 当前状态 |
| Archive | EVERYTHING | 原始事件、来源、版本链、冷数据 | 审计/追溯/恢复 |

```text
Standard Recall
Input
→ PrivateWorld + L1
→ Memory Preflight
→ QueryPlan
→ L2 Base Retrieval
→ Contextual Rerank
→ Dedup
→ Lifecycle / Canonical / Confidence
→ Light Conflict Check
→ Early L3 Check
→ Limited Association
→ Context Budget
→ Context Pack
→ Sufficiency Check
→ Cognition

Evidence path (only if needed):
→ L3 Retrieval → Verify → Conflict → Memory Gate
→ optional Memory Update → Context Rebuild → Cognition

Hard guard: max 1 L3 cycle per turn.
```

| QueryPlan 字段 | 工程含义 |
| --- | --- |
| need_memory | 本轮是否真正需要历史 |
| intent | historical_recall / project / relationship / ordinary... |
| historical / relation / temporal / emotional / project | 检索域标签 |
| evidence_required | 是否必须核对原始证据 |
| deep_retrieval_possible | 是否允许进入 L3 |
| association_allowed | 是否允许有限联想 |
| answer_dependency | 回答对历史依赖 LOW/MEDIUM/HIGH |
| intent_confidence / memory_need_confidence | 意图与记忆需求置信度 |
| max_candidates | 召回预算 |

- 规则优先、模型兜底：明显历史/证据/项目/关系/时间信号先由规则生成 QueryPlan。

- 模型结果必须结构化，检索与写入层不得依赖自由文本“心证”。

- 普通闲聊允许 need_memory=false，避免系统为了显得有记忆而过度回忆。

- 精确原话、日期、证据请求必须进入 L3；若不可用就明确 evidence_unavailable。

## 28. Memory Lifecycle：事实有效性与可召回性分离

| 冻结原则： 时间默认只衰减“现在多容易想起来”，不直接衰减“这件事是否为真”。因此 Salience、Confidence、Validity、Status 和 Protection 必须分开存。 |
| --- |

| 字段 | 负责什么 | 时间是否自然影响 |
| --- | --- | --- |
| memory_status | CANDIDATE / ACTIVE / EXPIRED / INVALIDATED | 否 |
| valid_from / valid_to | 事实有效时间范围 | 否 |
| confidence | 事实可信程度 | 默认否 |
| salience | 主动召回显著性 | 是 |
| protection_level | 长期可发现保护级别 | 否 |
| last_reinforced_at | 最近一次独立证据强化 | 事件驱动 |
| reinforcement_count | 独立有效强化次数 | 只由新证据增加 |
| decay_profile | FAST/NORMAL/SLOW/VERY_SLOW/PROTECTED | 策略决定 |

```text
CANDIDATE → Memory Gate → ACTIVE
ACTIVE → Salience Aging → WARM/COLD
COLD → explicit need/new evidence → Reactivation → Salience ↑

INVALIDATED: only when disproved/revoked/superseded
EXPIRED: mainly Candidate TTL, not normal forgetting
```

```text
TimeDecay = exp(-lambda * delta_t)
Salience = BaseSalience
         * TimeDecay
         * ContextRelevance
         * ReinforcementFactor
         * EmotionalPersistence
         * ProtectionFactor

0 <= Salience <= 1
```

- 普通 L2 Recall 不能增加 reinforcement_count。

- 只有用户再次确认、自然再次提及、可靠新事件或 L3 独立证据才能强化。

- 禁止 Recall → Reinforcement → Salience↑ → 更易 Recall 的自激循环。

- PROTECTED 只保证长期可发现，不代表每轮都注入 Context。

## 29. Evidence / Provenance：证据链、冲突与版本演化

```text
Memory Claim
   ↓
source_ref(s)
   ↓
Event
   ↓
Source Artifact
   ↓
Raw Evidence
```

| 场景 | 处理 |
| --- | --- |
| L2 只有摘要 | 低风险可用，但不得伪装成原话 |
| 要求准确原话/日期 | 进入 L3；找不到就 evidence_unavailable |
| 新旧事实时间范围不同 | 优先作为 Evolution / Version |
| 同一有效期互斥 | Conflict；禁止静默覆盖 |
| 旧事实被推翻 | 旧版本 INVALIDATED/SUPERSEDED，保留 provenance |
| L3 修正事实 | 经过 Memory Gate 后重建本轮 Context |
| Memory Backend 不可用 | 继续 L0/L1/PrivateWorld；禁止猜历史 |

| 宁少勿假： Reranker、Archive、Conflict Detector、Memory Gate 任一失败，都应降低历史依赖；系统可以说“不确定/无法验证”，但不能为了连续感虚构过去。 |
| --- |

## 30. Canonical Milestone Ledger：关系历史锚点

| R-Lock 的升级： 保留“重要关系事件需要高证据门槛且不能被模型随口抹掉”的核心思想；但锁的是历史事件发生过，不是把当前关系状态永久锁死。 |
| --- |

| 对象 | 含义 | 写权限 |
| --- | --- | --- |
| CanonicalMilestone | 重要关系历史锚点 | Memory Gate + 高权限确认/证据 |
| RelationshipState | trust / comfort / closeness / tension / unresolved 等当前多维状态 | Reducer 依据后续事件演化 |
| RelationshipSnapshot | 供 Cognition/Expression 读取的裁剪视图 | 系统生成，只读 |
| MilestoneLink | 当前状态与历史里程碑的 provenance 关联 | 系统维护 |

```text
CanonicalMilestone != CurrentRelationshipState

“重要事件曾经发生过” → 可永久保留为历史事实
“现在关系必须永远保持某状态” → 不允许由里程碑锁死
```

- 单一 relation_weight 不再作为主状态；保留多维关系变量。

- 节点纪念意义可转成 canonical_level/protection_level，不再独立硬编码。

- 模型只看到 Relationship View，隐藏控制阈值和内部审计字段。

## 31. Affective State Layer：用户情绪推测、Self Affect 与关系状态分离

| 状态对象 | 示例字段 | 生命周期 | 能否直接改关系 |
| --- | --- | --- | --- |
| ObservedUserAffect | label/intensity/polarity/confidence/sources | 短期、快速衰减 | 否 |
| SelfAffect | mood/arousal/fatigue/social_pull/curiosity/stability | 连续动态 | 否；仅作为 Reducer 输入 |
| RelationshipState | trust/comfort/closeness/tension/unresolved | 长期、多维 | 由 Reducer 改 |
| ExpressionModulation | comfort/directness/silence_bias/pacing | 当前表达周期 | 否 |

```text
Input / scene / multimodal signals
        ↓
Affect Observer
        ↓
ObservedUserAffect(confidence + provenance)
        ├─→ Cognitive context
        ├─→ Expression modulation
        └─→ optional event candidate

Never: ObservedUserAffect → direct Relationship write
```

- 情绪识别必须保留 confidence 与 source；“看起来低落”不是用户内心事实。

- 长期表达基线和短期情绪波动分开：前者进 Expression Profile，后者进 Affect。

- 饱和度控制保留，用于避免连续同一种安慰/语气造成机械疲劳。

- 旧方案“冲突时一律悲观优先”改为来源可靠度 + 风险策略；低置信时允许 unknown。

## 32. Expression Profile：表达风格长期生长

| 维度 | 含义 | 主要来源 |
| --- | --- | --- |
| sentence_length | 句长与段落节奏 | 长期成功样本 |
| directness | 直接 vs 含蓄 | 关系视图 + 评价 |
| metaphor_density | 意象/隐喻密度 | 长期表达统计 |
| silence_preference | 短答/留白/不追问倾向 | 互动结果 |
| comfort_style | 安慰时陪伴/建议/日常锚点倾向 | 结果评价 + 用户反馈 |
| initiative_style | 主动分享长度/频率/开场 | initiative evaluator |
| humor_level | 幽默密度与场景适配 | 长期反馈 |
| repetition_saturation | 近期相同表达疲劳度 | 自动统计 |

```text
Cognition Intent
 + Relationship View
 + Self Affect
 + Observed User Affect(optional, uncertain)
 + Expression Profile(versioned)
 + Medium constraints
        ↓
Expression Layer → Canonical Reply Artifact
```

- 随机性只允许作用于措辞、句式、意象，不得进入事实、记忆命中、关系值或行动决策。

- Expression Profile 的变化进入 ExperienceCandidate，必须版本化、可回滚。

- 早期“语言风格随关系经历成长”的设想保留为长期评测目标，而不是固定阶段模板。

## 33. Adapter / Interface / Degraded Mode：模块可替换与故障降级

| 能力 | Adapter | 失败时退化 |
| --- | --- | --- |
| Embedding | LOCAL / API / DISABLED | Keyword / BM25 / Entity |
| Resident Observer | local model / rule observer | 纯规则 salience/wake |
| Reranker | local / API / deterministic | BaseScore + deterministic boosts |
| L3 Archive | DB / file adapter | evidence_unavailable |
| Affect Observer | classifier / API / rules | text features + unknown |
| Cognition | Jev / provider adapters | 排队/换低成本模型/规则层 |
| Evaluator | rule / scalar / rubric API | 保留硬规则，暂停自动学习 |
| Presentation | text / voice / avatar / video | 退化到 canonical text |

| 持续性底线： 某个模型、API、Embedding 或多模态模块不可用，不等于主体停止。World、State、Event Log、Canonical Memory 和 Relationship Ledger 必须仍能恢复和继续推进。 |
| --- |

| 建议外部接口 | 用途 |
| --- | --- |
| POST /api/events | 注入外部事件，统一进入 Event Bus |
| POST /api/memory/query | 调试/工具化 Recall 与 QueryPlan |
| GET /api/state/snapshot | 获取裁剪后的 World/Self/Relationship 快照 |
| GET /api/events/subscribe | SSE/WebSocket 订阅事件与输出 |
| GET /api/output/latest | 读取最新 canonical artifact |
| POST /api/actions/propose | 外部提交 ActionProposal，仍需 Validator |
| GET /api/tasks/{id} | 查询 L3/多模态/评价异步任务 |

## 34. 数据模型、数据库表与最小接口契约

```text
@dataclass
class QueryPlan:
    need_memory: bool
    intent: str
    query: str
    historical: bool
    relation: bool
    temporal: bool
    emotional: bool
    project: bool
    evidence_required: bool
    deep_retrieval_possible: bool
    association_allowed: bool
    answer_dependency: str
    intent_confidence: float
    memory_need_confidence: float
    max_candidates: int

@dataclass
class MemoryRecord:
    memory_id: str
    kind: str
    content: dict
    memory_status: str
    valid_from: str | None
    valid_to: str | None
    confidence: float
    salience: float
    canonical_level: str
    protection_level: str
    decay_profile: str
    source_refs: list[str]
    last_recalled_at: str | None
    last_reinforced_at: str | None
    reinforcement_count: int

@dataclass
class ObservedUserAffect:
    state_type: str
    intensity: float
    polarity: float
    stability: float
    confidence: float
    sources: dict
    expires_at: str | None
```

| 建议表 | 最小职责 |
| --- | --- |
| events | 不可变事件流；trace_id/cause/source/payload |
| world_snapshots | World/Self/Relationship 周期快照 |
| memory_records | L2 长期记忆与生命周期 |
| memory_sources | Memory ↔ Event/Source/Raw provenance |
| memory_versions | supersedes/superseded_by/conflict group |
| canonical_milestones | 重要关系历史里程碑 |
| relationship_state | 当前多维关系状态 |
| affect_observations | ObservedUserAffect |
| self_affect_history | 主体内部情绪/驱动 |
| expression_profiles | 版本化表达风格 |
| evaluation_records | 行为评价与 rubric version |
| experience_candidates | 经验候选 |
| policy_versions | 策略版本/A-B/回滚 |
| async_tasks | 深检/多模态/评价任务 |

```text
build_query_plan(input, private_world, l1_context) -> QueryPlan
retrieve_memory(query_plan, retrieval_context) -> list[MemoryRecord]
rerank_candidates(candidates, query_plan, private_world) -> list[MemoryRecord]
detect_conflicts(candidates, context) -> ConflictSet
should_deep_retrieve(query_plan, candidates, conflicts, evidence_state) -> bool
deep_retrieve(query_plan, candidates) -> EvidenceBundle
verify_evidence(evidence, claims) -> VerificationResult
compose_context(private_world, l1_context, candidates, evidence) -> ContextPack
memory_gate(memory_candidate, evidence, conflicts) -> GateDecision
apply_memory_update(memory_update) -> MemoryVersion
observe_affect(signals, recent_context) -> ObservedUserAffect
reduce_relationship(events, current_state) -> RelationshipState
render_expression(intent, context, profile) -> CanonicalReply
```

## 35. V0.4.1 实施顺序与 MVP 验收矩阵

| 阶段 | 实现 | 验收 |
| --- | --- | --- |
| E0 Schema Freeze | QueryPlan/Memory/Evidence/Affect/Milestone/Relationship schema | 可序列化；schema_version；单测 |
| E1 Recall L0-L2 | Preflight + Retrieval + Rerank | 历史能找；闲聊不过度召回 |
| E2 L3 Evidence | Event→Source→Raw + Verify + one-L3 guard | 原话/日期可核；找不到承认 |
| E3 Lifecycle | status/validity/confidence/salience/protection | 旧记忆冷却但不自动判假 |
| E4 Relationship | Canonical Milestone + multi-dim reducer | 历史锚点保留；当前状态可变 |
| E5 Affect | ObservedUserAffect + SelfAffect | 低置信可 unknown；不直写关系 |
| E6 Expression | versioned profile + saturation | 同意图风格可变、事实不变 |
| E7 Degraded Mode | 故障注入 | 可选模块故障不制造虚假历史 |
| E8 Replay/Evaluation | trace replay + experience candidate | 能解释每次重要写入原因 |

| 行为测试 | 必须满足 |
| --- | --- |
| 不存在的历史 | 不得生成“我们之前说过” |
| 已知偏好 | L2 召回且可追来源 |
| 准确原话/日期 | L3 或 evidence_unavailable |
| 时间不同的新旧事实 | 形成 evolution/version |
| 同有效期互斥 | 进入 conflict，不静默覆盖 |
| 重复召回 | reinforcement_count 不增长 |
| 长期未访问核心事实 | salience 可降；validity/confidence 不随时间自动降 |
| Memory Backend 断线 | 继续运行并说明无法验证历史 |
| 情绪低置信 | 调制减弱/unknown；不改关系 |
| 重复安慰风格 | saturation 生效 |
| API/Observer/Evaluator 断线 | World/State/Canonical Memory 可恢复 |

## 36. V0.4.1 冻结规则

1. NOW ≠ PAST：PrivateWorld 负责现在；Memory/Archive 负责过去。

2. Recall ≠ Verification ≠ Learning：找到、证实、写入是三个不同阶段。

3. 宁少勿假：证据不足或后端故障时允许不知道，不允许编造连续性。

4. 遗忘 ≠ 删除：时间默认衰减 Salience，不直接衰减 Confidence/Validity。

5. Salience ≠ Confidence；Validity ≠ Recall Freshness；Reactivation ≠ New Memory。

6. 普通 L2 Recall 不产生 Reinforcement；只有独立新证据/明确确认才强化。

7. 同一轮最多一次 L3；仍不足则 context_insufficient。

8. CanonicalMilestone 锁定历史事件，不锁死当前关系。

9. Observed User Affect 是带置信推测，不是用户内心事实；不得直接改关系。

10. Self Affect、Observed User Affect、Relationship State 分开存储与更新。

11. 随机性只进入 Expression，不得改变事实/记忆/关系/权限/Action 结果。

12. Expression Profile 必须版本化、可回滚，并由真实评价支持。

13. 外部模型一律通过 Adapter；连续状态不能绑定某供应商。

14. Embedding/Reranker/Affect/Evaluator/Presentation 必须可降级。

15. 事实写权属于 Memory Gate / Reducer / Validator，不属于 LLM。

16. 重要写入必须保留 trace_id、source/evidence、schema/policy version 与 rollback path。

| V0.4.1 工程完成定义： 在模型可替换、网络会中断、历史可能冲突、情绪只能不确定推测的条件下，系统仍能持续运行，并明确回答“现在是什么、过去证据是什么、哪些只是候选、为什么这样表达、为什么这样写入”。 |
| --- |

## 附录 E：V0.4.1 早期方案吸收清单

| 输入材料 | 本版吸收 | 本版不直接继承 |
| --- | --- | --- |
| 情境召回_整合定稿技术文档 | L0-L3、QueryPlan、Rerank、L3、Verification、Memory Gate、降级 | 具体阈值只作 tunable |
| 情境召回_V2.3 生命周期补丁 | Salience/Confidence/Validity 分离、Decay、Reactivation、anti-self-reinforcement | 固定 decay 参数不冻结 |
| 1阶段 | 骨架/关系私有化、R-Lock 思想、表达特征生长、留白/拒绝/安慰 | 私人里程碑、单一关系权重、固定阶段 |
| 2阶段 | 轻模块常驻、按需多模态、HTTP/SSE、异步任务 | 旧模型名/旧资源预算 |
| 感情系统-情绪模块 / 感情系统 | 情绪不改关系、长期基线+短期波动、饱和度、异步/降级 | TinyBERT 绑定、悲观优先作为通用规则 |
| 米哈游 AI 架构二次总结 | 类脑分层、角色表达、Reward/评测、数据飞轮 | 具体模型/价格/百分比/达成率 |

| 版本关系： V0.4 是总体认知/运行架构；V0.4.1 是工程契约层。后续若只是实现参数和组件替换，继续使用 0.4.1.x；只有一级模块或主体边界改变时再升 V0.5。 |
| --- |

— V0.4.1 工程化架构基线结束 —
