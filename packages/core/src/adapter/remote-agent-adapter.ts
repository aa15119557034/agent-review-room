import type { NodeHealth, RemoteRunSummary, RunId } from "@room/schemas";
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
 *   因为 leaseMs < reconnectGraceMs，此时节点一定已经自行终止了进程，不会出现"本地判失败、远端还在写"。
 *
 * 取消
 * - signal abort → POST cancel，然后继续读事件流等节点的 cancelled 终止事件。
 * - cancel 请求本身失败（网络断）→ 不阻塞：按断线处理，最终靠租约过期保证远端停止，
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

  /** GET /v1/health。用于设置页的"测试连接"和调度前检查。 */
  health(signal?: AbortSignal): Promise<NodeHealth>;

  /** GET /v1/runs。原始列表，供 UI 展示。 */
  listRemoteRuns(signal?: AbortSignal): Promise<RemoteRunSummary[]>;

  /**
   * Orchestrator 启动时调用（V0.4 §32 崩溃恢复的远端版本）。
   * localActiveRunIds：本地数据库中仍处于 STARTING / RUNNING 的、分配给这个节点的 run。
   * 调用方根据报告：取消 orphansOnNode，把 missingOnNode 标记为 FAILED(remote_lost)。
   */
  reconcile(localActiveRunIds: readonly RunId[], signal?: AbortSignal): Promise<ReconcileReport>;
}
