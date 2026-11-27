import { StructuredAgentEvent, type ResultDisplayBlock } from "@room/schemas";
import type { SqliteDatabase } from "./database";
import { appendRunEventTx, type StoredEvent } from "./run-lifecycle";
import { validateSourceRefs } from "./sources";

/** Storage boundary for an already negotiated stream. Terminal transitions still use the existing finish functions. */
export function appendStructuredEventTx(db: SqliteDatabase, value: unknown): { stored: StoredEvent | null; reason: string | null } {
  const event = StructuredAgentEvent.parse(value);
  const projectRun = db.prepare("SELECT state, project_id FROM runs WHERE id = ?").get(event.runId) as { state: string; project_id: string } | undefined;
  const chatRun = db.prepare("SELECT r.state, r.conversation_id, r.slot_id, s.outcome, s.run_id AS current_run_id FROM chat_runs r LEFT JOIN chat_reply_slots s ON s.id = r.slot_id WHERE r.id = ?").get(event.runId) as
    { state: string; conversation_id: string; slot_id: string | null; outcome: string | null; current_run_id: string | null } | undefined;
  if (projectRun && chatRun) throw new Error("ambiguous run identity");
  const run = projectRun ?? chatRun;
  if (!run) return { stored: null, reason: "run_not_found" };
  if (run.state !== "RUNNING") return { stored: null, reason: "run_not_running" };
  if (chatRun?.slot_id && (chatRun.outcome !== "running" || chatRun.current_run_id !== event.runId)) return { stored: null, reason: "stale_attempt" };
  const column = chatRun ? "chat_run_id" : "run_id";
  const duplicate = db.prepare("SELECT event_id AS eventId, seq, ts, payload FROM run_events WHERE " + column + " = ? AND event_id = ?").get(event.runId, event.eventId) as (StoredEvent & { payload: string }) | undefined;
  if (duplicate) {
    const previous = JSON.parse(duplicate.payload) as Record<string, unknown>;
    if (JSON.stringify({ ...event, seq: previous["seq"] }) !== JSON.stringify(previous)) throw new Error("replayed event changed payload");
    return { stored: { eventId: duplicate.eventId, seq: duplicate.seq, ts: duplicate.ts }, reason: null };
  }
  if (event.type === "result_display") {
    if (event.result.block.kind === "citation") {
      const citation = event.result.block;
      validateSourceRefs(db, projectRun ? { projectId: projectRun.project_id } : { conversationId: chatRun!.conversation_id }, [citation.source]);
      const previous = readResultDisplay(db, event.runId).find((block) => block.kind === "citation" && block.citationId === citation.citationId);
      if (previous && JSON.stringify(previous) !== JSON.stringify(citation)) throw new Error("citation identity changed within a run");
    }
  }
  return { stored: appendRunEventTx(db, event.runId, { type: event.type, payload: event, eventId: event.eventId, ts: event.ts }, { chat: chatRun !== undefined }), reason: null };
}

/** Latest cumulative usage / step state is projected from the existing log, never summed or stored a second time. */
export function readResultDisplay(db: SqliteDatabase, runId: string): ResultDisplayBlock[] {
  const rows = db.prepare("SELECT payload FROM run_events WHERE (run_id = ? OR chat_run_id = ?) AND type = 'result_display' ORDER BY seq").all(runId, runId) as { payload: string }[];
  const blocks = new Map<string, ResultDisplayBlock>();
  for (const row of rows) {
    const event = StructuredAgentEvent.parse(JSON.parse(row.payload));
    if (event.type !== "result_display") throw new Error("stored event type mismatch");
    const block = event.result.block;
    const key = block.kind === "citation" ? "citation:" + block.citationId : block.kind === "tool_step" ? "tool:" + block.stepId : block.kind === "usage" ? "usage" : "unsupported:" + block.originalKind;
    if (block.kind === "citation" && blocks.has(key) && JSON.stringify(blocks.get(key)) !== JSON.stringify(block)) throw new Error("citation identity changed within a run");
    blocks.set(key, block);
  }
  return [...blocks.values()];
}
