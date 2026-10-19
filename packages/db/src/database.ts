import Database from "better-sqlite3";
import { runMigrations } from "./migrations";

export type SqliteDatabase = Database.Database;

export interface OpenDatabaseOptions {
  readonly?: boolean;
  /** 等锁上限（毫秒），默认 5000 */
  busyTimeoutMs?: number;
}

/**
 * 打开数据库并保证不变量（D-02）：
 * - journal_mode = WAL：读写并发，崩溃后用 -wal 回放（V0.4 §32 第 2 步）
 * - synchronous = NORMAL：WAL 下的常见折中，断电最多丢最后一批事务
 * - busy_timeout：并发写者等锁而不是立刻 SQLITE_BUSY
 * - foreign_keys = ON：SQLite 默认关闭，必须每个连接打开
 *
 * 注意：数据库文件放在 Electron userData，不进仓库。
 */
export function openDatabase(file: string, options: OpenDatabaseOptions = {}): SqliteDatabase {
  const readonly = options.readonly === true;
  const db = new Database(file, readonly ? { readonly: true } : undefined);
  const busyTimeoutMs = options.busyTimeoutMs ?? 5000;

  // busy_timeout 必须在切 WAL 之前：切换 journal_mode 需要锁，
  // 另一个连接正持锁时应当等待，而不是立刻 SQLITE_BUSY。
  db.pragma(`busy_timeout = ${busyTimeoutMs}`);
  db.pragma("foreign_keys = ON");
  if (!readonly) {
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
  }

  if (!readonly) runMigrations(db);

  return db;
}
