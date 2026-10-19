import { z } from "zod";
import { ApprovalId, PermissionRequestId, RunId, Sha256Hex } from "./common";
import { AgentEvent } from "./agent-event";
import { PermissionDecision, PermissionRequest } from "./permission";
import { ApprovalState, RunState } from "./state-machines";

/**
 * 控制面 API：给"人"用的接口（预留给手机 App）。
 *
 * - 桌面 renderer 今天通过 Electron IPC 调用它；以后手机 App 通过网络网关调用同一套格式。
 * - 手机 App 只连 Orchestrator，**永远不直接连 AgentServer**。
 * - 与传输层无关：这里只定义消息格式，不定义 IPC / WebSocket / HTTP 细节。
 */

export const ClientKind = z.enum(["desktop", "mobile"]);

export const ControlScope = z.enum([
  "read",              // 看状态、看 prompt、看结果
  "approve",           // 批准 / 拒绝 Approval
  "permission",        // 回答 Agent 的权限请求
  "cancel",            // 取消 run
]);

export const ControlCommand = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("approval.approve"),
    approvalId: ApprovalId,
    /**
     * 必须带上审批人看到的 prompt hash。
     * 和当前 snapshot 不一致就拒绝——防止手机上停留的旧页面批准了已经变化的 prompt。
     */
    expectedSnapshotHash: Sha256Hex,
  }),
  z.object({ type: z.literal("approval.reject"), approvalId: ApprovalId, reason: z.string().max(2000).optional() }),
  z.object({ type: z.literal("run.cancel"), runId: RunId, reason: z.string().max(500).optional() }),
  z.object({
    type: z.literal("permission.decide"),
    runId: RunId,
    requestId: PermissionRequestId,
    decision: PermissionDecision.shape.decision,
  }),
]);

export const ControlQuery = z.discriminatedUnion("type", [
  z.object({ type: z.literal("approvals.listPending") }),
  z.object({ type: z.literal("runs.list"), limit: z.number().int().min(1).max(200).default(50) }),
  z.object({ type: z.literal("runs.get"), runId: RunId }),
]);

/** Orchestrator 推给所有已连接客户端的事件 */
export const ControlEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("approval.updated"), approvalId: ApprovalId, state: ApprovalState }),
  z.object({ type: z.literal("run.updated"), runId: RunId, state: RunState }),
  z.object({ type: z.literal("run.event"), event: AgentEvent }),
  z.object({ type: z.literal("permission.requested"), runId: RunId, request: PermissionRequest }),
]);

export const ControlCommandResult = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }),
  z.object({
    ok: z.literal(false),
    error: z.enum(["forbidden", "not_found", "invalid_state", "stale_snapshot", "already_decided"]),
    message: z.string(),
  }),
]);

export type ControlCommand = z.infer<typeof ControlCommand>;
export type ControlQuery = z.infer<typeof ControlQuery>;
export type ControlEvent = z.infer<typeof ControlEvent>;
export type ControlCommandResult = z.infer<typeof ControlCommandResult>;
export type ControlScope = z.infer<typeof ControlScope>;
