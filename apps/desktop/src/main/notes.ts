import {
  extractRoomNote,
  noteShrankALot,
  type NoteScope,
  type ProjectNote,
  type ProjectNoteReason,
  type RoomNoteRejectReason,
} from "@room/schemas";
import { sha256Hex } from "@room/core";
import {
  getProjectNote,
  insertProjectNote,
  latestProjectNote,
  listLatestProjectNotes,
  listProjectNoteHistory,
  newProjectNoteId,
  noteScopeKey,
  writeTransaction,
  type SqliteDatabase,
  type WriteQueue,
} from "@room/db";
import type { ControlErrorCode, ControlEvent } from "@room/schemas";

/**
 * 项目笔记（C-46 / ADR-005，D-46a）：存版本、从回答里切 room-note、给拼 Prompt 提供「他这份」。
 *
 * 边界：
 * - 存储和版本链在 @room/db（insertProjectNote 会再核一次链）；
 * - 回答的落库由各自的 Run 收尾负责，这里只在落库**成功之后**记一版，所以迟到的结果不会留下孤立笔记；
 * - 拼 Prompt 用 latest()，返回最小形状（id / version / content），不把整条 ProjectNote 塞进 Snapshot。
 */

export interface NoteSnapshot {
  id: string;
  version: number;
  content: string;
}

export interface NoteReplySource {
  kind: "turn" | "chat_run";
  id: string;
}

/** 拼 Prompt / 收回答的两边都只依赖这一层接口（测试可以传假的） */
export interface NotesProvider {
  latest(scope: NoteScope, agent: string): NoteSnapshot | null;
  /** 从回答里切出 room-note：返回显示用的正文 + 要存的笔记内容 / 拒绝原因。**不落库** */
  extract(text: string): { text: string; content: string | null; rejected: RoomNoteRejectReason | null };
  /** 回答落库成功后存一版；内容没变就不新建。失败只记日志，不影响回答 */
  recordReply(input: { scope: NoteScope; agent: string; content: string; source: NoteReplySource }): Promise<ProjectNote | null>;
  /** 切出来了但没存（多段 / 超长 / 没结尾）：发事件，回答照常 */
  reject(input: { scope: NoteScope; agent: string; reason: RoomNoteRejectReason; source: NoteReplySource }): void;
}

export class NoteError extends Error {
  readonly code: ControlErrorCode;
  constructor(code: ControlErrorCode, message: string) {
    super(message);
    this.name = "NoteError";
    this.code = code;
  }
}

export class NotesService implements NotesProvider {
  readonly #db: SqliteDatabase;
  readonly #queue: WriteQueue;
  readonly #emit: (event: ControlEvent) => void;

  constructor(deps: { db: SqliteDatabase; queue: WriteQueue; emit: (event: ControlEvent) => void }) {
    this.#db = deps.db;
    this.#queue = deps.queue;
    this.#emit = deps.emit;
  }

  latest(scope: NoteScope, agent: string): NoteSnapshot | null {
    const note = latestProjectNote(this.#db, scope, agent);
    return note === null ? null : { id: note.id, version: note.version, content: note.content };
  }

  extract(text: string): { text: string; content: string | null; rejected: RoomNoteRejectReason | null } {
    const result = extractRoomNote(text);
    if (result.kind === "ok") return { text: result.text, content: result.content, rejected: null };
    if (result.kind === "invalid") return { text: result.text, content: null, rejected: result.reason };
    return { text, content: null, rejected: null };
  }

  async recordReply(input: { scope: NoteScope; agent: string; content: string; source: NoteReplySource }): Promise<ProjectNote | null> {
    try {
      const note = await this.#append({
        scope: input.scope,
        agent: input.agent,
        content: input.content,
        updatedBy: "agent",
        reason: "reply",
        source: input.source,
        revertedFromId: null,
        skipIfUnchanged: true,
      });
      return note;
    } catch (error) {
      console.warn("[notes] 项目笔记没存上：", error instanceof Error ? error.message : String(error));
      return null;
    }
  }

  reject(input: { scope: NoteScope; agent: string; reason: RoomNoteRejectReason; source: NoteReplySource }): void {
    this.#emit({
      type: "projectNote.rejected",
      scope: input.scope,
      agent: input.agent,
      reason: input.reason,
      source:
        input.source.kind === "turn"
          ? { kind: "turn", turnId: input.source.id }
          : { kind: "chat_run", runId: input.source.id },
    } as ControlEvent);
  }

  /** 用户改：带 expectedParentId 防盖掉秘书刚写的版本 */
  async edit(input: {
    scope: NoteScope;
    agent: string;
    content: string;
    expectedParentId: string | null;
  }): Promise<ProjectNote> {
    this.#assertMember(input.scope, input.agent);
    const latest = latestProjectNote(this.#db, input.scope, input.agent);
    if ((latest?.id ?? null) !== input.expectedParentId) {
      throw new NoteError("invalid_state", "这份笔记已经变了，重新打开再改");
    }
    const note = await this.#append({
      scope: input.scope,
      agent: input.agent,
      content: input.content,
      updatedBy: "human",
      reason: "human_edit",
      source: null,
      revertedFromId: null,
      skipIfUnchanged: true,
    });
    if (note === null) throw new NoteError("internal", "笔记没有变化，但也没找到上一版");
    return note;
  }

  /** 回退：把 noteId 那一版的内容存成新版（不删任何东西） */
  async revert(noteId: string): Promise<ProjectNote> {
    const target = getProjectNote(this.#db, noteId);
    if (target === null) throw new NoteError("not_found", "没有这一版笔记");
    this.#assertMember(target.scope, target.agent);
    const latest = latestProjectNote(this.#db, target.scope, target.agent);
    if (latest !== null && latest.id === target.id) throw new NoteError("invalid_state", "已经是最新一版了");
    const note = await this.#append({
      scope: target.scope,
      agent: target.agent,
      content: target.content,
      updatedBy: "human",
      reason: "revert",
      source: null,
      revertedFromId: target.id,
      skipIfUnchanged: false,
    });
    if (note === null) throw new NoteError("internal", "回退没有存上新版本");
    return note;
  }

  list(scope: NoteScope): ProjectNote[] {
    return listLatestProjectNotes(this.#db, scope);
  }

  history(scope: NoteScope, agent: string): ProjectNote[] {
    return listProjectNoteHistory(this.#db, scope, agent);
  }

  /** 秘书得在这个子项目里（议题的收件人 / 会话成员），否则 not_found */
  #assertMember(scope: NoteScope, agent: string): void {
    if (scope.kind === "conversation") {
      const row = this.#db.prepare("SELECT members FROM conversations WHERE id = ?").get(scope.conversationId) as
        | { members: string }
        | undefined;
      if (row === undefined || !(JSON.parse(row.members) as string[]).includes(agent)) {
        throw new NoteError("not_found", "这位秘书不在这个会话里");
      }
      return;
    }
    const rows = this.#db
      .prepare("SELECT recipients FROM rounds WHERE project_id = ?")
      .all(scope.projectId) as { recipients: string }[];
    const found = rows.some((row) => (JSON.parse(row.recipients) as string[]).includes(agent));
    if (!found) {
      const project = this.#db.prepare("SELECT 1 FROM projects WHERE id = ?").get(scope.projectId);
      throw new NoteError(project === undefined ? "not_found" : "invalid_state", "这位秘书不在这个议题里");
    }
  }

  async #append(input: {
    scope: NoteScope;
    agent: string;
    content: string;
    updatedBy: "agent" | "human";
    reason: ProjectNoteReason;
    source: NoteReplySource | null;
    revertedFromId: string | null;
    skipIfUnchanged: boolean;
  }): Promise<ProjectNote | null> {
    const createdAt = new Date().toISOString();
    const { scope, agent } = input;
    return await writeTransaction(this.#db, this.#queue, () => {
      const latest = latestProjectNote(this.#db, scope, agent);
      if (input.skipIfUnchanged && latest !== null && latest.content === input.content) return latest;
      const contentHash = sha256Hex(input.content);
      const created: ProjectNote = {
        id: newProjectNoteId(),
        scope,
        agent,
        version: latest === null ? 1 : latest.version + 1,
        parentId: latest === null ? null : latest.id,
        content: input.content,
        contentHash,
        updatedBy: input.updatedBy,
        reason: input.reason,
        source: input.source === null ? null : input.source.kind === "turn" ? { kind: "turn", turnId: input.source.id } : { kind: "chat_run", runId: input.source.id },
        revertedFromId: input.revertedFromId,
        shrankALot: noteShrankALot(latest?.content ?? "", input.content),
        createdAt,
      };
      insertProjectNote(this.#db, created);
      this.#emit({ type: "projectNote.created", note: created } as ControlEvent);
      return created;
    });
  }
}

export type { ProjectNote };
