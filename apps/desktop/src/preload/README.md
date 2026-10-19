# preload/ — 负责：DeepSeek ｜ 审查：Claude
contextBridge 只暴露 packages/schemas 里定义的 IPC 频道，不暴露 ipcRenderer 本身。
