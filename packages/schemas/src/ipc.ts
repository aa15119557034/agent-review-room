import type {
  CommandRequest,
  CommandResponse,
  CommandType,
  ControlEvent,
  ControlResult,
  QueryRequest,
  QueryResponse,
  QueryType,
} from "./control-api";

/**
 * Electron IPC 传输层（桌面专用）。
 *
 * 只有三个频道，所有业务都走控制面 API 的格式：
 *   room:command  renderer → main   invoke，返回 ControlResult
 *   room:query    renderer → main   invoke，返回 ControlResult
 *   room:event    main → renderer   send，推送 ControlEvent
 *
 * main 进程必须：
 * 1. 用 ControlCommand / ControlQuery 校验入参，失败返回 validation_failed（不 throw）
 * 2. 用登记表里的 response schema 校验出参，保证 renderer 拿到的数据符合契约
 * 3. 桌面客户端拥有全部 scope；scope 检查留给以后的网络网关
 */
export const IPC_CHANNELS = {
  command: "room:command",
  query: "room:query",
  event: "room:event",
} as const;

/** preload 通过 contextBridge 暴露为 window.room。只暴露这三个方法，不暴露 ipcRenderer */
export interface RoomBridge {
  command<T extends CommandType>(request: CommandRequest<T> & { type: T }): Promise<ControlResult<CommandResponse<T>>>;
  query<T extends QueryType>(request: QueryRequest<T> & { type: T }): Promise<ControlResult<QueryResponse<T>>>;
  /** 返回取消订阅函数 */
  onEvent(listener: (event: ControlEvent) => void): () => void;
}

declare global {
  interface Window {
    room: RoomBridge;
  }
}
