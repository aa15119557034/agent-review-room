import { assemblePrompt } from "@room/core";
import { approveAndCreateRun, type RunRow, type SqliteDatabase, ulid, type WriteQueue, writeTransaction } from "@room/db";
import type { Approval, Contribution, Message, Project, PromptSnapshot, Run } from "@room/schemas";

/**
 * 控制面的数据读写（D-07）。
 *
 * 只做「把契约里的命令翻译成 SQL」这一件事，不在这里做权限和 IPC 校验——
 * 那些在 ipc.ts。所有写操作走 writeTransaction（单写者队列 + BEGIN IMMEDIATE）。
 */

export class RepositoryError extends Error {
  readonly code: "not_found" | "invalid_state" | "invalid_selection";
  constructor(code: "not_found" | "invalid_state" | "invalid_selection", message: string) {
    super(message);
    this.name = "RepositoryError";
    this.code = code;
  }
}

const now = (): string => new Date().toISOString();

const toProject = (row: Record<string, unknown>): Project => ({
  id: row["id"] as string,
  name: row["name"] as string,
  createdAt: row["created_at"] as string,
});

const toMessage = (row: Record<string, unknown>): Message => {
  const base = {
    id: row["id"] as string,
    projectId: row["project_id"] as string,
    content: row["content"] as string,
    createdAt: row["created_at"] as string,
    sourceAgent: row["source_agent"] as string,
  };
  if (row["kind"] === "reviewer_output") return { ...base, kind: "reviewer_output", runId: row["run_id"] as string };
  return { ...base, kind: "source_input" };
};

const toContribution = (row: Record<string, unknown>): Contribution => ({
  id: row["id"] as string,
  projectId: row["project_id"] as string,
  sourceMessageId: row["source_message_id"] as string,
  type: row["type"] as Contribution["type"],
  title: row["title"] as string,
  content: row["content"] as string,
  selection: { start: row["selection_start"] as number, end: row["selection_end"] as number },
  confidence: (row["confidence"] as number | null) ?? null,
  createdBy: row["created_by"] as Contribution["createdBy"],
  schemaVersion: 1,
  createdAt: row["created_at"] as string,
});

const toSnapshot = (row: Record<string, unknown>): PromptSnapshot => ({
  id: row["id"] as string,
  projectId: row["project_id"] as string,
  content: row["content"] as string,
  contentHash: row["content_hash"] as string,
  nonce: row["nonce"] as string,
  contributionIds: JSON.parse(row["contribution_ids"] as string) as string[],
  taskInstruction: row["task_instruction"] as string,
  reviewerAgent: row["reviewer_agent"] as string,
  adapterVersion: row["adapter_version"] as string,
  tokenEstimate: row["token_estimate"] as number,
  synthesisVersion: (row["synthesis_version"] as number | null) ?? null,
  branch: (row["branch"] as string | null) ?? null,
  commitSha: (row["commit_sha"] as string | null) ?? null,
  createdAt: row["created_at"] as string,
});

const toApproval = (row: Record<string, unknown>): Approval => ({
  id: row["id"] as string,
  projectId: row["project_id"] as string,
  snapshotId: row["snapshot_id"] as string,
  state: row["state"] as Approval["state"],
  decidedVia: (row["decided_via"] as Approval["decidedVia"]) ?? null,
  reason: (row["reason"] as string | null) ?? null,
  createdAt: row["created_at"] as string,
  decidedAt: (row["decided_at"] as string | null) ?? null,
});

const toRun = (row: RunRow): Run => ({
  id: row.id,
  projectId: row.project_id,
  approvalId: row.approval_id,
  snapshotId: row.snapshot_id,
  adapterId: row.adapter_id,
  state: row.state,
  substate: row.substate,
  failureReason: row.failure_reason,
  createdAt: row.created_at,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
});

export interface CreateSnapshotInput {
  projectId: string;
  contributionIds: string[];
  taskInstruction: string;
  reviewerAgent: string;
}

export class Repository {
  readonly #db: SqliteDatabase;
  readonly #queue: WriteQueue;

  constructor(db: SqliteDatabase, queue: WriteQueue) {
    this.#db = db;
    this.#queue = queue;
  }

  async createProject(name: string): Promise<Project> {
    const id = "proj_" + ulid();
    const createdAt = now();
    await writeTransaction(this.#db, this.#queue, () => {
      this.#db.prepare("INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)").run(id, name, createdAt);
    });
    return { id, name, createdAt };
  }

  async addSource(projectId: string, sourceAgent: string, content: string): Promise<Message> {
    const id = "msg_" + ulid();
    const createdAt = now();
    await writeTransaction(this.#db, this.#queue, () => {
      this.#db
        .prepare(
          "INSERT INTO messages (id, project_id, kind, source_agent, run_id, content, created_at) " +
            "VALUES (?, ?, 'source_input', ?, NULL, ?, ?)",
        )
        .run(id, projectId, sourceAgent, content, createdAt);
    });
    return { id, projectId, kind: "source_input", sourceAgent, content, createdAt };
  }

  async createContribution(input: {
    projectId: string;
    sourceMessageId: string;
    contributionType: Contribution["type"];
    title: string;
    selection: { start: number; end: number };
  }): Promise<Contribution> {
    const source = this.#db
      .prepare("SELECT content FROM messages WHERE id = ? AND project_id = ?")
      .get(input.sourceMessageId, input.projectId) as { content: string } | undefined;
    if (source === undefined) throw new RepositoryError("not_found", "source message not found");
    if (input.selection.end > source.content.length) {
      throw new RepositoryError("invalid_selection", "selection is outside the source message");
    }

    const content = source.content.slice(input.selection.start, input.selection.end);
    const id = "c_" + ulid();
    const createdAt = now();

    await writeTransaction(this.#db, this.#queue, () => {
      this.#db
        .prepare(
          "INSERT INTO contributions (id, project_id, source_message_id, type, title, content, selection_start, " +
            "selection_end, confidence, created_by, schema_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'human', 1, ?)",
        )
        .run(
          id,
          input.projectId,
          input.sourceMessageId,
          input.contributionType,
          input.title,
          content,
          input.selection.start,
          input.selection.end,
          createdAt,
        );
    });

    return {
      id,
      projectId: input.projectId,
      sourceMessageId: input.sourceMessageId,
      type: input.contributionType,
      title: input.title,
      content,
      selection: input.selection,
      confidence: null,
      createdBy: "human",
      schemaVersion: 1,
      createdAt,
    };
  }

  /** AC-3/4/5：拼装不可变 Snapshot，同时把之前悬着的审批置为 EXPIRED，并创建 READY_FOR_REVIEW。 */
  async createSnapshot(input: CreateSnapshotInput): Promise<{ snapshot: PromptSnapshot; approval: Approval }> {
    const rows = input.contributionIds.map((id) => {
      const row = this.#db
        .prepare("SELECT * FROM contributions WHERE id = ? AND project_id = ?")
        .get(id, input.projectId) as Record<string, unknown> | undefined;
      if (row === undefined) throw new RepositoryError("not_found", "contribution " + id + " not found in project");
      return row;
    });

    const contributions = rows.map(toContribution);
    const assembled = assemblePrompt({
      contributions: contributions.map((c) => ({ id: c.id, type: c.type, title: c.title, content: c.content })),
      taskInstruction: input.taskInstruction,
      reviewerAgent: input.reviewerAgent,
    });

    const snapshotId = "snap_" + ulid();
    const approvalId = "apr_" + ulid();
    const createdAt = now();

    await writeTransaction(this.#db, this.#queue, () => {
      // 旧的待审审批作废（没有产生 Run 的）
      this.#db
        .prepare(
          "UPDATE approvals SET state = 'EXPIRED', decided_at = ? " +
            "WHERE project_id = ? AND state IN ('READY_FOR_REVIEW', 'APPROVED') " +
            "AND id NOT IN (SELECT approval_id FROM runs)",
        )
        .run(createdAt, input.projectId);

      this.#db
        .prepare(
          "INSERT INTO prompt_snapshots (id, project_id, content, content_hash, nonce, contribution_ids, " +
            "task_instruction, reviewer_agent, adapter_version, token_estimate, synthesis_version, branch, commit_sha, created_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)",
        )
        .run(
          snapshotId,
          input.projectId,
          assembled.content,
          assembled.contentHash,
          assembled.nonce,
          JSON.stringify(contributionIds(assembled.contributionIds)),
          input.taskInstruction,
          input.reviewerAgent,
          assembled.adapterVersion,
          assembled.tokenEstimate,
          createdAt,
        );

      this.#db
        .prepare(
          "INSERT INTO approvals (id, project_id, snapshot_id, state, decided_via, reason, created_at, decided_at) " +
            "VALUES (?, ?, ?, 'READY_FOR_REVIEW', NULL, NULL, ?, NULL)",
        )
        .run(approvalId, input.projectId, snapshotId, createdAt);
    });

    return {
      snapshot: {
        id: snapshotId,
        projectId: input.projectId,
        content: assembled.content,
        contentHash: assembled.contentHash,
        nonce: assembled.nonce,
        contributionIds: [...assembled.contributionIds],
        taskInstruction: input.taskInstruction,
        reviewerAgent: input.reviewerAgent,
        adapterVersion: assembled.adapterVersion,
        tokenEstimate: assembled.tokenEstimate,
        synthesisVersion: null,
        branch: null,
        commitSha: null,
        createdAt,
      },
      approval: {
        id: approvalId,
        projectId: input.projectId,
        snapshotId,
        state: "READY_FOR_REVIEW",
        decidedVia: null,
        reason: null,
        createdAt,
        decidedAt: null,
      },
    };
  }

  async approve(input: { approvalId: string; expectedSnapshotHash: string; adapterId: string }) {
    const result = await approveAndCreateRun(this.#db, this.#queue, {
      approvalId: input.approvalId,
      expectedSnapshotHash: input.expectedSnapshotHash,
      adapterId: input.adapterId,
      decidedVia: "desktop",
    });
    return { approval: toApproval(result.approval as unknown as Record<string, unknown>), run: toRun(result.run) };
  }

  async reject(approvalId: string, reason: string | undefined): Promise<Approval> {
    return writeTransaction(this.#db, this.#queue, () => {
      const decidedAt = now();
      const result = this.#db
        .prepare(
          "UPDATE approvals SET state = 'REJECTED', reason = ?, decided_via = 'desktop', decided_at = ? " +
            "WHERE id = ? AND state = 'READY_FOR_REVIEW'",
        )
        .run(reason ?? null, decidedAt, approvalId);
      if (result.changes !== 1) {
        throw new RepositoryError("invalid_state", "approval is not waiting for review");
      }
      const row = this.#db.prepare("SELECT * FROM approvals WHERE id = ?").get(approvalId) as Record<string, unknown>;
      return toApproval(row);
    });
  }

  listProjects(): Project[] {
    return (this.#db.prepare("SELECT * FROM projects ORDER BY created_at DESC").all() as Record<string, unknown>[]).map(toProject);
  }

  listMessages(projectId: string): Message[] {
    return (
      this.#db.prepare("SELECT * FROM messages WHERE project_id = ? ORDER BY created_at").all(projectId) as Record<string, unknown>[]
    ).map(toMessage);
  }

  listContributions(projectId: string): Contribution[] {
    return (
      this.#db
        .prepare("SELECT * FROM contributions WHERE project_id = ? ORDER BY created_at")
        .all(projectId) as Record<string, unknown>[]
    ).map(toContribution);
  }

  getSnapshot(snapshotId: string): PromptSnapshot {
    const row = this.#db.prepare("SELECT * FROM prompt_snapshots WHERE id = ?").get(snapshotId) as
      | Record<string, unknown>
      | undefined;
    if (row === undefined) throw new RepositoryError("not_found", "snapshot not found");
    return toSnapshot(row);
  }

  listApprovals(projectId: string, pendingOnly: boolean): Approval[] {
    const sql = pendingOnly
      ? "SELECT * FROM approvals WHERE project_id = ? AND state = 'READY_FOR_REVIEW' ORDER BY created_at DESC"
      : "SELECT * FROM approvals WHERE project_id = ? ORDER BY created_at DESC";
    return (this.#db.prepare(sql).all(projectId) as Record<string, unknown>[]).map(toApproval);
  }

  listRuns(projectId: string, limit: number): Run[] {
    return (
      this.#db
        .prepare("SELECT * FROM runs WHERE project_id = ? ORDER BY created_at DESC LIMIT ?")
        .all(projectId, limit) as RunRow[]
    ).map(toRun);
  }

  getRun(runId: string): Run {
    const row = this.#db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as RunRow | undefined;
    if (row === undefined) throw new RepositoryError("not_found", "run not found");
    return toRun(row);
  }

  listEvents(
    runId: string,
    after: number,
  ): { seq: number; eventId: string; type: string; payload: unknown; ts: string }[] {
    const rows = this.#db
      .prepare(
        "SELECT seq, event_id AS eventId, type, payload, ts FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq",
      )
      .all(runId, after) as { seq: number; eventId: string; type: string; payload: string; ts: string }[];
    return rows.map((r) => ({
      seq: r.seq,
      eventId: r.eventId,
      type: r.type,
      payload: JSON.parse(r.payload) as unknown,
      ts: r.ts,
    }));
  }
}

function contributionIds(ids: readonly string[]): string[] {
  return [...ids];
}
