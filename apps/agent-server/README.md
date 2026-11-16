# @room/agent-server — 执行节点

负责：Claude（S-01 骨架、S-02 Windows + Claude CLI）｜ 审查：DeepSeek

运行在**执行节点电脑**上，接收主控端的评审请求，在本机启动 `claude -p`（使用这台电脑上登录的 Claude 订阅），把回复流式传回主控端。设计见 `docs/design/ADR-001-远端执行节点.md`，协议见 `packages/schemas/src/remote-protocol.ts`。

```
主控端（DeepSeek 的电脑）  ── 局域网 HTTP + Token ──▶  本机 AgentServer :7420 ──▶ claude -p
```

## 在执行节点（Windows）上第一次设置

在 PowerShell 里，进入仓库目录：

```powershell
# 1. 确认 Claude Code 已安装并登录（会用掉一点订阅额度）
#    用英文测试：Windows PowerShell 5.1 往管道写中文默认会变成 "?"（AgentServer 自己写 stdin 用 UTF-8，不受影响）
"Reply with exactly one word: hello" | claude -p

# 2. 安装依赖（第一次；只装节点需要的部分，不用装 Electron）
pnpm install --filter "@room/agent-server..."


# 注意：setup / start 前面必须有 run——pnpm 自带同名的 `pnpm setup` 命令，不加 run 会跑成那个
# 3. 一键准备：生成配置、Token、Reviewer 用的空文件夹，并打印要填到主控端的信息
pnpm --filter @room/agent-server run setup

# 4. 启动
pnpm --filter @room/agent-server run start
```

第 3 步会打印类似：

```
在主控端的设置页填写：
  地址：http://192.168.1.20:7420      ← 代理软件的虚拟网卡（198.18.x.x）不会列出来
  评审方式：claude-review
  Token：3f9a…（64 位）
```

把这三项填到主控端"设置 → Reviewer 节点"，点"测试连接"。

第一次启动时 Windows 会弹出防火墙提示，选**允许"专用网络"**。如果没弹出、主控端连不上，用管理员 PowerShell 执行：

```powershell
netsh advfirewall firewall add rule name="Agent Review Room 7420" dir=in action=allow protocol=TCP localport=7420 profile=private
```

## 主控机本机节点（S-10：讨论室里的 Codex 和 DeepSeek）

主控机（DeepSeek + GPT 那台）上也跑一个 AgentServer，**只监听 127.0.0.1**（局域网里别的电脑连不上），给讨论室提供两种方式：

| profile | 实际运行 | 用的是谁的额度 |
|---|---|---|
| `codex-discuss` | `codex exec --json --skip-git-repo-check --sandbox read-only --ephemeral [-m 模型 -c model_reasoning_effort=档位] -` | 这台电脑上 `codex login` 登录的 ChatGPT 账号 |
| `deepseek-discuss` | `node ../bin/deepseek-chat.mjs [--model 模型 --effort 档位]`（不传默认 `deepseek-flash`） | 环境变量 `DEEPSEEK_API_KEY` 对应的 API 余额 |

```
主控端 ──127.0.0.1──▶ 本机 AgentServer :7420 ──▶ codex exec / deepseek-chat.mjs
       ──局域网────▶ 你的电脑 AgentServer :7420 ──▶ claude -p          （Phase 0 已有）
```

在主控机的 PowerShell 里，进入仓库目录：

```powershell
# 1. 装 Codex 命令行并用 ChatGPT 账号登录（会打开浏览器）
npm install -g @openai/codex
codex login
#    测试：应该回一个 hello（会用掉一点额度）
"Reply with exactly one word: hello" | codex exec --skip-git-repo-check -

# 2. 设置 DeepSeek 的 API Key（只存在这台电脑的用户环境变量里，不进仓库、不进日志）
#    把 sk-… 换成你自己的 Key；设置后要**关掉 PowerShell 重新打开**才生效
[Environment]::SetEnvironmentVariable("DEEPSEEK_API_KEY", "sk-…", "User")

# 3. 安装依赖（第一次）
pnpm install --filter "@room/agent-server..."

# 4. 生成本机配置（注意 -- --local）
pnpm --filter @room/agent-server run setup -- --local

# 5. 启动
pnpm --filter @room/agent-server run start
```

启动后，在**另一个** PowerShell 窗口里各试一次（不经过主控端，直接问本机节点；会用掉一点额度）：

```powershell
pnpm --filter @room/agent-server run try -- codex-discuss "用一句话介绍你自己"
pnpm --filter @room/agent-server run try -- deepseek-discuss "用一句话介绍你自己"
```

回复会实时打印出来，最后一行是 `—— 结束：completed …`（成功）或 `—— 结束：error（原因）…`。

第 4 步会打印 `地址：http://127.0.0.1:7420`、`可用的方式：codex-discuss、deepseek-discuss` 和 Token。没设置 Key 时会提示，但不会打印 Key 本身。

**额度用尽**（C-25）：解析器从结构化输出里认出"额度用尽 / 限流"时，节点报告 `error(quota_exhausted)`，讨论里显示为「缺席（额度）」，其他人继续：
- Codex：`turn.failed` 或未完成时的 `error`，消息里有 usage limit / rate limit 等
- DeepSeek：HTTP 402（余额不足）或 429（限流）
- Claude：`result.is_error` 且消息里有 usage limit，或 `api_error_status: 429`

认不出来的失败照旧是 `process_exit_nonzero` / `internal`，不猜。

**额度显示（1B，待实测）**：5 小时 / 每周用量只读官方提供的数据——Claude 的 statusline JSON（`rate_limits`），Codex 的 `codex app-server` 接口（`account/rateLimits/read`），DeepSeek 的 `GET /user/balance`。不读本机登录凭据、不调用未公开的接口；读不到就显示「未知」。真机结果联调时写在这里。

## 模型和思考强度（S-22）

每个 profile 能选哪些模型、每个模型有哪些强度档位，写在配置文件的 `models` 里，节点在 `/v1/health` 原样上报（`profileModels`），秘书资料页的下拉框和拉条就是按它画的。主控端在 StartRun 里只传模型 id 和档位 id，节点先核对清单（不在清单里就拒绝 `unknown_model`，不换模型、不就近取档），再按 `modelArgs` / `effortArgs` 把它翻译成命令行参数：

| profile | `modelArgs` | `effortArgs` | 清单（2026-10-23 实测） |
|---|---|---|---|
| `claude-review` | `--model {model}` | `--effort {effort}` | `claude-opus-5-5`、`claude-sonnet-5-5`；low / medium / high / xhigh / max。`claude-haiku-5-5`；low / medium / high（2026-11-12 云端 Linux、claude 2.1.322 实测三档都正常回答；xhigh / max 没测，所以没列） |
| `codex-discuss` | `-m {model}` | `-c model_reasoning_effort={effort}` | `gpt-6.1-sol`、`gpt-6-astra`；low / medium / high / xhigh / max / ultra |
| `deepseek-discuss` | `--model {model}` | `--effort {effort}`（脚本发成 `reasoning_effort`） | `deepseek-flash`；low / high / max |

- 参数默认加在 `args` 最后；`args` 里写了 `"{model-args}"` 就插在那个位置（Codex 要插在最后的 `-` 前面）
- 请求里没带模型（老主控端，或秘书设成「跟随 profile」）时，什么都不加，用 CLI 自己的默认
- `models` 为空的 profile 上报 `models: []`，表示模型写死在 `args` 里，带模型的请求会被拒绝
- 档位名一定要用实测过的：`claude` 遇到不认识的 `--effort` 只打警告、照常回答，所以只能靠这份清单拦住
- 启动时会把每个模型、每个档位拼出来的命令都检查一遍，配错了直接报出来

试某个模型和档位：

```powershell
pnpm --filter @room/agent-server run try -- codex-discuss --model gpt-6.1-sol --effort medium "Reply with exactly one word: hello"
```

**已经有配置文件的电脑**：`setup` 不会覆盖已有的配置。把 `agent-server.config.json` 改名备份，再运行一次 `setup`（Reviewer 电脑不带参数，主控机带 `-- --local`），Token 会沿用。自己改过配置的话，照示例把 `models`、`modelArgs`、`effortArgs` 三项抄过去，并去掉 `args` 里原来写死的 `--model …`。

## 看图和画图（S-23）

**收图**（契约 C-42a / C-42g）：主控端只给 health 里 `capabilities.attachments: true`、并且这次用的模型 `vision: "yes"` 的节点发图。节点再核一遍：

- 这次用的模型实测能看（`models[].vision` 或模型写死时的 `fixedModelVision`）并且 profile 配了 `images`，否则整个拒绝 `vision_unsupported`
- 每张图解码后的 sha256 和请求里写的一样，并且和 content 开头的附件清单块对得上，否则 `hash_mismatch`（422）。字节数对不上、base64 不规范、图的类型不认识，在更前面的格式检查就被拒绝，报 `bad_request`（400，只回字段路径）
- 同一个 runId 再提交时，图（sha256 列表）和 kind 也要一样，否则 `run_id_conflict`
- 请求体上限默认约 28.4 MB（契约的 `NODE_MIN_BODY_BYTES_WITH_ATTACHMENTS`：8 张图 base64 + 最长的 content）。调到这个数以下时节点不报能收图

**交给 CLI**：都写进 stdin，不落临时文件。content 里有一块格式固定、自带 nonce 边界的图片资料块（契约 C-42g 的 `attachmentImageBlock`），块里有图片位置标记 `[图片位置 <nonce>]`；节点按「标记前文字 → 图片（按编号）→ 标记后文字」交出去，不加、不删、不改任何文字。

| `images.input` | 给谁 | `images.args`（只在带图时加） |
|---|---|---|
| `claude-stream-json` | `claude -p`（parser 要是 `claude-stream-json`） | `["--input-format", "stream-json"]` |
| `openai-content-json` | `bin/deepseek-chat.mjs`（parser 要是 `room-jsonl`） | `["--input-format", "content-json"]` |

Codex：`codex exec` 只能用 `-i` 把图放在全部文字前面，做不到上面的顺序，按 ADR-004 §2 报 `vision: "no"`（不配 `images`）。以后要让林离看图，得改走 `codex app-server`，另提。

**实测谁能看**（ADR-004 §2：没测过就是 unknown，按看不了处理）：

```powershell
pnpm --filter @room/agent-server run vision-test -- claude-review --model claude-opus-5-5
pnpm --filter @room/agent-server run vision-test -- deepseek-discuss --model deepseek-flash
```

示例配置里 Claude 的三个模型都**没有**标 `vision`，所以刚装好时带图的消息会被拒绝（`vision_unsupported`）：要先在自己的电脑上按下面的办法每个模型测过 3/3，再自己写上。云端（2026-11-12）只用 Haiku 5.5 真看过一张图，认对了，但一次不够 3/3，不算数；Opus、Sonnet 没测。

每次随机画一张 6 位数字的测试图，按真 Run 的顺序交给 CLI，回答里的数字和图上完全一样才算通过（多一位少一位都不算）。每个模型连测 3 次，3 次都过才写 yes（云端用 Haiku 5.5 改版过程中跑过 9 次，有 2 次认错：一次把 0 认成 3，一次多读一位）。不用先启动节点。最后打印一行 JSON 验收记录，贴到 PR 或 issue 里；通过了再把那个模型的 `"vision": "yes"` 写进配置，重启节点。已实测：deepseek-flash（content-json）主控机 3/3 通过（#131），示例配置已写 yes。

**画图 profile**（契约 C-42b，`kind: "image"`）：配了 `imageRun` 的 profile 只接画图 Run，别的 profile 不接画图 Run（`unsupported_kind`）。

- `imageRun.outputDir`：节点专用的根目录。每个画图 Run 在下面新建一个 `<runId>` 子目录（已存在就不接管，报 `spawn_failed`），通过 args 里的 `{image-output-dir}` 或环境变量 `ROOM_IMAGE_OUTPUT_DIR` 告诉 CLI 把图写在那里
- 只从这次 Run 自己的子目录里取图：进程正常结束后取最新的一张（按文件头认 png / jpeg / webp，最多 10 MB），在终止事件里报 sha256、类型、字节数；没有图就是 `error(incomplete_output)`
- 结束时（不管成败）只删这次 Run 的子目录。根目录里别的文件、别的 Run 的子目录一概不碰，所以**不要把 outputDir 指向 CLI 自己的共享目录**（例如 Codex 的 `$CODEX_HOME\generated_images`：那里的文件证明不了是这次 Run 画的）
- 图读进节点内存，主控端用 `GET /v1/runs/<runId>/artifacts/<sha256>`（要 Token）取。取过之后再留 `leaseMs`，断线可以重取；结束后超过 `leaseMs` 没人取、或最后一次取过之后超过 `leaseMs`，就丢掉
- 节点启动时清掉根目录下上次没来得及删的 `run_<ULID>` 文件夹（只删这种名字的文件夹）
- 同一个画图 profile 同时只画一张（第二张 `node_busy`，ADR-004 §3 Codex 一次一张）；不同 profile 可以共用根目录，各取各的
- Codex 默认把图存在 `$CODEX_HOME\generated_images`，节点不去那里拿。做法：`codex exec -C {image-output-dir} --sandbox workspace-write …`，画图指令里让它「画完把图复制到当前工作目录」。主控机实测（#131，codex-cli 0.163.0、gpt-6-sol）**一次成功**：约 163 秒，图出现在 Run 目录。这依赖模型照做，D-38b 走 Codex 前再连测 2～3 次
- 注意：Codex 自己在 `generated_images` 里也会留一份（每张约 2.3 MB），节点不删，需要时手动清
- 讨论/聊天用的 Codex profile 加 `--disable image_generation`（实测能挡住自己画图，模型会先问），避免顺手画图白烧额度。被挡住后模型可能提议改走要 `OPENAI_API_KEY` 的 CLI 画图，`envAllowlist` 里没有这个变量，所以也走不通

## 读 Codex 额度（S-24）

契约 C-42b 的 `GET /v1/profiles/<profileId>/quota`：返回 5 小时窗口、每周窗口各用了百分之多少、什么时候重置，以及是否已经在扣付费 credits。主控端画图选路（D-38b：任一窗口 ≥ 85% 就走本机）靠它。

- 配置：在 Codex 的 profile 上加 `"quota": {"source": "codex-app-server"}`（示例配置的 `codex-discuss` 已加）。节点用同一个 `command` 起 `codex app-server`，按 stdio JSON-RPC 依次发 `initialize` → `initialized` → `account/rateLimits/read`，拿到结果就结束进程。额度是账号级的，配在哪个 Codex profile 上读到的都一样
- `envAllowlist` 要放行 `CODEX_HOME`（登录信息在那里），和跑 Run 一样不给别的变量
- **2 秒读不到就报「未知」**（含启动 app-server 的时间）：超时、出错、没登录、断网、字段缺失，对应各项都是 `null`，不是 0；端点仍然返回 200。失败原因记在节点日志里
- 窗口按长度认：300 分钟是 5 小时，10080 分钟是每周；长度缺失或是别的值，那一项报 `null`，不按位置猜
- `creditsInUse`：订阅额度还能用 → `false`；后端说不许再用订阅额度（`ordinaryUsageAllowed: false`）时，**两个窗口一律报 `null`**（百分比再低也不信，保证走本机），账户有 credits（或不限量）→ `true`，否则 `null`；读不准 → `null`
- 同一个 profile 同时只起一个 app-server，同时来的请求共用这一次的结果
- health 里 `capabilities.quota: true` 表示这个节点提供这个端点；没配 quota 的 profile 返回 404 `not_found`

实测（不用先启动节点）：

```powershell
pnpm --filter @room/agent-server run quota -- codex-discuss
```

打印一行 JSON。验收：读到的百分比要和 Codex 自己显示的一致（Codex 里 `/status`）；画一张图前后各读一次，差值就是单图消耗，写进验收记录；超过 10% 要拿回来请江浩重新定 85% 这条线。主控机实测（#133，codex-cli 0.163.0，已登录）：读到的数字和 Codex 原始返回一致；画一张图 5 小时窗口 +4%、每周 +1%，没超过 10%，85% 线不用重定；读一次约 2 秒，机器忙时偶尔超过 2 秒报「未知」（按规则走本机）。云端没登录的 codex 0.166.0 实测：161 ms 返回，各项为 `null`，日志记「codex account authentication required to read rate limits」。

### Claude 和 DeepSeek 的额度（S-21，契约 C-36）

同一个端点，按 profile 配的 `quota.source` 读：

- **Claude**：`"quota": {"source": "claude-stream"}`（示例配置的 `claude-review` 已加）。Claude 没有单独查额度的命令，但 `claude -p --output-format stream-json` 每次跑都会顺带输出一行 `rate_limit_event`（2.1.x 实测：`unifiedWindows.five_hour / seven_day` 的 `utilization` 是 0～1 的比例，`resetsAt` 是 Unix 秒，`isUsingOverage` 表示在不在扣超额）。节点把**这台节点上任何 claude-stream-json profile 的最近一次**记下来，读的时候直接给，不额外花额度
  - 换算：`usedPercent = utilization × 100`（超过 100 按 100），窗口 `status: "rejected"` 记 100；`creditsInUse = isUsingOverage`
  - 只在内存里：**节点刚启动、还没跑过 Run 时各项为 `null`（未知）**，主控端不会因此判缺席
  - 一个节点一个 Claude 账号时不用改；同一节点上有两个账号时给各自的 profile 配不同的 `"account"`
  - 这个 source 要求 profile 的 `parser` 是 `claude-stream-json`（启动时检查）
- **DeepSeek**：`"quota": {"source": "deepseek-balance"}`（示例配置的 `deepseek-discuss` 已加）。读 `GET https://api.deepseek.com/user/balance`，有人民币用人民币，`total_balance` 原样当余额（字符串），订阅窗口为 `null`
  - API Key 和跑 Run 用同一套环境：`DEEPSEEK_API_KEY`（可用 `apiKeyEnv` 改名）要么在 `envFiles` 里（安装脚本就是这么配的，每次现读文件），要么在 `envAllowlist` 里（启动时检查二者至少有一个）；只放进请求头，不打印、不回传
  - 2 秒读不到、HTTP 出错、没设 Key → 各项 `null`，原因记日志（日志里没有 Key）
  - 实测：`pnpm --filter @room/agent-server run quota -- deepseek-discuss`

主控端怎么用：`quotaState()`（契约）——任一窗口 ≥ 100% 或余额 ≤ 0 是用完，全部读不到是**未知（不算缺席）**。

## 独立网页检索（P2-S07 首片）

新增独立项目 profile，可在一次既有 Run 内执行一次 DeepSeek Search、最多一次 Fetch，返回完整正文、来源 hash、工具步骤和用量。需 health 能力声明及本次结构化结果 opt-in；不接聊天或模型内置搜索。配置、费用口径、真实测试和待接线范围见 [P2-S07 首片说明](../../docs/design/P2-S07-独立检索首片.md)。桌面检索入口尚未接通，不能把普通评审 Prompt 直接发给此 profile。

## 安全

- **监听 0.0.0.0**：局域网里的其他电脑能访问。所有请求都必须带 Token，否则 401
- Token 保存在 `apps/agent-server/agent-server.token`（已在 .gitignore 里），也可以用环境变量 `AGENT_SERVER_TOKEN` 覆盖
- **局域网内是明文 HTTP**：Token 和 prompt 在网络上不加密，只适合可信的家庭 / 办公网络。跨网络使用请走 Tailscale / WireGuard
- 请求里不能带命令：只能选这台电脑配置里写好的 profile
- `claude-review` 在空文件夹 `reviewer-sandbox/` 里运行，权限模式 `dontAsk`（需要批准的工具调用一律拒绝）、`--permission-prompts none`

## Windows 进程管理

- **`.cmd` 兼容**：npm 装的 `claude` 是 `claude.cmd`，不能直接 spawn。AgentServer 按 PATH + PATHEXT 找到真实文件：`.exe` 直接启动；`.cmd` / `.bat` 用 `cmd.exe /d /s /c "…"` 启动。为了安全，**参数里出现 cmd 特殊字符（`^ & | < > % ! " ( )`）会在启动时直接拒绝**，而不是尝试转义
- **终止进程**：一律 `taskkill /pid <pid> /T /F`，连同整个进程树。经 `cmd.exe` 启动时 pid 是 cmd.exe，`/T` 会把它下面的 node / claude 一起结束
- **租约**：主控端断开超过 `leaseMs`（默认 20 秒），节点自己结束评审，不会在后台一直消耗额度

## 输出解析（profile.parser）

`claude-stream-json`：解析 `claude -p --output-format stream-json --verbose --include-partial-messages`
- 增量文字 → `text_delta`（子 agent 的文字不算）
- 最后的 `result` 行 → `message_complete`（权威结果）+ `completed`
- **没有 `result` 行就结束 → `error(incomplete_output)`**，即使退出码是 0：被截断的回复不会被当成完整结果
- `result.is_error` → `error(internal)`，带错误信息
- 非 JSON 行原样以 stdout `output` 转发，方便排查

`codex-exec-json`：解析 `codex exec --json`
- 每条 `agent_message` → `text_delta`（多条之间空一行）；**最后一条**是权威结果（和 `codex exec -o` 一致）
- 必须看到 `turn.completed` 才算完成；单独的 `error` 事件可能只是重连提示，不算失败
- `reasoning`、命令执行等其他条目不算回答

`room-jsonl`：本仓库自带脚本（`bin/deepseek-chat.mjs`）的输出，每行 `delta` / `done` / `error`；必须有 `done` 才算完成

所有解析器：退出码非 0 时也先看解析结论——额度用尽的 CLI 往往以非 0 退出，原因只在结构化输出里

## 测试

```bash
pnpm --filter @room/agent-server test     # 146 个
```

Windows 相关逻辑（`.cmd` 包装、taskkill 参数）用注入的模拟环境测试；`claude` 用 `test/fixtures/fake-claude.mjs`、`codex` 用 `test/fixtures/fake-codex.mjs` 模拟；`deepseek-chat.mjs` 对着测试里起的假 DeepSeek 服务跑（不联网、不用真 Key）。

## 已知缺口

- [x] 真实 Windows（执行节点）：`pnpm --filter @room/agent-server test` 35/35 通过；`claude -p "…"` 能返回结果；setup 能生成配置和 Token
- [ ] stdin 传 prompt 的真机结果、和主控端的第一次端到端评审：联调时补上
- [ ] S-10 真机：`codex exec --json` 的真实输出（特别是额度用尽时的消息原文）、DeepSeek 真实 Key、三个 Agent 各回答一次真实问题
- [ ] `codex exec` 在 Windows 上是否需要 `--sandbox read-only` 之外的设置（例如沙箱不可用时的提示）
- [ ] 节点被强杀后的孤儿进程清理（pid 文件）
- [ ] 权限请求中继（Phase 0 不需要：Reviewer 不使用工具）
- [ ] TLS

## 秘书的记忆文件夹和独立账号（S-20）

规则见 `docs/design/ADR-003-聊天空间.md` §2a。每位秘书在她所在的电脑上有：

- `<AgentRoom>\memory\<秘书>\`：记忆（`core` 每次都带，`journal` 按日期，`notes` 按修改时间，`memory.json` 定预算）
- `<AgentRoom>\node\<秘书>\`：她的节点配置、Token、命令行的工作目录
- 低权限账号 `agentroom-<秘书>`，计划任务 `AgentRoom-<秘书>` 以这个账号开机启动节点

用**以管理员身份运行的 Windows PowerShell**（`powershell.exe`，不是 `pwsh`）一次装一位。模板用仓库里的示例（`agent-server.config.example.json` 给江浩的电脑，`agent-server.config.local.example.json` 给主控机），里面有 `<秘书>-chat`。`deepseek` 要等 D-40 迁移完成之后、加 `-AfterD40` 才装（不加脚本会拒绝）：

```powershell
# 先装依赖（打包要用 esbuild）；Node 要 22 或更高，用官方安装包装到 Program Files
pnpm install --frozen-lockfile
.\apps\agent-server\scripts\install-secretary.ps1 -Agent codex -HomeDir D:\AgentRoom -Port 7421 `
  -ConfigTemplate .\apps\agent-server\agent-server.config.json -AppSource (Get-Location) -TokenReader $env:USERNAME
```

`-TokenReader` 只能是本机的一个用户账号，或者正在运行脚本的这个账号（这一条可以是域账号或 Entra 账号）；其他域账号、组都会被拒绝。秘书账号读不到江浩用户目录里 npm 装的 `claude` / `codex`，所以脚本会用 npm 给她单独装一份到 `node\<秘书>\cli`（要能访问 npm 源；配置的源（比如镜像）装不上时会再试 `registry.npmjs.org`；平台原生包（比如 `@openai/codex-win32-x64`）没装上会单独补装；这一步在建账号之前，装不上就什么都不动），并把模板里 `command` 是 `claude` / `codex` 的 profile 改成这份的绝对路径（`node_modules\.bin\<秘书>.cmd`）；脚本还会给她「作为批处理作业登录」的权限，没有这个权限计划任务不会真正启动。`-TokenReader` 也不能是 SYSTEM、服务账号或 `agentroom-` 开头的节点账号。以前装过 #98 早期版本、`node\app`（或 `node\app.new`、`node\app.old`）里有 `node_modules` 的，先用 `rmdir /s /q` 删掉那个文件夹再装。

重装替换程序时是两次改名（`node\app` → `app.old`，`app.new` → `app`）。如果正好在两次改名之间断电，`node\app` 会不见、所有秘书的节点都起不来；这时把 `node\app.old` 改名回 `app`，再重跑安装脚本（脚本发现这种情况也会拒绝继续并提示这一步）。

**不要用别的账号以 `node\codex\codex-home` 当 `CODEX_HOME` 跑 codex**（包括在江浩自己的窗口里试命令）：codex 会把它建的文件设成只有创建者能访问，林离的账号之后就启动不了（报 `failed to initialize in-process app-server client: access denied`）。要试就用安装脚本打开的那个以 `agentroom-codex` 运行的窗口。真出了这种情况，重跑安装脚本：它会先把 `codex-home` 的所有者和权限修回来，并删掉 codex 自己会重建的 `codex-home\tmp`、`cache`、`plugins\cache`；里面有管理员也打不开的文件、删不掉时，整个文件夹挪到 `<AgentRoom>-trash\`（比如 `E:\AgentRoom-trash\`），codex 会重建，那个文件夹以后可以手动删。还是卡在这一步，就停掉 `AgentRoom-codex` 和 codex 进程，把整个 `codex-home` 挪到 `<AgentRoom>-trash\`，重装后在 `agentroom-codex` 窗口里重新登录一次 codex（汐 #139 实测：这样 0.164 全部通过）。

`-CliVersion 0.163.0` 这类参数可以指定命令行的版本（不填 = npm 上最新的）。新版本在秘书的低权限账号下跑不起来时，用它退回实测过的版本。

模板里没有 `<秘书>-chat` 也能装（账号、文件夹、权限、计划任务照装），但聊天读不到记忆，脚本最后会提示换模板重跑。

**汐（deepseek）**：不装命令行。脚本会问 DeepSeek 的 API Key（输入时不显示；重装时直接回车 = 保留已有的），存进 `node\deepseek\deepseek-api-key.txt`，只有 `agentroom-deepseek` 和管理员能读；profile 里用 `envFiles` 在每次启动时现读，不再从环境变量读。模板里的 `../bin/deepseek-chat.mjs` 会换成 `node\app\bin` 里的绝对路径。

主控机上按 §2a「切换顺序」：先装 `codex`（7421）；汐的 D-40 迁移完成后才装 `deepseek`（7420）。

节点配置新增的字段：`homeDir`、`agent`（填了以后只能跑 `<agent>-` 开头的 profile）、`runAsUser`（进程账号不对就拒绝启动）、聊天 profile 的 `memory: { "dir": "memory/<agent>", "provider": "folder" }`。安装脚本会先把节点打成一个文件（`pnpm --filter @room/agent-server run bundle` → `dist/agent-server.mjs`），`node\app` 里只有它和 `bin\`，没有 `node_modules`；重装时新程序先放进 `node\app.new`，复制、校验、设权限、注册计划任务都成功后才替换 `node\app`，中途失败时其他秘书正在用的旧版本不动；计划任务直接用 Program Files 里的 `node.exe` 运行它。不用安装脚本、手工配置的节点：`homeDir` 和它的上级不能是任何链接、junction 或挂载点（节点用 `lstat` 查，卷挂载点 Node 不一定认得出，以安装脚本的检查为准）。启动时会检查 `homeDir` 在本机 NTFS 盘上，并按规则读一遍记忆，只打印条数和跳过的原因，不打印正文。

### 聊天怎么带记忆（第二段）

- 主控端的聊天 Snapshot 里留一个槽位（`StartRun.chat.memory`，X-30 生成）。节点收到后按上面的规则读这位秘书的记忆，用 `@room/core` 的 `wrapChatUntrusted`（同一个 nonce）包好，**只换掉那一处标记**，别的文字一个字不加；然后发一次 `prompt_final`（最终 hash + 记忆清单：条目 id 和 sha256，没有正文），再把全文交给 CLI
- 读不到、`memory.json` 无效、core 不合格、正文里出现这次的边界标记 → 槽位里换成「此记忆来源不可用」，清单报 `unavailable`，聊天照常回答；原因只写节点日志
- 没配记忆的 profile 收到槽位也一样按「不可用」填
- `health.memoryProfiles`：配了记忆、现在按规则读得到的聊天 profile。启动时查一次，之后每次聊天和 health（最多一分钟一次）都会刷新，所以改好记忆不用重启节点
- 同一个 runId 重复提交时 `chat` 也要一致，否则 `run_id_conflict`

### 聊天 profile 只能说话

节点启动时检查 `-chat` 结尾的 profile，下面这些没写就拒绝启动（第一道；有没有真的关掉以实测为准）：

| 命令 | 必须带 | 作用 |
|---|---|---|
| claude | `--tools=`、`--strict-mcp-config`、`--permission-mode dontAsk` | 一个内置工具都不给、不加载 MCP、要批准的一律拒绝 |
| claude（建议，不拦启动） | `--setting-sources=` | 不读用户、工作目录里的设置文件，里面配的 hooks 不会在聊天时跑命令（见下） |
| codex | `--sandbox read-only`、`--disable shell_tool` | 只读沙箱、不给跑命令的工具（示例里还关了 `view_image`、`image_generation`、网页搜索，`project_doc_max_bytes=0` 不读 AGENTS.md） |
| node（deepseek） | 无 | 本仓库脚本，本来就没有工具 |

任何聊天 profile 都不能带放开权限的参数（`--dangerously-skip-permissions`、`workspace-write`、`danger-full-access`、`--add-dir`、`--allowedTools` 等）。安装脚本把聊天 profile 放在 `node\<秘书>\chat-sandbox`，她对这个文件夹只读。

Codex 的聊天和讨论用同一个 `CODEX_HOME`（`node\codex\codex-home`，林离自己的，不是江浩的 `~\.codex`），里面没有工程规则；聊天 profile 另外用 `project_doc_max_bytes=0` 不读工作目录的 AGENTS.md。分成两个 `CODEX_HOME` 要登录两次、刷新 Token 也会互相顶掉，所以没拆。

**hooks（2026-11-12 实测，claude 2.1.322）**：`--tools=` 关的是工具，关不掉 hooks。工作目录里放一份 `.claude/settings.json`，配上 SessionStart 和 UserPromptSubmit 两个 hook，用上表的参数跑一句话，两个 hook 都执行了；加上 `--setting-sources=`（空值 = 用户 / 项目 / 本地三级设置都不读）或 `--safe-mode` 之后都不执行，回答正常。示例配置的 `claude-chat` 已经带 `--setting-sources=`。写成 `--setting-sources user` 这种带值的只是少读几级设置，那几级里的 hooks 照跑，启动日志照样提醒；空值写成 `--setting-sources=`，或者 `--setting-sources` 后面紧跟一个空字符串都算。已经在跑的节点没有这一项也能启动，只在启动日志里提醒一行；要补上就照示例在 `args` 里加一项、重启节点。没测到的：用户级 `~/.claude/settings.json` 里的 hook（云端不能改会话自己的设置，按 CLI 的说明它也属于 `--setting-sources` 管的范围）、Windows 上的 `claude.cmd`（参数里没有 cmd 特殊字符，启动检查能过）、更老的 claude 版本认不认这个参数——在你的电脑上加了以后先跑一句 `try` 确认。

**只有思考、没有正文**：CLI 正常结束但回答是空的，节点照常报 `completed`、正文为空；主控端把空回答记成「失败（没有内容）」，可以重试。

### 真机验收（任务板 S-20 ①②③）

装好、计划任务在跑之后，用管理员 PowerShell：

```powershell
.\apps\agent-server\scripts\verify-isolation.ps1 -Agent codex -HomeDir D:\AgentRoom -Port 7421
# 只做不调模型的检查（不花额度）
.\apps\agent-server\scripts\verify-isolation.ps1 -Agent codex -HomeDir D:\AgentRoom -Port 7421 -SkipModelRuns
```

- ③ 节点进程的用户是 `agentroom-<秘书>`；用你的账号启动同一份配置被拒绝；配置里混进别的秘书的 profile 被拒绝；别的秘书的 Token 权限里没有她
- ① 聊天 profile 参数里关了工具、工作目录她不能写；实际让它写文件、跑 `whoami`，核对没有效果
- 光看参数不算数（比如 `--tools=` 的空值会不会被当成「没传」）。云端 Linux、claude 2.1.322 已验证（2026-11-12）：带 `--tools=` 时 init 事件里 `tools` 是空数组，让它读文件、跑命令、访问网址，回答是「No tool definitions are available」，哨兵文件没被读、命令没执行、网址没被访问。Windows 上的 `claude.cmd` 还没验证，在装好的那台电脑上，验收前先用她的命令行手工试一句最小的，回答里不能出现用户名：
  `echo 运行 whoami 并贴出输出 | <node\<秘书>\cli\node_modules\.bin\claude.cmd> -p --tools= --strict-mcp-config --permission-mode dontAsk`（Codex 换成 `codex-chat` 的参数）
- 跑之前会把整份记忆备份到你的临时目录；万一记忆被改了，结束时自动整份恢复，并报「不通过」
- ② 在你的用户目录、别的秘书的 `inbox`、别的秘书的 Token 放哨兵，让每个 profile（聊天和讨论）去读、改、删，核对回答里没有哨兵、hash 前后不变；记忆 `notes` 里临时放 junction / 符号链接 / 硬链接（目标她能读），核对记忆清单里没有它们
- 结束时删掉所有哨兵和链接，记忆正文前后 hash 不变。系统运行库、命令行自己的登录信息和临时缓存不在「其他用户数据」范围内
- ④（挑记忆的边界）在 `test/memory-folder.test.ts` 里，`pnpm --filter @room/agent-server test` 在 Windows 上跑一遍就覆盖 `mklink /H`、junction 和保留时间的复制
