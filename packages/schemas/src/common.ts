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

// ---- 讨论室（ADR-002 / C-20）
export const RoundId = prefixedId("rnd");
export const BatchId = prefixedId("bat");
export const TurnId = prefixedId("turn");
export const PlanVersionId = prefixedId("plan");

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
