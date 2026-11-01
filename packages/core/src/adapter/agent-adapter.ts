import type {
  AgentEvent,
  AttachmentImageSlot,
  MemorySlot,
  PermissionDecision,
  PermissionRequest,
  RunId,
  StartRunAttachments,
} from "@room/schemas";

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
  /**
   * C-34 聊天 Run 才有：节点按槽位填记忆，并回报 prompt_final。
   * 不传 = 讨论室 / 单次评审（行为不变）。
   */
  chat?: { memory: MemorySlot | null };
  /**
   * C-42a / C-42g：这次带给节点的图片（本体 base64 + sha256），和 imageSlot 成对出现：都传或都不传。
   * 调用方（main）按 Snapshot.attachments 从图片库读本体，imageSlot 原样取 Snapshot.imageSlot；
   * Adapter 只负责原样放进 StartRun，不改 content、不重算清单。远端以外的 Adapter 不支持带图时应拒绝（error 终止事件），不能丢图继续跑。
   */
  attachments?: StartRunAttachments;
  imageSlot?: AttachmentImageSlot;
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
