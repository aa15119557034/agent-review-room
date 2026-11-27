import { z } from "zod";
import { SourceReferences } from "./structured-results";
import { AudioRef, ChatMessageId, ConversationId, IsoTimestamp, prefixedId, ProjectNoteId, RunId, Sha256Hex, SnapshotId } from "./common";
import { FailureReason } from "./agent-event";
import { RunState, RunSubstate } from "./state-machines";
import { AgentName } from "./entities";
import { BatchModel, CHAT_PERSONA_MAX_CHARS } from "./discussion";
import { MemoryManifest, MemorySlot, occursExactlyOnce } from "./remote-protocol";
import { ImageRef } from "./appearance";
import {
  ATTACHMENT_LIMITS,
  AttachmentImageSlot,
  AttachmentManifest,
  attachmentImageSlotMarker,
  attachmentManifestBlock,
  imageBlockPlaced,
} from "./attachments";
import { ImmersiveDeferral, MediaIntent } from "./immersive";

/**
 * 聊天空间（ADR-003 / C-34，阶段 1B-2）。
 *
 * 和讨论室的关系：
 * - 聊天**不盖章**：没有 Approval、没有 ApprovalBatch；人发一条就是授权这一次回答
 * - 每次秘书回答仍是一个 Run（ChatRun），用和讨论室同一张 RUN_TRANSITIONS，**每个 Run 恰好一个终止事件**；
 *   流式文字照旧走 ControlEvent `run.event`（AgentEvent 按 runId 区分），中断修复照旧
 * - 秘书之间不会自己接着聊：秘书的消息**永远不建回答位**
 * - 聊天里说的话永远不会直接变成动作；要变成动作只能 chat.toTopic，进讨论室盖章
 *
 * 和 ADR-004（多模态，C-42a～d）的分工：下面这些由 C-42 加在本文件的类型上，C-34 不定义、不重复：
 * - C-42a：图片附件的附件清单（AttachmentManifest）、`ModelOption.vision` 三态（「能看图」看模型，不看人，
 *   所以 AgentProfile 上**没有**「能看图」标记）、ImagePurpose 新增 chat / sticker / material / generated、每条消息的图片张数上限
 * - C-42c：你发的消息上的 `replyAsVoice`
 * - C-42d：ChatAgentOutput 的 reply 分支上的 `speak` / `draw`；沉浸模式设置按会话存，用 immersive.get / immersive.update
 * - C-42e：秘书回答上存下合格的媒体意图（AgentChatMessage.mediaIntent）和沉浸模式的退回原因（immersiveDeferred）
 * C-34 先合并时，这些字段都不存在，旧数据读出来照样合法；C-42 合并后各自按自己的规则补。
 */

// ================================================================ ID

export const ChatSlotId = prefixedId("slot");
/** 聊天里的非图片文件（图片仍用 ImageRef，同一套引用规则，C-32） */
export const FileRef = prefixedId("file");
export const StickerId = prefixedId("stk");
export const ChatSummaryId = prefixedId("csum");

export type ChatSlotId = z.infer<typeof ChatSlotId>;
export type FileRef = z.infer<typeof FileRef>;
export type StickerId = z.infer<typeof StickerId>;
export type ChatSummaryId = z.infer<typeof ChatSummaryId>;

// 录音引用 AudioRef 和播放用的 AUDIO_URL_SCHEME 在 common.ts（C-42c 的合成语音也用）

// ================================================================ 上限（后端强制，不只靠界面）

export const CHAT_LIMITS = {
  /** 一条消息最多几个收件人 = 群聊最多几位秘书 */
  maxRecipients: 8,
  /** 每个会话每分钟最多几条你发的消息（按主控机时间，最近 60 秒滑动计算；重试不计） */
  messagesPerMinute: 6,
  /** 只能撤回 5 分钟内的消息（按主控机时间，界面倒计时只是显示） */
  retractWindowMs: 5 * 60_000,
  /** 撤回之后 5 分钟内可以「重新编辑」 */
  reeditWindowMs: 5 * 60_000,
  textMaxChars: 20_000,
  /** 秘书一次回答的正文上限 */
  replyMaxChars: 200_000,
  /** 一条消息最多几个附件（图片 + 文件合计；图片张数另有 C-42a 的上限） */
  attachmentsPerMessage: 9,
  /** 其中图片最多几张（ADR-004 §2，C-42a） */
  imagesPerMessage: ATTACHMENT_LIMITS.perMessage,
  /** 单个文件（非图片）的上限，D-34a 可以提议调整 */
  fileMaxBytes: 20 * 1024 * 1024,
  /** 录音最长 5 分钟 */
  voiceMaxMs: 5 * 60_000,
  /** chat.voice.import 收的原始录音（base64 之前）上限 */
  voiceImportMaxBytes: 16 * 1024 * 1024,
  stickersMax: 500,
  /** 聊天人设可以很长（ADR-003 §2「上限另定」，这里定 5 万字） */
  chatPersonaMaxChars: CHAT_PERSONA_MAX_CHARS,
  /** 一次 chat.toTopic 最多选几条 */
  toTopicMaxMessages: 200,
} as const;

// ================================================================ 会话

export const ConversationKind = z.enum(["direct", "group"]);
export type ConversationKind = z.infer<typeof ConversationKind>;

const uniqueAgents = (xs: readonly string[]) => new Set(xs).size === xs.length;

const groupMembers = z.array(AgentName).min(2).max(CHAT_LIMITS.maxRecipients).refine(uniqueAgents, "成员不能重复");

/** 新建会话时的成员：单聊恰好一位，群聊 2～8 位、不重复。chat.conversation.create 的入参用它，所以入参就挡住「一位的群聊」 */
export const ConversationMembers = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("direct"), agent: AgentName }).strict(),
  z.object({ kind: z.literal("group"), agents: groupMembers }).strict(),
]);
export type ConversationMembers = z.infer<typeof ConversationMembers>;

/** 群聊改成员（chat.conversation.update）用的同一条规则 */
export const GroupMembers = groupMembers;

/**
 * 单聊 = 你 + 一位；群聊 = 你 + 2～8 位。
 * 会话列表按 lastActivityAt 倒序（置顶的在最前）。1B 不删除会话。
 */
export const Conversation = z
  .object({
    id: ConversationId,
    kind: ConversationKind,
    /** 秘书成员（不含你）。单聊恰好 1 位，群聊 2～8 位，不重复 */
    members: z.array(AgentName).min(1).max(CHAT_LIMITS.maxRecipients).refine(uniqueAgents, "成员不能重复"),
    /** 你起的名字（单聊相当于备注名）；null 时单聊显示对方名字，群聊显示成员名拼起来 */
    title: z.string().trim().min(1).max(60).nullable(),
    pinned: z.boolean(),
    /** 免打扰：不弹通知，未读只显示小红点不显示数字 */
    muted: z.boolean(),
    /** 你读到哪一条；从没读过为 null。未读数由 main 按它算 */
    lastReadMessageId: ChatMessageId.nullable(),
    /** 最近一条消息（任何人）的时间；新建的会话等于 createdAt */
    lastActivityAt: IsoTimestamp,
    createdAt: IsoTimestamp,
  })
  .refine((c) => (c.kind === "direct" ? c.members.length === 1 : c.members.length >= 2), "单聊恰好 1 位，群聊至少 2 位");
export type Conversation = z.infer<typeof Conversation>;

// ================================================================ 你发的消息：内容

/**
 * @ 了谁。**只看这个结构化字段**：正文里打的「@汐」、引用、语音转写、附件里出现的 @ 都不改变收件人。
 * - none  ：没点名。单聊里只能是 none（对方总是回答）
 * - all   ：@所有人
 * - agents：@某几位，必须都是会话成员、不重复
 */
export const ChatMentions = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z.object({ kind: z.literal("all") }).strict(),
  z
    .object({
      kind: z.literal("agents"),
      agents: z.array(AgentName).min(1).max(CHAT_LIMITS.maxRecipients).refine(uniqueAgents, "不能重复"),
    })
    .strict(),
]);
export type ChatMentions = z.infer<typeof ChatMentions>;

/**
 * 附件。只存引用，renderer 拿不到路径；名字是原文件名，进 Prompt 时由拼装器转义（X-30）。
 * - image：发给能看图的模型；其他人收到「[图片：文件名]」（C-42a 管处理、清单和 vision）
 * - file ：isText 为 true 的按附件规则进不可信边界；否则（PDF / Word 等，1B 不解析）只发「[文件：文件名]」
 */
export const ChatAttachment = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("image"), ref: ImageRef, name: z.string().min(1).max(255) }).strict(),
  z
    .object({
      kind: z.literal("file"),
      ref: FileRef,
      name: z.string().min(1).max(255),
      /** main 按文件头判断出来的类型，不看扩展名 */
      mime: z.string().regex(/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/).max(100),
      bytes: z.number().int().positive().max(CHAT_LIMITS.fileMaxBytes),
      sha256: Sha256Hex,
      /** main 判断能当 UTF-8 文本读（txt / md / csv / json / 代码）。只有它为 true 的文件正文进 Prompt */
      isText: z.boolean(),
    })
    .strict(),
]);
export type ChatAttachment = z.infer<typeof ChatAttachment>;

/** 语音转写结果。transcribed = 引擎原样；edited = 你发送前改过 */
export const VoiceTranscript = z
  .object({
    text: z.string().trim().min(1).max(CHAT_LIMITS.textMaxChars),
    /** BCP 47，例如 zh-CN；引擎没给出时为 null */
    language: z.string().regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/).nullable(),
    source: z.enum(["transcribed", "edited"]),
    /** 转写引擎和模型版本，例如 { engine: "sherpa-onnx", model: "paraformer-zh-2024-03" }（D-34b 实测后定） */
    engine: z.object({ engine: z.string().min(1).max(40), model: z.string().min(1).max(80) }).strict(),
  })
  .strict();
export type VoiceTranscript = z.infer<typeof VoiceTranscript>;

/**
 * 一条消息的内容。发给秘书的永远是文字：
 * - text   ：正文 + 附件（正文可以为空字符串，但这时至少要有一个附件）
 * - voice  ：发的是转写文字（秘书听不到声音）；原录音和转写都在备份 / 导出范围内
 * - sticker：静态表情（png / jpeg / webp，没有 GIF）；发给秘书的是「[表情：说明]」，说明在发送时从表情库抄下来
 */
export const ChatContent = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("text"),
      text: z.string().max(CHAT_LIMITS.textMaxChars),
      attachments: z.array(ChatAttachment).max(CHAT_LIMITS.attachmentsPerMessage),
    })
    .strict(),
  z
    .object({
      kind: z.literal("voice"),
      audio: AudioRef,
      durationMs: z.number().int().positive().max(CHAT_LIMITS.voiceMaxMs),
      transcript: VoiceTranscript,
    })
    .strict(),
  z
    .object({
      kind: z.literal("sticker"),
      stickerId: StickerId,
      image: ImageRef,
      label: z.string().trim().min(1).max(40),
    })
    .strict(),
]).refine((c) => c.kind !== "text" || c.text.trim().length > 0 || c.attachments.length > 0, "正文和附件不能都为空")
  .refine(
    (c) => c.kind !== "text" || c.attachments.filter((a) => a.kind === "image").length <= CHAT_LIMITS.imagesPerMessage,
    `一条消息最多 ${CHAT_LIMITS.imagesPerMessage} 张图片`,
  );
export type ChatContent = z.infer<typeof ChatContent>;

/**
 * C-42i：图片附件随 chat.send 带上的原文件名。只是个名字：去掉首尾空白后 1～255 字，
 * 不能有路径分隔符（/ \\）、控制字符（Cc：C0、DEL、C1）、格式字符（Cf：双向控制 U+202A–202E / U+2066–2069、
 * U+200E/200F、零宽 U+200B 等）和行/段分隔符（U+2028 / U+2029）——防界面上的名字被伪装、防在 Prompt 里插一行（汐 #150）。
 * 进 Prompt 时照旧由拼装器转义（X-30），这里不负责转义。main 在 pick 返回前也会规范化（D-43），这里是第二道防线
 */
export const ChatImageInputName = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .regex(/^[^/\\\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+$/u, "图片名不能带路径、控制字符或隐藏的格式字符");
export type ChatImageInputName = z.infer<typeof ChatImageInputName>;

/**
 * chat.send 里你交上来的内容：**只有引用和你自己写的字**，其余元数据由 main 从自己的记录里填，不信客户端：
 * - 附件：只传 ref。name / mime / bytes / sha256 / isText 由 main 按 chat.attachment.pick 时存下的记录填。
 *   例外（C-42i）：图片按内容去重，同一个 ref 可能来自不同文件名，main 记不住「这一次」叫什么，
 *   所以图片可以带上 chat.attachment.pick 返回的 name（只用于显示和资料区里转义后的图名，不参与任何校验）；
 *   不带时 main 用「图片.<扩展名>」占位。文件的 name 仍然只从 main 的记录里取
 * - 语音：只传 audio 和你（可能改过的）转写文字。durationMs、language、engine 从 VoiceRecording 填；
 *   录音必须是 ready；transcriptText 和引擎原样转写逐字相同 → source = transcribed，否则 edited
 * - 表情：只传 stickerId。image 和 label 发送时从表情库抄
 * 引用不存在、不属于聊天、录音不是 ready → validation_failed。存进 UserChatMessage 的是 main 填完的 ChatContent。
 */

export const ChatAttachmentInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("image"), ref: ImageRef, name: ChatImageInputName.optional() }).strict(),
  z.object({ kind: z.literal("file"), ref: FileRef }).strict(),
]);
export type ChatAttachmentInput = z.infer<typeof ChatAttachmentInput>;

export const ChatContentInput = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("text"),
      text: z.string().max(CHAT_LIMITS.textMaxChars),
      attachments: z.array(ChatAttachmentInput).max(CHAT_LIMITS.attachmentsPerMessage),
    })
    .strict(),
  z
    .object({
      kind: z.literal("voice"),
      audio: AudioRef,
      transcriptText: z.string().trim().min(1).max(CHAT_LIMITS.textMaxChars),
    })
    .strict(),
  z.object({ kind: z.literal("sticker"), stickerId: StickerId }).strict(),
]).refine((c) => c.kind !== "text" || c.text.trim().length > 0 || c.attachments.length > 0, "正文和附件不能都为空")
  .refine(
    (c) => c.kind !== "text" || c.attachments.filter((a) => a.kind === "image").length <= CHAT_LIMITS.imagesPerMessage,
    `一条消息最多 ${CHAT_LIMITS.imagesPerMessage} 张图片`,
  )
  .refine((c) => c.kind !== "text" || new Set(c.attachments.map((a) => a.ref)).size === c.attachments.length, "同一个附件不能放两次");
export type ChatContentInput = z.infer<typeof ChatContentInput>;

// ================================================================ 消息

/**
 * 你发的消息的状态：
 * - sent     ：正常
 * - retracted：已撤回。原文仍在数据库里（消息详情能看到），但撤回之后新建的任何 Snapshot / Run / 摘要 / 议题材料都不再带它；
 *              已经发出去的（不可变的旧 Snapshot、模型已经看到的）收不回来。只能 sent → retracted，不能撤销撤回
 */
export const ChatMessageState = z.enum(["sent", "retracted"]);
export type ChatMessageState = z.infer<typeof ChatMessageState>;

const chatMessageBase = {
  id: ChatMessageId,
  conversationId: ConversationId,
  /**
   * 与消息同一事务写入后不可修改；撤回/重新解析不回写旧引用。
   * 共用挂载位有意覆盖用户/秘书消息；D08 首片只由 main 为秘书回答写入，不采信用户自报引用。
   */
  sourceRefs: SourceReferences.optional(),
  /** 主控机时间（撤回窗口按它算） */
  createdAt: IsoTimestamp,
};

export const UserChatMessage = z
  .object({
    ...chatMessageBase,
    sender: z.literal("user"),
    content: ChatContent,
    mentions: ChatMentions,
    /**
     * 引用的那条消息；它的内容按资料进不可信边界，引用里的 @ 不算点名。
     * 被引用的消息「已被排除」（见 isExcludedFromContext）时，之后的 Prompt 不再带它
     */
    quoteMessageId: ChatMessageId.nullable(),
    /** 重新编辑：指向被撤回的原消息，显示在原来的位置，带「已重新编辑」标记 */
    replacesMessageId: ChatMessageId.nullable(),
    /**
     * C-42c：「用语音回」。true = 这条消息的回答都合成语音（authorization = reply_as_voice）。
     * 省略 = 没开（旧消息也是省略）。只看这个开关，不看秘书输出里的 speak
     */
    replyAsVoice: z.literal(true).optional(),
    state: ChatMessageState,
    retractedAt: IsoTimestamp.nullable(),
  })
  .refine((m) => (m.state === "retracted") === (m.retractedAt !== null), "只有撤回的消息有 retractedAt")
  .refine((m) => m.replacesMessageId !== m.id, "不能替换自己");
export type UserChatMessage = z.infer<typeof UserChatMessage>;

/**
 * 秘书的回答。只在回答位结局为 answered 时写入，和 Run 的终态同一事务。秘书的消息不能撤回，记录本身也不变。
 * 它回答的那条消息被撤回后，这条回答也从之后的上下文里排除（记录保留）；界面靠 chat.slot.updated（回答位变 retracted）知道，
 * 没有 chat.message.updated。
 */
export const AgentChatMessage = z
  .object({
    ...chatMessageBase,
    sender: z.literal("agent"),
    agent: AgentName,
    /** 正文（正本）。秘书不发图片和音频本身；想画图 / 想用语音说放在下面的 mediaIntent */
    text: z.string().max(CHAT_LIMITS.replyMaxChars).refine((t) => t.trim().length > 0, "回答不能是空白"),
    /** 回答的是哪条你发的消息、哪个回答位、哪个 Run */
    inReplyTo: ChatMessageId,
    slotId: ChatSlotId,
    runId: RunId,
    /** 界面的「记忆来源」小标记：这次用到了几条节点记忆；没有记忆槽位为 null。来自 ChatRun.memoryManifest */
    memoryEntriesUsed: z.number().int().nonnegative().nullable(),
    /**
     * C-42e：这条回答里合格的媒体意图（extractMediaIntent 的 intent），和回答同一个事务写入，沉浸模式关着也照存；一项都没有就省略。
     * 被丢掉的不合格原始值不在这里：Run 的原始输出（message_complete）里本来就有，调用方另记一条审计日志，界面不显示。
     * 界面靠它显示：
     * - draw ：画图请求卡（沉浸模式关着，或被退回时）；相关的任务：media.list 列这个会话的媒体任务，客户端按 source.messageId 过滤
     * - speak：「秘书想用语音说」的播放按钮（关着时不自动合成，见 C-42c / C-42d）；只有朗读文本在上限内才会有
     * 你那条消息被撤回后（回答位变 retracted），界面不再显示这条回答的请求卡和播放按钮；记录本身不变
     */
    mediaIntent: MediaIntent.refine((i) => i.speak !== undefined || i.draw !== undefined, "没有媒体意图就省略").optional(),
    /**
     * C-42e：沉浸模式开着、但意图没有自动执行（见 ImmersiveDeferral）。只能退回这条确实带了的意图；
     * 沉浸模式关着时省略（本来就不自动执行）。是写入那一刻的记录，之后手动执行了也不改：界面以任务 / 语音片段为准
     */
    immersiveDeferred: ImmersiveDeferral.optional(),
  })
  .strict()
  .refine(
    (m) =>
      m.immersiveDeferred === undefined ||
      ((m.immersiveDeferred.speak === undefined || m.mediaIntent?.speak === true) &&
        (m.immersiveDeferred.draw === undefined || m.mediaIntent?.draw !== undefined)),
    "只能退回这条回答带了的媒体意图",
  );
export type AgentChatMessage = z.infer<typeof AgentChatMessage>;

export const ChatMessage = z.union([UserChatMessage, AgentChatMessage]);
export type ChatMessage = z.infer<typeof ChatMessage>;

/**
 * 一条消息是否已从之后的上下文里排除（ADR-003 §2）。拼 Snapshot、写摘要、引用（quoteMessageId）、转议题都用这一条规则：
 * - 你的消息：已撤回
 * - 秘书的回答：它回答的那条（inReplyTo）已撤回
 * 被排除的消息不能被新消息引用、不能被转议题（invalid_state），也不能进新的 Snapshot / 摘要。
 * inReplyToOf 由调用方按 inReplyTo 查出那条你的消息传进来；查不到（返回 undefined）**按已排除处理**（宁严勿松），调用方不用另外判断。
 */
export const isExcludedFromContext = (m: ChatMessage, inReplyToOf: (id: string) => UserChatMessage | undefined): boolean =>
  m.sender === "user" ? m.state === "retracted" : inReplyToOf(m.inReplyTo)?.state !== "sent";

// ================================================================ 回答位

/**
 * 回答位的结局（ADR-003：聊天用自己的集合，**不改讨论室的 TurnOutcome**）。
 * - running     ：Run 已建（QUEUED～RUNNING）
 * - answered    ：Run COMPLETED，输出是合法的 reply，已写 AgentChatMessage
 * - skipped     ：没点名时秘书给出明确的 `skip`。Run 正常结束、不建消息；界面显示「这条没有回」，不算缺席
 * - absent_quota：Run FAILED(quota_exhausted)，或发送时已知额度缺席（这时没有 Run）
 * - unavailable ：发送时这位不能答（节点不通 / 没配聊天 profile / 你暂停了他），没有 Run。其他人照常回答
 * - failed      ：其他失败，见 failure（空输出、解析失败、不该 skip 却 skip、超时、Run 失败、中断修复）
 * - cancelled   ：你点了停（chat.cancelReply）
 * - retracted   ：你撤回了这条消息（终态）
 * failed / absent_quota / unavailable / cancelled 可以单独重试（回到 running，新 Snapshot、新 Run），不会重发给别人。
 */
export const ChatSlotOutcome = z.enum([
  "running",
  "answered",
  "skipped",
  "absent_quota",
  "unavailable",
  "failed",
  "cancelled",
  "retracted",
]);
export type ChatSlotOutcome = z.infer<typeof ChatSlotOutcome>;

export const CHAT_SLOT_TRANSITIONS: Readonly<Record<ChatSlotOutcome, readonly ChatSlotOutcome[]>> = {
  running: ["answered", "skipped", "absent_quota", "failed", "cancelled", "retracted"],
  // 已答 / 不回答：不能重试，只能随消息撤回
  answered: ["retracted"],
  skipped: ["retracted"],
  // 可以单独重试
  absent_quota: ["running", "retracted"],
  unavailable: ["running", "retracted"],
  failed: ["running", "retracted"],
  cancelled: ["running", "retracted"],
  retracted: [],
};

/** 发送时就能确定的结局（没有 Run） */
export const CHAT_SLOT_INITIAL_OUTCOMES = ["running", "absent_quota", "unavailable"] as const satisfies readonly ChatSlotOutcome[];

export const ChatSlotFailure = z
  .object({
    kind: z.enum([
      "empty_output",      // Run 完成了但没有任何文字
      "parse_error",       // 不是合法的 ChatAgentOutput（包括半截 JSON、多余字段）
      "skip_not_allowed",  // 单聊或被点名的人给出 skip
      "timed_out",         // Run TIMED_OUT
      "run_failed",        // Run FAILED（额度以外的原因，见 ChatRun.failureReason）
      "interrupted",       // 应用重启时中断修复
    ]),
    /** 给人看的说明。不含 Prompt 原文和密钥 */
    message: z.string().max(2000),
  })
  .strict();
export type ChatSlotFailure = z.infer<typeof ChatSlotFailure>;

/**
 * 一次发送 = 一组回答位，唯一键是 (userMessageId, agent)。所有回答位和 Run 在同一个事务里建出来。
 *
 * 谁有回答位（D-31b 实现，X-31 测）：
 * - 单聊：对方，required = true
 * - 群聊 mentions = all：全部成员，required = true
 * - 群聊 mentions = agents：只有被点到的人，required = true；没点到的人这条不建回答位
 * - 群聊 mentions = none：全部成员，required = false（可以 skip）
 *
 * 迟到结果（D-31b 必须这样实现，X-31 要测「旧 Run 在新尝试开始之后才结束」）：
 * - 处理任何 Run 事件前，先核对 event.runId === slot.runId（当前这次尝试）。不相等 = 旧尝试：只更新那个 ChatRun 自己的记录，
 *   **回答位、回答消息一概不动**
 * - 相等但回答位已经是 retracted / cancelled：结果丢弃，不会改回 answered
 * - 唯一约束 (slotId, attempt)：连点两次重试只建一个 Run
 */
export const ChatReplySlot = z
  .object({
    id: ChatSlotId,
    conversationId: ConversationId,
    userMessageId: ChatMessageId,
    agent: AgentName,
    /** true = 必须回答（skip 算失败）；false = 没点名，可以 skip */
    required: z.boolean(),
    outcome: ChatSlotOutcome,
    /** 当前（最近一次）尝试的 Run；absent_quota / unavailable 发生在建 Run 之前时为 null */
    runId: RunId.nullable(),
    /** 第几次尝试，从 1 开始；每次重试 +1。旧的 Run 归档保留 */
    attempt: z.number().int().positive(),
    /** answered 时指向回答；撤回后保留 */
    replyMessageId: ChatMessageId.nullable(),
    /** 只在 failed 时非 null */
    failure: ChatSlotFailure.nullable(),
    /** 只在 unavailable 时非 null */
    unavailableReason: z.enum(["offline", "unconfigured", "paused_by_user"]).nullable(),
    createdAt: IsoTimestamp,
    /** running 时为 null */
    finishedAt: IsoTimestamp.nullable(),
  })
  // 撤回时保留撤回前的 replyMessageId / failure / unavailableReason（审计用），所以 retracted 两样都允许
  .refine((s) => (s.outcome === "answered" ? s.replyMessageId !== null : s.replyMessageId === null || s.outcome === "retracted"), "只有 answered（或撤回前已答的 retracted）有回答")
  .refine((s) => (s.outcome === "failed" ? s.failure !== null : s.failure === null || s.outcome === "retracted"), "只有 failed（或撤回前失败的 retracted）有 failure")
  .refine(
    (s) => (s.outcome === "unavailable" ? s.unavailableReason !== null : s.unavailableReason === null || s.outcome === "retracted"),
    "只有 unavailable（或撤回前不能答的 retracted）有原因",
  )
  .refine(
    (s) => !["running", "answered", "skipped", "failed", "cancelled"].includes(s.outcome) || s.runId !== null,
    "running / answered / skipped / failed / cancelled 必须有 Run",
  )
  .refine((s) => s.outcome !== "unavailable" || s.runId === null, "unavailable 是发送时判断的，没有 Run")
  .refine((s) => (s.outcome === "running") === (s.finishedAt === null), "只有 running 没有结束时间")
  .refine((s) => !(s.required && s.outcome === "skipped"), "必须回答的人不能是 skipped（应为 failed/skip_not_allowed）");
export type ChatReplySlot = z.infer<typeof ChatReplySlot>;

// ================================================================ 秘书的输出格式

/**
 * 聊天 Run 的输出（message_complete 的全文）必须**整段**是一个 JSON 对象（首尾空白可以有，别的不行）：
 * - { "kind": "reply", "text": "…" }
 * - { "kind": "skip" }
 * 两种都 strict，多一个字段就是 parse_error。reply 上另外允许 speak / draw 两个媒体意图入口（C-42d）：
 * 这一层不校验它们的内容，由 extractMediaIntent（immersive.ts）各自校验，不合格只丢那一项、不让整条回答失败；
 * skip 带了它们照样是 parse_error。
 * 解析失败按失败记，**不降级成 skip**；只有完整合法的 reply 才建消息。
 * 单聊或被点名的人给出 skip → failed(skip_not_allowed)，不能悄悄显示成「不回答」。
 * 分类顺序：整段输出去空白后为空 → empty_output；不是 JSON 或不合下面的 schema → parse_error；
 * 合法 JSON、kind 为 reply 但 text 去空白后为空 → empty_output（schema 也拒绝它，所以空白回答不可能变成 answered）。
 */
export const ChatAgentOutput = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("reply"),
      text: z.string().max(CHAT_LIMITS.replyMaxChars).refine((t) => t.trim().length > 0, "empty_output"),
      /** C-42d：媒体意图入口，内容见 extractMediaIntent */
      speak: z.unknown().optional(),
      draw: z.unknown().optional(),
    })
    .strict(),
  z.object({ kind: z.literal("skip") }).strict(),
]);
export type ChatAgentOutput = z.infer<typeof ChatAgentOutput>;

// 记忆槽位（MemorySlot）和记忆清单（MemoryManifest）是节点协议的一部分，定义在 remote-protocol.ts

// ================================================================ Snapshot 和 Run

/**
 * 聊天的 Snapshot：主控端拼的部分，不可变、落库、算 hash。和讨论室的 PromptSnapshot 共用 snap_ 的 id 空间，
 * 所以节点那边（StartRun.snapshot）没有区别。
 * 每次尝试（包括重试）都**重新拼一份新的** Snapshot：撤回之后旧 Snapshot 不能被重发。
 * purpose 和用它的 ChatRun.purpose 相同：
 * - reply          ：回答 userMessageId 那条消息（非 null）
 * - history_summary：给较早的历史写摘要，userMessageId 为 null；includedMessageIds 至少一条，
 *                    并且等于这次生成的 ChatHistorySummary.sourceMessageIds（同一次拼装）
 * - window_handoff ：换窗口时写交接笔记（ADR-005 §4），userMessageId 为 null。内容 = 他当前窗口里会收到的历史 + 他现在的笔记
 *
 * C-46（ADR-005）：reply / window_handoff 的 Snapshot 要带上这位秘书在这个会话的最新项目笔记（放在 nonce 资料边界里），
 * 用的哪一版记在 projectNoteId，算进指纹；换过窗口的，includedMessageIds / includedSummaryIds 只有窗口里的
 * （被引用的窗口前消息只写占位，不算进 includedMessageIds）
 */
export const ChatSnapshot = z
  .object({
    id: SnapshotId,
    /**
     * 与 Snapshot 同一事务写入后不可修改；撤回只影响后续使用，不回写旧版本/hash/status。
     * 仅展示和溯源，不在 contentHash 中，不能证明模型确实读过资料或盖章绑定了这些来源。
     * 以后若需盖章绑定来源，须另开契约将来源清单写入 content，像附件清单一样受 hash 覆盖。
     */
    sourceRefs: SourceReferences.optional(),
    purpose: z.enum(["reply", "history_summary", "window_handoff"]),
    conversationId: ConversationId,
    userMessageId: ChatMessageId.nullable(),
    agent: AgentName,
    /** 主控端拼好的全文（含记忆槽位 marker，不含记忆正文） */
    content: z.string().min(1).max(2_000_000),
    /** sha256(UTF-8(content)) */
    contentHash: Sha256Hex,
    /**
     * 这次拼装用的边界 nonce。一份 Snapshot 只有一个 nonce：主控端包历史 / 摘要 / 附件用它，
     * 节点包记忆也用它（所以 memorySlot.nonce 必须等于它）
     */
    nonce: z.string().regex(/^[a-f0-9]{16,64}$/),
    /** 没开节点记忆时为 null。marker 在 content 里必须恰好出现一次 */
    memorySlot: MemorySlot.nullable(),
    /**
     * C-42a：这一次实际发给这位秘书的图片清单（权威），规则同 PromptSnapshot.attachments：
     * content 以 attachmentManifestBlock(attachments) 开头（记忆槽位 marker 在它后面）。
     * 省略 = 没带图（包括这次用的模型看不了图、只收到「[图片：文件名]」占位的情况）
     */
    attachments: AttachmentManifest.optional(),
    /**
     * C-42g：图片位置标记 = attachmentImageSlotMarker(nonce)。不带图时省略；带图却没有标记的 Snapshot 暂时能存，但起跑不了（StartRun 带图必须有 imageSlot）；这是过渡，D-36b / X-34 的拼装器都写上图片资料块后收紧成「有 attachments 就必须有 imageSlot」。
     * content 里有恰好一块 attachmentImageBlock(nonce, 张数)、在清单块后面、在当前用户消息之前（最后一条由拼装器验收保证，见 attachments.ts）。起跑时原样放进 StartRun.imageSlot
     */
    imageSlot: AttachmentImageSlot.optional(),
    /** 拼进来的消息（历史、引用、当前这条）和摘要。撤回审计用：撤回后拼的 Snapshot 不能含被排除的消息 id（见 isExcludedFromContext） */
    includedMessageIds: z.array(ChatMessageId).min(1).max(10_000),
    includedSummaryIds: z.array(ChatSummaryId).max(100),
    /**
     * C-46：这次带上的项目笔记版本。null = 他在这个会话还没有笔记；省略 = C-46 之前的 Snapshot，或 history_summary
     * （写摘要不带笔记）
     */
    projectNoteId: ProjectNoteId.nullable().optional(),
    adapterVersion: z.string().min(1),
    tokenEstimate: z.number().int().nonnegative(),
    createdAt: IsoTimestamp,
  })
  .refine((s) => (s.purpose === "reply") === (s.userMessageId !== null), "只有 reply 有 userMessageId")
  .refine((s) => s.purpose !== "history_summary" || s.projectNoteId === undefined, "写摘要不带笔记")
  .refine((s) => s.memorySlot === null || s.memorySlot.nonce === s.nonce, "记忆槽位和 Snapshot 用同一个 nonce")
  .refine((s) => s.memorySlot === null || occursExactlyOnce(s.content, s.memorySlot.marker), "记忆槽位 marker 必须在 content 里恰好出现一次")
  .refine(
    (s) => s.attachments === undefined || s.content.startsWith(attachmentManifestBlock(s.attachments)),
    "带图时 content 要以附件清单块开头",
  )
  .refine((s) => s.imageSlot === undefined || s.attachments !== undefined, "不带图时不能有 imageSlot")
  .refine(
    (s) =>
      s.attachments === undefined ||
      s.imageSlot === undefined ||
      (s.imageSlot === attachmentImageSlotMarker(s.nonce) &&
        imageBlockPlaced(s.content, s.attachments, s.imageSlot)),
    "imageSlot 要用这份 Snapshot 的 nonce，content 里恰好一块图片资料块，在清单块后面，标记只在块里出现一次",
  );
export type ChatSnapshot = z.infer<typeof ChatSnapshot>;

/**
 * 聊天的 Run（kind = "chat"）。和讨论室的 Run 分开定义，因为它没有 Approval、没有议题；
 * 状态、子状态、失败原因、终止事件和讨论室完全一样（RUN_TRANSITIONS）。数据库是否同表由 D-31a 决定。
 * purpose：
 * - reply          ：回答某个回答位
 * - history_summary：给本会话较早的历史写摘要（没有回答位；谁来写、什么时候写由 D-31b 定）
 * - window_handoff ：换窗口时写交接笔记（C-46，没有回答位，收尾和 history_summary 一样走 slotId = null 的路径）。
 *                    结果写进 ChatWindowDraft.content，不直接存成笔记；草稿取消时 Run 照常保留
 */
export const ChatRun = z
  .object({
    id: RunId,
    kind: z.literal("chat"),
    purpose: z.enum(["reply", "history_summary", "window_handoff"]),
    conversationId: ConversationId,
    /** purpose = reply 时非 null */
    slotId: ChatSlotId.nullable(),
    agent: AgentName,
    snapshotId: SnapshotId,
    /** = ChatSnapshot.contentHash（主控端拼的部分） */
    snapshotHash: Sha256Hex,
    /**
     * 最终实际发出内容（记忆填进槽位之后）的 sha256，由节点计算并回报（prompt_final 事件）。
     * 没有槽位时等于 snapshotHash。节点回报之前为 null；Run 在节点开始前就结束了也是 null。聊天不盖章，只用于事后核对
     */
    finalPromptHash: Sha256Hex.nullable(),
    /** 节点回报的记忆清单；没有槽位、或节点回报之前为 null */
    memoryManifest: MemoryManifest.nullable(),
    /** 按参与者 modelSettings 的「聊天」场合在发送时定下（规则同 AgentModelSettings 的 1～4）；null = 用 profile 自带的 */
    model: BatchModel.nullable(),
    adapterId: z.string().min(1),
    state: RunState,
    substate: RunSubstate.nullable(),
    failureReason: FailureReason.nullable(),
    createdAt: IsoTimestamp,
    startedAt: IsoTimestamp.nullable(),
    finishedAt: IsoTimestamp.nullable(),
  })
  .refine((r) => (r.purpose === "reply") === (r.slotId !== null), "只有 reply 有回答位")
  .refine((r) => (r.state === "RUNNING") === (r.substate !== null), "只有 RUNNING 有子状态")
  .refine((r) => (r.state === "FAILED") === (r.failureReason !== null), "只有 FAILED 有失败原因");
export type ChatRun = z.infer<typeof ChatRun>;

// ================================================================ 历史摘要

/**
 * 本会话较早历史的摘要（和讨论室的压缩方式一样：最近的全文、更早的用摘要）。
 * 摘要也是不可信资料，不升级成指令。
 * 记下来源消息：其中任何一条被撤回，摘要在同一事务里变成 stale，下次发送前重建，stale 的摘要不再进任何 Snapshot。
 */
export const ChatHistorySummary = z.object({
  id: ChatSummaryId,
  conversationId: ConversationId,
  sourceMessageIds: z.array(ChatMessageId).min(1).max(10_000),
  content: z.string().min(1).max(200_000),
  contentHash: Sha256Hex,
  state: z.enum(["current", "stale"]),
  /** 写摘要的那个 Run（purpose = history_summary） */
  runId: RunId,
  agent: AgentName,
  createdAt: IsoTimestamp,
});
export type ChatHistorySummary = z.infer<typeof ChatHistorySummary>;

// ================================================================ 语音、表情

/**
 * 一段录音。chat.voice.import 之后先是 transcribing，转写完成后 ready（带引擎给出的原样转写）或 failed。
 * 转写在主控机本地的独立进程里做，不上传第三方（D-34b）。
 * 发送时你可以先改转写文字，发出去的那份在 ChatContent.voice.transcript 里。
 */
export const VoiceRecording = z
  .object({
    audio: AudioRef,
    durationMs: z.number().int().positive().max(CHAT_LIMITS.voiceMaxMs),
    status: z.enum(["transcribing", "ready", "failed"]),
    /** ready 时非 null，source 一定是 transcribed */
    transcript: VoiceTranscript.nullable(),
    /** failed 时的说明 */
    error: z.string().max(2000).nullable(),
    createdAt: IsoTimestamp,
  })
  .refine((v) => (v.status === "ready") === (v.transcript !== null), "只有 ready 有转写")
  .refine((v) => v.transcript === null || v.transcript.source === "transcribed", "引擎给的转写是 transcribed")
  .refine((v) => (v.status === "failed") === (v.error !== null), "只有 failed 有错误说明");
export type VoiceRecording = z.infer<typeof VoiceRecording>;

/** 你的表情库里的一张。label 是发给秘书的说明（「[表情：小鲸鱼比心]」） */
export const Sticker = z.object({
  id: StickerId,
  image: ImageRef,
  label: z.string().trim().min(1).max(40),
  createdAt: IsoTimestamp,
});
export type Sticker = z.infer<typeof Sticker>;

/** 会话列表的一行 */
export const ConversationListItem = z.object({
  conversation: Conversation,
  lastMessage: ChatMessage.nullable(),
  unreadCount: z.number().int().nonnegative(),
  /** 还有几个回答位是 running（列表上显示「汐回答中」） */
  runningSlots: z.number().int().nonnegative(),
});
export type ConversationListItem = z.infer<typeof ConversationListItem>;

/** 消息分页游标：按 (createdAt, id) 倒序 */
export const ChatCursor = z.object({ createdAt: IsoTimestamp, id: ChatMessageId }).strict();
export type ChatCursor = z.infer<typeof ChatCursor>;
