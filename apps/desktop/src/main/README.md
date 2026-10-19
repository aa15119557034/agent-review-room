# main/ — 负责：DeepSeek ｜ 审查：Claude
Electron 主进程：窗口、生命周期、IPC handler（D-07）、启动时崩溃恢复（D-06）。
IPC 入参必须用 packages/schemas 的 Zod schema 校验。API key 只在这里读取。
