import type { SqliteDatabase } from "@room/db";
import {
  AGENT_ACTIVITY_PREVIEW_MAX,
  type AgentActivityCursor,
  type AgentActivityItem,
  type AgentActivityTurn,
  type ChatReplySlot,
  type Conversation,
  type Turn,
} from "@room/schemas";

/**
 * D-44 / C-37a：一位秘书「正在答什么 / 最近答过什么」，讨论的 Turn 和聊天的回答位放在一起。
 *
 * 规则都来自契约（`control-api.ts` 的 `agents.activity`）：
 * - current：Turn 的 outcome 是 pending / running、回答位是 running；(createdAt, id) 正序，不分页，硬上限 200
 * - recent：已经结束的，(createdAt, id) 倒序，一页 limit 条；满页给 nextCursor（= 本页最后一条），不足给 null
 * - `before` 只翻历史：传了 before 时 current 返回空数组
 * - preview：讨论 = 这一轮的任务、聊天 = 那条用户消息的正文；最多 200 **个字符（码点）**；
 *   用户消息已撤回 → null（原文只在审计里）；只有图 / 语音 / 表情、没有文字 → null
 * - 替补代答：Turn.agent 是实际答的人，列在他这边（onBehalfOf 写着代谁）；被替的人那边不列
 * - 作废（VOIDED）的轮里的 Turn 照常列（结局照旧）
 */

/** 一次查询返回的一页（契约 agents.activity 的返回） */
export interface AgentActivityPage {
  current: AgentActivityItem[];
  recent: AgentActivityItem[];
  nextCursor: AgentActivityCursor | null;
}

/** current 的硬上限（契约：main 设硬上限，超出只取最近的那些） */
export const AGENT_ACTIVITY_CURRENT_MAX = 200;
export const AGENT_ACTIVITY_DEFAULT_LIMIT = 20;

interface TurnActivityRow {
  id: string;
  round_id: string;
  batch_id: string;
  agent: string;
  on_behalf_of: string | null;
  is_summary: number;
  approval_id: string;
  run_id: string | null;
  outcome: Turn["outcome"];
  reply_message_id: string | null;
  superseded_by: string | null;
  created_at: string;
  finished_at: string | null;
  partial_text: string | null;
  project_id: string;
  project_name: string;
  round_index: number;
  task: string;
}

interface SlotActivityRow {
  id: string;
  conversation_id: string;
  user_message_id: string;
  agent: string;
  required: number;
  outcome: ChatReplySlot["outcome"];
  run_id: string | null;
  attempt: number;
  reply_message_id: string | null;
  failure: string | null;
  unavailable_reason: ChatReplySlot["unavailableReason"];
  created_at: string;
  finished_at: string | null;
  conv_kind: Conversation["kind"];
  conv_title: string | null;
  conv_pinned: number;
  conv_muted: number;
  conv_last_read_message_id: string | null;
  conv_last_activity_at: string;
  conv_created_at: string;
  /** conversation_members 的 json 数组（按 ordinal 排好） */
  conv_members: string;
  user_content: string | null;
  user_state: "sent" | "retracted" | null;
}

/** 按码点截断（不要切出半个 emoji / 代理对） */
export function truncatePreview(text: string, max = AGENT_ACTIVITY_PREVIEW_MAX): string {
  const codepoints = Array.from(text);
  return codepoints.length <= max ? text : codepoints.slice(0, max).join("");
}

const toActivityTurn = (row: TurnActivityRow): AgentActivityTurn => ({
  id: row.id,
  agent: row.agent,
  onBehalfOf: row.on_behalf_of,
  isSummary: row.is_summary === 1,
  outcome: row.outcome,
  replyMessageId: row.reply_message_id,
  supersededBy: row.superseded_by,
  createdAt: row.created_at,
  finishedAt: row.finished_at,
});

const toConversation = (row: SlotActivityRow): Conversation => ({
  id: row.conversation_id,
  kind: row.conv_kind,
  members: JSON.parse(row.conv_members) as string[],
  title: row.conv_title,
  pinned: row.conv_pinned === 1,
  muted: row.conv_muted === 1,
  lastReadMessageId: row.conv_last_read_message_id,
  lastActivityAt: row.conv_last_activity_at,
  createdAt: row.conv_created_at,
});

const toSlot = (row: SlotActivityRow): ChatReplySlot => ({
  id: row.id,
  conversationId: row.conversation_id,
  userMessageId: row.user_message_id,
  agent: row.agent,
  required: row.required === 1,
  outcome: row.outcome,
  runId: row.run_id,
  attempt: row.attempt,
  replyMessageId: row.reply_message_id,
  failure: row.failure === null ? null : (JSON.parse(row.failure) as ChatReplySlot["failure"]),
  unavailableReason: row.unavailable_reason,
  createdAt: row.created_at,
  finishedAt: row.finished_at,
});

/** 聊天预览：撤回 / 没有文字 → null；有文字按码点截 */
function chatPreview(row: SlotActivityRow): string | null {
  if (row.user_state !== "sent" || row.user_content === null) return null;
  let content: unknown;
  try {
    content = JSON.parse(row.user_content);
  } catch {
    return null;
  }
  if (typeof content !== "object" || content === null) return null;
  const kind = (content as { kind?: unknown }).kind;
  const text =
    kind === "text"
      ? (content as { text?: unknown }).text
      : kind === "voice"
        ? (content as { transcriptText?: unknown }).transcriptText
        : null;
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (trimmed === "") return null;
  return truncatePreview(trimmed);
}

const turnItem = (row: TurnActivityRow): AgentActivityItem => ({
  kind: "discussion",
  projectId: row.project_id,
  projectName: row.project_name,
  roundId: row.round_id,
  roundIndex: row.round_index,
  turn: toActivityTurn(row),
  preview: truncatePreview(row.task),
});

const slotItem = (row: SlotActivityRow): AgentActivityItem => ({
  kind: "chat",
  conversation: toConversation(row),
  slot: toSlot(row),
  preview: chatPreview(row),
});

/** 游标过滤：(created_at, id) 严格在游标之后（倒序翻页） */
const BEFORE_TURN = "(t.created_at < ? OR (t.created_at = ? AND t.id < ?))";
const BEFORE_SLOT = "(s.created_at < ? OR (s.created_at = ? AND s.id < ?))";

const TURN_SELECT =
  "SELECT t.id, t.round_id, t.batch_id, t.agent, t.on_behalf_of, t.is_summary, t.approval_id, t.run_id, t.outcome, " +
  "t.reply_message_id, t.superseded_by, t.created_at, t.finished_at, t.partial_text, " +
  "r.project_id AS project_id, p.name AS project_name, r.round_index AS round_index, r.task AS task " +
  "FROM turns t JOIN rounds r ON r.id = t.round_id JOIN projects p ON p.id = r.project_id ";

const SLOT_SELECT =
  "SELECT s.id, s.conversation_id, s.user_message_id, s.agent, s.required, s.outcome, s.run_id, s.attempt, " +
  "s.reply_message_id, s.failure, s.unavailable_reason, s.created_at, s.finished_at, " +
  "c.kind AS conv_kind, c.title AS conv_title, c.pinned AS conv_pinned, c.muted AS conv_muted, " +
  "c.last_read_message_id AS conv_last_read_message_id, c.last_activity_at AS conv_last_activity_at, " +
  "c.created_at AS conv_created_at, " +
  "(SELECT json_group_array(m.agent) FROM (SELECT agent FROM conversation_members WHERE conversation_id = s.conversation_id ORDER BY ordinal) m) AS conv_members, " +
  "m.content AS user_content, m.state AS user_state " +
  "FROM chat_reply_slots s JOIN conversations c ON c.id = s.conversation_id " +
  "JOIN chat_messages m ON m.id = s.user_message_id ";

/**
 * 一位秘书的活动（C-37a）。调用方已经确认这位秘书存在（不存在报 not_found 是 main 那一层的事）。
 */
export function agentActivity(
  db: SqliteDatabase,
  agentId: string,
  options: { before?: AgentActivityCursor; limit?: number } = {},
): AgentActivityPage {
  const limit = options.limit ?? AGENT_ACTIVITY_DEFAULT_LIMIT;
  const before = options.before;

  // current：还没结束的，正序；不分页（受硬上限约束）
  let current: AgentActivityItem[] = [];
  if (before === undefined) {
    // 先各取「最近的 max+1 条」（倒序），合并后取前 max 条，再翻回正序
    const liveTurns = db
      .prepare(
        TURN_SELECT +
          "WHERE t.agent = ? AND t.outcome IN ('pending', 'running') ORDER BY t.created_at DESC, t.id DESC LIMIT ?",
      )
      .all(agentId, AGENT_ACTIVITY_CURRENT_MAX + 1) as TurnActivityRow[];
    const liveSlots = db
      .prepare(
        SLOT_SELECT + "WHERE s.agent = ? AND s.outcome = 'running' ORDER BY s.created_at DESC, s.id DESC LIMIT ?",
      )
      .all(agentId, AGENT_ACTIVITY_CURRENT_MAX + 1) as SlotActivityRow[];
    current = [...liveTurns.map(turnItem), ...liveSlots.map(slotItem)]
      .sort((a, b) => compareActivity(a, b, "desc"))
      .slice(0, AGENT_ACTIVITY_CURRENT_MAX)
      .sort((a, b) => compareActivity(a, b, "asc"));
  }

  // recent：已经结束的，倒序 + 游标；各取 limit + 1 条再归并，用来判断「满页」
  const turnParams: unknown[] = before === undefined ? [agentId] : [agentId, before.createdAt, before.createdAt, before.id];
  const slotParams: unknown[] = before === undefined ? [agentId] : [agentId, before.createdAt, before.createdAt, before.id];
  const finishedTurns = db
    .prepare(
      TURN_SELECT +
        "WHERE t.agent = ? AND t.outcome NOT IN ('pending', 'running')" +
        (before === undefined ? "" : " AND " + BEFORE_TURN) +
        " ORDER BY t.created_at DESC, t.id DESC LIMIT ?",
    )
    .all(...turnParams, limit + 1) as TurnActivityRow[];
  const finishedSlots = db
    .prepare(
      SLOT_SELECT +
        "WHERE s.agent = ? AND s.outcome <> 'running'" +
        (before === undefined ? "" : " AND " + BEFORE_SLOT) +
        " ORDER BY s.created_at DESC, s.id DESC LIMIT ?",
    )
    .all(...slotParams, limit + 1) as SlotActivityRow[];

  const merged = [...finishedTurns.map(turnItem), ...finishedSlots.map(slotItem)].sort((a, b) =>
    compareActivity(a, b, "desc"),
  );
  const recent = merged.slice(0, limit);
  const nextCursor = merged.length > limit ? cursorOf(recent[recent.length - 1]!) : null;

  return { current, recent, nextCursor };
}

type Direction = "asc" | "desc";

const cursorOf = (item: AgentActivityItem): AgentActivityCursor => {
  const key = item.kind === "discussion" ? item.turn : item.slot;
  return { createdAt: key.createdAt, id: key.id as AgentActivityCursor["id"] };
};

/** (createdAt, id) 排序；id 是 turn_… / slot_… 前缀不同的字符串，比较是确定的 */
function compareActivity(a: AgentActivityItem, b: AgentActivityItem, direction: Direction): number {
  const x = a.kind === "discussion" ? a.turn : a.slot;
  const y = b.kind === "discussion" ? b.turn : b.slot;
  const sameTime = x.createdAt === y.createdAt;
  const byTime = x.createdAt < y.createdAt ? -1 : x.createdAt > y.createdAt ? 1 : 0;
  const byId = x.id === y.id ? 0 : x.id < y.id ? -1 : 1;
  const order = sameTime ? byId : byTime;
  return direction === "asc" ? order : -order;
}
