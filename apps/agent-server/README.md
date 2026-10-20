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
echo 只回复两个字：你好 | claude -p

# 2. 安装依赖（第一次）
pnpm install

# 3. 一键准备：生成配置、Token、Reviewer 用的空文件夹，并打印要填到主控端的信息
pnpm --filter @room/agent-server setup

# 4. 启动
pnpm --filter @room/agent-server start
```

第 3 步会打印类似：

```
在主控端的设置页填写：
  地址：http://192.168.1.20:7420
  评审方式：claude-review
  Token：3f9a…（64 位）
```

把这三项填到主控端"设置 → Reviewer 节点"，点"测试连接"。

第一次启动时 Windows 会弹出防火墙提示，选**允许"专用网络"**。如果没弹出、主控端连不上，用管理员 PowerShell 执行：

```powershell
netsh advfirewall firewall add rule name="Agent Review Room 7420" dir=in action=allow protocol=TCP localport=7420 profile=private
```

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

## 测试

```bash
pnpm --filter @room/agent-server test     # 35 个
```

Windows 相关逻辑（`.cmd` 包装、taskkill 参数）用注入的模拟环境测试；`claude` 用 `test/fixtures/fake-claude.mjs` 模拟。

## 已知缺口

- [ ] **还没有在真实 Windows 上跑过**：请在执行节点上按上面步骤运行一次，并跑 `pnpm --filter @room/agent-server test`
- [ ] `echo … | claude -p` 从 stdin 读 prompt：文档写明支持，但还没在你的电脑上实测（第 1 步就是这个测试）
- [ ] 节点被强杀后的孤儿进程清理（pid 文件）
- [ ] 权限请求中继（Phase 0 不需要：Reviewer 不使用工具）
- [ ] TLS
