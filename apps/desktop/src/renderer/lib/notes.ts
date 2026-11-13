import {
  CHAT_WINDOW_SUGGEST_COMPACTIONS,
  RUN_TRANSITIONS,
  type ChatMessage,
  type ChatRun,
  type ChatWindow,
  type ChatWindowDraft,
  type ChatWindowStatus,
  type ControlEvent,
  type GithubSyncStatus,
  type NoteScope,
  type ProjectNote,
  type ProjectNoteReason,
  type ProjectNoteSource,
  type RoomNoteRejectReason,
} from "@room/schemas";

/**
 * 项目笔记、换窗口、GitHub 同步的界面状态（C-47，契约 C-46 / ADR-005）。
 * 和别的状态一样只存后端给的：笔记版本、窗口、草稿、同步状态都以 main 为准，前端不推导版本号和压缩次数。
 *
 * 后端还不认识这些查询时（D-46 还没合），对应的 available 为 false，界面把入口藏起来，不弹错。
 */
export interface NotesState {
  /** projectNotes.* 能不能用 */
  available: boolean;
  /** scopeKey → 每位秘书的最新一版（projectNotes.list） */
  latest: Record<string, ProjectNote[]>;
  /** noteKey(scope, agent) → 历史版本，新的在前（projectNotes.history） */
  history: Record<string, ProjectNote[]>;
  /** chat.windows.* 能不能用 */
  windowsAvailable: boolean;
  /** 会话 → 每位成员的窗口状态（chat.windows.get），顺序同成员 */
  windows: Record<string, ChatWindowStatus[]>;
  /** 会话 → 换过的窗口，旧的在前（chat.windows.list），时间线画「换了新窗口」用 */
  windowList: Record<string, ChatWindow[]>;
  /** 草稿按 id（事件和命令返回的最新一份） */
  drafts: Record<string, ChatWindowDraft>;
  /** 写交接的 Run（purpose = window_handoff），看它是不是还在写 / 失败了 */
  handoffRuns: Record<string, ChatRun>;
  /** 这次运行里收到的「笔记没存上」（只推不存，重启就没了；回答本身照常） */
  rejected: RejectedNote[];
  /** GitHub 同步；null = 还没读到 */
  github: GithubSyncStatus | null;
  githubAvailable: boolean;
  sheet: NotesSheet;
}

export type NotesSheet =
  | null
  /** 看 / 改一位秘书的笔记。agents：同一个子项目里能切换的人；noteId：直接看某一版；tab：打开时停在哪 */
  | { kind: "note"; scope: NoteScope; agent: string; agents: string[]; noteId?: string; tab?: NoteTab }
  /** 换窗口的弹出单（看交接笔记、改、确认） */
  | { kind: "handoff"; conversationId: string; agent: string; draftId: string };

export type NoteTab = "note" | "diff" | "history";

export interface RejectedNote {
  scope: NoteScope;
  agent: string;
  reason: RoomNoteRejectReason;
  source: ProjectNoteSource;
}

export const initialNotes: NotesState = {
  available: true,
  latest: {},
  history: {},
  windowsAvailable: true,
  windows: {},
  windowList: {},
  drafts: {},
  handoffRuns: {},
  rejected: [],
  github: null,
  githubAvailable: true,
  sheet: null,
};

export const scopeKey = (s: NoteScope) => (s.kind === "topic" ? `p:${s.projectId}` : `c:${s.conversationId}`);
export const noteKey = (s: NoteScope, agent: string) => `${scopeKey(s)}|${agent}`;
export const sameScope = (a: NoteScope, b: NoteScope) => scopeKey(a) === scopeKey(b);

const REJECTED_KEEP = 50;

/** 新的在前，按 version 去重 */
function insertVersion(list: readonly ProjectNote[], note: ProjectNote): ProjectNote[] {
  if (list.some((n) => n.id === note.id)) return list as ProjectNote[];
  return [...list, note].sort((a, b) => b.version - a.version);
}

function setStatus(list: readonly ChatWindowStatus[], agent: string, f: (s: ChatWindowStatus) => ChatWindowStatus): ChatWindowStatus[] {
  return list.map((s) => (s.agent === agent ? f(s) : s));
}

export function applyNotesEvent(n: NotesState, event: ControlEvent): NotesState {
  switch (event.type) {
    case "projectNote.created": {
      const note = event.note;
      const sk = scopeKey(note.scope);
      const hk = noteKey(note.scope, note.agent);
      let next = n;
      const latest = n.latest[sk] ?? [];
      const cur = latest.find((x) => x.agent === note.agent);
      if (!cur || note.version > cur.version) {
        next = { ...next, latest: { ...next.latest, [sk]: cur ? latest.map((x) => (x.agent === note.agent ? note : x)) : [...latest, note] } };
      }
      const hist = n.history[hk] ?? [];
      const merged = insertVersion(hist, note);
      if (merged !== hist) next = { ...next, history: { ...next.history, [hk]: merged } };
      return next;
    }
    case "projectNote.rejected": {
      const r: RejectedNote = { scope: event.scope, agent: event.agent, reason: event.reason, source: event.source };
      return { ...n, rejected: [...n.rejected, r].slice(-REJECTED_KEEP) };
    }
    case "chat.window.draftUpdated": {
      const d = event.draft;
      const old = n.drafts[d.id];
      // 事件和命令返回可能先后到：updatedAt 更旧的不覆盖
      if (old && old.updatedAt > d.updatedAt) return n;
      const statuses = n.windows[d.conversationId];
      return {
        ...n,
        drafts: { ...n.drafts, [d.id]: d },
        windows: statuses
          ? {
              ...n.windows,
              [d.conversationId]: setStatus(statuses, d.agent, (s) => ({
                ...s,
                pendingDraft: d.state === "pending" ? d : s.pendingDraft?.id === d.id ? null : s.pendingDraft,
              })),
            }
          : n.windows,
      };
    }
    case "chat.window.created": {
      const w = event.window;
      const list = n.windowList[w.conversationId];
      const statuses = n.windows[w.conversationId];
      return {
        ...n,
        windowList: list && !list.some((x) => x.id === w.id) ? { ...n.windowList, [w.conversationId]: [...list, w] } : n.windowList,
        windows: statuses
          ? {
              ...n.windows,
              // 新窗口里还没有摘要：压缩次数从 0 开始（main 之后的 chat.windows.get 为准）
              [w.conversationId]: setStatus(statuses, w.agent, (s) =>
                s.index >= w.index ? s : { ...s, index: w.index, window: w, compactionsInWindow: 0, suggestSwitch: false, pendingDraft: s.pendingDraft?.id === w.draftId ? null : s.pendingDraft },
              ),
            }
          : n.windows,
      };
    }
    case "chat.run.updated":
      if (event.run.purpose !== "window_handoff") return n;
      return { ...n, handoffRuns: { ...n.handoffRuns, [event.run.id]: event.run } };
    case "github.updated":
      return { ...n, github: event.status };
    default:
      return n;
  }
}

// ---------------------------------------------------------------- 给界面的文字

export const REASON_LABEL: Record<ProjectNoteReason, string> = {
  reply: "回答里更新",
  window_handoff: "换窗口时的交接",
  human_edit: "你改的",
  revert: "回退",
};

export const REJECT_LABEL: Record<RoomNoteRejectReason, string> = {
  multiple: "一次写了两段以上",
  too_long: "超过 2 万字",
  unclosed: "没有写完（缺结尾）",
  nested_fence: "笔记里的代码块把笔记截断了",
};

/** 谁写的这一版：「C酱 在回答里更新」「你改的」「回退到第 2 版」 */
export function versionLabel(note: ProjectNote, name: (agent: string) => string, versionOf: (id: string) => number | undefined): string {
  if (note.reason === "revert") {
    const v = note.revertedFromId ? versionOf(note.revertedFromId) : undefined;
    return v ? `你回退到第 ${v} 版` : "你回退到旧版";
  }
  if (note.reason === "window_handoff") return note.updatedBy === "agent" ? `${name(note.agent)} 写的交接` : "交接（你改过）";
  return note.updatedBy === "agent" ? `${name(note.agent)} 在回答里更新` : "你改的";
}

/** 时间线上那一行（ADR-005 §3）：删了一半以上就提醒看一下 */
export const noteTimelineText = (note: ProjectNote, name: string) =>
  note.shrankALot ? `${name} 这次删了不少笔记，看看对不对` : `${name} 更新了笔记`;

// ---------------------------------------------------------------- 换窗口

/**
 * 换窗口弹出单现在是哪一步：
 * - writing：写交接的 Run 还在跑（或还没读到它的状态）
 * - failed ：Run 失败、超时或被取消，没写出内容
 *   （COMPLETED 但草稿内容还没到时仍算 writing：后端先推 Run 结束、再推草稿，后端保证要么写进草稿要么失败）
 * - ready  ：有内容了（Run 写的，或你自己写 / 改的），可以确认
 * - closed ：已经换了或取消了
 */
export type HandoffPhase = "writing" | "failed" | "ready" | "closed";

export function handoffPhase(draft: ChatWindowDraft, run: ChatRun | undefined): HandoffPhase {
  if (draft.state !== "pending") return "closed";
  if (draft.content !== null) return "ready";
  if (draft.runId === null) return "ready";
  if (run && run.id === draft.runId && run.state !== "COMPLETED" && RUN_TRANSITIONS[run.state].length === 0) return "failed";
  return "writing";
}

export const HANDOFF_FAILURE_LABEL: Partial<Record<NonNullable<ChatRun["failureReason"]>, string>> = {
  quota_exhausted: "额度用完了",
};

/** 失败时给人看的一句话 */
export function handoffFailureText(run: ChatRun | undefined): string {
  if (!run) return "没写成。";
  if (run.state === "CANCELLED") return "写交接被停了。";
  if (run.state === "TIMED_OUT") return "写交接超时了。";
  const why = run.failureReason ? HANDOFF_FAILURE_LABEL[run.failureReason] : undefined;
  return why ? `没写成：${why}。` : "没写成。";
}

/** 会话里谁该换窗口了（窗口里压缩满 3 次），按成员顺序 */
export const suggestedSwitches = (statuses: readonly ChatWindowStatus[] | undefined) =>
  (statuses ?? []).filter((s) => s.suggestSwitch);

/** 「这个窗口压缩 N 次」；没压缩过写「这个窗口还没压缩」 */
export const compactionText = (s: ChatWindowStatus) =>
  s.compactionsInWindow === 0 ? "这个窗口还没压缩" : `这个窗口压缩 ${s.compactionsInWindow} 次${s.compactionsInWindow >= CHAT_WINDOW_SUGGEST_COMPACTIONS ? "，建议换" : ""}`;

/** 时间线：在哪条消息后面画「换了新窗口」（边界那条消息 id → 那之后开始的窗口） */
export function windowLinesAfter(windows: readonly ChatWindow[] | undefined): Map<string, ChatWindow[]> {
  const out = new Map<string, ChatWindow[]>();
  for (const w of windows ?? []) out.set(w.startsAfterMessageId, [...(out.get(w.startsAfterMessageId) ?? []), w]);
  return out;
}

/** 时间线：哪一次回答（runId / turnId）存了哪一版笔记 */
export function notesBySource(history: Record<string, ProjectNote[]>, scope: NoteScope): Map<string, ProjectNote> {
  const prefix = `${scopeKey(scope)}|`;
  const out = new Map<string, ProjectNote>();
  for (const [k, list] of Object.entries(history)) {
    if (!k.startsWith(prefix)) continue;
    for (const n of list) {
      if (n.reason !== "reply" || !n.source) continue;
      out.set(n.source.kind === "turn" ? n.source.turnId : n.source.runId, n);
    }
  }
  return out;
}

/** 时间线：哪一次回答的笔记没存上 */
export function rejectedBySource(rejected: readonly RejectedNote[], scope: NoteScope): Map<string, RejectedNote> {
  const out = new Map<string, RejectedNote>();
  for (const r of rejected) {
    if (!sameScope(r.scope, scope)) continue;
    out.set(r.source.kind === "turn" ? r.source.turnId : r.source.runId, r);
  }
  return out;
}

/** 换窗口确认页的「新窗口从《……》之后开始」 */
export function boundaryText(messageId: string, messages: readonly ChatMessage[], preview: (m: ChatMessage) => string): string {
  const m = messages.find((x) => x.id === messageId);
  if (!m) return "你点「换窗口」时的最后一条消息";
  const t = preview(m).replace(/\s+/g, " ").trim();
  return `《${t.length > 24 ? `${t.slice(0, 24)}…` : t || "（空）"}》`;
}

// ---------------------------------------------------------------- 改了什么

export interface DiffLine {
  kind: "same" | "add" | "del";
  text: string;
}

/** 太长时不逐行比（LCS 是平方级），整份当成删了再加 */
const DIFF_MAX_LINES = 1500;

/**
 * 按行比较两版笔记（最长公共子序列）。只用来给人看「改了什么」，不参与任何判断
 */
export function noteDiff(before: string, after: string): DiffLine[] {
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");
  if (a.length > DIFF_MAX_LINES || b.length > DIFF_MAX_LINES) {
    return [...a.map((text) => ({ kind: "del" as const, text })), ...b.map((text) => ({ kind: "add" as const, text }))];
  }
  const n = a.length;
  const m = b.length;
  // lcs[i][j] = a[i..] 和 b[j..] 的最长公共子序列长度
  const lcs: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ kind: "del", text: a[i++]! });
    } else {
      out.push({ kind: "add", text: b[j++]! });
    }
  }
  while (i < n) out.push({ kind: "del", text: a[i++]! });
  while (j < m) out.push({ kind: "add", text: b[j++]! });
  return out;
}

/** 「加了 3 行、删了 5 行」；没变写「没有改动」 */
export function diffSummary(lines: readonly DiffLine[]): string {
  const add = lines.filter((l) => l.kind === "add").length;
  const del = lines.filter((l) => l.kind === "del").length;
  if (!add && !del) return "没有改动";
  return [add && `加了 ${add} 行`, del && `删了 ${del} 行`].filter(Boolean).join("、");
}

// ---------------------------------------------------------------- GitHub

export const GITHUB_ERROR_LABEL: Record<NonNullable<GithubSyncStatus["lastError"]>, string> = {
  public_repo: "这是公开仓库，笔记不推（只推私有仓库）。",
  no_token: "还没有填 Token。",
  unauthorized: "Token 不对或没有这个仓库的写权限。",
  not_found: "找不到这个仓库（名字不对，或 Token 看不到它）。",
  network: "连不上 GitHub，排着队，恢复后自动推。",
  other: "推送出错了。",
};

/**
 * 「保存」为什么按不了（C-49 / B-15）。能保存返回 null。
 * 以前仓库填对了、Token 空着时按钮灰着，不说为什么。
 */
export function githubSaveBlocker(i: { repo: string; repoOk: boolean; token: string; tokenSet: boolean }): string | null {
  if (i.repo.trim() === "") return i.token.trim() === "" ? null : "还要填仓库（用户名/仓库名）。";
  // 仓库或 Token 格式不对：输入框下面已经有提示，这里不重复
  if (!i.repoOk || i.token.trim() !== "") return null;
  return i.tokenSet ? null : "还要填 Token 才能保存。";
}

/** 设置页那一行状态 */
export function githubStatusText(s: GithubSyncStatus): string {
  if (s.repo === null) return "没有设置仓库，笔记只存在这台电脑上。";
  if (s.lastError) return GITHUB_ERROR_LABEL[s.lastError];
  if (s.private === null) return "正在检查仓库是不是私有的…";
  if (s.pending > 0) return `${s.pending} 版笔记还没推上去。`;
  return "都推上去了。";
}
