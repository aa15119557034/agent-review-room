import {
  getChatMessage,
  getMediaJob,
  insertMediaJob,
  listActiveMediaJobs,
  listMediaJobs,
  listMediaJobsForMessages,
  transitionMediaJob,
  MediaJobStateConflictError,
  ulid,
  writeTransaction,
  type SqliteDatabase,
  type WriteQueue,
} from "@room/db";
import {
  IMMERSIVE_LIMITS,
  MediaJob as MediaJobSchema,
  pickMessageMediaJobs,
  type ControlEvent,
  type DrawRequest,
  type DrawRoutePreview,
  type MediaFailureReason,
  type MediaJob,
  type MediaScope,
  type MediaSource,
} from "@room/schemas";
import { ChatError } from "./chat";
import type { ComfyUiClient } from "./comfyui";
import { ComfyUiError } from "./comfyui";
import { ImageRejectedError, type MediaStore } from "./media-store";

/**
 * 媒体任务（画图）的编排（D-38a，契约 C-42b / ADR-004 §3）。
 *
 * - 全局一条队列，并发 1：画图（以后的语音合成）都排在这一条上；老的先跑
 * - 排队超过 gpuQueueTimeoutMs 还没开始 → failed(gpu_queue_timeout)（ADR 的「显卡排队超时」，界面据此退回请求卡）
 * - 开始以后：本机 ComfyUI 画 → 图存进图片库（generated）→ succeeded；画不出来按原因 failed
 * - 取消 / 「停」：排队中的直接取消；正在跑的先在本地标取消、再让 ComfyUI 打断，迟到的结果丢掉
 * - 每次状态变化都推 media.updated；任务本身不可变的部分由 db 层的转换函数保证（恰好一个终态）
 *
 * 这一段只有本机 ComfyUI；「先林离、85% 换本机」的选路是 D-38b。
 */

export interface MediaJobsDeps {
  db: SqliteDatabase;
  queue: WriteQueue;
  store: MediaStore;
  emit: (event: ControlEvent) => void;
  /** 当前可用的 ComfyUI 客户端；没配置 / 连不上返回 null */
  comfy: () => ComfyUiClient | null;
  now: () => string;
  /** 每张图的种子（测试注入固定值） */
  seed?: () => number;
}

const QUEUE_TIMEOUT_MS = IMMERSIVE_LIMITS.gpuQueueTimeoutMs;

export class MediaJobsService {
  #pumping = false;
  /** 正在跑的任务 → 本次运行的 AbortController（取消时用） */
  readonly #running = new Map<string, AbortController>();

  constructor(private readonly deps: MediaJobsDeps) {}

  /** 请求卡打开时预览：这一段只有本机，能连上 ComfyUI 就是 comfyui，否则 backend=null */
  async preview(_request: DrawRequest): Promise<DrawRoutePreview> {
    const client = this.deps.comfy();
    const available = client !== null && (await client.isUp());
    return {
      backend: available ? "comfyui" : null,
      fallbackReason: null,
      quota: null,
      // 林离还没接（D-38b）：现在不能选
      codexManual: "blocked",
      comfyuiAvailable: available,
    };
  }

  /**
   * 你点了「画」（authorization = user_tap）。
   * - 只支持本机：backend=codex 现在明确拒绝（D-38b）；auto 等同本机
   * - 同一个 source + 同样的 draw 已经有没结束的任务：返回那个，不重复建
   * - source 以存下来的消息为准：消息不存在 / 不在这个会话 / agent 对不上 → validation_failed
   */
  async start(request: DrawRequest, source: MediaSource, confirmedOverThreshold: boolean): Promise<MediaJob> {
    if (request.backend === "codex") {
      throw new ChatError("validation_failed", "林离画图还没上线（D-38b），现在只能用本机");
    }
    const now = this.deps.now();
    const message = this.#assertSource(source);
    const active = listActiveMediaJobs(this.deps.db).find(
      (job) =>
        job.kind === "draw" &&
        sameSource(job.source, source) &&
        JSON.stringify(job.draw) === JSON.stringify(request),
    );
    if (active !== undefined) return active;

    const job: MediaJob = MediaJobSchema.parse({
      id: `mjob_${ulid()}`,
      kind: "draw",
      state: "queued",
      authorization: "user_tap",
      source,
      intentHash: null,
      draw: { ...request, backend: request.backend === "auto" ? "auto" : "comfyui" },
      route: null,
      remoteRunId: null,
      result: null,
      speech: null,
      failure: null,
      cancelReason: null,
      createdAt: now,
      startedAt: null,
      finishedAt: null,
    });
    void message;
    void confirmedOverThreshold; // D-38b 才需要（手动选林离的二次确认）
    await writeTransaction(this.deps.db, this.deps.queue, () => insertMediaJob(this.deps.db, job));
    this.#emit(job);
    this.#pump();
    return job;
  }

  async cancel(jobId: string): Promise<MediaJob> {
    const job = getMediaJob(this.deps.db, jobId);
    if (job === null) throw new ChatError("not_found", "任务不存在");
    if (job.state !== "queued" && job.state !== "running") throw new ChatError("invalid_state", "这个任务已经结束了");
    const controller = this.#running.get(jobId);
    controller?.abort();
    if (job.state === "running") void this.deps.comfy()?.interrupt();
    return this.#transition(jobId, job.state, "cancelled", { cancelReason: "user_cancel" });
  }

  /** 会话 / 议题的「停」：取消这个范围里所有排队和正在跑的任务（cancelReason = user_stop） */
  async stop(scope: MediaScope): Promise<MediaJob[]> {
    const active = listActiveMediaJobs(this.deps.db).filter((job) => inScope(job, scope));
    const cancelled: MediaJob[] = [];
    for (const job of active) {
      try {
        if (job.state === "running") void this.deps.comfy()?.interrupt();
        this.#running.get(job.id)?.abort();
        cancelled.push(await this.#transition(job.id, job.state, "cancelled", { cancelReason: "user_stop" }));
      } catch (error) {
        // 刚好自己结束了：跳过，不因为一个任务失败停掉整次「停」
        if (!(error instanceof MediaJobStateConflictError) && !(error instanceof ChatError)) throw error;
      }
    }
    return cancelled;
  }

  list(scope: MediaScope, messageIds?: readonly string[]): MediaJob[] {
    if (scope.kind === "chat" && messageIds !== undefined) {
      // C-42f：这些消息的全部任务先取出来，再按「每消息每类：最新 5 + 最新成功 + 最新进行中」挑，最后整体倒序
      const all = listMediaJobsForMessages(this.deps.db, scope.conversationId, messageIds);
      return pickMessageMediaJobs(all)
        .sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1))
        .slice(0, 200);
    }
    return listMediaJobs(this.deps.db, scope, 200);
  }

  get(jobId: string): MediaJob {
    const job = getMediaJob(this.deps.db, jobId);
    if (job === null) throw new ChatError("not_found", "任务不存在");
    return job;
  }

  // ---------------------------------------------------------------- 队列

  #pump(): void {
    if (this.#pumping) return;
    this.#pumping = true;
    void this.#drain().finally(() => {
      this.#pumping = false;
    });
  }

  async #drain(): Promise<void> {
    for (;;) {
      const queued = listActiveMediaJobs(this.deps.db).filter((job) => job.state === "queued");
      const next = queued[0];
      if (next === undefined) return;
      const waited = Date.parse(this.deps.now()) - Date.parse(next.createdAt);
      if (waited > QUEUE_TIMEOUT_MS) {
        await this.#fail(next, "gpu_queue_timeout", "显卡排队超过 2 分钟");
        continue;
      }
      await this.#run(next);
    }
  }

  async #run(job: MediaJob): Promise<void> {
    const controller = new AbortController();
    this.#running.set(job.id, controller);
    try {
      await this.#transition(job.id, "queued", "running", {});
      const client = this.deps.comfy();
      if (client === null || !(await client.isUp())) {
        await this.#fail(job, "backend_unavailable", "本机 ComfyUI 没开");
        return;
      }
      const draw = job.draw;
      if (draw === null) {
        await this.#fail(job, "internal", "画图任务没有请求");
        return;
      }
      const seed = this.deps.seed?.() ?? Math.trunc(Math.random() * 0xffff_ffff);
      let result;
      try {
        result = await client.draw({ prompt: draw.prompt, size: draw.size, seed });
      } catch (error) {
        if (controller.signal.aborted) return; // 已经被取消并收尾了
        if (error instanceof ComfyUiError) {
          if (error.code === "timeout") {
            await this.#transition(job.id, "running", "timed_out", {}).catch(ignoreConflict);
            return;
          }
          if (error.code === "unavailable") {
            await this.#fail(job, "backend_unavailable", error.message);
            return;
          }
          await this.#fail(job, "generation_failed", error.message);
          return;
        }
        await this.#fail(job, "internal", error instanceof Error ? error.message : String(error));
        return;
      }
      if (controller.signal.aborted) return;
      let image;
      try {
        image = await this.deps.store.addGeneratedImage(result.image, this.deps.now());
      } catch (error) {
        if (error instanceof ImageRejectedError) {
          await this.#fail(job, "artifact_invalid", error.message);
          return;
        }
        throw error;
      }
      try {
        await this.#transition(job.id, "running", "succeeded", {
          route: {
            backend: "comfyui",
            manual: false,
            confirmedOverThreshold: false,
            fallbackReason: null,
            quotaBefore: null,
            quotaAfter: null,
          },
          result: {
            ref: image.ref,
            sha256: image.sha256,
            backend: "comfyui",
            model: result.model,
            prompt: draw.prompt,
            size: draw.size,
            seed: result.seed,
            workflowHash: null,
          },
        });
      } catch (error) {
        if (error instanceof MediaJobStateConflictError) return; // 取消抢先了
        throw error;
      }
    } finally {
      this.#running.delete(job.id);
    }
  }

  async #fail(job: MediaJob, reason: MediaFailureReason, message: string): Promise<void> {
    const state = getMediaJob(this.deps.db, job.id)?.state;
    if (state !== "running" && state !== "queued") return;
    await this.#transition(job.id, state, "failed", { failure: { reason, message } }).catch(ignoreConflict);
  }

  async #transition(
    jobId: string,
    from: MediaJob["state"],
    to: MediaJob["state"],
    patch: {
      route?: MediaJob["route"];
      result?: MediaJob["result"];
      failure?: MediaJob["failure"];
      cancelReason?: MediaJob["cancelReason"];
      startedAt?: string;
      finishedAt?: string;
    },
  ): Promise<MediaJob> {
    const next = await writeTransaction(this.deps.db, this.deps.queue, () =>
      transitionMediaJob(this.deps.db, { id: jobId, from, to, now: this.deps.now(), patch }),
    );
    this.#emit(next);
    return next;
  }

  #emit(job: MediaJob): void {
    this.deps.emit({ type: "media.updated", job });
  }

  /** source 以库里的消息为准；不一致就 validation_failed（渲染层只能拿到 id） */
  #assertSource(source: MediaSource): void {
    if (source.kind !== "chat") throw new ChatError("validation_failed", "现在只支持从聊天里发起画图");
    const message = getChatMessage(this.deps.db, source.messageId);
    if (message === null || message.conversationId !== source.conversationId) {
      throw new ChatError("validation_failed", "这条消息不在这个会话里");
    }
    if (message.sender === "agent" && source.agent !== message.agent) {
      throw new ChatError("validation_failed", "消息的作者对不上");
    }
    if (message.sender === "user" && source.agent !== null) {
      throw new ChatError("validation_failed", "你自己发的消息，agent 应该是 null");
    }
  }
}

const inScope = (job: MediaJob, scope: MediaScope): boolean =>
  scope.kind === "chat"
    ? job.source.kind === "chat" && job.source.conversationId === scope.conversationId
    : job.source.kind === "topic" && job.source.projectId === scope.projectId;

const sameSource = (a: MediaSource, b: MediaSource): boolean => JSON.stringify(a) === JSON.stringify(b);

const ignoreConflict = (error: unknown): void => {
  if (!(error instanceof MediaJobStateConflictError)) throw error;
};

