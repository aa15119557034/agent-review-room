import type {
  AgentChatMessage,
  ChatContent,
  ChatCursor,
  ChatMentions,
  ChatMessage,
  ChatReplySlot,
  ChatSlotFailure,
  ChatSlotOutcome,
  Conversation,
  ConversationMembers,
  UserChatMessage,
} from "@room/schemas";
import { ChatMessage as ChatMessageSchema, ChatReplySlot as ChatReplySlotSchema } from "@room/schemas";
import type { SqliteDatabase } from "./database";
import { ulid } from "./ulid";
import { writeTransaction, type WriteQueue } from "./write-queue";

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
    if (agents.length < 1 || agents.length > 8 || new Set(agents).size !== agents.length) {
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
    db.prepare(
      "INSERT INTO chat_messages (id, conversation_id, sender, created_at, content, mentions, quote_message_id, " +
        "replaces_message_id, state, retracted_at, request_hash) VALUES (?, ?, 'user', ?, ?, ?, ?, ?, ?, NULL, ?)",
    ).run(
      message.id,
      message.conversationId,
      message.createdAt,
      JSON.stringify(message.content),
      JSON.stringify(message.mentions),
      message.quoteMessageId,
      message.replacesMessageId,
      message.state,
      input.requestHash ?? null,
    );
  } else {
    db.prepare(
      "INSERT INTO chat_messages (id, conversation_id, sender, created_at, agent, text, in_reply_to, slot_id, run_id, " +
        "memory_entries_used) VALUES (?, ?, 'agent', ?, ?, ?, ?, ?, ?, ?)",
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

/** 改回答位的可变字段（身份字段有触发器挡着）。**必须在调用方的事务里跑** */
export function updateChatSlot(db: SqliteDatabase, slot: ChatReplySlot): void {
  const parsed = ChatReplySlotSchema.parse(slot);
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

