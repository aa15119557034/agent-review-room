import { assertTransition } from "@room/core";
import {
  MediaJob as MediaJobSchema,
  MEDIA_JOB_TRANSITIONS,
  type MediaJob,
  type MediaJobState,
} from "@room/schemas";
import type { SqliteDatabase } from "./database";

/**
 * 媒体任务的读写（C-42b / D-38a）。
 *
 * 和 Run 一样：每个任务恰好一个终态，状态只按 MEDIA_JOB_TRANSITIONS 往前走；
 * 数据库里有触发器，终态之后再 UPDATE 会被直接拦下。这里只做「行 ↔ 契约」和状态检查，
 * 队列、选路、ComfyUI 怎么跑是 main 的事。
 */

interface MediaJobRow {
  id: string;
  kind: string;
  state: string;
  authorization: string;
  source: string;
  intent_hash: string | null;
  draw: string | null;
  route: string | null;
  remote_run_id: string | null;
  result: string | null;
  speech: string | null;
  failure: string | null;
  cancel_reason: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

const parseJson = (value: string | null): unknown => (value === null ? null : JSON.parse(value));

const toJob = (row: MediaJobRow): MediaJob =>
  MediaJobSchema.parse({
    id: row.id,
    kind: row.kind,
    state: row.state,
    authorization: row.authorization,
    source: JSON.parse(row.source) as unknown,
    intentHash: row.intent_hash,
    draw: parseJson(row.draw),
    route: parseJson(row.route),
    remoteRunId: row.remote_run_id,
    result: parseJson(row.result),
    speech: parseJson(row.speech),
    failure: parseJson(row.failure),
    cancelReason: row.cancel_reason,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  });

export function insertMediaJob(db: SqliteDatabase, job: MediaJob): void {
  const parsed = MediaJobSchema.parse(job);
  db.prepare(
    "INSERT INTO media_jobs (id, kind, state, authorization, source, intent_hash, draw, route, remote_run_id, " +
      "result, speech, failure, cancel_reason, created_at, started_at, finished_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    parsed.id,
    parsed.kind,
    parsed.state,
    parsed.authorization,
    JSON.stringify(parsed.source),
    parsed.intentHash,
    parsed.draw === null ? null : JSON.stringify(parsed.draw),
    parsed.route === null ? null : JSON.stringify(parsed.route),
    parsed.remoteRunId,
    parsed.result === null ? null : JSON.stringify(parsed.result),
    parsed.speech === null ? null : JSON.stringify(parsed.speech),
    parsed.failure === null ? null : JSON.stringify(parsed.failure),
    parsed.cancelReason,
    parsed.createdAt,
    parsed.startedAt,
    parsed.finishedAt,
  );
}

export function getMediaJob(db: SqliteDatabase, id: string): MediaJob | null {
  const row = db.prepare("SELECT * FROM media_jobs WHERE id = ?").get(id) as MediaJobRow | undefined;
  return row === undefined ? null : toJob(row);
}

/** 「停」和列表用的范围：一个聊天会话，或一个议题 */
export type MediaJobScope =
  | { kind: "chat"; conversationId: string }
  | { kind: "topic"; projectId: string };

/**
 * 一个范围里的任务，按创建时间倒序，最多 limit（契约默认上限 200）。
 * C-42f 的「按消息查 + 每消息每类最多 7 条」在 main 里筛，这里只给范围。
 */
export function listMediaJobs(db: SqliteDatabase, scope: MediaJobScope, limit = 200): MediaJob[] {
  const rows = (
    scope.kind === "chat"
      ? db
          .prepare(
            "SELECT * FROM media_jobs WHERE json_extract(source, '$.kind') = 'chat' " +
              "AND json_extract(source, '$.conversationId') = ? ORDER BY created_at DESC, id DESC LIMIT ?",
          )
          .all(scope.conversationId, limit)
      : db
          .prepare(
            "SELECT * FROM media_jobs WHERE json_extract(source, '$.kind') = 'topic' " +
              "AND json_extract(source, '$.projectId') = ? ORDER BY created_at DESC, id DESC LIMIT ?",
          )
          .all(scope.projectId, limit)
  ) as MediaJobRow[];
  return rows.map(toJob);
}

/** 显卡队列用：排队中和正在跑的任务，老的在前（先来先跑） */
export function listActiveMediaJobs(db: SqliteDatabase): MediaJob[] {
  const rows = db
    .prepare("SELECT * FROM media_jobs WHERE state IN ('queued', 'running') ORDER BY created_at ASC, id ASC")
    .all() as MediaJobRow[];
  return rows.map(toJob);
}

export class MediaJobStateConflictError extends Error {
  constructor(
    readonly jobId: string,
    readonly from: MediaJobState,
    readonly actual: MediaJobState | null,
  ) {
    super(`媒体任务 ${jobId} 的状态已经变了（期望 ${from}，实际 ${actual ?? "不存在"}）`);
    this.name = "MediaJobStateConflictError";
  }
}

/** 终态之前才能改的字段 */
export type MediaJobPatch = Partial<
  Pick<MediaJob, "route" | "remoteRunId" | "result" | "speech" | "failure" | "cancelReason" | "startedAt" | "finishedAt">
>;

/**
 * 往前走一步。和 Run 的 transitionRun 一样：先核对调用方看到的状态，再按转换表走，最后带状态条件更新，
 * 并发下只会有一个成功（另一个拿到 0 行、抛冲突）。
 */
export function transitionMediaJob(
  db: SqliteDatabase,
  input: { id: string; from: MediaJobState; to: MediaJobState; now?: string } & { patch?: MediaJobPatch },
): MediaJob {
  const current = getMediaJob(db, input.id);
  if (current === null) throw new MediaJobStateConflictError(input.id, input.from, null);
  if (current.state !== input.from) throw new MediaJobStateConflictError(input.id, input.from, current.state);
  assertTransition(MEDIA_JOB_TRANSITIONS, "media job", input.from, input.to);

  const patch = input.patch ?? {};
  const next: MediaJob = {
    ...current,
    ...patch,
    state: input.to,
    ...(input.to === "running" && patch.startedAt === undefined && current.startedAt === null
      ? { startedAt: input.now ?? new Date().toISOString() }
      : {}),
  };
  // 终态一定要有结束时间（契约和表约束都这么要求）；调用方没给就补当前时间
  if (["succeeded", "failed", "cancelled", "timed_out"].includes(input.to) && next.finishedAt === null) {
    next.finishedAt = input.now ?? new Date().toISOString();
  }
  MediaJobSchema.parse(next);

  const result = db
    .prepare(
      "UPDATE media_jobs SET state = ?, route = ?, remote_run_id = ?, result = ?, speech = ?, failure = ?, " +
        "cancel_reason = ?, started_at = ?, finished_at = ? WHERE id = ? AND state = ?",
    )
    .run(
      next.state,
      next.route === null ? null : JSON.stringify(next.route),
      next.remoteRunId,
      next.result === null ? null : JSON.stringify(next.result),
      next.speech === null ? null : JSON.stringify(next.speech),
      next.failure === null ? null : JSON.stringify(next.failure),
      next.cancelReason,
      next.startedAt,
      next.finishedAt,
      next.id,
      input.from,
    );
  if (result.changes === 0) throw new MediaJobStateConflictError(input.id, input.from, getMediaJob(db, input.id)?.state ?? null);
  return getMediaJob(db, input.id) as MediaJob;
}

