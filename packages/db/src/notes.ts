import type { ProjectNote } from "@room/schemas";
import { ProjectNote as ProjectNoteSchema, type NoteScope } from "@room/schemas";
import type { SqliteDatabase } from "./database";
import { ulid } from "./ulid";

/**
 * 项目笔记的存储（C-46 / ADR-005，D-46a）。
 *
 * 一版一行、不可变：同一 (scope, agent) 的 version 从 1 连续递增，parent_id 指上一版。
 * 写函数**不自己开事务**（和 chat / discussion 的约定一样），由调用方把「存笔记 + 关联的账」放进同一个事务；
 * 这里只做版本链的一致性检查。
 */

export const newProjectNoteId = (): string => "note_" + ulid();

export interface ProjectNoteRow {
  id: string;
  scope_kind: "topic" | "conversation";
  scope_id: string;
  agent: string;
  version: number;
  parent_id: string | null;
  content: string;
  content_hash: string;
  updated_by: "agent" | "human";
  reason: "reply" | "window_handoff" | "human_edit" | "revert";
  source_kind: "turn" | "chat_run" | null;
  source_id: string | null;
  reverted_from_id: string | null;
  shrank_alot: number;
  created_at: string;
}

/** 契约里的 scope → 表里的两列 */
export const noteScopeKey = (scope: NoteScope): { kind: "topic" | "conversation"; id: string } =>
  scope.kind === "topic" ? { kind: "topic", id: scope.projectId } : { kind: "conversation", id: scope.conversationId };

const toProjectNote = (row: ProjectNoteRow): ProjectNote =>
  ProjectNoteSchema.parse({
    id: row.id,
    scope:
      row.scope_kind === "topic"
        ? { kind: "topic", projectId: row.scope_id }
        : { kind: "conversation", conversationId: row.scope_id },
    agent: row.agent,
    version: row.version,
    parentId: row.parent_id,
    content: row.content,
    contentHash: row.content_hash,
    updatedBy: row.updated_by,
    reason: row.reason,
    source:
      row.source_kind === null || row.source_id === null
        ? null
        : row.source_kind === "turn"
          ? { kind: "turn", turnId: row.source_id }
          : { kind: "chat_run", runId: row.source_id },
    revertedFromId: row.reverted_from_id,
    shrankALot: row.shrank_alot === 1,
    createdAt: row.created_at,
  });

export function getProjectNote(db: SqliteDatabase, id: string): ProjectNote | null {
  const row = db.prepare("SELECT * FROM project_notes WHERE id = ?").get(id) as ProjectNoteRow | undefined;
  return row === undefined ? null : toProjectNote(row);
}

/** 一位秘书在一个子项目里的最新一版；没写过是 null */
export function latestProjectNote(db: SqliteDatabase, scope: NoteScope, agent: string): ProjectNote | null {
  const { kind, id } = noteScopeKey(scope);
  const row = db
    .prepare(
      "SELECT * FROM project_notes WHERE scope_kind = ? AND scope_id = ? AND agent = ? " +
        "ORDER BY version DESC LIMIT 1",
    )
    .get(kind, id, agent) as ProjectNoteRow | undefined;
  return row === undefined ? null : toProjectNote(row);
}

/** 一个子项目里每位秘书的最新一版（只列写过笔记的人），按 agent 排 */
export function listLatestProjectNotes(db: SqliteDatabase, scope: NoteScope): ProjectNote[] {
  const { kind, id } = noteScopeKey(scope);
  const rows = db
    .prepare(
      "SELECT p.* FROM project_notes p " +
        "WHERE p.scope_kind = ? AND p.scope_id = ? AND p.version = (" +
        "  SELECT MAX(q.version) FROM project_notes q " +
        "  WHERE q.scope_kind = p.scope_kind AND q.scope_id = p.scope_id AND q.agent = p.agent" +
        ") ORDER BY p.agent",
    )
    .all(kind, id) as ProjectNoteRow[];
  return rows.map(toProjectNote);
}

/** 一位秘书在一个子项目里的历史版本，新的在前 */
export function listProjectNoteHistory(
  db: SqliteDatabase,
  scope: NoteScope,
  agent: string,
  limit = 200,
): ProjectNote[] {
  const { kind, id } = noteScopeKey(scope);
  const rows = db
    .prepare(
      "SELECT * FROM project_notes WHERE scope_kind = ? AND scope_id = ? AND agent = ? " +
        "ORDER BY version DESC LIMIT ?",
    )
    .all(kind, id, agent, limit) as ProjectNoteRow[];
  return rows.map(toProjectNote);
}

/**
 * 存一版新笔记。**在调用方的事务里跑**：先核版本链（第 1 版没有上一版；之后必须接在当前最新版后面），
 * 再插入。内容和 parentId 的关系是契约的一部分（ProjectNote 的 refine 也会再核一遍）。
 */
export function insertProjectNote(db: SqliteDatabase, note: ProjectNote): void {
  const parsed = ProjectNoteSchema.parse(note);
  const latest = latestProjectNote(db, parsed.scope, parsed.agent);
  if (parsed.version === 1) {
    if (latest !== null) throw new Error("project note version 1 already exists");
  } else if (latest === null || latest.id !== parsed.parentId || latest.version + 1 !== parsed.version) {
    throw new Error("project note is not the next version of the latest one");
  }
  const { kind, id } = noteScopeKey(parsed.scope);
  db.prepare(
    "INSERT INTO project_notes (id, scope_kind, scope_id, agent, version, parent_id, content, content_hash, " +
      "updated_by, reason, source_kind, source_id, reverted_from_id, shrank_alot, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    parsed.id,
    kind,
    id,
    parsed.agent,
    parsed.version,
    parsed.parentId,
    parsed.content,
    parsed.contentHash,
    parsed.updatedBy,
    parsed.reason,
    parsed.source === null ? null : parsed.source.kind,
    parsed.source === null ? null : parsed.source.kind === "turn" ? parsed.source.turnId : parsed.source.runId,
    parsed.revertedFromId,
    parsed.shrankALot ? 1 : 0,
    parsed.createdAt,
  );
}
