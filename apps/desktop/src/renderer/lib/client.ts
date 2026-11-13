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
      throw new ControlFailure("internal", `应用内部没有响应，请重新打开应用再试（${err instanceof Error ? err.message : String(err)}）`);
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

/**
 * 后端 message 里的参与者内部 id（claude / deepseek / codex）换成显示名（C-49 / B-08）。
 * 只换独立出现的 id：「profile codex-discuss」里的 codex 不动。
 */
export function withAgentNames(message: string, agents: readonly { id: string; displayName: string }[]): string {
  let out = message;
  for (const a of agents) {
    if (!/^[\w-]+$/.test(a.id) || a.id === a.displayName) continue;
    out = out.replace(new RegExp(`(?<![\\w-])${a.id}(?![\\w-])`, "g"), a.displayName);
  }
  return out;
}

/** 后端的 message 只是把提示又说了一遍的：不再拼在括号里（C-49 / B-08） */
const REDUNDANT_MESSAGE: Partial<Record<ControlErrorCode, RegExp>> = {
  rate_limited: /每分钟最多/,
  agent_unavailable: /现在还是不能答$/,
};

/** 错误码 → 给用户看的说明。后端的 message 作为补充；agents 给了就把内部 id 换成显示名 */
export function describeFailure(err: unknown, agents: readonly { id: string; displayName: string }[] = []): string {
  if (!(err instanceof ControlFailure)) return err instanceof Error ? err.message : String(err);
  const message = withAgentNames(err.message, agents);
  const hint: Partial<Record<ControlErrorCode, string>> = {
    stale_snapshot: "这份内容在你查看之后已经变了，请重新打开预览再批准。",
    already_decided: "这一项已经处理过了。",
    invalid_state: "现在不能这样操作：状态可能已经变了，刷新后再试。",
    reviewer_not_configured: "还没有设置 Reviewer 节点，请先在“设置”里填写节点地址和 Token。",
    not_found: "要找的记录不存在，可能已被删除。",
    rate_limited: "发得太快了：每个会话每分钟最多 6 条，稍等一下再发。",
    idempotency_conflict: "这条消息和之前没发成功的那次内容不一样，请重新发送。",
    agent_unavailable: "这位现在还是不能回答。",
  };
  const h = hint[err.code];
  if (!h) return message;
  // agent_unavailable：后端说了具体原因（谁、为什么）就只显示原因，不再套一句「这位…」
  if (err.code === "agent_unavailable" && !REDUNDANT_MESSAGE.agent_unavailable!.test(err.message)) return message;
  return REDUNDANT_MESSAGE[err.code]?.test(err.message) ? h : `${h}（${message}）`;
}
