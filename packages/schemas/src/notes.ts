import { z } from "zod";
import {
  ChatMessageId,
  ChatWindowDraftId,
  ChatWindowId,
  ConversationId,
  IsoTimestamp,
  ProjectNoteId,
  RunId,
  Sha256Hex,
  TurnId,
} from "./common";
import { AgentName, ProjectId } from "./entities";

/**
 * 项目笔记和聊天的「换窗口」（ADR-005 / C-46）。
 *
 * - 项目笔记：每位秘书在每个子项目（讨论室的议题、聊天的会话）里一份工作本。存在主控机，版本不可变，
 *   秘书在回答里用 ```room-note 写整份新笔记，用户在界面上改、回退。发给秘书时只带他自己那份（ADR-005 §2）
 * - 换窗口：按（会话, 秘书）。窗口只在「拼回答 Prompt」这一步生效；摘要的规划和谁写摘要都不受影响（ADR-005 §4）
 * - 笔记是秘书写的，按不可信资料处理：拼进 Prompt 时放在带 nonce 的资料边界里，界面只当纯文本 / 受限 Markdown 显示
 */

// ================================================================ 上限

export const PROJECT_NOTE_LIMITS = {
  /** 一份笔记正文的上限（字符） */
  maxChars: 20_000,
  /** 新版不到上一版的这个比例时，时间线提示「这次删了不少」，不拦 */
  shrinkWarnRatio: 0.5,
} as const;

// ================================================================ 项目笔记

/** 笔记属于哪个子项目。以后世界板块再加一种 */
export const NoteScope = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("topic"), projectId: ProjectId }).strict(),
  z.object({ kind: z.literal("conversation"), conversationId: ConversationId }).strict(),
]);
export type NoteScope = z.infer<typeof NoteScope>;

/**
 * 为什么有这一版：
 * - reply         ：秘书在回答里带了 room-note（讨论室记 turnId，聊天记 runId）
 * - window_handoff：换窗口确认时存的交接笔记（只在 conversation 下；记 runId = 写交接的 Run，用户自己写的为 null）
 * - human_edit    ：用户在界面上改的
 * - revert        ：用户回退到某个旧版（内容等于 revertedFromId 那一版）
 */
export const ProjectNoteReason = z.enum(["reply", "window_handoff", "human_edit", "revert"]);
export type ProjectNoteReason = z.infer<typeof ProjectNoteReason>;

export const ProjectNoteSource = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("turn"), turnId: TurnId }).strict(),
  z.object({ kind: z.literal("chat_run"), runId: RunId }).strict(),
]);
export type ProjectNoteSource = z.infer<typeof ProjectNoteSource>;

/**
 * 一版笔记，不可变。同一 (scope, agent) 的版本连成一条链：version 从 1 开始连续，parentId 指向上一版。
 * 「当前笔记」= 这条链上 version 最大的那一版。并发写（秘书回答和用户编辑同时到）由 main 在事务里串行：
 * 秘书的写法总是基于当时的最新版；用户的 projectNote.edit 带 expectedParentId，不是最新就 invalid_state。
 */
export const ProjectNote = z
  .object({
    id: ProjectNoteId,
    scope: NoteScope,
    agent: AgentName,
    version: z.number().int().positive(),
    /** 上一版；version = 1 时为 null */
    parentId: ProjectNoteId.nullable(),
    /** 允许空字符串：秘书或用户可以把笔记清空 */
    content: z.string().max(PROJECT_NOTE_LIMITS.maxChars),
    /** sha256(UTF-8(content))，进 Snapshot 指纹的是 id，这个用来比对和导出 */
    contentHash: Sha256Hex,
    updatedBy: z.enum(["agent", "human"]),
    reason: ProjectNoteReason,
    /** reason = reply 时非 null；window_handoff 时是写交接的 Run（用户选「我自己写」、从没起过 Run 时为 null）；其他为 null */
    source: ProjectNoteSource.nullable(),
    /** reason = revert 时指向被拿回来的那一版 */
    revertedFromId: ProjectNoteId.nullable(),
    /** 比上一版少了一半以上（见 noteShrankALot）；main 存的时候算好，界面据此提示 */
    shrankALot: z.boolean(),
    createdAt: IsoTimestamp,
  })
  .refine((n) => (n.version === 1) === (n.parentId === null), "只有第 1 版没有上一版")
  .refine(
    (n) => (n.reason === "reply" ? n.updatedBy === "agent" : n.reason === "window_handoff" || n.updatedBy === "human"),
    "reply 一定是秘书写的；human_edit / revert 一定是用户；交接笔记看最后是谁写的",
  )
  .refine((n) => n.reason !== "reply" || n.source !== null, "reply 要记是哪一次回答")
  .refine((n) => n.reason === "reply" || n.reason === "window_handoff" || n.source === null, "只有 reply / window_handoff 有来源")
  .refine((n) => (n.reason === "revert") === (n.revertedFromId !== null), "只有 revert 有 revertedFromId")
  .refine((n) => n.reason !== "window_handoff" || n.scope.kind === "conversation", "换窗口只在聊天里")
  .refine(
    (n) => n.source === null || (n.scope.kind === "topic" ? n.source.kind === "turn" : n.source.kind === "chat_run"),
    "讨论室的笔记来源是 Turn，聊天的是 ChatRun",
  );
export type ProjectNote = z.infer<typeof ProjectNote>;

/** 新版是否比上一版少了一半以上（按字符数）。上一版为空时不算 */
export const noteShrankALot = (previous: string, next: string): boolean =>
  previous.length > 0 && next.length < previous.length * PROJECT_NOTE_LIMITS.shrinkWarnRatio;

// ================================================================ ```room-note 代码块

export const NOTE_FENCE = "room-note";

export type RoomNoteExtract =
  /** 回答里没有 room-note */
  | { kind: "none" }
  /** 恰好一段、合格：content 是整份新笔记，text 是去掉这段之后的回答正文（首尾空白已去掉） */
  | { kind: "ok"; content: string; text: string }
  /**
   * 不合格：这次不存笔记，回答照常（text 同样去掉了所有 room-note 段，不把半截笔记显示成正文），
   * 时间线提示「笔记没存上」
   */
  | { kind: "invalid"; reason: "multiple" | "too_long" | "unclosed"; text: string };

/**
 * 从秘书的回答里切出 room-note。规则：
 * - 开头一行是 3 个以上反引号紧跟 `room-note`（行首，后面只能有空白）；结尾是**同样个数**的反引号单独一行。
 *   笔记里要写代码块就用更长的围栏（例如 4 个反引号），和 CommonMark 一样
 * - 只认一段；两段以上 → multiple。没有结尾 → unclosed（从开头到正文结束都当作这段，丢掉）
 * - 内容去掉首尾的空行后 > maxChars → too_long；空内容合法（= 清空笔记）
 * - 讨论室和聊天都用这一个函数，main 和测试不另写一份
 */
export function extractRoomNote(reply: string): RoomNoteExtract {
  const lines = reply.split("\n");
  const blocks: { start: number; end: number | null }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = /^(`{3,})room-note[ \t]*\r?$/.exec(lines[i] ?? "");
    if (!open) continue;
    const fence = open[1] ?? "```";
    let end: number | null = null;
    for (let j = i + 1; j < lines.length; j++) {
      if ((lines[j] ?? "").replace(/[ \t\r]+$/, "") === fence) {
        end = j;
        break;
      }
    }
    blocks.push({ start: i, end });
    if (end === null) break;
    i = end;
  }
  if (blocks.length === 0) return { kind: "none" };

  const keep = lines.filter((_, i) => !blocks.some((b) => i >= b.start && (b.end === null || i <= b.end)));
  const text = keep.join("\n").trim();
  if (blocks.some((b) => b.end === null)) return { kind: "invalid", reason: "unclosed", text };
  if (blocks.length > 1) return { kind: "invalid", reason: "multiple", text };
  const b = blocks[0]!;
  const content = lines
    .slice(b.start + 1, b.end!)
    .join("\n")
    .replace(/\r/g, "")
    .replace(/^\n+|\n+$/g, "");
  if (content.length > PROJECT_NOTE_LIMITS.maxChars) return { kind: "invalid", reason: "too_long", text };
  return { kind: "ok", content, text };
}

// ================================================================ 换窗口（只在聊天里）

/**
 * 一位秘书在一个会话里的一个窗口。第 1 个窗口（没换过）不写记录。
 * 发给这位秘书的回答 Prompt 只带 startsAfterMessageId 之后的消息、来源**全部**在这之后的摘要，以及他的最新笔记。
 */
export const ChatWindow = z
  .object({
    id: ChatWindowId,
    conversationId: ConversationId,
    agent: AgentName,
    /** 第几个窗口，从 2 开始（第 1 个不写记录）；同一 (conversationId, agent) 连续递增 */
    index: z.number().int().min(2),
    /** 边界：这条（含）以前的消息都不再发给他。点「换窗口」那一刻定下（= 草稿上的同名字段） */
    startsAfterMessageId: ChatMessageId,
    /** 确认时存的交接笔记（reason = window_handoff） */
    handoffNoteId: ProjectNoteId,
    /** 由哪份草稿确认来的 */
    draftId: ChatWindowDraftId,
    createdAt: IsoTimestamp,
  })
  .strict();
export type ChatWindow = z.infer<typeof ChatWindow>;

/**
 * 换窗口草稿（ADR-005 §4）。点「换窗口」时建，确认或取消时关。
 * - 同一 (conversationId, agent) 最多一份 pending；已有时 chat.window.prepare 直接返回它，不再起新 Run
 * - content：Run 写好的交接笔记，或用户改过的；Run 还在跑或失败时为 null
 * - 取消只把 state 改成 cancelled：不存笔记、不写窗口；Run 和它的终止事件照常保留
 * - 重启后 pending 的草稿还在；写交接的 Run 被中断修复成失败时，草稿留着、content 仍为 null，可以重写或自己写
 */
export const ChatWindowDraft = z
  .object({
    id: ChatWindowDraftId,
    conversationId: ConversationId,
    agent: AgentName,
    /** 新窗口从这条之后开始，prepare 那一刻会话里的最后一条消息 */
    startsAfterMessageId: ChatMessageId,
    /** 当前写交接的 Run（purpose = window_handoff）；用户选「我自己写」并且从没起过 Run 时为 null */
    runId: RunId.nullable(),
    content: z.string().max(PROJECT_NOTE_LIMITS.maxChars).nullable(),
    /** content 最后是谁写的；content 为 null 时为 null */
    contentBy: z.enum(["agent", "human"]).nullable(),
    state: z.enum(["pending", "confirmed", "cancelled"]),
    /** confirmed 时指向建出来的窗口 */
    windowId: ChatWindowId.nullable(),
    createdAt: IsoTimestamp,
    updatedAt: IsoTimestamp,
  })
  .strict()
  .refine((d) => (d.content === null) === (d.contentBy === null), "有内容才有作者")
  .refine((d) => (d.state === "confirmed") === (d.windowId !== null), "只有 confirmed 有窗口")
  .refine((d) => d.state !== "confirmed" || d.content !== null, "没有内容不能确认");
export type ChatWindowDraft = z.infer<typeof ChatWindowDraft>;

/** 换窗口的提醒线：窗口里压缩到这么多次，聊天顶上显示「建议换窗口」（ADR-002 §9 同一个数） */
export const CHAT_WINDOW_SUGGEST_COMPACTIONS = 3;

/**
 * 会话里每位成员的窗口状态（chat.windows.get），给聊天顶上的记忆条和聊天设置用。
 * compactionsInWindow：来源全部在当前窗口里、并且 current（不是 stale）的历史摘要有几份。
 * 主控端自己数，和节点按秘书报的 AgentStatus.compactions 不是一个口径，界面写「这个窗口压缩 N 次」
 */
export const ChatWindowStatus = z
  .object({
    agent: AgentName,
    /** 当前是第几个窗口（没换过 = 1） */
    index: z.number().int().positive(),
    /** 当前窗口；第 1 个窗口为 null */
    window: ChatWindow.nullable(),
    compactionsInWindow: z.number().int().nonnegative(),
    /** compactionsInWindow >= CHAT_WINDOW_SUGGEST_COMPACTIONS */
    suggestSwitch: z.boolean(),
    /** 有 pending 的草稿时给出来，界面直接打开它 */
    pendingDraft: ChatWindowDraft.nullable(),
  })
  .strict()
  .refine((s) => (s.index === 1) === (s.window === null), "第 1 个窗口没有记录")
  .refine((s) => s.window === null || s.window.index === s.index, "index 和窗口记录一致")
  .refine((s) => s.suggestSwitch === s.compactionsInWindow >= CHAT_WINDOW_SUGGEST_COMPACTIONS, "提醒线按压缩次数算")
  .refine((s) => s.pendingDraft === null || (s.pendingDraft.state === "pending" && s.pendingDraft.agent === s.agent), "只给自己的 pending 草稿");
export type ChatWindowStatus = z.infer<typeof ChatWindowStatus>;

// ================================================================ 同步到 GitHub（ADR-005 §5）

/** owner/name，GitHub 的命名规则 */
export const GithubRepoName = z
  .string()
  .max(140)
  .regex(/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/, "格式是 owner/name")
  .refine((s) => !(s.split("/")[1] ?? "").startsWith(".") && !s.endsWith(".git"), "仓库名不能以 . 开头，不带 .git");
export type GithubRepoName = z.infer<typeof GithubRepoName>;

/** GitHub Token：只在 main 读写，永远不从查询里返回（只返回 tokenSet） */
export const GithubToken = z.string().min(20).max(255).regex(/^[\x21-\x7e]+$/, "Token 只能包含可见 ASCII 字符");

/**
 * 同步状态（github.get）。没填仓库时 repo 为 null，什么都不推。
 * - private：最近一次检查的结果；没检查过为 null。false 时不推（只推私有仓库），lastError = "public_repo"
 * - pending：还没推上去的条数（笔记版本 + 议题导出）。推不上去就排队，下次再推
 * - 推送以主控机为准：先取远端 sha 再覆盖
 */
export const GithubSyncStatus = z
  .object({
    repo: GithubRepoName.nullable(),
    tokenSet: z.boolean(),
    private: z.boolean().nullable(),
    pending: z.number().int().nonnegative(),
    lastPushedAt: IsoTimestamp.nullable(),
    lastError: z.enum(["public_repo", "no_token", "unauthorized", "not_found", "network", "other"]).nullable(),
    /** 给人看的说明，不含 Token、不含笔记原文 */
    lastErrorMessage: z.string().max(500).nullable(),
  })
  .strict()
  .refine((s) => (s.lastError === null) === (s.lastErrorMessage === null), "错误码和说明一起有");
export type GithubSyncStatus = z.infer<typeof GithubSyncStatus>;

/** 笔记在仓库里的路径：notes/<子项目>/<秘书>.md。子项目用 id，名字会改 */
export const githubNotePath = (scope: NoteScope, agent: string): string =>
  `notes/${scope.kind === "topic" ? scope.projectId : scope.conversationId}/${agent}.md`;
