import type { ControlEvent, GithubSyncStatus, NoteScope, ProjectNote } from "@room/schemas";
import { ControlFailure, describeFailure, type RoomClient } from "./client";
import type { AppState } from "./state";
import type { Store } from "./store";
import { applyNotesEvent, noteKey, scopeKey, type NoteTab, type NotesState } from "./notes";

/**
 * 项目笔记、换窗口、GitHub 的操作（C-47）。规则同别的 actions：失败写进 notice，不向上抛。
 * 后端还不认识这些命令（D-46 没合，返回 validation_failed）时不弹错，把对应的 available 置为 false，界面藏掉入口。
 * internal 是真出错（锁库、事务冲突），照常报错，入口留着可以再试。
 */
export function createNotesActions(store: Store<AppState>, client: RoomClient, fail: (err: unknown) => void) {
  const setNotes = (f: (n: NotesState) => NotesState) => store.set((s) => ({ ...s, notes: f(s.notes) }));
  const notes = () => store.get().notes;
  const notSupported = (err: unknown) =>
    err instanceof ControlFailure && err.code === "validation_failed";
  const apply = (e: ControlEvent) => setNotes((n) => applyNotesEvent(n, e));

  async function loadScope(scope: NoteScope) {
    if (!notes().available) return;
    try {
      const list = await client.query({ type: "projectNotes.list", scope });
      setNotes((n) => {
        let next = { ...n, latest: { ...n.latest, [scopeKey(scope)]: n.latest[scopeKey(scope)] ?? [] } };
        // 查询与事件按同一版本规则合并，旧查询不能把已经显示的新版改回去。
        for (const note of list) next = applyNotesEvent(next, { type: "projectNote.created", note });
        return next;
      });
      // 时间线上「更新了笔记」那一行要知道每一版是哪次回答写的：有笔记的人把历史也读下来
      await Promise.all((notes().latest[scopeKey(scope)] ?? []).map((x) => loadHistory(scope, x.agent)));
    } catch (err) {
      if (notSupported(err)) setNotes((n) => ({ ...n, available: false }));
      else fail(err);
    }
  }

  async function loadHistory(scope: NoteScope, agent: string) {
    try {
      const list = await client.query({ type: "projectNotes.history", scope, agent });
      setNotes((n) => {
        // 查询期间推来的新版不能被旧结果盖掉
        const merged = [...list];
        for (const x of n.history[noteKey(scope, agent)] ?? []) if (!merged.some((y) => y.id === x.id)) merged.push(x);
        merged.sort((a, b) => b.version - a.version);
        return { ...n, history: { ...n.history, [noteKey(scope, agent)]: merged } };
      });
    } catch (err) {
      if (!notSupported(err)) fail(err);
    }
  }

  async function loadWindows(conversationId: string) {
    if (!notes().windowsAvailable) return;
    try {
      const [statuses, windows] = await Promise.all([
        client.query({ type: "chat.windows.get", conversationId }),
        client.query({ type: "chat.windows.list", conversationId }),
      ]);
      setNotes((n) => {
        const drafts = { ...n.drafts };
        for (const st of statuses) if (st.pendingDraft) drafts[st.pendingDraft.id] = st.pendingDraft;
        return { ...n, windows: { ...n.windows, [conversationId]: statuses }, windowList: { ...n.windowList, [conversationId]: windows }, drafts };
      });
      // 有草稿的：读一下写交接的 Run，好知道是还在写还是失败了
      for (const st of statuses) if (st.pendingDraft?.runId) void loadRun(st.pendingDraft.runId);
    } catch (err) {
      if (notSupported(err)) setNotes((n) => ({ ...n, windowsAvailable: false }));
      else fail(err);
    }
  }

  async function loadRun(runId: string) {
    try {
      const run = await client.query({ type: "chat.runs.get", runId });
      apply({ type: "chat.run.updated", run });
    } catch {
      // 读不到就当还在写，事件到了会更新
    }
  }

  /** 并发改：别人（秘书）刚写了新版，重新读一下再让你改 */
  async function staleReload(err: unknown, scope: NoteScope, agent: string) {
    if (err instanceof ControlFailure && err.code === "invalid_state") {
      await Promise.all([loadScope(scope), loadHistory(scope, agent)]);
      store.set((s) => ({ ...s, notice: { kind: "error", message: `笔记刚刚有了新的一版，已经重新读了，请在最新版上再改。（${err.message}）` } }));
      return;
    }
    fail(err);
  }

  return {
    loadScope,
    loadHistory,
    loadWindows,
    loadRun,

    /** 打开一个会话时：笔记、窗口状态 */
    async loadConversation(conversationId: string) {
      await Promise.all([loadScope({ kind: "conversation", conversationId }), loadWindows(conversationId)]);
    },

    onEvent(e: ControlEvent) {
      if (e.type === "chat.window.created") void loadWindows(e.window.conversationId);
      if (e.type === "chat.summary.updated" && notes().windows[e.summary.conversationId] !== undefined) {
        void loadWindows(e.summary.conversationId);
      }
      if (e.type === "chat.window.draftUpdated" && e.draft.runId) void loadRun(e.draft.runId);
    },

    openNote(scope: NoteScope, agent: string, agents: string[], opts: { noteId?: string; tab?: NoteTab } = {}) {
      setNotes((n) => ({ ...n, sheet: { kind: "note", scope, agent, agents, ...opts } }));
      void loadHistory(scope, agent);
    },
    closeSheet: () => setNotes((n) => ({ ...n, sheet: null })),

    /** 你改笔记。expectedParentId = 你看到的那一版；不是最新 → 重新读、提示 */
    async editNote(scope: NoteScope, agent: string, content: string, expectedParentId: string | null): Promise<ProjectNote | undefined> {
      try {
        const note = await client.command({ type: "projectNote.edit", scope, agent, content, expectedParentId });
        apply({ type: "projectNote.created", note });
        return note;
      } catch (err) {
        await staleReload(err, scope, agent);
        return undefined;
      }
    },

    async revertNote(note: ProjectNote): Promise<ProjectNote | undefined> {
      try {
        const next = await client.command({ type: "projectNote.revert", noteId: note.id });
        apply({ type: "projectNote.created", note: next });
        return next;
      } catch (err) {
        await staleReload(err, note.scope, note.agent);
        return undefined;
      }
    },

    /**
     * 点「换窗口」：建草稿（已有 pending 的就是它），打开弹出单。
     * 秘书现在不能答（暂停、节点不通）时 main 不建草稿，提示里给「我自己写」的路
     */
    async prepareWindow(conversationId: string, agent: string, writeYourself = false) {
      const existing = notes().windows[conversationId]?.find((s) => s.agent === agent)?.pendingDraft;
      if (existing) {
        setNotes((n) => ({ ...n, sheet: { kind: "handoff", conversationId, agent, draftId: existing.id } }));
        if (existing.runId) void loadRun(existing.runId);
        return;
      }
      try {
        const draft = await client.command({ type: "chat.window.prepare", conversationId, agent, ...(writeYourself ? { writeYourself } : {}) });
        apply({ type: "chat.window.draftUpdated", draft });
        setNotes((n) => ({ ...n, sheet: { kind: "handoff", conversationId, agent, draftId: draft.id } }));
        if (draft.runId) void loadRun(draft.runId);
      } catch (err) {
        if (err instanceof ControlFailure && err.code === "agent_unavailable") {
          store.set((s) => ({
            ...s,
            notice: { kind: "error", message: `这位现在不能写交接（${err.message}）。可以在「换窗口」旁边选「我自己写」。` },
          }));
          return;
        }
        fail(err);
      }
    },

    async editDraft(draftId: string, content: string) {
      try {
        const draft = await client.command({ type: "chat.window.editDraft", draftId, content });
        apply({ type: "chat.window.draftUpdated", draft });
        return draft;
      } catch (err) {
        fail(err);
        return undefined;
      }
    },

    async redoDraft(draftId: string) {
      try {
        const draft = await client.command({ type: "chat.window.redo", draftId });
        apply({ type: "chat.window.draftUpdated", draft });
        if (draft.runId) void loadRun(draft.runId);
      } catch (err) {
        fail(err);
      }
    },

    /**
     * 点「换」。弹出单里还有没保存的修改时，先存进草稿（拿到新的 hash）再确认，
     * 这样确认的就是你眼前这份
     */
    async confirmWindow(draftId: string, edited: string | null): Promise<boolean> {
      let draft = notes().drafts[draftId];
      if (!draft) return false;
      if (edited !== null && edited !== draft.content) {
        try {
          draft = await client.command({ type: "chat.window.editDraft", draftId, content: edited });
          apply({ type: "chat.window.draftUpdated", draft });
        } catch (err) {
          fail(err);
          return false;
        }
      }
      if (draft.contentHash === null) return false;
      try {
        const { window, note, draft: done } = await client.command({ type: "chat.window.confirm", draftId, expectedContentHash: draft.contentHash });
        apply({ type: "chat.window.draftUpdated", draft: done });
        apply({ type: "projectNote.created", note });
        apply({ type: "chat.window.created", window });
        setNotes((n) => ({ ...n, sheet: null }));
        void loadWindows(window.conversationId);
        return true;
      } catch (err) {
        if (err instanceof ControlFailure && err.code === "stale_snapshot") {
          store.set((s) => ({ ...s, notice: { kind: "error", message: `交接笔记刚刚又变了，请看一眼新的再点「换」。（${err.message}）` } }));
          return false;
        }
        fail(err);
        return false;
      }
    },

    async cancelWindow(draftId: string) {
      try {
        const draft = await client.command({ type: "chat.window.cancel", draftId });
        apply({ type: "chat.window.draftUpdated", draft });
        setNotes((n) => ({ ...n, sheet: null }));
      } catch (err) {
        fail(err);
      }
    },

    // ---------------------------------------------------------- GitHub

    async loadGithub() {
      try {
        const github = await client.query({ type: "github.get" });
        setNotes((n) => ({ ...n, github, githubAvailable: true }));
      } catch (err) {
        if (notSupported(err)) setNotes((n) => ({ ...n, githubAvailable: false }));
        else fail(err);
      }
    },

    /** 保存仓库（null = 关掉同步）。token 留空表示保留原来的。返回错误说明，成功返回 null */
    async saveGithub(repo: string | null, token?: string): Promise<GithubSyncStatus | string> {
      try {
        const github = await client.command({ type: "github.update", repo, ...(token ? { token } : {}) });
        setNotes((n) => ({ ...n, github }));
        return github;
      } catch (err) {
        return describeFailure(err);
      }
    },

    async pushGithubNow() {
      try {
        const github = await client.command({ type: "github.pushNow" });
        setNotes((n) => ({ ...n, github }));
      } catch (err) {
        fail(err);
      }
    },
  };
}

export type NotesActions = ReturnType<typeof createNotesActions>;
