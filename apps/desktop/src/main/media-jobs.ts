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
  /** 取消原因：cancel / stop 先记下，等 #run 收尾时用（谁先到都不丢） */
  readonly #cancelIntent = new Map<string, MediaJob["cancelReason"]>();

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
    this.#cancelIntent.set(jobId, "user_cancel");
    this.#running.get(jobId)?.abort();
    if (job.state === "running") void this.deps.comfy()?.cancelActive();
    // 读到 queued 时 #run 可能刚好把它写成 running（写队列里 running 在前）：冲突就按最新状态再来一次
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = getMediaJob(this.deps.db, jobId);
      if (current === null) throw new ChatError("not_found", "任务不存在");
      if (current.state !== "queued" && current.state !== "running") {
        this.#cancelIntent.delete(jobId);
        throw new ChatError("invalid_state", "这个任务已经结束了");
      }
      try {
        const cancelled = await this.#transition(jobId, current.state, "cancelled", { cancelReason: "user_cancel" });
        this.#cancelIntent.delete(jobId);
        return cancelled;
      } catch (error) {
        if (!(error instanceof MediaJobStateConflictError)) throw error;
      }
    }
    throw new ChatError("invalid_state", "这个任务已经结束了");
  }

  /** 会话 / 议题的「停」：取消这个范围里所有排队和正在跑的任务（cancelReason = user_stop） */
  async stop(scope: MediaScope): Promise<MediaJob[]> {
    return this.#cancelAll(listActiveMediaJobs(this.deps.db).filter((job) => inScope(job, scope)), "user_stop");
  }

  /**
   * 消息被撤回（ADR-004 §3a）：取消从这条消息、以及它下面回答发起的排队/在跑任务。
   * 原因记 message_withdrawn，界面据此把请求卡收回。
   */
  async cancelBySourceMessageIds(messageIds: readonly string[]): Promise<MediaJob[]> {
    const set = new Set(messageIds);
    if (set.size === 0) return [];
    const affected = listActiveMediaJobs(this.deps.db).filter(
      (job) => job.source.kind === "chat" && set.has(job.source.messageId),
    );
    return this.#cancelAll(affected, "message_withdrawn");
  }

  /** 批量取消：先记原因、abort、让 ComfyUI 停，再按最新状态重试转换（冲突不算失败） */
  async #cancelAll(jobs: readonly MediaJob[], reason: MediaJob["cancelReason"]): Promise<MediaJob[]> {
    const cancelled: MediaJob[] = [];
    for (const job of jobs) {
      this.#cancelIntent.set(job.id, reason);
      this.#running.get(job.id)?.abort();
      if (job.state === "running") void this.deps.comfy()?.cancelActive();
      // 和 cancel 一样：冲突就按最新状态重试，别把「刚开跑」当成失败
      for (let attempt = 0; attempt < 3; attempt++) {
        const current = getMediaJob(this.deps.db, job.id);
        if (current === null || (current.state !== "queued" && current.state !== "running")) {
          this.#cancelIntent.delete(job.id);
          break;
        }
        try {
          cancelled.push(await this.#transition(job.id, current.state, "cancelled", { cancelReason: reason }));
          this.#cancelIntent.delete(job.id);
          break;
        } catch (error) {
          if (!(error instanceof MediaJobStateConflictError)) throw error;
        }
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

  /** 队列是否还有事在做（诊断 / 测试用：等它空下来再关数据库） */
  busy(): boolean {
    return this.#pumping;
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
        await this.#fail(next, "gpu_queue_timeout", "显卡排队超过 2 分钟").catch(ignoreConflict);
        continue;
      }
      // 一个任务出任何意外都不能让整条队列停下来：记成 failed(internal)，接着跑下一个
      try {
        await this.#run(next);
      } catch (error) {
        if (!(error instanceof MediaJobStateConflictError)) {
          await this.#fail(next, "internal", error instanceof Error ? error.message : String(error)).catch(ignoreConflict);
        }
      }
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
        result = await client.draw({ prompt: draw.prompt, size: draw.size, seed }, { signal: controller.signal });
      } catch (error) {
        if (controller.signal.aborted) {
          await this.#settleCancelled(job.id);
          return;
        }
        if (error instanceof ComfyUiError) {
          if (error.code === "cancelled") {
            await this.#settleCancelled(job.id);
            return;
          }
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
      if (controller.signal.aborted) {
        await this.#settleCancelled(job.id);
        return;
      }
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
        await this.#commitSuccess(job, {
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
            workflowHash: result.workflowHash,
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

  /**
   * 结果落库：和「来源消息是否已撤回」的检查放在**同一个事务**里（林离 #129）。
   * 撤回提交和取消回调之间回图的窗口，靠这里挡住——不会再落成 succeeded。
   */
  async #commitSuccess(
    job: MediaJob,
    patch: { route?: MediaJob["route"]; result?: MediaJob["result"] },
  ): Promise<void> {
    const applied = await writeTransaction(this.deps.db, this.deps.queue, () => {
      if (this.#sourceWithdrawn(job)) {
        return transitionMediaJob(this.deps.db, {
          id: job.id,
          from: "running",
          to: "cancelled",
          now: this.deps.now(),
          patch: { cancelReason: "message_withdrawn" },
        });
      }
      return transitionMediaJob(this.deps.db, { id: job.id, from: "running", to: "succeeded", now: this.deps.now(), patch });
    });
    this.#emit(applied);
  }

  /** 来源消息（回答的话，还有它回答的那条）是不是已经撤回（ADR-004 §3a） */
  #sourceWithdrawn(job: MediaJob): boolean {
    if (job.source.kind !== "chat") return false;
    const message = getChatMessage(this.deps.db, job.source.messageId);
    if (message === null) return false;
    if ("state" in message && message.state === "retracted") return true;
    if (message.sender === "agent") {
      const parent = getChatMessage(this.deps.db, message.inReplyTo);
      if (parent !== null && "state" in parent && parent.state !== "sent") return true;
    }
    return false;
  }

  /**
   * 取消之后收尾：只要还在 queued / running 就转成 cancelled（原因记在 #cancelIntent）。
   * 取消和 #run 谁先到都行，另一方看到冲突就跳过——任务一定会落到终态（C酱 #123）。
   */
  async #settleCancelled(jobId: string): Promise<void> {
    const current = getMediaJob(this.deps.db, jobId);
    if (current === null) return;
    if (current.state !== "queued" && current.state !== "running") {
      this.#cancelIntent.delete(jobId);
      return;
    }
    await this.#transition(jobId, current.state, "cancelled", {
      cancelReason: this.#cancelIntent.get(jobId) ?? "user_cancel",
    }).catch(ignoreConflict);
    this.#cancelIntent.delete(jobId);
  }

  /**
   * 启动时收尾：上一次崩掉 / 被强杀留下的 queued / running 一律记成 cancelled(app_restart)
   * （契约 media.ts：「不留『生成中』」）。每条都会推一次 media.updated。
   */
  async repairInterrupted(): Promise<number> {
    let repaired = 0;
    for (const job of listActiveMediaJobs(this.deps.db)) {
      try {
        await this.#transition(job.id, job.state, "cancelled", { cancelReason: "app_restart" });
        this.#cancelIntent.delete(job.id);
        repaired += 1;
      } catch (error) {
        if (!(error instanceof MediaJobStateConflictError)) throw error;
      }
    }
    return repaired;
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
    // 撤回的消息不画（和 cancelReason = message_withdrawn 的语义对上，C酱 #123）
    if ("state" in message && message.state !== "sent") {
      throw new ChatError("validation_failed", "这条消息已经撤回了，不能再画");
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
