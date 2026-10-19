import type { AgentEvent, PermissionDecision, PermissionRequest, RunId } from "@room/schemas";

/** V0.4 §19 的 AgentAdapter，加上了 Phase 0 需要的最少类型。 */

export interface AgentCapabilities {
  streaming: boolean;
  permissionRequests: boolean;
  /** 是否能保证不写文件（Reviewer 只读要求） */
  readOnly: boolean;
}

export interface SessionConfig {
  projectId: string;
  /** 本地 Adapter：工作目录；远端 Adapter：忽略，由节点 profile 决定 */
  cwd?: string;
}

export interface Session {
  sessionId: string;
  adapterId: string;
}

export interface AgentInput {
  snapshotId: string;
  /** 原样发送，不做任何改写（AC-7） */
  content: string;
  contentHash: string;
  commitSha?: string;
}

export interface RunOptions {
  signal: AbortSignal;
  onPermissionRequest: (request: PermissionRequest) => Promise<PermissionDecision>;
  idleTimeoutMs: number;
  totalTimeoutMs: number;
}

export interface AgentAdapter {
  readonly id: string;
  readonly kind: "local" | "remote" | "api";

  initialize(): Promise<AgentCapabilities>;
  startSession(config: SessionConfig): Promise<Session>;

  /**
   * 不变量（所有实现都必须满足）：
   * 1. 产出的 AgentEvent.seq 从 0 开始严格递增。
   * 2. 恰好产出一个终止事件（completed / error / cancelled / timed_out），之后迭代器结束。
   *    出现任何异常都必须转换成 error 终止事件，不允许迭代器直接 throw。
   * 3. signal abort 后，最终产出 cancelled（或在此之前已经产出的其他终止事件）。
   * 4. 消费方中途 break（iterator.return()）等同于 abort。
   * 5. run 结束时，所有尚未回答的 onPermissionRequest 视为 deny。
   */
  run(sessionId: string, runId: RunId, input: AgentInput, opts: RunOptions): AsyncIterable<AgentEvent>;

  closeSession(sessionId: string): Promise<void>;
}
