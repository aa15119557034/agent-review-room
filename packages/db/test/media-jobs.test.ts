import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import Database from "better-sqlite3";
import {
  currentVersion,
  getMediaJob,
  insertMediaJob,
  LATEST_SCHEMA_VERSION,
  listActiveMediaJobs,
  listMediaJobs,
  MediaJobStateConflictError,
  openDatabase,
  transitionMediaJob,
} from "../src/index";
import type { MediaJob } from "@room/schemas";
import { SCHEMA_V1, SCHEMA_V2 } from "../src/schema";
import { SCHEMA_V3, SCHEMA_V3_REBUILD } from "../src/schema-v3";
import { SCHEMA_V4 } from "../src/schema-v4";
import { SCHEMA_V5 } from "../src/schema-v5";
import { SCHEMA_V6 } from "../src/schema-v6";
import { SCHEMA_V7 } from "../src/schema-v7";
import { SCHEMA_V8 } from "../src/schema-v8";
import { SCHEMA_V9 } from "../src/schema-v9";
import { SCHEMA_V10 } from "../src/schema-v10";

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // Windows 上句柄释放有延迟
    }
  }
});

function tempFile(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return join(dir, "room.db");
}

const T = "2026-10-27T00:00:00.000Z";
const AT = (s: number) => new Date(Date.UTC(2026, 9, 27, 0, 0, s)).toISOString();
const ID = "01JAAAAAAAAAAAAAAAAAAAAAAA";
const ID_B = "01JBBBBBBBBBBBBBBBBBBBBBBB";
const ID_C = "01JCCCCCCCCCCCCCCCCCCCCCCC";

const job = (patch: Partial<MediaJob> = {}): MediaJob => ({
  id: `mjob_${ID}`,
  kind: "draw",
  state: "queued",
  authorization: "user_tap",
  source: { kind: "chat", conversationId: `conv_${ID}`, messageId: `cmsg_${ID}`, agent: "deepseek" },
  intentHash: null,
  draw: { prompt: "小鲸鱼", size: "1024x1024", backend: "comfyui" },
  route: null,
  remoteRunId: null,
  result: null,
  speech: null,
  failure: null,
  cancelReason: null,
  createdAt: T,
  startedAt: null,
  finishedAt: null,
  ...patch,
});

describe("migration v11 (media jobs)", () => {
  it("adds media_jobs on a v10 database without touching old data", () => {
    const file = tempFile("room-v11-");
    const raw = new Database(file);
    raw.pragma("foreign_keys = OFF");
    raw.exec(SCHEMA_V1);
    raw.exec(SCHEMA_V2);
    raw.exec(SCHEMA_V3);
    raw.exec(SCHEMA_V3_REBUILD);
    raw.exec(SCHEMA_V4);
    raw.exec(SCHEMA_V5);
    raw.exec(SCHEMA_V6);
    raw.exec(SCHEMA_V7);
    raw.exec(SCHEMA_V8);
    raw.exec(SCHEMA_V9);
    raw.exec(SCHEMA_V10);
    raw.pragma("user_version = 10");

    raw
      .prepare(
        "INSERT INTO conversations (id, kind, direct_agent, title, pinned, muted, last_read_message_id, last_activity_at, created_at) " +
          "VALUES ('conv_old', 'direct', 'deepseek', NULL, 0, 0, NULL, ?, ?)",
      )
      .run(T, T);
    raw
      .prepare(
        "INSERT INTO chat_messages (id, conversation_id, sender, created_at, content, mentions, state) " +
          "VALUES ('cmsg_old', 'conv_old', 'user', ?, ?, ?, 'sent')",
      )
      .run(T, JSON.stringify({ kind: "text", text: "旧消息", attachments: [] }), JSON.stringify({ kind: "none" }));
    raw.close();

    const db = openDatabase(file);
    try {
      assert.equal(currentVersion(db), LATEST_SCHEMA_VERSION);
      assert.ok(LATEST_SCHEMA_VERSION >= 11);
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(
        (r) => r.name,
      );
      assert.ok(tables.includes("media_jobs"));
      assert.equal((db.prepare("SELECT count(*) AS n FROM chat_messages").get() as { n: number }).n, 1);
      assert.deepEqual(db.pragma("foreign_key_check"), []);
    } finally {
      db.close();
    }
    assert.ok(existsSync(file + ".bak-v10"), "migration backup must exist");
  });
});

describe("media jobs (C-42b)", () => {
  const fresh = () => openDatabase(tempFile("room-media-jobs-"));

  it("stores and reads a draw job; states move only forward and terminal jobs are final", () => {
    const db = fresh();
    try {
      insertMediaJob(db, job());
      assert.deepEqual(getMediaJob(db, `mjob_${ID}`), job());

      const running = transitionMediaJob(db, { id: `mjob_${ID}`, from: "queued", to: "running", now: AT(1) });
      assert.equal(running.state, "running");
      assert.equal(running.startedAt, AT(1));

      const done = transitionMediaJob(db, {
        id: `mjob_${ID}`,
        from: "running",
        to: "succeeded",
        now: AT(2),
        patch: {
          route: { backend: "comfyui", manual: false, confirmedOverThreshold: false, fallbackReason: null, quotaBefore: null, quotaAfter: null },
          result: {
            ref: `img_${ID}`,
            sha256: "a".repeat(64),
            backend: "comfyui",
            model: null,
            prompt: "小鲸鱼",
            size: "1024x1024",
            seed: 7,
            workflowHash: "b".repeat(64),
          },
        },
      });
      assert.equal(done.state, "succeeded");
      assert.equal(done.finishedAt, AT(2));
      assert.equal(done.result?.ref, `img_${ID}`);

      // 终态之后不能再往前走
      assert.throws(
        () => transitionMediaJob(db, { id: `mjob_${ID}`, from: "succeeded", to: "running" }),
        (e: unknown) => e instanceof Error,
      );
      // 用旧状态再来一次：冲突，不是覆盖
      assert.throws(
        () => transitionMediaJob(db, { id: `mjob_${ID}`, from: "running", to: "failed" }),
        MediaJobStateConflictError,
      );
      // 触发器兜底：终态之后 UPDATE 直接被数据库拒
      assert.throws(
        () => db.prepare("UPDATE media_jobs SET remote_run_id = 'x' WHERE id = ?").run(`mjob_${ID}`),
        /final/,
      );
    } finally {
      db.close();
    }
  });

  it("fails a queued job with a failure reason, cancels with a cancel reason", () => {
    const db = fresh();
    try {
      insertMediaJob(db, job());
      const failed = transitionMediaJob(db, {
        id: `mjob_${ID}`,
        from: "queued",
        to: "failed",
        now: AT(1),
        patch: { failure: { reason: "backend_unavailable", message: "ComfyUI 没开" } },
      });
      assert.equal(failed.failure?.reason, "backend_unavailable");

      insertMediaJob(db, job({ id: `mjob_${ID_B}`, createdAt: T }));
      const cancelled = transitionMediaJob(db, {
        id: `mjob_${ID_B}`,
        from: "queued",
        to: "cancelled",
        now: AT(2),
        patch: { cancelReason: "user_stop" },
      });
      assert.equal(cancelled.cancelReason, "user_stop");
      assert.equal(cancelled.finishedAt, AT(2));

      // 状态和原因对不上时契约直接拒（MediaJob 的 refine）
      assert.throws(() =>
        insertMediaJob(db, job({ id: `mjob_${ID_C}`, state: "failed", failure: null })),
      );
    } finally {
      db.close();
    }
  });

  it("lists by scope and the queue sees queued + running in creation order", () => {
    const db = fresh();
    try {
      insertMediaJob(db, job({ id: `mjob_${ID}`, createdAt: AT(0) }));
      insertMediaJob(db, job({ id: `mjob_${ID_B}`, createdAt: AT(1), state: "queued" }));
      insertMediaJob(
        db,
        job({
          id: `mjob_${ID_C}`,
          createdAt: AT(2),
          source: { kind: "topic", projectId: `proj_${ID}`, messageId: `msg_${ID}`, agent: "deepseek" },
        }),
      );
      transitionMediaJob(db, { id: `mjob_${ID}`, from: "queued", to: "running", now: AT(3) });

      const chatJobs = listMediaJobs(db, { kind: "chat", conversationId: `conv_${ID}` });
      assert.deepEqual(
        chatJobs.map((j) => j.id),
        [`mjob_${ID_B}`, `mjob_${ID}`],
      );
      const topicJobs = listMediaJobs(db, { kind: "topic", projectId: `proj_${ID}` });
      assert.deepEqual(topicJobs.map((j) => j.id), [`mjob_${ID_C}`]);

      const active = listActiveMediaJobs(db);
      assert.deepEqual(
        active.map((j) => j.id),
        [`mjob_${ID}`, `mjob_${ID_B}`, `mjob_${ID_C}`],
        "显卡队列是全局的（聊天和议题共用），老的在前；终态任务不在队列里",
      );
      assert.equal(listMediaJobs(db, { kind: "chat", conversationId: `conv_${ID}` }, 1).length, 1);
    } finally {
      db.close();
    }
  });
});

