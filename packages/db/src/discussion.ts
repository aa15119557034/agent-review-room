import { createHash, randomUUID } from "node:crypto";
import { canTransition, ROUND_TRANSITIONS, type RoundState } from "@room/schemas";
import type { SqliteDatabase } from "./database";
import { writeTransaction, type WriteQueue } from "./write-queue";

/**
 * 讨论室的写入路径（ADR-002 / D-21）。
 *
 * 这里只负责「记录」：轮、批、发言、以及「一次盖章 → N 个 Run」。
 * Run 真正怎么跑在 apps/desktop/src/main/orchestrator.ts，不在这里。
 */

export type BatchApproveErrorCode =
  | "batch_not_found"
  | "batch_not_ready"
  | "item_missing"
  | "approval_not_ready"
  | "hash_mismatch"
  | "round_transition_invalid"
  | "turn_not_pending";

export class BatchApproveError extends Error {
  readonly code: BatchApproveErrorCode;
  constructor(code: BatchApproveErrorCode, message: string) {
    super(message);
    this.name = "BatchApproveError";
    this.code = code;
  }
}

export interface BatchApproveItem {
  approvalId: string;
  /** 确认页上展示的指纹；和库里、和内容重算出来的都必须一致 */
  expectedContentHash: string;
}

export interface ApproveBatchInput {
  batchId: string;
  items: BatchApproveItem[];
  via: "desktop" | "mobile";
}

export interface ApproveBatchResult {
  batchId: string;
  roundId: string;
  runIds: string[];
  turnIds: string[];
}

const now = (): string => new Date().toISOString();

/** 26 位 Crockford Base32 的 ULID 体（时间有序 + 随机后缀），和契约的前缀拼起来 */
function ulid(): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let time = Date.now();
  let timePart = "";
  for (let i = 0; i < 10; i += 1) {
    timePart = alphabet[time % 32] + timePart;
    time = Math.floor(time / 32);
  }
  const bytes = Buffer.from(randomUUID().replace(/-/g, ""), "hex");
  let randomPart = "";
  for (let i = 0; i < 16; i += 1) randomPart += alphabet[bytes[i] % 32];
  return timePart + randomPart;
}

export const newRunId = (): string => "run_" + ulid();
export const newTurnId = (): string => "turn_" + ulid();

interface BatchRow {
  id: string;
  project_id: string;
  round_id: string;
  kind: string;
  state: string;
}

interface ItemRow {
  recipient: string;
  on_behalf_of: string | null;
  approval_id: string;
  snapshot_id: string;
  content_hash: string;
}

interface ApprovalRow {
  id: string;
  project_id: string;
  snapshot_id: string;
  state: string;
}

/**
 * 盖章之后这一轮该变成什么。按批次种类决定，不是一律 DRAFT → RUNNING：
 * - initial                   : DRAFT → RUNNING
 * - resume                    : PAUSED → RUNNING
 * - supplement / retry        : RUNNING 不变；AWAITING_SUMMARY → RUNNING
 * - summary                   : AWAITING_SUMMARY → SUMMARIZING
 *
 * 能不能转由契约的 ROUND_TRANSITIONS 查表决定（C-20c 补上了 AWAITING_SUMMARY → RUNNING）。
 */
const ROUND_TARGET: Readonly<Record<string, RoundState>> = {
  initial: "RUNNING",
  resume: "RUNNING",
  supplement: "RUNNING",
  retry: "RUNNING",
  summary: "SUMMARIZING",
};

/**
 * 起草：为批次里每个收件人建一条 `pending` 的 Turn（还没有 Run）。
 *
 * 契约要求 Turn 在盖章之前就存在：确认页要显示「谁会被发」，拒盖时要能标成 `rejected`，
 * 盖章时是把同一条 Turn 从 `pending` 改成 `running`（`turns.approval_id` 是 UNIQUE，不能插第二条）。
 */
export function createDraftTurns(db: SqliteDatabase, queue: WriteQueue, batchId: string): Promise<string[]> {
  return writeTransaction(db, queue, () => {
    const batch = db.prepare("SELECT id, project_id, round_id, kind, state FROM batches WHERE id = ?").get(batchId) as
      | BatchRow
      | undefined;
    if (batch === undefined) throw new BatchApproveError("batch_not_found", "batch not found");
    if (batch.state !== "READY_FOR_REVIEW") {
      throw new BatchApproveError("batch_not_ready", `batch is ${batch.state}`);
    }

    const items = db
      .prepare("SELECT recipient, on_behalf_of, approval_id, snapshot_id, content_hash FROM batch_items WHERE batch_id = ? ORDER BY recipient")
      .all(batch.id) as ItemRow[];

    const createdAt = now();
    const turnIds: string[] = [];
    for (const item of items) {
      const turnId = newTurnId();
      db.prepare(
        "INSERT INTO turns (id, round_id, batch_id, agent, on_behalf_of, is_summary, approval_id, run_id, outcome, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'pending', ?)",
      ).run(
        turnId,
        batch.round_id,
        batch.id,
        item.recipient,
        item.on_behalf_of,
        batch.kind === "summary" ? 1 : 0,
        item.approval_id,
        createdAt,
      );
      turnIds.push(turnId);
    }
    return turnIds;
  });
}

/**
 * 整批盖章：**要么全部发出去，要么一条都不写**。
 *
 * 一次事务里做完五件事：
 * 1. 每个 Approval 从 READY_FOR_REVIEW 变 APPROVED（CAS，改不动就整体回滚）
 * 2. 每个收件人一个 Run（QUEUED）
 * 3. 每个收件人一个 Turn（running，指向 Run）
 * 4. Batch 变 APPROVED
 * 5. Round 从 DRAFT 变 RUNNING
 *
 * 发送前逐个校验指纹：库里存的 content_hash、调用方传上来的 expectedContentHash、
 * 以及用 snapshot.content 现算的 sha256，三者必须一致。
 */
export function approveBatch(
  db: SqliteDatabase,
  queue: WriteQueue,
  input: ApproveBatchInput,
): Promise<ApproveBatchResult> {
  return writeTransaction(db, queue, () => {
    const batch = db.prepare("SELECT id, project_id, round_id, kind, state FROM batches WHERE id = ?").get(input.batchId) as
      | BatchRow
      | undefined;
    if (batch === undefined) throw new BatchApproveError("batch_not_found", "batch not found");
    if (batch.state !== "READY_FOR_REVIEW") {
      throw new BatchApproveError("batch_not_ready", `batch is ${batch.state}`);
    }

    const round = db.prepare("SELECT id, state FROM rounds WHERE id = ?").get(batch.round_id) as
      | { id: string; state: string }
      | undefined;
    if (round === undefined) throw new BatchApproveError("batch_not_found", "round not found");

    const target = ROUND_TARGET[batch.kind];
    if (target === undefined) {
      throw new BatchApproveError("round_transition_invalid", `unknown batch kind ${batch.kind}`);
    }
    if (round.state !== target && !canTransition(ROUND_TRANSITIONS, round.state as RoundState, target)) {
      throw new BatchApproveError("round_transition_invalid", `${round.state} -> ${target} (${batch.kind}) is not allowed`);
    }

    const items = db
      .prepare("SELECT recipient, on_behalf_of, approval_id, snapshot_id, content_hash FROM batch_items WHERE batch_id = ? ORDER BY recipient")
      .all(batch.id) as ItemRow[];

    // 必须一次盖完整批：少一项就不发，避免「一半人收到、一半人没收到」
    if (items.length !== input.items.length) {
      throw new BatchApproveError("item_missing", "approve must cover every item in the batch");
    }

    const byApproval = new Map(input.items.map((item) => [item.approvalId, item]));
    const decidedAt = now();
    const runIds: string[] = [];
    const turnIds: string[] = [];

    for (const item of items) {
      const submitted = byApproval.get(item.approval_id);
      if (submitted === undefined) throw new BatchApproveError("item_missing", "missing item in approval request");

      const approval = db
        .prepare("SELECT id, project_id, snapshot_id, state FROM approvals WHERE id = ?")
        .get(item.approval_id) as ApprovalRow | undefined;
      if (approval === undefined) throw new BatchApproveError("item_missing", "approval not found");
      if (approval.state !== "READY_FOR_REVIEW") {
        throw new BatchApproveError("approval_not_ready", `approval is ${approval.state}`);
      }

      const snapshot = db
        .prepare("SELECT content, content_hash FROM prompt_snapshots WHERE id = ?")
        .get(item.snapshot_id) as { content: string; content_hash: string } | undefined;
      if (snapshot === undefined) throw new BatchApproveError("item_missing", "snapshot not found");

      const actual = createHash("sha256").update(snapshot.content, "utf8").digest("hex");
      if (actual !== snapshot.content_hash || actual !== item.content_hash || actual !== submitted.expectedContentHash) {
        throw new BatchApproveError("hash_mismatch", `snapshot content of ${item.recipient} does not match its hash`);
      }

      const changed = db
        .prepare("UPDATE approvals SET state = 'APPROVED', decided_via = ?, decided_at = ? WHERE id = ? AND state = 'READY_FOR_REVIEW'")
        .run(input.via, decidedAt, item.approval_id);
      if (changed.changes !== 1) throw new BatchApproveError("approval_not_ready", "approval changed concurrently");

      const runId = newRunId();
      // 节点上的 profileId 决定 adapterId；没配置时退回 recipient（S-10 定下来之前先这样）
      const profile = db.prepare("SELECT profile_id FROM agents WHERE id = ?").get(item.recipient) as
        | { profile_id: string | null }
        | undefined;
      const adapterId = profile?.profile_id ? "remote:" + profile.profile_id : "remote:" + item.recipient;
      db.prepare(
        "INSERT INTO runs (id, project_id, approval_id, snapshot_id, adapter_id, state, created_at) VALUES (?, ?, ?, ?, ?, 'QUEUED', ?)",
      ).run(runId, batch.project_id, item.approval_id, item.snapshot_id, adapterId, decidedAt);

      // 起草时已经建好 `pending` 的 Turn，这里只改状态、挂上 run_id
      const turn = db
        .prepare("UPDATE turns SET outcome = 'running', run_id = ? WHERE approval_id = ? AND outcome = 'pending'")
        .run(runId, item.approval_id);
      if (turn.changes !== 1) {
        throw new BatchApproveError("turn_not_pending", `turn for ${item.recipient} is not pending (draft first)`);
      }
      const turnId = (db.prepare("SELECT id FROM turns WHERE approval_id = ?").get(item.approval_id) as { id: string }).id;

      runIds.push(runId);
      turnIds.push(turnId);
    }

    db.prepare("UPDATE batches SET state = 'APPROVED', decided_via = ?, decided_at = ? WHERE id = ? AND state = 'READY_FOR_REVIEW'").run(
      input.via,
      decidedAt,
      batch.id,
    );
    if (round.state !== target) {
      const moved = db
        .prepare("UPDATE rounds SET state = ?, started_at = COALESCE(started_at, ?) WHERE id = ? AND state = ?")
        .run(target, decidedAt, round.id, round.state);
      if (moved.changes !== 1) {
        throw new BatchApproveError("round_transition_invalid", "round changed concurrently");
      }
    }

    return { batchId: batch.id, roundId: batch.round_id, runIds, turnIds };
  });
}
