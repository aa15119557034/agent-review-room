import type { Database } from "better-sqlite3";
import { SCHEMA_V1 } from "./schema";

/**
 * 迁移（D-02）：用 PRAGMA user_version 记版本，每个迁移在自己的事务里跑。
 * 不做 down 迁移——Phase 0 只有前向迁移，回滚靠备份文件。
 */

export interface Migration {
  /** 从 1 开始，必须连续 */
  readonly version: number;
  readonly name: string;
  readonly up: (db: Database) => void;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "phase0-initial",
    up: (db) => {
      db.exec(SCHEMA_V1);
    },
  },
];

/** 当前数据库的 schema 版本（新库为 0）。 */
export function currentVersion(db: Database): number {
  return db.pragma("user_version", { simple: true }) as number;
}

/**
 * 把数据库升到最新版本，返回本次实际执行了几个迁移。
 * 版本不连续（有人插了号却没写迁移）时直接抛错，避免半升级状态。
 */
export function runMigrations(db: Database): number {
  let applied = 0;

  for (const migration of MIGRATIONS) {
    const version = currentVersion(db);
    if (migration.version <= version) continue;
    if (migration.version !== version + 1) {
      throw new Error(
        `migration gap: database is at v${version}, next migration is v${migration.version}`,
      );
    }

    db.exec("BEGIN IMMEDIATE");
    try {
      migration.up(db);
      // PRAGMA 不接受参数占位符；version 来自本文件的常量，不是外部输入
      db.pragma(`user_version = ${migration.version}`);
      db.exec("COMMIT");
      applied += 1;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // 事务可能已被 SQLite 自动回滚
      }
      throw error;
    }
  }

  return applied;
}
