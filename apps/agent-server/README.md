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
| `codex-discuss` | `codex exec --json --skip-git-repo-check --sandbox read-only --ephemeral -` | 这台电脑上 `codex login` 登录的 ChatGPT 账号 |
| `deepseek-discuss` | `node ../bin/deepseek-chat.mjs --model deepseek-v4-pro` | 环境变量 `DEEPSEEK_API_KEY` 对应的 API 余额 |

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

模型名写在配置文件 `deepseek-discuss.args` 里（`--model deepseek-v4-pro`），想换便宜的就改成 `deepseek-flash`。

**额度用尽**（C-25）：解析器从结构化输出里认出"额度用尽 / 限流"时，节点报告 `error(quota_exhausted)`，讨论里显示为「缺席（额度）」，其他人继续：
- Codex：`turn.failed` 或未完成时的 `error`，消息里有 usage limit / rate limit 等
- DeepSeek：HTTP 402（余额不足）或 429（限流）
- Claude：`result.is_error` 且消息里有 usage limit，或 `api_error_status: 429`

认不出来的失败照旧是 `process_exit_nonzero` / `internal`，不猜。

**额度显示（1B，待实测）**：5 小时 / 每周用量只读官方提供的数据——Claude 的 statusline JSON（`rate_limits`），Codex 的 `codex app-server` 接口（`account/rateLimits/read`），DeepSeek 的 `GET /user/balance`。不读本机登录凭据、不调用未公开的接口；读不到就显示「未知」。真机结果联调时写在这里。

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
pnpm --filter @room/agent-server test     # 59 个
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
