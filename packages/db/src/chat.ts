import type {
  AgentChatMessage,
  BatchModel,
  ChatContent,
  Project,
  ChatCursor,
  ChatHistorySummary,
  ChatMentions,
  ChatMessage,
  ChatReplySlot,
  ChatRun,
  ChatSlotFailure,
  ChatSlotOutcome,
  ChatSnapshot,
  Conversation,
  ConversationMembers,
  FailureReason,
  ImmersiveDeferral,
  MediaIntent,
  MemoryManifest,
  Message,
  RunState,
  RunSubstate,
  UserChatMessage,
} from "@room/schemas";
import {
  CHAT_SLOT_TRANSITIONS,
  RUN_TRANSITIONS,
  isExcludedFromContext,
  ChatHistorySummary as ChatHistorySummarySchema,
  ChatMessage as ChatMessageSchema,
  ChatReplySlot as ChatReplySlotSchema,
  ChatRun as ChatRunSchema,
  ChatSnapshot as ChatSnapshotSchema,
} from "@room/schemas";
import { assertTransition } from "@room/core";
import type { SqliteDatabase } from "./database";
import { ulid } from "./ulid";
import { writeTransaction, type WriteQueue } from "./write-queue";
import { chatSourceReference, isChatMessageCurrent, mergeSourceRefs, readSourceRefs, runSourceRefs, sourceRefsCurrent, SourceUnavailableError, validateCurrentSourceRefs, validateSourceRefs } from "./sources";
import { appendRunEventTx } from "./run-lifecycle";

/**
 * 聊天空间的读写模型（D-31a）。
 *
 * 只做「行 ↔ 契约类型」的翻译和最基本的一致性检查；发送 / 撤回 / 重试的编排（谁建回答位、
 * 什么顺序落库、迟到结果怎么丢）是 D-31b 的事，这里只提供它要用的同步原语：
 *
 * - 写函数**不自己开事务**（除了 createConversation / updateConversation / markRead 这种单动作），
 *   因为 D-31b 要把「消息 + 回答位 + Run」放进同一个事务，嵌套 BEGIN 会直接报错。
 * - 读函数按契约的形状返回，不做额外校验；出参校验由 IPC 的登记表负责。
 * - 聊天消息除撤回外不可变（触发器保证），所以只有 retractChatMessage 一个更新入口。
 */

export const newConversationId = (): string => "conv_" + ulid();
export const newChatMessageId = (): string => "cmsg_" + ulid();
export const newChatSlotId = (): string => "slot_" + ulid();

// ================================================================ 行 → 契约

export interface ConversationRow {
  id: string;
  kind: "direct" | "group";
  direct_agent: string | null;
  title: string | null;
  pinned: number;
  muted: number;
  last_read_message_id: string | null;
  last_activity_at: string;
  created_at: string;
}

const toConversation = (row: ConversationRow, members: readonly string[]): Conversation => ({
  id: row.id,
  kind: row.kind,
  members: [...members],
  title: row.title,
  pinned: row.pinned === 1,
  muted: row.muted === 1,
  lastReadMessageId: row.last_read_message_id,
  lastActivityAt: row.last_activity_at,
  createdAt: row.created_at,
});

export interface ChatMessageRow {
  id: string;
  conversation_id: string;
  sender: "user" | "agent";
  created_at: string;
  content: string | null;
  mentions: string | null;
  quote_message_id: string | null;
  replaces_message_id: string | null;
  state: "sent" | "retracted" | null;
  retracted_at: string | null;
  agent: string | null;
  text: string | null;
  in_reply_to: string | null;
  slot_id: string | null;
  run_id: string | null;
  memory_entries_used: number | null;
  /** C-42e / D-31d：合格的媒体意图（JSON，NULL = 这条回答没有） */
  media_intent: string | null;
  /** C-42e / D-39：沉浸模式没自动执行的原因（JSON；NULL = 没有退回） */
  immersive_deferred: string | null;
  /** C-42c / D-37b（v17）：你这条消息开了「用语音回」；秘书的消息是 NULL */
  reply_as_voice: number | null;
  source_refs: string | null;
}

const toChatMessage = (row: ChatMessageRow): ChatMessage => {
  if (row.sender === "user") {
    const message: UserChatMessage = {
      id: row.id,
      conversationId: row.conversation_id,
      createdAt: row.created_at,
      sender: "user",
      content: JSON.parse(row.content as string) as ChatContent,
      mentions: JSON.parse(row.mentions as string) as ChatMentions,
      quoteMessageId: row.quote_message_id,
      replacesMessageId: row.replaces_message_id,
      state: row.state as "sent" | "retracted",
      retractedAt: row.retracted_at,
      ...(row.reply_as_voice === 1 ? { replyAsVoice: true as const } : {}),
    };
    return message;
  }
  const message: AgentChatMessage = {
    id: row.id,
    conversationId: row.conversation_id,
    createdAt: row.created_at,
    sender: "agent",
    agent: row.agent as string,
    text: row.text as string,
    inReplyTo: row.in_reply_to as string,
    slotId: row.slot_id as string,
    runId: row.run_id as string,
    memoryEntriesUsed: row.memory_entries_used,
    ...(row.source_refs == null ? {} : { sourceRefs: readSourceRefs(row.source_refs) }),
    // C-42e：旧行（D-31d 之前）这一列是 NULL，省略就是「没有媒体意图」
    ...(row.media_intent === null ? {} : { mediaIntent: JSON.parse(row.media_intent) as MediaIntent }),
    ...(row.immersive_deferred === null ? {} : { immersiveDeferred: JSON.parse(row.immersive_deferred) as ImmersiveDeferral }),
  };
  return message;
};

export interface ChatSlotRow {
  id: string;
  conversation_id: string;
  user_message_id: string;
  agent: string;
  required: number;
  outcome: ChatSlotOutcome;
  run_id: string | null;
  attempt: number;
  reply_message_id: string | null;
  failure: string | null;
  unavailable_reason: "offline" | "unconfigured" | "paused_by_user" | null;
  created_at: string;
  finished_at: string | null;
}

const toChatSlot = (row: ChatSlotRow): ChatReplySlot => ({
  id: row.id,
  conversationId: row.conversation_id,
  userMessageId: row.user_message_id,
  agent: row.agent,
  required: row.required === 1,
  outcome: row.outcome,
  runId: row.run_id,
  attempt: row.attempt,
  replyMessageId: row.reply_message_id,
  failure: row.failure === null ? null : (JSON.parse(row.failure) as ChatSlotFailure),
  unavailableReason: row.unavailable_reason,
  createdAt: row.created_at,
  finishedAt: row.finished_at,
});

// ================================================================ 会话：读

const membersOf = (db: SqliteDatabase, conversationId: string): string[] =>
  (
    db
      .prepare("SELECT agent FROM conversation_members WHERE conversation_id = ? ORDER BY ordinal")
      .all(conversationId) as { agent: string }[]
  ).map((r) => r.agent);

export function getConversationRow(db: SqliteDatabase, conversationId: string): ConversationRow | undefined {
  return db.prepare("SELECT * FROM conversations WHERE id = ?").get(conversationId) as ConversationRow | undefined;
}

export function getConversation(db: SqliteDatabase, conversationId: string): Conversation | null {
  const row = getConversationRow(db, conversationId);
  return row === undefined ? null : toConversation(row, membersOf(db, conversationId));
}

/** 会话列表：置顶的在前，其余按最近活跃倒序（索引 idx_conversations_activity 覆盖） */
export function listConversations(db: SqliteDatabase): Conversation[] {
  const rows = db
    .prepare("SELECT * FROM conversations ORDER BY pinned DESC, last_activity_at DESC, id")
    .all() as ConversationRow[];
  if (rows.length === 0) return [];

  const members = new Map<string, string[]>();
  const memberRows = db
    .prepare(
      "SELECT m.conversation_id AS conversationId, m.agent AS agent FROM conversation_members m " +
        "ORDER BY m.conversation_id, m.ordinal",
    )
    .all() as { conversationId: string; agent: string }[];
  for (const m of memberRows) {
    const list = members.get(m.conversationId);
    if (list === undefined) members.set(m.conversationId, [m.agent]);
    else list.push(m.agent);
  }

  return rows.map((row) => toConversation(row, members.get(row.id) ?? []));
}

/** 和这位的单聊（没有就是 null）。一个 Agent 只能有一个单聊，由部分唯一索引保证 */
export function findDirectConversation(db: SqliteDatabase, agent: string): Conversation | null {
  const row = db.prepare("SELECT * FROM conversations WHERE direct_agent = ?").get(agent) as ConversationRow | undefined;
  return row === undefined ? null : toConversation(row, membersOf(db, row.id));
}

// ================================================================ 会话：写

export interface CreateConversationInput {
  members: ConversationMembers;
  /** 你起的名字；null = 用成员名 */
  title: string | null;
  /** 不传就用当前时间 */
  createdAt?: string;
}

/**
 * 新建会话。单聊已经有的话直接返回原来那个（契约：不新建）。
 * 群聊的 2～8 位、不重复由 ConversationMembers 保证；这里再兜一次（不是从命令进来的调用方也要守）。
 */
export function createConversation(
  db: SqliteDatabase,
  queue: WriteQueue,
  input: CreateConversationInput,
): Promise<Conversation> {
  const createdAt = input.createdAt ?? new Date().toISOString();
  return writeTransaction(db, queue, () => {
    if (input.members.kind === "direct") {
      const existing = findDirectConversation(db, input.members.agent);
      if (existing !== null) return existing;
    }

    const agents = input.members.kind === "direct" ? [input.members.agent] : [...input.members.agents];
    // 单聊恰好 1 位，群聊 2～8 位（和 Conversation 的 refine 对齐，绕过 Zod 直接调用也建不出坏数据）
    const minMembers = input.members.kind === "direct" ? 1 : 2;
    if (agents.length < minMembers || agents.length > 8 || new Set(agents).size !== agents.length) {
      throw new Error("conversation members out of range");
    }

    const id = newConversationId();
    db.prepare(
      "INSERT INTO conversations (id, kind, direct_agent, title, pinned, muted, last_read_message_id, last_activity_at, created_at) " +
        "VALUES (?, ?, ?, ?, 0, 0, NULL, ?, ?)",
    ).run(id, input.members.kind, input.members.kind === "direct" ? input.members.agent : null, input.title, createdAt, createdAt);

    const insertMember = db.prepare("INSERT INTO conversation_members (conversation_id, agent, ordinal) VALUES (?, ?, ?)");
    agents.forEach((agent, index) => insertMember.run(id, agent, index));

    return toConversation(getConversationRow(db, id) as ConversationRow, agents);
  });
}

export interface UpdateConversationInput {
  title?: string | null;
  pinned?: boolean;
  muted?: boolean;
  /** 只对群聊：改完仍要 2～8 位、不重复（契约的 GroupMembers） */
  members?: readonly string[];
}

/** 改会话设置。只改传进来的字段；成员整份替换（顺序按数组） */
export function updateConversation(
  db: SqliteDatabase,
  queue: WriteQueue,
  conversationId: string,
  patch: UpdateConversationInput,
): Promise<Conversation | null> {
  return writeTransaction(db, queue, () => {
    const row = getConversationRow(db, conversationId);
    if (row === undefined) return null;

    if (patch.members !== undefined) {
      if (row.kind === "direct") throw new Error("direct conversation has exactly one member");
      const agents = [...patch.members];
      if (agents.length < 2 || agents.length > 8 || new Set(agents).size !== agents.length) {
        throw new Error("group members out of range");
      }
      db.prepare("DELETE FROM conversation_members WHERE conversation_id = ?").run(conversationId);
      const insertMember = db.prepare("INSERT INTO conversation_members (conversation_id, agent, ordinal) VALUES (?, ?, ?)");
      agents.forEach((agent, index) => insertMember.run(conversationId, agent, index));
    }

    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.title !== undefined) (sets.push("title = ?"), params.push(patch.title));
    if (patch.pinned !== undefined) (sets.push("pinned = ?"), params.push(patch.pinned ? 1 : 0));
    if (patch.muted !== undefined) (sets.push("muted = ?"), params.push(patch.muted ? 1 : 0));
    if (sets.length > 0) {
      params.push(conversationId);
      db.prepare("UPDATE conversations SET " + sets.join(", ") + " WHERE id = ?").run(...(params as never[]));
    }

    return getConversation(db, conversationId);
  });
}

/**
 * 读到这一条为止。只能往后挪：比当前 lastRead 旧（按 (createdAt, id)）就忽略。
 * 返回更新后的会话；会话或消息不存在时返回 null。
 */
export function markConversationRead(
  db: SqliteDatabase,
  queue: WriteQueue,
  conversationId: string,
  messageId: string,
): Promise<Conversation | null> {
  return writeTransaction(db, queue, () => {
    const conversation = getConversationRow(db, conversationId);
    if (conversation === undefined) return null;
    const message = db
      .prepare("SELECT id, conversation_id, created_at FROM chat_messages WHERE id = ?")
      .get(messageId) as { id: string; conversation_id: string; created_at: string } | undefined;
    if (message === undefined || message.conversation_id !== conversationId) return null;

    if (conversation.last_read_message_id !== null) {
      const current = db
        .prepare("SELECT id, created_at FROM chat_messages WHERE id = ?")
        .get(conversation.last_read_message_id) as { id: string; created_at: string } | undefined;
      if (current !== undefined && !isAfter(message, current)) return getConversation(db, conversationId);
    }

    db.prepare("UPDATE conversations SET last_read_message_id = ? WHERE id = ?").run(messageId, conversationId);
    return getConversation(db, conversationId);
  });
}

/** (createdAt, id) 的字典序比较 —— 分页和「已读到哪」都用它 */
function isAfter(a: { created_at: string; id: string }, b: { created_at: string; id: string }): boolean {
  if (a.created_at !== b.created_at) return a.created_at > b.created_at;
  return a.id > b.id;
}

// ================================================================ 消息：读

export function getChatMessage(db: SqliteDatabase, messageId: string): ChatMessage | null {
  const row = db.prepare("SELECT * FROM chat_messages WHERE id = ?").get(messageId) as ChatMessageRow | undefined;
  return row === undefined ? null : toChatMessage(row);
}

export interface ListChatMessagesResult {
  messages: ChatMessage[];
  nextCursor: ChatCursor | null;
}

/**
 * 按 (createdAt, id) 倒序分页（契约 chat.messages.list）：不传 before 从最新开始。
 * 已撤回的消息也返回（界面要显示「你撤回了一条消息」）。
 */
export function listChatMessages(
  db: SqliteDatabase,
  conversationId: string,
  before: ChatCursor | null,
  limit: number,
): ListChatMessagesResult {
  if (limit < 1 || limit > 100) throw new Error("limit out of range");

  const rows = (
    before === null
      ? db
          .prepare(
            "SELECT * FROM chat_messages WHERE conversation_id = ? ORDER BY created_at DESC, id DESC LIMIT ?",
          )
          .all(conversationId, limit + 1)
      : db
          .prepare(
            "SELECT * FROM chat_messages WHERE conversation_id = ? AND (created_at < ? OR (created_at = ? AND id < ?)) " +
              "ORDER BY created_at DESC, id DESC LIMIT ?",
          )
          .all(conversationId, before.createdAt, before.createdAt, before.id, limit + 1)
  ) as ChatMessageRow[];

  const messages = rows.slice(0, limit).map(toChatMessage);
  const last = rows.length > limit ? rows[limit - 1] : undefined;
  return {
    messages,
    nextCursor: last === undefined ? null : { createdAt: last.created_at, id: last.id },
  };
}

/**
 * 一整段会话的消息，旧的在前（D-45 摘要规划用）。
 * 分页接口（listChatMessages）是给界面倒着翻的，摘要要按时间顺序看全量。
 */
export function listChatMessagesAscending(db: SqliteDatabase, conversationId: string, limit = 10_000): ChatMessage[] {
  return (
    db
      .prepare("SELECT * FROM chat_messages WHERE conversation_id = ? ORDER BY created_at ASC, id ASC LIMIT ?")
      .all(conversationId, limit) as ChatMessageRow[]
  ).map(toChatMessage);
}

/** 本页里这些消息的全部回答位（chat.messages.list 的 slots 字段） */
export function listChatSlotsForMessages(db: SqliteDatabase, messageIds: readonly string[]): ChatReplySlot[] {
  if (messageIds.length === 0) return [];
  const placeholders = messageIds.map(() => "?").join(", ");
  return (
    db
      .prepare(
        "SELECT * FROM chat_reply_slots WHERE user_message_id IN (" + placeholders + ") ORDER BY user_message_id, agent",
      )
      .all(...messageIds) as ChatSlotRow[]
  ).map(toChatSlot);
}

/** 一条消息的全部回答位 */
export function listChatSlotsForMessage(db: SqliteDatabase, messageId: string): ChatReplySlot[] {
  return listChatSlotsForMessages(db, [messageId]);
}

// ================================================================ 消息：写

export interface InsertChatMessageInput {
  message: ChatMessage;
  /** 只对你发的消息有意义：chatSendIntentJson 的 sha256（D-31b 的防重复） */
  requestHash?: string | null;
}

/**
 * 插入一条消息，并把会话的 lastActivityAt 往前推。
 * **必须在调用方的事务里跑**（D-31b 要把消息、回答位、Run 放同一个事务）。
 */
export function insertChatMessage(db: SqliteDatabase, input: InsertChatMessageInput): void {
  const message = ChatMessageSchema.parse(input.message);

  if (message.sender === "user") {
    if (message.sourceRefs !== undefined) throw new Error("user chat messages cannot supply source references");
    // 引用 / 重新编辑必须指向同一个会话的消息（跨会话引用会让拼 Prompt 和撤回审计读错人）
    for (const referenced of [message.quoteMessageId, message.replacesMessageId]) {
      if (referenced === null) continue;
      const row = db.prepare("SELECT conversation_id, sender FROM chat_messages WHERE id = ?").get(referenced) as
        | { conversation_id: string; sender: string }
        | undefined;
      if (row === undefined) throw new Error("referenced chat message not found: " + referenced);
      if (row.conversation_id !== message.conversationId) {
        throw new Error("referenced chat message is from another conversation");
      }
      if (referenced === message.replacesMessageId && row.sender !== "user") {
        throw new Error("only your own message can be re-edited");
      }
    }

    db.prepare(
      "INSERT INTO chat_messages (id, conversation_id, sender, created_at, content, mentions, quote_message_id, " +
        "replaces_message_id, state, retracted_at, reply_as_voice, request_hash) " +
        "VALUES (?, ?, 'user', ?, ?, ?, ?, ?, ?, NULL, ?, ?)",
    ).run(
      message.id,
      message.conversationId,
      message.createdAt,
      JSON.stringify(message.content),
      JSON.stringify(message.mentions),
      message.quoteMessageId,
      message.replacesMessageId,
      message.state,
      // C-42c / D-37b：只在用户消息上；没开时存 NULL（契约里就是「不传」）
      message.replyAsVoice === true ? 1 : null,
      input.requestHash ?? null,
    );
  } else {
    // 回答必须和它的回答位同一组：同会话、同一位 Agent、回答的就是那条消息、就是当前这次尝试的 Run
    const slotRow = db.prepare("SELECT * FROM chat_reply_slots WHERE id = ?").get(message.slotId) as ChatSlotRow | undefined;
    if (slotRow === undefined) throw new Error("chat reply slot not found: " + message.slotId);
    if (slotRow.conversation_id !== message.conversationId) throw new Error("reply slot belongs to another conversation");
    if (slotRow.agent !== message.agent) throw new Error("reply slot belongs to another agent");
    if (slotRow.user_message_id !== message.inReplyTo) throw new Error("reply slot answers another message");
    if (slotRow.run_id !== message.runId) throw new Error("run does not match the slot's current attempt");
    const parent = db.prepare("SELECT sender, state FROM chat_messages WHERE id = ?").get(message.inReplyTo) as
      | { sender: string; state: string }
      | undefined;
    if (parent?.sender !== "user") throw new Error("agent reply must answer a user message");
    // 消息已撤回 = 之后的上下文里不再有它，迟到的回答不能落库（契约：撤回瞬间答完的结果丢弃）
    if (parent.state !== "sent") throw new Error("agent reply must answer a message that is still in context");

    const sourceRefs = validateSourceRefs(db, { conversationId: message.conversationId }, message.sourceRefs);
    db.prepare(
      "INSERT INTO chat_messages (id, conversation_id, sender, created_at, agent, text, in_reply_to, slot_id, run_id, " +
        "memory_entries_used, media_intent, immersive_deferred, source_refs) VALUES (?, ?, 'agent', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      message.id,
      message.conversationId,
      message.createdAt,
      message.agent,
      message.text,
      message.inReplyTo,
      message.slotId,
      message.runId,
      message.memoryEntriesUsed,
      message.mediaIntent === undefined ? null : JSON.stringify(message.mediaIntent),
      message.immersiveDeferred === undefined ? null : JSON.stringify(message.immersiveDeferred),
      sourceRefs === undefined ? null : JSON.stringify(sourceRefs),
    );
  }

  db.prepare("UPDATE conversations SET last_activity_at = ? WHERE id = ? AND last_activity_at < ?").run(
    message.createdAt,
    message.conversationId,
    message.createdAt,
  );
}

/**
 * 撤回（只有你自己发的消息能撤回，窗口由 D-31b 判）。返回撤回后的消息；不存在 / 不是你的 / 已撤回返回 null。
 * 触发器只允许改 state / retracted_at，这里也只改这两列。
 */
export function retractChatMessage(db: SqliteDatabase, messageId: string, retractedAt: string): UserChatMessage | null {
  const row = db.prepare("SELECT * FROM chat_messages WHERE id = ?").get(messageId) as ChatMessageRow | undefined;
  if (row === undefined || row.sender !== "user" || row.state === "retracted") return null;
  db.prepare("UPDATE chat_messages SET state = 'retracted', retracted_at = ? WHERE id = ?").run(retractedAt, messageId);
  return toChatMessage({ ...row, state: "retracted", retracted_at: retractedAt }) as UserChatMessage;
}

// ================================================================ 历史摘要
// 契约（C-34）的 ChatHistorySummary。X-30 定了形状、D-41 落地存哪儿：
// 「记下来源消息：其中任何一条被撤回，摘要在同一事务里变成 stale，stale 的摘要不再进任何 Snapshot」。

/**
 * 撤回这条消息之后，哪些消息也不再进上下文：**它自己 + 回答它的那些发言**
 * （ADR-003 §2：回答已撤回消息的发言一起排除，`isExcludedFromContext` 就是这么判的）。
 * 覆盖到其中任何一条的摘要都该一起标 stale——只按「用户消息 id」查会漏掉切在一问一答之间的摘要（D-41b）。
 */
export function excludedMessageIdsForRetract(db: SqliteDatabase, messageId: string): string[] {
  const source = db.prepare("SELECT conversation_id FROM chat_messages WHERE id = ?").get(messageId) as { conversation_id: string } | undefined;
  if (source === undefined) return [messageId];
  // Read this conversation's reverse edges once; do not recursively resolve every stored message.
  const edges = db.prepare(
    "SELECT id, in_reply_to AS source_id FROM chat_messages WHERE conversation_id = ? AND in_reply_to IS NOT NULL " +
    "UNION ALL SELECT m.id, json_extract(j.value, '$.source.id') AS source_id FROM chat_messages m, json_each(m.source_refs) j " +
    "WHERE m.conversation_id = ? AND json_extract(j.value, '$.source.kind') = 'chat_message'",
  ).all(source.conversation_id, source.conversation_id) as { id: string; source_id: string }[];
  const dependents = new Map<string, string[]>();
  for (const edge of edges) {
    const children = dependents.get(edge.source_id);
    if (children === undefined) dependents.set(edge.source_id, [edge.id]);
    else children.push(edge.id);
  }
  const excluded = new Set([messageId]);
  for (const id of excluded) for (const dependent of dependents.get(id) ?? []) excluded.add(dependent);
  return [...excluded];
}

interface ChatSummaryRow {
  id: string;
  conversation_id: string;
  source_message_ids: string;
  content: string;
  content_hash: string;
  state: ChatHistorySummary["state"];
  run_id: string;
  agent: string;
  created_at: string;
}

function toChatSummary(row: ChatSummaryRow): ChatHistorySummary {
  return ChatHistorySummarySchema.parse({
    id: row.id,
    conversationId: row.conversation_id,
    sourceMessageIds: JSON.parse(row.source_message_ids) as string[],
    content: row.content,
    contentHash: row.content_hash,
    state: row.state,
    runId: row.run_id,
    agent: row.agent,
    createdAt: row.created_at,
  });
}

/** 写一条摘要。**必须在调用方的事务里跑**（和写摘要的那个 Run 一起落库） */
export function insertChatSummary(db: SqliteDatabase, summary: ChatHistorySummary): void {
  const parsed = ChatHistorySummarySchema.parse(summary);
  db.prepare(
    "INSERT INTO chat_summaries (id, conversation_id, source_message_ids, content, content_hash, state, run_id, agent, " +
      "created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    parsed.id,
    parsed.conversationId,
    JSON.stringify(parsed.sourceMessageIds),
    parsed.content,
    parsed.contentHash,
    parsed.state,
    parsed.runId,
    parsed.agent,
    parsed.createdAt,
  );
}

/** 这个会话有没有还没跑完的历史摘要 Run（D-45：同一会话同时只允许一个） */
export function hasActiveChatSummaryRun(db: SqliteDatabase, conversationId: string): boolean {
  return (
    db
      .prepare(
        "SELECT 1 FROM chat_runs WHERE conversation_id = ? AND purpose = 'history_summary' " +
          "AND state IN ('QUEUED', 'STARTING', 'RUNNING') LIMIT 1",
      )
      .get(conversationId) !== undefined
  );
}

/** 本会话的摘要，按时间正序（拼 Prompt 时的顺序） */
export function listChatSummaries(db: SqliteDatabase, conversationId: string): ChatHistorySummary[] {
  const rows = db
    .prepare("SELECT * FROM chat_summaries WHERE conversation_id = ? ORDER BY created_at, id")
    .all(conversationId) as ChatSummaryRow[];
  return rows.map(toChatSummary);
}

/**
 * 这些消息被撤回：覆盖到它们的摘要**在同一事务里**变成 stale，返回这次改掉的（调用方拿去推 `chat.summary.updated`）。
 * 已经是 stale 的不重复改，也不重复推。
 */
export function markChatSummariesStale(
  db: SqliteDatabase,
  messageIds: readonly string[],
): ChatHistorySummary[] {
  if (messageIds.length === 0) return [];
  const excluded = new Set(messageIds);
  const rows = db.prepare(
    "SELECT * FROM chat_summaries WHERE state = 'current' AND conversation_id IN " +
    "(SELECT conversation_id FROM chat_messages WHERE id IN (SELECT value FROM json_each(?))) ORDER BY created_at, id",
  ).all(JSON.stringify(messageIds)) as ChatSummaryRow[];
  const hits = rows.filter((row) => (JSON.parse(row.source_message_ids) as string[]).some((id) => excluded.has(id)) ||
    (runSourceRefs(db, row.run_id) ?? []).some((ref) => ref.source.kind === "chat_message" && excluded.has(ref.source.id)));
  if (hits.length === 0) return [];
  const update = db.prepare("UPDATE chat_summaries SET state = 'stale' WHERE id = ? AND state = 'current'");
  for (const row of hits) update.run(row.id);
  return hits.map((row) => toChatSummary({ ...row, state: "stale" }));
}

// ================================================================ 回答位

export function getChatSlot(db: SqliteDatabase, slotId: string): ChatReplySlot | null {
  const row = db.prepare("SELECT * FROM chat_reply_slots WHERE id = ?").get(slotId) as ChatSlotRow | undefined;
  return row === undefined ? null : toChatSlot(row);
}

/**
 * 建回答位。**必须在调用方的事务里跑**。
 * 唯一键 (userMessageId, agent) 由表上的唯一索引保证：重试只能改 attempt / runId，不能新建回答位。
 */
export function insertChatSlot(db: SqliteDatabase, slot: ChatReplySlot): void {
  const parsed = ChatReplySlotSchema.parse(slot);
  db.prepare(
    "INSERT INTO chat_reply_slots (id, conversation_id, user_message_id, agent, required, outcome, run_id, attempt, " +
      "reply_message_id, failure, unavailable_reason, created_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    parsed.id,
    parsed.conversationId,
    parsed.userMessageId,
    parsed.agent,
    parsed.required ? 1 : 0,
    parsed.outcome,
    parsed.runId,
    parsed.attempt,
    parsed.replyMessageId,
    parsed.failure === null ? null : JSON.stringify(parsed.failure),
    parsed.unavailableReason,
    parsed.createdAt,
    parsed.finishedAt,
  );
}

/**
 * 改回答位的可变字段（身份字段有触发器挡着）。**必须在调用方的事务里跑**。
 *
 * 状态只能按 CHAT_SLOT_TRANSITIONS 走：retracted 是终态，迟到结果改不回去；重试（→ running）必须 attempt + 1，
 * 其余转换 attempt / runId 都不许变。数据库层兜底，D-31b 漏判一次也不会把撤回的回答放回来。
 */
export function updateChatSlot(db: SqliteDatabase, slot: ChatReplySlot): void {
  const parsed = ChatReplySlotSchema.parse(slot);
  const row = db.prepare("SELECT * FROM chat_reply_slots WHERE id = ?").get(parsed.id) as ChatSlotRow | undefined;
  if (row === undefined) throw new Error("chat reply slot not found: " + parsed.id);
  const previous = toChatSlot(row);

  if (parsed.outcome !== previous.outcome) {
    assertTransition(CHAT_SLOT_TRANSITIONS, "chat slot", previous.outcome, parsed.outcome);
    if (parsed.outcome === "running") {
      // 重试：同一条消息、同一位 Agent 的第 attempt 次尝试，旧的 Run 归档
      if (parsed.attempt !== previous.attempt + 1) {
        throw new Error(
          "retrying a chat slot must increment attempt: " + previous.attempt + " -> " + parsed.attempt,
        );
      }
    } else if (parsed.attempt !== previous.attempt || parsed.runId !== previous.runId) {
      throw new Error("only a retry may change attempt / runId of a chat slot");
    }
  } else if (parsed.attempt !== previous.attempt || parsed.runId !== previous.runId) {
    throw new Error("attempt / runId only change when retrying (chat slot " + parsed.id + ")");
  }

  const result = db
    .prepare(
      "UPDATE chat_reply_slots SET outcome = ?, run_id = ?, attempt = ?, reply_message_id = ?, failure = ?, " +
        "unavailable_reason = ?, finished_at = ? WHERE id = ?",
    )
    .run(
      parsed.outcome,
      parsed.runId,
      parsed.attempt,
      parsed.replyMessageId,
      parsed.failure === null ? null : JSON.stringify(parsed.failure),
      parsed.unavailableReason,
      parsed.finishedAt,
      parsed.id,
    );
  if (result.changes !== 1) throw new Error("chat reply slot not found: " + parsed.id);
}

// ================================================================ Snapshot（不可变）

export interface ChatSnapshotRow {
  id: string;
  purpose: "reply" | "history_summary";
  conversation_id: string;
  user_message_id: string | null;
  agent: string;
  content: string;
  content_hash: string;
  nonce: string;
  memory_slot: string | null;
  attachments: string | null;
  /** C-42g / X-34b：带图时的图片位置标记（v15 才有的列；老行是 NULL） */
  image_slot: string | null;
  /** C-46：这次带上的项目笔记版本（v20 才有的列；老行 / 没带笔记是 NULL） */
  project_note_id: string | null;
  included_message_ids: string;
  included_summary_ids: string;
  adapter_version: string;
  token_estimate: number;
  created_at: string;
  source_refs: string | null;
}

const toChatSnapshot = (row: ChatSnapshotRow): ChatSnapshot => {
  const snapshot: ChatSnapshot = {
    id: row.id,
    purpose: row.purpose,
    conversationId: row.conversation_id,
    userMessageId: row.user_message_id,
    agent: row.agent,
    content: row.content,
    contentHash: row.content_hash,
    nonce: row.nonce,
    memorySlot: row.memory_slot === null ? null : (JSON.parse(row.memory_slot) as ChatSnapshot["memorySlot"]),
    includedMessageIds: JSON.parse(row.included_message_ids) as string[],
    includedSummaryIds: JSON.parse(row.included_summary_ids) as string[],
    adapterVersion: row.adapter_version,
    tokenEstimate: row.token_estimate,
    createdAt: row.created_at,
    ...(row.source_refs == null ? {} : { sourceRefs: readSourceRefs(row.source_refs) }),
  };
  // 可选字段：不传和传 undefined 是两回事，数据库里 NULL 就是没有
  if (row.attachments !== null) snapshot.attachments = JSON.parse(row.attachments) as NonNullable<ChatSnapshot["attachments"]>;
  if (row.image_slot !== null) snapshot.imageSlot = row.image_slot as NonNullable<ChatSnapshot["imageSlot"]>;
  if ((row.project_note_id ?? null) !== null) snapshot.projectNoteId = row.project_note_id;
  return snapshot;
};

/** 写一份 Snapshot。**必须在调用方的事务里跑**（和消息、回答位、Run 同一个事务）。 */
export function insertChatSnapshot(db: SqliteDatabase, snapshot: ChatSnapshot): void {
  const parsed = ChatSnapshotSchema.parse(snapshot);
  const sourceRefs = validateSourceRefs(db, { conversationId: parsed.conversationId }, parsed.sourceRefs);
  db.prepare(
    "INSERT INTO chat_snapshots (id, purpose, conversation_id, user_message_id, agent, content, content_hash, nonce, " +
      "memory_slot, attachments, image_slot, included_message_ids, included_summary_ids, adapter_version, token_estimate, " +
      "project_note_id, created_at, source_refs) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    parsed.id,
    parsed.purpose,
    parsed.conversationId,
    parsed.userMessageId,
    parsed.agent,
    parsed.content,
    parsed.contentHash,
    parsed.nonce,
    parsed.memorySlot === null ? null : JSON.stringify(parsed.memorySlot),
    parsed.attachments === undefined ? null : JSON.stringify(parsed.attachments),
    parsed.imageSlot === undefined ? null : parsed.imageSlot,
    JSON.stringify(parsed.includedMessageIds),
    JSON.stringify(parsed.includedSummaryIds),
    parsed.adapterVersion,
    parsed.tokenEstimate,
    parsed.projectNoteId ?? null,
    parsed.createdAt,
    sourceRefs === undefined ? null : JSON.stringify(sourceRefs),
  );
}

export function getChatSnapshot(db: SqliteDatabase, snapshotId: string): ChatSnapshot | null {
  const row = db.prepare("SELECT * FROM chat_snapshots WHERE id = ?").get(snapshotId) as ChatSnapshotRow | undefined;
  return row === undefined ? null : toChatSnapshot(row);
}

// ================================================================ Run

export interface ChatRunRow {
  id: string;
  kind: "chat";
  purpose: "reply" | "history_summary";
  conversation_id: string;
  slot_id: string | null;
  agent: string;
  snapshot_id: string;
  snapshot_hash: string;
  final_prompt_hash: string | null;
  memory_manifest: string | null;
  model: string | null;
  adapter_id: string;
  state: RunState;
  substate: "active" | "waiting_for_human" | "disconnected" | null;
  failure_reason: FailureReason | null;
  attempt: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

const toChatRun = (row: ChatRunRow): ChatRun => ({
  id: row.id,
  kind: "chat",
  purpose: row.purpose,
  conversationId: row.conversation_id,
  slotId: row.slot_id,
  agent: row.agent,
  snapshotId: row.snapshot_id,
  snapshotHash: row.snapshot_hash,
  finalPromptHash: row.final_prompt_hash,
  memoryManifest: row.memory_manifest === null ? null : (JSON.parse(row.memory_manifest) as MemoryManifest),
  model: row.model === null ? null : (JSON.parse(row.model) as ChatRun["model"]),
  adapterId: row.adapter_id,
  state: row.state,
  substate: row.substate,
  failureReason: row.failure_reason,
  createdAt: row.created_at,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
});

/**
 * 转议题时选中的消息在事务里已经不是「可进上下文」的状态（被撤回了 / 被别的消息替换掉了 / 不在这个会话）。
 * 服务层映射成 invalid_state。
 */
export class ChatToTopicConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatToTopicConflictError";
  }
}

/**
 * 并发发送：同一个 messageId 已经落库（另一个请求先提交了）。
 * 调用方应当重新读那条消息，按防重复规则返回第一次的结果，而不是报 internal。
 */
export class ChatSendDuplicateMessageError extends Error {
  constructor(readonly messageId: string) {
    super("chat message already exists: " + messageId);
    this.name = "ChatSendDuplicateMessageError";
  }
}

/** 事务里的限流兜底：并发发送时事务外那次计数会漏 */
export class ChatSendRateLimitError extends Error {
  constructor(max: number) {
    super("chat rate limit exceeded: " + max + " messages per minute");
    this.name = "ChatSendRateLimitError";
  }
}

/**
 * 发送前的准备（读会话、拼 Snapshot）和提交之间会话变了（成员 / 类型）。
 * 调用方必须重建 Snapshot 再发；不能按旧成员建回答位。
 */
export class ChatSendConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatSendConflictError";
  }
}

/** 迟到结果：Run 已经被别的路径结掉了（撤回 / 取消 / 中断修复），不能再改。 */
export class ChatRunStateConflictError extends Error {
  constructor(
    readonly runId: string,
    readonly expected: RunState,
    readonly actual: RunState | null,
  ) {
    super("chat run " + runId + " is " + (actual ?? "missing") + ", expected " + expected);
    this.name = "ChatRunStateConflictError";
  }
}

export function getChatRun(db: SqliteDatabase, runId: string): ChatRun | null {
  const row = db.prepare("SELECT * FROM chat_runs WHERE id = ?").get(runId) as ChatRunRow | undefined;
  return row === undefined ? null : toChatRun(row);
}

export function listChatRunsForSlot(db: SqliteDatabase, slotId: string): ChatRun[] {
  return (
    db.prepare("SELECT * FROM chat_runs WHERE slot_id = ? ORDER BY attempt").all(slotId) as ChatRunRow[]
  ).map(toChatRun);
}

/** 建一个聊天 Run。**必须在调用方的事务里跑**（和 Snapshot、回答位同一个事务）。 */
export function insertChatRun(db: SqliteDatabase, run: ChatRun): void {
  const parsed = ChatRunSchema.parse(run);

  // 和 Snapshot / 回答位对一遍：调用方传错一个 id 就建不出「Run 指向别人的会话」这种行
  const snapshot = getChatSnapshot(db, parsed.snapshotId);
  if (snapshot === null) throw new Error("chat snapshot not found: " + parsed.snapshotId);
  if (snapshot.contentHash !== parsed.snapshotHash) throw new Error("chat run snapshotHash does not match the snapshot");
  if (snapshot.purpose !== parsed.purpose) throw new Error("chat run purpose does not match the snapshot");
  if (snapshot.conversationId !== parsed.conversationId) throw new Error("chat run conversation does not match the snapshot");
  if (snapshot.agent !== parsed.agent) throw new Error("chat run agent does not match the snapshot");

  const slot = parsed.slotId === null ? null : getChatSlot(db, parsed.slotId);
  if (parsed.purpose === "reply") {
    if (slot === null) throw new Error("chat run has no reply slot: " + parsed.id);
    if (slot.agent !== parsed.agent) throw new Error("chat run agent does not match its slot");
    if (slot.conversationId !== parsed.conversationId) throw new Error("chat run conversation does not match its slot");
    if (slot.runId !== parsed.id) throw new Error("chat run is not the slot's current attempt");
    if (snapshot.userMessageId !== slot.userMessageId) throw new Error("chat run snapshot answers another message");
  } else if (slot !== null) {
    throw new Error("a history_summary run must not have a reply slot");
  }

  db.prepare(
    "INSERT INTO chat_runs (id, kind, purpose, conversation_id, slot_id, agent, snapshot_id, snapshot_hash, " +
      "final_prompt_hash, memory_manifest, model, adapter_id, state, substate, failure_reason, attempt, created_at, " +
      "started_at, finished_at) VALUES (?, 'chat', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    parsed.id,
    parsed.purpose,
    parsed.conversationId,
    parsed.slotId,
    parsed.agent,
    parsed.snapshotId,
    parsed.snapshotHash,
    parsed.finalPromptHash,
    parsed.memoryManifest === null ? null : JSON.stringify(parsed.memoryManifest),
    parsed.model === null ? null : JSON.stringify(parsed.model),
    parsed.adapterId,
    parsed.state,
    parsed.substate,
    parsed.failureReason,
    slot?.attempt ?? 1,
    parsed.createdAt,
    parsed.startedAt,
    parsed.finishedAt,
  );
}

/**
 * 状态迁移（QUEUED → STARTING → RUNNING），CAS 失败就是迟到 / 重复的结果。**在调用方事务里跑**。
 *
 * - 必须走 RUN_TRANSITIONS；**终态只能经 finishChatRun**（否则会出现「COMPLETED 但没有 finished_at、回答位还在转」）
 * - 转成 RUNNING 必须带 substate（契约：RUNNING ⇔ substate 非 null）；from = to 只允许 RUNNING 换子状态
 * - failure_reason 不在这里碰（只有 finishChatRun 写）
 */
export function transitionChatRun(
  db: SqliteDatabase,
  runId: string,
  from: RunState,
  to: RunState,
  patch: { substate?: RunSubstate; startedAt?: string } = {},
): ChatRun {
  if (from === to) {
    if (from !== "RUNNING") throw new Error("only a RUNNING chat run can change its substate");
  } else {
    assertTransition(RUN_TRANSITIONS, "run", from, to);
    if (RUN_TRANSITIONS[to].length === 0) {
      throw new Error("terminal chat run state must go through finishChatRun: " + to);
    }
  }

  const substate = to === "RUNNING" ? (patch.substate ?? null) : null;
  if (to === "RUNNING" && substate === null) throw new Error("a RUNNING chat run needs a substate");

  const result = db
    .prepare("UPDATE chat_runs SET state = ?, substate = ?, started_at = COALESCE(?, started_at) WHERE id = ? AND state = ?")
    .run(to, substate, patch.startedAt ?? null, runId, from);
  if (result.changes !== 1) {
    const current = getChatRun(db, runId);
    throw new ChatRunStateConflictError(runId, from, current?.state ?? null);
  }
  return getChatRun(db, runId) as ChatRun;
}

/**
 * 节点的 prompt_final：记下最终 hash 和记忆清单。每个 Run 最多一次。
 * **在调用方事务里跑**；重复回报返回 false（不覆盖第一次的权威值）。
 *
 * 没有记忆槽位时，契约要求 memory 为 null、finalPromptHash 等于 snapshotHash；对不上就不记。
 */
export function recordChatPromptFinal(
  db: SqliteDatabase,
  runId: string,
  finalPromptHash: string,
  memory: MemoryManifest | null,
): boolean {
  const run = getChatRun(db, runId);
  if (run === null) return false;
  const snapshot = getChatSnapshot(db, run.snapshotId);
  if (snapshot === null) return false;
  if (snapshot.memorySlot === null) {
    if (memory !== null) return false;
    if (finalPromptHash !== run.snapshotHash) return false;
  }

  const result = db
    .prepare("UPDATE chat_runs SET final_prompt_hash = ?, memory_manifest = ? WHERE id = ? AND final_prompt_hash IS NULL")
    .run(finalPromptHash, memory === null ? null : JSON.stringify(memory), runId);
  return result.changes === 1;
}

export type ChatRunTerminal =
  /**
   * C-42e / D-31d：mediaIntent 是 extractMediaIntent 的合格结果，和这条回答在同一个事务里落库；
   * 调用方一项都没合格就不传（不是传空对象——空对象在契约里不合法）。被丢掉的原始值由调用方记日志
   */
  | { kind: "answered"; text: string; mediaIntent?: MediaIntent; immersiveDeferred?: ImmersiveDeferral; sourceRefs?: AgentChatMessage["sourceRefs"] }
  | { kind: "skipped" }
  | { kind: "absent_quota" }
  | { kind: "failed"; failure: ChatSlotFailure; failureReason?: FailureReason }
  | { kind: "cancelled" }
  | { kind: "timed_out" };

export interface FinishChatRunInput {
  /** Rechecked inside the write queue, including a cancellation that arrived while waiting for it. */
  signal?: AbortSignal;
  /** main 已授权的自动媒体计划，只在实际落回答的同一事务里持久化。 */
  immersivePlan?: { draw: boolean; speak: boolean };
  runId: string;
  /** 调用方看到的当前状态；和数据库不一致就说明是迟到 / 重复的结果 */
  from: RunState;
  terminal: ChatRunTerminal;
  finishedAt?: string;
}

export interface FinishChatRunResult {
  run: ChatRun;
  slot: ChatReplySlot | null;
  message: AgentChatMessage | null;
}

/** failed 里哪些是「Run 正常结束、对输出分类得到的失败」——Run 记 COMPLETED，不记 FAILED */
const POST_COMPLETION_FAILURES = new Set<ChatSlotFailure["kind"]>(["empty_output", "parse_error", "skip_not_allowed"]);

/**
 * 结掉一个聊天 Run：Run 终态、回答位结局、秘书的回答消息，**同一个事务**。
 *
 * - 回答位必须是**这次尝试**（slot.runId === run.id）而且还在 running 才会被改；旧尝试的迟到结果只收尾 Run 自己
 * - Run 的状态走 RUN_TRANSITIONS（例如 RUNNING → COMPLETED / FAILED / TIMED_OUT）
 * - empty_output / parse_error / skip_not_allowed 是输出分类，Run 记 COMPLETED；run_failed / interrupted 记 FAILED
 * - 必须回答的人给出 skip → failed(skip_not_allowed)，不能没有结局
 */
export function finishChatRun(
  db: SqliteDatabase,
  queue: WriteQueue,
  input: FinishChatRunInput,
): Promise<FinishChatRunResult> {
  return writeTransaction(db, queue, () => {
    const run = getChatRun(db, input.runId);
    if (run === null) throw new ChatRunStateConflictError(input.runId, input.from, null);
    if (run.state !== input.from) throw new ChatRunStateConflictError(input.runId, input.from, run.state);

    const finishedAt = input.finishedAt ?? new Date().toISOString();
    let slot = run.slotId === null ? null : getChatSlot(db, run.slotId);
    const currentAttempt = slot !== null && slot.runId === run.id && slot.outcome === "running";

    let terminal: ChatRunTerminal = input.signal?.aborted === true ? { kind: "cancelled" } : input.terminal;
    if (currentAttempt && terminal.kind === "skipped" && slot !== null && slot.required) {
      terminal = { kind: "failed", failure: { kind: "skip_not_allowed", message: "单聊或被点名的人必须回答，不能 skip" } };
    }
    let sourceRefs: ReturnType<typeof runSourceRefs>;
    let sourceError: SourceUnavailableError | undefined;
    if (currentAttempt && terminal.kind === "answered") {
      try { sourceRefs = validateCurrentSourceRefs(db, { conversationId: run.conversationId }, mergeSourceRefs([terminal.sourceRefs, runSourceRefs(db, run.id)])); }
      catch (error) {
        if (!(error instanceof SourceUnavailableError)) throw error;
        sourceError = error;
        terminal = { kind: "failed", failureReason: "postprocess", failure: { kind: "run_failed", message: "引用的资料已撤回，请重新生成回答" } };
      }
    }

    const state: RunState =
      terminal.kind === "answered" || terminal.kind === "skipped"
        ? "COMPLETED"
        : terminal.kind === "cancelled"
          ? "CANCELLED"
          : terminal.kind === "timed_out"
            ? "TIMED_OUT"
            : terminal.kind === "absent_quota"
              ? "FAILED"
              : POST_COMPLETION_FAILURES.has(terminal.failure.kind)
                ? "COMPLETED"
                : "FAILED";

    let failureReason: FailureReason | null = null;
    if (state === "FAILED") {
      failureReason = terminal.kind === "absent_quota" ? "quota_exhausted" : terminal.kind === "failed" ? (terminal.failureReason ?? null) : null;
      if (failureReason === null) throw new Error("a FAILED chat run needs a failure reason");
    }

    assertTransition(RUN_TRANSITIONS, "run", input.from, state);
    db.prepare(
      "UPDATE chat_runs SET state = ?, substate = NULL, failure_reason = ?, finished_at = ? WHERE id = ? AND state = ?",
    ).run(state, failureReason, finishedAt, input.runId, input.from);
    if (sourceError !== undefined) {
      appendRunEventTx(db, run.id, { type: "error", ts: finishedAt, payload: { reason: "postprocess", message: sourceError.message } }, { allowTerminal: true, chat: true });
    }

    let message: AgentChatMessage | null = null;
    if (currentAttempt && slot !== null) {
      if (terminal.kind === "answered") {
        const question = getChatMessage(db, slot.userMessageId);
        if (question === null || question.sender !== "user") throw new Error("chat reply slot has no user message");
        message = {
          id: newChatMessageId(),
          conversationId: slot.conversationId,
          createdAt: finishedAt,
          sender: "agent",
          agent: slot.agent,
          text: terminal.text,
          inReplyTo: slot.userMessageId,
          slotId: slot.id,
          runId: run.id,
          memoryEntriesUsed: run.memoryManifest === null ? null : run.memoryManifest.entries.length,
          ...(terminal.mediaIntent === undefined ? {} : { mediaIntent: terminal.mediaIntent }),
          ...(terminal.immersiveDeferred === undefined ? {} : { immersiveDeferred: terminal.immersiveDeferred }),
          ...(sourceRefs === undefined ? {} : { sourceRefs }),
        };
        insertChatMessage(db, { message });
        if (input.immersivePlan?.draw || input.immersivePlan?.speak) {
          db.prepare("INSERT INTO chat_immersive_pending (message_id, draw, speak) VALUES (?, ?, ?)")
            .run(message.id, input.immersivePlan.draw ? 1 : 0, input.immersivePlan.speak ? 1 : 0);
        }
        slot = { ...slot, outcome: "answered", replyMessageId: message.id, finishedAt };
      } else if (terminal.kind === "skipped") {
        slot = { ...slot, outcome: "skipped", finishedAt };
      } else if (terminal.kind === "absent_quota") {
        slot = { ...slot, outcome: "absent_quota", finishedAt };
      } else if (terminal.kind === "cancelled") {
        slot = { ...slot, outcome: "cancelled", finishedAt };
      } else if (terminal.kind === "timed_out") {
        slot = { ...slot, outcome: "failed", failure: { kind: "timed_out", message: "回答超时" }, finishedAt };
      } else {
        slot = { ...slot, outcome: "failed", failure: terminal.failure, finishedAt };
      }
      updateChatSlot(db, slot);
    }

    return { run: getChatRun(db, input.runId) as ChatRun, slot, message };
  });
}

export interface FinishChatSummaryRunInput {
  runId: string;
  /** 调用方看到的当前状态；和数据库不一致就是迟到 / 重复的结果 */
  from: RunState;
  /** 成功时给这份摘要（来源被撤回时不会落库）；和 failure 二选一 */
  summary?: ChatHistorySummary;
  /** 失败（空输出 / 节点报错 / 超时 / 取消）；和 summary 二选一 */
  failure?: { message: string; failureReason: FailureReason };
  finishedAt?: string;
}

export interface FinishChatSummaryRunResult {
  run: ChatRun;
  /** 真的落库的摘要；null = 没写（失败，或者来源在跑的时候被撤回了） */
  summary: ChatHistorySummary | null;
}

/** 这些来源里已经被排除的（消息没了 / 撤回 / 回答的是已撤回的消息） */
function excludedSourceIds(db: SqliteDatabase, ids: readonly string[]): string[] {
  const excluded: string[] = [];
  const inReplyToOf = (messageId: string) => {
    const parent = getChatMessage(db, messageId);
    return parent !== null && parent.sender === "user" ? parent : undefined;
  };
  for (const id of ids) {
    const message = getChatMessage(db, id);
    if (message === null || isExcludedFromContext(message, inReplyToOf) || !isChatMessageCurrent(db, id, message.conversationId)) excluded.push(id);
  }
  return excluded;
}

/**
 * 结掉一个 history_summary Run（D-45）：Run 终态和摘要落库在**同一个事务**里。
 *
 * - 落库前再核一次来源消息：Run 跑的时候有人撤回 / 回答的消息被撤回 → 这份摘要丢掉（不存 current），
 *   Run 仍按 COMPLETED 收尾（输出本身是好的，只是过期了）
 * - 失败（空输出 / 节点报错 / 超时 / 取消）→ Run 记 FAILED；不写摘要
 */
export function finishChatSummaryRun(
  db: SqliteDatabase,
  queue: WriteQueue,
  input: FinishChatSummaryRunInput,
): Promise<FinishChatSummaryRunResult> {
  if ((input.summary === undefined) === (input.failure === undefined)) {
    throw new Error("finishChatSummaryRun needs exactly one of summary / failure");
  }
  return writeTransaction(db, queue, () => {
    const run = getChatRun(db, input.runId);
    if (run === null) throw new ChatRunStateConflictError(input.runId, input.from, null);
    if (run.state !== input.from) throw new ChatRunStateConflictError(input.runId, input.from, run.state);
    if (run.purpose !== "history_summary") throw new Error("not a history_summary run: " + input.runId);

    const finishedAt = input.finishedAt ?? new Date().toISOString();
    const state: RunState = input.failure === undefined ? "COMPLETED" : "FAILED";
    assertTransition(RUN_TRANSITIONS, "run", input.from, state);

    let stored: ChatHistorySummary | null = null;
    if (input.summary !== undefined) {
      if (input.summary.conversationId !== run.conversationId) throw new Error("summary is for another conversation");
      if (input.summary.runId !== run.id) throw new Error("summary was written by another run");
      if (excludedSourceIds(db, input.summary.sourceMessageIds).length === 0 && sourceRefsCurrent(db, { conversationId: run.conversationId }, runSourceRefs(db, run.id))) {
        insertChatSummary(db, input.summary);
        stored = input.summary;
      }
    }

    db.prepare(
      "UPDATE chat_runs SET state = ?, substate = NULL, failure_reason = ?, finished_at = ? WHERE id = ? AND state = ?",
    ).run(state, input.failure?.failureReason ?? null, finishedAt, input.runId, input.from);
    return { run: getChatRun(db, input.runId) as ChatRun, summary: stored };
  });
}

/**
 * 启动时修复：上次崩溃留下的 QUEUED / STARTING / RUNNING 聊天 Run 统一标成 FAILED(interrupted)，
 * 回答位跟着记 failed(interrupted)，不留转圈的「回答中」。
 */
export async function repairInterruptedChatRuns(
  db: SqliteDatabase,
  queue: WriteQueue,
): Promise<{ repaired: string[] }> {
  const rows = db
    .prepare("SELECT id, state FROM chat_runs WHERE state IN ('QUEUED', 'STARTING', 'RUNNING') ORDER BY created_at")
    .all() as { id: string; state: RunState }[];
  const repaired: string[] = [];
  for (const row of rows) {
    try {
      await finishChatRun(db, queue, {
        runId: row.id,
        from: row.state,
        terminal: { kind: "failed", failure: { kind: "interrupted", message: "应用重启，这次回答中断了" }, failureReason: "interrupted" },
      });
      repaired.push(row.id);
    } catch (error) {
      // 别的路径已经把它结掉了（取消 / 撤回）：跳过，别让启动失败
      if (!(error instanceof ChatRunStateConflictError)) throw error;
    }
  }
  return { repaired };
}
// ================================================================ 一次发送的事务体（D-31b 第二段）

export type ChatSendAvailability =
  | { kind: "available" }
  | { kind: "absent_quota" }
  | { kind: "unavailable"; reason: "offline" | "unconfigured" | "paused_by_user" };

export interface ChatSendRecipient {
  agent: string;
  required: boolean;
  availability: ChatSendAvailability;
}

/**
 * @ 规则（ADR-003 §2 / C-34）：谁是收件人、谁必须回答。
 * - 单聊：对方，required = true
 * - 群聊 @所有人：全部成员，required = true
 * - 群聊 @某几位：只有被点到的人，required = true；没点到的不建回答位
 * - 群聊没点名：全部成员，required = false（可以 skip）
 */
export function chatRecipients(conversation: Conversation, mentions: ChatMentions): string[] {
  const members = conversation.members;
  if (conversation.kind === "direct") {
    if (mentions.kind !== "none") throw new Error("a direct chat only accepts mentions = none");
    return [...members];
  }
  if (mentions.kind === "none" || mentions.kind === "all") return [...members];
  for (const agent of mentions.agents) {
    if (!members.includes(agent)) throw new Error("mentioned agent " + agent + " is not in this conversation");
  }
  return [...mentions.agents];
}

/**
 * 收件人是否必须回答：单聊、@所有人、以及「@某几位里的本人」= true；
 * 群聊没点名、或者 @某几位时没被点到的人 = false。
 */
export function chatRequired(conversation: Conversation, mentions: ChatMentions, agent: string): boolean {
  if (conversation.kind === "direct") return true;
  if (mentions.kind === "all") return true;
  return mentions.kind === "agents" && mentions.agents.includes(agent);
}

export interface CreateChatSendInput {
  /** 消息所在的会话；收件人和 required 由 chatRecipients / chatRequired 自己算，不信调用方 */
  conversation: Conversation;
  message: UserChatMessage;
  /** 只对你发的消息有意义：chatSendIntentJson 的 sha256 */
  requestHash: string | null;
  /** 每位成员的可用性（main 的 ChatService 探测节点）；没传的按 available 处理 */
  availability: ReadonlyMap<string, ChatSendAvailability>;
  /** 给能答的人拼好的 Snapshot（key = agent） */
  snapshots: ReadonlyMap<string, ChatSnapshot>;
  /** Run 的 adapterId（例如 "remote:deepseek-chat"） */
  adapterIds: ReadonlyMap<string, string>;
  /** 每位收件人这次用的模型（C-40 的规则在 main 里算好）；没传 = null（用 profile 自带） */
  models?: ReadonlyMap<string, BatchModel | null>;
  createdAt: string;
  /** 限流兜底：在这个事务里再数一次（并发发送时事务外那次会漏） */
  rateLimit?: { since: string; max: number };
}

export interface CreateChatSendResult {
  message: UserChatMessage;
  slots: ChatReplySlot[];
  runs: ChatRun[];
}

/**
 * 一条消息的落库：消息 + 回答位 +（能答的人的）Snapshot 和 Run，**在同一个事务里**。
 *
 * - 收件人 / required 由 chatRecipients / chatRequired 按会话和 mentions 算，调用方只提供「每位能不能答」
 * - 不能答的人直接记 unavailable / absent_quota，没有 Run；其他人照常（聊天不像讨论室整条失败）
 * - 一个能答的人都没有也算成功
 * - 中途任何一步失败（缺 Snapshot、insertChatRun 不一致）整次回滚，不会留下半套消息 / 回答位
 */
export function createChatSend(
  db: SqliteDatabase,
  queue: WriteQueue,
  input: CreateChatSendInput,
): Promise<CreateChatSendResult> {
  return writeTransaction(db, queue, () => {
    const message = ChatMessageSchema.parse(input.message);
    if (message.sender !== "user") throw new Error("chat send must create a user message");
    if (message.conversationId !== input.conversation.id) throw new Error("chat message belongs to another conversation");
    if (db.prepare("SELECT 1 FROM chat_messages WHERE id = ?").get(message.id) !== undefined) {
      throw new ChatSendDuplicateMessageError(message.id);
    }

    // 限流也在这个事务里再数一次：事务外那次和真正写入之间隔着探测的 await，并发时能一起越过去
    if (input.rateLimit !== undefined) {
      const recent = db
        .prepare(
          "SELECT count(*) AS n FROM chat_messages WHERE conversation_id = ? AND sender = 'user' AND created_at > ?",
        )
        .get(message.conversationId, input.rateLimit.since) as { n: number };
      if (recent.n >= input.rateLimit.max) throw new ChatSendRateLimitError(input.rateLimit.max);
    }

    // 引用 / 重新编辑的校验发生在事务外，中间隔着节点探测的 await：
    // 被引用的消息可能刚被撤回、被重新编辑的原消息可能刚被另一个窗口替换掉。这里在写事务里再核一次。
    if (message.quoteMessageId !== null) {
      const quote = getChatMessage(db, message.quoteMessageId);
      if (quote === null || quote.conversationId !== message.conversationId) {
        throw new ChatSendConflictError("quoted message is not in this conversation");
      }
      if (isExcludedFromContext(quote, parentOf(db))) {
        throw new ChatSendConflictError("quoted message is no longer in context (retracted after the check)");
      }
    }
    if (message.replacesMessageId !== null) {
      const original = getChatMessage(db, message.replacesMessageId);
      if (
        original === null ||
        original.sender !== "user" ||
        original.conversationId !== message.conversationId ||
        original.state !== "retracted"
      ) {
        throw new ChatSendConflictError("the message being re-edited is no longer a retracted message in this conversation");
      }
      if (
        db.prepare("SELECT 1 FROM chat_messages WHERE replaces_message_id = ?").get(original.id) !== undefined
      ) {
        throw new ChatSendConflictError("this message was already re-edited by a concurrent send");
      }
    }

    // 拼 Snapshot 是在事务外做的，中间用户可能改了成员：在同一个事务里重读会话，
    // 和调用方看到的名单不一致就整次拒绝（调用方重建 Snapshot 再发），不能按旧成员建回答位。
    const conversation = getConversation(db, message.conversationId);
    if (conversation === null) throw new ChatSendConflictError("conversation " + message.conversationId + " disappeared");
    if (conversation.kind !== input.conversation.kind) {
      throw new ChatSendConflictError("conversation kind changed while the snapshots were being built");
    }
    const previous = [...input.conversation.members].sort();
    const current = [...conversation.members].sort();
    if (previous.length !== current.length || previous.some((agent, index) => agent !== current[index])) {
      throw new ChatSendConflictError("conversation members changed while the snapshots were being built");
    }

    // availability 是每位收件人的探测结果，必须由调用方显式给出。
    // 不能把「漏传」解释成「能答」：用户暂停的秘书会因此照样开始回答。
    const recipients: ChatSendRecipient[] = chatRecipients(conversation, message.mentions).map((agent) => {
      const availability = input.availability.get(agent);
      if (availability === undefined) throw new Error("missing availability for chat recipient " + agent);
      return {
        agent,
        required: chatRequired(conversation, message.mentions, agent),
        availability,
      };
    });

    insertChatMessage(db, { message, requestHash: input.requestHash });

    const slots: ChatReplySlot[] = [];
    const runs: ChatRun[] = [];

    for (const recipient of recipients) {
    const snapshot = input.snapshots.get(recipient.agent);
    const adapterId = input.adapterIds.get(recipient.agent);
    const canAnswer = recipient.availability.kind === "available";
    if (canAnswer && (snapshot === undefined || adapterId === undefined)) {
      throw new Error("missing snapshot or adapter for " + recipient.agent);
    }
    if (canAnswer && snapshot !== undefined && !snapshot.includedMessageIds.includes(message.id)) {
      throw new Error("snapshot of " + recipient.agent + " does not include the current message");
    }

    const slotId = newChatSlotId();
    const runId = "run_" + ulid();
    const slot: ChatReplySlot = {
      id: slotId,
      conversationId: message.conversationId,
      userMessageId: message.id,
      agent: recipient.agent,
      required: recipient.required,
      outcome: canAnswer ? "running" : recipient.availability.kind === "absent_quota" ? "absent_quota" : "unavailable",
      runId: canAnswer ? runId : null,
      attempt: 1,
      replyMessageId: null,
      failure: null,
      unavailableReason: recipient.availability.kind === "unavailable" ? recipient.availability.reason : null,
      createdAt: input.createdAt,
      finishedAt: canAnswer ? null : input.createdAt,
    };
    insertChatSlot(db, slot);
    slots.push(slot);

    if (!canAnswer || snapshot === undefined || adapterId === undefined) continue;
    insertChatSnapshot(db, snapshot);
    const run: ChatRun = {
      id: runId,
      kind: "chat",
      purpose: "reply",
      conversationId: message.conversationId,
      slotId,
      agent: recipient.agent,
      snapshotId: snapshot.id,
      snapshotHash: snapshot.contentHash,
      finalPromptHash: null,
      memoryManifest: null,
      model: input.models?.get(recipient.agent) ?? null,
      adapterId,
      state: "QUEUED",
      substate: null,
      failureReason: null,
      createdAt: input.createdAt,
      startedAt: null,
      finishedAt: null,
    };
    insertChatRun(db, run);
    runs.push(run);
  }

    return { message, slots, runs };
  });
}
// ================================================================ 一键转议题（D-31c）

export interface CreateChatToTopicInput {
  projectId: string;
  materialId: string;
  conversationId: string;
  name: string;
  /** 选中的聊天消息（按时间排好序；服务层负责校验） */
  chatMessageIds: readonly string[];
  /** 拼好的材料正文 */
  content: string;
  createdAt: string;
}

/**
 * 从聊天建一个议题：项目 + 一条 chat_material 初始材料，**同一个事务**。
 * 内容长度 / 已撤回 / 重复的校验都在服务层、事务开始之前做。
 */
/** isExcludedFromContext 需要的「回答的是哪条你发的消息」查询 */
function parentOf(db: SqliteDatabase): (messageId: string) => UserChatMessage | undefined {
  return (messageId) => {
    const message = getChatMessage(db, messageId);
    return message !== null && message.sender === "user" ? message : undefined;
  };
}

export function createChatToTopic(
  db: SqliteDatabase,
  queue: WriteQueue,
  input: CreateChatToTopicInput,
): Promise<{ project: Project; material: Message }> {
  return writeTransaction(db, queue, () => {
    // 选消息发生在事务外：事务里按 id 重读一次，撤回 / 跨会话都在这儿兜住，不让被撤回的原文进材料
    const placeholders = input.chatMessageIds.map(() => "?").join(", ");
    const rows = db
      .prepare(
        "SELECT m.id AS id, m.sender AS sender, m.state AS state, p.state AS parentState " +
          "FROM chat_messages m LEFT JOIN chat_messages p ON p.id = m.in_reply_to " +
          "WHERE m.conversation_id = ? AND m.id IN (" + placeholders + ")",
      )
      .all(input.conversationId, ...input.chatMessageIds) as {
      id: string;
      sender: "user" | "agent";
      state: "sent" | "retracted" | null;
      parentState: "sent" | "retracted" | null;
    }[];
    if (rows.length !== input.chatMessageIds.length) {
      throw new ChatToTopicConflictError("selected chat messages are missing or belong to another conversation");
    }
    for (const row of rows) {
      const inContext = row.sender === "user" ? row.state === "sent" : row.parentState === "sent";
      if (!inContext || !isChatMessageCurrent(db, row.id, input.conversationId)) throw new ChatToTopicConflictError("chat message " + row.id + " is no longer in context");
    }

    const sourceRefs = mergeSourceRefs([input.chatMessageIds.filter((id) => getChatMessage(db, id)?.sourceRefs !== undefined).map((id) => chatSourceReference(db, id, input.conversationId, input.createdAt))]);

    db.prepare("INSERT INTO projects (id, name, from_conversation_id, created_at) VALUES (?, ?, ?, ?)").run(
      input.projectId,
      input.name,
      input.conversationId,
      input.createdAt,
    );
    db.prepare(
      "INSERT INTO messages (id, project_id, kind, conversation_id, chat_message_ids, content, created_at, source_refs) " +
        "VALUES (?, ?, 'chat_material', ?, ?, ?, ?, ?)",
    ).run(
      input.materialId,
      input.projectId,
      input.conversationId,
      JSON.stringify(input.chatMessageIds),
      input.content,
      input.createdAt,
      sourceRefs === undefined ? null : JSON.stringify(sourceRefs),
    );

    const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(input.projectId) as Record<string, unknown>;
    const material = db.prepare("SELECT * FROM messages WHERE id = ?").get(input.materialId) as Record<string, unknown>;
    return {
      project: {
        id: project["id"] as string,
        name: project["name"] as string,
        fromConversationId: (project["from_conversation_id"] as string | null) ?? null,
        createdAt: project["created_at"] as string,
      },
      material: {
        id: material["id"] as string,
        projectId: material["project_id"] as string,
        kind: "chat_material",
        conversationId: material["conversation_id"] as string,
        chatMessageIds: JSON.parse(material["chat_message_ids"] as string) as string[],
        content: material["content"] as string,
        createdAt: material["created_at"] as string,
        ...(sourceRefs === undefined ? {} : { sourceRefs }),
      },
    };
  });
}
