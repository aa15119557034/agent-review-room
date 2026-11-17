import { sha256Hex } from "@room/core";
import { appendResearchResultTx, assertResearchRun, ProjectResearchError, type SqliteDatabase, type WriteQueue } from "@room/db";
import { ProjectResearchRemoteEvent, ProjectResearchStartRunRequest } from "@room/schemas";

/** One run, one captured database context. Rejected events stay rejected across reconnects. */
export function researchResultSink(deps: {
  db: SqliteDatabase; queue: WriteQueue; request: ProjectResearchStartRunRequest; signal: AbortSignal;
  assertContext: () => void;
  changed: (originalMessageId: string | null) => void;
  diagnostic: (reason: string) => void;
}): (value: ProjectResearchRemoteEvent) => Promise<void> {
  const request = ProjectResearchStartRunRequest.parse(deps.request);
  let started = false, terminal = false, lastSeq = -1;
  const seen = new Map<number, { hash: string; work: Promise<void> }>();
  const guard = () => {
    deps.assertContext();
    if (deps.signal.aborted || !deps.db.open) throw new ProjectResearchError("research context was cancelled or closed");
  };
  return async (value) => {
    guard();
    const event = ProjectResearchRemoteEvent.parse(value);
    if (event.type === "heartbeat") return;
    const hash = sha256Hex(JSON.stringify(event));
    const duplicate = seen.get(event.seq);
    if (duplicate) {
      if (duplicate.hash !== hash) throw new ProjectResearchError("replayed research event changed payload");
      return duplicate.work;
    }
    const reject = (reason: string) => {
      deps.diagnostic(reason);
      seen.set(event.seq, { hash, work: Promise.resolve() });
    };
    if (event.seq <= lastSeq) { reject("out_of_order"); return; }
    lastSeq = event.seq;
    if (terminal) { reject("after_terminal"); return; }
    if (event.type === "started") {
      if (started) throw new ProjectResearchError("research restarted within the same run");
      started = true;
    } else if (!started) { reject("before_started"); return; }
    if (event.type === "terminal") terminal = true;
    const run = assertResearchRun(deps.db, request);
    if (event.type === "result_display" && event.result.block.kind === "citation" && event.result.block.source.status === "readable" && run.research_original_message_id === null) {
      reject("citation_before_original"); return;
    }
    const work = deps.queue.run(() => {
      // Do not check the mutable terminal flag here: work received before terminal is already FIFO.
      guard();
      deps.db.transaction(() => {
        assertResearchRun(deps.db, request);
        if (event.type === "terminal" && event.result.outcome === "completed" && !deps.db.prepare("SELECT 1 FROM run_events WHERE run_id = ? AND type = 'message_complete'").get(request.runId)) {
          throw new ProjectResearchError("research completed without a final original or explicit empty result");
        }
        if (event.type !== "message_complete" && event.type !== "result_display") return;
        const result = appendResearchResultTx(deps.db, request, event);
        // Emit after the transaction commits below, never expose uncommitted originals.
        return result;
      }).immediate();
    });
    const completed = work.then(() => {
      guard();
      if (event.type === "message_complete" || event.type === "result_display") {
        const current = assertResearchRun(deps.db, request);
        deps.changed(event.type === "message_complete" ? current.research_original_message_id : null);
      }
    });
    seen.set(event.seq, { hash, work: completed });
    return completed;
  };
}
