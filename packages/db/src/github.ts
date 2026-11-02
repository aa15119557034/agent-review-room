import type { SqliteDatabase } from "./database";

/**
 * GitHub 同步的队列和状态（C-46 / ADR-005 §5，D-46c）。
 *
 * 只往上推：每个路径只留最新一份内容；推成功才删。Token 不在这里（在设置文件的加密字段里）。
 */

export interface GithubQueueRow {
  path: string;
  content: string;
  message: string;
  created_at: string;
  updated_at: string;
  attempts: number;
  last_error: string | null;
}

export interface GithubSyncState {
  private: boolean | null;
  lastPushedAt: string | null;
  lastError: string | null;
  lastErrorMessage: string | null;
}

/** 排一条（同一个路径覆盖成最新内容，不新增行） */
export function enqueueGithubPush(
  db: SqliteDatabase,
  input: { path: string; content: string; message: string; now: string },
): void {
  db.prepare(
    "INSERT INTO github_push_queue (path, content, message, created_at, updated_at, attempts, last_error) " +
      "VALUES (?, ?, ?, ?, ?, 0, NULL) " +
      "ON CONFLICT(path) DO UPDATE SET content = excluded.content, message = excluded.message, updated_at = excluded.updated_at",
  ).run(input.path, input.content, input.message, input.now, input.now);
}

export function listGithubQueue(db: SqliteDatabase, limit = 20): GithubQueueRow[] {
  return db
    .prepare("SELECT * FROM github_push_queue ORDER BY created_at, path LIMIT ?")
    .all(limit) as GithubQueueRow[];
}

export function countGithubQueue(db: SqliteDatabase): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM github_push_queue").get() as { n: number }).n;
}

export function removeGithubPush(db: SqliteDatabase, path: string, sentUpdatedAt: string, sentContent: string): void {
  // 按「这次推出去的那一版」删：等待 GET/PUT 期间同路径又存了新版（即使同一毫秒）也不能一起删掉（#187）
  db.prepare("DELETE FROM github_push_queue WHERE path = ? AND updated_at = ? AND content = ?").run(
    path,
    sentUpdatedAt,
    sentContent,
  );
}

export function markGithubPushFailed(db: SqliteDatabase, path: string, sentUpdatedAt: string, sentContent: string, error: string): void {
  // 同理：新版没推失败，不要把失败记到它头上（同时比内容和时间，同一毫秒的新版也不会被误伤）
  db.prepare("UPDATE github_push_queue SET attempts = attempts + 1, last_error = ? WHERE path = ? AND updated_at = ? AND content = ?")
    .run(error.slice(0, 500), path, sentUpdatedAt, sentContent);
}

export function getGithubSyncState(db: SqliteDatabase): GithubSyncState {
  const row = db.prepare("SELECT * FROM github_sync_state WHERE id = 1").get() as
    | { private: number | null; last_pushed_at: string | null; last_error: string | null; last_error_message: string | null }
    | undefined;
  if (row === undefined) return { private: null, lastPushedAt: null, lastError: null, lastErrorMessage: null };
  return {
    private: row.private === null ? null : row.private === 1,
    lastPushedAt: row.last_pushed_at,
    lastError: row.last_error,
    lastErrorMessage: row.last_error_message,
  };
}

export function updateGithubSyncState(db: SqliteDatabase, patch: Partial<GithubSyncState>): void {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (patch.private !== undefined) {
    sets.push("private = ?");
    values.push(patch.private === null ? null : patch.private ? 1 : 0);
  }
  if (patch.lastPushedAt !== undefined) {
    sets.push("last_pushed_at = ?");
    values.push(patch.lastPushedAt);
  }
  if (patch.lastError !== undefined) {
    sets.push("last_error = ?");
    values.push(patch.lastError);
  }
  if (patch.lastErrorMessage !== undefined) {
    sets.push("last_error_message = ?");
    values.push(patch.lastErrorMessage);
  }
  if (sets.length === 0) return;
  db.prepare("UPDATE github_sync_state SET " + sets.join(", ") + " WHERE id = 1").run(...values);
}
