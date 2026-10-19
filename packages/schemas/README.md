# @room/schemas — 契约 ｜ 起草：Claude ｜ 批准：用户 ｜ 审查：DeepSeek

唯一的类型来源。任何修改都要走单独的契约 PR，经用户批准。

| 文件 | 内容 | 状态 |
|---|---|---|
| `common.ts` | ID、hash、时间戳格式 | 草案 |
| `state-machines.ts` | Approval / Run 合法转换表、RUNNING 子状态 | 草案 |
| `permission.ts` | 权限请求与决定 | 草案 |
| `agent-event.ts` | Orchestrator 内部统一事件、失败原因 | 草案 |
| `remote-protocol.ts` | Orchestrator ⇄ AgentServer 协议 v1（ADR-001） | 草案 |
| `control-api.ts` | 人 ⇄ Orchestrator，桌面和手机共用（ADR-001） | 草案 |
| Phase 0 实体、IPC 频道 | C-01b | 待写 |
