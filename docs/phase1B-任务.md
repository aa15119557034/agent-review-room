# 任务板 · Phase 1B：外观、聊天空间、参与者、讨论室待办

依据：`docs/design/ADR-002-讨论室模式.md`、`docs/design/ADR-003-聊天空间.md`（提议中）、`docs/design/ADR-004-多模态和插件.md`（提议中）。
顺序按用户 2026-10-23 的选择：外观 → 聊天空间 → 参与者（控制台、额度、替补）→ 讨论室待办（原「工作部分」，已并进讨论室标签）。

可以并行（汐评审意见）：C-32 → D-30、C-39 → D-33 不必等外观验收，可以和 C-34 同时进行。

| 并行道 | 任务 | 估算（汐） |
|---|---|---|
| A | C-32 → D-30、C-39 → D-33 | 1～1.5 天 |
| B | C-34 → D-31a → D-31b → D-31c | 5～8 天（汐，含回答位、撤回、记忆清单） |
| C | C-36 → D-32 → X-32 | 2～3 天 |
| 贯穿 | 迁移真库副本、重启读回、e2e | 1～2 天 |

每个小阶段都要用户验收后再进入下一个。契约（C-）都是单独 PR，用户合并 = 批准。

---

## 第 0 步：你

- [ ] 批准 ADR-003 和本任务板（合并这个 PR）
- [ ] 1B-2 开始前：在主控机上给聊天用的 Codex 登录一次（新的 `CODEX_HOME`，Claude 带着做）
- [x] ~~1B-2 开始前：告诉 Claude 每位的「记忆文件夹」放在哪台电脑的哪里~~ 江浩 2026-10-25 定：秘书们自己安排，布局见 ADR-003 §2a

## 1B-0 模型选择（用户 2026-10-23 定为最优先，排在 C-34 之前）

用户定的默认值：汐固定 DeepSeek V4.1 Flash 1017（`deepseek-flash`），强度「高」；C酱 首选 Opus 5.5、备选 Sonnet 5.5；林离 首选 GPT-6.1 Sol、备选 GPT-6 Astra。C酱和林离：聊天、讨论室发言用「中等」，汇总用「高」。备选只在起草时换（确认页写明），盖章后不再换。

合并顺序（汐的评审）：C-40 先不单独合并，等 D-35、C-41 和 X-33 做好后连着合，不留类型检查变红的窗口。

| ID | 负责 | 内容 | 依赖 | 验收 |
|---|---|---|---|---|
| **C-40** | Claude | 契约：节点 health 按 profile 报可用模型和强度档位（`profileModels`）；`StartRun.model`；`unknown_model`；参与者的 `modelSettings`（首选 / 备选 / 三个场合的强度）；`BatchItem.model`；`batch.approve` 的 `expected` 带 model | — | 用户批准 |
| **S-22** | Claude | 节点：用 `run try` 实测三家 CLI 的准确模型名和档位名（要明确回答 deepseek-flash 有没有可传的强度参数），写进节点配置并在 health 里上报；把 `StartRun.model` 翻译成 CLI 参数（不在列表里就拒绝，不就近取档）；DeepSeek 默认改成 `deepseek-flash` | C-40 | 每个 profile 用每个模型各跑一次真实请求；传列表外的模型 / 档位被拒（`unknown_model`）；CLI 参数只来自节点配置里的映射，不直接拼请求里的字符串 |
| **D-35** | DeepSeek | 迁移 + 保存 `modelSettings`；起草时按 C-40 的规则定下 `BatchItem.model`；盖章时比对 `expected.model`；Run 启动时带上 `StartRun.model`；老节点（不报 `profileModels`）不带 | C-40 | 单测覆盖：首选可用 / 只有备选可用 / 都不可用（`agent_unavailable`）；跟随 profile 的四条路径（没报 `profileModels`、没有这个 profile、`models: []`、首选为 null）；强度 `configured` / `node_default` / `none`；重试和恢复沿用原模型、原模型不可用时重选；`expected.model` 的模型不一致、强度不一致、null 对非 null 各自整批 `stale_snapshot`（message 写明是谁、哪一项），`usedFallback` / `effortSource` 不同不影响；1A 真库副本迁移后旧批次 `model` 读出来是 null、参与者是 `DEFAULT_AGENT_MODEL_SETTINGS`、旧批次仍能盖章。节点探测结果要带上 `profileModels`（现在只有 `profiles`） |
| **C-41** | Claude | 界面：推荐配置写入用户定的默认值（Codex 节点默认是 `low`，所以 `medium` / `high` 要明确保存）；秘书资料页的模型选择和强度拉条（档位由节点报告，弹性动画）、确认页逐人显示模型和强度、用了备选时标出；mock 同步 | C-40 | mock 下三位都能改并保存；确认页标出用了备选的人和强度改用节点默认的人；模型没有档位时拉条不出现，显示「这个模型没有强度档位」，不能看起来设置成功 |
| **X-33** | Codex | e2e 适配和补测：`harness` 的批次类型复用 `ApprovalBatch["items"]`，`expected` 用 `toRunModel` 从真实批次逐项构造（不一律填 null）；FakeNode 可选上报 `profileModels`，记录实际 StartRun 的 model | D-35、C-41 | 老节点：批次和 expected 都是 null，StartRun 省略 model；可选模型：讨论发言 `medium`、汇总 `high`，首选不可用时节点收到备选 id，传输里没有 `usedFallback` / `effortSource`；只改 expected 的模型 / 强度 / null 互换各自整批 `stale_snapshot`，没有新 Run、假节点没有新 StartRun（内容 hash 不变） |

## 1B-1 外观

| ID | 负责 | 内容 | 依赖 | 验收 |
|---|---|---|---|---|
| **C-32** | Claude | 契约：头像存储方式（`avatarRef` 的格式、图片存在哪）、聊天背景设置 | — | 用户批准 |
| **D-30** | DeepSeek | 头像上传 / 读取（main 里存进 userData，renderer 只拿引用）：按文件头判断真实类型、大小上限、原子写、文件名用 ULID、替换时清旧文件 | C-32 | 重启后头像还在；非图片（含改扩展名的 exe）被拒；引用不存在或用途不对被拒；选图对话框可注入，单测覆盖（CI 打不开系统对话框） |
| **C-33** | Claude | 外观：苹果风格 + 微信用法（画布《1B 外观草案》）；桌面和手机布局；讨论室按新排版重做（三栏、轮次胶囊、汇总标签、新建议题页、按住盖章、右栏可收起）；动画尊重「减少动态效果」 | C-32 | 用户看过说「不粗糙了」；按住盖章：按 999ms 松手、再推进时钟过 1 秒，`batch.approve` / `plan.finalize` 调用 0 次、状态不变；移出 / 失焦 / 页面隐藏 / 变灰清计时；按满只发一次；普通点击和键盘绕不过 |

## 1B-M 多模态（ADR-004）

按林离评审拆成两段：**1B-M1** 在 1B-0 之后，可以和 C-34 并行；**1B-M2**（D-39 沉浸模式）随 1B-2，等 C-34、D-31b 落地后再做。验收细节见 ADR-004「分阶段」。

| ID | 负责 | 内容 | 依赖 | 估算 |
|---|---|---|---|---|
| **C-42a** | Claude | 契约：图片、附件清单、`vision` 三态、`capabilities.attachments`、图片引用表和用途 | ADR-004 | 0.5 天 |
| **C-42b** | Claude | 契约：MediaJob、`kind: "image"` 的 Run、生成图回传、DrawRequest、GeneratedImage、Codex 额度 | ADR-004 | 1 天 |
| **C-42c** | Claude | 契约：SpeechClip、VoiceProfile、`replyAsVoice` | ADR-004 | 0.5 天 |
| **C-42d** | Claude | 契约：ChartSpec、MediaIntent、沉浸模式设置 | ADR-004 | 0.5 天 |
| **C-42e** | Claude | 契约补漏（C-43 开工时发现）：秘书回答上存合格的媒体意图 `mediaIntent` 和沉浸模式退回原因 `immersiveDeferred`，界面才能显示画图请求卡 /「想用语音说」 | C-42d | 0.2 天 |
| **C-42f** | Claude | 契约小补（#114 汐提出）：`media.list` 加可选 `messageIds`（只用于 chat 范围，最多 14 个，每条消息每类（画图 / 语音）返回最新 5 条 + 最新一条成功的 + 最新一条没结束的，最多 7 条，14 × 2 × 7 ≤ 200，保证每条、每类都查得到，成功画过的图不会被后来的失败挤掉；挑法见 `pickMessageMediaJobs`），会话累计超过 200 条任务后旧消息的图仍找得回来、请求卡不重复出现；`speakableText` 的占位匹配上界放到 1200（提示词最长 1000 字，加上「[我画的图：」前缀） | C-42e | 0.2 天 |
| **S-23** | Claude | 节点：看图实测、收附件并按清单校验、请求体 16 MB、`kind: "image"` Run 和生成图回传 | C-42a、C-42b | 2～3 天 |
| **S-24** | Claude | 节点：读 Codex 额度（2 秒超时）并上报、实测单图消耗；S-21 的 Codex 部分提前，C-36 复用 | C-42b | 1 天 |
| **D-36a** | DeepSeek | 图片处理管道（去全部元数据、转正、确定性输出、拒动图 / HEIC） | C-42a | 1.5～2 天 |
| **D-36b** | DeepSeek | 附件清单进指纹、盖章和起跑重读比对、图片本体 + 引用表、数据库迁移；main 注册 `room-image://`（按引用表查本体、只读、不可导航、只认 `img_…`，其余 404） | C-42a、D-36a | 1.5～2 天 |
| **D-37a** | DeepSeek | 语音合成试听（三个候选盲听） | C-42c | 2～3 天 |
| **D-37b** | DeepSeek | 语音合成集成（独立进程、缓存、MediaJob）；朗读文本只用契约的 `speakableText`，不另写过滤 | D-37a | 2～3 天 |
| **D-31d** | DeepSeek | 秘书回答存 `mediaIntent`（C-42e）：迁移给 `chat_messages` 加可空列（旧行读回省略）、`insertChatMessage` / `toChatMessage` 读写、写回答时调 `extractMediaIntent`（里面用契约里的 `speakableText` 判 speak 字数），被丢的原始值记审计；`immersiveDeferred` 留给 D-39 | C-42e、D-31b | 0.5 天 |
| **D-38a** | DeepSeek | 画图 · 本机 ComfyUI、全局显卡队列、MediaJob。验收含：沉浸模式的自动意图要么有任务（本机画不了就立刻 `failed(backend_unavailable)`），要么有 `immersiveDeferred`，不能都没有 | C-42b | 2～3 天 |
| **D-38b** | DeepSeek | **暂缓**（2026-11-01 用户决定画图先只走本机，ADR-004 §3；恢复前先由江浩决定，再看 #133 的单图实测和当时 5 小时窗口的余量定 85% 线）。画图 · 林离 + 85% 选路 + 回退 | C-42b、S-23、S-24、D-38a | 2～3 天 |
| **C-43** | Claude | 界面：图片、图表、画图卡、语音、沉浸设置和「停」、议题材料带图（先对着 mock 做，接真后端要 D-31d） | C-42a～e | 3～4 天 |
| **X-34a** | Claude（2026-11-01 从林离转来） | Prompt（`core/src/discussion/chat.ts`）：回答格式说明（reply / skip 的 JSON、`room-chart`、`speak` / `draw`，例子由测试交给契约解析函数核对）、历史里的图 / 文件只给名字占位、画过的图给「[我画的图：提示词]」、当前图名进资料区，全部转义；`replyRequired` 入参 | C-42a、C-42d、D-36b | 0.5 天 |
| **D-41** | DeepSeek | 接线：main 的 `chat-prompt.ts` 和 `test/chat-prompt.test.ts` 删掉（或迁到 core 测试），`chat.ts` 改用 core 的 `buildChatSnapshot`（传 `summaries`、`memorySource`、`replyRequired = slot.required`）；撤回时摘要标 stale（X-30 遗留） | X-30、X-34a | 0.5～1 天 |
| **X-34b** | Claude（2026-11-01 从林离转来） | 确定性 e2e（ADR-004 X-34 验收那一行）：假节点收到的 StartRun 里图片块在资料区、在当前用户消息之前，sha256 和清单一致；畸形媒体意图记失败且没有媒体任务；沉浸模式关着时 `speak` 不合成；图里写「画一张」不会自动画。讨论室的「最近一轮」规则等议题材料有带图入口时再做。**2026-11-01 进度**：全部已做——畸形意图、沉浸关着（e2e #12/#13），图片送到节点、图里写「画一张」不自动画（e2e #14/#15；接线 #145 / #147 / #148） | D-41、X-31 的聊天 e2e 骨架 | 1～1.5 天 |
| **D-42** | DeepSeek | 聊天图片送到节点（main 这半）：`chat.send` 收下图片（引用校验）、按节点 `capabilities.attachments` + 这次模型的 vision 决定带不带，带图时把清单交给 `buildChatSnapshot`、起跑时把字节和 `imageSlot` 交给 Adapter；看不到图的收「[图片：名字]」占位；Snapshot 的 `imageSlot` 落库（迁移 v15） | C-42a、C-42g、C-42h、D-41 | 0.5～1 天 |
| **D-39** | DeepSeek | 沉浸模式（1B-M2），含写 `immersiveDeferred` | C-34、D-31b、D-31d、D-37b、D-38a（D-38b 暂缓期间只接本机画图）、C-43、X-34a、D-41 | 4～6 天 |

排法：D-31d 先做（小，C-43 接真后端靠它）；D-36 和 C-34 并行；D-37a 先做，用户选定后再 D-37b；D-38a 不等 S-23；D-39 排在 D-31b 之后。D-36～D-39 合计约 15～22 天，和 D-31a/b/c 都是汐的活，1B-2 大约推后 1～2 周。

## 1B-2 聊天空间

| ID | 负责 | 内容 | 依赖 | 验收 |
|---|---|---|---|---|
| **C-34** | Claude | 契约：Conversation / ChatMessage（结构化的 @ 收件人、`replacesMessageId`、撤回状态）/ 回答位（唯一键 用户消息 id + Agent，独立的 `ChatSlotOutcome`）、语音 / 表情 / 文件字段（图片、画图、语音合成的类型引用 C-42a～d，不重复定义）、记忆槽位和记忆清单（只存 id + hash）、Run 上的 Snapshot hash 与最终 hash、`chatPersona` / `memorySource`、聊天命令 / 查询 / 事件、`chat.toTopic` | ADR-003 | 用户批准 |
| **D-31a** | DeepSeek | 迁移（编号按合并顺序取下一个；v4 已被 D-35 用掉，D-36b 也要一个）+ 读写模型：会话 / 聊天消息 / 回答位、新字段（可空）；索引（会话按最近活跃、消息按会话+时间分页）；迁移前自动备份 `room.db.bak-v<旧版本>`，一个事务做完，可安全重跑 | C-34 | **拿 1A 真库副本**迁移：旧数据 digest 不变、新表为空、`foreign_key_check` 通过；迁移后重启全部读回 |
| **D-31b** | DeepSeek | 发送与回答编排（@ 规则、撤回 / 重新编辑见 ADR-003 §2）：回答位 + Run 同一事务；不可用的人记缺席、其他人继续；单独重试；防重复（用户消息 id）；硬上限；聊天 Run 进中断修复 | D-31a | 每个 Run 恰好一个终止事件；没点名时只有明确 `skip` 才记「不回答」（空输出 / 超时 / 缺席各走各的；单聊和被点名的 `skip` 算失败）；5 分钟撤回 / 重新编辑（先落库再中止，撤回瞬间答完的结果被丢弃；旧 Snapshot 不能被重试重放；重新编辑是新消息，旧回答位不复活）；3 人中 1 人失败：看得出是谁、能单独重试、不重发另外两人；强杀后重启没有转圈的 Run |
| **D-31c** | DeepSeek | 一键转议题：选中的消息作为初始材料，建议题和材料在同一事务；已撤回的消息不能选 | D-31b | 转出的议题能正常跑一轮 |
| **X-30** | Codex | `core/src/discussion/` 旁边加聊天 Prompt 拼装：聊天人设 →（不可信边界：会话历史压缩、历史摘要、Agent 发言、附件、记忆槽位）→ 当前用户消息；导出边界包裹函数给节点填记忆用 | C-34 | 同一输入 hash 相同；用已知 nonce 在记忆文件名 / 正文、历史消息 / 摘要、附件里伪造结束标签，都不能闭合边界；断言当前用户消息在边界外，Agent 消息和摘要在边界内 |
| **S-20** | Claude | 节点：三个聊天 profile（无工具；Codex 单独 `CODEX_HOME`）；节点填记忆槽位并回报记忆清单和最终 hash；节点用低权限账号运行的说明和脚本。按 ADR-003 §2a：在每台电脑选定的 `<AgentRoom>`（不一定在 C 盘，必须本机 NTFS，写进节点配置 `homeDir`）下建布局和权限；一位秘书一个账号一个节点（计划任务以 `agentroom-<秘书>` 运行，`runAsUser` 不对就拒绝启动）；profile 的 `memory` 配置和「文件夹」读法（预算、core 规则、排序按 §2a）；主控机按 §2a「切换顺序」：先起 7421（`agentroom-codex`），D-40 迁移完成后才把 7420 切成 `agentroom-deepseek` 并建汐的记忆文件夹 | C-34、X-30 | **三条分开测，都用真实启动的三个 profile**：① 不能用工具：检查启动参数的工具 / 权限配置，实际尝试调命令被拒；② 文件隔离：能读指定记忆，尝试写 / 删 / 改记忆文件、读写用户数据里的哨兵文件全部被拒，前后文件 hash 不变；`..`、Windows junction / 符号链接越不出记忆目录。③ 账号隔离：切换完成后实际在跑的林离讨论 / 聊天 profile 读汐的记忆文件夹、读汐节点的 Token 被系统拒绝；7420 配置里带 `codex-*` 时节点拒绝启动；节点进程的用户是 `agentroom-*`，用江浩的账号启动被节点拒绝；④ 挑记忆的边界：core 缺失或为空 / core 超预算 / core 有文件超 `maxFileBytes` / core 超 200 个 → `unavailable`；`journal` 两种文件名混用时按日期排对；`memory.dir` 指向别的秘书的文件夹时启动报错；`memory.json` 缺失 / 损坏 / 越界 → `unavailable`；非 NTFS 的 `homeDir` 被拒；`mklink /H` 硬链接被跳过；同一份文件用 `robocopy /COPY:DAT` 复制后挑出的清单不变。（系统运行库、登录信息和临时缓存不在「其他用户数据」范围内，验收里写明） |
| **C-35** | Claude | 聊天界面（按手机宽度设计）：会话列表、单聊 / 群聊、@、记忆来源标记、选消息转议题 | C-34 | mock 下跑通单聊、群聊、转议题 |
| **D-34a** | DeepSeek | 聊天文件 + 静态表情库（沿用 C-32 引用规则；按内容去重；大小 / 数量上限；1B 不解析 PDF / Word） | C-34 | 文件按文件头判断类型；GIF 被拒；重启后都在（2～3 天） |
| **D-34b** | DeepSeek | 语音转写：先 spike（10 段真实录音，在主控机 CPU 上测速度、错字率、加载时间、内存），再集成为独立进程；main 注册 `room-audio://`（和 D-37b 合成的语音共用一个处理器，规则同 `room-image://`，只认 `aud_…`） | C-34 | 断网也能转写；快于实时（3～5 天，含 spike） |
| **X-31** | Claude（2026-11-01 从林离转来） | e2e：聊天 → 转议题 → 跑一轮；@ 规则（单聊、@一人、@所有人、没点名的 reply / skip 混合、正文里打 @ 但没选人、空输出 / 超时 vs 明确 skip，没有自动下一轮）；撤回（用唯一哨兵串：撤回后发给每位的 Snapshot、节点请求、压缩历史、转议题材料都不含它，数据库审计仍能读到；5 分钟边界；别人的消息不能撤；迟到结果不回流；重新编辑后旧回答位不复活） | D-31c、C-35 | 自动测试通过 |

## 1B-3 参与者

| ID | 负责 | 内容 | 依赖 | 验收 |
|---|---|---|---|---|
| **C-36** | Claude | 契约：`round.draft` 的替补参数、额度状态（按 profile 报告，读不到 = 未知）。**定稿内容**：`RoundSubstitutions`（absent / substitute 成对，不做替补链）挂在 `round.draft` / `round.redraft`（省略 = 自动按 `AgentProfile.substitute`；redraft 省略 = 沿用）和 `round.retry.substitute`（答到一半额度用完 → 让替补代答）；节点额度端点加 `balance`（按量计费的余额）；`quotaState()` 判 ok / exhausted / unknown，未知不算缺席 | — | 用户批准 |
| **S-21** | Claude | 节点实测并上报额度：Claude `rate_limits`、DeepSeek 余额（Codex 部分已提前到 1B-M 的 S-24）。做法：Claude 从每次 Run 的 stream-json 里的 `rate_limit_event` 记最近一次（`quota.source = claude-stream`，不额外花额度，节点刚启动时未知）；DeepSeek 读 `/user/balance`（`deepseek-balance`，Key 只从 envAllowlist 里的环境变量读） | C-36 | 读得到的显示数字，读不到的显示「未知」，不猜 |
| **D-32** | DeepSeek | 额度汇总（不猜，只聚合 C-36 上报的）、自动缺席、替补派发；替补链防环、替补也不可用时记缺席；同一人同一轮不重复记缺席 | C-36 | 额度用尽 → 自动缺席，汇总表正确显示 |
| **C-37** | Claude | Agent 控制台（每位一页：状态、额度、正在答什么、历史、暂停 / 恢复、替补设置） | C-36 | mock 下所有状态都能显示 |
| **X-32** | Claude（原 Codex，2026-11-01 改派） | 把 0-B #10 从「写库模拟」改成走替补命令。**做法**：假节点加 `GET /v1/profiles/:id/quota`（没给 = 404），#10 拆成 a 自动替补 / b 显式替补与 `[]`、替补也用完 / c 答到一半用完 → `round.retry` 带替补、旧 Turn 接上、不能派第二个 / d 粘滞缺席（读不到不清、读到 ok 才清） | D-32 | #10 完整覆盖 |

## 1B-4 讨论室待办

| ID | 负责 | 内容 | 依赖 | 验收 |
|---|---|---|---|---|
| **C-38** | Claude | 讨论室标签：议题列表 + 一句话状态、待办角标、只读时间线 + 原有动作按钮（不新增命令） | 1B-2 | 只用讨论室标签完成一轮：发送 → 汇总 → 定稿 |

## 顺手一起做（小）

| ID | 负责 | 内容 |
|---|---|---|
| **C-39** | Claude | 契约：`node.importLocalToken`（主控机节点一键从本机读取 Token，main 直接加密保存，renderer 只拿到「已保存」） |
| **D-33** | DeepSeek | 实现 C-39：只对 `controller-local`（之后由 C-44 扩成本机节点白名单）；token 路径来自节点配置，**不能由 renderer 传路径**；校验长度、只进 safeStorage、不回显不写日志；导入后自动测一次连接。可以和 D-30 并成一个 PR |
| **C-44** | Claude | （S-20 配套，不算小活；依赖 C-39 / D-33 已合并；验收：用户批准）契约：`node.importLocalToken` 的 id 改成本机节点白名单（`controller-local`、`controller-local-codex`），每个 id 一个 main 里的 Token 文件路径（ADR-003 §2a） |
| **D-40** | DeepSeek | （S-20 配套，不算小活；依赖 C-44；迁移编号按 D-31a 的规则；真库副本验收）实现 C-44；推荐配置里林离改指 `controller-local-codex`（7421）；数据库里林离的参与者迁到新节点，真库副本验证讨论和聊天都走新节点 ；验收：桌面端以江浩的普通账号（不提权）一键导入 7420、7421 两份 Token 并连接成功 |
| **C-42i** | Claude | 契约小补：`chat.send` 里图片附件可带 `chat.attachment.pick` 返回的原文件名（`ChatImageInputName`，可选，只用于显示和资料区图名，不能带路径和控制字符）；不带时 main 照旧用「图片.<扩展名>」。文件名仍只从 main 的记录取 |
| **D-43** | DeepSeek | 实现 C-42i（依赖 C-42i）：`main/chat.ts` 的 `#resolveAttachment` 有 `name` 就用它，没有才用「图片.<扩展名>」占位；补 chat-ipc 测试（带名字 → 消息、清单、资料区都是原名；不带 → 占位不变） |
| **C-45** | Claude | 界面（依赖 C-42i；接真后端要 D-43）：发图时带上原文件名；发出去的带图消息下面按这次实际的 Snapshot 标出「某某这次看不到图」（`chat.snapshots.get` 的 `attachments` 为准，不按发送前的探测猜） |

## 1B 验收

- 1B-1～1B-4 各自的验收都通过
- 聊天里无法触发任何文件改动或命令（S-20 的测试）
- 全部单元测试、类型检查、e2e 通过，附实际命令和输出
- 写 `docs/Phase1B-验收记录.md`
