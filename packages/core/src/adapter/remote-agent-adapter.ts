import type { NodeHealth, RemoteRunLedgerId, RemoteRunProof, RemoteRunSummary, RunId, WorldProfileExpectation } from "@room/schemas";
import type { AgentAdapter } from "./agent-adapter";

/**
 * 远端执行节点的配置。
 * token 不存数据库，运行时从系统凭据库 / 环境变量读取。
 */
export interface RemoteNodeConfig {
  nodeId: string;
  /** 例如 https://192.168.1.20:7420 。生产环境应使用 TLS 或 WireGuard/Tailscale 隧道。 */
  baseUrl: string;
  profileId: string;
  /** 多久收不到任何字节（含 heartbeat）就认为连接已断。建议 >= 3 × 节点 heartbeatMs */
  heartbeatTimeoutMs: number;
  /** 断线后重连宽限期。必须 > 节点 leaseMs（initialize 时校验） */
  reconnectGraceMs: number;
  /** 单个 HTTP 请求（非事件流）的超时 */
  requestTimeoutMs: number;
  /** 派发前协商并持久绑定；所有创建重试及取消原样携带，不因不匹配而删除后重发。 */
  expectedLedgerId?: RemoteRunLedgerId;
  /** 固定隔离映射；世界请求必须同时绑定 ledger，initialize 和节点最终准入都要核对。 */
  expectedWorldProfile?: WorldProfileExpectation;
}

/**
 * 可选的持久 Run 能力。存在不等于节点支持：新派发仍须核对 health/initialize。
 * 只需原节点凭据与 ledger，不依赖原 profile 仍存在或创建会话，供崩溃恢复对账。
 */
export interface RemoteRunFenceAccess {
  readonly ledgerId: RemoteRunLedgerId;
  /**
   * 原 ledger 下取消。202 + 合法 CancelRunResponse 才 resolve；HTTP/网络/格式错误 reject。
   * 调用方使用独立、有界的清理 signal，不能复用已 abort 的生成 signal。成功仍非停止证明。
   */
  cancel(runId: RunId, reason?: string, signal?: AbortSignal): Promise<void>;
  /**
   * 校验 schema、精确 RunId 和绑定 ledgerId；错配、404、读取失败均 reject。
   * missing/unconfirmed 原样返回，不伪装成已停止，不用 runs 列表或 terminal 代替。
   */
  proof(runId: RunId, signal?: AbortSignal): Promise<RemoteRunProof>;
}

export interface ReconcileReport {
  /** 节点上还在跑、但本地已经是终态（或根本不认识）的 run——需要取消 */
  orphansOnNode: RunId[];
  /** 本地认为 RUNNING、节点上已经不存在的 run——本地应标记 FAILED(remote_lost) */
  missingOnNode: RunId[];
}

/**
 * RemoteAgentAdapter：通过 AgentServer 协议 v1（见 @room/schemas remote-protocol）在远端节点执行。
 *
 * run() 的行为约定（在 AgentAdapter 的不变量之上）：
 *
 * 启动
 * - POST /v1/runs。网络错误时用同一个 runId 重试（节点按 runId 幂等）。
 * - 4xx（hash_mismatch / commit_mismatch / unknown_profile / node_busy …）→ error(remote_rejected)，不重试。
 *   node_busy 例外：由 Orchestrator 的队列决定是否稍后重新调度，Adapter 本身不排队。
 *
 * 事件流
 * - GET /v1/runs/:id/events?after=<lastSeq>，把 RemoteEvent 映射成 AgentEvent，seq 由本地重新分配。
 * - 超过 heartbeatTimeoutMs 收不到任何字节 → 认为断线：
 *     产出 status{substate:"disconnected"}，暂停 idle 计时，用 after=lastSeq 反复重连，
 *     直到 reconnectGraceMs 用完。
 * - 重连成功 → status{substate:"active"}，继续。节点会补发断线期间的事件，不会丢。
 * - 宽限期用完 → 产出 error(connection_lost) 终止事件。
 *   租约到期只是节点尝试停止，不能保证受管进程已经 close；世界屏障仍须匹配的持久 proof。
 *
 * 取消
 * - signal abort → POST cancel，然后继续读事件流等节点的 cancelled 终止事件。
 * - cancel 请求本身失败（网络断）→ 不阻塞事件流收尾：按断线处理，节点仍会按租约尝试停止，
 *   本地产出 cancelled（reason 注明 "unconfirmed"）。
 *
 * 权限请求
 * - 节点推来 permission_request → 调用 onPermissionRequest → POST 决定。
 * - 等待人工期间产出 status{substate:"waiting_for_human"}，暂停 idle 计时；心跳照常，连接不会因此被判死。
 *
 * 终止之后
 * - 已产出终止事件后再收到的任何事件一律丢弃（只记日志），不改变 Run 状态。
 */
export interface RemoteAgentAdapter extends AgentAdapter {
  readonly kind: "remote";
  readonly node: Readonly<RemoteNodeConfig>;

  /** 旧实现可以缺席；世界派发必须同时有此接口和节点已协商的 runFence/worldProfiles 能力。 */
  readonly runFence?: RemoteRunFenceAccess;

  /** GET /v1/health。用于设置页的"测试连接"和调度前检查。 */
  health(signal?: AbortSignal): Promise<NodeHealth>;

  /** GET /v1/runs。原始列表，供 UI 展示。 */
  listRemoteRuns(signal?: AbortSignal): Promise<RemoteRunSummary[]>;

  /**
   * Orchestrator 启动时调用（V0.4 §32 崩溃恢复的远端版本）。
   * localActiveRunIds：本地数据库中仍处于 STARTING / RUNNING 的、分配给这个节点的 run。
   * 调用方根据报告：取消 orphansOnNode，把 missingOnNode 标记为 FAILED(remote_lost)。
   * 列表缺席/finished 都不是持久停止证明，不能解除世界的跨重启模型准入屏障。
   */
  reconcile(localActiveRunIds: readonly RunId[], signal?: AbortSignal): Promise<ReconcileReport>;
}
