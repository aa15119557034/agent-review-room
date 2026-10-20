import { contextBridge, ipcRenderer } from "electron";
import { IPC_CHANNELS, type ControlEvent, type ControlResult, type RoomBridge } from "@room/schemas";

/**
 * preload（D-07）。只暴露契约里的三个方法，不暴露 ipcRenderer 本身。
 */

const bridge: RoomBridge = {
  command: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.command, request) as Promise<ControlResult<never>>,
  query: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.query, request) as Promise<ControlResult<never>>,
  onEvent: (listener: (event: ControlEvent) => void): (() => void) => {
    const handler = (_event: unknown, payload: ControlEvent): void => listener(payload);
    ipcRenderer.on(IPC_CHANNELS.event, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.event, handler);
    };
  },
};

contextBridge.exposeInMainWorld("room", bridge);
