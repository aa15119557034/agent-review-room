import type { Database } from "better-sqlite3";
import { SCHEMA_V1, SCHEMA_V2 } from "./schema";
import { SCHEMA_V3, SCHEMA_V3_REBUILD } from "./schema-v3";
import { SCHEMA_V4 } from "./schema-v4";
import { SCHEMA_V5 } from "./schema-v5";
import { SCHEMA_V6 } from "./schema-v6";
import { SCHEMA_V7 } from "./schema-v7";
import { SCHEMA_V8 } from "./schema-v8";
import { SCHEMA_V9 } from "./schema-v9";
import { SCHEMA_V10 } from "./schema-v10";
import { SCHEMA_V11 } from "./schema-v11";
import { SCHEMA_V12 } from "./schema-v12";
import { SCHEMA_V13 } from "./schema-v13";
import { SCHEMA_V14 } from "./schema-v14";
import { SCHEMA_V15 } from "./schema-v15";
import { SCHEMA_V16 } from "./schema-v16";
import { SCHEMA_V17 } from "./schema-v17";
import { SCHEMA_V18 } from "./schema-v18";
import { SCHEMA_V19 } from "./schema-v19";
import { SCHEMA_V20 } from "./schema-v20";
import { SCHEMA_V21 } from "./schema-v21";

/**
 * 迁移（D-02）：用 PRAGMA user_version 记版本，每个迁移在自己的事务里跑。
 * 不做 down 迁移——Phase 0 只有前向迁移，回滚靠备份文件。
 */

export interface Migration {
  /** 从 1 开始，必须连续 */
  readonly version: number;
  readonly name: string;
  readonly up: (db: Database) => void;
  /**
   * 表重建类迁移需要临时关闭外键（SQLite 要求关外键必须在事务之外），
   * runMigrations 会在迁移前后自动开关。
   */
  readonly disableForeignKeys?: boolean;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "phase0-initial",
    up: (db) => {
      db.exec(SCHEMA_V1);
    },
  },
  {
    version: 2,
    name: "runs-failure-reason-incomplete-output",
    disableForeignKeys: true,
    up: (db) => {
      db.exec(SCHEMA_V2);
    },
  },
  {
    version: 3,
    name: "discussion-room",
    disableForeignKeys: true,
    up: (db) => {
      db.exec(SCHEMA_V3);
      db.exec(SCHEMA_V3_REBUILD);
    },
  },
  {
    version: 4,
    name: "model-settings",
    up: (db) => {
      db.exec(SCHEMA_V4);
    },
  },
  {
    version: 5,
    name: "chat-space",
    up: (db) => {
      db.exec(SCHEMA_V5);
    },
  },
  {
    version: 6,
    name: "chat-runs-and-snapshots",
    up: (db) => {
      db.exec(SCHEMA_V6);
    },
  },
  {
    version: 7,
    name: "chat-material-message",
    // 重建 messages：DROP 时会被 contributions 的外键挡住
    disableForeignKeys: true,
    up: (db) => {
      db.exec(SCHEMA_V7);
    },
  },
  {
    version: 8,
    name: "chat-media-intent",
    up: (db) => {
      db.exec(SCHEMA_V8);
    },
  },
  {
    version: 9,
    name: "image-refs",
    up: (db) => {
      db.exec(SCHEMA_V9);
    },
  },
  {
    version: 10,
    name: "chat-files-and-stickers",
    up: (db) => {
      db.exec(SCHEMA_V10);
    },
  },
  {
    version: 11,
    name: "media-jobs",
    up: (db) => {
      db.exec(SCHEMA_V11);
    },
  },
  {
    version: 12,
    name: "voice-recordings",
    up: (db) => {
      db.exec(SCHEMA_V12);
    },
  },
  {
    version: 13,
    name: "controller-local-codex-node",
    up: (db) => {
      db.exec(SCHEMA_V13);
    },
  },
  {
    version: 14,
    name: "chat-history-summaries",
    up: (db) => {
      db.exec(SCHEMA_V14);
    },
  },
  {
    version: 15,
    name: "chat-snapshot-image-slot",
    up: (db) => {
      db.exec(SCHEMA_V15);
    },
  },
  {
    version: 16,
    name: "speech-clips",
    up: (db) => {
      db.exec(SCHEMA_V16);
    },
  },
  {
    version: 17,
    name: "chat-reply-as-voice",
    up: (db) => {
      db.exec(SCHEMA_V17);
    },
  },
  {
    version: 18,
    name: "agent-activity-indexes",
    up: (db) => {
      db.exec(SCHEMA_V18);
    },
  },
  {
    version: 19,
    name: "audio-refs-webm",
    // 重建表要先 DROP 旧的 audio_refs；speech_clips.audio_ref 指着它，外键开着就会「立即约束」失败（C酱 #137）
    disableForeignKeys: true,
    up: (db) => {
      db.exec(SCHEMA_V19);
      // 关外键期间重建，迁完自己验一遍：有坏数据就别放行
      const broken = db.prepare("PRAGMA foreign_key_check").all();
      if (broken.length > 0) throw new Error("v19 重建 audio_refs 之后有外键不一致：" + JSON.stringify(broken).slice(0, 500));
    },
  },
  {
    version: 20,
    name: "project-notes",
    up: (db) => {
      db.exec(SCHEMA_V20);
    },
  },
  {
    version: 21,
    name: "chat-windows",
    up: (db) => {
      db.exec(SCHEMA_V21);
    },
  },
];

/** 当前代码支持的最新 schema 版本 */
export const LATEST_SCHEMA_VERSION: number = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;

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

    // 外键开关必须在事务外，所以放在 BEGIN 之前；结束时无论如何都恢复
    if (migration.disableForeignKeys === true) db.pragma("foreign_keys = OFF");

    try {
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
    } finally {
      if (migration.disableForeignKeys === true) db.pragma("foreign_keys = ON");
    }
  }

  return applied;
}




