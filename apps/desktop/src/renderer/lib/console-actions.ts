import type { ControlEvent } from "@room/schemas";
import { ControlFailure, type RoomClient } from "./client";
import type { AppState } from "./state";
import type { Store } from "./store";
import { appendRecent, applyActivityEvent, type ConsoleState } from "./console";

/** 历史一页几条 */
export const ACTIVITY_PAGE = 20;

/**
 * 秘书控制台的操作（C-37）。规则同别处：失败写进 notice，不向上抛。
 * 暂停 / 恢复、替补设置用讨论室已有的 updateAgent（agent.update），这里不重复。
 */
export function createConsoleActions(
  store: Store<AppState>,
  client: RoomClient,
  fail: (err: unknown) => void,
  nav: { openTopic(projectId: string): Promise<void>; openConversation(conversationId: string): Promise<void> },
) {
  const setConsole = (f: (c: ConsoleState) => ConsoleState) => store.set((s) => ({ ...s, console: f(s.console) }));
  const con = () => store.get().console;

  /** 防止快速切换秘书时，前一位的查询结果覆盖后一位 */
  let loadToken = 0;
  /** 查第一页期间有这位的新活动到了：查完再查一次（查询结果可能比事件旧） */
  let dirty = false;
  let loading = false;
  let reloadTimer: ReturnType<typeof setTimeout> | null = null;

  async function loadActivity(agent: string) {
    const token = ++loadToken;
    loading = true;
    dirty = false;
    try {
      const page = await client.query({ type: "agents.activity", agent, limit: ACTIVITY_PAGE });
      if (token !== loadToken) return;
      setConsole((c) => (c.agentId !== agent ? c : { ...c, activityAvailable: true, activity: { agent, ...page } }));
    } catch (err) {
      if (token !== loadToken) return;
      // D-44 之前的真实后端不认识这个查询：活动两栏显示「还没接上」，不弹错误
      if (err instanceof ControlFailure && err.code === "validation_failed") setConsole((c) => ({ ...c, activityAvailable: false }));
      else fail(err);
    } finally {
      if (token === loadToken) {
        loading = false;
        if (dirty) reloadSoon();
      }
    }
  }

  function reloadSoon() {
    if (reloadTimer) return;
    reloadTimer = setTimeout(() => {
      reloadTimer = null;
      const { agentId } = con();
      if (agentId && store.get().view === "console") void loadActivity(agentId);
    }, 300);
  }

  async function selectAgent(agentId: string) {
    setConsole((c) => ({ ...c, agentId, activity: c.activity?.agent === agentId ? c.activity : null }));
    await loadActivity(agentId);
  }

  return {
    /** 顶栏「秘书」：打开控制台，默认看上次看的那位，否则第一位 */
    async open() {
      store.set((s) => ({ ...s, view: "console" }));
      const { agentId } = con();
      const first = agentId ?? store.get().disc.agents[0]?.id ?? null;
      if (first) await selectAgent(first);
    },

    selectAgent,

    async loadMore() {
      const page = con().activity;
      if (!page?.nextCursor) return;
      const agent = page.agent;
      try {
        const more = await client.query({ type: "agents.activity", agent, before: page.nextCursor, limit: ACTIVITY_PAGE });
        setConsole((c) => (c.activity?.agent !== agent ? c : { ...c, activity: appendRecent(c.activity, more) }));
      } catch (err) {
        fail(err);
      }
    },

    /** 打开活动对应的议题 / 会话 */
    async openItem(target: { kind: "discussion"; projectId: string } | { kind: "chat"; conversationId: string }) {
      if (target.kind === "discussion") await nav.openTopic(target.projectId);
      else await nav.openConversation(target.conversationId);
    },

    /** Turn / 回答位的事件：就地更新；没见过的（新的一次）重新查第一页 */
    onEvent(e: ControlEvent) {
      if (e.type !== "turn.updated" && e.type !== "chat.slot.updated") return;
      const { agentId, activity } = con();
      const agent = e.type === "turn.updated" ? e.turn.agent : e.slot.agent;
      if (!agentId || agent !== agentId || store.get().view !== "console") return;
      if (loading || !activity || activity.agent !== agentId) {
        dirty = true;
        return;
      }
      const { page, reload } = applyActivityEvent(activity, e);
      if (page !== activity) setConsole((c) => ({ ...c, activity: page }));
      if (reload) reloadSoon();
    },
  };
}
