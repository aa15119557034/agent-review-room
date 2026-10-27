import type { DrawRequest, DrawRoutePreview, ImmersiveSettings, MediaSource, NodeInfo, VoiceOption } from "@room/schemas";
import type { RoomClient } from "./client";
import { chatVision, jobActive, jobsOf, mergeJobs, type VisionHint } from "./media";
import { draftOf, initialMedia, type ChatDraft, type ChatMediaState, type ChatState } from "./chat";
import type { AppState } from "./state";
import type { Store } from "./store";

/**
 * 多模态的操作（C-43，契约 C-42a～e）：附件、录音、表情、画图、播放、沉浸模式和「停」。
 * 规则和其他 actions 一样：失败写进 notice，不向上抛。renderer 永远不传文件路径、不传要朗读的文字：
 * 选文件由 main 开对话框，朗读的正文由 main 按消息 id 自己取。
 */
export function createMediaActions(store: Store<AppState>, client: RoomClient, fail: (err: unknown) => void) {
  const setChat = (f: (c: ChatState) => ChatState) => store.set((s) => ({ ...s, chat: f(s.chat) }));
  const setMedia = (f: (m: ChatMediaState) => ChatMediaState) => setChat((c) => ({ ...c, media: f(c.media) }));
  const chat = () => store.get().chat;

  /** 改当前会话的草稿；和 chat-actions 一样，一改就作废上次没拿到结果的那次发送 */
  const draftPatch = (patch: Partial<ChatDraft>) =>
    setChat((c) => {
      if (!c.currentId) return c;
      return { ...c, drafts: { ...c.drafts, [c.currentId]: { ...draftOf(c, c.currentId), ...patch, messageId: null } } };
    });

  /**
   * 打开会话时：这个会话的媒体任务和沉浸模式设置。后端还没实现这些查询时安静地不显示（不弹错误），
   * 免得在 D-38 / D-39 之前每次打开会话都报错
   */
  async function loadForConversation(conversationId: string) {
    setMedia((m) => ({ ...m, jobs: [], immersive: null, clips: {}, playing: null, playQueue: [] }));
    const [jobs, immersive] = await Promise.all([
      client.query({ type: "media.list", scope: { kind: "chat", conversationId } }).catch(() => null),
      client.query({ type: "immersive.get", conversationId }).catch(() => null),
    ]);
    setChat((c) => {
      if (c.currentId !== conversationId) return c;
      const clips = { ...c.media.clips };
      for (const j of jobs ?? []) if (j.kind === "speech" && j.speech && j.source.kind === "chat") clips[j.source.messageId] ??= j.speech;
      // 查询期间推来的事件可能更新：合并，不覆盖
      return { ...c, media: { ...c.media, jobs: mergeJobs(jobs ?? [], c.media.jobs), immersive: immersive ?? c.media.immersive, clips } };
    });
  }

  /** 每位秘书「聊天」用的模型能不能看图：用 node.test 问一次聊天 profile（探测，失败不弹提示，记成 offline） */
  async function loadVision() {
    let nodes: NodeInfo[];
    try {
      nodes = await client.query({ type: "nodes.list" });
    } catch {
      return;
    }
    const entries = await Promise.all(
      store.get().disc.agents.map(async (a): Promise<readonly [string, VisionHint]> => {
        const node = nodes.find((n) => n.id === a.nodeId);
        if (!node || !node.tokenConfigured || a.chatProfileId === null) return [a.id, "offline"];
        try {
          const r = await client.command({ type: "node.test", id: node.id, baseUrl: node.baseUrl, profileId: a.chatProfileId });
          return [a.id, chatVision(a, r.reachable ? r.health : null)];
        } catch {
          return [a.id, "offline"];
        }
      }),
    );
    setMedia((m) => ({ ...m, vision: Object.fromEntries(entries) }));
  }

  /** 表情面板是你自己打开的：读不到就提示（和后台加载的媒体任务、沉浸设置不同，那些静默跳过） */
  async function loadStickers() {
    try {
      const stickers = await client.query({ type: "chat.stickers.list" });
      setMedia((m) => ({ ...m, stickers }));
    } catch (err) {
      fail(err);
    }
  }

  return {
    loadForConversation,
    loadVision,
    loadStickers,
    reset: () => setMedia(() => initialMedia),

    // ---------------------------------------------------------- 附件（D-34a / D-36）

    async pickAttachment(kind: "image" | "file") {
      try {
        const conversationId = chat().currentId;
        if (!conversationId || chat().media.voiceImporting[conversationId]) return;
        const a = await client.command({ type: "chat.attachment.pick", kind });
        if (!a) return;
        const d = draftOf(chat(), conversationId);
        // 选文件的对话框开着时录好了音：不覆盖录音，告诉你
        if (d.voice) return fail(new Error("草稿里已经有一段录音了，这个附件没放进去。要发附件先取消录音"));
        // 同一个文件选两次（main 按内容去重，ref 相同）只放一份
        if (d.attachments.some((x) => x.ref === a.ref)) return;
        draftPatch({ attachments: [...d.attachments, a], voice: null });
      } catch (err) {
        fail(err);
      }
    },
    removeAttachment(ref: string) {
      draftPatch({ attachments: draftOf(chat(), chat().currentId).attachments.filter((a) => a.ref !== ref) });
    },

    // ---------------------------------------------------------- 录音（D-34b）

    /**
     * 交一段录好的音（renderer 录的，没有路径）。转写完成前先显示「转写中」，好了把转写放进输入框给你改。
     * conversationId 是开始录音时的会话：录音过程中切了会话，也只写回原来那个会话的草稿
     */
    async importVoice(conversationId: string, format: "webm" | "ogg" | "wav", data: string) {
      setMedia((m) => ({ ...m, voiceImporting: { ...m.voiceImporting, [conversationId]: true } }));
      try {
        const rec = await client.command({ type: "chat.voice.import", format, data });
        let kept = true;
        setChat((c) => {
          const recordings = { ...c.media.recordings, [rec.audio]: rec };
          const prev = draftOf(c, conversationId);
          // 上传期间草稿里多了附件（理论上按钮锁着，防万一）：不静默丢附件，录音不放进去
          if (prev.attachments.length > 0 || prev.voice) {
            kept = false;
            return { ...c, media: { ...c.media, recordings } };
          }
          const voice = { audio: rec.audio, text: rec.status === "ready" ? rec.transcript!.text : "" };
          return {
            ...c,
            media: { ...c.media, recordings },
            drafts: { ...c.drafts, [conversationId]: { ...prev, voice, messageId: null } },
          };
        });
        if (!kept) fail(new Error("草稿里已经有附件或录音，这段录音没放进去"));
      } catch (err) {
        fail(err);
      } finally {
        setMedia((m) => {
          const { [conversationId]: _, ...rest } = m.voiceImporting;
          return { ...m, voiceImporting: rest };
        });
      }
    },
    setVoiceText: (text: string) => {
      const v = draftOf(chat(), chat().currentId).voice;
      if (v) draftPatch({ voice: { ...v, text } });
    },
    cancelVoice: () => draftPatch({ voice: null }),

    /** 「用语音回」开关：手动拨过就不再按说法自动点亮 */
    setReplyAsVoice: (on: boolean) => draftPatch({ replyAsVoice: on, replyAsVoiceTouched: true }),

    // ---------------------------------------------------------- 表情（D-34a）

    async addSticker(label: string) {
      try {
        const s = await client.command({ type: "chat.sticker.add", label });
        if (s) setMedia((m) => ({ ...m, stickers: [...(m.stickers ?? []), s] }));
      } catch (err) {
        fail(err);
      }
    },
    async removeSticker(stickerId: string) {
      try {
        await client.command({ type: "chat.sticker.remove", stickerId });
        setMedia((m) => ({ ...m, stickers: (m.stickers ?? []).filter((s) => s.id !== stickerId) }));
      } catch (err) {
        fail(err);
      }
    },

    // ---------------------------------------------------------- 画图（D-38）

    openDrawCard: (messageId: string, prompt: string) => setChat((c) => ({ ...c, sheet: { kind: "draw", messageId, prompt } })),

    /** 请求卡打开 / 改了路时预览走哪条路（main 现读一次额度）。失败返回 undefined，卡片上显示「预览不了」 */
    async previewDraw(request: DrawRequest): Promise<DrawRoutePreview | undefined> {
      try {
        return await client.query({ type: "draw.preview", request });
      } catch {
        return undefined;
      }
    },

    /**
     * 你点了「画」（authorization = user_tap）。成功就关掉卡片，之后的进度看 media.updated。
     * 同一条消息已经在画、或者上一次 draw.start 还没回来，就不再发（卡片和「改用本机画」不会一下建两个任务）
     */
    async startDraw(request: DrawRequest, source: MediaSource, confirmOverThreshold: boolean): Promise<boolean> {
      if (source.kind !== "chat") return false;
      const key = source.messageId;
      const m = chat().media;
      if (m.drawStarting[key] || jobsOf(m.jobs, key, "draw").some(jobActive)) {
        fail(new Error("这条已经在画了，等它画完或先取消"));
        return false;
      }
      setMedia((x) => ({ ...x, drawStarting: { ...x.drawStarting, [key]: true } }));
      const done = () =>
        setMedia((x) => {
          const { [key]: _, ...rest } = x.drawStarting;
          return { ...x, drawStarting: rest };
        });
      try {
        const job = await client.command({
          type: "draw.start",
          request,
          source,
          ...(confirmOverThreshold ? { confirmOverThreshold: true } : {}),
        });
        setChat((c) => {
          const drawRequested = { ...c.media.drawRequested, [key]: true as const };
          // 只关这条消息的请求卡：回包前切到别的会话、打开了别的卡，不能把那张关掉（林离 #115）
          const mine = c.sheet?.kind === "draw" && c.sheet.messageId === key && source.conversationId === c.currentId;
          return {
            ...c,
            sheet: mine ? null : c.sheet,
            media:
              source.conversationId === c.currentId
                ? { ...c.media, jobs: mergeJobs(c.media.jobs, [job]), drawRequested }
                : { ...c.media, drawRequested },
          };
        });
        return true;
      } catch (err) {
        fail(err);
        return false;
      } finally {
        done();
      }
    },

    async cancelJob(jobId: string) {
      try {
        const job = await client.command({ type: "media.cancel", jobId });
        // 回包前可能已经切到别的会话：只并进任务所属的那个会话
        setChat((c) =>
          job.source.kind === "chat" && job.source.conversationId === c.currentId ? { ...c, media: { ...c.media, jobs: mergeJobs(c.media.jobs, [job]) } } : c,
        );
      } catch (err) {
        fail(err);
      }
    },

    /** 会话的「停」：取消这个会话所有排队和正在跑的媒体任务。一次性的，沉浸模式仍然开着 */
    async stop() {
      const conversationId = chat().currentId;
      if (!conversationId) return;
      try {
        const jobs = await client.command({ type: "media.stop", scope: { kind: "chat", conversationId } });
        setChat((c) =>
          c.currentId !== conversationId
            ? c
            : { ...c, media: { ...c.media, jobs: mergeJobs(c.media.jobs, jobs), playing: null, playQueue: [] } },
        );
      } catch (err) {
        fail(err);
      }
    },

    // ---------------------------------------------------------- 播放（D-37）

    /** 点了一条回答的「播放」：播过的直接播；否则 main 合成（authorization = user_play），合成好了自动播 */
    async play(messageId: string, agent: string) {
      const c = chat();
      const conversationId = c.currentId;
      if (!conversationId) return;
      if (c.media.clips[messageId]) {
        setMedia((m) => ({ ...m, playing: messageId, playQueue: m.playQueue.filter((x) => x !== messageId) }));
        return;
      }
      try {
        const r = await client.command({ type: "speech.play", source: { kind: "chat", conversationId, messageId, agent } });
        setChat((x) => {
          if (x.currentId !== conversationId) return x;
          if (r.cached) return { ...x, media: { ...x.media, clips: { ...x.media.clips, [messageId]: r.clip }, playing: messageId } };
          return { ...x, media: { ...x.media, jobs: mergeJobs(x.media.jobs, [r.job]) } };
        });
      } catch (err) {
        fail(err);
      }
    },
    stopPlaying: () => setMedia((m) => ({ ...m, playing: null, playQueue: [] })),
    /** 播完一段：接着播队列里的下一段 */
    playEnded: () => setMedia((m) => ({ ...m, playing: m.playQueue[0] ?? null, playQueue: m.playQueue.slice(1) })),

    // ---------------------------------------------------------- 沉浸模式（D-39）

    async updateImmersive(settings: ImmersiveSettings) {
      const conversationId = chat().currentId;
      if (!conversationId) return;
      try {
        const saved = await client.command({ type: "immersive.update", conversationId, settings });
        const usage = await client.query({ type: "immersive.get", conversationId }).then((r) => r.usage).catch(() => null);
        setChat((c) =>
          c.currentId !== conversationId
            ? c
            : { ...c, media: { ...c.media, immersive: { settings: saved, usage: usage ?? c.media.immersive?.usage ?? emptyUsage() } } },
        );
        // 从开到关：main 取消了这个会话所有任务，拉一次最新的
        if (!saved.enabled) await loadForConversation(conversationId);
      } catch (err) {
        fail(err);
      }
    },

    // ---------------------------------------------------------- 声音（秘书资料页）

    async loadVoices(): Promise<VoiceOption[] | undefined> {
      try {
        return await client.query({ type: "voices.list" });
      } catch (err) {
        fail(err);
        return undefined;
      }
    },
  };
}

const emptyUsage = () => ({ asOf: new Date().toISOString(), drawsLastHour: 0, voiceClipsLastHour: 0 });

export type MediaActions = ReturnType<typeof createMediaActions>;
