import {
  findSpeechClip,
  getChatMessage,
  getMediaJob,
  insertMediaJob,
  insertSpeechClip,
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
  SPEAK_MAX_CHARS,
  speakableText,
  type ControlEvent,
  type DrawRequest,
  type DrawRoutePreview,
  type MediaFailureReason,
  type MediaJob,
  type MediaScope,
  type MediaSource,
  type SpeechClip,
  type VoiceProfile,
} from "@room/schemas";
import { sha256Hex } from "@room/core";
import { ChatError } from "./chat";
import type { ComfyUiClient } from "./comfyui";
import { ComfyUiError } from "./comfyui";
import { ImageRejectedError, type MediaStore } from "./media-store";
import type { TtsRunner, TtsVoiceConfig } from "./tts";
import { TtsFailedError, TtsUnavailableError } from "./tts";

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
  /** D-37b：语音合成的独立进程；没配置返回 null（播放显示「还没配好声音」） */
  tts?: () => TtsRunner | null;
  /** D-37b：按 agent id 取人设（拿声音设置）；不传 = 不支持语音 */
  agentOf?: (agentId: string) => { voice?: VoiceProfile | null } | null;
  now: () => string;
  /** 每张图的种子（测试注入固定值） */
  seed?: () => number;
}

/** 一次语音合成请求（在队列里等的时候先记着：MediaJob 本身不存文本） */
interface PendingSpeech {
  text: string;
  textHash: string;
  voice: TtsVoiceConfig;
  speed: number;
}

const QUEUE_TIMEOUT_MS = IMMERSIVE_LIMITS.gpuQueueTimeoutMs;

export class MediaJobsService {
  #pumping = false;
  /** 正在跑的任务 → 本次运行的 AbortController（取消时用） */
  readonly #running = new Map<string, AbortController>();
  /** 取消原因：cancel / stop 先记下，等 #run 收尾时用（谁先到都不丢） */
  readonly #cancelIntent = new Map<string, MediaJob["cancelReason"]>();
  /** D-37b：等着的语音请求（jobId → 文本 / 声音 / 语速）。重启就丢，遗留任务本来也会被记成 cancelled(app_restart) */
  readonly #speech = new Map<string, PendingSpeech>();

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

  /**
   * D-37b：你点了「播放」（authorization = user_play）。
   *
   * - source 以库里的回答为准：必须是秘书的回答，作者和 source.agent 对不上 / 已撤回 → validation_failed
   * - 朗读文本只用契约的 `speakableText`；过滤后为空或超过 SPEAK_MAX_CHARS 不合成
   * - 秘书没选声音（AgentProfile.voice 为空）→ validation_failed「还没选声音」
   * - 缓存命中（同一段文本 + 声音 + 语速 + 引擎 + 版本）直接返回片段；否则建一个语音任务排队
   */
  async play(
    source: MediaSource,
    options: { authorization?: "user_play" | "reply_as_voice" } = {},
  ): Promise<{ cached: true; clip: SpeechClip } | { cached: false; job: MediaJob }> {
    const authorization = options.authorization ?? "user_play";
    if (source.kind !== "chat") throw new ChatError("validation_failed", "现在只支持播放聊天里的回答");
    const runner = this.deps.tts?.() ?? null;
    if (runner === null || !runner.available()) {
      throw new ChatError("validation_failed", "语音合成还没配好（userData/tts.json），先别播放");
    }
    const message = getChatMessage(this.deps.db, source.messageId);
    if (message === null || message.conversationId !== source.conversationId) {
      throw new ChatError("validation_failed", "这条消息不在这个会话里");
    }
    if (message.sender !== "agent") throw new ChatError("validation_failed", "只能播放秘书的回答");
    if (source.agent !== null && source.agent !== message.agent) throw new ChatError("validation_failed", "消息的作者对不上");
    if (this.#sourceWithdrawn({ source })) {
      throw new ChatError("validation_failed", "这条消息已经撤回了，不能再播放");
    }

    const agent = this.deps.agentOf?.(message.agent) ?? null;
    const voice = agent?.voice ?? null;
    if (voice === null || voice === undefined) throw new ChatError("validation_failed", "这位秘书还没选声音");
    const profile = runner.voice(voice.voiceId);
    if (profile === null) throw new ChatError("validation_failed", "选的声音不在配置里（userData/tts.json）");

    const text = speakableText(message.text);
    if (text.length === 0) throw new ChatError("validation_failed", "这条回答没有能朗读的文字");
    if (text.length > SPEAK_MAX_CHARS) throw new ChatError("validation_failed", "这条回答太长，不适合朗读");

    const textHash = sha256Hex(text);
    const key = {
      textHash,
      voiceId: voice.voiceId,
      speed: voice.speed,
      engine: runner.engine,
      engineVersion: runner.engineVersion,
    } as const;
    const cached = findSpeechClip(this.deps.db, key);
    // 手动播放：命中缓存直接给片段；「用语音回」自动合成时仍要建任务（界面按任务显示这条回答有没有语音），
    // 只是命中缓存的任务会立刻成功，不再调引擎
    if (cached !== null && authorization === "user_play") return { cached: true, clip: cached };

    const pending = this.#speech;
    const active = listActiveMediaJobs(this.deps.db).find((job) => {
      // 同一来源 + 同一段文本 / 声音 / 语速：不管是哪个授权建的，都算同一个（C酱 #152 必须改 1）
      if (job.kind !== "speech" || !sameSource(job.source, source)) return false;
      const request = pending.get(job.id);
      return request?.textHash === textHash && request.voice.id === voice.voiceId && request.speed === voice.speed;
    });
    if (active !== undefined) return { cached: false, job: active };

    const now = this.deps.now();
    const job: MediaJob = MediaJobSchema.parse({
      id: `mjob_${ulid()}`,
      kind: "speech",
      state: "queued",
      authorization,
      source,
      intentHash: null,
      draw: null,
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
    this.#speech.set(job.id, { text, textHash, voice: profile, speed: voice.speed });
    await writeTransaction(this.deps.db, this.deps.queue, () => insertMediaJob(this.deps.db, job));
    this.#emit(job);
    // 命中缓存（只有「用语音回」会走到这里）：任务立刻成功，不调引擎
    if (cached !== null) {
      await this.#transition(job.id, "queued", "running", {});
      await this.#commitSpeech(job, cached, { insert: false });
      return { cached: false, job: getMediaJob(this.deps.db, job.id) ?? job };
    }
    this.#pump();
    return { cached: false, job };
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
      if (job.kind === "speech") {
        await this.#runSpeech(job, controller);
        return;
      }
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
      // 撤回已经落库：图还没存就别存了（林离 #129：撤回后返回的图不能进图片库）
      if (this.#sourceWithdrawn(job)) {
        this.#cancelIntent.set(job.id, "message_withdrawn");
        await this.#settleCancelled(job.id);
        return;
      }
      let saved;
      try {
        saved = await this.deps.store.addGeneratedImageDetailed(result.image, this.deps.now());
      } catch (error) {
        if (error instanceof ImageRejectedError) {
          await this.#fail(job, "artifact_invalid", error.message);
          return;
        }
        throw error;
      }
      const image = saved.record;
      try {
        const committed = await this.#commitSuccess(job, {
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
        // 存图之后、落库之前这段时间被撤回了：把这次新建的引用和字节清掉（共享的图不能动）
        if (!committed) {
          if (saved.created) this.deps.store.deleteImage(image.ref);
          return;
        }
      } catch (error) {
        if (!(error instanceof MediaJobStateConflictError)) throw error;
        if (saved.created) this.deps.store.deleteImage(image.ref);
        return;
      }
    } finally {
      this.#running.delete(job.id);
    }
  }

  /**
   * 跑一个语音任务（D-37b）：串行调独立进程 → 字节存进 MediaStore → 片段落库（缓存索引）→ succeeded。
   * 失败分类：引擎起不来 / 没配置 → backend_unavailable；引擎报错、超时 → generation_failed；
   * 被取消 → cancelled（原因在 #cancelIntent）；来源消息已撤回 → cancelled(message_withdrawn)，和画图一致。
   */
  async #runSpeech(job: MediaJob, controller: AbortController): Promise<void> {
    try {
      const request = this.#speech.get(job.id);
      if (request === undefined) {
        await this.#fail(job, "internal", "语音请求丢了（应用重启过？）");
        return;
      }
      const runner = this.deps.tts?.() ?? null;
      if (runner === null || !runner.available()) {
        await this.#fail(job, "backend_unavailable", "语音合成还没配好（userData/tts.json）");
        return;
      }
      if (this.#sourceWithdrawn(job)) {
        await this.#settleCancelled(job.id);
        return;
      }
      // C酱 #152 必须改 1：排队期间可能已经有人把同一段合成好了（自动任务和手动播放撞在一起），
      // 命中缓存就不再调引擎，也不会去撞 speech_clips 的唯一索引
      const already = findSpeechClip(this.deps.db, {
        textHash: request.textHash,
        voiceId: request.voice.id,
        speed: request.speed,
        engine: runner.engine,
        engineVersion: runner.engineVersion,
      });
      if (already !== null) {
        await this.#commitSpeech(job, already, { insert: false });
        return;
      }
      let synth;
      try {
        synth = await runner.synthesize({
          text: request.text,
          voice: request.voice,
          speed: request.speed,
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted) {
          await this.#settleCancelled(job.id);
          return;
        }
        if (error instanceof TtsUnavailableError) {
          await this.#fail(job, "backend_unavailable", error.message);
          return;
        }
        if (error instanceof TtsFailedError) {
          await this.#fail(job, "generation_failed", error.message);
          return;
        }
        throw error;
      }
      const saved = this.deps.store.addAudioDetailed(synth.bytes, synth.mime, this.deps.now());
      const audio = saved.record;
      const clip: SpeechClip = {
        id: `spch_${ulid()}` as SpeechClip["id"],
        textHash: request.textHash,
        voiceId: request.voice.id,
        speed: request.speed,
        engine: runner.engine,
        engineVersion: runner.engineVersion,
        audioRef: audio.ref,
        mime: audio.mime,
        durationMs: synth.durationMs,
        createdAt: this.deps.now(),
      };
      try {
        const committed = await this.#commitSpeech(job, clip);
        // 存音频之后、落库之前被取消 / 撤回：把这次新建的引用和字节清掉（C酱 #152 建议 4）
        if (!committed) {
          if (saved.created) this.deps.store.deleteAudio(audio.ref);
          return;
        }
      } catch (error) {
        if (!(error instanceof MediaJobStateConflictError)) throw error;
        if (saved.created) this.deps.store.deleteAudio(audio.ref);
        return;
      }
    } finally {
      this.#speech.delete(job.id);
      this.#running.delete(job.id);
    }
  }

  /** 语音结果落库：和「来源消息是否已撤回」同一个事务（和画图一样的口径） */
  async #commitSpeech(job: MediaJob, clip: SpeechClip, options: { insert: boolean } = { insert: true }): Promise<boolean> {
    let succeeded = true;
    const applied = await writeTransaction(this.deps.db, this.deps.queue, () => {
      if (this.#sourceWithdrawn(job)) {
        succeeded = false;
        return transitionMediaJob(this.deps.db, {
          id: job.id,
          from: "running",
          to: "cancelled",
          now: this.deps.now(),
          patch: { cancelReason: "message_withdrawn" },
        });
      }
      if (options.insert) insertSpeechClip(this.deps.db, clip);
      return transitionMediaJob(this.deps.db, {
        id: job.id,
        from: "running",
        to: "succeeded",
        now: this.deps.now(),
        patch: { speech: clip },
      });
    });
    this.#emit(applied);
    return succeeded;
  }

  /**
   * 结果落库：和「来源消息是否已撤回」的检查放在**同一个事务**里（林离 #129）。
   * 撤回提交和取消回调之间回图的窗口，靠这里挡住——不会再落成 succeeded。
   * 返回 true = 存成成功，false = 因为撤回被取消（调用方据此清掉刚画的图）。
   */
  async #commitSuccess(
    job: MediaJob,
    patch: { route?: MediaJob["route"]; result?: MediaJob["result"] },
  ): Promise<boolean> {
    let succeeded = true;
    const applied = await writeTransaction(this.deps.db, this.deps.queue, () => {
      if (this.#sourceWithdrawn(job)) {
        succeeded = false;
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
    return succeeded;
  }

  /** 来源消息（回答的话，还有它回答的那条）是不是已经撤回（ADR-004 §3a） */
  #sourceWithdrawn(job: Pick<MediaJob, "source">): boolean {
    const source = job.source;
    if (source.kind !== "chat") return false;
    const message = getChatMessage(this.deps.db, source.messageId);
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
      speech?: MediaJob["speech"];
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
