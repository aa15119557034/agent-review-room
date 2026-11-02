import type {
  AppearanceSettings,
  AgentEvent,
  Approval,
  Contribution,
  ControlEvent,
  Message,
  Project,
  PromptSnapshot,
  ReviewerNodeSettings,
  Run,
  SystemStatus,
} from "@room/schemas";
import { applyDiscussionEvent, initialDiscussion, type DiscussionState } from "./discussion";
import { applyChatEvent, initialChat, isChatRun, type ChatState } from "./chat";
import { initialConsole, type ConsoleState } from "./console";

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
  /** snapshotId → Snapshot。按需加载，Snapshot 不可变所以可以一直缓存 */
  snapshots: Record<string, PromptSnapshot>;
  /** 正在编辑、还没生成 Snapshot 的 prompt。切换项目时重置 */
  draft: PromptDraft;
  /** 用户在运行记录里点选的 run；null 表示默认显示最新的一个 */
  selectedRunId: string | null;
  /** 顶栏切换：聊天（C-35）、讨论室（主页）、秘书控制台（C-37）、单次评审（Phase 0 工作台）、设置 */
  view: "chat" | "discussion" | "console" | "desk" | "settings";
  /** 讨论室（C-21） */
  disc: DiscussionState;
  /** 聊天空间（C-35） */
  chat: ChatState;
  /** 秘书控制台（C-37） */
  console: ConsoleState;
  /** Reviewer 节点设置；undefined = 还没读过，null = 从未设置 */
  reviewerNode: ReviewerNodeSettings | null | undefined;
  /** 你在聊天里的名字和头像（appearance.get）；读不到时为 null，界面显示「我」 */
  appearance: AppearanceSettings | null;
  /** 最近一次操作失败的说明，显示在界面上，由用户关闭 */
  notice: { kind: "error"; message: string } | null;
}

export interface PromptDraft {
  contributionIds: string[];
  taskInstruction: string;
}

export const DEFAULT_TASK =
  "请审查以下材料：指出其中的错误、风险和遗漏，说明理由；如果有更好的做法，请具体给出。";

export const emptyDraft = (): PromptDraft => ({ contributionIds: [], taskInstruction: DEFAULT_TASK });

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
  snapshots: {},
  draft: emptyDraft(),
  selectedRunId: null,
  view: "discussion",
  disc: initialDiscussion,
  chat: initialChat,
  console: initialConsole,
  reviewerNode: undefined,
  appearance: null,
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
      // 聊天回答的流式文字也走 run.event（按当前会话的回答位认）
      if (!state.runs.some((r) => r.id === runId) && !isChatRun(state.chat, runId)) return state;
      return { ...state, runEvents: { ...state.runEvents, [runId]: appendEvents(state.runEvents[runId], [event.event]) } };
    }

    case "permission.requested":
      // Phase 0 不会出现；Phase 1 接权限 UI 时处理
      return state;

    case "round.updated":
    case "batch.updated":
    case "turn.updated":
    case "summary.created":
    case "plan.updated":
    case "agent.status": {
      const disc = applyDiscussionEvent(state.disc, event, pid);
      return disc === state.disc ? state : { ...state, disc };
    }

    // 聊天空间（C-34 / C-35）
    case "chat.conversation.updated":
    case "chat.message.created":
    case "chat.message.updated":
    case "chat.slot.updated":
    case "chat.run.updated":
    // 多模态（C-43）：录音转写、画图 / 语音任务
    case "chat.voice.updated":
    case "media.updated": {
      const chat = applyChatEvent(state.chat, event);
      return chat === state.chat ? state : { ...state, chat };
    }
    // 摘要在界面上不显示
    case "chat.summary.updated":
      return state;
    // 项目笔记、换窗口、GitHub（C-46 契约）：界面在 C-47 接，先忽略
    case "projectNote.created":
    case "projectNote.rejected":
    case "chat.window.draftUpdated":
    case "chat.window.created":
    case "github.updated":
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

/** 当前等待批准的那一项（同一项目最多一个：生成新的会让旧的失效） */
export const readyApproval = (s: AppState) =>
  [...s.approvals].reverse().find((a) => a.state === "READY_FOR_REVIEW") ?? null;

/** 已经处理过的审批，新的在前 */
export const decidedApprovals = (s: AppState) =>
  s.approvals.filter((a) => a.state !== "READY_FOR_REVIEW" && a.state !== "DRAFT").reverse();

/** 草稿里勾选的片段，按片段创建顺序排列，并去掉已经不存在的 id */
export const draftContributions = (s: AppState) =>
  s.contributions.filter((c) => s.draft.contributionIds.includes(c.id));

/** 当前显示的 run：用户点选的，否则最新的 */
export const selectedRun = (s: AppState) =>
  (s.selectedRunId ? s.runs.find((r) => r.id === s.selectedRunId) : undefined) ?? runsNewestFirst(s)[0] ?? null;

export interface Transcript {
  text: string;
  /**
   * final     ：已入库的 reviewer_output，权威结果
   * streaming ：run 还在进行，由 message_delta 拼出来的临时文字
   * partial   ：run 已结束但没有最终结果（取消 / 失败 / 超时），显示中断前收到的部分
   * empty     ：还没有任何输出
   */
  source: "final" | "streaming" | "partial" | "empty";
}

/** 纯函数：某个 run 应该显示的文字 */
export function runTranscript(s: AppState, runId: string): Transcript {
  const final = s.messages.find((m) => m.kind === "reviewer_output" && m.runId === runId);
  if (final) return { text: final.content, source: "final" };
  const events = s.runEvents[runId] ?? [];
  const complete = events.find((e) => e.type === "message_complete");
  const text =
    complete && complete.type === "message_complete"
      ? complete.text
      : events.map((e) => (e.type === "message_delta" ? e.text : "")).join("");
  if (!text) return { text: "", source: "empty" };
  const run = s.runs.find((r) => r.id === runId);
  const finished = run ? !["QUEUED", "STARTING", "RUNNING"].includes(run.state) : false;
  return { text, source: finished ? "partial" : "streaming" };
}

/** run 的终止事件（用于显示失败原因、取消原因） */
export const terminalEvent = (s: AppState, runId: string) =>
  (s.runEvents[runId] ?? []).find((e) => ["completed", "error", "cancelled", "timed_out"].includes(e.type)) ?? null;
