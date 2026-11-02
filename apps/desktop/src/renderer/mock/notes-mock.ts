import {
  ChatWindowDraft as ChatWindowDraftSchema,
  ProjectNote as ProjectNoteSchema,
  RUN_TRANSITIONS,
  canTransition,
  extractRoomNote,
  noteShrankALot,
  type AgentEvent,
  type AgentProfile,
  type ChatMessage,
  type ChatRun,
  type ChatWindow,
  type ChatWindowDraft,
  type ChatWindowStatus,
  type CommandRequest,
  type ControlEvent,
  type Conversation,
  type GithubSyncStatus,
  type NoteScope,
  type Project,
  type ProjectNote,
  type ProjectNoteReason,
  type ProjectNoteSource,
  type RunState,
  CHAT_WINDOW_SUGGEST_COMPACTIONS,
} from "@room/schemas";
import { MockError, id, now, sha256Hex } from "./util";

/**
 * 项目笔记、换窗口、GitHub 同步的内存实现（C-47 开发用，契约 C-46 / ADR-005）。规则照 control-api 的注释：
 * - 笔记版本不可变，version 连续、parentId 指上一版；你改要带 expectedParentId，不是最新 → invalid_state
 * - 换窗口：prepare 时定边界；同一（会话, 秘书）最多一份 pending；写交接的 Run 没有回答位，恰好一个终止事件
 * - confirm 带 expectedContentHash；取消不存笔记、不写窗口，Run 照常保留
 * - GitHub：只推私有仓库；Token 只在这里，查询不返回
 *
 * 和其他 mock 一样只是演示和 UI 开发用，不是 D-46 的参考实现。
 */

export interface NotesMockOptions {
  /** 写交接时这几位失败一次（额度用完），演示「重写 / 我自己写」 */
  handoffFailOnce?: string[];
}

export interface NotesMockContext {
  emit(e: ControlEvent): void;
  pushEvent(runId: string, e: Record<string, unknown> & { type: AgentEvent["type"] }): void;
  agents(): AgentProfile[];
  projects(): Project[];
  timers: Map<string, ReturnType<typeof setTimeout>[]>;
  tickMs: number;
  chat: {
    ready: Promise<void>;
    conversations(): Conversation[];
    /** 会话里的消息，按时间正序 */
    messagesOf(conversationId: string): ChatMessage[];
    /** 写交接的 Run 放进聊天的 Run 表（chat.runs.get 查得到） */
    addRun(run: ChatRun): void;
  };
}

const clone = <T>(x: T): T => structuredClone(x);
const pairKey = (cid: string, agent: string) => `${cid}|${agent}`;
const sameScope = (a: NoteScope, b: NoteScope) =>
  a.kind === "topic" ? b.kind === "topic" && a.projectId === b.projectId : b.kind === "conversation" && a.conversationId === b.conversationId;

export function createNotesMock(ctx: NotesMockContext, options: NotesMockOptions = {}) {
  const { emit } = ctx;
  const notes: ProjectNote[] = [];
  const windows: ChatWindow[] = [];
  const drafts: ChatWindowDraft[] = [];
  const runs: ChatRun[] = [];
  /** 窗口里压缩次数（真实的由 main 按摘要数，mock 直接记） */
  const compactions = new Map<string, number>();
  const handoffFail = new Set(options.handoffFailOnce ?? []);

  // ------------------------------------------------------------ 笔记

  const chain = (scope: NoteScope, agent: string) =>
    notes.filter((n) => n.agent === agent && sameScope(n.scope, scope)).sort((a, b) => b.version - a.version);
  const latest = (scope: NoteScope, agent: string): ProjectNote | undefined => chain(scope, agent)[0];

  const checkMember = (scope: NoteScope, agent: string) => {
    if (!ctx.agents().some((a) => a.id === agent)) throw new MockError("not_found", `秘书 ${agent} 不存在`);
    if (scope.kind === "topic") {
      if (!ctx.projects().some((p) => p.id === scope.projectId)) throw new MockError("not_found", `议题 ${scope.projectId} 不存在`);
      return;
    }
    const conv = ctx.chat.conversations().find((c) => c.id === scope.conversationId);
    if (!conv) throw new MockError("not_found", `会话 ${scope.conversationId} 不存在`);
    if (!conv.members.includes(agent)) throw new MockError("not_found", `${agent} 不是这个会话的成员`);
  };

  async function save(
    scope: NoteScope,
    agent: string,
    content: string,
    by: "agent" | "human",
    reason: ProjectNoteReason,
    source: ProjectNoteSource | null,
    revertedFromId: string | null = null,
    at = now(),
  ): Promise<ProjectNote> {
    // 先算 hash 再取上一版：取上一版和存进去之间不能有 await（真实后端是一个事务）
    const contentHash = await sha256Hex(content);
    const prev = latest(scope, agent);
    const note = ProjectNoteSchema.parse({
      id: id("note"), scope, agent, version: (prev?.version ?? 0) + 1, parentId: prev?.id ?? null, content, contentHash,
      updatedBy: by, reason, source, revertedFromId, shrankALot: prev ? noteShrankALot(prev.content, content) : false, createdAt: at,
    });
    notes.push(note);
    emit({ type: "projectNote.created", note: clone(note) });
    github.enqueue();
    return note;
  }

  // ------------------------------------------------------------ 换窗口

  const runDone = (r: ChatRun) => RUN_TRANSITIONS[r.state].length === 0;
  const setRun = (r: ChatRun, to: RunState, patch: Partial<ChatRun> = {}) => {
    if (!canTransition(RUN_TRANSITIONS, r.state, to)) throw new MockError("invalid_state", `Run 不能从 ${r.state} 变为 ${to}`);
    Object.assign(r, patch, { state: to, substate: to === "RUNNING" ? "active" : null });
    if (runDone(r)) r.finishedAt = now();
    emit({ type: "chat.run.updated", run: clone(r) });
  };
  const cancelRun = (runId: string | null, reason: string) => {
    const r = runId ? runs.find((x) => x.id === runId) : undefined;
    if (!r || runDone(r)) return;
    ctx.timers.get(r.id)?.forEach(clearTimeout);
    ctx.pushEvent(r.id, { type: "cancelled", reason });
    setRun(r, "CANCELLED");
  };

  const draft = (draftId: string) => {
    const d = drafts.find((x) => x.id === draftId);
    if (!d) throw new MockError("not_found", `草稿 ${draftId} 不存在`);
    return d;
  };
  const touchDraft = async (d: ChatWindowDraft, patch: Partial<ChatWindowDraft>) => {
    const content = patch.content !== undefined ? patch.content : d.content;
    const contentHash = content === null ? null : await sha256Hex(content);
    Object.assign(d, patch, { contentHash, updatedAt: now() });
    ChatWindowDraftSchema.parse(d);
    emit({ type: "chat.window.draftUpdated", draft: clone(d) });
  };

  const currentWindow = (cid: string, agent: string) =>
    windows.filter((w) => w.conversationId === cid && w.agent === agent).sort((a, b) => b.index - a.index)[0];

  /** 他当前窗口里的消息（换过窗口的只要边界之后的） */
  const windowMessages = (cid: string, agent: string) => {
    const all = ctx.chat.messagesOf(cid);
    const w = currentWindow(cid, agent);
    if (!w) return all;
    const at = all.findIndex((m) => m.id === w.startsAfterMessageId);
    return at === -1 ? all : all.slice(at + 1);
  };

  /** mock 的交接笔记：旧笔记里的约定带上，再写做到哪了、还没回答的事 */
  function handoffText(cid: string, agent: string): string {
    const msgs = windowMessages(cid, agent);
    const old = latest({ kind: "conversation", conversationId: cid }, agent)?.content ?? "";
    const keep = old
      .split("\n")
      .filter((l) => l.startsWith("- "))
      .slice(0, 6);
    const lastUser = [...msgs].reverse().find((m) => m.sender === "user");
    const said = (m: ChatMessage | undefined) =>
      m?.sender === "user" && m.content.kind === "text" ? m.content.text.slice(0, 30) : m?.sender === "user" && m.content.kind === "voice" ? m.content.transcript.text.slice(0, 30) : "（表情）";
    return [
      "## 做到哪了",
      `- 这个窗口里一共 ${msgs.length} 条消息；最近你问的是「${said(lastUser)}」`,
      "",
      "## 要记住的约定",
      ...(keep.length ? keep : ["- （旧笔记里没有约定）"]),
      "",
      "## 还没回答的事",
      "- 没有",
      "",
      "（mock 写的交接笔记）",
    ].join("\n");
  }

  async function startHandoffRun(d: ChatWindowDraft): Promise<ChatRun> {
    const snapshotHash = await sha256Hex(`handoff:${d.id}:${Date.now()}`);
    const run: ChatRun = {
      id: id("run"), kind: "chat", purpose: "window_handoff", conversationId: d.conversationId, slotId: null, agent: d.agent,
      snapshotId: id("snap"), snapshotHash, finalPromptHash: null, memoryManifest: null, model: null, adapterId: "mock-chat",
      state: "QUEUED", substate: null, failureReason: null, createdAt: now(), startedAt: null, finishedAt: null,
    };
    runs.push(run);
    ctx.chat.addRun(run);
    emit({ type: "chat.run.updated", run: clone(run) });
    const fail = handoffFail.delete(d.agent);
    const steps: (() => void | Promise<void>)[] = [
      () => setRun(run, "STARTING"),
      () => setRun(run, "RUNNING", { startedAt: now() }),
      () => ctx.pushEvent(run.id, { type: "message_delta", text: "## 做到哪了\n" }),
    ];
    if (fail) {
      steps.push(() => {
        ctx.pushEvent(run.id, { type: "error", reason: "quota_exhausted", message: "额度用尽" });
        setRun(run, "FAILED", { failureReason: "quota_exhausted" });
      });
    } else {
      steps.push(
        () => ctx.pushEvent(run.id, { type: "message_delta", text: "…" }),
        async () => {
          const text = handoffText(d.conversationId, d.agent);
          ctx.pushEvent(run.id, { type: "message_complete", text });
          ctx.pushEvent(run.id, { type: "completed" });
          setRun(run, "COMPLETED");
          // 只有草稿还在等、而且还是这个 Run 的时候才写进去（你已经自己写了 / 重写了 / 取消了就不写）
          if (d.state === "pending" && d.runId === run.id && d.content === null) await touchDraft(d, { content: text, contentBy: "agent" });
        },
      );
    }
    const handles = steps.map((step, i) =>
      setTimeout(() => {
        if (!runDone(run)) void step();
      }, ctx.tickMs * 3 * (i + 1)),
    );
    ctx.timers.set(run.id, handles);
    return run;
  }

  // ------------------------------------------------------------ GitHub

  const github = (() => {
    let status: GithubSyncStatus = { repo: null, tokenSet: false, private: null, pending: 0, lastPushedAt: null, lastError: null, lastErrorMessage: null };
    // Token 只在这里，github.get 永远不返回
    let token: string | null = null;
    const set = (patch: Partial<GithubSyncStatus>) => {
      status = { ...status, ...patch };
      emit({ type: "github.updated", status: clone(status) });
    };
    const error = (lastError: NonNullable<GithubSyncStatus["lastError"]>, lastErrorMessage: string) => set({ lastError, lastErrorMessage });
    const push = () =>
      setTimeout(() => {
        if (!status.repo || status.private !== true || status.pending === 0) return;
        // mock 规则：仓库名带 offline = 连不上，排着队
        if (status.repo.includes("offline")) return error("network", "连不上 api.github.com（ECONNRESET）");
        set({ pending: 0, lastPushedAt: now(), lastError: null, lastErrorMessage: null });
      }, ctx.tickMs * 4);
    /** 后台查仓库：没 Token / 公开 / 私有（仓库名带 public = 公开仓库） */
    const check = () =>
      setTimeout(() => {
        if (!status.repo) return;
        if (!token) return error("no_token", "还没有填 Token");
        if (token.startsWith("bad")) return error("unauthorized", "GitHub 返回 401");
        if (status.repo.includes("public")) return set({ private: false, lastError: "public_repo", lastErrorMessage: "这个仓库是公开的" });
        set({ private: true, lastError: null, lastErrorMessage: null });
        push();
      }, ctx.tickMs * 3);
    return {
      get: () => clone(status),
      update(repo: string | null, newToken?: string) {
        if (newToken !== undefined) token = newToken;
        status = repo === null
          ? { ...status, repo: null, private: null, pending: 0, lastError: null, lastErrorMessage: null, tokenSet: token !== null }
          : { ...status, repo, private: null, lastError: null, lastErrorMessage: null, tokenSet: token !== null };
        if (repo !== null) check();
        return clone(status);
      },
      pushNow() {
        if (!status.repo) throw new MockError("invalid_state", "还没有设置仓库");
        if (status.lastError === "network") set({ lastError: null, lastErrorMessage: null });
        if (status.private === null || status.lastError !== null) check();
        else push();
        return clone(status);
      },
      /** 存了一版笔记：有仓库就排队，私有的过一会儿推上去 */
      enqueue() {
        if (!status.repo) return;
        set({ pending: status.pending + 1 });
        if (status.private === true && status.lastError === null) push();
      },
    };
  })();

  // ------------------------------------------------------------ commands

  const commands = {
    async "projectNote.edit"(req: CommandRequest<"projectNote.edit">) {
      await ready;
      checkMember(req.scope, req.agent);
      const cur = latest(req.scope, req.agent);
      if ((cur?.id ?? null) !== req.expectedParentId) throw new MockError("invalid_state", "笔记已经有了更新的版本");
      if (cur && cur.content === req.content) return clone(cur);
      return clone(await save(req.scope, req.agent, req.content, "human", "human_edit", null));
    },

    async "projectNote.revert"(req: CommandRequest<"projectNote.revert">) {
      const old = notes.find((n) => n.id === req.noteId);
      if (!old) throw new MockError("not_found", `笔记 ${req.noteId} 不存在`);
      if (latest(old.scope, old.agent)?.id === old.id) throw new MockError("invalid_state", "这已经是最新版");
      return clone(await save(old.scope, old.agent, old.content, "human", "revert", null, old.id));
    },

    async "chat.window.prepare"(req: CommandRequest<"chat.window.prepare">) {
      await ready;
      checkMember({ kind: "conversation", conversationId: req.conversationId }, req.agent);
      const pending = drafts.find((d) => d.conversationId === req.conversationId && d.agent === req.agent && d.state === "pending");
      if (pending) return clone(pending);
      const msgs = ctx.chat.messagesOf(req.conversationId);
      const last = msgs[msgs.length - 1];
      if (!last) throw new MockError("invalid_state", "会话里还没有消息");
      const a = ctx.agents().find((x) => x.id === req.agent)!;
      if (!req.writeYourself && (a.pausedByUser || a.nodeId === null || a.chatProfileId === null)) {
        throw new MockError("agent_unavailable", a.pausedByUser ? "已暂停" : "没有配置节点");
      }
      const at = now();
      const d: ChatWindowDraft = {
        id: id("cwd"), conversationId: req.conversationId, agent: req.agent, startsAfterMessageId: last.id, runId: null,
        content: req.writeYourself ? "" : null, contentHash: req.writeYourself ? await sha256Hex("") : null,
        contentBy: req.writeYourself ? "human" : null, state: "pending", windowId: null, createdAt: at, updatedAt: at,
      };
      drafts.push(d);
      if (!req.writeYourself) d.runId = (await startHandoffRun(d)).id;
      emit({ type: "chat.window.draftUpdated", draft: clone(d) });
      return clone(d);
    },

    async "chat.window.editDraft"(req: CommandRequest<"chat.window.editDraft">) {
      const d = draft(req.draftId);
      if (d.state !== "pending") throw new MockError("invalid_state", "草稿已经换了或取消了");
      // 还在写的时候你动手了 = 不等了，我自己写
      cancelRun(d.runId, "你自己写交接");
      await touchDraft(d, { content: req.content, contentBy: "human" });
      return clone(d);
    },

    async "chat.window.redo"(req: CommandRequest<"chat.window.redo">) {
      const d = draft(req.draftId);
      if (d.state !== "pending") throw new MockError("invalid_state", "草稿已经换了或取消了");
      const a = ctx.agents().find((x) => x.id === d.agent);
      if (a?.pausedByUser || a?.nodeId === null) throw new MockError("agent_unavailable", "这位现在不能写");
      cancelRun(d.runId, "重写交接");
      const run = await startHandoffRun(d);
      await touchDraft(d, { runId: run.id, content: null, contentBy: null });
      return clone(d);
    },

    async "chat.window.confirm"(req: CommandRequest<"chat.window.confirm">) {
      const d = draft(req.draftId);
      if (d.state !== "pending") throw new MockError("invalid_state", "草稿已经换了或取消了");
      if (d.content === null || d.contentHash === null) throw new MockError("invalid_state", "交接笔记还没写好");
      if (d.contentHash !== req.expectedContentHash) throw new MockError("stale_snapshot", "交接笔记在你看过之后又变了");
      // 以下在真实后端是一个事务：存笔记 → 写窗口 → 草稿 confirmed
      const scope: NoteScope = { kind: "conversation", conversationId: d.conversationId };
      const note = await save(scope, d.agent, d.content, d.contentBy ?? "human", "window_handoff", d.runId ? { kind: "chat_run", runId: d.runId } : null);
      const prev = currentWindow(d.conversationId, d.agent);
      const window: ChatWindow = {
        id: id("cwin"), conversationId: d.conversationId, agent: d.agent, index: (prev?.index ?? 1) + 1,
        startsAfterMessageId: d.startsAfterMessageId, handoffNoteId: note.id, draftId: d.id, createdAt: now(),
      };
      windows.push(window);
      compactions.set(pairKey(d.conversationId, d.agent), 0);
      await touchDraft(d, { state: "confirmed", windowId: window.id });
      emit({ type: "chat.window.created", window: clone(window) });
      return clone({ window, note, draft: d });
    },

    async "chat.window.cancel"(req: CommandRequest<"chat.window.cancel">) {
      const d = draft(req.draftId);
      if (d.state !== "pending") throw new MockError("invalid_state", "草稿已经换了或取消了");
      cancelRun(d.runId, "取消换窗口");
      await touchDraft(d, { state: "cancelled" });
      return clone(d);
    },

    async "github.update"(req: CommandRequest<"github.update">) {
      return github.update(req.repo, req.token);
    },

    async "github.pushNow"() {
      return github.pushNow();
    },
  };

  // ------------------------------------------------------------ queries

  const queries = {
    async "projectNotes.list"(req: { scope: NoteScope }) {
      await ready;
      const agents = [...new Set(notes.filter((n) => sameScope(n.scope, req.scope)).map((n) => n.agent))];
      return clone(agents.map((a) => latest(req.scope, a)!));
    },
    async "projectNotes.history"(req: { scope: NoteScope; agent: string }) {
      await ready;
      return clone(chain(req.scope, req.agent).slice(0, 200));
    },
    async "chat.windows.get"(req: { conversationId: string }) {
      await ready;
      const conv = ctx.chat.conversations().find((c) => c.id === req.conversationId);
      if (!conv) throw new MockError("not_found", `会话 ${req.conversationId} 不存在`);
      return clone(
        conv.members.map((agent): ChatWindowStatus => {
          const w = currentWindow(conv.id, agent) ?? null;
          const n = compactions.get(pairKey(conv.id, agent)) ?? 0;
          return {
            agent, index: w?.index ?? 1, window: w, compactionsInWindow: n, suggestSwitch: n >= CHAT_WINDOW_SUGGEST_COMPACTIONS,
            pendingDraft: drafts.find((d) => d.conversationId === conv.id && d.agent === agent && d.state === "pending") ?? null,
          };
        }),
      );
    },
    async "chat.windows.list"(req: { conversationId: string }) {
      await ready;
      return clone(windows.filter((w) => w.conversationId === req.conversationId).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1)));
    },
    async "github.get"() {
      return github.get();
    },
  };

  // ------------------------------------------------------------ 聊天回答里的 room-note（D-46a 在 main 做，这里演示）

  /**
   * 秘书的回答出来以后：切出 room-note，合格的存成新版，不合格的提示「笔记没存上」。返回去掉笔记之后的正文。
   * 存笔记在回答之后（真实后端是同一个事务）
   */
  function fromReply(conversationId: string, agent: string, runId: string, text: string): string {
    const r = extractRoomNote(text);
    if (r.kind === "none") return text;
    const scope: NoteScope = { kind: "conversation", conversationId };
    const source: ProjectNoteSource = { kind: "chat_run", runId };
    if (r.kind === "ok") {
      setTimeout(() => void save(scope, agent, r.content, "agent", "reply", source), 0);
    } else {
      setTimeout(() => emit({ type: "projectNote.rejected", scope, agent, reason: r.reason, source }), 0);
    }
    return r.text;
  }

  /** 演示数据（查询和命令都先等它）：群聊里 C酱 两版、汐 一版、C酱 已经压缩 3 次；单聊里 C酱 一版 */
  async function seed() {
    await ctx.chat.ready;
    const convs = ctx.chat.conversations();
    for (const conv of convs) {
      const scope: NoteScope = { kind: "conversation", conversationId: conv.id };
      const replies = ctx.chat.messagesOf(conv.id).filter((m): m is Extract<ChatMessage, { sender: "agent" }> => m.sender === "agent");
      const runOf = (agent: string, nth: number) => replies.filter((m) => m.agent === agent)[nth];
      if (conv.kind === "group") {
        const c1 = runOf("claude", 0);
        const c2 = runOf("claude", 1);
        const d1 = runOf("deepseek", 0);
        if (c1) {
          await save(scope, "claude", "## 我在这里负责什么\n- 前端和契约\n\n## 约定\n- 聊天界面先做，控制台后做", "agent", "reply", { kind: "chat_run", runId: c1.runId }, null, c1.createdAt);
        }
        if (c2) {
          await save(
            scope, "claude",
            "## 我在这里负责什么\n- 前端和契约\n\n## 约定\n- 聊天界面先做，控制台后做\n- 图表用 room-chart，不画图片\n\n## 做到哪了\n- 工作量对比图已经发了",
            "agent", "reply", { kind: "chat_run", runId: c2.runId }, null, c2.createdAt,
          );
        }
        if (d1) {
          await save(scope, "deepseek", "## 负责\n- 聊天后端（D-31）\n\n## 还差\n- 历史摘要\n- 文件和语音（D-34）", "agent", "reply", { kind: "chat_run", runId: d1.runId }, null, d1.createdAt);
        }
        compactions.set(pairKey(conv.id, "claude"), 3);
        compactions.set(pairKey(conv.id, "deepseek"), 1);
      } else {
        const agent = conv.members[0]!;
        const r = runOf(agent, 0);
        if (r) await save(scope, agent, "## 约定\n- #99 的评审意见每天晚上汇总一次", "agent", "reply", { kind: "chat_run", runId: r.runId }, null, r.createdAt);
        compactions.set(pairKey(conv.id, agent), 2);
      }
    }
  }

  /** 讨论室演示：给一个议题放两份笔记（讨论回答里的 room-note 由 D-46a 做，mock 的讨论回答不带） */
  async function seedTopic(projectId: string) {
    const scope: NoteScope = { kind: "topic", projectId };
    const turn = { kind: "turn" as const, turnId: id("turn") };
    await save(scope, "deepseek", "## 我在这个议题负责\n- 写入路径和单写者队列\n\n## 约定\n- 事务用 BEGIN IMMEDIATE\n- delta 每 200ms 批量落库", "agent", "reply", turn);
    await save(scope, "claude", "## 我在这个议题负责\n- 评审和汇总\n\n## 记住\n- 江浩要先看风险再看方案", "agent", "reply", { kind: "turn", turnId: id("turn") });
  }

  const ready = seed();

  return {
    commands,
    queries,
    fromReply,
    seedTopic,
    /** 回答时用：他现在的笔记（mock 的秘书在笔记后面接着记） */
    current: (conversationId: string, agent: string) => latest({ kind: "conversation", conversationId }, agent)?.content ?? "",
    ready,
    reset() {
      notes.length = 0;
      windows.length = 0;
      drafts.length = 0;
      runs.length = 0;
      compactions.clear();
    },
  };
}
