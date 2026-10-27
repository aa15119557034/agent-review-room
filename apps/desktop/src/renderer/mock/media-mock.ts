import {
  CODEX_DRAW_QUOTA_THRESHOLD_PERCENT,
  DEFAULT_IMMERSIVE_SETTINGS,
  MEDIA_JOB_TRANSITIONS,
  canTransition,
  type AgentChatMessage,
  type AgentProfile,
  type ChatAttachment,
  type CommandRequest,
  type ControlEvent,
  type DrawRequest,
  type DrawRoutePreview,
  type ImmersiveDeferral,
  type ImmersiveSettings,
  type MediaCancelReason,
  type MediaIntent,
  type MediaJob,
  type MediaJobState,
  type SpeechClip,
  type Sticker,
  type SubscriptionQuota,
  type UserChatMessage,
  type VoiceOption,
  type VoiceRecording,
} from "@room/schemas";
import { MockError, id, now, sha256Hex } from "./util";

/**
 * 多模态的内存实现（C-43 开发用，契约 C-42a～e）。规则照 control-api 里的注释：
 * - 每个 MediaJob 恰好一个终态（只走 MEDIA_JOB_TRANSITIONS）；取消之后到的结果丢掉
 * - 授权由「后端」按发起方式填：你点「画」= user_tap，你点「播放」= user_play，「用语音回」= reply_as_voice，沉浸模式 = immersive
 * - source 以存下来的消息为准（作者对不上 validation_failed），用谁的声音只看回答的作者
 * - 沉浸模式入队时按最近 60 分钟占名额，超了就退回（immersiveDeferred = hourly_limit）
 *
 * 和其他 mock 一样只是演示和界面开发用：图片是画出来的 SVG，声音是一段提示音，转写是假的。
 * 浏览器里没有 room-image:// 和 room-audio://，所以 url() 把引用换成 data: 地址（只在 ?mock 时装进 lib/media）。
 */

export interface MediaMockOptions {
  /** 林离 Codex 的额度（两个窗口都用这个数）；null = 读不到 */
  codexQuotaPercent?: number | null;
  /** 本机 ComfyUI 有没有开 */
  comfyui?: boolean;
  /** 下一张图画到一半额度用完（只触发一次） */
  quotaExhaustOnce?: boolean;
}

export interface MediaMockContext {
  emit(e: ControlEvent): void;
  agents(): AgentProfile[];
  /** 按 id 找聊天消息（chat-mock 提供） */
  chatMessage(messageId: string): (UserChatMessage | AgentChatMessage) | undefined;
  tickMs: number;
}

const VOICES: VoiceOption[] = [
  { id: "qingning", displayName: "清宁（温和）", engine: "cosyvoice", source: "preset", sampleRef: null },
  { id: "yuanqi", displayName: "元气（明快）", engine: "cosyvoice", source: "preset", sampleRef: null },
  { id: "chenwen", displayName: "沉稳（低）", engine: "cosyvoice", source: "preset", sampleRef: null },
  { id: "xiaoyu", displayName: "小语（轻）", engine: "cosyvoice", source: "preset", sampleRef: null },
];

const HOUR = 3600_000;

export function createMediaMock(ctx: MediaMockContext, options: MediaMockOptions = {}) {
  const { emit } = ctx;
  const clone = <T>(x: T): T => structuredClone(x);
  const m = {
    /** 引用 → 浏览器能显示 / 播放的地址 */
    urls: new Map<string, string>(),
    attachments: new Map<string, ChatAttachment>(),
    recordings: new Map<string, VoiceRecording>(),
    stickers: [] as Sticker[],
    jobs: [] as MediaJob[],
    timers: new Map<string, ReturnType<typeof setTimeout>[]>(),
    /** 回答的消息 id + 声音 → 合成过的语音（缓存，键里含声音和语速，和 speech.ts 一样） */
    clips: new Map<string, SpeechClip>(),
    immersive: new Map<string, ImmersiveSettings>(),
    picks: 0,
  };
  let quotaExhaustOnce = options.quotaExhaustOnce ?? false;

  const agent = (aid: string) => ctx.agents().find((a) => a.id === aid);

  // ------------------------------------------------------------ 假图片 / 假声音

  function svgImage(title: string, sub: string, hue: number, w = 640, h = 480): string {
    const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
      `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 55% 78%)"/>` +
      `<stop offset="1" stop-color="hsl(${(hue + 50) % 360} 45% 52%)"/></linearGradient></defs>` +
      `<rect width="100%" height="100%" fill="url(#g)"/>` +
      `<circle cx="${w * 0.72}" cy="${h * 0.32}" r="${Math.min(w, h) * 0.16}" fill="hsl(${(hue + 180) % 360} 70% 88%)" opacity="0.8"/>` +
      `<text x="32" y="${h - 64}" font-family="sans-serif" font-size="${Math.round(w / 18)}" fill="#fff">${esc(title.slice(0, 24))}</text>` +
      `<text x="32" y="${h - 28}" font-family="sans-serif" font-size="${Math.round(w / 36)}" fill="#fff" opacity="0.85">${esc(sub.slice(0, 48))}</text>` +
      `</svg>`;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }

  /** 一段轻柔的提示音当作「合成的语音」：8 kHz 单声道 16 位 WAV */
  function toneWav(ms: number, hz: number): string {
    const rate = 8000;
    const n = Math.round((rate * ms) / 1000);
    const buf = new DataView(new ArrayBuffer(44 + n * 2));
    const str = (o: number, s: string) => [...s].forEach((ch, i) => buf.setUint8(o + i, ch.charCodeAt(0)));
    str(0, "RIFF");
    buf.setUint32(4, 36 + n * 2, true);
    str(8, "WAVEfmt ");
    buf.setUint32(16, 16, true);
    buf.setUint16(20, 1, true);
    buf.setUint16(22, 1, true);
    buf.setUint32(24, rate, true);
    buf.setUint32(28, rate * 2, true);
    buf.setUint16(32, 2, true);
    buf.setUint16(34, 16, true);
    str(36, "data");
    buf.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) {
      const t = i / rate;
      const env = Math.min(1, i / 400, (n - i) / 400) * (0.6 + 0.4 * Math.sin(t * 7));
      buf.setInt16(44 + i * 2, Math.round(Math.sin(2 * Math.PI * hz * t) * 4000 * env), true);
    }
    let bin = "";
    new Uint8Array(buf.buffer).forEach((b) => (bin += String.fromCharCode(b)));
    return `data:audio/wav;base64,${btoa(bin)}`;
  }

  // ------------------------------------------------------------ 任务状态机

  const setJob = (j: MediaJob, to: MediaJobState, patch: Partial<MediaJob> = {}) => {
    if (!canTransition(MEDIA_JOB_TRANSITIONS, j.state, to)) throw new MockError("invalid_state", `任务不能从 ${j.state} 变为 ${to}`);
    Object.assign(j, patch, { state: to });
    if (MEDIA_JOB_TRANSITIONS[to].length === 0) {
      j.finishedAt = now();
      m.timers.get(j.id)?.forEach(clearTimeout);
      m.timers.delete(j.id);
    }
    emit({ type: "media.updated", job: clone(j) });
  };
  const live = (j: MediaJob) => MEDIA_JOB_TRANSITIONS[j.state].length > 0;

  const newJob = (patch: Pick<MediaJob, "kind" | "authorization" | "source" | "intentHash" | "draw">): MediaJob => ({
    id: id("mjob"), state: "queued", route: null, remoteRunId: null, result: null, speech: null, failure: null,
    cancelReason: null, createdAt: now(), startedAt: null, finishedAt: null, ...patch,
  });

  /** 按步骤推进；任务已经结束（被取消）的步骤不再执行 = 取消之后到的结果丢掉 */
  function schedule(j: MediaJob, steps: (() => void)[], every = ctx.tickMs * 4) {
    const hs = steps.map((step, i) => setTimeout(() => live(j) && step(), every * (i + 1)));
    m.timers.set(j.id, hs);
  }

  function cancel(j: MediaJob, reason: MediaCancelReason) {
    if (live(j)) setJob(j, "cancelled", { cancelReason: reason });
  }

  // ------------------------------------------------------------ 画图

  const quota = (): SubscriptionQuota | null => {
    const p = options.codexQuotaPercent === undefined ? 42 : options.codexQuotaPercent;
    if (p === null) return null;
    const w = { usedPercent: p, windowMinutes: 300, resetsAt: new Date(Date.now() + 2 * HOUR).toISOString() };
    return { fiveHour: w, weekly: { ...w, usedPercent: Math.max(0, p - 20), windowMinutes: 10080 }, creditsInUse: p >= 100, readAt: now() };
  };
  const comfyui = options.comfyui ?? true;

  function preview(request: DrawRequest): DrawRoutePreview {
    const q = quota();
    const max = q && q.fiveHour && q.weekly ? Math.max(q.fiveHour.usedPercent, q.weekly.usedPercent) : null;
    const codexManual: DrawRoutePreview["codexManual"] = max === null ? "confirm" : max >= 100 || q?.creditsInUse ? "blocked" : max >= CODEX_DRAW_QUOTA_THRESHOLD_PERCENT ? "confirm" : "none";
    const reason = max === null ? "quota_unknown" : q?.creditsInUse ? "credits_in_use" : max >= CODEX_DRAW_QUOTA_THRESHOLD_PERCENT ? "quota_threshold" : null;
    if (request.backend === "comfyui") return { backend: comfyui ? "comfyui" : null, fallbackReason: null, quota: q, codexManual, comfyuiAvailable: comfyui };
    if (request.backend === "codex") return { backend: codexManual === "blocked" ? null : "codex", fallbackReason: null, quota: q, codexManual, comfyuiAvailable: comfyui };
    if (reason === null) return { backend: "codex", fallbackReason: null, quota: q, codexManual, comfyuiAvailable: comfyui };
    return { backend: comfyui ? "comfyui" : null, fallbackReason: reason, quota: q, codexManual, comfyuiAvailable: comfyui };
  }

  function runDraw(j: MediaJob, manual: boolean, confirmed: boolean, localOnly: boolean) {
    const request = j.draw!;
    const p = localOnly ? { ...preview({ ...request, backend: "comfyui" }), fallbackReason: "session_local_only" as const } : preview(request);
    schedule(j, [
      () => {
        if (p.backend === null) return setJob(j, "failed", { failure: { reason: "backend_unavailable", message: `林离：${quotaTextShort(p.quota)}；本机 ComfyUI 没开` } });
        setJob(j, "running", {
          startedAt: now(),
          route: { backend: p.backend, manual, confirmedOverThreshold: confirmed, fallbackReason: p.backend === "codex" ? null : p.fallbackReason, quotaBefore: p.quota, quotaAfter: null },
        });
      },
      () => {
        if (j.route?.backend === "codex" && quotaExhaustOnce) {
          quotaExhaustOnce = false;
          return setJob(j, "failed", { failure: { reason: "quota_exhausted", message: "Codex 报额度不足" } });
        }
      },
      async () => {
        const ref = id("img");
        const [w, h] = request.size.split("x").map((x) => Number(x) / 2) as [number, number];
        m.urls.set(ref, svgImage(request.prompt, j.route!.backend === "codex" ? "林离 · gpt-image-2" : "本机 · Qwen-Image", (request.prompt.length * 37) % 360, w, h));
        const sha256 = await sha256Hex(ref);
        if (!live(j)) return;
        const route = j.route!;
        setJob(j, "succeeded", {
          route: { ...route, quotaAfter: route.backend === "codex" ? quota() : null },
          result: {
            ref, sha256, backend: route.backend, model: route.backend === "codex" ? "gpt-image-2" : "qwen-image",
            prompt: request.prompt, size: request.size, seed: route.backend === "comfyui" ? 1234567 : null,
            workflowHash: route.backend === "comfyui" ? "e".repeat(64) : null,
          },
        });
      },
    ]);
  }

  // ------------------------------------------------------------ 语音

  async function speak(j: MediaJob, reply: AgentChatMessage, a: AgentProfile) {
    const voice = a.voice!;
    const key = `${reply.id}|${voice.voiceId}|${voice.speed}`;
    const ms = Math.min(6000, 1200 + reply.text.length * 40) / voice.speed;
    schedule(j, [
      () => setJob(j, "running", { startedAt: now() }),
      async () => {
        const audioRef = id("aud");
        m.urls.set(audioRef, toneWav(ms, 300 + (voice.voiceId.length % 5) * 60));
        const clip: SpeechClip = {
          id: id("spch"), textHash: await sha256Hex(reply.text), voiceId: voice.voiceId, speed: voice.speed, engine: "cosyvoice",
          engineVersion: "mock-1", audioRef, mime: "audio/wav", durationMs: Math.round(ms), createdAt: now(),
        };
        if (!live(j)) return;
        m.clips.set(key, clip);
        setJob(j, "succeeded", { speech: clip });
      },
    ], ctx.tickMs * 3);
  }

  const chatSource = (msg: UserChatMessage | AgentChatMessage) =>
    ({ kind: "chat", conversationId: msg.conversationId, messageId: msg.id, agent: msg.sender === "agent" ? msg.agent : null }) as const;

  const settingsOf = (cid: string) => m.immersive.get(cid) ?? DEFAULT_IMMERSIVE_SETTINGS;
  const usageOf = (cid: string) => {
    const since = Date.now() - HOUR;
    const mine = m.jobs.filter(
      (j) => j.authorization === "immersive" && j.source.kind === "chat" && j.source.conversationId === cid && Date.parse(j.createdAt) > since &&
        // 开始前被取消的退回名额
        !(j.state === "cancelled" && j.startedAt === null),
    );
    return { asOf: now(), drawsLastHour: mine.filter((j) => j.kind === "draw").length, voiceClipsLastHour: mine.filter((j) => j.kind === "speech").length };
  };

  // ------------------------------------------------------------ 给 chat-mock 用

  const hooks = {
    url: (ref: string) => m.urls.get(ref),
    attachment(ref: string) {
      const a = m.attachments.get(ref);
      if (!a) throw new MockError("validation_failed", `附件 ${ref} 不存在（要先用 chat.attachment.pick 选）`);
      return clone(a);
    },
    recording(audio: string) {
      const r = m.recordings.get(audio);
      if (!r) throw new MockError("validation_failed", `录音 ${audio} 不存在`);
      if (r.status !== "ready") throw new MockError("validation_failed", "录音还没转写好");
      return clone(r);
    },
    sticker(stickerId: string) {
      const s = m.stickers.find((x) => x.id === stickerId);
      if (!s) throw new MockError("validation_failed", `表情 ${stickerId} 不存在`);
      return clone(s);
    },

    /**
     * 写回答之前：沉浸模式开着时按名额决定哪些意图自动执行、哪些退回（和回答同一个「事务」定下）。
     * 返回要写在消息上的 immersiveDeferred，和写完消息后要开始的任务
     */
    planReply(conversationId: string, intent: MediaIntent | undefined, replyAsVoice: boolean) {
      const s = settingsOf(conversationId);
      const deferred: ImmersiveDeferral = {};
      const auto = { speak: false, draw: false, replyAsVoice };
      if (s.enabled && intent) {
        const u = usageOf(conversationId);
        if (intent.draw) {
          if (u.drawsLastHour < s.drawsPerHour) auto.draw = true;
          else deferred.draw = "hourly_limit";
        }
        // 你要求的语音回（reply_as_voice）不占沉浸模式的名额
        if (intent.speak && !replyAsVoice) {
          if (u.voiceClipsLastHour < s.voiceClipsPerHour) auto.speak = true;
          else deferred.speak = "hourly_limit";
        }
      }
      return { deferred: Object.keys(deferred).length ? deferred : undefined, auto };
    },

    /** 回答写进去之后：开始自动任务（用语音回 / 沉浸模式） */
    async afterReply(reply: AgentChatMessage, auto: { speak: boolean; draw: boolean; replyAsVoice: boolean }) {
      const a = agent(reply.agent);
      const intentHash = await sha256Hex(JSON.stringify(reply.mediaIntent ?? {}));
      if ((auto.replyAsVoice || auto.speak) && a?.voice) {
        const j = newJob({ kind: "speech", authorization: auto.replyAsVoice ? "reply_as_voice" : "immersive", source: chatSource(reply), intentHash: auto.replyAsVoice ? null : intentHash, draw: null });
        m.jobs.push(j);
        emit({ type: "media.updated", job: clone(j) });
        void speak(j, reply, a);
      }
      if (auto.draw && reply.mediaIntent?.draw) {
        const local = !settingsOf(reply.conversationId).autoDrawUsesSubscription;
        const j = newJob({ kind: "draw", authorization: "immersive", source: chatSource(reply), intentHash, draw: { ...reply.mediaIntent.draw, backend: "auto" } });
        m.jobs.push(j);
        emit({ type: "media.updated", job: clone(j) });
        runDraw(j, false, false, local);
      }
    },

    /** 消息撤回 / 回答重新生成：取消对应的任务 */
    cancelFor(messageIds: readonly string[], reason: MediaCancelReason) {
      for (const j of m.jobs) if (j.source.kind === "chat" && messageIds.includes(j.source.messageId)) cancel(j, reason);
    },

    /** 演示数据：一张图、一个文件 */
    async seedAttachment(kind: "image" | "file"): Promise<ChatAttachment> {
      return pick(kind);
    },
  };

  async function pick(kind: "image" | "file"): Promise<ChatAttachment> {
    const n = ++m.picks;
    let a: ChatAttachment;
    if (kind === "image") {
      const ref = id("img");
      const names = ["窗外.jpg", "白板照片.jpg", "界面截图.png", "小鲸鱼.webp"];
      const name = names[(n - 1) % names.length]!;
      m.urls.set(ref, svgImage(name.replace(/\.\w+$/, ""), "mock 图片（已去掉位置信息）", (n * 83) % 360));
      a = { kind: "image", ref, name };
    } else {
      const ref = id("file");
      a = { kind: "file", ref, name: n % 2 ? "需求笔记.md" : "报价单.pdf", mime: n % 2 ? "text/markdown" : "application/pdf", bytes: 1834 * n, sha256: await sha256Hex(ref), isText: n % 2 === 1 };
    }
    m.attachments.set(a.ref, a);
    return clone(a);
  }

  // ------------------------------------------------------------ commands / queries

  const commands = {
    async "chat.attachment.pick"(req: CommandRequest<"chat.attachment.pick">) {
      return pick(req.kind);
    },

    async "chat.voice.import"(req: CommandRequest<"chat.voice.import">) {
      const audio = id("aud");
      const bytes = Math.floor((req.data.length * 3) / 4);
      // webm / opus 大约 2 KB 一秒
      const durationMs = Math.max(1000, Math.min(300_000, Math.round(bytes / 2)));
      m.urls.set(audio, `data:audio/${req.format};base64,${req.data}`);
      const rec: VoiceRecording = { audio, durationMs, status: "transcribing", transcript: null, error: null, createdAt: now() };
      m.recordings.set(audio, rec);
      setTimeout(() => {
        Object.assign(rec, {
          status: "ready",
          transcript: { text: `（mock 转写）这是一段 ${Math.round(durationMs / 1000)} 秒的录音，你可以在发送前改这段文字。`, language: "zh-CN", source: "transcribed", engine: { engine: "mock", model: "mock-asr" } },
        });
        emit({ type: "chat.voice.updated", recording: clone(rec) });
      }, ctx.tickMs * 8);
      return clone(rec);
    },

    async "chat.sticker.add"(req: CommandRequest<"chat.sticker.add">) {
      if (m.stickers.length >= 500) throw new MockError("invalid_state", "表情库满了");
      const image = id("img");
      m.urls.set(image, svgImage(req.label, "", (m.stickers.length * 61) % 360, 240, 240));
      const s: Sticker = { id: id("stk"), image, label: req.label, createdAt: now() };
      m.stickers.push(s);
      return clone(s);
    },
    async "chat.sticker.update"(req: CommandRequest<"chat.sticker.update">) {
      const s = hooks.sticker(req.stickerId);
      const real = m.stickers.find((x) => x.id === s.id)!;
      real.label = req.label;
      return clone(real);
    },
    async "chat.sticker.remove"(req: CommandRequest<"chat.sticker.remove">) {
      hooks.sticker(req.stickerId);
      m.stickers = m.stickers.filter((x) => x.id !== req.stickerId);
      return {};
    },

    async "draw.start"(req: CommandRequest<"draw.start">) {
      const src = req.source;
      if (src.kind !== "chat") throw new MockError("validation_failed", "mock 只做了聊天里的画图");
      const msg = ctx.chatMessage(src.messageId);
      const author = msg?.sender === "agent" ? msg.agent : null;
      if (!msg || msg.conversationId !== src.conversationId || author !== src.agent) throw new MockError("validation_failed", "来源消息对不上");
      const same = m.jobs.find(
        (j) => live(j) && j.source.kind === "chat" && j.source.messageId === src.messageId && JSON.stringify(j.draw) === JSON.stringify(req.request),
      );
      if (same) return clone(same);
      const p = preview(req.request);
      if (req.request.backend === "codex") {
        if (p.codexManual === "blocked") throw new MockError("invalid_state", `林离额度 ${quotaTextShort(p.quota)}，不能选`);
        if (p.codexManual === "confirm" && !req.confirmOverThreshold) throw new MockError("invalid_state", `林离额度 ${quotaTextShort(p.quota)}，要再确认一次`);
      }
      const j = newJob({ kind: "draw", authorization: "user_tap", source: chatSource(msg), intentHash: null, draw: clone(req.request) });
      m.jobs.push(j);
      runDraw(j, req.request.backend !== "auto", req.confirmOverThreshold === true && p.codexManual === "confirm", false);
      return clone(j);
    },

    async "media.cancel"(req: CommandRequest<"media.cancel">) {
      const j = m.jobs.find((x) => x.id === req.jobId);
      if (!j) throw new MockError("not_found", `任务 ${req.jobId} 不存在`);
      if (!live(j)) throw new MockError("invalid_state", "任务已经结束了");
      cancel(j, "user_cancel");
      return clone(j);
    },

    async "media.stop"(req: CommandRequest<"media.stop">) {
      const scope = req.scope;
      const hit = m.jobs.filter((j) => live(j) && j.source.kind === "chat" && scope.kind === "chat" && j.source.conversationId === scope.conversationId);
      hit.forEach((j) => cancel(j, "user_stop"));
      return clone(hit);
    },

    async "speech.play"(req: CommandRequest<"speech.play">) {
      const src = req.source;
      if (src.kind !== "chat") throw new MockError("validation_failed", "mock 只做了聊天里的播放");
      const msg = ctx.chatMessage(src.messageId);
      if (!msg || msg.sender !== "agent" || msg.agent !== src.agent || msg.conversationId !== src.conversationId) {
        throw new MockError("validation_failed", "只能播放秘书的回答");
      }
      const a = agent(msg.agent);
      if (!a?.voice) throw new MockError("validation_failed", `${a?.displayName ?? msg.agent} 还没选声音（设置 → 参与者）`);
      const cached = m.clips.get(`${msg.id}|${a.voice.voiceId}|${a.voice.speed}`);
      if (cached) return { cached: true as const, clip: clone(cached) };
      const j = newJob({ kind: "speech", authorization: "user_play", source: chatSource(msg), intentHash: null, draw: null });
      m.jobs.push(j);
      void speak(j, msg, a);
      return { cached: false as const, job: clone(j) };
    },

    async "immersive.update"(req: CommandRequest<"immersive.update">) {
      const was = settingsOf(req.conversationId).enabled;
      m.immersive.set(req.conversationId, clone(req.settings));
      if (was && !req.settings.enabled) {
        for (const j of m.jobs) if (j.source.kind === "chat" && j.source.conversationId === req.conversationId) cancel(j, "immersive_off");
      }
      return clone(req.settings);
    },
  };

  const queries = {
    async "chat.stickers.list"() {
      return clone(m.stickers);
    },
    async "chat.voice.get"(req: { audio: string }) {
      const r = m.recordings.get(req.audio);
      if (!r) throw new MockError("not_found", "录音不存在");
      return clone(r);
    },
    async "draw.preview"(req: { request: DrawRequest }) {
      return preview(req.request);
    },
    async "voices.list"() {
      return clone(VOICES);
    },
    async "immersive.get"(req: { conversationId: string }) {
      return { settings: clone(settingsOf(req.conversationId)), usage: usageOf(req.conversationId) };
    },
    async "media.get"(req: { jobId: string }) {
      const j = m.jobs.find((x) => x.id === req.jobId);
      if (!j) throw new MockError("not_found", `任务 ${req.jobId} 不存在`);
      return clone(j);
    },
    async "media.list"(req: { scope: { kind: string; conversationId?: string } }) {
      return clone(
        m.jobs
          .filter((j) => j.source.kind === "chat" && req.scope.kind === "chat" && j.source.conversationId === req.scope.conversationId)
          .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
          .slice(0, 200),
      );
    },
  };

  async function seed() {
    for (const label of ["比心", "收到", "好耶"]) await commands["chat.sticker.add"]({ type: "chat.sticker.add", label });
  }

  return {
    commands,
    queries,
    hooks,
    seed,
    reset() {
      m.timers.forEach((hs) => hs.forEach(clearTimeout));
      m.timers.clear();
      m.jobs.length = 0;
      m.stickers.length = 0;
      m.clips.clear();
      m.immersive.clear();
    },
  };
}

function quotaTextShort(q: SubscriptionQuota | null): string {
  if (!q || !q.fiveHour || !q.weekly) return "读不到";
  return `${Math.round(Math.max(q.fiveHour.usedPercent, q.weekly.usedPercent))}%`;
}
