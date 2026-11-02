import { ChatWindow as ChatWindowSchema, ChatWindowDraft as ChatWindowDraftSchema, type ChatWindow, type ChatWindowDraft } from "@room/schemas";
import type { SqliteDatabase } from "./database";
import { ulid } from "./ulid";

/**
 * 聊天的「换窗口」存储（C-46 / ADR-005 §4，D-46b）。
 *
 * - 草稿：可改（content / run_id / state / window_id / updated_at），同一 (会话, 秘书) 最多一份 pending。
 * - 窗口：不可变（v21 的触发器拦 UPDATE / DELETE）；index 从 2 开始，和草稿上的边界一起定下来。
 */

export const newChatWindowId = (): string => "cwin_" + ulid();
export const newChatWindowDraftId = (): string => "cwd_" + ulid();

interface DraftRow {
  id: string;
  conversation_id: string;
  agent: string;
  starts_after_message_id: string;
  run_id: string | null;
  content: string | null;
  content_hash: string | null;
  content_by: "agent" | "human" | null;
  state: "pending" | "confirmed" | "cancelled";
  window_id: string | null;
  created_at: string;
  updated_at: string;
}

const toDraft = (row: DraftRow): ChatWindowDraft =>
  ChatWindowDraftSchema.parse({
    id: row.id,
    conversationId: row.conversation_id,
    agent: row.agent,
    startsAfterMessageId: row.starts_after_message_id,
    runId: row.run_id,
    content: row.content,
    contentHash: row.content_hash,
    contentBy: row.content_by,
    state: row.state,
    windowId: row.window_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

export function getChatWindowDraft(db: SqliteDatabase, id: string): ChatWindowDraft | null {
  const row = db.prepare("SELECT * FROM chat_window_drafts WHERE id = ?").get(id) as DraftRow | undefined;
  return row === undefined ? null : toDraft(row);
}

/** 这位秘书在这个会话里还没关的草稿（同一时刻最多一份，契约保证） */
export function pendingChatWindowDraft(db: SqliteDatabase, conversationId: string, agent: string): ChatWindowDraft | null {
  const row = db
    .prepare("SELECT * FROM chat_window_drafts WHERE conversation_id = ? AND agent = ? AND state = 'pending' ORDER BY created_at DESC LIMIT 1")
    .get(conversationId, agent) as DraftRow | undefined;
  return row === undefined ? null : toDraft(row);
}

/** 写一份草稿。**在调用方的事务里跑** */
export function insertChatWindowDraft(db: SqliteDatabase, draft: ChatWindowDraft): void {
  const parsed = ChatWindowDraftSchema.parse(draft);
  db.prepare(
    "INSERT INTO chat_window_drafts (id, conversation_id, agent, starts_after_message_id, run_id, content, content_hash, " +
      "content_by, state, window_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    parsed.id,
    parsed.conversationId,
    parsed.agent,
    parsed.startsAfterMessageId,
    parsed.runId,
    parsed.content,
    parsed.contentHash,
    parsed.contentBy,
    parsed.state,
    parsed.windowId,
    parsed.createdAt,
    parsed.updatedAt,
  );
}

/** 改草稿（内容 / 作者 / Run / 状态 / 指向的窗口 / 更新时间）。**在调用方的事务里跑** */
export function updateChatWindowDraft(db: SqliteDatabase, draft: ChatWindowDraft): void {
  const parsed = ChatWindowDraftSchema.parse(draft);
  db.prepare(
    "UPDATE chat_window_drafts SET run_id = ?, content = ?, content_hash = ?, content_by = ?, state = ?, window_id = ?, " +
      "updated_at = ? WHERE id = ?",
  ).run(
    parsed.runId,
    parsed.content,
    parsed.contentHash,
    parsed.contentBy,
    parsed.state,
    parsed.windowId,
    parsed.updatedAt,
    parsed.id,
  );
}

interface WindowRow {
  id: string;
  conversation_id: string;
  agent: string;
  idx: number;
  starts_after_message_id: string;
  handoff_note_id: string;
  draft_id: string;
  created_at: string;
}

const toWindow = (row: WindowRow): ChatWindow =>
  ChatWindowSchema.parse({
    id: row.id,
    conversationId: row.conversation_id,
    agent: row.agent,
    index: row.idx,
    startsAfterMessageId: row.starts_after_message_id,
    handoffNoteId: row.handoff_note_id,
    draftId: row.draft_id,
    createdAt: row.created_at,
  });

export function getChatWindow(db: SqliteDatabase, id: string): ChatWindow | null {
  const row = db.prepare("SELECT * FROM chat_windows WHERE id = ?").get(id) as WindowRow | undefined;
  return row === undefined ? null : toWindow(row);
}

/** 一个会话里换过的窗口，旧的在前（时间线按边界画） */
export function listChatWindows(db: SqliteDatabase, conversationId: string): ChatWindow[] {
  const rows = db
    .prepare("SELECT * FROM chat_windows WHERE conversation_id = ? ORDER BY created_at, id")
    .all(conversationId) as WindowRow[];
  return rows.map(toWindow);
}

/** 这位秘书当前的窗口；第 1 个窗口（没换过）是 null */
export function currentChatWindow(db: SqliteDatabase, conversationId: string, agent: string): ChatWindow | null {
  const row = db
    .prepare("SELECT * FROM chat_windows WHERE conversation_id = ? AND agent = ? ORDER BY idx DESC LIMIT 1")
    .get(conversationId, agent) as WindowRow | undefined;
  return row === undefined ? null : toWindow(row);
}

/** 写一个窗口。**在调用方的事务里跑**（和存笔记、草稿状态一起） */
export function insertChatWindow(db: SqliteDatabase, window: ChatWindow): void {
  const parsed = ChatWindowSchema.parse(window);
  db.prepare(
    "INSERT INTO chat_windows (id, conversation_id, agent, idx, starts_after_message_id, handoff_note_id, draft_id, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    parsed.id,
    parsed.conversationId,
    parsed.agent,
    parsed.index,
    parsed.startsAfterMessageId,
    parsed.handoffNoteId,
    parsed.draftId,
    parsed.createdAt,
  );
}

/**
 * 窗口里压缩了几次 = 覆盖范围**完全**在这个窗口里的 current 摘要份数。
 * 第 1 个窗口（boundary = null）= 全部 current 摘要。
 */
export function countSummariesInWindow(
  db: SqliteDatabase,
  conversationId: string,
  startsAfterMessageId: string | null,
): number {
  if (startsAfterMessageId === null) {
    const row = db
      .prepare("SELECT COUNT(*) AS n FROM chat_summaries WHERE conversation_id = ? AND state = 'current'")
      .get(conversationId) as { n: number };
    return row.n;
  }
  const boundary = db.prepare("SELECT created_at, id FROM chat_messages WHERE id = ?").get(startsAfterMessageId) as
    | { created_at: string; id: string }
    | undefined;
  if (boundary === undefined) return 0;
  const rows = db
    .prepare("SELECT source_message_ids FROM chat_summaries WHERE conversation_id = ? AND state = 'current'")
    .all(conversationId) as { source_message_ids: string }[];
  let inside = 0;
  for (const row of rows) {
    const ids = JSON.parse(row.source_message_ids) as string[];
    const before = db
      .prepare(
        "SELECT COUNT(*) AS n FROM chat_messages WHERE id IN (SELECT value FROM json_each(?)) " +
          "AND (created_at < ? OR (created_at = ? AND id <= ?))",
      )
      .get(JSON.stringify(ids), boundary.created_at, boundary.created_at, boundary.id) as { n: number };
    if (before.n === 0) inside += 1;
  }
  return inside;
}
