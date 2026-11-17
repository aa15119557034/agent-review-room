import { createHash } from "node:crypto";
import { ProjectSourcesCurrent, ProjectSourcePreview, PROJECT_RESEARCH_QUERIES, SourceReferences, type ChatContent, type SourceReference } from "@room/schemas";
import type { SqliteDatabase } from "./database";
import { ProjectResearchError } from "./research-plan";

/** Local query scope, not an IPC request or an authorization supplied by a provider. */
type Scope = { projectId: string } | { conversationId: string };
const hash = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** Expected source withdrawal, distinct from malformed references or ownership violations. */
export class SourceUnavailableError extends Error {
  readonly code = "stale_snapshot";
  constructor() {
    super("prompt source is no longer available; rebuild the prompt");
    this.name = "SourceUnavailableError";
  }
}

export function readSourceRefs(json: string | null | undefined): SourceReference[] | undefined {
  return json == null ? undefined : SourceReferences.parse(JSON.parse(json));
}

function ownerReferences(db: SqliteDatabase, projectId: string, owner: ProjectSourcesCurrent["owner"]): SourceReference[] {
  const table = owner.kind === "message" ? "messages" : "prompt_snapshots";
  const row = db.prepare("SELECT source_refs FROM " + table + " WHERE id = ? AND project_id = ?").get(owner.id, projectId) as { source_refs: string | null } | undefined;
  if (!row) throw new ProjectResearchError("source owner not found in this project", "not_found");
  return readSourceRefs(row.source_refs) ?? [];
}

export function currentProjectSources(db: SqliteDatabase, value: unknown): ProjectSourcesCurrent {
  const { projectId, owner } = PROJECT_RESEARCH_QUERIES["sources.current"].request.parse(value);
  return ProjectSourcesCurrent.parse({ projectId, owner, checkedAt: new Date().toISOString(), sources: ownerReferences(db, projectId, owner).map((reference, index) => ({
    index, reference, currentStatus: resolveSourceReference(db, { projectId }, reference).reference.status,
  })) });
}

export function previewProjectSource(db: SqliteDatabase, value: unknown): ProjectSourcePreview {
  const { projectId, owner, index } = PROJECT_RESEARCH_QUERIES["sources.preview"].request.parse(value);
  const reference = ownerReferences(db, projectId, owner)[index];
  if (!reference) throw new ProjectResearchError("source index not found on this owner", "not_found");
  const resolved = resolveSourceReference(db, { projectId }, reference);
  return ProjectSourcePreview.parse({ projectId, owner, index, reference, checkedAt: new Date().toISOString(), status: resolved.reference.status, content: resolved.content });
}

export function mergeSourceRefs(lists: readonly (readonly SourceReference[] | undefined)[]): SourceReference[] | undefined {
  const refs = [...new Map(lists.flatMap((list) => list ?? []).map((ref) => [JSON.stringify(ref), ref])).values()];
  return refs.length === 0 ? undefined : SourceReferences.parse(refs);
}

function chatText(row: { sender: string; content: string | null; text: string | null }): string {
  if (row.sender === "agent") return row.text!;
  const content = JSON.parse(row.content!) as ChatContent;
  return content.kind === "text" ? content.text : content.kind === "voice" ? content.transcript.text : content.label;
}

function chatRow(db: SqliteDatabase, id: string) {
  return db.prepare("SELECT m.*, p.state AS parent_state FROM chat_messages m LEFT JOIN chat_messages p ON p.id = m.in_reply_to WHERE m.id = ?").get(id) as
    | { id: string; conversation_id: string; sender: string; state: string | null; parent_state: string | null; content: string | null; text: string | null; source_refs: string | null }
    | undefined;
}

function assertChatScope(db: SqliteDatabase, scope: Scope, row: NonNullable<ReturnType<typeof chatRow>>): void {
  const allowed = "conversationId" in scope ? row.conversation_id === scope.conversationId : db.prepare(
    "SELECT 1 FROM messages m, json_each(m.chat_message_ids) j WHERE m.project_id = ? AND m.kind = 'chat_material' AND m.conversation_id = ? AND j.value = ?",
  ).get(scope.projectId, row.conversation_id, row.id) !== undefined;
  if (!allowed) throw new Error("source reference is outside the current project/conversation");
}

/** Re-evaluate a reference without rewriting the historical metadata. Never fetch URLs here. */
export function resolveSourceReference(db: SqliteDatabase, scope: Scope, ref: SourceReference, visiting = new Set<string>()): { reference: SourceReference; content: string | null } {
  const unavailable = (status: "missing" | "revoked") => ({ reference: { ...ref, status }, content: null });
  const key = JSON.stringify([ref.source, ref.version, ref.contentHash]);
  if (visiting.has(key)) return unavailable("missing");
  const path = new Set(visiting).add(key);
  let content: string;
  let refs: SourceReference[] | undefined;
  let dependencyScope = scope;
  if (ref.source.kind === "message") {
    if (!("projectId" in scope)) throw new Error("project source is outside the current conversation");
    const row = db.prepare("SELECT project_id, kind, conversation_id, chat_message_ids, content, source_refs FROM messages WHERE id = ?").get(ref.source.id) as
      | { project_id: string; kind: string; conversation_id: string | null; chat_message_ids: string | null; content: string; source_refs: string | null } | undefined;
    if (!row) return unavailable("missing");
    if (row.project_id !== scope.projectId) throw new Error("source message belongs to another project");
    if (row.kind === "chat_material" && (JSON.parse(row.chat_message_ids!) as string[]).some((id) => !isChatMessageCurrent(db, id, row.conversation_id!, path))) return unavailable("revoked");
    content = row.content;
    refs = readSourceRefs(row.source_refs);
    if (ref.version !== ref.source.id) return unavailable("missing");
  } else if (ref.source.kind === "chat_message") {
    const row = chatRow(db, ref.source.id);
    if (!row) return unavailable("missing");
    assertChatScope(db, scope, row);
    if ((row.sender === "user" ? row.state : row.parent_state) !== "sent") return unavailable("revoked");
    content = chatText(row);
    refs = readSourceRefs(row.source_refs);
    dependencyScope = { conversationId: row.conversation_id };
    if (ref.version !== ref.source.id) return unavailable("missing");
  } else {
    const source = ref.source;
    // A URL alone cannot stand in for readable text. Match its exact version/hash to a stored original.
    const rows = "projectId" in scope
      ? db.prepare("SELECT content, source_refs FROM messages WHERE project_id = ? AND kind = 'source_input' AND source_refs IS NOT NULL ORDER BY created_at, id").all(scope.projectId) as { content: string; source_refs: string }[]
      : [];
    const original = rows.find((row) => hash(row.content) === ref.contentHash && readSourceRefs(row.source_refs)!.some((stored) =>
      stored.source.kind === "web" && stored.source.url === (ref.source as { url: string }).url && stored.version === ref.version && stored.contentHash === ref.contentHash && stored.status === "readable"));
    if (!original) return unavailable(ref.status === "revoked" ? "revoked" : "missing");
    content = original.content;
    refs = readSourceRefs(original.source_refs)!.filter((stored) => !(stored.source.kind === "web" && stored.source.url === source.url && stored.version === ref.version && stored.contentHash === ref.contentHash && stored.status === "readable"));
  }
  if (!sourceRefsCurrent(db, dependencyScope, refs, path)) return unavailable("revoked");
  if (ref.status !== "readable") return unavailable(ref.status);
  if (hash(content) !== ref.contentHash) return unavailable("missing");
  return { reference: ref, content };
}

export function sourceRefsCurrent(db: SqliteDatabase, scope: Scope, refs: readonly SourceReference[] | undefined, visiting = new Set<string>()): boolean {
  return (refs ?? []).every((ref) => {
    if (ref.status === "revoked") return false;
    const status = resolveSourceReference(db, scope, ref, visiting).reference.status;
    return status !== "revoked" && (ref.status !== "readable" || status === "readable");
  });
}

export function isChatMessageCurrent(db: SqliteDatabase, id: string, conversationId: string, visiting = new Set<string>()): boolean {
  const row = chatRow(db, id);
  if (!row || row.conversation_id !== conversationId || (row.sender === "user" ? row.state : row.parent_state) !== "sent") return false;
  return sourceRefsCurrent(db, { conversationId }, readSourceRefs(row.source_refs), visiting);
}

/** Write boundary: shape, ownership and exact original bytes; only a new source_input can carry its own web provenance. */
export function validateSourceRefs(db: SqliteDatabase, scope: Scope, value: readonly SourceReference[] | undefined, originalText?: string): SourceReference[] | undefined {
  if (value === undefined) return undefined;
  const refs = SourceReferences.parse(value);
  for (const ref of refs) {
    if (ref.source.kind === "web" && ref.status === "readable" && originalText !== undefined && hash(originalText) === ref.contentHash) continue;
    const resolved = resolveSourceReference(db, scope, ref);
    if (ref.status === "readable" && resolved.reference.status === "revoked") throw new SourceUnavailableError();
    if (ref.status === "readable" && resolved.reference.status !== "readable") throw new Error("source reference is unavailable or does not match the original version/hash");
  }
  return refs;
}

/** Completion must also reject revoked dependencies carried as missing/revoked metadata. */
export function validateCurrentSourceRefs(db: SqliteDatabase, scope: Scope, value: readonly SourceReference[] | undefined): SourceReference[] | undefined {
  const refs = validateSourceRefs(db, scope, value);
  if (!sourceRefsCurrent(db, scope, refs)) throw new SourceUnavailableError();
  return refs;
}

export function chatSourceReference(db: SqliteDatabase, id: string, conversationId: string, retrievedAt: string): SourceReference {
  const row = chatRow(db, id);
  if (!row || !isChatMessageCurrent(db, id, conversationId)) throw new Error("chat source is no longer available");
  return { source: { kind: "chat_message", id }, version: id, contentHash: hash(chatText(row)), retrievedAt, status: "readable" };
}

export function resultSourceRefs(db: SqliteDatabase, runId: string): SourceReference[] | undefined {
  const rows = db.prepare("SELECT json_extract(payload, '$.result.block.source') AS source FROM run_events WHERE (run_id = ? OR chat_run_id = ?) AND type = 'result_display' AND json_extract(payload, '$.result.block.kind') = 'citation' ORDER BY seq").all(runId, runId) as { source: string }[];
  return mergeSourceRefs(rows.map((row) => SourceReferences.parse([JSON.parse(row.source)])));
}

/** Conservatively retain the input dependencies as provenance, never as proof that the model used them. */
export function runSourceRefs(db: SqliteDatabase, runId: string): SourceReference[] | undefined {
  const rows = db.prepare("SELECT s.source_refs FROM runs r JOIN prompt_snapshots s ON s.id = r.snapshot_id WHERE r.id = ? UNION ALL SELECT s.source_refs FROM chat_runs r JOIN chat_snapshots s ON s.id = r.snapshot_id WHERE r.id = ?").all(runId, runId) as { source_refs: string | null }[];
  if (rows.length > 1) throw new Error("ambiguous run identity");
  return mergeSourceRefs([...rows.map((row) => readSourceRefs(row.source_refs)), resultSourceRefs(db, runId)]);
}

/** A saved Prompt can outlive its source visibility. Recheck before approval/resume and before dispatch. */
export function assertPromptSourcesCurrent(db: SqliteDatabase, snapshotId: string, projectId: string): void {
  const row = db.prepare("SELECT source_refs FROM prompt_snapshots WHERE id = ? AND project_id = ?").get(snapshotId, projectId) as { source_refs: string | null } | undefined;
  if (row === undefined || !sourceRefsCurrent(db, { projectId }, readSourceRefs(row.source_refs))) {
    throw new SourceUnavailableError();
  }
}

/** Plans keep their existing schema; their summary and parent chain supply derived provenance. */
export function planSourceRefs(db: SqliteDatabase, planId: string): SourceReference[] | undefined {
  const rows = db.prepare("WITH RECURSIVE ancestors(id, parent_id) AS (SELECT id, parent_id FROM plan_versions WHERE id = ? UNION SELECT p.id, p.parent_id FROM plan_versions p JOIN ancestors a ON p.id = a.parent_id) SELECT m.source_refs FROM ancestors a JOIN round_summaries s ON s.plan_version_id = a.id JOIN messages m ON m.id = s.message_id").all(planId) as { source_refs: string | null }[];
  return mergeSourceRefs(rows.map((row) => readSourceRefs(row.source_refs)));
}
