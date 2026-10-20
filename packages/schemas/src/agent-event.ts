import { z } from "zod";
import { IsoTimestamp, RunId } from "./common";
import { PermissionDecision, PermissionRequest } from "./permission";

/**
 * Orchestrator 内部统一的 Agent 事件（V0.3 §23 / V0.4 §22）。
 * 本地 Adapter 和 RemoteAgentAdapter 都输出这个格式。
 * seq 由 Orchestrator 侧分配，单个 run 内从 0 开始严格递增。
 */
const base = {
  eventId: z.string().min(1),
  runId: RunId,
  seq: z.number().int().nonnegative(),
  ts: IsoTimestamp,
};

export const FailureReason = z.enum([
  "interrupted",          // Orchestrator 崩溃后启动修复（V0.4 §24）
  "connection_lost",      // 远端在重连宽限期内没有恢复
  "lease_expired",        // 远端因为租约过期自行终止
  "remote_lost",          // 远端已不认识这个 run（节点重启等）
  "remote_rejected",      // 远端拒绝启动（鉴权、参数、繁忙……）
  "hash_mismatch",
  "commit_mismatch",
  "spawn_failed",
  "process_exit_nonzero",
  "output_limit_exceeded",
  "incomplete_output",    // Reviewer 的输出没有正常结束（流被截断），不能当作完整结果
  "postprocess",          // 自动 commit 等后处理失败（V0.4 §27）
  "internal",
]);

export const AgentEvent = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("message_delta"), text: z.string() }),
  z.object({ ...base, type: z.literal("message_complete"), text: z.string() }),
  z.object({ ...base, type: z.literal("output"), stream: z.enum(["stdout", "stderr"]), data: z.string() }),
  z.object({ ...base, type: z.literal("permission_request"), request: PermissionRequest }),
  z.object({
    ...base,
    type: z.literal("permission_resolved"),
    requestId: z.string(),
    decision: PermissionDecision,
  }),
  z.object({
    ...base,
    type: z.literal("status"),
    /** RUNNING 的内部子状态，不改变 Run 的主状态 */
    substate: z.enum(["active", "waiting_for_human", "disconnected"]),
  }),
  // ---- 终止事件：每个 run 恰好一个 ----
  z.object({ ...base, type: z.literal("completed") }),
  z.object({
    ...base,
    type: z.literal("error"),
    reason: FailureReason,
    message: z.string().max(4000).optional(),
    exitCode: z.number().int().nullable().optional(),
  }),
  z.object({ ...base, type: z.literal("cancelled"), reason: z.string().max(500).optional() }),
  z.object({ ...base, type: z.literal("timed_out"), kind: z.enum(["idle", "total"]) }),
]);

export type AgentEvent = z.infer<typeof AgentEvent>;
export type FailureReason = z.infer<typeof FailureReason>;

export const TERMINAL_EVENT_TYPES = ["completed", "error", "cancelled", "timed_out"] as const;
export type TerminalAgentEvent = Extract<AgentEvent, { type: (typeof TERMINAL_EVENT_TYPES)[number] }>;

export const isTerminalEvent = (e: AgentEvent): e is TerminalAgentEvent =>
  (TERMINAL_EVENT_TYPES as readonly string[]).includes(e.type);
