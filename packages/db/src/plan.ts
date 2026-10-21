import { createHash } from "node:crypto";
import type { SqliteDatabase } from "./database";
import { writeTransaction, type WriteQueue } from "./write-queue";

/**
 * 方案版本的写入路径（ADR-002 / C-20）：确认草稿、盖章定稿。
 *
 * 不变量：
 * - 每个议题最多一个 CURRENT、一个 FINAL（建表时的唯一索引兜底）
 * - 内容不可改：定稿时重算 sha256(content)，必须同时等于调用方看到的指纹和库里存的指纹
 */

export type PlanErrorCode = "plan_not_found" | "plan_not_draft" | "plan_not_current" | "hash_mismatch";

export class PlanError extends Error {
  readonly code: PlanErrorCode;
  constructor(code: PlanErrorCode, message: string) {
    super(message);
    this.name = "PlanError";
    this.code = code;
  }
}

export interface PlanVersionRow {
  id: string;
  project_id: string;
  version: number;
  state: string;
  content: string;
  content_hash: string;
  change_note: string;
  based_on_round_id: string | null;
  parent_id: string | null;
  drafted_by_kind: string;
  drafted_by_agent: string | null;
  superseded_reason: string | null;
  created_at: string;
  decided_at: string | null;
}

const now = (): string => new Date().toISOString();

function readPlan(db: SqliteDatabase, planVersionId: string): PlanVersionRow | undefined {
  return db.prepare("SELECT * FROM plan_versions WHERE id = ?").get(planVersionId) as PlanVersionRow | undefined;
}

/**
 * 确认方案草稿：DRAFT → CURRENT，原来的 CURRENT → SUPERSEDED（同一个事务）。
 * 返回被取代的那些版本，调用方要把它们的 plan.updated 也推出去。
 */
export function confirmPlan(
  db: SqliteDatabase,
  queue: WriteQueue,
  planVersionId: string,
): Promise<{ plan: PlanVersionRow; superseded: PlanVersionRow[] }> {
  return writeTransaction(db, queue, () => {
    const plan = readPlan(db, planVersionId);
    if (plan === undefined) throw new PlanError("plan_not_found", "plan version not found");
    if (plan.state !== "DRAFT") throw new PlanError("plan_not_draft", "plan is " + plan.state);

    const decidedAt = now();
    const previous = db
      .prepare("SELECT id FROM plan_versions WHERE project_id = ? AND state = 'CURRENT'")
      .all(plan.project_id) as { id: string }[];
    for (const row of previous) {
      db.prepare("UPDATE plan_versions SET state = 'SUPERSEDED', decided_at = ? WHERE id = ? AND state = 'CURRENT'").run(
        decidedAt,
        row.id,
      );
    }

    const changed = db
      .prepare("UPDATE plan_versions SET state = 'CURRENT', decided_at = ? WHERE id = ? AND state = 'DRAFT'")
      .run(decidedAt, plan.id);
    if (changed.changes !== 1) throw new PlanError("plan_not_draft", "plan changed concurrently");

    return {
      plan: readPlan(db, plan.id)!,
      superseded: previous.map((row) => readPlan(db, row.id)!),
    };
  });
}

/**
 * 盖章定稿：CURRENT → FINAL。校验指纹（三处一致：内容现算、库里存的、调用方看到的），
 * 这样「看的是旧版本」不会被悄悄定稿。
 */
export function finalizePlan(
  db: SqliteDatabase,
  queue: WriteQueue,
  input: { planVersionId: string; expectedContentHash: string },
): Promise<PlanVersionRow> {
  return writeTransaction(db, queue, () => {
    const plan = readPlan(db, input.planVersionId);
    if (plan === undefined) throw new PlanError("plan_not_found", "plan version not found");
    if (plan.state !== "CURRENT") throw new PlanError("plan_not_current", "plan is " + plan.state);

    const actual = createHash("sha256").update(plan.content, "utf8").digest("hex");
    if (actual !== plan.content_hash || actual !== input.expectedContentHash) {
      throw new PlanError("hash_mismatch", "plan content does not match its hash");
    }

    const changed = db
      .prepare("UPDATE plan_versions SET state = 'FINAL', decided_at = ? WHERE id = ? AND state = 'CURRENT'")
      .run(now(), plan.id);
    if (changed.changes !== 1) throw new PlanError("plan_not_current", "plan changed concurrently");
    return readPlan(db, plan.id)!;
  });
}
