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

// ================================================================ 讨论室（ADR-002 / C-20）

/**
 * 一轮讨论的状态（画布 0-B）。
 * - DRAFT            : 收件人和内容已生成，等盖章
 * - RUNNING          : 已盖章，有人在答
 * - PAUSED           : 用户暂停；正在答的已按"打断"结束，计时停止
 * - AWAITING_SUMMARY : 所有人都有结局，或用户点了「结束本轮」
 * - SUMMARIZING      : 汇总请求已盖章，汇总者在写
 * - SUMMARIZED       : 汇总完成，产生了方案新版本（终态；下一轮是新的 Round）
 * - VOIDED           : 用户回到某一阶段改方向，这一轮作废（终态，记录保留）
 */
export const RoundState = z.enum(["DRAFT", "RUNNING", "PAUSED", "AWAITING_SUMMARY", "SUMMARIZING", "SUMMARIZED", "VOIDED"]);
export type RoundState = z.infer<typeof RoundState>;

export const ROUND_TRANSITIONS: Readonly<Record<RoundState, readonly RoundState[]>> = {
  DRAFT: ["RUNNING", "VOIDED"],
  RUNNING: ["PAUSED", "AWAITING_SUMMARY", "VOIDED"],
  PAUSED: ["RUNNING", "AWAITING_SUMMARY", "VOIDED"],
  // 大家都有结局之后，还可以单独重试某人或补充（retry / supplement 批次盖章后回到 RUNNING）
  AWAITING_SUMMARY: ["RUNNING", "SUMMARIZING", "VOIDED"],
  // 汇总失败（失败 / 超时 / 缺席）回到 AWAITING_SUMMARY，可以换人或重试
  SUMMARIZING: ["SUMMARIZED", "AWAITING_SUMMARY", "VOIDED"],
  SUMMARIZED: [],
  VOIDED: [],
};

/**
 * 方案版本的状态。版本链只增不改：修改 = 新版本。
 * - DRAFT      : 汇总者或用户起草，等用户确认
 * - CURRENT    : 用户确认的当前版本（每个议题最多一个）
 * - FINAL      : 用户盖章定稿（每个议题最多一个）。以后发现漏了，从它派生一个新的 DRAFT；
 *                派生版本定稿时，旧的 FINAL 在同一事务里变成 SUPERSEDED（C-26）
 * - SUPERSEDED : 被更新的版本取代，或草稿被放弃（终态）
 */
export const PlanState = z.enum(["DRAFT", "CURRENT", "FINAL", "SUPERSEDED"]);
export type PlanState = z.infer<typeof PlanState>;

export const PLAN_TRANSITIONS: Readonly<Record<PlanState, readonly PlanState[]>> = {
  DRAFT: ["CURRENT", "SUPERSEDED"],
  CURRENT: ["FINAL", "SUPERSEDED"],
  // 只有一种情况会离开 FINAL：从它派生的新版本被定稿（C-26）
  FINAL: ["SUPERSEDED"],
  SUPERSEDED: [],
};

/**
 * 一个人在一轮里的一次发言（Turn）的结局。Run 的状态机不变，Turn 只是给讨论用的标签：
 * 同一个人被打断后重新回答，是同一轮里的两个 Turn。
 */
export const TurnOutcome = z.enum([
  "pending",            // 已生成内容，等盖章
  "running",
  "answered",           // Run COMPLETED，且有正式回答
  "interrupted",        // 用户打断（会有一个新 Turn 接着）
  "round_ended",        // 用户点「结束本轮」时还没答完
  "paused",             // 用户暂停时还没答完（恢复后会有新 Turn）
  "absent_quota",       // Run FAILED(quota_exhausted)：缺席（额度）
  "timed_out",
  "failed",             // 其他失败，可以单独重试
  "rejected",           // 用户没有盖章（拒绝了这批）
]);
export type TurnOutcome = z.infer<typeof TurnOutcome>;

export const TERMINAL_TURN_OUTCOMES = [
  "answered", "interrupted", "round_ended", "paused", "absent_quota", "timed_out", "failed", "rejected",
] as const satisfies readonly TurnOutcome[];

// ================================================================ 媒体任务（ADR-004 / C-42b）

/**
 * 画图 / 语音合成任务的状态。每个任务恰好一个终态（succeeded / failed / cancelled / timed_out）。
 * queued → cancelled 时退回沉浸模式的名额；running 之后不管结局都占名额（C-42d）
 */
export const MediaJobState = z.enum(["queued", "running", "succeeded", "failed", "cancelled", "timed_out"]);
export type MediaJobState = z.infer<typeof MediaJobState>;

export const MEDIA_JOB_TRANSITIONS: Readonly<Record<MediaJobState, readonly MediaJobState[]>> = {
  queued: ["running", "cancelled", "failed"],
  running: ["succeeded", "failed", "cancelled", "timed_out"],
  succeeded: [],
  failed: [],
  cancelled: [],
  timed_out: [],
};

export const canTransition = <S extends string>(
  table: Readonly<Record<S, readonly S[]>>,
  from: S,
  to: S,
): boolean => table[from].includes(to);
