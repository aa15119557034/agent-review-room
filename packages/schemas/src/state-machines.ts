import { z } from "zod";

/**
 * Approval / Run 状态转换表（C-01 草案，待用户批准）。
 * 转换规则以数据形式定义，core 的实现只能查表，不能自己写 if。
 */

export const ApprovalState = z.enum([
  "DRAFT",
  "READY_FOR_REVIEW",
  "APPROVED",
  "REJECTED",
  "EXPIRED",
  "CANCELLED",
]);
export type ApprovalState = z.infer<typeof ApprovalState>;

export const APPROVAL_TRANSITIONS: Readonly<Record<ApprovalState, readonly ApprovalState[]>> = {
  DRAFT: ["READY_FOR_REVIEW", "CANCELLED"],
  READY_FOR_REVIEW: ["APPROVED", "REJECTED", "EXPIRED", "CANCELLED"],
  // APPROVED 之后只能失效或取消。"被消费"不是状态，而是 runs.approval_id 的唯一约束：
  // 一个 Approval 最多对应一个 Run，"消费 Approval + 创建 Run" 必须在同一个事务里完成。
  APPROVED: ["EXPIRED", "CANCELLED"],
  REJECTED: [],
  EXPIRED: [],
  CANCELLED: [],
};

export const RunState = z.enum([
  "QUEUED",
  "STARTING",
  "RUNNING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "TIMED_OUT",
]);
export type RunState = z.infer<typeof RunState>;

export const RUN_TRANSITIONS: Readonly<Record<RunState, readonly RunState[]>> = {
  QUEUED: ["STARTING", "CANCELLED", "FAILED"],
  STARTING: ["RUNNING", "FAILED", "CANCELLED", "TIMED_OUT"],
  RUNNING: ["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
  TIMED_OUT: [],
};

/**
 * RUNNING 的内部子状态。不进入主状态机，只影响计时器：
 * - active            : idle timeout 计时
 * - waiting_for_human : idle timeout 暂停（V0.4 §20）
 * - disconnected      : 远端连接中断，进入重连宽限期；idle timeout 暂停，宽限期计时
 *
 * 注意：没有 RECOVERY_REQUIRED 这个 Run 状态。断线最终落到 FAILED(connection_lost)。
 * RECOVERY_REQUIRED 只用于 worktree（V0.4 §27）。
 */
export const RunSubstate = z.enum(["active", "waiting_for_human", "disconnected"]);
export type RunSubstate = z.infer<typeof RunSubstate>;

export const canTransition = <S extends string>(
  table: Readonly<Record<S, readonly S[]>>,
  from: S,
  to: S,
): boolean => table[from].includes(to);
