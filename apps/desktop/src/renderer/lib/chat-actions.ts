import { ChatImageInputName, type ChatContentInput, type ChatMentions, type ConversationMembers, type ControlEvent, type Project } from "@room/schemas";
import { ControlFailure, type RoomClient } from "./client";
import type { AppState } from "./state";
import {
  draftOf,
  emptyDraft,
  mergeMessages,
  mergeSlots,
  pruneMentions,
  toggleMention,
  type ChatDraft,
  type ChatState,
} from "./chat";
import { newId } from "./ids";
import { asksForVoiceReply } from "./media";
import { createMediaActions } from "./media-actions";
import type { Store } from "./store";

/**
 * 聊天空间的操作（C-35）。规则和其他 actions 一样：失败写进 notice，不向上抛。
 * 聊天不盖章：这里没有一条操作会改文件或跑命令；要变成动作只能 toTopic（进讨论室再盖章）。
 */
export interface ChatHooks {
  /** 转议题成功后：把议题加进列表并切到讨论室 */
  openTopic(project: Project): Promise<void>;
}

/** 一页拉多少条消息 */
const PAGE = 50;
/** 聊天事件到了之后多久重新拉会话列表（合并一串事件） */
const LIST_REFRESH_MS = 150;

export function createChatActions(store: Store<AppState>, client: RoomClient, fail: (err: unknown) => void, hooks: ChatHooks) {
  const setChat = (f: (c: ChatState) => ChatState) => store.set((s) => ({ ...s, chat: f(s.chat) }));
  const chat = () => store.get().chat;

  const notSupported = (err: unknown) =>
    err instanceof ControlFailure && (err.code === "validation_failed" || err.code === "internal");

  async function loadConversations() {
    try {
      const list = await client.query({ type: "chat.conversations.list" });
      setChat((c) => ({ ...c, available: true, list }));
    } catch (err) {
      if (notSupported(err) && chat().list === null) setChat((c) => ({ ...c, available: false }));
      else fail(err);
    }
  }

  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  const refreshListSoon = () => {
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      void loadConversations();
    }, LIST_REFRESH_MS);
  };

  /** 读到最新一条（只往后挪，后端也会忽略更旧的） */
  async function markRead() {
    const { currentId, messages } = chat();
    const last = messages[messages.length - 1];
    if (!currentId || !last) return;
    try {
      await client.command({ type: "chat.conversation.markRead", conversationId: currentId, messageId: last.id });
    } catch {
      // 只是已读标记，失败不打扰
    }
  }

  const media = createMediaActions(store, client, fail);

  let openToken = 0;

  async function openConversation(conversationId: string) {
    const token = ++openToken;
    setChat((c) => ({ ...c, currentId: conversationId, messages: [], slots: [], nextCursor: null, selecting: null, sheet: null }));
    void media.loadForConversation(conversationId);
    try {
      const page = await client.query({ type: "chat.messages.list", conversationId, limit: PAGE });
      if (token !== openToken) return;
      // 等查询期间推来的事件已经合进来了，查询结果可能比它们旧：合并，不覆盖（规则见 mergeMessages / slotIsNewer）
      setChat((c) =>
        c.currentId !== conversationId
          ? c
          : { ...c, messages: mergeMessages(c.messages, page.messages), slots: mergeSlots(c.slots, page.slots), nextCursor: page.nextCursor },
      );
      void media.loadJobs(conversationId, page.messages.map((m) => m.id));
      // 回答到一半关掉再打开：之前的流式文字补不回来（main 的聊天事件只推不存，契约也没有回放查询），
      // 只显示「正在想…」，之后到的照常显示，答完以 chat.message.created 的正文为准
      await markRead();
      refreshListSoon();
    } catch (err) {
      fail(err);
    }
  }

  const draftPatch = (patch: Partial<ChatDraft>) =>
    setChat((c) => {
      if (!c.currentId) return c;
      // 草稿一改，之前那次没拿到结果的发送就作废了（意图变了就是新的一次）
      const next = { ...draftOf(c, c.currentId), ...patch, messageId: patch.messageId ?? null };
      return { ...c, drafts: { ...c.drafts, [c.currentId]: next } };
    });

  return {
    media,
    loadConversations,

    /** 聊天事件的副作用：未读数、「回答中」以 main 为准，重新拉列表；正在看的会话来了新消息就标已读 */
    onChatEvent(e: ControlEvent) {
      if (!e.type.startsWith("chat.")) return;
      refreshListSoon();
      if (e.type === "chat.message.created" && e.message.conversationId === chat().currentId) void markRead();
    },

    openConversation,

    /** 手机宽度下「返回」到会话列表 */
    closeConversation: () => setChat((c) => ({ ...c, currentId: null, selecting: null, sheet: null })),

    async loadOlder() {
      const { currentId, nextCursor } = chat();
      if (!currentId || !nextCursor) return;
      try {
        const page = await client.query({ type: "chat.messages.list", conversationId: currentId, before: nextCursor, limit: PAGE });
        setChat((c) =>
          c.currentId !== currentId
            ? c
            : { ...c, messages: mergeMessages(c.messages, page.messages), slots: mergeSlots(c.slots, page.slots), nextCursor: page.nextCursor },
        );
        void media.loadJobs(currentId, page.messages.map((m) => m.id));
      } catch (err) {
        fail(err);
      }
    },

    openSheet: (sheet: ChatState["sheet"]) => setChat((c) => ({ ...c, sheet })),
    closeSheet: () => setChat((c) => ({ ...c, sheet: null })),

    async createConversation(members: ConversationMembers, title: string | null) {
      try {
        let conv = await client.command({ type: "chat.conversation.create", members, title });
        // 和这位已经有单聊时 main 返回原来那个，填的名字不会用上：填了就改成它，不能无声丢掉（B-11）
        if (title !== null && conv.title !== title) {
          conv = await client.command({ type: "chat.conversation.update", conversationId: conv.id, title });
        }
        await loadConversations();
        await openConversation(conv.id);
      } catch (err) {
        fail(err);
      }
    },

    /** 改名、置顶、免打扰、群成员。只传要改的 */
    async updateConversation(patch: { title?: string | null; pinned?: boolean; muted?: boolean; members?: string[] }) {
      const conversationId = chat().currentId;
      if (!conversationId) return;
      try {
        const conv = await client.command({ type: "chat.conversation.update", conversationId, ...patch });
        setChat((c) => ({
          ...c,
          drafts: c.drafts[conv.id] ? { ...c.drafts, [conv.id]: { ...c.drafts[conv.id]!, mentions: pruneMentions(c.drafts[conv.id]!.mentions, conv.members) } } : c.drafts,
        }));
        await loadConversations();
      } catch (err) {
        fail(err);
      }
    },

    /** 打字。没手动拨过「用语音回」时，按这一条里有没有「用语音回我」这类说法自动点亮 / 熄灭 */
    setDraftText: (text: string) => {
      const d = draftOf(chat(), chat().currentId);
      draftPatch(d.replyAsVoiceTouched ? { text } : { text, replyAsVoice: asksForVoiceReply(text) });
    },
    toggleMention: (pick: "all" | string) =>
      draftPatch({ mentions: toggleMention(draftOf(chat(), chat().currentId).mentions, pick) }),
    setMentions: (mentions: ChatMentions) => draftPatch({ mentions }),
    quote: (messageId: string | null) => draftPatch({ quoteMessageId: messageId }),
    cancelReedit: () => draftPatch({ replacesMessageId: null }),

    /** 重新编辑：把撤回的原文放回输入框（@ 和引用一起带回来），发出去是一条新消息 */
    startReedit(messageId: string) {
      const m = chat().messages.find((x) => x.id === messageId);
      if (!m || m.sender !== "user" || m.content.kind !== "text") return;
      // 附件要重新选（撤回后 main 可能已经清掉没被引用的文件）；「用语音回」照原来的
      draftPatch({
        text: m.content.text,
        mentions: m.mentions,
        quoteMessageId: m.quoteMessageId,
        replacesMessageId: m.id,
        replyAsVoice: m.replyAsVoice === true,
        replyAsVoiceTouched: m.replyAsVoice === true,
        attachments: [],
        voice: null,
      });
    },

    async send() {
      const c = chat();
      const conversationId = c.currentId;
      const conv = c.list?.find((x) => x.conversation.id === conversationId)?.conversation;
      if (!conversationId || !conv) return;
      const draft = draftOf(c, conversationId);
      const content = draftContent(draft);
      if (!content) return;
      // 同一次发送（上次没拿到结果）沿用原来的 id，main 按 id 防重复
      const messageId = draft.messageId ?? newId("cmsg");
      setChat((x) => ({ ...x, drafts: { ...x.drafts, [conversationId]: { ...draft, messageId } } }));
      try {
        const r = await client.command({
          type: "chat.send",
          conversationId,
          messageId,
          content,
          mentions: conv.kind === "direct" ? { kind: "none" } : draft.mentions,
          quoteMessageId: draft.quoteMessageId,
          replacesMessageId: draft.replacesMessageId,
          ...(draft.replyAsVoice ? { replyAsVoice: true as const } : {}),
        });
        setChat((x) => {
          // 草稿在等结果期间又改过（messageId 被清掉）就别覆盖
          const still = x.drafts[conversationId]?.messageId === messageId;
          const drafts = still ? { ...x.drafts, [conversationId]: emptyDraft() } : x.drafts;
          if (x.currentId !== conversationId) return { ...x, drafts };
          return { ...x, drafts, messages: mergeMessages(x.messages, [r.message]), slots: mergeSlots(x.slots, r.slots) };
        });
        refreshListSoon();
      } catch (err) {
        // 后端明确拒绝了 = 什么都没建，下次是新的一次；连不上 = 不知道建没建，留着 id 原样再发
        if (!(err instanceof ControlFailure && err.code === "internal")) {
          setChat((x) => {
            const d = x.drafts[conversationId];
            return d?.messageId === messageId ? { ...x, drafts: { ...x.drafts, [conversationId]: { ...d, messageId: null } } } : x;
          });
        }
        fail(err);
      }
    },

    /** 发一个表情：点了就发，不进草稿（@ 和「用语音回」照草稿里的） */
    async sendSticker(stickerId: string) {
      const c = chat();
      const conversationId = c.currentId;
      const conv = c.list?.find((x) => x.conversation.id === conversationId)?.conversation;
      if (!conversationId || !conv) return;
      const draft = draftOf(c, conversationId);
      try {
        const r = await client.command({
          type: "chat.send",
          conversationId,
          messageId: newId("cmsg"),
          content: { kind: "sticker", stickerId },
          mentions: conv.kind === "direct" ? { kind: "none" } : draft.mentions,
          quoteMessageId: null,
          replacesMessageId: null,
          ...(draft.replyAsVoice ? { replyAsVoice: true as const } : {}),
        });
        setChat((x) => (x.currentId !== conversationId ? x : { ...x, messages: mergeMessages(x.messages, [r.message]), slots: mergeSlots(x.slots, r.slots) }));
        refreshListSoon();
      } catch (err) {
        fail(err);
      }
    },

    async retract(messageId: string) {
      try {
        const r = await client.command({ type: "chat.retract", messageId });
        // 等返回期间可能已经切到别的会话：只写回它自己的会话
        setChat((c) =>
          c.currentId !== r.message.conversationId ? c : { ...c, messages: mergeMessages(c.messages, [r.message]), slots: mergeSlots(c.slots, r.slots) },
        );
        refreshListSoon();
      } catch (err) {
        fail(err);
      }
    },

    async retry(slotId: string) {
      try {
        const r = await client.command({ type: "chat.retry", slotId });
        setChat((c) => (c.currentId !== r.slot.conversationId ? c : { ...c, slots: mergeSlots(c.slots, [r.slot]) }));
      } catch (err) {
        fail(err);
      }
    },

    async cancelReply(slotId: string) {
      try {
        const slot = await client.command({ type: "chat.cancelReply", slotId });
        setChat((c) => (c.currentId !== slot.conversationId ? c : { ...c, slots: mergeSlots(c.slots, [slot]) }));
      } catch (err) {
        fail(err);
      }
    },

    // ---------------------------------------------------------- 多选 → 转议题

    startSelect: (messageId?: string) => setChat((c) => ({ ...c, selecting: messageId ? [messageId] : [], sheet: null })),
    cancelSelect: () => setChat((c) => ({ ...c, selecting: null })),
    toggleSelect: (messageId: string) =>
      setChat((c) =>
        !c.selecting
          ? c
          : { ...c, selecting: c.selecting.includes(messageId) ? c.selecting.filter((x) => x !== messageId) : [...c.selecting, messageId] },
      ),

    async toTopic(name: string) {
      const { currentId, selecting, messages } = chat();
      if (!currentId || !selecting?.length) return;
      // 按时间顺序交（main 也会按时间整理，这里只是让请求好读）
      const messageIds = messages.filter((m) => selecting.includes(m.id)).map((m) => m.id);
      try {
        const { project } = await client.command({ type: "chat.toTopic", conversationId: currentId, messageIds, name });
        setChat((c) => ({ ...c, selecting: null }));
        await hooks.openTopic(project);
      } catch (err) {
        fail(err);
      }
    },

    /** 记忆来源详情：这次回答的 ChatRun（记忆清单在上面） */
    async loadChatRun(runId: string) {
      if (chat().runs[runId]) return;
      try {
        const run = await client.query({ type: "chat.runs.get", runId });
        setChat((c) => ({ ...c, runs: { ...c.runs, [run.id]: run } }));
      } catch (err) {
        fail(err);
      }
    },

  };
}

/**
 * 草稿 → chat.send 的 content：有录音就是语音消息（只交 audio 和你改过的转写），
 * 否则是正文 + 附件（只交 ref，其余元数据 main 自己填）。什么都没有返回 null
 */
export function draftContent(d: ChatDraft): ChatContentInput | null {
  if (d.voice) return d.voice.text.trim() ? { kind: "voice", audio: d.voice.audio, transcriptText: d.voice.text.trim() } : null;
  if (!d.text.trim() && d.attachments.length === 0) return null;
  // C-42i：图片带上选的时候的原文件名（同一张图按内容去重，main 记不住这次叫什么）；名字不合格就不带，main 用占位名
  const attachments = d.attachments.map((a) =>
    a.kind === "image"
      ? { kind: "image" as const, ref: a.ref, ...(ChatImageInputName.safeParse(a.name).success ? { name: a.name.trim() } : {}) }
      : { kind: "file" as const, ref: a.ref },
  );
  return { kind: "text", text: d.text, attachments };
}

export type ChatActions = ReturnType<typeof createChatActions>;
