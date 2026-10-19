import type { ContributionType, TextSelection } from "@room/schemas";
import { appendEvents, applyEvent, type AppState } from "./state";
import { describeFailure, type RoomClient } from "./client";
import type { Store } from "./store";

/**
 * 所有会访问后端的操作都在这里。UI 组件只调用这些函数，不直接碰 client。
 * 每个操作失败时写入 state.notice，不向上抛——组件不需要 try/catch。
 */
export function createActions(store: Store<AppState>, client: RoomClient) {
  const fail = (err: unknown) => store.set((s) => ({ ...s, notice: { kind: "error", message: describeFailure(err) } }));

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
    store.set((s) => ({ ...s, currentProjectId: projectId, messages, contributions, approvals, runs, runEvents }));
  }

  return {
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
        store.set((s) => ({ ...s, contributions: [...s.contributions, c] }));
        return c;
      } catch (err) {
        fail(err);
      }
    },

    async createSnapshot(contributionIds: string[], taskInstruction: string) {
      const projectId = store.get().currentProjectId;
      if (!projectId) return;
      try {
        const { snapshot, approval } = await client.command({
          type: "snapshot.create",
          projectId,
          contributionIds,
          taskInstruction,
        });
        // 旧的待审批项会被后端改成 EXPIRED 并通过事件推过来，这里只加新的
        store.set((s) => applyEvent(s, { type: "approval.updated", approval }));
        return snapshot;
      } catch (err) {
        fail(err);
      }
    },

    getSnapshot: (snapshotId: string) => client.query({ type: "snapshots.get", snapshotId }),

    async approve(approvalId: string, expectedSnapshotHash: string) {
      try {
        const { approval, run } = await client.command({ type: "approval.approve", approvalId, expectedSnapshotHash });
        store.set((s) => applyEvent(applyEvent(s, { type: "approval.updated", approval }), { type: "run.updated", run }));
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

    dismissNotice: () => store.set((s) => ({ ...s, notice: null })),
  };
}

export type Actions = ReturnType<typeof createActions>;
