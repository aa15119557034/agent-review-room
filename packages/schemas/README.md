# @room/schemas — 契约 ｜ 起草：Claude ｜ 批准：用户 ｜ 审查：DeepSeek

唯一的类型来源。任何修改都要走单独的契约 PR，经用户批准。

| 文件 | 内容 | 状态 |
|---|---|---|
| `common.ts` | ID、hash、时间戳格式 | 已合并 |
| `state-machines.ts` | Approval / Run 合法转换表、RUNNING 子状态 | 已合并 |
| `permission.ts` | 权限请求与决定 | 已合并 |
| `agent-event.ts` | Orchestrator 内部统一事件、失败原因 | 已合并 |
| `remote-protocol.ts` | Orchestrator ⇄ AgentServer 协议 v1（ADR-001） | 已合并 |
| `entities.ts` | Phase 0 实体：Project、Message、Contribution、PromptSnapshot、Approval、Run、SystemStatus | C-01b 草案 |
| `control-api.ts` | 人 ⇄ Orchestrator：命令 / 查询登记表、结果、事件；桌面和手机共用 | C-01b 草案 |
| `ipc.ts` | Electron IPC 的三个频道和 `window.room` 类型 | C-01b 草案 |

测试：`pnpm --filter @room/schemas test`（状态机可达性、登记表一致性、实体约束）；`test/types.typecheck.ts` 是编译期检查。

使用说明见 `docs/contracts/README.md`。
