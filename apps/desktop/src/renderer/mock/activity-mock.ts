import {
  AGENT_ACTIVITY_PREVIEW_MAX,
  type AgentActivityCursor,
  type AgentActivityItem,
  type ChatMessage,
  type ChatReplySlot,
  type Conversation,
  type Project,
  type QueryRequest,
  type QueryResponse,
  type Round,
  type Turn,
} from "@room/schemas";
import { MockError } from "./util";

/**
 * C-37a agents.activity 的 mock：把讨论的 Turn 和聊天的回答位按秘书列出来。
 * 规则照契约注释：current 正序全给；recent 按 (createdAt, id) 倒序分页；带 before 时 current 为空；
 * 替补的 Turn 只算实际答的人；用户消息已撤回 → preview = null。
 */
export interface ActivitySources {
  agentExists(agent: string): boolean;
  projects(): Project[];
  discussion(): { rounds: Round[]; turns: Turn[] };
  chat(): Promise<{ conversations: Conversation[]; messages: ChatMessage[]; slots: ChatReplySlot[] }>;
}

const LIVE_TURN: readonly Turn["outcome"][] = ["pending", "running"];

const cut = (text: string | null | undefined): string | null => {
  const t = text?.trim();
  return t ? t.slice(0, AGENT_ACTIVITY_PREVIEW_MAX) : null;
};

const itemKey = (x: AgentActivityItem) => (x.kind === "discussion" ? x.turn : x.slot);
const isLive = (x: AgentActivityItem) => (x.kind === "discussion" ? LIVE_TURN.includes(x.turn.outcome) : x.slot.outcome === "running");

/** (createdAt, id) 比较；a 在 b 之后（更新）为正 */
const cmp = (a: { createdAt: string; id: string }, b: { createdAt: string; id: string }) =>
  a.createdAt !== b.createdAt ? (a.createdAt < b.createdAt ? -1 : 1) : a.id === b.id ? 0 : a.id < b.id ? -1 : 1;

export function createActivityQuery(src: ActivitySources) {
  return async function agentsActivity(req: QueryRequest<"agents.activity">): Promise<QueryResponse<"agents.activity">> {
    if (!src.agentExists(req.agent)) throw new MockError("not_found", `参与者 ${req.agent} 不存在`);
    const projects = src.projects();
    const { rounds, turns } = src.discussion();
    const chat = await src.chat();

    const items: AgentActivityItem[] = [];
    for (const turn of turns) {
      if (turn.agent !== req.agent) continue;
      const round = rounds.find((r) => r.id === turn.roundId);
      const project = round && projects.find((p) => p.id === round.projectId);
      if (!round || !project) continue;
      items.push({
        kind: "discussion",
        projectId: project.id,
        projectName: project.name,
        roundId: round.id,
        roundIndex: round.index,
        turn,
        preview: cut(round.task),
      });
    }
    for (const slot of chat.slots) {
      if (slot.agent !== req.agent) continue;
      const conversation = chat.conversations.find((c) => c.id === slot.conversationId);
      if (!conversation) continue;
      const m = chat.messages.find((x) => x.id === slot.userMessageId);
      const text = m && m.sender === "user" && m.state !== "retracted" && m.content.kind === "text" ? m.content.text : null;
      items.push({ kind: "chat", conversation, slot, preview: cut(text) });
    }

    const current = req.before ? [] : items.filter(isLive).sort((a, b) => cmp(itemKey(a), itemKey(b)));
    const before = req.before as AgentActivityCursor | undefined;
    const done = items
      .filter((x) => !isLive(x))
      .sort((a, b) => cmp(itemKey(b), itemKey(a)))
      .filter((x) => !before || cmp(itemKey(x), before) < 0);
    const limit = req.limit ?? 20;
    const recent = done.slice(0, limit);
    const last = recent[recent.length - 1];
    return {
      current,
      recent,
      nextCursor: done.length > limit && last ? { createdAt: itemKey(last).createdAt, id: itemKey(last).id } : null,
    };
  };
}
