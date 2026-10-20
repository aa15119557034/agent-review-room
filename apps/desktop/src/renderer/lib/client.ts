import type {
  CommandRequest,
  CommandResponse,
  CommandType,
  ControlErrorCode,
  QueryRequest,
  QueryResponse,
  QueryType,
  RoomBridge,
} from "@room/schemas";

/** 后端返回 ok:false 时抛出。UI 层统一捕获，显示 message */
export class ControlFailure extends Error {
  constructor(
    readonly code: ControlErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ControlFailure";
  }
}

/**
 * 对 window.room 的薄封装：把 ControlResult 变成"成功返回数据 / 失败抛 ControlFailure"，
 * 并把 IPC 本身的异常（preload 崩溃等）也转成 ControlFailure("internal")。
 */
export interface RoomClient {
  command<T extends CommandType>(request: CommandRequest<T> & { type: T }): Promise<CommandResponse<T>>;
  query<T extends QueryType>(request: QueryRequest<T> & { type: T }): Promise<QueryResponse<T>>;
  onEvent: RoomBridge["onEvent"];
}

export function createClient(bridge: RoomBridge): RoomClient {
  const call = async <R>(fn: () => Promise<{ ok: true; data: R } | { ok: false; error: ControlErrorCode; message: string }>) => {
    let result;
    try {
      result = await fn();
    } catch (err) {
      throw new ControlFailure("internal", `无法连接后端：${err instanceof Error ? err.message : String(err)}`);
    }
    if (!result.ok) throw new ControlFailure(result.error, result.message);
    return result.data;
  };
  // 泛型透传时 TS 无法把 T 收窄到具体命令，这里内部放宽类型；对外签名仍由 RoomClient 保证
  const loose = bridge as unknown as {
    command(r: unknown): ReturnType<RoomBridge["command"]>;
    query(r: unknown): ReturnType<RoomBridge["query"]>;
  };
  return {
    command: (request) => call(() => loose.command(request)) as never,
    query: (request) => call(() => loose.query(request)) as never,
    onEvent: (listener) => bridge.onEvent(listener),
  };
}

/** 错误码 → 给用户看的说明。后端的 message 作为补充 */
export function describeFailure(err: unknown): string {
  if (!(err instanceof ControlFailure)) return err instanceof Error ? err.message : String(err);
  const hint: Partial<Record<ControlErrorCode, string>> = {
    stale_snapshot: "这份 prompt 在你查看之后已经变了，请重新打开预览再批准。",
    already_decided: "这一项已经处理过了。",
    invalid_state: "当前状态下不能执行这个操作。",
    reviewer_not_configured: "还没有设置 Reviewer 节点，请先在“设置”里填写节点地址和 Token。",
    not_found: "要找的记录不存在，可能已被删除。",
  };
  return hint[err.code] ? `${hint[err.code]}（${err.message}）` : err.message;
}
