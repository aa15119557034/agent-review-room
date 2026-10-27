import {
  CHAT_LIMITS,
  CHAT_SLOT_TRANSITIONS,
  type AgentChatMessage,
  type ChatAttachment,
  type ChatCursor,
  type ChatMentions,
  type ChatMessage,
  type ChatReplySlot,
  type ChatRun,
  type ChatSlotOutcome,
  type Conversation,
  type ConversationListItem,
  type ControlEvent,
  type ImmersiveSettings,
  type ImmersiveUsage,
  type MediaJob,
  type SpeechClip,
  type Sticker,
  type UserChatMessage,
  type VoiceRecording,
} from "@room/schemas";
import { mergeJobs, stripCharts, type VisionHint } from "./media";

/**
 * 聊天空间的状态（C-35，契约 C-34）。和讨论室一样放在同一个 store 里（AppState.chat），
 * 规则单独写在这里：只存后端给的数据；回答位的结局、撤回与否都只看后端，前端不推导。
 *
 * 会话列表的未读数、「回答中」由 main 算：聊天事件到了就重新拉一次列表（chat-actions 里防抖），
 * 这里不自己加减。
 */
export interface ChatState {
  /** 后端还不认识聊天的查询时为 false（老后端） */
  available: boolean;
  /** null = 还没拉过 */
  list: ConversationListItem[] | null;
  /** 正在看的会话；null = 在会话列表（手机宽度下只显示列表） */
  currentId: string | null;
  /** 当前会话已加载的消息（按 createdAt, id 正序） */
  messages: ChatMessage[];
  /** 当前会话已加载的消息的回答位 */
  slots: ChatReplySlot[];
  /** 更早的消息从这里接着拉；null = 到头了 */
  nextCursor: ChatCursor | null;
  /** runId → ChatRun。只在看记忆来源详情时按需拉 */
  runs: Record<string, ChatRun>;
  /** 每个会话的草稿（微信那样：切走再回来还在） */
  drafts: Record<string, ChatDraft>;
  /** 多选（转议题）：选中的消息 id；null = 没在多选 */
  selecting: string[] | null;
  /** 浮层：新建会话、会话设置、消息详情、画图请求卡 */
  sheet:
    | null
    | { kind: "new" }
    | { kind: "settings" }
    | { kind: "message"; messageId: string }
    | { kind: "draw"; messageId: string; prompt: string };
  /** 多模态（C-43） */
  media: ChatMediaState;
}

/** 多模态的状态（C-43，契约 C-42a～e）。任务的结局只看后端（media.updated），前端不推导 */
export interface ChatMediaState {
  /** 当前会话的媒体任务（画图、语音合成） */
  jobs: MediaJob[];
  /** 当前会话的沉浸模式设置和用量；null = 还没拉到（或后端还不认识） */
  immersive: { settings: ImmersiveSettings; usage: ImmersiveUsage } | null;
  /** 表情库；null = 还没拉过 */
  stickers: Sticker[] | null;
  /** 每位秘书现在的聊天模型能不能看图（只是提示） */
  vision: Record<string, VisionHint>;
  /** 你录的、还在转写或等你发送的录音（按 AudioRef） */
  recordings: Record<string, VoiceRecording>;
  /** 播过的合成语音：回答的消息 id → 音频 */
  clips: Record<string, SpeechClip>;
  /** 正在播的回答（消息 id），和排着队等自动播的 */
  playing: string | null;
  playQueue: string[];
  /**
   * 这次运行里你点过「画」的消息（不随会话切换清空）。media.list 只给最近 200 条任务，
   * 更早的任务查不到时，靠它提醒「画过了」，免得再点一次又花一份额度（汐 #115）
   */
  drawRequested: Record<string, true>;
  /** 正在发 draw.start 的消息：结果回来前不能再发一次 */
  drawStarting: Record<string, true>;
  /** 正在上传 / 转写录音的会话：这期间不能加附件（录音回来会占掉草稿，林离 #115） */
  voiceImporting: Record<string, true>;
}

export const initialMedia: ChatMediaState = {
  jobs: [],
  immersive: null,
  stickers: null,
  vision: {},
  recordings: {},
  clips: {},
  playing: null,
  playQueue: [],
  drawRequested: {},
  drawStarting: {},
  voiceImporting: {},
};

export interface ChatDraft {
  text: string;
  mentions: ChatMentions;
  quoteMessageId: string | null;
  /** 重新编辑：被撤回的那条 */
  replacesMessageId: string | null;
  /** 选好的附件（main 存好、去过元数据之后的记录），发送时只交 ref */
  attachments: ChatAttachment[];
  /** 录好的语音：发的是（可能改过的）转写文字；有它时这条是语音消息，不带正文和附件 */
  voice: { audio: string; text: string } | null;
  /** 「用语音回」开关（C-42c） */
  replyAsVoice: boolean;
  /** 你手动拨过开关之后，就不再按说法自动点亮（免得你关掉又被打开） */
  replyAsVoiceTouched: boolean;
  /**
   * 发出去但没拿到结果（IPC 断了）时留着，原样再发 = 同一次发送（main 按 id 防重复）。
   * 草稿任何一处改动都会清掉它：意图变了就是新的一次，否则会撞 idempotency_conflict
   */
  messageId: string | null;
}

export const emptyDraft = (): ChatDraft => ({
  text: "",
  mentions: { kind: "none" },
  quoteMessageId: null,
  replacesMessageId: null,
  attachments: [],
  voice: null,
  replyAsVoice: false,
  replyAsVoiceTouched: false,
  messageId: null,
});

export const initialChat: ChatState = {
  available: true,
  list: null,
  currentId: null,
  messages: [],
  slots: [],
  nextCursor: null,
  runs: {},
  drafts: {},
  selecting: null,
  sheet: null,
  media: initialMedia,
};

// ---------------------------------------------------------------- 合并

const byTime = (a: ChatMessage, b: ChatMessage) =>
  a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/** 合并消息（按 id 去重，保持正序）。已撤回的不会被迟到的旧版本改回 sent */
export function mergeMessages(existing: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const map = new Map(existing.map((m) => [m.id, m]));
  for (const m of incoming) {
    const old = map.get(m.id);
    if (old && old.sender === "user" && m.sender === "user" && old.state === "retracted" && m.state === "sent") continue;
    map.set(m.id, m);
  }
  return [...map.values()].sort(byTime);
}

/**
 * 新的回答位记录能不能覆盖旧的。命令的返回和事件可能乱序到达，不能让旧状态盖掉新状态：
 * - 新的一次尝试（attempt 更大）总是更新
 * - 同一次尝试：结局相同（字段补全），或者按 CHAT_SLOT_TRANSITIONS 能走过去
 */
export function slotIsNewer(old: ChatReplySlot, next: ChatReplySlot): boolean {
  if (next.attempt !== old.attempt) return next.attempt > old.attempt;
  if (next.outcome === old.outcome) return true;
  return (CHAT_SLOT_TRANSITIONS[old.outcome] as readonly ChatSlotOutcome[]).includes(next.outcome);
}

export function mergeSlots(existing: ChatReplySlot[], incoming: ChatReplySlot[]): ChatReplySlot[] {
  const out = existing.slice();
  for (const s of incoming) {
    const i = out.findIndex((x) => x.id === s.id);
    if (i === -1) out.push(s);
    else if (slotIsNewer(out[i]!, s)) out[i] = s;
  }
  return out;
}

/** 聊天事件 → 状态。不属于当前会话的消息 / 回答位忽略（打开那个会话时会重新拉） */
export function applyChatEvent(c: ChatState, event: ControlEvent): ChatState {
  switch (event.type) {
    case "chat.conversation.updated": {
      if (!c.list) return c;
      const i = c.list.findIndex((x) => x.conversation.id === event.conversation.id);
      if (i === -1) return c;
      const list = c.list.slice();
      list[i] = { ...list[i]!, conversation: event.conversation };
      return { ...c, list };
    }
    case "chat.message.created":
    case "chat.message.updated":
      if (event.message.conversationId !== c.currentId) return c;
      return { ...c, messages: mergeMessages(c.messages, [event.message]) };
    case "chat.slot.updated":
      if (event.slot.conversationId !== c.currentId) return c;
      return { ...c, slots: mergeSlots(c.slots, [event.slot]) };
    case "chat.run.updated":
      // 只更新已经拉过的（看记忆来源详情时），不主动收集
      if (!c.runs[event.run.id]) return c;
      return { ...c, runs: { ...c.runs, [event.run.id]: event.run } };
    case "media.updated":
      return applyMediaJob(c, event.job);
    case "chat.voice.updated": {
      // 只收自己正在录的（发出去之后就不管了）
      const rec = event.recording;
      if (!c.media.recordings[rec.audio]) return c;
      const media = { ...c.media, recordings: { ...c.media.recordings, [rec.audio]: rec } };
      // 转写好了：草稿里这段录音的文字还空着就填上，给你发送前改
      const drafts = { ...c.drafts };
      if (rec.status === "ready") {
        for (const [cid, d] of Object.entries(drafts)) {
          if (d.voice?.audio === rec.audio && d.voice.text === "") drafts[cid] = { ...d, voice: { ...d.voice, text: rec.transcript!.text } };
        }
      }
      return { ...c, media, drafts };
    }
    default:
      return c;
  }
}

/**
 * 媒体任务的变化。语音合成好了（这次事件才变成 succeeded）：记下音频，排进自动播放队列（按完成的顺序播）。
 * 自动播只在会话开着、窗口在前台时真的播，见 ui 的播放器；你点「播放」合成的也走这里
 */
export function applyMediaJob(c: ChatState, job: MediaJob): ChatState {
  const src = job.source;
  if (src.kind !== "chat" || src.conversationId !== c.currentId) return c;
  const old = c.media.jobs.find((j) => j.id === job.id);
  const jobs = mergeJobs(c.media.jobs, [job]);
  if (jobs.find((j) => j.id === job.id) !== job) return { ...c, media: { ...c.media, jobs } };
  let { clips, playing, playQueue } = c.media;
  if (job.kind === "speech" && job.state === "succeeded" && job.speech && old?.state !== "succeeded") {
    clips = { ...clips, [src.messageId]: job.speech };
    if (playing === null) playing = src.messageId;
    else if (playing !== src.messageId && !playQueue.includes(src.messageId)) playQueue = [...playQueue, src.messageId];
  }
  return { ...c, media: { ...c.media, jobs, clips, playing, playQueue } };
}

/** 这个 run 是不是当前会话某个回答位的（流式文字要收下） */
export const isChatRun = (c: ChatState, runId: string) => c.slots.some((s) => s.runId === runId);

// ---------------------------------------------------------------- 显示

export const currentConversation = (c: ChatState): Conversation | null =>
  c.list?.find((x) => x.conversation.id === c.currentId)?.conversation ?? null;

export const draftOf = (c: ChatState, conversationId: string | null): ChatDraft =>
  (conversationId && c.drafts[conversationId]) || emptyDraft();

/** 会话的名字：你起的名字，否则单聊是对方名字，群聊是成员名字拼起来 */
export function conversationTitle(conv: Conversation, name: (agent: string) => string): string {
  if (conv.title) return conv.title;
  return conv.members.map(name).join("、");
}

/** 会话列表里最后一条的预览 */
export function previewText(m: ChatMessage | null, name: (agent: string) => string): string {
  if (!m) return "还没有消息";
  if (m.sender === "agent") return `${name(m.agent)}：${oneLine(stripCharts(m.text))}`;
  if (m.state === "retracted") return "你撤回了一条消息";
  return `你：${oneLine(contentText(m))}`;
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** 你发的消息显示成文字（语音用转写，表情用说明，附件用占位） */
export function contentText(m: UserChatMessage): string {
  const c = m.content;
  if (c.kind === "voice") return `[语音] ${c.transcript.text}`;
  if (c.kind === "sticker") return `[表情：${c.label}]`;
  const files = c.attachments.map((a) => (a.kind === "image" ? `[图片：${a.name}]` : `[文件：${a.name}]`));
  return [c.text, ...files].filter((x) => x.trim()).join(" ");
}

export const messageText = (m: ChatMessage) => (m.sender === "agent" ? m.text : contentText(m));

/** 一条消息是否在界面上显示为「已排除」。和 isExcludedFromContext 的区别：问的那条没加载到时不算（只是不知道） */
export function excludedForDisplay(m: ChatMessage, messages: readonly ChatMessage[]): boolean {
  if (m.sender === "user") return m.state === "retracted";
  const q = messages.find((x) => x.id === m.inReplyTo);
  return q !== undefined && q.sender === "user" && q.state === "retracted";
}

export type TimelineEntry =
  | { kind: "user"; message: UserChatMessage; slots: ChatReplySlot[]; reedited: boolean }
  | { kind: "retracted"; message: UserChatMessage }
  | { kind: "agent"; message: AgentChatMessage; excluded: boolean; replyTo: UserChatMessage | null };

/**
 * 时间线：按时间正序。
 * - 重新编辑的消息显示在原来那条的位置（原来那条的「你撤回了一条消息」不再单独显示）
 * - 秘书的回答前面不是它回答的那条时，带一个「回复 你：…」的小引用，免得看不出在答哪句
 */
export function timeline(c: ChatState): TimelineEntry[] {
  const users = new Map<string, UserChatMessage>();
  for (const m of c.messages) if (m.sender === "user") users.set(m.id, m);
  const replacedBy = new Map<string, UserChatMessage>();
  for (const m of users.values()) if (m.replacesMessageId && users.has(m.replacesMessageId)) replacedBy.set(m.replacesMessageId, m);

  const out: TimelineEntry[] = [];
  let lastQuestion: string | null = null;
  for (const m of c.messages) {
    if (m.sender === "agent") {
      const q = users.get(m.inReplyTo) ?? null;
      out.push({ kind: "agent", message: m, excluded: excludedForDisplay(m, c.messages), replyTo: lastQuestion === m.inReplyTo ? null : q });
      continue;
    }
    // 替换别人的那条在原位置显示，这里跳过
    if (m.replacesMessageId && users.has(m.replacesMessageId)) continue;
    // 原位置显示这一串重新编辑的最后一条（可以撤回后重新编辑好几次）
    let last = m;
    for (let next = replacedBy.get(last.id), n = 0; next && n < users.size; next = replacedBy.get(last.id), n++) last = next;
    if (last.state === "retracted") {
      out.push({ kind: "retracted", message: last });
      lastQuestion = null;
    } else {
      out.push({ kind: "user", message: last, slots: c.slots.filter((s) => s.userMessageId === last.id), reedited: last !== m });
      lastQuestion = last.id;
    }
  }
  return out;
}

/** 正在回答的回答位（时间线底部显示流式文字） */
export const runningSlots = (c: ChatState) =>
  c.slots.filter((s) => s.outcome === "running").sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));

export const SLOT_LABEL: Record<ChatSlotOutcome, string> = {
  running: "回答中",
  answered: "已答",
  skipped: "这条没有回",
  absent_quota: "额度缺席",
  unavailable: "不能回答",
  failed: "失败",
  cancelled: "已停止",
  retracted: "已撤回",
};

export const UNAVAILABLE_LABEL: Record<NonNullable<ChatReplySlot["unavailableReason"]>, string> = {
  offline: "节点连不上",
  unconfigured: "没配聊天",
  paused_by_user: "你暂停了",
};

export const FAILURE_LABEL: Record<NonNullable<ChatReplySlot["failure"]>["kind"], string> = {
  empty_output: "空回答",
  parse_error: "格式不对",
  skip_not_allowed: "该回答却没回",
  timed_out: "超时",
  run_failed: "出错",
  interrupted: "应用重启时中断",
};

/** 回答位的一句话状态，例如「汐 · 失败（超时）」 */
export function slotLabel(s: ChatReplySlot): string {
  if (s.outcome === "failed" && s.failure) return `${SLOT_LABEL.failed}（${FAILURE_LABEL[s.failure.kind]}）`;
  if (s.outcome === "unavailable" && s.unavailableReason) return `${SLOT_LABEL.unavailable}（${UNAVAILABLE_LABEL[s.unavailableReason]}）`;
  return SLOT_LABEL[s.outcome];
}

/** 可以单独重试的结局（契约：CHAT_SLOT_TRANSITIONS 里能回到 running 的） */
export const canRetrySlot = (s: ChatReplySlot) => (CHAT_SLOT_TRANSITIONS[s.outcome] as readonly string[]).includes("running");

/** 消息下面显示哪些回答位：已答的看回答本身就够了，不再重复 */
export const visibleSlots = (slots: readonly ChatReplySlot[]) => slots.filter((s) => s.outcome !== "answered" && s.outcome !== "running");

// ---------------------------------------------------------------- 撤回 / 重新编辑（窗口按主控机时间，界面只是显示）

export const canRetract = (m: ChatMessage, nowMs: number) =>
  m.sender === "user" && m.state === "sent" && nowMs - Date.parse(m.createdAt) < CHAT_LIMITS.retractWindowMs;

export function canReedit(m: ChatMessage, messages: readonly ChatMessage[], nowMs: number): boolean {
  if (m.sender !== "user" || m.state !== "retracted" || m.retractedAt === null) return false;
  if (nowMs - Date.parse(m.retractedAt) >= CHAT_LIMITS.reeditWindowMs) return false;
  return !messages.some((x) => x.sender === "user" && x.replacesMessageId === m.id);
}

// ---------------------------------------------------------------- @

/** 在 @ 选择框里点了一项。点「所有人」覆盖具体的人；点已选的人再点一次取消 */
export function toggleMention(cur: ChatMentions, pick: "all" | string): ChatMentions {
  if (pick === "all") return cur.kind === "all" ? { kind: "none" } : { kind: "all" };
  const agents = cur.kind === "agents" ? cur.agents : [];
  if (agents.includes(pick)) {
    const rest = agents.filter((a) => a !== pick);
    return rest.length ? { kind: "agents", agents: rest } : { kind: "none" };
  }
  return { kind: "agents", agents: [...agents, pick] };
}

/** 发送前，告诉你这条谁会回（规则只看选中的 @，不看正文里的字） */
export function mentionHint(conv: Conversation, mentions: ChatMentions, name: (agent: string) => string): string {
  if (conv.kind === "direct") return `${name(conv.members[0]!)} 会回答`;
  if (mentions.kind === "all") return "@所有人：每位都必须回答";
  if (mentions.kind === "agents") {
    const rest = conv.members.length - mentions.agents.length;
    return `${mentions.agents.map(name).join("、")} 必须回答${rest > 0 ? "；其他人这条不回" : ""}`;
  }
  return "没点名：每位自己决定回不回";
}

/** 改了群成员之后，草稿里点到的人可能已经不在群里了 */
export function pruneMentions(m: ChatMentions, members: readonly string[]): ChatMentions {
  if (m.kind !== "agents") return m;
  const agents = m.agents.filter((a) => members.includes(a));
  return agents.length ? { kind: "agents", agents } : { kind: "none" };
}

// ---------------------------------------------------------------- 流式文字

/**
 * 聊天 Run 的原始输出是一整段 JSON（{"kind":"reply","text":"…"}），流式时是半截。
 * 从半截里尽量取出 text 的内容来显示；还没到 text、或者是 skip，返回空字符串。
 * 只用于「回答中」的临时显示，最终以 chat.message.created 的正文为准。
 */
export function partialReplyText(raw: string): string {
  const key = raw.search(/"text"\s*:\s*"/);
  if (key === -1) return "";
  let i = raw.indexOf('"', raw.indexOf(":", key) + 1) + 1;
  let out = "";
  while (i < raw.length) {
    const ch = raw[i]!;
    if (ch === '"') break;
    if (ch !== "\\") {
      out += ch;
      i++;
      continue;
    }
    const esc = raw[i + 1];
    if (esc === undefined) break;
    if (esc === "u") {
      const hex = raw.slice(i + 2, i + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
      out += String.fromCharCode(parseInt(hex, 16));
      i += 6;
      continue;
    }
    out += ({ n: "\n", t: "\t", r: "\r", b: "\b", f: "\f" } as Record<string, string>)[esc] ?? esc;
    i += 2;
  }
  return out;
}

/** 记忆来源小标记（AgentChatMessage.memoryEntriesUsed）：null = 这位没开节点记忆，不显示 */
export function memoryBadge(m: AgentChatMessage): string | null {
  if (m.memoryEntriesUsed === null) return null;
  return m.memoryEntriesUsed > 0 ? `记忆 ${m.memoryEntriesUsed} 条` : "没用到记忆";
}

export const MEMORY_STATUS_LABEL: Record<NonNullable<ChatRun["memoryManifest"]>["status"], string> = {
  filled: "用到了节点记忆文件夹里的内容",
  empty: "节点记忆文件夹里没有相关的内容",
  unavailable: "此记忆来源不可用（节点没开或读不到）",
};

/** 转议题能不能选这条：被排除的不能选（契约 isExcludedFromContext；没加载到问题的回答交给后端判断） */
export const selectableForTopic = (m: ChatMessage, messages: readonly ChatMessage[]) => !excludedForDisplay(m, messages);

/** 会话列表时间：今天显示时分，否则月-日 */
export function shortTime(iso: string, nowMs: number): string {
  const d = new Date(iso);
  const today = new Date(nowMs);
  const sameDay = d.toDateString() === today.toDateString();
  const pad = (n: number) => String(n).padStart(2, "0");
  return sameDay ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : `${d.getMonth() + 1}-${d.getDate()}`;
}
