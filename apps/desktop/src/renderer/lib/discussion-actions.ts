import {
  toRunModel,
  type ApprovalBatch,
  type CommandRequest,
  type ControlEvent,
  type LocalNodeId,
  type NodeInfo,
  type NodeTestResult,
  type Round,
} from "@room/schemas";
import { ControlFailure, type RoomClient } from "./client";
import { appendEvents, applyEvent, type AppState } from "./state";
import { initialDiscussion, planForNextRound, rejectedDraftRound, sendableRecipients, type DiscussionState } from "./discussion";
import { modelsFor } from "./models";
import { boardSeq, isOpenRound, withDigest, type TopicDigest } from "./topic-board";
import type { Store } from "./store";

/**
 * 讨论室的操作（C-21）。规则和 Phase 0 的 actions 一样：失败写进 notice，不向上抛。
 *
 * 真实后端在 D-21 之前不认识讨论室的查询——那时 disc.available = false，
 * 讨论室页面显示"还没上线"，单次评审照常可用。
 */
/** agent.update 的请求（去掉 type） */
export type AgentPatch = Omit<CommandRequest<"agent.update">, "type">;

export function createDiscussionActions(store: Store<AppState>, client: RoomClient, fail: (err: unknown) => void) {
  const setDisc = (f: (d: DiscussionState) => DiscussionState) => store.set((s) => ({ ...s, disc: f(s.disc) }));
  const setUi = (f: (u: DiscussionState["ui"]) => DiscussionState["ui"]) => setDisc((d) => ({ ...d, ui: f(d.ui) }));

  const notSupported = (err: unknown) =>
    err instanceof ControlFailure && (err.code === "validation_failed" || err.code === "internal");

  /** 全局：参与者和他们的状态 */
  async function loadAgents() {
    try {
      const [agents, status] = await Promise.all([
        client.query({ type: "agents.list" }),
        client.query({ type: "agents.status" }),
      ]);
      setDisc((d) => ({
        ...d,
        available: true,
        agents,
        agentsLoaded: true,
        status: Object.fromEntries(status.map((x) => [x.agent, x])),
        ui: d.ui.composer.recipients.length
          ? d.ui
          : { ...d.ui, composer: { ...d.ui.composer, recipients: agents.filter((a) => a.canDiscuss && !a.canSummarize).map((a) => a.id) } },
      }));
    } catch (err) {
      if (notSupported(err)) setDisc((d) => ({ ...d, available: false }));
      else fail(err);
    }
  }

  /**
   * 只重读状态（在不在线、额度）。节点的地址 / Token 改了、或者打开秘书页时调用：
   * 状态平时靠 agent.status 事件，改了节点设置没有事件，以前会一直显示旧的「在线」（C-49 / B-09）。
   * 读不到不弹错，留着旧的。
   */
  async function refreshStatus() {
    try {
      const status = await client.query({ type: "agents.status" });
      setDisc((d) => ({ ...d, status: Object.fromEntries(status.map((x) => [x.agent, x])) }));
    } catch {
      // 只是刷新
    }
  }

  /** 某个议题的全部讨论数据。loadProject 之后调用；失败不影响单次评审 */
  async function loadTopic(projectId: string) {
    if (!store.get().disc.available) return;
    try {
      const [rounds, plans] = await Promise.all([
        client.query({ type: "rounds.list", projectId }),
        client.query({ type: "plans.list", projectId }),
      ]);
      const details = await Promise.all(rounds.map((r) => client.query({ type: "rounds.get", roundId: r.id })));
      if (store.get().currentProjectId !== projectId) return;
      const turns = details.flatMap((x) => x.turns);
      // 讨论里的 run 也要有事件（回答中显示流式文字）
      const runIds = turns.map((t) => t.runId).filter((x): x is string => x !== null && !store.get().runEvents[x]);
      const evs = await Promise.all(runIds.map((runId) => client.query({ type: "runs.events", runId })));
      store.set((s) => {
        if (s.currentProjectId !== projectId) return s;
        const runEvents = { ...s.runEvents };
        runIds.forEach((id, i) => (runEvents[id] = appendEvents(runEvents[id], evs[i] ?? [])));
        return {
          ...s,
          runEvents,
          disc: {
            ...s.disc,
            rounds,
            plans,
            batches: details.flatMap((x) => x.batches),
            turns,
            summaries: details.flatMap((x) => (x.summary ? [x.summary] : [])),
            confirm: null,
            board: { ...s.disc.board, live: projectId },
            ui: { ...s.disc.ui, page: { kind: "timeline" } },
          },
        };
      });
    } catch (err) {
      if (notSupported(err)) setDisc((d) => ({ ...d, available: false }));
      else fail(err);
    }
  }

  const pid = () => store.get().currentProjectId;
  let addingNote = false;

  // ------------------------------------------------------------ 讨论室标签的议题列表（C-38）

  /** 一个议题读一句话状态要的数据：只对还没结束的那一轮多查一次 rounds.get */
  async function fetchDigest(projectId: string): Promise<TopicDigest> {
    const [rounds, plans] = await Promise.all([
      client.query({ type: "rounds.list", projectId }),
      client.query({ type: "plans.list", projectId }),
    ]);
    const details = await Promise.all(rounds.filter(isOpenRound).map((r) => client.query({ type: "rounds.get", roundId: r.id })));
    return { rounds, plans, batches: details.flatMap((x) => x.batches), turns: details.flatMap((x) => x.turns) };
  }

  /** 取一次并写缓存：号在开始取的时候发，晚回来的旧结果盖不掉更新的缓存 */
  async function refreshDigest(projectId: string): Promise<boolean> {
    const seq = boardSeq();
    try {
      const g = await fetchDigest(projectId);
      setDisc((d) => ({ ...d, board: withDigest(d.board, projectId, g, seq) }));
      return true;
    } catch {
      return false;
    }
  }

  const markFailed = (projectId: string) =>
    setDisc((d) => (d.board.topics[projectId] ? d : { ...d, board: { ...d.board, failed: { ...d.board.failed, [projectId]: true } } }));

  /**
   * 启动时读一遍所有议题。读不到的 1 秒后再试一次，还不行就标「读不出来」（不弹提示，列表只是概览；
   * 点开议题时 loadTopic 会照常报错）
   */
  async function loadBoard(retryMs = 1000) {
    if (!store.get().disc.available) return;
    const failed: string[] = [];
    await Promise.all(
      store.get().projects.map(async (p) => {
        if (!(await refreshDigest(p.id))) failed.push(p.id);
      }),
    );
    if (failed.length === 0) return;
    await new Promise((r) => setTimeout(r, retryMs));
    await Promise.all(
      failed.map(async (pid) => {
        if (store.get().disc.board.live === pid) return;
        if (!(await refreshDigest(pid))) markFailed(pid);
      }),
    );
  }

  /** 别的议题有动静：同一个议题 200ms 内的事件合并成一次重读；那时已经打开了它就不用读 */
  const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
  function refreshSoon(projectId: string) {
    if (refreshTimers.has(projectId)) return;
    refreshTimers.set(
      projectId,
      setTimeout(() => {
        refreshTimers.delete(projectId);
        if (store.get().disc.board.live === projectId) return;
        void refreshDigest(projectId);
      }, 200),
    );
  }

  /** 事件 → 议题列表。当前议题按实时数据算，不用重读；别的议题重读一次 */
  function onBoardEvent(e: ControlEvent) {
    const d = store.get().disc;
    let projectId: string | null = null;
    switch (e.type) {
      case "round.updated":
        projectId = e.round.projectId;
        break;
      case "batch.updated":
        projectId = e.batch.projectId;
        break;
      case "plan.updated":
        projectId = e.plan.projectId;
        break;
      case "turn.updated":
      case "summary.created": {
        const roundId = e.type === "turn.updated" ? e.turn.roundId : e.summary.roundId;
        projectId = Object.entries(d.board.topics).find(([, g]) => g.rounds.some((r) => r.id === roundId))?.[0] ?? null;
        break;
      }
      default:
        return;
    }
    if (!projectId || projectId === d.board.live) return;
    if (!store.get().projects.some((p) => p.id === projectId)) return;
    refreshSoon(projectId);
  }
  const take = (round: Round | null, batch: ApprovalBatch | null) =>
    store.set((s) => {
      let next = s;
      if (round) next = applyEvent(next, { type: "round.updated", round });
      if (batch) next = applyEvent(next, { type: "batch.updated", batch });
      return next;
    });

  async function openConfirm(batchId: string) {
    try {
      const confirm = await client.query({ type: "batches.get", batchId });
      setDisc((d) => ({ ...d, confirm, batches: d.batches.some((b) => b.id === confirm.batch.id) ? d.batches : [...d.batches, confirm.batch] }));
    } catch (err) {
      fail(err);
      return;
    }
    // 确认页要显示模型的名字；没问过节点就顺便问一次
    if (Object.keys(store.get().disc.models).length === 0) await loadModels();
  }

  /**
   * 问每位参与者所在的节点能用哪些模型（C-41）。用 node.test：不传 token，main 只在地址没变时用已保存的。
   * 这是探测，失败不弹提示，记为 null（界面显示「节点没有上报」）。
   */
  async function loadModels() {
    let nodes: NodeInfo[];
    try {
      nodes = await client.query({ type: "nodes.list" });
    } catch {
      return;
    }
    const entries = await Promise.all(
      store.get().disc.agents.map(async (a) => {
        const node = nodes.find((n) => n.id === a.nodeId);
        if (!node || !node.tokenConfigured || a.profileId === null) return [a.id, null] as const;
        try {
          const r = await client.command({ type: "node.test", id: node.id, baseUrl: node.baseUrl, profileId: a.profileId });
          return [a.id, r.reachable ? modelsFor(r.health, a.profileId) ?? null : null] as const;
        } catch {
          return [a.id, null] as const;
        }
      }),
    );
    setDisc((d) => ({ ...d, models: Object.fromEntries(entries) }));
  }

  // ------------------------------------------------------------ 节点与参与者（设置页，C-27）

  /** 设置页用：节点列表（Token 只有 tokenConfigured，永远拿不到值） */
  async function loadNodes(): Promise<NodeInfo[] | undefined> {
    try {
      return await client.query({ type: "nodes.list" });
    } catch (err) {
      fail(err);
      return undefined;
    }
  }

  async function upsertNode(input: { id: string; label: string; baseUrl: string; token?: string }): Promise<NodeInfo | undefined> {
    try {
      return await client.command({ type: "node.upsert", ...input });
    } catch (err) {
      fail(err);
      return undefined;
    }
  }

  async function testNode(input: { id: string; baseUrl: string; profileId: string; token?: string }): Promise<NodeTestResult | undefined> {
    try {
      return await client.command({ type: "node.test", ...input });
    } catch (err) {
      fail(err);
      return undefined;
    }
  }

  /**
   * C-44：从本机读 Token 存进这个节点（路径只在 main 里，renderer 只给 id）。
   * 失败不弹全局错误，返回错误码和说明，由设置页按节点显示。成功后由调用方再调一次 node.test。
   */
  async function importLocalToken(
    id: LocalNodeId,
  ): Promise<{ ok: true; node: NodeInfo } | { ok: false; code: string; message: string }> {
    try {
      return { ok: true, node: await client.command({ type: "node.importLocalToken", id }) };
    } catch (err) {
      if (err instanceof ControlFailure) return { ok: false, code: err.code, message: err.message };
      fail(err);
      return { ok: false, code: "internal", message: "导入失败" };
    }
  }

  /** 改一个参与者（不存在时由后端新建，新建必须带名字和颜色）。成功后刷新参与者和状态 */
  async function updateAgent(patch: AgentPatch): Promise<boolean> {
    try {
      await client.command({ type: "agent.update", ...patch });
      await loadAgents();
      return true;
    } catch (err) {
      fail(err);
      return false;
    }
  }

  const deriving = new Set<string>();

  return {
    loadAgents,
    refreshStatus,
    loadTopic,
    loadBoard,
    onBoardEvent,
    loadNodes,
    upsertNode,
    testNode,
    importLocalToken,
    loadModels,
    updateAgent,

    // ---------------------------------------------------------- 界面开关
    toggleRail: () => setUi((u) => ({ ...u, railCollapsed: !u.railCollapsed })),
    /** 手机宽度：回到议题列表 / 打开议题那一栏 */
    showTopicList: () => setUi((u) => ({ ...u, pane: "list", sheet: false })),
    showTopicPane: () => setUi((u) => ({ ...u, pane: "topic" })),
    toggleSide: () => setUi((u) => ({ ...u, sideCollapsed: !u.sideCollapsed })),
    toggleSheet: () => setUi((u) => ({ ...u, sheet: !u.sheet })),
    toggleRound: (roundId: string) =>
      setUi((u) => ({ ...u, collapsedRounds: { ...u.collapsedRounds, [roundId]: !u.collapsedRounds[roundId] } })),
    setAllRounds: (collapsed: boolean) =>
      setDisc((d) => ({ ...d, ui: { ...d.ui, collapsedRounds: Object.fromEntries(d.rounds.map((r) => [r.id, collapsed])) } })),
    toggleExpanded: (key: string) => setUi((u) => ({ ...u, expanded: { ...u.expanded, [key]: !u.expanded[key] } })),
    setComposerText: (text: string) => setUi((u) => ({ ...u, composer: { ...u.composer, text } })),
    toggleRecipient: (agentId: string) =>
      setUi((u) => {
        const r = u.composer.recipients;
        return { ...u, composer: { ...u.composer, recipients: r.includes(agentId) ? r.filter((x) => x !== agentId) : [...r, agentId] } };
      }),
    goDiscussion: () => store.set((s) => ({ ...s, view: "discussion" })),
    goDesk: () => store.set((s) => ({ ...s, view: "desk" })),

    // ---------------------------------------------------------- 发言 / 起草 / 盖章

    /** 「只发言」：写进时间线，不发给任何人 */
    async addNote() {
      const projectId = pid();
      const text = store.get().disc.ui.composer.text.trim();
      if (!projectId || !text || addingNote) return;
      addingNote = true;
      try {
        const message = await client.command({ type: "note.add", projectId, content: text });
        store.set((s) => applyEvent({ ...s, disc: { ...s.disc, ui: { ...s.disc.ui, composer: { ...s.disc.ui.composer, text: "" } } } },
          { type: "message.created", message }));
      } catch (err) {
        fail(err);
      } finally {
        addingNote = false;
      }
    },

    /** 起草新的一轮并打开确认页。输入框里的文字就是本轮任务 */
    async draftRound() {
      const projectId = pid();
      const { text } = store.get().disc.ui.composer;
      // 只交现在发得了的人：未配置 / 离线 / 暂停的不带上（界面上他们也不显示成勾选）
      const recipients = sendableRecipients(store.get().disc);
      if (!projectId || !text.trim() || recipients.length === 0) return;
      // 退回去改之后：这一轮还是草稿，改好的任务走 round.redraft，不新开一轮（C-03）
      const rejected = rejectedDraftRound(store.get().disc);
      if (rejected) {
        try {
          const { round, batch } = await client.command({ type: "round.redraft", roundId: rejected.id, recipients, task: text.trim() });
          take(round, batch);
          setUi((u) => ({ ...u, composer: { ...u.composer, text: "" } }));
          await openConfirm(batch.id);
        } catch (err) {
          fail(err);
        }
        return;
      }
      const current = planForNextRound(store.get().disc);
      try {
        const { round, batch } = await client.command({
          type: "round.draft",
          projectId,
          recipients,
          task: text.trim(),
          taskSource: "human",
          planVersionId: current?.id ?? null,
          historyMode: "recent_with_summaries",
        });
        take(round, batch);
        setUi((u) => ({ ...u, composer: { ...u.composer, text: "" } }));
        await openConfirm(batch.id);
      } catch (err) {
        fail(err);
      }
    },

    openConfirm,
    closeConfirm: () => setDisc((d) => ({ ...d, confirm: null })),

    /** 盖章：把确认页上看到的每一份内容的 hash 一起交上去 */
    async approveBatch() {
      const c = store.get().disc.confirm;
      if (!c) return;
      try {
        const { batch } = await client.command({
          type: "batch.approve",
          batchId: c.batch.id,
          // C-40：模型和强度也算进盖章指纹；只交 { model, effort }
          expected: c.batch.items.map((i) => ({
            approvalId: i.approvalId,
            contentHash: i.contentHash,
            model: i.model === null ? null : toRunModel(i.model),
          })),
        });
        take(null, batch);
        setDisc((d) => ({ ...d, confirm: null }));
      } catch (err) {
        fail(err);
      }
    },

    async rejectBatch(reason?: string) {
      const c = store.get().disc.confirm;
      if (!c) return;
      try {
        const batch = await client.command({ type: "batch.reject", batchId: c.batch.id, ...(reason ? { reason } : {}) });
        take(null, batch);
        setDisc((d) => ({ ...d, confirm: null }));
        // 退回的是还没发出的新一轮：把任务放回输入框，改完再「去盖章」（C-03）
        const back = rejectedDraftRound(store.get().disc);
        if (back && back.id === batch.roundId && !store.get().disc.ui.composer.text.trim()) {
          setUi((u) => ({ ...u, composer: { ...u.composer, text: back.task } }));
        }
      } catch (err) {
        fail(err);
      }
    },

    // ---------------------------------------------------------- 一轮进行中（C-23 会加完整页面）

    async pauseRound(roundId: string) {
      try {
        take(await client.command({ type: "round.pause", roundId }), null);
      } catch (err) {
        fail(err);
      }
    },
    async resumeRound(roundId: string) {
      try {
        const { round, batch } = await client.command({ type: "round.resume", roundId });
        take(round, batch);
        await openConfirm(batch.id);
      } catch (err) {
        fail(err);
      }
    },
    async endRound(roundId: string) {
      try {
        take(await client.command({ type: "round.end", roundId }), null);
      } catch (err) {
        fail(err);
      }
    },
    async retryAgent(roundId: string, agent: string) {
      try {
        const batch = await client.command({ type: "round.retry", roundId, agent });
        take(null, batch);
        await openConfirm(batch.id);
      } catch (err) {
        fail(err);
      }
    },
    async summarize(roundId: string, summarizer: string) {
      try {
        const batch = await client.command({ type: "round.summarize", roundId, summarizer });
        take(null, batch);
        await openConfirm(batch.id);
      } catch (err) {
        fail(err);
      }
    },

    // ---------------------------------------------------------- 插话 / 改方向（C-23）

    setInterjectMode: (mode: DiscussionState["ui"]["interject"]["mode"]) =>
      setUi((u) => ({ ...u, interject: { ...u.interject, mode } })),
    toggleInterjectTarget: (agentId: string) =>
      setUi((u) => {
        const t = u.interject.targets;
        return { ...u, interject: { ...u.interject, targets: t.includes(agentId) ? t.filter((x) => x !== agentId) : [...t, agentId] } };
      }),

    /** 一轮进行中时发补充。立刻打断 / 只发给某人会生成新批次 → 确认页盖章；放进下一轮只记下来 */
    async supplement() {
      const d = store.get().disc;
      const round = [...d.rounds].sort((a, b) => b.index - a.index).find((r) => ["RUNNING", "PAUSED", "AWAITING_SUMMARY"].includes(r.state));
      const text = d.ui.composer.text.trim();
      if (!round || !text) return;
      const { targets } = d.ui.interject;
      // 暂停中只能「放进下一轮」（要发出去的补充只能在进行中 / 待汇总时盖章，见 D-21 ALLOWED_FROM）
      const mode = round.state === "PAUSED" ? "next_round" : d.ui.interject.mode;
      try {
        const { note, batch } = await client.command({ type: "round.supplement", roundId: round.id, content: text, mode, targets: mode === "next_round" ? [] : targets });
        store.set((s) => applyEvent({ ...s, disc: { ...s.disc, ui: { ...s.disc.ui, composer: { ...s.disc.ui.composer, text: "" } } } }, { type: "message.created", message: note }));
        if (batch) {
          take(null, batch);
          await openConfirm(batch.id);
        }
      } catch (err) {
        fail(err);
      }
    },

    /** 回到某一阶段改方向：这一轮作废（记录保留） */
    async voidRound(roundId: string, reason: string) {
      try {
        take(await client.command({ type: "round.void", roundId, reason }), null);
        const plans = await client.query({ type: "plans.list", projectId: pid()! });
        setDisc((d) => ({ ...d, plans }));
      } catch (err) {
        fail(err);
      }
    },

    // ---------------------------------------------------------- 汇总与方案（C-24）

    openReview: (roundId: string) => setUi((u) => ({ ...u, page: { kind: "review", roundId } })),
    closeReview: () => setUi((u) => ({ ...u, page: { kind: "timeline" } })),
    /** 草案「新议题」：中间一栏换成新建表单（C-33b） */
    openNewTopic: () => setDisc((d) => ({ ...d, confirm: null, ui: { ...d.ui, page: { kind: "new" } } })),

    /** 议题还没有任何方案时，自己写第一版（C-28） */
    async createPlan(content: string, changeNote: string) {
      const projectId = pid();
      if (!projectId) return;
      try {
        const plan = await client.command({ type: "plan.create", projectId, content, changeNote });
        store.set((s) => applyEvent(s, { type: "plan.updated", plan }));
        return plan;
      } catch (err) {
        fail(err);
      }
    },

    async editPlan(parentId: string, content: string, changeNote: string) {
      try {
        const plan = await client.command({ type: "plan.edit", parentId, content, changeNote });
        store.set((s) => applyEvent(s, { type: "plan.updated", plan }));
        return plan;
      } catch (err) {
        fail(err);
      }
    },

    /** 盖章定稿：交上看到的 contentHash，内容变了就拒绝 */
    async finalizePlan(planVersionId: string, expectedContentHash: string) {
      try {
        const plan = await client.command({ type: "plan.finalize", planVersionId, expectedContentHash });
        store.set((s) => applyEvent(s, { type: "plan.updated", plan }));
      } catch (err) {
        fail(err);
      }
    },

    async derivePlan(planVersionId: string) {
      // 连点只发一次（真机上连点叠出过 v2…v12）
      if (deriving.has(planVersionId)) return;
      deriving.add(planVersionId);
      try {
        const plan = await client.command({ type: "plan.derive", planVersionId });
        store.set((s) => applyEvent(s, { type: "plan.updated", plan }));
      } catch (err) {
        fail(err);
      } finally {
        deriving.delete(planVersionId);
      }
    },

    async confirmPlan(planVersionId: string) {
      try {
        const plan = await client.command({ type: "plan.confirm", planVersionId });
        store.set((s) => applyEvent(s, { type: "plan.updated", plan }));
      } catch (err) {
        fail(err);
      }
    },
  };
}

export type DiscussionActions = ReturnType<typeof createDiscussionActions>;
export { initialDiscussion };
