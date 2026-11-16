import { z } from "zod";

/** Crockford Base32 ULID body (26 chars). */
const ULID_BODY = "[0-9A-HJKMNP-TV-Z]{26}";

/** 带前缀的 ULID，例如 run_01JABCDEFGHJKMNPQRSTVWXYZ0 */
export const prefixedId = <P extends string>(prefix: P) =>
  z.string().regex(new RegExp(`^${prefix}_${ULID_BODY}$`), `expected ${prefix}_<ULID>`);

export const RunId = prefixedId("run");
export const SnapshotId = prefixedId("snap");
export const ApprovalId = prefixedId("apr");
export const PermissionRequestId = prefixedId("perm");
/** 材料和结构化引用共用；entities.ts 保留原导出位置。 */
export const MessageId = prefixedId("msg");
export type MessageId = z.infer<typeof MessageId>;

// ---- 讨论室（ADR-002 / C-20）
export const RoundId = prefixedId("rnd");
export const BatchId = prefixedId("bat");
export const TurnId = prefixedId("turn");
export const PlanVersionId = prefixedId("plan");

// ---- 聊天空间（ADR-003 / C-34）。放在这里是因为 entities.ts（议题来源、聊天材料）也要用
export const ConversationId = prefixedId("conv");
/** 你发的消息的 id 由发送方生成（防重复，见 chat.send）；秘书的消息由 main 生成 */
export const ChatMessageId = prefixedId("cmsg");

// ---- 项目笔记和换窗口（ADR-005 / C-46）。放在这里是因为 entities.ts / chat.ts 的 Snapshot 要记笔记版本
export const ProjectNoteId = prefixedId("note");
export const ChatWindowId = prefixedId("cwin");
export const ChatWindowDraftId = prefixedId("cwd");
export type ProjectNoteId = z.infer<typeof ProjectNoteId>;
export type ChatWindowId = z.infer<typeof ChatWindowId>;
export type ChatWindowDraftId = z.infer<typeof ChatWindowDraftId>;

// ---- 音频（C-34 的录音和 C-42c 的合成语音共用）。放在这里避免 chat.ts 和 speech.ts 互相引用
/** 音频引用：录音（16k 单声道，main 转好后存的那一份）或合成的语音 */
export const AudioRef = prefixedId("aud");
export type AudioRef = z.infer<typeof AudioRef>;
/** renderer 播放音频用 `room-audio://aud_…`；规则和 room-image 一样（只认引用、只读、不可导航、不拼路径） */
export const AUDIO_URL_SCHEME = "room-audio";

/**
 * SHA-256，小写十六进制。
 * 约定：Prompt 的 hash = sha256(UTF-8 编码的 content 原文)，不做任何规范化。
 */
export const Sha256Hex = z.string().regex(/^[a-f0-9]{64}$/);

/** 完整 40 位 git commit SHA（不接受缩写）。 */
export const CommitSha = z.string().regex(/^[a-f0-9]{40}$/);

export const IsoTimestamp = z.string().datetime({ offset: true });

export type RunId = z.infer<typeof RunId>;
export type SnapshotId = z.infer<typeof SnapshotId>;
export type ApprovalId = z.infer<typeof ApprovalId>;
export type PermissionRequestId = z.infer<typeof PermissionRequestId>;
export type RoundId = z.infer<typeof RoundId>;
export type BatchId = z.infer<typeof BatchId>;
export type TurnId = z.infer<typeof TurnId>;
export type PlanVersionId = z.infer<typeof PlanVersionId>;
export type ConversationId = z.infer<typeof ConversationId>;
export type ChatMessageId = z.infer<typeof ChatMessageId>;
