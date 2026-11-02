import type { ApprovalBatch, BatchKind, PlanVersion, Project, Round, Turn } from "@room/schemas";
import { displayedPlan, type DiscussionState } from "./discussion";

/**
 * 讨论室标签（C-38，ADR-003 §3 / §4）：议题列表的一句话状态 + 「等你处理」。
 *
 * 只用已有的查询（rounds.list / plans.list / rounds.get），不新增命令；
 * 状态全部从后端给的 Round / 批次 / Turn / 方案读出来，不猜。
 */

/** 一个议题读出状态所需的数据。当前打开的议题直接用 disc 里的实时数据，其它议题用 board 里的缓存 */
export interface TopicDigest {
  rounds: Round[];
  /** 只有没结束的那一轮的批次（其它轮不会再有等盖章的批次） */
  batches: ApprovalBatch[];
  /** 只有没结束的那一轮的 Turn（用来说「谁在回答」） */
  turns: Turn[];
  plans: PlanVersion[];
}

export type TopicGroup = "todo" | "active" | "new" | "final";

export const GROUP_LABEL: Record<TopicGroup, string> = {
  todo: "等你处理",
  active: "进行中",
  new: "还没开始",
  final: "已定稿",
};
export const GROUP_ORDER: readonly TopicGroup[] = ["todo", "active", "new", "final"];

/** 一件等你处理的事。点它：先打开议题；stamp 直接打开原来的确认页 */
export type TodoItem =
  | { kind: "stamp"; projectId: string; batchId: string; roundIndex: number; batchKind: BatchKind; label: string }
  | { kind: "confirm_plan"; projectId: string; planId: string; version: number; label: string }
  | { kind: "summarize"; projectId: string; roundId: string; roundIndex: number; label: string }
  | { kind: "void"; projectId: string; roundId: string; roundIndex: number; label: string };

export interface TopicStatus {
  group: TopicGroup;
  /** 一句话状态，例如「第 2 轮 · 汐回答中」「等你盖章」「v2 已定稿」 */
  line: string;
  todos: TodoItem[];
  /** 排序用：最近一次动静 */
  lastActivity: string;
}

const OPEN: readonly Round["state"][] = ["DRAFT", "RUNNING", "PAUSED", "AWAITING_SUMMARY", "SUMMARIZING"];
export const isOpenRound = (r: Round) => OPEN.includes(r.state);

const STAMP_WHAT: Record<BatchKind, string> = {
  initial: "发出去",
  resume: "恢复",
  supplement: "补充",
  retry: "重试",
  summary: "汇总",
};

/** 从当前议题的实时状态取同样的一份数据 */
export function digestFromDisc(d: DiscussionState): TopicDigest {
  const open = d.rounds.filter(isOpenRound).map((r) => r.id);
  return {
    rounds: d.rounds,
    batches: d.batches.filter((b) => b.roundId !== null && open.includes(b.roundId)),
    turns: d.turns.filter((t) => open.includes(t.roundId)),
    plans: d.plans,
  };
}

const latest = (...xs: (string | null | undefined)[]) => xs.filter((x): x is string => !!x).sort().at(-1) ?? "";

/**
 * 一个议题的状态。优先级：等你盖章 > 方案草稿等你确认 > 本轮答完等你请人汇总 > 进行中 > 已定稿 > 还没开始。
 * names：参与者 id → 名字
 */
export function topicStatus(project: Project, g: TopicDigest | undefined, name: (agent: string) => string): TopicStatus {
  if (!g) return { group: "new", line: "读取中…", todos: [], lastActivity: project.createdAt };
  const rounds = [...g.rounds].sort((a, b) => b.index - a.index);
  const open = rounds.find(isOpenRound) ?? null;
  const last = rounds[0] ?? null;
  const plan = displayedPlan({ plans: g.plans } as DiscussionState);
  const todos: TodoItem[] = [];
  const pid = project.id;

  if (open) {
    for (const b of g.batches.filter((x) => x.roundId === open.id && x.state === "READY_FOR_REVIEW")) {
      todos.push({
        kind: "stamp", projectId: pid, batchId: b.id, roundIndex: open.index, batchKind: b.kind,
        label: `第 ${open.index} 轮${b.kind === "initial" ? "" : STAMP_WHAT[b.kind]}等你盖章`,
      });
    }
  }
  if (plan?.state === "DRAFT") {
    todos.push({ kind: "confirm_plan", projectId: pid, planId: plan.id, version: plan.version, label: `方案 v${plan.version} 草稿等你确认` });
  }
  const openTurns = open ? g.turns.filter((t) => t.roundId === open.id) : [];
  if (open?.state === "AWAITING_SUMMARY" && !todos.some((t) => t.kind === "stamp")) {
    const answered = openTurns.some((t) => !t.isSummary && t.outcome === "answered");
    todos.push(
      answered
        ? { kind: "summarize", projectId: pid, roundId: open.id, roundIndex: open.index, label: `第 ${open.index} 轮答完了，等你请人汇总` }
        : { kind: "void", projectId: pid, roundId: open.id, roundIndex: open.index, label: `第 ${open.index} 轮没人回答，可以改方向` },
    );
  }

  const lastActivity = latest(
    project.createdAt,
    ...g.rounds.map((r) => r.createdAt),
    ...g.batches.map((b) => b.decidedAt ?? b.createdAt),
    ...g.turns.map((t) => t.createdAt),
    ...g.plans.map((p) => p.decidedAt ?? p.createdAt),
  );

  if (todos.length > 0) return { group: "todo", line: todos[0]!.label, todos, lastActivity };

  if (open) return { group: "active", line: openLine(open, openTurns, name), todos, lastActivity };

  if (plan?.state === "FINAL") return { group: "final", line: `v${plan.version} 已定稿`, todos, lastActivity };
  if (plan?.state === "CURRENT") {
    return { group: "active", line: `方案 v${plan.version} · 可以再讨论或定稿`, todos, lastActivity };
  }
  if (last) {
    const tail = last.state === "VOIDED" ? "已作废" : "已汇总";
    return { group: "active", line: `第 ${last.index} 轮${tail}`, todos, lastActivity };
  }
  return { group: "new", line: "还没开始", todos, lastActivity };
}

function openLine(r: Round, turns: Turn[], name: (agent: string) => string): string {
  const head = `第 ${r.index} 轮`;
  const running = (summary: boolean) =>
    [...new Set(turns.filter((t) => t.outcome === "running" && t.isSummary === summary).map((t) => name(t.agent)))];
  switch (r.state) {
    case "RUNNING": {
      const who = running(false);
      return who.length ? `${head} · ${who.join("、")}回答中` : `${head} · 进行中`;
    }
    case "SUMMARIZING": {
      const who = running(true);
      return who.length ? `${head} · ${who.join("、")}汇总中` : `${head} · 汇总中`;
    }
    case "PAUSED":
      return `${head} · 已暂停`;
    case "AWAITING_SUMMARY":
      return `${head} · 等汇总`;
    case "DRAFT":
      return `${head} · 还没盖章`;
    default:
      return head;
  }
}

/** 议题按组排好；组内最近有动静的在前 */
export function groupTopics(
  projects: readonly Project[],
  statusOf: (p: Project) => TopicStatus,
): { group: TopicGroup; items: { project: Project; status: TopicStatus }[] }[] {
  const all = projects.map((project) => ({ project, status: statusOf(project) }));
  return GROUP_ORDER.map((group) => ({
    group,
    items: all
      .filter((x) => x.status.group === group)
      .sort((a, b) => (a.status.lastActivity < b.status.lastActivity ? 1 : a.status.lastActivity > b.status.lastActivity ? -1 : 0)),
  })).filter((x) => x.items.length > 0);
}

/** 当前议题用实时数据，其它议题用缓存 */
export function statusFor(
  d: DiscussionState,
  currentProjectId: string | null,
  project: Project,
): TopicStatus {
  const name = (id: string) => d.agents.find((a) => a.id === id)?.displayName ?? id;
  const g = project.id === currentProjectId && d.board.live === project.id ? digestFromDisc(d) : d.board.topics[project.id];
  return topicStatus(project, g, name);
}

/** 顶栏「讨论」上的角标：所有议题等你处理的事加起来 */
export function todoCount(d: DiscussionState, currentProjectId: string | null, projects: readonly Project[]): number {
  return projects.reduce((n, p) => n + statusFor(d, currentProjectId, p).todos.length, 0);
}
