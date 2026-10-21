import type { ContributionType, NodeTestResult, TextSelection } from "@room/schemas";
import { appendEvents, applyEvent, emptyDraft, type AppState } from "./state";
import { describeFailure, type RoomClient } from "./client";
import type { Store } from "./store";
import { createDiscussionActions } from "./discussion-actions";

/**
 * 所有会访问后端的操作都在这里。UI 组件只调用这些函数，不直接碰 client。
 * 每个操作失败时写入 state.notice，不向上抛——组件不需要 try/catch。
 */
export function createActions(store: Store<AppState>, client: RoomClient) {
  const fail = (err: unknown) => store.set((s) => ({ ...s, notice: { kind: "error", message: describeFailure(err) } }));

  const disc = createDiscussionActions(store, client, fail);

  /** 防止快速切换项目时，旧项目的查询结果覆盖新项目 */
  let loadToken = 0;

  async function loadProject(projectId: string) {
    const token = ++loadToken;
    const [messages, contributions, approvals, runs] = await Promise.all([
      client.query({ type: "messages.list", projectId }),
      client.query({ type: "contributions.list", projectId }),
      client.query({ type: "approvals.list", projectId }),
      client.query({ type: "runs.list", projectId }),
    ]);
    const eventLists = await Promise.all(runs.map((r) => client.query({ type: "runs.events", runId: r.id })));
    if (token !== loadToken) return;
    const runEvents: AppState["runEvents"] = {};
    runs.forEach((r, i) => (runEvents[r.id] = appendEvents(undefined, eventLists[i] ?? [])));
    store.set((s) => ({
      ...s,
      currentProjectId: projectId,
      messages,
      contributions,
      approvals,
      runs,
      runEvents,
      draft: s.currentProjectId === projectId ? s.draft : emptyDraft(),
      selectedRunId: s.currentProjectId === projectId ? s.selectedRunId : null,
      disc:
        s.currentProjectId === projectId
          ? s.disc
          : { ...s.disc, rounds: [], batches: [], turns: [], summaries: [], plans: [], confirm: null },
    }));
    await disc.loadTopic(projectId);
  }

  return {
    ...disc,

    /** 启动：订阅事件 → 读系统状态和项目列表 → 打开第一个项目 */
    async start(): Promise<() => void> {
      // 先订阅再查询：查询期间推来的事件不会丢；重复的由 applyEvent 去重
      const unsubscribe = client.onEvent((e) => store.set((s) => applyEvent(s, e)));
      try {
        const [status, projects] = await Promise.all([
          client.query({ type: "system.status" }),
          client.query({ type: "projects.list" }),
        ]);
        store.set((s) => ({ ...s, status, projects, connection: { phase: "ready" } }));
        await disc.loadAgents();
        const first = projects[0];
        if (first) await loadProject(first.id);
      } catch (err) {
        store.set((s) => ({ ...s, connection: { phase: "failed", message: describeFailure(err) } }));
      }
      return unsubscribe;
    },

    async selectProject(projectId: string) {
      try {
        await loadProject(projectId);
      } catch (err) {
        fail(err);
      }
    },

    async createProject(name: string) {
      try {
        const project = await client.command({ type: "project.create", name });
        store.set((s) => ({ ...s, projects: [...s.projects, project] }));
        await loadProject(project.id);
      } catch (err) {
        fail(err);
      }
    },

    async addSource(sourceAgent: string, content: string) {
      const projectId = store.get().currentProjectId;
      if (!projectId) return;
      try {
        const message = await client.command({ type: "source.add", projectId, sourceAgent, content });
        store.set((s) => applyEvent(s, { type: "message.created", message }));
        return message;
      } catch (err) {
        fail(err);
      }
    },

    async createContribution(input: {
      sourceMessageId: string;
      contributionType: ContributionType;
      title: string;
      selection: TextSelection;
    }) {
      const projectId = store.get().currentProjectId;
      if (!projectId) return;
      try {
        const c = await client.command({ type: "contribution.create", projectId, ...input });
        // 新标记的片段默认勾选进 prompt 草稿
        store.set((s) => ({
          ...s,
          contributions: [...s.contributions, c],
          draft: { ...s.draft, contributionIds: [...s.draft.contributionIds, c.id] },
        }));
        return c;
      } catch (err) {
        fail(err);
      }
    },

    toggleDraftContribution(contributionId: string) {
      store.set((s) => {
        const ids = s.draft.contributionIds;
        const next = ids.includes(contributionId) ? ids.filter((i) => i !== contributionId) : [...ids, contributionId];
        return { ...s, draft: { ...s.draft, contributionIds: next } };
      });
    },

    setTaskInstruction(taskInstruction: string) {
      store.set((s) => ({ ...s, draft: { ...s.draft, taskInstruction } }));
    },

    /** 用当前草稿生成不可变 Snapshot。草稿保留，方便微调后重新生成 */
    async createSnapshot() {
      const { currentProjectId: projectId, draft, contributions } = store.get();
      if (!projectId) return;
      const contributionIds = contributions.filter((c) => draft.contributionIds.includes(c.id)).map((c) => c.id);
      if (contributionIds.length === 0 || !draft.taskInstruction.trim()) return;
      try {
        const { snapshot, approval } = await client.command({
          type: "snapshot.create",
          projectId,
          contributionIds,
          taskInstruction: draft.taskInstruction.trim(),
        });
        // 旧的待审批项会被后端改成 EXPIRED 并通过事件推过来，这里只加新的
        store.set((s) => ({
          ...applyEvent(s, { type: "approval.updated", approval }),
          snapshots: { ...s.snapshots, [snapshot.id]: snapshot },
        }));
        return snapshot;
      } catch (err) {
        fail(err);
      }
    },

    /** 确保某个 Snapshot 已在本地缓存（审批卡片打开时调用） */
    async ensureSnapshot(snapshotId: string) {
      if (store.get().snapshots[snapshotId]) return;
      try {
        const snapshot = await client.query({ type: "snapshots.get", snapshotId });
        store.set((s) => ({ ...s, snapshots: { ...s.snapshots, [snapshot.id]: snapshot } }));
      } catch (err) {
        fail(err);
      }
    },

    async approve(approvalId: string, expectedSnapshotHash: string) {
      try {
        const { approval, run } = await client.command({ type: "approval.approve", approvalId, expectedSnapshotHash });
        store.set((s) => ({
          ...applyEvent(applyEvent(s, { type: "approval.updated", approval }), { type: "run.updated", run }),
          // 刚批准的 run 自动成为当前查看的那一个
          selectedRunId: run.id,
        }));
        return run;
      } catch (err) {
        fail(err);
      }
    },

    async reject(approvalId: string, reason?: string) {
      try {
        const approval = await client.command({
          type: "approval.reject",
          approvalId,
          ...(reason ? { reason } : {}),
        });
        store.set((s) => applyEvent(s, { type: "approval.updated", approval }));
      } catch (err) {
        fail(err);
      }
    },

    async cancelRun(runId: string) {
      try {
        const run = await client.command({ type: "run.cancel", runId, reason: "用户取消" });
        store.set((s) => applyEvent(s, { type: "run.updated", run }));
      } catch (err) {
        fail(err);
      }
    },

    selectRun: (runId: string) => store.set((s) => ({ ...s, selectedRunId: runId })),

    // ---------------------------------------------------------- 设置

    async openSettings() {
      store.set((s) => ({ ...s, view: "settings" }));
      try {
        const { reviewerNode } = await client.query({ type: "settings.get" });
        store.set((s) => ({ ...s, reviewerNode }));
      } catch (err) {
        fail(err);
      }
    },

    closeSettings: () => store.set((s) => ({ ...s, view: "discussion" })),

    /** 测试连接，不保存。token 留空表示用已保存的 */
    async testReviewerNode(input: { baseUrl: string; profileId: string; token?: string }): Promise<NodeTestResult | undefined> {
      try {
        return await client.command({ type: "settings.testReviewerNode", ...input });
      } catch (err) {
        fail(err);
      }
    },

    /** 保存节点设置。token 留空表示保留原来的。成功后刷新系统状态（Reviewer 是否可用） */
    async saveReviewerNode(input: { baseUrl: string; profileId: string; token?: string }): Promise<boolean> {
      try {
        const reviewerNode = await client.command({ type: "settings.updateReviewerNode", ...input });
        const status = await client.query({ type: "system.status" });
        store.set((s) => ({ ...s, reviewerNode, status }));
        return true;
      } catch (err) {
        fail(err);
        return false;
      }
    },

    dismissNotice: () => store.set((s) => ({ ...s, notice: null })),
  };
}

export type Actions = ReturnType<typeof createActions>;
