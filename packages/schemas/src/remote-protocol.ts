import { z } from "zod";
import { CommitSha, IsoTimestamp, RunId, Sha256Hex, SnapshotId } from "./common";
import { PermissionDecision, PermissionRequest } from "./permission";

/**
 * Orchestrator（控制面） ⇄ AgentServer（执行面）协议 v1。
 *
 * HTTP 端点（全部要求 Authorization: Bearer <token>）：
 *   GET  /v1/health
 *   GET  /v1/runs                                 对账：节点上还活着/刚结束的 run
 *   POST /v1/runs                                 StartRunRequest → StartRunResponse（幂等，按 runId）
 *   GET  /v1/runs/:runId/events?after=<seq>       NDJSON 流：先补发 seq > after 的事件，再推实时事件
 *   POST /v1/runs/:runId/cancel                   CancelRunRequest
 *   POST /v1/runs/:runId/permissions/:requestId   PermissionDecision（Phase 1，骨架返回 501）
 *
 * 关键规则：
 * 1. Payload 里不允许出现命令。只能选节点本地配置好的 profileId。（.strict() 拒绝多余字段）
 * 2. 节点执行前必须重新计算 sha256(content)，与 contentHash 不一致就拒绝。
 * 3. 事件流就是租约：没有任何订阅者连着超过 leaseMs，节点自行终止该 run。
 *    必须满足 leaseMs < Orchestrator 的 reconnectGraceMs，保证"远端先停，本地后判失败"。
 * 4. heartbeat 不带 seq、不进缓冲；只用来检测连接是否还活着。
 */
export const REMOTE_PROTOCOL_VERSION = 1 as const;

export const ProfileId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);

export const RunLimits = z
  .object({
    idleTimeoutMs: z.number().int().min(1_000).max(3_600_000),
    totalTimeoutMs: z.number().int().min(1_000).max(24 * 3_600_000),
  })
  .strict();

export const StartRunRequest = z
  .object({
    protocol: z.literal(REMOTE_PROTOCOL_VERSION),
    runId: RunId,
    profileId: ProfileId,
    snapshot: z
      .object({
        id: SnapshotId,
        /** 原样作为 stdin 传给 CLI */
        content: z.string().min(1).max(2_000_000),
        contentHash: Sha256Hex,
        /** 提供时，且节点 profile 开启 verifyCommit，节点会校验工作目录 HEAD 一致且干净 */
        commitSha: CommitSha.optional(),
      })
      .strict(),
    limits: RunLimits,
  })
  .strict();

export const StartRunResponse = z.object({
  runId: RunId,
  status: z.enum(["accepted", "already_exists"]),
  eventsPath: z.string(),
});

/** 节点侧事件。seq 是节点本地序号，RemoteAgentAdapter 负责映射成 AgentEvent。 */
const seqd = { seq: z.number().int().nonnegative(), ts: IsoTimestamp };

export const RemoteTerminal = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("completed"), exitCode: z.literal(0) }),
  z.object({
    outcome: z.literal("error"),
    reason: z.enum([
      "spawn_failed",
      "process_exit_nonzero",
      "lease_expired",
      "output_limit_exceeded",
      "node_shutdown",
      "internal",
    ]),
    exitCode: z.number().int().nullable(),
    message: z.string().max(4000).optional(),
  }),
  z.object({ outcome: z.literal("cancelled"), reason: z.string().max(500).optional() }),
  z.object({ outcome: z.literal("timed_out"), kind: z.enum(["idle", "total"]) }),
]);

export const RemoteEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("started"), ...seqd }),
  z.object({ type: z.literal("output"), ...seqd, stream: z.enum(["stdout", "stderr"]), data: z.string() }),
  z.object({ type: z.literal("permission_request"), ...seqd, request: PermissionRequest }),
  z.object({ type: z.literal("terminal"), ...seqd, result: RemoteTerminal }),
  z.object({ type: z.literal("heartbeat"), ts: IsoTimestamp, lastSeq: z.number().int().min(-1) }),
]);

export const CancelRunRequest = z.object({ reason: z.string().max(500).optional() }).strict();

export const PermissionDecisionRequest = PermissionDecision;

export const NodeHealth = z.object({
  protocol: z.literal(REMOTE_PROTOCOL_VERSION),
  nodeId: z.string(),
  profiles: z.array(ProfileId),
  activeRuns: z.number().int().nonnegative(),
  maxConcurrentRuns: z.number().int().positive(),
  leaseMs: z.number().int().positive(),
  heartbeatMs: z.number().int().positive(),
});

export const RemoteRunSummary = z.object({
  runId: RunId,
  profileId: ProfileId,
  state: z.enum(["running", "finished"]),
  lastSeq: z.number().int().min(-1),
  subscribers: z.number().int().nonnegative(),
});

export const RemoteErrorCode = z.enum([
  "unauthorized",
  "bad_request",
  "not_found",
  "unknown_profile",
  "hash_mismatch",
  "commit_mismatch",
  "run_id_conflict",
  "node_busy",
  "payload_too_large",
  "not_implemented",
  "internal",
]);

export const RemoteErrorResponse = z.object({
  error: RemoteErrorCode,
  message: z.string(),
});

export type StartRunRequest = z.infer<typeof StartRunRequest>;
export type StartRunResponse = z.infer<typeof StartRunResponse>;
export type RemoteEvent = z.infer<typeof RemoteEvent>;
export type RemoteTerminal = z.infer<typeof RemoteTerminal>;
export type NodeHealth = z.infer<typeof NodeHealth>;
export type RemoteRunSummary = z.infer<typeof RemoteRunSummary>;
export type RemoteErrorCode = z.infer<typeof RemoteErrorCode>;
