import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import { currentVersion, LATEST_SCHEMA_VERSION, runMigrations } from "./migrations";
import { BACKUP_SUFFIX } from "./schema-v5";

export type SqliteDatabase = Database.Database;

export interface OpenDatabaseOptions {
  readonly?: boolean;
  /** 等锁上限（毫秒），默认 5000 */
  busyTimeoutMs?: number;
  /**
   * 升版本前先备份成 `<file>.bak-v<旧版本>`（D-31a）。
   * 默认开；`:memory:` 和新库（版本 0）自动跳过；测试里传 false 关掉。
   */
  backupBeforeMigrate?: boolean;
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

  if (!readonly) {
    maybeBackupBeforeMigrate(db, file, options.backupBeforeMigrate !== false);
    runMigrations(db);
  }

  return db;
}

/**
 * 迁移前把库原样备份一份（D-31a：升级失败还能退回去）。
 *
 * 用 `VACUUM INTO` 而不是复制文件：WAL 里还没合并的页也在备份里，备份文件本身也是干净的（没有 -wal / -shm）。
 * 只备份一次：第一次升级尝试失败、数据库还停在旧版本时，重跑不会再覆盖那份「升级前」的备份。
 */
function maybeBackupBeforeMigrate(db: SqliteDatabase, file: string, enabled: boolean): void {
  if (!enabled || file === ":memory:") return;
  const version = currentVersion(db);
  if (version === 0 || version >= LATEST_SCHEMA_VERSION) return;

  const target = file + BACKUP_SUFFIX + version;
  if (existsSync(target)) return;
  // 值来自调用方的文件路径，按 SQL 字符串转义（Windows 反斜杠在单引号里是普通字符）
  db.exec("VACUUM INTO '" + target.replace(/'/g, "''") + "'");
}
