import { canEmitStructuredResults, NodeHealth, StartRunRequest, StructuredRemoteEvent } from "@room/schemas";
import { appendStructuredEventTx, type SqliteDatabase, type WriteQueue } from "@room/db";

/** S07's future negotiated producer uses this sink; constructing it never enables a provider or changes old requests. */
export function structuredResultSink(
  db: SqliteDatabase,
  queue: WriteQueue,
  health: NodeHealth,
  request: StartRunRequest,
  signal: AbortSignal,
  diagnostic: (reason: string) => void,
): (value: unknown) => Promise<void> {
  const accepted = StartRunRequest.parse(request);
  if (!canEmitStructuredResults(NodeHealth.parse(health), accepted)) throw new Error("structured results were not negotiated for this run/profile");
  let started = false;
  let terminal = false;
  let lastSeq = -1;
  return async (value) => {
    const remote = StructuredRemoteEvent.parse(value);
    const replay = "seq" in remote && remote.seq <= lastSeq;
    if ("seq" in remote) lastSeq = Math.max(lastSeq, remote.seq);
    if (remote.type === "terminal") { terminal = true; return; }
    if (remote.type === "started") { if (!terminal) started = true; return; }
    if (remote.type !== "result_display") return;
    if (terminal || !started) { diagnostic(terminal ? "after_terminal" : "before_started"); return; }
    const event = { ...remote, runId: accepted.runId, eventId: accepted.runId + ":display:" + remote.seq };
    // Capture this database instance. A switch cannot redirect a queued callback to the new database.
    if (signal.aborted || !db.open) { diagnostic("cancelled_or_database_closed"); return; }
    await queue.run(() => {
      if (signal.aborted || !db.open) { diagnostic("cancelled_or_database_closed"); return; }
      // This event arrived before terminal and is already ahead of it in the write queue.
      db.transaction(() => {
        const snapshot = db.prepare("SELECT s.id, s.content_hash FROM runs r JOIN prompt_snapshots s ON s.id = r.snapshot_id WHERE r.id = ? UNION ALL SELECT s.id, s.content_hash FROM chat_runs r JOIN chat_snapshots s ON s.id = r.snapshot_id WHERE r.id = ?").all(accepted.runId, accepted.runId) as { id: string; content_hash: string }[];
        if (snapshot.length !== 1 || snapshot[0]!.id !== accepted.snapshot.id || snapshot[0]!.content_hash !== accepted.snapshot.contentHash) throw new Error("run snapshot does not match the negotiated request");
        if (replay && !db.prepare("SELECT 1 FROM run_events WHERE event_id = ?").get(event.eventId)) throw new Error("out-of-order structured result");
        const result = appendStructuredEventTx(db, event);
        if (result.reason !== null) diagnostic(result.reason);
      }).immediate();
    });
  };
}
