import { createHash, randomUUID } from "node:crypto";
import {
  canTransition,
  ROUND_TRANSITIONS,
  type ApprovalBatch,
  type BatchKind,
  type BatchModel,
  type HistoryMode,
  type RoundState,
  type TaskSource,
} from "@room/schemas";
import type { SqliteDatabase } from "./database";
import { appendRunEventTx } from "./run-lifecycle";
import { cancelOpenBatchesTx, cancelRunningTurns } from "./discussion-turn";
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
  | "model_mismatch"
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
  /** C-40：确认页上展示的模型和强度；省略 / null = profile 自带 */
  model?: { model: string; effort: string | null } | null;
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
  for (let i = 0; i < 16; i += 1) randomPart += alphabet[bytes[i]! % 32];
  return timePart + randomPart;
}

export const newRunId = (): string => "run_" + ulid();
export const newTurnId = (): string => "turn_" + ulid();
export const newRoundId = (): string => "rnd_" + ulid();
export const newBatchId = (): string => "bat_" + ulid();
export const newSnapshotId = (): string => "snap_" + ulid();
export const newApprovalId = (): string => "apr_" + ulid();

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
  model: string | null;
}

interface ApprovalRow {
  id: string;
  project_id: string;
  snapshot_id: string;
  state: string;
}

/** 确认页要展示的「压缩了哪几轮」，契约里定义 */
type CompressedRound = ApprovalBatch["compressedRounds"][number];

/** rounds 的完整库行（createRoundDraft 返回原始行，映射成契约实体是 IPC 的事） */
export interface RoundRow {
  id: string;
  project_id: string;
  round_index: number;
  state: RoundState;
  task: string;
  task_source: TaskSource;
  /** JSON 数组文本，和库里一致 */
  recipients: string;
  plan_version_id: string | null;
  history_mode: HistoryMode;
  void_reason: string | null;
  active_ms: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

/** batches 的完整库行 */
export interface ApprovalBatchRow {
  id: string;
  project_id: string;
  round_id: string;
  kind: BatchKind;
  state: string;
  /** JSON 数组文本，和库里一致 */
  compressed_rounds: string;
  decided_via: string | null;
  created_at: string;
  decided_at: string | null;
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
const ROUND_TARGET: Readonly<Record<BatchKind, RoundState>> = {
  initial: "RUNNING",
  resume: "RUNNING",
  supplement: "RUNNING",
  retry: "RUNNING",
  summary: "SUMMARIZING",
};

/**
 * 这种批次**只能从哪些状态出发**。只查 ROUND_TRANSITIONS 不够：那张表回答的是
 * 「X 能不能变成 Y」，会放过语义上不该发生的事——
 * - `resume` 在 AWAITING_SUMMARY 盖章（表里允许 AWAITING_SUMMARY → RUNNING，但 resume 只能从 PAUSED）
 * - `initial` 在 PAUSED 盖章（PAUSED → RUNNING 合法，但那时应该用 resume）
 * - `summary` 在已经 SUMMARIZING 时再盖一次（会变成两个汇总同时在跑）
 */
const ALLOWED_FROM: Readonly<Record<BatchKind, readonly RoundState[]>> = {
  initial: ["DRAFT"],
  resume: ["PAUSED"],
  supplement: ["RUNNING", "AWAITING_SUMMARY"],
  retry: ["RUNNING", "AWAITING_SUMMARY"],
  summary: ["AWAITING_SUMMARY"],
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
      .prepare("SELECT recipient, on_behalf_of, approval_id, snapshot_id, content_hash, model FROM batch_items WHERE batch_id = ? ORDER BY recipient")
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

export type RoundDraftErrorCode =
  | "invalid_input"
  | "round_active"
  | "hash_mismatch"
  | "round_not_found"
  | "round_not_awaiting_summary"
  | "round_not_draft"
  | "round_not_paused"
  | "round_not_active"
  | "turn_not_retryable"
  // 拼 Prompt 之后、写 Snapshot 的事务之前，材料里的消息被撤回了
  | "chat_material_changed"
  // 旧 Turn 在写事务里已经不是「没被接上」了（两个并发 retry 只有一个能落库）
  | "supersede_conflict";

export class RoundDraftError extends Error {
  readonly code: RoundDraftErrorCode;
  constructor(code: RoundDraftErrorCode, message: string) {
    super(message);
    this.name = "RoundDraftError";
    this.code = code;
  }
}

/**
 * 一个收件人的 Prompt。**内容由 @room/core 的 assembleDiscussionBatch 拼好再传进来**，
 * db 不做拼装；这里只核对 contentHash，免得存进去的指纹和内容对不上、盖章时才炸。
 */
export interface RoundDraftPrompt {
  content: string;
  /** sha256(UTF-8(content))，由调用方算出；db 会再算一次核对 */
  contentHash: string;
  /** 不可信边界用的 nonce */
  nonce: string;
  /** 拼装器版本，例如 discussion-v2 */
  adapterVersion: string;
  tokenEstimate: number;
  /** 这份内容和同批其他人不一样（只给他一个人的补充、额外信息） */
  differsFromOthers: boolean;
}

export interface RoundDraftRecipient {
  agent: string;
  prompt: RoundDraftPrompt;
  /** C-40：起草时定下的模型和强度；省略 / null = 用 profile 自带模型 */
  model?: BatchModel | null;
  /**
   * D-32 / C-36：替补代答时为被替补的人（absent）。`agent` 是真正收件的那位（替补），
   * 这个字段记「他替谁答」，写进 batch_items / turns 的 on_behalf_of。
   */
  onBehalfOf?: string | null;
}

export interface CreateRoundDraftInput {
  projectId: string;
  /**
   * 调用方在拼 Prompt 时就要知道这一轮的 id（契约实体里有），可以先自己生成再传进来。
   * 不传就由 db 生成。
   */
  roundId?: string;
  recipients: readonly RoundDraftRecipient[];
  /**
   * D-32：这一轮「本来要发给谁」（用户挑的收件人），和 recipients 不同的地方是替补代答：
   * recipients 里是真正收件的替补，这里仍然是缺席的那位。不传 = 和 recipients 的 agent 一样。
   */
  roundRecipients?: readonly string[];
  task: string;
  taskSource: TaskSource;
  planVersionId?: string | null;
  historyMode: HistoryMode;
  /** 讨论记录被压缩的说明，确认页展示 */
  compressedRounds?: readonly CompressedRound[];
  /** 这次实际放进材料的聊天消息 id（写事务里复核是否刚被撤回） */
  chatMaterialSourceIds?: readonly string[];
}

export interface CreateSummaryDraftInput {
  roundId: string;
  /** 汇总批次只有一个收件人（汇总者） */
  recipients: readonly RoundDraftRecipient[];
  compressedRounds?: readonly CompressedRound[];
  chatMaterialSourceIds?: readonly string[];
}

/**
 * 写 Snapshot 的事务里复核聊天材料来源（C-34 / D-31c）。
 * 拼 Prompt 是同步读、写库要排队：中间可能有 chat.retract 先提交，那样新 Snapshot 会带上刚撤回的原文
 * （ADR-003：撤回之后新建的 Prompt / Run 都不再带它）。只检查这次实际放进材料里的消息。
 */
function assertChatMaterialSourcesCurrentTx(db: SqliteDatabase, ids: readonly string[]): void {
  if (ids.length === 0) return;
  const rows = db
    .prepare(
      "SELECT m.id AS id, m.sender AS sender, m.state AS state, p.state AS parentState " +
        "FROM chat_messages m LEFT JOIN chat_messages p ON p.id = m.in_reply_to " +
        "WHERE m.id IN (" + ids.map(() => "?").join(", ") + ")",
    )
    .all(...ids) as { id: string; sender: "user" | "agent"; state: string | null; parentState: string | null }[];
  for (const row of rows) {
    const inContext = row.sender === "user" ? row.state === "sent" : row.parentState === "sent";
    if (!inContext) {
      throw new RoundDraftError(
        "chat_material_changed",
        "chat material source " + row.id + " was retracted while the prompt was being built",
      );
    }
  }
}

/** 议题里「还没结束」的轮：同一议题同时只允许一个（ux_round_active 兜底） */
const ACTIVE_ROUND_STATES: readonly RoundState[] = [
  "DRAFT",
  "RUNNING",
  "PAUSED",
  "AWAITING_SUMMARY",
  "SUMMARIZING",
];

/** 每一批最多 8 个收件人（契约与 rounds.recipients 的 CHECK 一致），且不能重复 */
function assertRecipients(recipients: readonly RoundDraftRecipient[]): void {
  if (recipients.length < 1 || recipients.length > 8) {
    throw new RoundDraftError("invalid_input", "a batch needs 1-8 recipients");
  }
  const seen = new Set<string>();
  for (const recipient of recipients) {
    if (seen.has(recipient.agent)) {
      throw new RoundDraftError("invalid_input", `duplicate recipient ${recipient.agent}`);
    }
    seen.add(recipient.agent);
  }
}

/**
 * 把一批收件人落到库里：批次 + 每人的 Snapshot / Approval / batch_item / pending Turn。
 * 调用方必须已经处在事务里（这里不做 BEGIN）。
 *
 * Turn 在盖章之前就要存在：确认页要显示「谁会被发」，拒盖时标成 rejected，
 * 盖章时把同一条 Turn 从 pending 改成 running（turns.approval_id 是 UNIQUE）。
 *
 * 替补代答这一片还没做：on_behalf_of 一律写 NULL。做替补时 recipients 里记的是「座位」
 * （onBehalfOf ?? agent），替补本人作为 agent 另记。
 */
function insertBatchTx(
  db: SqliteDatabase,
  input: {
    projectId: string;
    roundId: string;
    kind: BatchKind;
    /** 这一轮的任务，写进 Snapshot 的 task_instruction（确认页会显示） */
    taskText: string;
    recipients: readonly RoundDraftRecipient[];
    compressedRounds: readonly CompressedRound[];
    createdAt: string;
  },
): { batchId: string; turnIds: Map<string, string> } {
  const batchId = newBatchId();
  const turnIds = new Map<string, string>();
  db.prepare(
    "INSERT INTO batches (id, project_id, round_id, kind, state, compressed_rounds, created_at) " +
      "VALUES (?, ?, ?, ?, 'READY_FOR_REVIEW', ?, ?)",
  ).run(batchId, input.projectId, input.roundId, input.kind, JSON.stringify(input.compressedRounds), input.createdAt);

  for (const recipient of input.recipients) {
    const prompt = recipient.prompt;
    const contentHash = createHash("sha256").update(prompt.content, "utf8").digest("hex");
    if (contentHash !== prompt.contentHash) {
      throw new RoundDraftError("hash_mismatch", `prompt of ${recipient.agent} does not match its hash`);
    }

    const snapshotId = newSnapshotId();
    const approvalId = newApprovalId();
    db.prepare(
      "INSERT INTO prompt_snapshots (id, project_id, content, content_hash, nonce, contribution_ids, task_instruction, " +
        "reviewer_agent, adapter_version, token_estimate, created_at) VALUES (?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?)",
    ).run(
      snapshotId,
      input.projectId,
      prompt.content,
      contentHash,
      prompt.nonce,
      input.taskText,
      recipient.agent,
      prompt.adapterVersion,
      prompt.tokenEstimate,
      input.createdAt,
    );

    db.prepare(
      "INSERT INTO approvals (id, project_id, snapshot_id, state, created_at) VALUES (?, ?, ?, 'READY_FOR_REVIEW', ?)",
    ).run(approvalId, input.projectId, snapshotId, input.createdAt);

    db.prepare(
      "INSERT INTO batch_items (batch_id, recipient, on_behalf_of, approval_id, snapshot_id, content_hash, differs_from_others, token_estimate, model) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      batchId,
      recipient.agent,
      recipient.onBehalfOf ?? null,
      approvalId,
      snapshotId,
      contentHash,
      prompt.differsFromOthers ? 1 : 0,
      prompt.tokenEstimate,
      recipient.model === null || recipient.model === undefined ? null : JSON.stringify(recipient.model),
    );

    const turnId = newTurnId();
    db.prepare(
      "INSERT INTO turns (id, round_id, batch_id, agent, on_behalf_of, is_summary, approval_id, run_id, outcome, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'pending', ?)",
    ).run(
      turnId,
      input.roundId,
      batchId,
      recipient.agent,
      recipient.onBehalfOf ?? null,
      input.kind === "summary" ? 1 : 0,
      approvalId,
      input.createdAt,
    );
    turnIds.set(recipient.agent, turnId);
  }

  return { batchId, turnIds };
}

/**
 * 起草一轮（round.draft 的写入部分）：**一个事务**里建出
 * 一轮 + 每个收件人的 Snapshot / Approval + 一个批次 + 每人的 batch_item 与 pending Turn。
 *
 * 批次固定是 initial；resume / supplement / retry 是在已有的轮上加批次，
 * summary 走下面的 createSummaryDraft。
 */
export function createRoundDraft(
  db: SqliteDatabase,
  queue: WriteQueue,
  input: CreateRoundDraftInput,
): Promise<{ round: RoundRow; batch: ApprovalBatchRow }> {
  return writeTransaction(db, queue, () => {
    assertRecipients(input.recipients);
    assertChatMaterialSourcesCurrentTx(db, input.chatMaterialSourceIds ?? []);

    // 先查一遍是为了给调用方一个能读的错误；并发时由 ux_round_active 唯一索引兜底
    const active = db
      .prepare(
        `SELECT id, state FROM rounds WHERE project_id = ? AND state IN (${ACTIVE_ROUND_STATES.map(() => "?").join(", ")}) LIMIT 1`,
      )
      .get(input.projectId, ...ACTIVE_ROUND_STATES) as { id: string; state: string } | undefined;
    if (active !== undefined) {
      throw new RoundDraftError("round_active", `round ${active.id} is still ${active.state}`);
    }

    // 外键只保证方案存在，不保证是同一个议题的
    if (input.planVersionId !== undefined && input.planVersionId !== null) {
      const plan = db.prepare("SELECT project_id FROM plan_versions WHERE id = ?").get(input.planVersionId) as
        | { project_id: string }
        | undefined;
      if (plan === undefined || plan.project_id !== input.projectId) {
        throw new RoundDraftError("invalid_input", `plan ${input.planVersionId} does not belong to this project`);
      }
    }

    const createdAt = now();
    const roundId = input.roundId ?? newRoundId();
    // 作废的轮也占号，所以取 max + 1 而不是 count + 1
    const roundIndex = (
      db.prepare("SELECT COALESCE(MAX(round_index), 0) + 1 AS n FROM rounds WHERE project_id = ?").get(input.projectId) as { n: number }
    ).n;

    db.prepare(
      "INSERT INTO rounds (id, project_id, round_index, state, task, task_source, recipients, plan_version_id, history_mode, created_at) " +
        "VALUES (?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?, ?)",
    ).run(
      roundId,
      input.projectId,
      roundIndex,
      input.task,
      input.taskSource,
      JSON.stringify(input.roundRecipients ?? input.recipients.map((recipient) => recipient.agent)),
      input.planVersionId ?? null,
      input.historyMode,
      createdAt,
    );

    const { batchId } = insertBatchTx(db, {
      projectId: input.projectId,
      roundId,
      kind: "initial",
      taskText: input.task,
      recipients: input.recipients,
      compressedRounds: input.compressedRounds ?? [],
      createdAt,
    });

    return {
      round: db.prepare("SELECT * FROM rounds WHERE id = ?").get(roundId) as RoundRow,
      batch: db.prepare("SELECT * FROM batches WHERE id = ?").get(batchId) as ApprovalBatchRow,
    };
  });
}

/**
 * 汇总批次（round.summarize 的写入部分）：在**已有的轮**上加一张 summary 批次 + pending Turn。
 *
 * - 轮必须是 AWAITING_SUMMARY（SUMMARIZING 说明已经有汇总在跑，SUMMARIZED 已经汇总过）
 * - 同一轮里还没盖章的 summary 批次先作废，不留两张待盖章的汇总单
 * - 汇总者的 Prompt 由 @room/core 的 assembleSummaryPrompt 拼好传进来
 */
export function createSummaryDraft(
  db: SqliteDatabase,
  queue: WriteQueue,
  input: CreateSummaryDraftInput,
): Promise<{ batch: ApprovalBatchRow }> {
  return writeTransaction(db, queue, () => {
    if (input.recipients.length !== 1) {
      throw new RoundDraftError("invalid_input", "a summary batch has exactly one recipient");
    }
    assertRecipients(input.recipients);
    assertChatMaterialSourcesCurrentTx(db, input.chatMaterialSourceIds ?? []);

    const round = db.prepare("SELECT id, project_id, state, task FROM rounds WHERE id = ?").get(input.roundId) as
      | { id: string; project_id: string; state: string; task: string }
      | undefined;
    if (round === undefined) throw new RoundDraftError("round_not_found", "round not found");
    if (round.state !== "AWAITING_SUMMARY") {
      throw new RoundDraftError("round_not_awaiting_summary", `round is ${round.state}`);
    }

    const createdAt = now();
    cancelOpenSummaryBatchesTx(db, round.id, createdAt);
    const { batchId } = insertBatchTx(db, {
      projectId: round.project_id,
      roundId: round.id,
      kind: "summary",
      taskText: round.task,
      recipients: input.recipients,
      compressedRounds: input.compressedRounds ?? [],
      createdAt,
    });

    return { batch: db.prepare("SELECT * FROM batches WHERE id = ?").get(batchId) as ApprovalBatchRow };
  });
}


/** 作废一轮里某一种还没盖章的批次（supplement / retry / initial …） */
function cancelOpenBatchesByKindTx(db: SqliteDatabase, roundId: string, kind: BatchKind, ts: string): void {
  db.prepare(
    "UPDATE approvals SET state = 'CANCELLED', decided_at = ? WHERE state IN ('DRAFT', 'READY_FOR_REVIEW') AND id IN (" +
      "SELECT bi.approval_id FROM batch_items bi JOIN batches b ON b.id = bi.batch_id WHERE b.round_id = ? AND b.kind = ?)",
  ).run(ts, roundId, kind);
  db.prepare(
    "UPDATE batches SET state = 'CANCELLED', decided_at = ? WHERE round_id = ? AND kind = ? AND state IN ('DRAFT', 'READY_FOR_REVIEW')",
  ).run(ts, roundId, kind);
  db.prepare(
    "UPDATE turns SET outcome = 'rejected', finished_at = ? WHERE outcome = 'pending' AND batch_id IN (" +
      "SELECT id FROM batches WHERE round_id = ? AND kind = ?)",
  ).run(ts, roundId, kind);
}

export interface SupersedeLink {
  oldTurnId: string;
  /** 新 Turn 的 agent（替补代答时是替补本人） */
  agent: string;
  /**
   * 旧 Turn 必须仍然没有被接上，否则整批回滚（C酱 #163 复审必须改 1）。
   * 并发 retry 都会在 await 之前读到 supersededBy = null，只有写事务里的这个条件能挡住第二个。
   */
  requireNotSuperseded?: boolean;
}

export interface CreateBatchDraftInput {
  roundId: string;
  kind: BatchKind;
  recipients: readonly RoundDraftRecipient[];
  compressedRounds?: readonly CompressedRound[];
  /** 建之前把这一轮里这种 kind 的待盖章批次作废（重新补充 / 重试同一批时用） */
  cancelOpenKind?: BatchKind;
  /** 旧的 Turn 接到新 Turn 上（打断 / 补充 / 重试） */
  supersede?: readonly SupersedeLink[];
  chatMaterialSourceIds?: readonly string[];
}

/**
 * 在**已有的轮**上加一张批次（supplement / retry / 重新起草等）：
 * 每个收件人一份新 Snapshot + Approval + batch_item + pending Turn，和起草共用 insertBatchTx。
 */
export function createBatchDraft(
  db: SqliteDatabase,
  queue: WriteQueue,
  input: CreateBatchDraftInput,
): Promise<{ batch: ApprovalBatchRow }> {
  return writeTransaction(db, queue, () => {
    assertRecipients(input.recipients);
    assertChatMaterialSourcesCurrentTx(db, input.chatMaterialSourceIds ?? []);
    const round = db.prepare("SELECT id, project_id, state, task FROM rounds WHERE id = ?").get(input.roundId) as
      | { id: string; project_id: string; state: string; task: string }
      | undefined;
    if (round === undefined) throw new RoundDraftError("round_not_found", "round not found");
    if (round.state === "SUMMARIZED" || round.state === "VOIDED") {
      throw new RoundDraftError("round_not_active", "round is " + round.state);
    }

    // 并发 retry：旧 Turn 必须仍然没有被接上。检查、建批次、UPDATE 都在同一个写事务里，
    // 第二个 retry 走到这里时要么在 SELECT 撞上、要么在 UPDATE 的 changes 上撞上，两处都抛出去回滚整批。
    for (const link of input.supersede ?? []) {
      if (link.requireNotSuperseded !== true) continue;
      const old = db.prepare("SELECT superseded_by FROM turns WHERE id = ?").get(link.oldTurnId) as
        | { superseded_by: string | null }
        | undefined;
      if (old === undefined || old.superseded_by !== null) {
        throw new RoundDraftError(
          "supersede_conflict",
          old === undefined ? "turn " + link.oldTurnId + " not found" : "turn " + link.oldTurnId + " is already superseded",
        );
      }
    }

    const createdAt = now();
    if (input.cancelOpenKind !== undefined) {
      cancelOpenBatchesByKindTx(db, round.id, input.cancelOpenKind, createdAt);
    }

    const { batchId, turnIds } = insertBatchTx(db, {
      projectId: round.project_id,
      roundId: round.id,
      kind: input.kind,
      taskText: round.task,
      recipients: input.recipients,
      compressedRounds: input.compressedRounds ?? [],
      createdAt,
    });

    for (const link of input.supersede ?? []) {
      const next = turnIds.get(link.agent);
      if (next === undefined) {
        // required 却找不到要接的新 Turn：调用方把 agent 传错了，不能悄悄当成没这回事
        if (link.requireNotSuperseded === true) {
          throw new RoundDraftError("supersede_conflict", "no new turn for " + link.agent + " to link " + link.oldTurnId + " to");
        }
        continue;
      }
      const changed = db
        .prepare("UPDATE turns SET superseded_by = ? WHERE id = ? AND superseded_by IS NULL")
        .run(next, link.oldTurnId);
      // 只有 required 的链接要求「必须接上」；普通的打断 / 补充沿用原来的尽力而为语义
      if (link.requireNotSuperseded === true && changed.changes !== 1) {
        throw new RoundDraftError("supersede_conflict", "turn " + link.oldTurnId + " is already superseded");
      }
    }

    return { batch: db.prepare("SELECT * FROM batches WHERE id = ?").get(batchId) as ApprovalBatchRow };
  });
}

export interface CreateResumeBatchInput {
  roundId: string;
  /** 暂停后要重新发的人（通常是结局为 paused 的那些） */
  agents: readonly string[];
  /**
   * C-40：恢复时沿用原模型；节点已不支持原模型时由调用方重选后在这里覆盖。
   * 不传 = 原样复制暂停前那条 batch_item 的 model。
   */
  models?: Readonly<Record<string, BatchModel | null>>;
}

/**
 * 恢复（0-B 第 6 行）：内容不变，一键重新盖章。
 *
 * 直接复用原来那次的 Snapshot（不再拼一次 Prompt）：这样「恢复」发出去的内容和指纹
 * 与暂停前完全一致；每个收件人新建一个 Approval + batch_item + pending Turn，
 * 旧的 paused Turn 用 superseded_by 接上。
 *
 * D-32 / C酱 #163 复审必须改 2：替补代答的人暂停后恢复，新的 batch_item / Turn 也必须
 * 沿用旧 Turn 的 on_behalf_of。Prompt 里写着「替 A 回答」，持久化不能把它当成 B 自己的发言。
 */
export function createResumeBatch(
  db: SqliteDatabase,
  queue: WriteQueue,
  input: CreateResumeBatchInput,
): Promise<{ batch: ApprovalBatchRow }> {
  return writeTransaction(db, queue, () => {
    if (input.agents.length < 1 || input.agents.length > 8) {
      throw new RoundDraftError("invalid_input", "a resume batch needs 1-8 agents");
    }
    const round = db.prepare("SELECT id, project_id, state FROM rounds WHERE id = ?").get(input.roundId) as
      | { id: string; project_id: string; state: string }
      | undefined;
    if (round === undefined) throw new RoundDraftError("round_not_found", "round not found");
    if (round.state !== "PAUSED") throw new RoundDraftError("round_not_paused", "round is " + round.state);

    const previous = input.agents.map((agent) => {
      const row = db
        .prepare(
          "SELECT t.id AS turn_id, t.on_behalf_of AS on_behalf_of, a.snapshot_id AS snapshot_id, s.content_hash AS content_hash, " +
            "b.compressed_rounds AS compressed_rounds, bi.model AS model " +
            "FROM turns t JOIN approvals a ON a.id = t.approval_id JOIN prompt_snapshots s ON s.id = a.snapshot_id " +
            "JOIN batches b ON b.id = t.batch_id JOIN batch_items bi ON bi.approval_id = t.approval_id " +
            "WHERE t.round_id = ? AND t.agent = ? AND t.is_summary = 0 AND t.outcome = 'paused' " +
            "ORDER BY t.created_at DESC, t.rowid DESC LIMIT 1",
        )
        .get(round.id, agent) as
        | {
            turn_id: string;
            on_behalf_of: string | null;
            snapshot_id: string;
            content_hash: string;
            compressed_rounds: string;
            model: string | null;
          }
        | undefined;
      if (row === undefined) throw new RoundDraftError("turn_not_retryable", agent + " has no paused turn");
      const override =
        input.models !== undefined && Object.prototype.hasOwnProperty.call(input.models, agent)
          ? input.models[agent] ?? null
          : undefined;
      const model = override !== undefined ? override : row.model === null ? null : (JSON.parse(row.model) as BatchModel);
      // batch_items.on_behalf_of 与 turns.on_behalf_of 是同一处写入的，以旧 Turn 为准原样带过去
      return {
        agent,
        turn_id: row.turn_id,
        on_behalf_of: row.on_behalf_of,
        snapshot_id: row.snapshot_id,
        content_hash: row.content_hash,
        compressed_rounds: row.compressed_rounds,
        model,
      };
    });

    const createdAt = now();
    const batchId = newBatchId();
    db.prepare(
      "INSERT INTO batches (id, project_id, round_id, kind, state, compressed_rounds, created_at) " +
        "VALUES (?, ?, ?, 'resume', 'READY_FOR_REVIEW', ?, ?)",
    ).run(batchId, round.project_id, round.id, previous[0]!.compressed_rounds, createdAt);

    for (const item of previous) {
      const approvalId = newApprovalId();
      db.prepare(
        "INSERT INTO approvals (id, project_id, snapshot_id, state, created_at) VALUES (?, ?, ?, 'READY_FOR_REVIEW', ?)",
      ).run(approvalId, round.project_id, item.snapshot_id, createdAt);
      db.prepare(
        "INSERT INTO batch_items (batch_id, recipient, on_behalf_of, approval_id, snapshot_id, content_hash, differs_from_others, token_estimate, model) " +
          "VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?)",
      ).run(
        batchId,
        item.agent,
        item.on_behalf_of,
        approvalId,
        item.snapshot_id,
        item.content_hash,
        item.model === null ? null : JSON.stringify(item.model),
      );
      const turnId = newTurnId();
      db.prepare(
        "INSERT INTO turns (id, round_id, batch_id, agent, on_behalf_of, is_summary, approval_id, run_id, outcome, created_at) " +
          "VALUES (?, ?, ?, ?, ?, 0, ?, NULL, 'pending', ?)",
      ).run(turnId, round.id, batchId, item.agent, item.on_behalf_of, approvalId, createdAt);
      db.prepare("UPDATE turns SET superseded_by = ? WHERE id = ? AND superseded_by IS NULL").run(turnId, item.turn_id);
    }

    return { batch: db.prepare("SELECT * FROM batches WHERE id = ?").get(batchId) as ApprovalBatchRow };
  });
}

export interface InterruptTurnsInput {
  roundId: string;
  agents: readonly string[];
  /** 每人已经写出来的部分，按 turnId 传；没有就不存 */
  partialText?: Readonly<Record<string, string>>;
}

/**
 * 打断指定的人（0-B 第 4 行）：Run CANCELLED + 唯一的 cancelled 终止事件，Turn 记 interrupted，
 * 已经写出来的部分保留。只处理正在跑的 Turn。
 */
export function interruptTurns(
  db: SqliteDatabase,
  queue: WriteQueue,
  input: InterruptTurnsInput,
): Promise<{ interrupted: { turnId: string; runId: string | null }[] }> {
  return writeTransaction(db, queue, () => {
    const ts = now();
    const interrupted: { turnId: string; runId: string | null }[] = [];

    for (const agent of input.agents) {
      const turn = db
        .prepare(
          "SELECT id, run_id FROM turns WHERE round_id = ? AND agent = ? AND is_summary = 0 AND outcome = 'running' " +
            "ORDER BY created_at DESC, rowid DESC LIMIT 1",
        )
        .get(input.roundId, agent) as { id: string; run_id: string | null } | undefined;
      if (turn === undefined) continue;

      if (turn.run_id !== null) {
        const changed = db
          .prepare(
            "UPDATE runs SET state = 'CANCELLED', finished_at = ?, substate = NULL WHERE id = ? AND state IN ('QUEUED', 'STARTING', 'RUNNING')",
          )
          .run(ts, turn.run_id);
        if (changed.changes === 1) {
          appendRunEventTx(db, turn.run_id, { type: "cancelled", payload: { reason: "interrupted" }, ts }, { allowTerminal: true });
        }
      }
      db.prepare("UPDATE turns SET outcome = 'interrupted', partial_text = ?, finished_at = ? WHERE id = ? AND outcome = 'running'").run(
        input.partialText?.[turn.id] ?? null,
        ts,
        turn.id,
      );
      interrupted.push({ turnId: turn.id, runId: turn.run_id });
    }

    return { interrupted };
  });
}

export interface VoidRoundInput {
  roundId: string;
  reason: string;
  /** 正在跑的 Turn 已经写出来的部分，按 turnId 传 */
  partialText?: Readonly<Record<string, string>>;
}

/**
 * 作废这一轮（0-B 第 13 行）：记录全部保留。
 * 正在跑的按 round_ended 结束、待盖章的批次作废、基于这一轮的方案草稿 → SUPERSEDED。
 */
export function voidRound(
  db: SqliteDatabase,
  queue: WriteQueue,
  input: VoidRoundInput,
): Promise<{ round: RoundRow; supersededPlanIds: string[]; endedTurns: number; cancelledBatches: number }> {
  return writeTransaction(db, queue, () => {
    const round = db.prepare("SELECT * FROM rounds WHERE id = ?").get(input.roundId) as RoundRow | undefined;
    if (round === undefined) throw new RoundDraftError("round_not_found", "round not found");
    if (!ACTIVE_ROUND_STATES.includes(round.state)) {
      throw new RoundDraftError("round_not_active", "round is " + round.state);
    }

    const ts = now();
    const endedTurns = cancelRunningTurns(db, round.id, "round_ended", input.partialText ?? {}, ts);
    const cancelledBatches = cancelOpenBatchesTx(db, round.id, ts);
    // 作废也要把正在跑的这段时间累计进 active_ms（和 pause / end 一致），否则界面上「用了多久」会少一段
    const elapsed = round.started_at === null ? 0 : Math.max(0, Date.parse(ts) - Date.parse(round.started_at));

    db.prepare(
      "UPDATE rounds SET state = 'VOIDED', void_reason = ?, started_at = NULL, active_ms = ?, finished_at = ? WHERE id = ?",
    ).run(input.reason, round.active_ms + elapsed, ts, round.id);

    const plans = db
      .prepare("SELECT id FROM plan_versions WHERE based_on_round_id = ? AND state = 'DRAFT'")
      .all(round.id) as { id: string }[];
    db.prepare(
      "UPDATE plan_versions SET state = 'SUPERSEDED', superseded_reason = ?, decided_at = ? WHERE based_on_round_id = ? AND state = 'DRAFT'",
    ).run("第 " + round.round_index + " 轮作废：" + input.reason, ts, round.id);

    return {
      round: db.prepare("SELECT * FROM rounds WHERE id = ?").get(round.id) as RoundRow,
      supersededPlanIds: plans.map((plan) => plan.id),
      endedTurns,
      cancelledBatches,
    };
  });
}

export interface RedraftRoundInput {
  roundId: string;
  task: string;
  recipientAgents: readonly string[];
  historyMode: HistoryMode;
  /** 按新任务 / 新收件人重新拼好的 Prompt */
  prompts: readonly RoundDraftRecipient[];
  compressedRounds?: readonly CompressedRound[];
  chatMaterialSourceIds?: readonly string[];
}

/** 修改还没盖章的一轮：任务 / 收件人 / 讨论记录取法；旧批次作废，生成新的 initial 批次 */
export function redraftRound(
  db: SqliteDatabase,
  queue: WriteQueue,
  input: RedraftRoundInput,
): Promise<{ round: RoundRow; batch: ApprovalBatchRow }> {
  return writeTransaction(db, queue, () => {
    assertRecipients(input.prompts);
    assertChatMaterialSourcesCurrentTx(db, input.chatMaterialSourceIds ?? []);
    const round = db.prepare("SELECT id, project_id, state FROM rounds WHERE id = ?").get(input.roundId) as
      | { id: string; project_id: string; state: string }
      | undefined;
    if (round === undefined) throw new RoundDraftError("round_not_found", "round not found");
    if (round.state !== "DRAFT") throw new RoundDraftError("round_not_draft", "round is " + round.state);

    const createdAt = now();
    cancelOpenBatchesTx(db, round.id, createdAt);
    db.prepare(
      "UPDATE rounds SET task = ?, task_source = 'human', recipients = ?, history_mode = ? WHERE id = ? AND state = 'DRAFT'",
    ).run(input.task, JSON.stringify(input.recipientAgents), input.historyMode, round.id);

    const { batchId } = insertBatchTx(db, {
      projectId: round.project_id,
      roundId: round.id,
      kind: "initial",
      taskText: input.task,
      recipients: input.prompts,
      compressedRounds: input.compressedRounds ?? [],
      createdAt,
    });

    return {
      round: db.prepare("SELECT * FROM rounds WHERE id = ?").get(round.id) as RoundRow,
      batch: db.prepare("SELECT * FROM batches WHERE id = ?").get(batchId) as ApprovalBatchRow,
    };
  });
}

/** 重新请求汇总时，作废旧的那张待盖章 summary 批次（只动 summary 这一种） */
function cancelOpenSummaryBatchesTx(db: SqliteDatabase, roundId: string, ts: string): void {
  db.prepare(
    "UPDATE approvals SET state = 'CANCELLED', decided_at = ? WHERE state IN ('DRAFT', 'READY_FOR_REVIEW') AND id IN (" +
      "SELECT bi.approval_id FROM batch_items bi JOIN batches b ON b.id = bi.batch_id WHERE b.round_id = ? AND b.kind = 'summary')",
  ).run(ts, roundId);
  db.prepare(
    "UPDATE batches SET state = 'CANCELLED', decided_at = ? WHERE round_id = ? AND kind = 'summary' AND state IN ('DRAFT', 'READY_FOR_REVIEW')",
  ).run(ts, roundId);
  db.prepare(
    "UPDATE turns SET outcome = 'rejected', finished_at = ? WHERE outcome = 'pending' AND batch_id IN (" +
      "SELECT id FROM batches WHERE round_id = ? AND kind = 'summary')",
  ).run(ts, roundId);
}

/**
 * 整批盖章：**要么全部发出去，要么一条都不写**。
 *
 * 一次事务里做完五件事：
 * 1. 每个 Approval 从 READY_FOR_REVIEW 变 APPROVED（CAS，改不动就整体回滚）
 * 2. 每个收件人一个 Run（QUEUED）
 * 3. 起草时建好的那条 `pending` Turn 改成 `running` 并挂上 run_id（不是新建）
 * 4. Batch 变 APPROVED
 * 5. Round 按批次种类转到目标状态（见 ROUND_TARGET / ALLOWED_FROM）
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

    // 库里的 kind 是 TEXT，先按 BatchKind 取，再保留运行期兜底（老的 / 手写的行）
    const kind = batch.kind as BatchKind;
    const target = ROUND_TARGET[kind] as RoundState | undefined;
    const allowedFrom = ALLOWED_FROM[kind] as readonly RoundState[] | undefined;
    if (target === undefined || allowedFrom === undefined) {
      throw new BatchApproveError("round_transition_invalid", `unknown batch kind ${batch.kind}`);
    }
    if (!allowedFrom.includes(round.state as RoundState)) {
      throw new BatchApproveError(
        "round_transition_invalid",
        `${batch.kind} cannot start from ${round.state} (allowed: ${allowedFrom.join(", ")})`,
      );
    }
    if (round.state !== target && !canTransition(ROUND_TRANSITIONS, round.state as RoundState, target)) {
      throw new BatchApproveError("round_transition_invalid", `${round.state} -> ${target} (${batch.kind}) is not allowed`);
    }

    const items = db
      .prepare("SELECT recipient, on_behalf_of, approval_id, snapshot_id, content_hash, model FROM batch_items WHERE batch_id = ? ORDER BY recipient")
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

      // C-40：模型/强度也是盖章指纹的一部分。只比较 model + effort；
      // BatchItem 里的 usedFallback / effortSource 是给人看的，不参与。
      const stored = item.model === null ? null : (JSON.parse(item.model) as { model: string; effort: string | null });
      const approvedModel = submitted.model ?? null;
      const sameModel =
        stored === null
          ? approvedModel === null
          : approvedModel !== null && approvedModel.model === stored.model && approvedModel.effort === stored.effort;
      if (!sameModel) {
        const what =
          stored === null || approvedModel === null
            ? "model"
            : stored.model !== approvedModel.model
              ? "model"
              : "effort";
        throw new BatchApproveError(
          "model_mismatch",
          `${what} of ${item.recipient} changed: approved ${JSON.stringify(approvedModel)}, batch has ${JSON.stringify(stored)}`,
        );
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

/**
 * D-32：某张批次的每一项（谁在收件、替谁答）。redraft「沿用旧替补」要按 onBehalfOf 读回。
 */
export function listBatchItems(
  db: SqliteDatabase,
  batchId: string,
): { recipient: string; onBehalfOf: string | null }[] {
  const rows = db
    .prepare("SELECT recipient, on_behalf_of FROM batch_items WHERE batch_id = ? ORDER BY recipient")
    .all(batchId) as { recipient: string; on_behalf_of: string | null }[];
  return rows.map((row) => ({ recipient: row.recipient, onBehalfOf: row.on_behalf_of }));
}
