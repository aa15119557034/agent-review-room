import type {
  AgentEvent,
  Approval,
  Contribution,
  ControlEvent,
  Message,
  Project,
  Run,
  SystemStatus,
} from "@room/schemas";

/**
 * renderer 的全部状态。只存从后端拿到的数据和少量 UI 状态，不在前端推导业务状态
 * （例如 Run 是否结束只看 run.state，不根据事件自己判断）。
 */
export interface AppState {
  connection: { phase: "connecting" } | { phase: "ready" } | { phase: "failed"; message: string };
  status: SystemStatus | null;
  projects: Project[];
  currentProjectId: string | null;
  messages: Message[];
  contributions: Contribution[];
  approvals: Approval[];
  runs: Run[];
  /** runId → 按 seq 递增的事件；只保存当前项目的 run */
  runEvents: Record<string, AgentEvent[]>;
  /** 最近一次操作失败的说明，显示在界面上，由用户关闭 */
  notice: { kind: "error"; message: string } | null;
}

export const initialState: AppState = {
  connection: { phase: "connecting" },
  status: null,
  projects: [],
  currentProjectId: null,
  messages: [],
  contributions: [],
  approvals: [],
  runs: [],
  runEvents: {},
  notice: null,
};

const upsert = <T extends { id: string }>(list: T[], item: T): T[] => {
  const i = list.findIndex((x) => x.id === item.id);
  if (i === -1) return [...list, item];
  const next = list.slice();
  next[i] = item;
  return next;
};

/**
 * 把后端推送的事件合并进状态。纯函数，可单测。
 *
 * - 不属于当前项目的事件直接忽略（切换项目时会重新查询）
 * - run.event 按 seq 去重：seq 不大于已有最大值的事件丢弃，所以重放和重复推送都安全
 */
export function applyEvent(state: AppState, event: ControlEvent): AppState {
  const pid = state.currentProjectId;
  switch (event.type) {
    case "message.created":
      if (event.message.projectId !== pid) return state;
      return { ...state, messages: upsert(state.messages, event.message) };

    case "approval.updated":
      if (event.approval.projectId !== pid) return state;
      return { ...state, approvals: upsert(state.approvals, event.approval) };

    case "run.updated":
      if (event.run.projectId !== pid) return state;
      return { ...state, runs: upsert(state.runs, event.run) };

    case "run.event": {
      const runId = event.event.runId;
      if (!state.runs.some((r) => r.id === runId)) return state;
      return { ...state, runEvents: { ...state.runEvents, [runId]: appendEvents(state.runEvents[runId], [event.event]) } };
    }

    case "permission.requested":
      // Phase 0 不会出现；Phase 1 接权限 UI 时处理
      return state;
  }
}

/** 合并事件，保证 seq 严格递增、无重复 */
export function appendEvents(existing: AgentEvent[] | undefined, incoming: AgentEvent[]): AgentEvent[] {
  const out = existing ? existing.slice() : [];
  let last = out.length ? out[out.length - 1]!.seq : -1;
  for (const e of [...incoming].sort((a, b) => a.seq - b.seq)) {
    if (e.seq <= last) continue;
    out.push(e);
    last = e.seq;
  }
  return out;
}

// ---------------------------------------------------------------- selectors

export const currentProject = (s: AppState) => s.projects.find((p) => p.id === s.currentProjectId) ?? null;

export const pendingApprovals = (s: AppState) =>
  s.approvals.filter((a) => a.state === "READY_FOR_REVIEW" || a.state === "APPROVED");

export const runsNewestFirst = (s: AppState) =>
  [...s.runs].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
