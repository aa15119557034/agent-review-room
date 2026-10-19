# @room/agent-server — 远端执行节点（骨架）

负责：DeepSeek（接手维护）｜ 审查：Claude ｜ 骨架作者：Claude（S-01）

运行在隔离的节点上，接收 Orchestrator 的请求，在本地拉起**预先配置好的** CLI，把输出以 NDJSON 流式回传。协议见 `packages/schemas/src/remote-protocol.ts`，设计取舍见 `docs/design/ADR-001-远端执行节点.md`。

## 运行

```bash
cp agent-server.config.example.json agent-server.config.json   # 按节点实际情况修改
export AGENT_SERVER_TOKEN="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
pnpm --filter @room/agent-server start
```

Windows PowerShell：

```powershell
$env:AGENT_SERVER_TOKEN = node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
pnpm --filter @room/agent-server start
```

配置示例里的 `claude-review` 只是示意，命令参数以节点上实际安装的 CLI 为准。`echo` profile 可以直接用来测试连通性。

## 手动试一下

```bash
TOKEN=...; BODY='{"protocol":1,"runId":"run_01JAAAAAAAAAAAAAAAAAAAAAAA","profileId":"echo","snapshot":{"id":"snap_01JAAAAAAAAAAAAAAAAAAAAAAA","content":"hello","contentHash":"2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"},"limits":{"idleTimeoutMs":10000,"totalTimeoutMs":60000}}'
curl -s -H "Authorization: Bearer $TOKEN" -d "$BODY" http://127.0.0.1:7420/v1/runs
curl -N -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:7420/v1/runs/run_01JAAAAAAAAAAAAAAAAAAAAAAA/events?after=-1"
```

## 已经保证的（有测试，`pnpm --filter @room/agent-server test`）

- 每个 run 恰好一个 terminal 事件；seq 从 0 连续递增
- 没有 token / token 错误 → 401
- 请求里夹带 `command` 等多余字段 → 400
- prompt hash 不一致 → 422，不会启动进程
- 同一 runId 重复提交幂等；内容不同 → 409
- 取消、idle 超时、非零退出码分别产出对应的 terminal
- 没人订阅超过 `leaseMs` → 终止整个进程树（Linux 上已验证子进程和孙进程都被杀）
- 断线重连 `?after=<seq>` 补发漏掉的事件
- 安静时也有心跳
- 超过 `maxConcurrentRuns` → 429
- 中文输出跨 chunk 不乱码

## 已知缺口（D-09）

- [ ] **Windows 上没测试过。** `taskkill /T /F` 的路径没有跑过
- [ ] Windows 上 `.cmd` 包装的 CLI（npm 全局安装的大多是）需要 cross-spawn，目前 `shell:false` 会直接启动失败
- [ ] 节点被强杀后的孤儿进程：需要 pid 文件 + 启动时清理
- [ ] 权限请求中继（`/permissions/:id` 返回 501）；等待人工期间暂停 idle 计时
- [ ] TLS（目前是明文 HTTP，只适合本机或 VPN 内）
- [ ] 只读保证：需要在操作系统层面配置（只读用户 / 只读挂载）
- [ ] 事件缓冲只在内存里，节点重启后无法补发
