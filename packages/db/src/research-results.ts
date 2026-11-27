import { createHash } from "node:crypto";
import { ProjectResearchRemoteEvent, ProjectResearchStartRunRequest, type SourceReference } from "@room/schemas";
import type { SqliteDatabase } from "./database";
import { readResearchPlan, ProjectResearchError } from "./research-plan";
import { appendRunEventTx } from "./run-lifecycle";
import { appendStructuredEventTx, readResultDisplay } from "./structured-results";
import { readSourceRefs, validateSourceRefs } from "./sources";
import { ulid } from "./ulid";

export function sameResearchSource(a: SourceReference, b: SourceReference): boolean {
  return a.source.kind === "web" && b.source.kind === "web" && a.source.url === b.source.url && a.version === b.version && a.contentHash === b.contentHash;
}

/** Recheck persisted run/snapshot identity at the last write boundary. */
export function assertResearchRun(db: SqliteDatabase, request: ProjectResearchStartRunRequest) {
  const run = db.prepare("SELECT project_id, snapshot_id, adapter_id, state, research_original_message_id FROM runs WHERE id = ?").get(request.runId) as
    { project_id: string; snapshot_id: string; adapter_id: string; state: string; research_original_message_id: string | null } | undefined;
  const saved = readResearchPlan(db, request.snapshot.id);
  if (!run || !saved || run.state !== "RUNNING" || run.project_id !== saved.plan.projectId || run.snapshot_id !== saved.plan.snapshotId ||
      request.profileId !== saved.plan.target.profileId || run.adapter_id !== "remote:" + request.profileId ||
      request.snapshot.content !== saved.plan.query || createHash("sha256").update(saved.plan.query, "utf8").digest("hex") !== request.snapshot.contentHash) {
    throw new ProjectResearchError("research event does not belong to the active authorized run");
  }
  return run;
}

/** Atomic original + self-reference + run association, or a single existing-log display event. */
export function appendResearchResultTx(db: SqliteDatabase, requestValue: ProjectResearchStartRunRequest, value: unknown): { changed: boolean; originalMessageId: string | null } {
  const request = ProjectResearchStartRunRequest.parse(requestValue);
  const event = ProjectResearchRemoteEvent.parse(value);
  const run = assertResearchRun(db, request);
  if (event.type !== "message_complete" && event.type !== "result_display") throw new ProjectResearchError("event is not a research result");
  const eventId = request.runId + ":research:" + event.seq;
  const existing = db.prepare("SELECT payload FROM run_events WHERE run_id = ? AND event_id = ?").get(request.runId, eventId) as { payload: string } | undefined;
  if (existing) {
    const { runId: _run, eventId: _id, ...previous } = JSON.parse(existing.payload) as Record<string, unknown>;
    if (JSON.stringify(ProjectResearchRemoteEvent.parse({ ...previous, seq: event.seq })) !== JSON.stringify(event)) throw new ProjectResearchError("replayed research event changed payload");
    return { changed: false, originalMessageId: run.research_original_message_id };
  }
  if (event.type === "message_complete") {
    if (db.prepare("SELECT 1 FROM run_events WHERE run_id = ? AND type = 'message_complete'").get(request.runId)) throw new ProjectResearchError("research returned more than one original");
    let originalMessageId: string | null = null;
    if (event.source !== null) {
      const bodyHash = createHash("sha256").update(event.text, "utf8").digest("hex");
      if (event.source.contentHash !== bodyHash || event.source.version !== bodyHash) throw new ProjectResearchError("research original hash does not match its exact bytes");
      const refs = validateSourceRefs(db, { projectId: run.project_id }, [event.source], event.text);
      originalMessageId = "msg_" + ulid();
      db.prepare("INSERT INTO messages (id, project_id, kind, source_agent, content, created_at, source_refs) VALUES (?, ?, 'source_input', ?, ?, ?, ?)")
        .run(originalMessageId, run.project_id, request.profileId, event.text, event.ts, JSON.stringify(refs));
      db.prepare("UPDATE runs SET research_original_message_id = ? WHERE id = ? AND research_original_message_id IS NULL").run(originalMessageId, request.runId);
    }
    appendRunEventTx(db, request.runId, { type: event.type, eventId, ts: event.ts, payload: event });
    return { changed: true, originalMessageId };
  }
  const block = event.result.block;
  if (block.kind === "citation" && block.source.status === "readable") {
    const original = run.research_original_message_id === null ? undefined : db.prepare("SELECT source_refs FROM messages WHERE id = ? AND project_id = ? AND kind = 'source_input'")
      .get(run.research_original_message_id, run.project_id) as { source_refs: string } | undefined;
    if (!original || !readSourceRefs(original.source_refs)?.some((ref) => sameResearchSource(ref, block.source))) throw new ProjectResearchError("readable citation requires this run's committed original");
  }
  const result = appendStructuredEventTx(db, { ...event, eventId, runId: request.runId });
  if (result.reason) throw new ProjectResearchError(result.reason);
  if (readResultDisplay(db, request.runId).length > 200) throw new ProjectResearchError("too many research display blocks");
  return { changed: true, originalMessageId: run.research_original_message_id };
}
