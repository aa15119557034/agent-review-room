import { createHash } from "node:crypto";
import type { SqliteDatabase } from "./database";
import { ulid } from "./ulid";
import { writeTransaction, type WriteQueue } from "./write-queue";

/**
 * 方案版本的写入路径（ADR-002 / C-20）：确认草稿、盖章定稿。
 *
 * 不变量：
 * - 每个议题最多一个 CURRENT、一个 FINAL（建表时的唯一索引兜底）
 * - 内容不可改：定稿时重算 sha256(content)，必须同时等于调用方看到的指纹和库里存的指纹
 */

export type PlanErrorCode =
  | "plan_not_found"
  | "plan_not_draft"
  | "plan_not_current"
  | "plan_not_final"
  | "plan_exists"
  | "plan_not_latest"
  | "hash_mismatch";

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
 *
 * C-26：这个议题已经有 FINAL（之前定过稿、后来派生出新版本）时，旧的 FINAL 在同一事务里
 * 变成 SUPERSEDED；返回被取代的版本，调用方要把它们的 plan.updated 也推出去。
 */
export function finalizePlan(
  db: SqliteDatabase,
  queue: WriteQueue,
  input: { planVersionId: string; expectedContentHash: string },
): Promise<{ plan: PlanVersionRow; superseded: PlanVersionRow[] }> {
  return writeTransaction(db, queue, () => {
    const plan = readPlan(db, input.planVersionId);
    if (plan === undefined) throw new PlanError("plan_not_found", "plan version not found");
    if (plan.state !== "CURRENT") throw new PlanError("plan_not_current", "plan is " + plan.state);

    const actual = createHash("sha256").update(plan.content, "utf8").digest("hex");
    if (actual !== plan.content_hash || actual !== input.expectedContentHash) {
      throw new PlanError("hash_mismatch", "plan content does not match its hash");
    }

    const decidedAt = now();
    const previous = db
      .prepare("SELECT id FROM plan_versions WHERE project_id = ? AND state = 'FINAL' AND id <> ?")
      .all(plan.project_id, plan.id) as { id: string }[];
    for (const row of previous) {
      db.prepare(
        "UPDATE plan_versions SET state = 'SUPERSEDED', superseded_reason = ?, decided_at = ? WHERE id = ? AND state = 'FINAL'",
      ).run("被新定稿的版本取代", decidedAt, row.id);
    }

    const changed = db
      .prepare("UPDATE plan_versions SET state = 'FINAL', decided_at = ? WHERE id = ? AND state = 'CURRENT'")
      .run(decidedAt, plan.id);
    if (changed.changes !== 1) throw new PlanError("plan_not_current", "plan changed concurrently");

    return {
      plan: readPlan(db, plan.id)!,
      superseded: previous.map((row) => readPlan(db, row.id)!),
    };
  });
}

function nextVersion(db: SqliteDatabase, projectId: string): number {
  return (
    db.prepare("SELECT COALESCE(MAX(version), 0) + 1 AS n FROM plan_versions WHERE project_id = ?").get(projectId) as { n: number }
  ).n;
}

function insertPlanVersion(
  db: SqliteDatabase,
  input: {
    projectId: string;
    version: number;
    content: string;
    contentHash: string;
    changeNote: string;
    basedOnRoundId: string | null;
    parentId: string | null;
    createdAt: string;
  },
): string {
  const id = "plan_" + ulid();
  db.prepare(
    "INSERT INTO plan_versions (id, project_id, version, state, content, content_hash, change_note, based_on_round_id, " +
      "parent_id, drafted_by_kind, drafted_by_agent, created_at) VALUES (?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?, 'human', NULL, ?)",
  ).run(
    id,
    input.projectId,
    input.version,
    input.content,
    input.contentHash,
    input.changeNote,
    input.basedOnRoundId,
    input.parentId,
    input.createdAt,
  );
  return id;
}

/**
 * 用户自己写第一版方案（plan.create）：只有议题还**没有任何版本**时才能用。
 * 用于汇总没有给出方案（planContent = null）、而用户想自己起草的情况。
 */
export function createPlan(
  db: SqliteDatabase,
  queue: WriteQueue,
  input: { projectId: string; content: string; changeNote: string },
): Promise<PlanVersionRow> {
  return writeTransaction(db, queue, () => {
    const existing = db.prepare("SELECT id FROM plan_versions WHERE project_id = ? LIMIT 1").get(input.projectId) as
      | { id: string }
      | undefined;
    if (existing !== undefined) {
      throw new PlanError("plan_exists", "this project already has a plan version; use plan.edit");
    }

    const createdAt = now();
    const id = insertPlanVersion(db, {
      projectId: input.projectId,
      version: 1,
      content: input.content,
      contentHash: createHash("sha256").update(input.content, "utf8").digest("hex"),
      changeNote: input.changeNote,
      basedOnRoundId: null,
      parentId: null,
      createdAt,
    });
    return readPlan(db, id)!;
  });
}

/**
 * 用户自己改方案（plan.edit）：基于 parentId 生成一个新的 DRAFT。
 * 项目里其它还没确认的 DRAFT 一起作废，避免出现两个互相冲突的草稿。
 */
export function editPlan(
  db: SqliteDatabase,
  queue: WriteQueue,
  input: { parentId: string; content: string; changeNote: string },
): Promise<{ plan: PlanVersionRow; superseded: PlanVersionRow[] }> {
  return writeTransaction(db, queue, () => {
    const parent = readPlan(db, input.parentId);
    if (parent === undefined) throw new PlanError("plan_not_found", "plan version not found");

    const createdAt = now();
    const previous = db
      .prepare("SELECT id FROM plan_versions WHERE project_id = ? AND state = 'DRAFT'")
      .all(parent.project_id) as { id: string }[];
    for (const row of previous) {
      db.prepare(
        "UPDATE plan_versions SET state = 'SUPERSEDED', superseded_reason = ?, decided_at = ? WHERE id = ? AND state = 'DRAFT'",
      ).run("被你改过的版本取代", createdAt, row.id);
    }

    const id = insertPlanVersion(db, {
      projectId: parent.project_id,
      version: nextVersion(db, parent.project_id),
      content: input.content,
      contentHash: createHash("sha256").update(input.content, "utf8").digest("hex"),
      changeNote: input.changeNote,
      basedOnRoundId: parent.based_on_round_id,
      parentId: parent.id,
      createdAt,
    });

    return {
      plan: readPlan(db, id)!,
      superseded: previous.map((row) => readPlan(db, row.id)!),
    };
  });
}

/** 定稿后发现漏了（plan.derive）：从 FINAL 派生一个新的 DRAFT，版本链不断 */
export function derivePlan(
  db: SqliteDatabase,
  queue: WriteQueue,
  planVersionId: string,
): Promise<{ plan: PlanVersionRow; superseded: PlanVersionRow[] }> {
  return writeTransaction(db, queue, () => {
    const parent = readPlan(db, planVersionId);
    if (parent === undefined) throw new PlanError("plan_not_found", "plan version not found");
    if (parent.state !== "FINAL") throw new PlanError("plan_not_final", "plan is " + parent.state);

    // 只能从「最新的有效版本」派生：已经有更新的 FINAL / CURRENT / DRAFT 时，
    // 再从旧版本派生只会克隆出一份内容相同的空版本（v2、v3…无限叠）。
    const latest = db
      .prepare(
        "SELECT MAX(version) AS version FROM plan_versions WHERE project_id = ? AND state IN ('FINAL', 'CURRENT', 'DRAFT')",
      )
      .get(parent.project_id) as { version: number | null };
    if (latest.version !== null && latest.version > parent.version) {
      throw new PlanError(
        "plan_not_latest",
        "plan v" + parent.version + " is not the latest active version (v" + latest.version + " exists)",
      );
    }

    const createdAt = now();
    // 和 plan.edit 一样：一个议题同时只能有一个 DRAFT。
    // 连点「派生下一版」不应该叠出多个草稿（v2、v3…都还挂在 v1 下面）。
    const previous = db
      .prepare("SELECT id FROM plan_versions WHERE project_id = ? AND state = 'DRAFT'")
      .all(parent.project_id) as { id: string }[];
    for (const row of previous) {
      db.prepare(
        "UPDATE plan_versions SET state = 'SUPERSEDED', superseded_reason = ?, decided_at = ? WHERE id = ? AND state = 'DRAFT'",
      ).run("被新派生的版本取代", createdAt, row.id);
    }

    const id = insertPlanVersion(db, {
      projectId: parent.project_id,
      version: nextVersion(db, parent.project_id),
      content: parent.content,
      contentHash: parent.content_hash,
      changeNote: "从 v" + parent.version + " 派生",
      basedOnRoundId: parent.based_on_round_id,
      parentId: parent.id,
      createdAt,
    });
    return { plan: readPlan(db, id)!, superseded: previous.map((row) => readPlan(db, row.id)!) };
  });
}

