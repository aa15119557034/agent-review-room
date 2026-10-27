import type {
  AgentEvent,
  AgentProfile,
  AgentStatus,
  ApprovalBatch,
  ControlEvent,
  Message,
  ModelOption,
  PlanVersion,
  PromptSnapshot,
  Round,
  RoundSummary,
  Stance,
  Turn,
} from "@room/schemas";

/**
 * 讨论室的状态（C-21）。和 Phase 0 的状态放在同一个 store 里（AppState.disc），
 * 但规则单独写在这里：只存后端给的数据，不在前端推导业务状态。
 */
export interface DiscussionState {
  /** 后端还没有实现讨论室（真实后端在 D-21 之前）时为 false */
  available: boolean;
  agents: AgentProfile[];
  status: Record<string, AgentStatus>;
  rounds: Round[];
  batches: ApprovalBatch[];
  turns: Turn[];
  summaries: RoundSummary[];
  plans: PlanVersion[];
  /**
   * 每位参与者能选的模型（C-41，从节点 health 的 profileModels 来）。
   * 没有这个 key = 还没问过；null = 问过但节点没报（老节点、连不上、没有这个 profile）
   */
  models: Record<string, ModelOption[] | null>;
  /** 确认页正在看的批次（含每个收件人的完整 Snapshot） */
  confirm: { batch: ApprovalBatch; snapshots: PromptSnapshot[] } | null;
  ui: {
    railCollapsed: boolean;
    sideCollapsed: boolean;
    /** roundId → 是否折叠 */
    collapsedRounds: Record<string, boolean>;
    /** messageId / turnId → 是否展开全文 */
    expanded: Record<string, boolean>;
    composer: { text: string; recipients: string[] };
    /** 一轮进行中时，输入框发出去的是"补充"：怎么处理正在答的人、发给谁 */
    interject: { mode: "restart_now" | "next_round" | "only"; targets: string[] };
    /** 中间区域：时间线，或者某一轮的汇总与方案页 */
    page: { kind: "timeline" } | { kind: "review"; roundId: string };
  };
}

export const initialDiscussion: DiscussionState = {
  available: true,
  agents: [],
  status: {},
  rounds: [],
  batches: [],
  turns: [],
  summaries: [],
  plans: [],
  models: {},
  confirm: null,
  ui: {
    railCollapsed: false,
    sideCollapsed: false,
    collapsedRounds: {},
    expanded: {},
    composer: { text: "", recipients: [] },
    interject: { mode: "restart_now", targets: [] },
    page: { kind: "timeline" },
  },
};

const upsert = <T>(list: T[], item: T, key: (x: T) => string): T[] => {
  const k = key(item);
  const i = list.findIndex((x) => key(x) === k);
  if (i === -1) return [...list, item];
  const next = list.slice();
  next[i] = item;
  return next;
};
const byId = (x: { id: string }) => x.id;

/** 讨论室事件 → 状态。不属于当前议题的忽略（切换议题时会重新查询） */
export function applyDiscussionEvent(d: DiscussionState, event: ControlEvent, projectId: string | null): DiscussionState {
  switch (event.type) {
    case "round.updated":
      if (event.round.projectId !== projectId) return d;
      return { ...d, rounds: upsert(d.rounds, event.round, byId) };
    case "batch.updated": {
      if (event.batch.projectId !== projectId) return d;
      const confirm = d.confirm && d.confirm.batch.id === event.batch.id ? { ...d.confirm, batch: event.batch } : d.confirm;
      return { ...d, batches: upsert(d.batches, event.batch, byId), confirm };
    }
    case "turn.updated":
      if (!d.rounds.some((r) => r.id === event.turn.roundId) && !d.batches.some((b) => b.id === event.turn.batchId)) {
        // 新一轮的 Turn 可能比 round.updated 先到；只要批次属于当前议题就收下
        return d;
      }
      return { ...d, turns: upsert(d.turns, event.turn, byId) };
    case "summary.created":
      if (!d.rounds.some((r) => r.id === event.summary.roundId)) return d;
      return { ...d, summaries: upsert(d.summaries, event.summary, (s) => s.roundId) };
    case "plan.updated":
      if (event.plan.projectId !== projectId) return d;
      return { ...d, plans: upsert(d.plans, event.plan, byId) };
    case "agent.status":
      return { ...d, status: { ...d.status, [event.status.agent]: event.status } };
    default:
      return d;
  }
}

// ---------------------------------------------------------------- selectors

const OPEN: readonly Round["state"][] = ["DRAFT", "RUNNING", "PAUSED", "AWAITING_SUMMARY", "SUMMARIZING"];

export const openRound = (d: DiscussionState): Round | null =>
  [...d.rounds].sort((a, b) => b.index - a.index).find((r) => OPEN.includes(r.state)) ?? null;

/** 等盖章的批次（每个议题同一时间通常只有一个） */
export const pendingBatches = (d: DiscussionState) => d.batches.filter((b) => b.state === "READY_FOR_REVIEW");

/** 右侧显示的方案：当前确认的，否则最新的草稿 */
const newest = (plans: readonly PlanVersion[]) => [...plans].sort((a, b) => b.version - a.version)[0] ?? null;

/** 右栏显示哪一版：最新的有效版本（草稿比当前 / 定稿新时显示草稿） */
export function displayedPlan(d: DiscussionState): PlanVersion | null {
  return newest(d.plans.filter((p) => p.state === "CURRENT" || p.state === "FINAL" || p.state === "DRAFT"));
}

/**
 * 下一轮附带哪一版：当前版本；没有当前版本时，用最新的定稿（定稿以后继续讨论，带的就是定稿）。
 * 没确认的草稿不带——它还没被用户认可。
 */
export function planForNextRound(d: DiscussionState): PlanVersion | null {
  return newest(d.plans.filter((p) => p.state === "CURRENT")) ?? newest(d.plans.filter((p) => p.state === "FINAL"));
}

/** 只能从最新的有效版本派生，而且它必须已经定稿（和 D-22k 一致；避免连点叠出空版本） */
export function canDerive(d: DiscussionState, plan: PlanVersion): boolean {
  return plan.state === "FINAL" && displayedPlan(d)?.id === plan.id;
}

export const agentName = (d: DiscussionState, id: string) => d.agents.find((a) => a.id === id)?.displayName ?? id;
export const agentColor = (d: DiscussionState, id: string) => d.agents.find((a) => a.id === id)?.color ?? "#566870";

export type TimelineEntry =
  | { kind: "note"; key: string; message: Extract<Message, { kind: "human_note" }> }
  /** 从聊天转来的初始材料（chat.toTopic，C-35） */
  | { kind: "material"; key: string; message: Extract<Message, { kind: "chat_material" }> }
  | { kind: "round"; key: string; round: Round; batches: ApprovalBatch[] }
  | { kind: "turn"; key: string; round: Round; turn: Turn; reply: Message | null }
  | { kind: "summary"; key: string; round: Round; turn: Turn; reply: Message | null; summary: RoundSummary | null };

/**
 * 时间线：按时间排序；每一轮先是分隔条，然后是这一轮的发言和插话，最后是汇总。
 * 还没盖章、被拒绝的发言不进时间线（分隔条上会显示"等盖章"）。
 */
export function timeline(d: DiscussionState, messages: Message[]): TimelineEntry[] {
  type Keyed = { ts: string; order: number; entry: TimelineEntry };
  const out: Keyed[] = [];
  const roundById = new Map(d.rounds.map((r) => [r.id, r]));
  for (const r of d.rounds) {
    out.push({ ts: r.createdAt, order: 0, entry: { kind: "round", key: r.id, round: r, batches: d.batches.filter((b) => b.roundId === r.id) } });
  }
  for (const t of d.turns) {
    const r = roundById.get(t.roundId);
    if (!r || t.outcome === "pending" || t.outcome === "rejected") continue;
    const reply = t.replyMessageId ? messages.find((m) => m.id === t.replyMessageId) ?? null : null;
    const ts = r.createdAt > t.createdAt ? r.createdAt : t.createdAt;
    if (t.isSummary) {
      const summary = d.summaries.find((s) => s.roundId === r.id) ?? null;
      out.push({ ts, order: 2, entry: { kind: "summary", key: t.id, round: r, turn: t, reply, summary } });
    } else {
      out.push({ ts, order: 1, entry: { kind: "turn", key: t.id, round: r, turn: t, reply } });
    }
  }
  for (const m of messages) {
    if (m.kind === "human_note") out.push({ ts: m.createdAt, order: 1, entry: { kind: "note", key: m.id, message: m } });
    if (m.kind === "chat_material") out.push({ ts: m.createdAt, order: 0, entry: { kind: "material", key: m.id, message: m } });
  }
  return out
    .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.order - b.order))
    .map((k) => k.entry);
}

/** 一个 Turn 应该显示的文字和来源 */
export function turnText(turn: Turn, reply: Message | null, events: AgentEvent[] | undefined): { text: string; live: boolean } {
  if (reply) return { text: reply.content, live: false };
  const streamed = (events ?? []).map((e) => (e.type === "message_delta" ? e.text : "")).join("");
  if (turn.outcome === "running") return { text: streamed, live: true };
  // 停下来的发言（暂停 / 打断 / 结束本轮 / 超时）：以记录里的 partialText 为准；
  // 记录里没有时用这个 Run 已收到的文字兜底，不让已经写出来的部分在界面上消失
  return { text: turn.partialText ?? streamed, live: false };
}

export const OUTCOME_LABEL: Record<Turn["outcome"], string> = {
  pending: "等盖章",
  running: "回答中",
  answered: "",
  interrupted: "被打断",
  round_ended: "被中断（结束本轮）",
  paused: "暂停时停下",
  absent_quota: "缺席（额度）",
  timed_out: "超时",
  failed: "失败",
  rejected: "没有盖章",
};

export const ROUND_STATE_LABEL: Record<Round["state"], string> = {
  DRAFT: "等盖章",
  RUNNING: "进行中",
  PAUSED: "已暂停",
  AWAITING_SUMMARY: "等汇总",
  SUMMARIZING: "汇总中",
  SUMMARIZED: "已汇总",
  VOIDED: "已作废",
};

export const TASK_SOURCE_LABEL: Record<Round["taskSource"], string> = {
  human: "你写的",
  summarizer_proposal: "汇总者提议",
  carried_over: "上轮遗留",
};

export function formatActive(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
}

/** 阶段条：议题 → 第 1 轮 → 汇总 v1 → 第 2 轮 → … */
export interface Stage {
  key: string;
  label: string;
  state: "done" | "current" | "voided" | "todo";
  roundId: string | null;
}

export function stages(d: DiscussionState): Stage[] {
  const out: Stage[] = [{ key: "topic", label: "议题", state: "done", roundId: null }];
  for (const r of [...d.rounds].sort((a, b) => a.index - b.index)) {
    const voided = r.state === "VOIDED";
    const open = OPEN.includes(r.state);
    out.push({ key: r.id, label: `第 ${r.index} 轮`, state: voided ? "voided" : open && r.state !== "AWAITING_SUMMARY" && r.state !== "SUMMARIZING" ? "current" : "done", roundId: r.id });
    const sum = d.summaries.find((s) => s.roundId === r.id);
    const plan = sum?.planVersionId ? d.plans.find((p) => p.id === sum.planVersionId) : undefined;
    if (sum) out.push({ key: `${r.id}-sum`, label: plan ? `汇总 v${plan.version}` : "汇总", state: "done", roundId: r.id });
    else if (r.state === "AWAITING_SUMMARY" || r.state === "SUMMARIZING") out.push({ key: `${r.id}-sum`, label: "汇总", state: "current", roundId: r.id });
  }
  const final = d.plans.find((p) => p.state === "FINAL");
  out.push({ key: "final", label: final ? `定稿 v${final.version}` : "定稿", state: final ? "done" : "todo", roundId: null });
  out.push({ key: "exec", label: "执行", state: "todo", roundId: null });
  return out;
}

/** 方案两版之间按行对比：新增 / 删除 / 不变 */
export type DiffLine = { kind: "same" | "added" | "removed"; text: string };

export function diffLines(before: string, after: string): DiffLine[] {
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");
  // 最长公共子序列，方案一般只有几十行，O(n·m) 足够
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) (out.push({ kind: "same", text: a[i]! }), i++, j++);
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) out.push({ kind: "removed", text: a[i++]! });
    else out.push({ kind: "added", text: b[j++]! });
  }
  while (i < a.length) out.push({ kind: "removed", text: a[i++]! });
  while (j < b.length) out.push({ kind: "added", text: b[j++]! });
  return out;
}

export const STANCE_LABEL: Record<Stance, string> = {
  agree: "同意",
  partial: "部分同意",
  oppose: "反对",
  no_response: "未回应",
  timed_out: "超时",
  abstained: "弃权",
  off_topic: "答非所问",
  not_addressed: "未涉及",
  absent_quota: "缺席（额度）",
  interrupted: "被中断",
};
