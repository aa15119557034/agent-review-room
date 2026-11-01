import {
  APPROVAL_TRANSITIONS,
  ApprovalState,
  canTransition,
  RUN_TRANSITIONS,
  RunState,
  type RunSubstate,
} from "@room/schemas";

/**
 * 状态机（D-03）。
 *
 * 转换规则**只来自 packages/schemas 的转换表**，这里不写任何 if/switch 判断合法性——
 * 契约改了实现自动跟，也不会出现「代码里偷偷多允许一条边」。
 *
 * AC-6：Approve 之后必须真的能产生 Run。
 * AC-9：Run 有且仅有一个 terminal event（转换层保证终态不可再转换）。
 */

export type TransitionTable<S extends string> = Readonly<Record<S, readonly S[]>>;

export type EntityKind = "approval" | "run" | "chat slot" | "media job";

/** 非法转换。带上 entity/from/to，方便 D-06 在错误路径里直接落库或记日志。 */
export class IllegalTransitionError extends Error {
  readonly entity: EntityKind;
  readonly from: string;
  readonly to: string;

  constructor(entity: EntityKind, from: string, to: string) {
    super(`${entity}: illegal transition ${from} -> ${to}`);
    this.name = "IllegalTransitionError";
    this.entity = entity;
    this.from = from;
    this.to = to;
  }
}

/** 该状态是否在表里（防止拿一个不存在的状态名来查）。 */
function isKnownState<S extends string>(table: TransitionTable<S>, state: string): state is S {
  return Object.hasOwn(table, state);
}

/**
 * 校验一次转换；非法时抛 IllegalTransitionError。
 * @param table - 契约里的转换表
 * @param entity - 出错信息里用的实体名
 */
export function assertTransition<S extends string>(
  table: TransitionTable<S>,
  entity: EntityKind,
  from: S,
  to: S,
): void {
  if (!isKnownState(table, from)) throw new IllegalTransitionError(entity, String(from), String(to));
  if (!canTransition(table, from, to)) throw new IllegalTransitionError(entity, from, to);
}

/** 返回目标状态；非法时抛错。写代码时用这个，别直接改字段。 */
export function transition<S extends string>(
  table: TransitionTable<S>,
  entity: EntityKind,
  from: S,
  to: S,
): S {
  assertTransition(table, entity, from, to);
  return to;
}

export function isTerminalState<S extends string>(table: TransitionTable<S>, state: S): boolean {
  if (!isKnownState(table, state)) return false;
  return table[state].length === 0;
}

/** Approval 的合法后继（只读，给 UI 决定按钮能不能点用）。 */
export function approvalNextStates(from: ApprovalState): readonly ApprovalState[] {
  return APPROVAL_TRANSITIONS[from] ?? [];
}

export function runNextStates(from: RunState): readonly RunState[] {
  return RUN_TRANSITIONS[from] ?? [];
}

export function transitionApproval(from: ApprovalState, to: ApprovalState): ApprovalState {
  return transition(APPROVAL_TRANSITIONS, "approval", from, to);
}

export function transitionRun(from: RunState, to: RunState): RunState {
  return transition(RUN_TRANSITIONS, "run", from, to);
}

export function isTerminalApprovalState(state: ApprovalState): boolean {
  return isTerminalState(APPROVAL_TRANSITIONS, state);
}

export function isTerminalRunState(state: RunState): boolean {
  return isTerminalState(RUN_TRANSITIONS, state);
}

/**
 * App 允许设置 substate 的唯一前提：主状态是 RUNNING。
 * entities.ts 的注释（「只在 RUNNING 时非 null」）在数据库层也有 CHECK 兜底。
 */
export function canHaveSubstate(state: RunState): boolean {
  return state === "RUNNING";
}

/** failure_reason 只在 FAILED 时允许（同上，DB 有对应 CHECK）。 */
export function canHaveFailureReason(state: RunState): boolean {
  return state === "FAILED";
}

export type { RunSubstate };

