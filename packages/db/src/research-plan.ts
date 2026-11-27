import { createHash, randomBytes } from "node:crypto";
import { ProjectResearchPlan, projectResearchApprovalContent } from "@room/schemas";
import type { SqliteDatabase } from "./database";
import { ulid } from "./ulid";

const hash = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
export class ProjectResearchError extends Error {
  constructor(message: string, readonly code: "stale_snapshot" | "invalid_state" | "not_found" | "agent_unavailable" = "invalid_state") { super(message); this.name = "ProjectResearchError"; }
}

/** Null means an ordinary snapshot. A damaged research marker must never fall back to review. */
export function readResearchPlan(db: SqliteDatabase, snapshotId: string): { plan: ProjectResearchPlan; researchHash: string } | null {
  const row = db.prepare("SELECT * FROM prompt_snapshots WHERE id = ?").get(snapshotId) as Record<string, unknown> | undefined;
  if (!row) throw new ProjectResearchError("snapshot not found", "not_found");
  if (row["adapter_version"] !== "project-research-v1" && row["research_plan"] == null && row["research_hash"] == null) return null;
  if (row["adapter_version"] !== "project-research-v1" || typeof row["research_plan"] !== "string" || typeof row["research_hash"] !== "string") throw new ProjectResearchError("research authorization is incomplete");
  const plan = ProjectResearchPlan.parse(JSON.parse(row["research_plan"]));
  if (plan.snapshotId !== snapshotId || plan.projectId !== row["project_id"] || plan.query !== row["content"] ||
      plan.target.profileId !== row["reviewer_agent"] || hash(plan.query) !== row["content_hash"] ||
      hash(projectResearchApprovalContent(plan)) !== row["research_hash"] || row["contribution_ids"] !== "[]" ||
      ["source_refs", "attachments", "image_slot", "project_note_id", "branch", "commit_sha", "synthesis_version"].some((key) => row[key] != null)) {
    throw new ProjectResearchError("research plan no longer matches its immutable snapshot");
  }
  return { plan, researchHash: row["research_hash"] };
}

export function assertOrdinarySnapshot(db: SqliteDatabase, snapshotId: string): void {
  if (readResearchPlan(db, snapshotId)) throw new ProjectResearchError("project research requires research.approve and its research hash");
}

/** Caller owns the write transaction and must check its database context immediately before this call. */
export function insertResearchPlanTx(db: SqliteDatabase, value: ProjectResearchPlan, now = new Date().toISOString()) {
  const plan = ProjectResearchPlan.parse(value);
  const researchHash = hash(projectResearchApprovalContent(plan));
  const approvalId = "apr_" + ulid();
  db.prepare("INSERT INTO prompt_snapshots (id, project_id, content, content_hash, nonce, contribution_ids, task_instruction, reviewer_agent, adapter_version, token_estimate, created_at, research_plan, research_hash) VALUES (?, ?, ?, ?, ?, '[]', ?, ?, 'project-research-v1', ?, ?, ?, ?)")
    .run(plan.snapshotId, plan.projectId, plan.query, hash(plan.query), randomBytes(16).toString("hex"), plan.query, plan.target.profileId, Math.ceil(plan.query.length / 4), now, JSON.stringify(plan), researchHash);
  db.prepare("INSERT INTO approvals (id, project_id, snapshot_id, state, created_at) VALUES (?, ?, ?, 'READY_FOR_REVIEW', ?)").run(approvalId, plan.projectId, plan.snapshotId, now);
  return { approvalId, plan, researchHash };
}
