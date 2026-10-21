import { assemblePrompt } from "@room/core";
import { approveAndCreateRun, type RunRow, type SqliteDatabase, ulid, type WriteQueue, writeTransaction } from "@room/db";
import type {
  AgentProfile,
  Approval,
  ApprovalBatch,
  BatchItem,
  Contribution,
  Message,
  PlanVersion,
  Project,
  PromptSnapshot,
  Round,
  RoundSummary,
  Run,
  Turn,
} from "@room/schemas";

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
  };
  const kind = row["kind"];
  if (kind === "reviewer_output") {
    return { ...base, kind, sourceAgent: row["source_agent"] as string, runId: row["run_id"] as string };
  }
  if (kind === "human_note") {
    return { ...base, kind, roundId: (row["round_id"] as string | null) ?? null };
  }
  if (kind === "agent_reply") {
    return {
      ...base,
      kind,
      sourceAgent: row["source_agent"] as string,
      onBehalfOf: (row["on_behalf_of"] as string | null) ?? null,
      roundId: row["round_id"] as string,
      turnId: row["turn_id"] as string,
      runId: row["run_id"] as string,
    };
  }
  if (kind === "summary") {
    return {
      ...base,
      kind,
      sourceAgent: row["source_agent"] as string,
      roundId: row["round_id"] as string,
      turnId: row["turn_id"] as string,
      runId: row["run_id"] as string,
    };
  }
  return { ...base, kind: "source_input", sourceAgent: row["source_agent"] as string };
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


const toRound = (row: Record<string, unknown>): Round => ({
  id: row["id"] as string,
  projectId: row["project_id"] as string,
  index: row["round_index"] as number,
  state: row["state"] as Round["state"],
  task: row["task"] as string,
  taskSource: row["task_source"] as Round["taskSource"],
  recipients: JSON.parse(row["recipients"] as string) as string[],
  planVersionId: (row["plan_version_id"] as string | null) ?? null,
  historyMode: row["history_mode"] as Round["historyMode"],
  voidReason: (row["void_reason"] as string | null) ?? null,
  activeMs: row["active_ms"] as number,
  createdAt: row["created_at"] as string,
  startedAt: (row["started_at"] as string | null) ?? null,
  finishedAt: (row["finished_at"] as string | null) ?? null,
});

const toBatchItem = (row: Record<string, unknown>): BatchItem => ({
  recipient: row["recipient"] as string,
  onBehalfOf: (row["on_behalf_of"] as string | null) ?? null,
  approvalId: row["approval_id"] as string,
  snapshotId: row["snapshot_id"] as string,
  contentHash: row["content_hash"] as string,
  differsFromOthers: row["differs_from_others"] === 1,
  tokenEstimate: row["token_estimate"] as number,
});

const toBatch = (row: Record<string, unknown>, items: BatchItem[]): ApprovalBatch => ({
  id: row["id"] as string,
  projectId: row["project_id"] as string,
  roundId: row["round_id"] as string,
  kind: row["kind"] as ApprovalBatch["kind"],
  state: row["state"] as ApprovalBatch["state"],
  items,
  compressedRounds: JSON.parse(row["compressed_rounds"] as string) as ApprovalBatch["compressedRounds"],
  decidedVia: (row["decided_via"] as ApprovalBatch["decidedVia"]) ?? null,
  createdAt: row["created_at"] as string,
  decidedAt: (row["decided_at"] as string | null) ?? null,
});

const toTurn = (row: Record<string, unknown>): Turn => ({
  id: row["id"] as string,
  roundId: row["round_id"] as string,
  batchId: row["batch_id"] as string,
  agent: row["agent"] as string,
  onBehalfOf: (row["on_behalf_of"] as string | null) ?? null,
  isSummary: row["is_summary"] === 1,
  approvalId: row["approval_id"] as string,
  runId: (row["run_id"] as string | null) ?? null,
  outcome: row["outcome"] as Turn["outcome"],
  partialText: (row["partial_text"] as string | null) ?? null,
  replyMessageId: (row["reply_message_id"] as string | null) ?? null,
  supersededBy: (row["superseded_by"] as string | null) ?? null,
  createdAt: row["created_at"] as string,
  finishedAt: (row["finished_at"] as string | null) ?? null,
});

const toRoundSummary = (row: Record<string, unknown>): RoundSummary => ({
  roundId: row["round_id"] as string,
  messageId: row["message_id"] as string,
  summarizer: row["summarizer"] as string,
  answered: row["answered"] as number,
  expected: row["expected"] as number,
  report: row["report"] === null ? null : (JSON.parse(row["report"] as string) as RoundSummary["report"]),
  planVersionId: (row["plan_version_id"] as string | null) ?? null,
  createdAt: row["created_at"] as string,
});

const toPlan = (row: Record<string, unknown>): PlanVersion => ({
  id: row["id"] as string,
  projectId: row["project_id"] as string,
  version: row["version"] as number,
  state: row["state"] as PlanVersion["state"],
  content: row["content"] as string,
  contentHash: row["content_hash"] as string,
  changeNote: row["change_note"] as string,
  basedOnRoundId: (row["based_on_round_id"] as string | null) ?? null,
  parentId: (row["parent_id"] as string | null) ?? null,
  draftedBy:
    row["drafted_by_kind"] === "agent"
      ? { kind: "agent", agent: row["drafted_by_agent"] as string }
      : { kind: "human" },
  supersededReason: (row["superseded_reason"] as string | null) ?? null,
  createdAt: row["created_at"] as string,
  decidedAt: (row["decided_at"] as string | null) ?? null,
});

const toAgent = (row: Record<string, unknown>): AgentProfile => ({
  id: row["id"] as string,
  displayName: row["display_name"] as string,
  color: row["color"] as string,
  avatarRef: (row["avatar_ref"] as string | null) ?? null,
  roleNote: row["role_note"] as string,
  canDiscuss: row["can_discuss"] === 1,
  canSummarize: row["can_summarize"] === 1,
  canExecute: row["can_execute"] === 1,
  nodeId: (row["node_id"] as string | null) ?? null,
  profileId: (row["profile_id"] as string | null) ?? null,
  pausedByUser: row["paused_by_user"] === 1,
  substitute: (row["substitute"] as string | null) ?? null,
});

export interface UpsertAgentInput {
  id: string;
  displayName?: string;
  color?: string;
  roleNote?: string;
  canDiscuss?: boolean;
  canSummarize?: boolean;
  canExecute?: boolean;
  nodeId?: string | null;
  profileId?: string | null;
  pausedByUser?: boolean;
  substitute?: string | null;
}

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

  getApproval(approvalId: string): Approval {
    const row = this.#db.prepare("SELECT * FROM approvals WHERE id = ?").get(approvalId) as
      | Record<string, unknown>
      | undefined;
    if (row === undefined) throw new RepositoryError("not_found", "approval not found");
    return toApproval(row);
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

  // ---------------------------------------------------------------- 讨论室（ADR-002 / C-20）

  getProject(projectId: string): Project {
    const row = this.#db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as Record<string, unknown> | undefined;
    if (row === undefined) throw new RepositoryError("not_found", "project not found");
    return toProject(row);
  }

  getRunRow(runId: string): RunRow {
    const row = this.#db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as RunRow | undefined;
    if (row === undefined) throw new RepositoryError("not_found", "run not found");
    return row;
  }

  getMessage(messageId: string): Message {
    const row = this.#db.prepare("SELECT * FROM messages WHERE id = ?").get(messageId) as Record<string, unknown> | undefined;
    if (row === undefined) throw new RepositoryError("not_found", "message not found");
    return toMessage(row);
  }

  listAgents(): AgentProfile[] {
    return (this.#db.prepare("SELECT * FROM agents ORDER BY id").all() as Record<string, unknown>[]).map(toAgent);
  }

  getAgentRow(agentId: string): Record<string, unknown> | undefined {
    return this.#db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId) as Record<string, unknown> | undefined;
  }

  getAgent(agentId: string): AgentProfile {
    const row = this.getAgentRow(agentId);
    if (row === undefined) throw new RepositoryError("not_found", "agent not found");
    return toAgent(row);
  }

  /** 新建或修改参与者。已有就只改传进来的字段；没有就按默认值补全建一条。 */
  async upsertAgent(input: UpsertAgentInput): Promise<AgentProfile> {
    const updatedAt = now();
    await writeTransaction(this.#db, this.#queue, () => {
      const existing = this.getAgentRow(input.id);

      if (existing === undefined) {
        this.#db
          .prepare(
            "INSERT INTO agents (id, display_name, color, role_note, can_discuss, can_summarize, can_execute, " +
              "node_id, profile_id, paused_by_user, substitute, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            input.id,
            input.displayName ?? input.id,
            input.color ?? "#5b6b66",
            input.roleNote ?? "",
            (input.canDiscuss ?? true) ? 1 : 0,
            (input.canSummarize ?? false) ? 1 : 0,
            (input.canExecute ?? false) ? 1 : 0,
            input.nodeId ?? null,
            input.profileId ?? null,
            (input.pausedByUser ?? false) ? 1 : 0,
            input.substitute ?? null,
            updatedAt,
            updatedAt,
          );
        return;
      }

      const columns: [keyof UpsertAgentInput, string][] = [
        ["displayName", "display_name"],
        ["color", "color"],
        ["roleNote", "role_note"],
        ["canDiscuss", "can_discuss"],
        ["canSummarize", "can_summarize"],
        ["canExecute", "can_execute"],
        ["nodeId", "node_id"],
        ["profileId", "profile_id"],
        ["pausedByUser", "paused_by_user"],
        ["substitute", "substitute"],
      ];
      const sets: string[] = [];
      const params: unknown[] = [];
      for (const [key, column] of columns) {
        const value = input[key];
        if (value === undefined) continue;
        sets.push(column + " = ?");
        params.push(typeof value === "boolean" ? (value ? 1 : 0) : value);
      }
      sets.push("updated_at = ?");
      params.push(updatedAt, input.id);
      this.#db.prepare("UPDATE agents SET " + sets.join(", ") + " WHERE id = ?").run(...(params as never[]));
    });

    return this.getAgent(input.id);
  }

  listMessagesByRound(roundId: string): Message[] {
    return (
      this.#db.prepare("SELECT * FROM messages WHERE round_id = ? ORDER BY created_at, rowid").all(roundId) as Record<string, unknown>[]
    ).map(toMessage);
  }

  getNodeRow(nodeId: string): { id: string; base_url: string | null } | undefined {
    return this.#db.prepare("SELECT id, base_url FROM nodes WHERE id = ?").get(nodeId) as
      | { id: string; base_url: string | null }
      | undefined;
  }

  listNodeRows(): { id: string; display_name: string; base_url: string | null }[] {
    return this.#db.prepare("SELECT id, display_name, base_url FROM nodes ORDER BY id").all() as {
      id: string;
      display_name: string;
      base_url: string | null;
    }[];
  }

  async upsertNodeRow(input: { id: string; label: string; baseUrl: string }): Promise<void> {
    const createdAt = now();
    await writeTransaction(this.#db, this.#queue, () => {
      this.#db
        .prepare(
          "INSERT INTO nodes (id, display_name, base_url, created_at) VALUES (?, ?, ?, ?) " +
            "ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name, base_url = excluded.base_url",
        )
        .run(input.id, input.label, input.baseUrl, createdAt);
    });
  }

  nextRoundIndex(projectId: string): number {
    return (
      this.#db.prepare("SELECT COALESCE(MAX(round_index), 0) + 1 AS n FROM rounds WHERE project_id = ?").get(projectId) as { n: number }
    ).n;
  }

  listRounds(projectId: string): Round[] {
    return (
      this.#db.prepare("SELECT * FROM rounds WHERE project_id = ? ORDER BY round_index").all(projectId) as Record<string, unknown>[]
    ).map(toRound);
  }

  getRound(roundId: string): Round {
    const row = this.#db.prepare("SELECT * FROM rounds WHERE id = ?").get(roundId) as Record<string, unknown> | undefined;
    if (row === undefined) throw new RepositoryError("not_found", "round not found");
    return toRound(row);
  }

  listBatchItems(batchId: string): BatchItem[] {
    return (
      this.#db.prepare("SELECT * FROM batch_items WHERE batch_id = ? ORDER BY recipient").all(batchId) as Record<string, unknown>[]
    ).map(toBatchItem);
  }

  /** 确认页用：批次里的每个收件人对应一份完整 Snapshot，顺序和 batch.items 一致 */
  listSnapshotsForBatch(batchId: string): PromptSnapshot[] {
    return (
      this.#db
        .prepare(
          "SELECT s.* FROM prompt_snapshots s JOIN batch_items bi ON bi.snapshot_id = s.id " +
            "WHERE bi.batch_id = ? ORDER BY bi.recipient",
        )
        .all(batchId) as Record<string, unknown>[]
    ).map(toSnapshot);
  }

  listBatches(roundId: string): ApprovalBatch[] {
    return (
      this.#db.prepare("SELECT * FROM batches WHERE round_id = ? ORDER BY created_at").all(roundId) as Record<string, unknown>[]
    ).map((row) => toBatch(row, this.listBatchItems(row["id"] as string)));
  }

  getBatch(batchId: string): ApprovalBatch {
    const row = this.#db.prepare("SELECT * FROM batches WHERE id = ?").get(batchId) as Record<string, unknown> | undefined;
    if (row === undefined) throw new RepositoryError("not_found", "batch not found");
    return toBatch(row, this.listBatchItems(batchId));
  }

  listTurns(roundId: string): Turn[] {
    return (
      this.#db.prepare("SELECT * FROM turns WHERE round_id = ? ORDER BY created_at, rowid").all(roundId) as Record<string, unknown>[]
    ).map(toTurn);
  }

  listTurnsByBatch(batchId: string): Turn[] {
    return (
      this.#db.prepare("SELECT * FROM turns WHERE batch_id = ? ORDER BY created_at, rowid").all(batchId) as Record<string, unknown>[]
    ).map(toTurn);
  }

  getTurn(turnId: string): Turn {
    const row = this.#db.prepare("SELECT * FROM turns WHERE id = ?").get(turnId) as Record<string, unknown> | undefined;
    if (row === undefined) throw new RepositoryError("not_found", "turn not found");
    return toTurn(row);
  }

  getTurnByApproval(approvalId: string): Turn {
    const row = this.#db.prepare("SELECT * FROM turns WHERE approval_id = ?").get(approvalId) as Record<string, unknown> | undefined;
    if (row === undefined) throw new RepositoryError("not_found", "turn not found");
    return toTurn(row);
  }

  getRoundSummary(roundId: string): RoundSummary | null {
    const row = this.#db.prepare("SELECT * FROM round_summaries WHERE round_id = ?").get(roundId) as Record<string, unknown> | undefined;
    return row === undefined ? null : toRoundSummary(row);
  }

  getPlan(planVersionId: string): PlanVersion {
    const row = this.#db.prepare("SELECT * FROM plan_versions WHERE id = ?").get(planVersionId) as Record<string, unknown> | undefined;
    if (row === undefined) throw new RepositoryError("not_found", "plan version not found");
    return toPlan(row);
  }

  listPlans(projectId: string): PlanVersion[] {
    return (
      this.#db.prepare("SELECT * FROM plan_versions WHERE project_id = ? ORDER BY version").all(projectId) as Record<string, unknown>[]
    ).map(toPlan);
  }

  /**
   * 拼讨论 Prompt 用的历史：只取**已经汇总**的轮（作废 / 未结束的不发给 Agent）。
   * 每轮带上它的消息、Turn 和汇总，core 自己决定最近两轮发全文、更早的用摘要。
   */
  discussionHistory(
    projectId: string,
    beforeIndex: number,
  ): {
    round: Round;
    messages: Message[];
    turns: Turn[];
    summary: { record: RoundSummary; message: Extract<Message, { kind: "summary" }> } | null;
  }[] {
    const rounds = (
      this.#db
        .prepare("SELECT * FROM rounds WHERE project_id = ? AND state = 'SUMMARIZED' AND round_index < ? ORDER BY round_index")
        .all(projectId, beforeIndex) as Record<string, unknown>[]
    ).map(toRound);

    return rounds.map((round) => {
      const messages = (
        this.#db.prepare("SELECT * FROM messages WHERE round_id = ? ORDER BY created_at, rowid").all(round.id) as Record<string, unknown>[]
      ).map(toMessage);
      const turns = (
        this.#db.prepare("SELECT * FROM turns WHERE round_id = ? ORDER BY created_at, rowid").all(round.id) as Record<string, unknown>[]
      ).map(toTurn);
      const record = this.getRoundSummary(round.id);
      const message = record === null ? undefined : messages.find((m) => m.id === record.messageId);
      return {
        round,
        messages,
        turns,
        // core 只认 kind = summary 的那条；对不上就当作没有汇总（不让它悄悄变成别的消息）
        summary: record !== null && message !== undefined && message.kind === "summary" ? { record, message } : null,
      };
    });
  }

  /** 这一轮有没有「正式回答」——没有的话不允许汇总（0-B 补充规则） */
  countAnsweredTurns(roundId: string): number {
    return (
      this.#db
        .prepare("SELECT count(*) AS n FROM turns WHERE round_id = ? AND is_summary = 0 AND outcome = 'answered'")
        .get(roundId) as { n: number }
    ).n;
  }

  /**
   * 这个 Agent 在所有议题里最新一次发言的结局与结束时间。
   * 额度是按账号算的：不按议题过滤；汇总时额度用尽也算缺席，所以也不过滤 is_summary。
   * 结束时间优先用 finished_at，老数据没有就用 created_at。
   */
  latestTurnOutcomeGlobal(agentId: string): { outcome: string; finishedAt: string | null } | null {
    const row = this.#db
      .prepare(
        "SELECT t.outcome AS outcome, COALESCE(t.finished_at, t.created_at) AS finished_at FROM turns t " +
          "WHERE t.agent = ? ORDER BY t.created_at DESC, t.rowid DESC LIMIT 1",
      )
      .get(agentId) as { outcome: string; finished_at: string | null } | undefined;
    return row === undefined ? null : { outcome: row.outcome, finishedAt: row.finished_at };
  }

  /** 这个人在这一轮当过替补吗（当过就不能当汇总者） */
  hasTurnAsSubstitute(roundId: string, agentId: string): boolean {
    const row = this.#db
      .prepare(
        "SELECT 1 AS yes FROM turns WHERE round_id = ? AND agent = ? AND on_behalf_of IS NOT NULL AND is_summary = 0 LIMIT 1",
      )
      .get(roundId, agentId) as { yes: number } | undefined;
    return row !== undefined;
  }
}

function contributionIds(ids: readonly string[]): string[] {
  return [...ids];
}
