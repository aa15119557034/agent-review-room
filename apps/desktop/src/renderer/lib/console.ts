import {
  quotaState,
  type AgentActivityCursor,
  type AgentActivityItem,
  type AgentActivityTurn,
  type AgentProfile,
  type AgentStatus,
  type ControlEvent,
  type QuotaState,
  type Turn,
} from "@room/schemas";
import { OUTCOME_LABEL } from "./discussion";
import { conversationTitle, slotLabel } from "./chat";

/**
 * 秘书控制台（C-37，契约 C-37a）。每位一页：状态、额度、正在答什么、历史、暂停 / 恢复、替补设置。
 * 规则和别处一样：只存后端给的数据。状态和额度用讨论室已经在维护的 disc.status（agents.status + agent.status 事件），
 * 暂停 / 替补走 agent.update，这里只多存一份「这位的活动」。
 */
export interface ConsoleState {
  /** 正在看谁；null = 还没选（打开时选第一位） */
  agentId: string | null;
  /** 这位的活动；null = 还没读到 */
  activity: ActivityPage | null;
  /** 后端还不认识 agents.activity（D-44 之前的真实后端）：活动两栏显示「还没接上」，其余照常 */
  activityAvailable: boolean;
}

export interface ActivityPage {
  agent: string;
  current: AgentActivityItem[];
  recent: AgentActivityItem[];
  nextCursor: AgentActivityCursor | null;
}

export const initialConsole: ConsoleState = { agentId: null, activity: null, activityAvailable: true };

// ---------------------------------------------------------------- 活动列表

/** turn.updated 带的是整份 Turn；活动列表只要摘要（C-37a：不带 partialText 等） */
export const activityTurn = (t: Turn): AgentActivityTurn => ({
  id: t.id,
  agent: t.agent,
  onBehalfOf: t.onBehalfOf,
  isSummary: t.isSummary,
  outcome: t.outcome,
  replyMessageId: t.replyMessageId,
  supersededBy: t.supersededBy,
  createdAt: t.createdAt,
  finishedAt: t.finishedAt,
});

const keyOf = (x: AgentActivityItem) => (x.kind === "discussion" ? x.turn : x.slot);
export const activityId = (x: AgentActivityItem) => keyOf(x).id;
export const isLiveActivity = (x: AgentActivityItem) =>
  x.kind === "discussion" ? x.turn.outcome === "pending" || x.turn.outcome === "running" : x.slot.outcome === "running";

/** 新的在前：(createdAt, id) 倒序，和后端分页的顺序一致 */
const newerFirst = (a: AgentActivityItem, b: AgentActivityItem) => {
  const x = keyOf(a);
  const y = keyOf(b);
  if (x.createdAt !== y.createdAt) return x.createdAt < y.createdAt ? 1 : -1;
  return x.id === y.id ? 0 : x.id < y.id ? 1 : -1;
};

/**
 * 重查第一页（来了没见过的活动）：换上新的第一页，**保留已经翻出来的更早部分**（汐 #160），不让用户再点一遍「更早的」。
 * 新的第一页不满一页 = 已经全在里面了，直接用它
 */
export function mergeFirstPage(old: ActivityPage | null, fresh: ActivityPage, limit: number): ActivityPage {
  if (!old || old.agent !== fresh.agent || fresh.recent.length < limit) return fresh;
  const last = fresh.recent[fresh.recent.length - 1]!;
  const seen = new Set([...fresh.current, ...fresh.recent].map(activityId));
  const older = old.recent.filter((x) => !seen.has(activityId(x)) && newerFirst(last, x) < 0);
  if (older.length === 0) return fresh;
  return { ...fresh, recent: [...fresh.recent, ...older], nextCursor: old.nextCursor };
}

/** 翻页：接在后面，按 id 去重（翻页期间有新的结束了，可能和第一页重复） */
export function appendRecent(page: ActivityPage, more: { recent: AgentActivityItem[]; nextCursor: AgentActivityCursor | null }): ActivityPage {
  const seen = new Set(page.recent.map(activityId));
  return { ...page, recent: [...page.recent, ...more.recent.filter((x) => !seen.has(activityId(x)))], nextCursor: more.nextCursor };
}

/**
 * turn.updated / chat.slot.updated → 就地更新这位的活动。
 * - 不是这位的：不变
 * - 已经在列表里：换上新的 Turn / 回答位；结束了就从 current 挪进 recent（按顺序插入）
 * - 不在列表里（新的一次）：返回 reload = true，由调用方重新查第一页（项目名、预览只有后端给得出）
 */
export function applyActivityEvent(page: ActivityPage, event: ControlEvent): { page: ActivityPage; reload: boolean } {
  let id: string;
  let replace: (x: AgentActivityItem) => AgentActivityItem;
  if (event.type === "turn.updated") {
    if (event.turn.agent !== page.agent) return { page, reload: false };
    id = event.turn.id;
    replace = (x) => (x.kind === "discussion" ? { ...x, turn: activityTurn(event.turn) } : x);
  } else if (event.type === "chat.slot.updated") {
    if (event.slot.agent !== page.agent) return { page, reload: false };
    id = event.slot.id;
    replace = (x) => (x.kind === "chat" ? { ...x, slot: event.slot } : x);
  } else {
    return { page, reload: false };
  }
  const old = [...page.current, ...page.recent].find((x) => activityId(x) === id);
  if (!old) return { page, reload: true };
  const next = replace(old);
  const current = page.current.filter((x) => activityId(x) !== id);
  const recent = page.recent.filter((x) => activityId(x) !== id);
  if (isLiveActivity(next)) {
    // 重试让回答位回到 running：回到「正在答」，保持正序
    return { page: { ...page, current: [...current, next].sort((a, b) => newerFirst(b, a)), recent }, reload: false };
  }
  return { page: { ...page, current, recent: [...recent, next].sort(newerFirst) }, reload: false };
}

// ---------------------------------------------------------------- 显示

export const AVAILABILITY_LABEL: Record<AgentStatus["availability"], string> = {
  available: "在线",
  offline: "离线",
  unconfigured: "未配置",
  paused_by_user: "已暂停",
  absent_quota: "缺席（额度）",
};

export const QUOTA_STATE_LABEL: Record<QuotaState, string> = {
  ok: "额度正常",
  exhausted: "额度用完",
  unknown: "额度未知",
};

export const BILLING_LABEL: Record<AgentStatus["billing"], string> = {
  subscription: "订阅",
  api: "按量计费",
  unknown: "计费方式未知",
};

export interface QuotaRow {
  label: string;
  /** 已用百分比，原样；剩余 = 100 - usedPercent */
  usedPercent: number;
  resetsAt: string | null;
}

/**
 * 额度面板要显示什么。读不到的项**不显示数字**，只在 rows 里缺这一行（界面写「未知」）；
 * 状态用契约的 quotaState，不自己判断。
 */
export function quotaView(st: AgentStatus | undefined) {
  if (!st) return { state: "unknown" as QuotaState, rows: [] as QuotaRow[], balance: null, billing: "unknown" as const };
  const rows: QuotaRow[] = [];
  if (st.fiveHour) rows.push({ label: "5 小时", ...st.fiveHour });
  if (st.weekly) rows.push({ label: "每周", ...st.weekly });
  return { state: quotaState(st), rows, balance: st.balance, billing: st.billing };
}

/** 百分比保留 1 位，整数不带小数 */
export const pct = (n: number) => `${Math.round(n * 10) / 10}%`;

/** 余额：人民币加 ¥，其他货币原样写在后面 */
export const money = (b: { amount: string; currency: string }) => (b.currency === "CNY" ? `¥${b.amount}` : `${b.amount} ${b.currency}`);

/** 活动一行的标题：讨论写「议题 · 第 N 轮」，聊天写会话名 */
export function activityTitle(x: AgentActivityItem, name: (agent: string) => string): string {
  if (x.kind === "discussion") return `${x.projectName} · 第 ${x.roundIndex} 轮`;
  return conversationTitle(x.conversation, name);
}

/** 活动一行的标签（讨论 / 聊天、汇总、代谁答、第几次） */
export function activityTags(x: AgentActivityItem, name: (agent: string) => string): string[] {
  if (x.kind === "discussion") {
    const tags = [x.turn.isSummary ? "讨论 · 汇总" : "讨论"];
    if (x.turn.onBehalfOf) tags.push(`代 ${name(x.turn.onBehalfOf)} 答`);
    return tags;
  }
  const tags = [x.conversation.kind === "group" ? "群聊" : "单聊"];
  if (x.slot.attempt > 1) tags.push(`第 ${x.slot.attempt} 次`);
  return tags;
}

export type ActivityTone = "active" | "good" | "bad" | "quiet";

/** 结局：文字照讨论室 / 聊天里的叫法；讨论里 answered 在时间线上不写字，这里要写 */
export function activityOutcome(x: AgentActivityItem): { label: string; tone: ActivityTone } {
  if (x.kind === "discussion") {
    const o = x.turn.outcome;
    const label = o === "answered" ? "已答" : OUTCOME_LABEL[o];
    const tone: ActivityTone =
      o === "pending" || o === "running" ? "active"
        : o === "answered" ? "good"
        : o === "absent_quota" || o === "timed_out" || o === "failed" ? "bad"
        : "quiet";
    return { label, tone };
  }
  const o = x.slot.outcome;
  const tone: ActivityTone =
    o === "running" ? "active"
      : o === "answered" || o === "skipped" ? "good"
      : o === "absent_quota" || o === "unavailable" || o === "failed" ? "bad"
      : "quiet";
  return { label: slotLabel(x.slot), tone };
}

/** 预览：null 时说明为什么没有（撤回的不露原文） */
export function activityPreview(x: AgentActivityItem): { text: string; muted: boolean } {
  if (x.preview) return { text: x.preview, muted: false };
  if (x.kind === "chat" && x.slot.outcome === "retracted") return { text: "（消息已撤回）", muted: true };
  return { text: x.kind === "chat" ? "（图片 / 语音 / 表情）" : "（没有题面）", muted: true };
}

/**
 * 替补能选谁：能参加讨论的其他人。两人互为替补在设置层面允许；同一轮两人都缺席时 round.draft 会拒绝（不做替补链，D-32），
 * 到时要换一个替补。汇总者限制在议题层面，由 round.draft 校验，这里不管。现在不能答的人照样列出，界面标出来（汐 #160）
 */
export function substituteOptions(agents: readonly AgentProfile[], self: string): AgentProfile[] {
  return agents.filter((a) => a.id !== self && a.canDiscuss);
}

/** 历史按「项目」分组（C-33b，江浩：历史按项目分）：讨论按议题、聊天按会话；组按最近一条的先后，组内保持原顺序 */
export interface ActivityGroup {
  key: string;
  title: string;
  kind: "discussion" | "group" | "direct";
  items: AgentActivityItem[];
}

export function groupActivity(items: readonly AgentActivityItem[], name: (agent: string) => string): ActivityGroup[] {
  const out: ActivityGroup[] = [];
  const byKey = new Map<string, ActivityGroup>();
  for (const x of items) {
    const key = x.kind === "discussion" ? `p:${x.projectId}` : `c:${x.conversation.id}`;
    let g = byKey.get(key);
    if (!g) {
      g = {
        key,
        title: x.kind === "discussion" ? x.projectName : conversationTitle(x.conversation, name),
        kind: x.kind === "discussion" ? "discussion" : x.conversation.kind === "group" ? "group" : "direct",
        items: [],
      };
      byKey.set(key, g);
      out.push(g);
    }
    g.items.push(x);
  }
  return out;
}
