import { contextBridge } from "electron";

/**
 * preload（DeepSeek 负责）。
 *
 * D-01 只建立骨架，**刻意不暴露任何 IPC 频道**：真正的 RoomBridge 必须按
 * packages/schemas 里 control-api.ts / ipc.ts 的定义由 D-07 实现，
 * 在此之前不要用临时接口占位，否则 renderer 会对着假契约开发。
 *
 * 不导出 ipcRenderer 本身（AGENTS.md 硬规则）。
 */

contextBridge.exposeInMainWorld("__roomPreloadReady", true);
