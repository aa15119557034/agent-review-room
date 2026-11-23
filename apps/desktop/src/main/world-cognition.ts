import { createHash } from "node:crypto";
import { extractWorldReply, type RemoteAgentAdapter } from "@room/core";
import { ulid, type WorldBudgetStore } from "@room/db";
import { AgentEvent, isTerminalEvent, type WorldBudget, type WorldCognitionMode, type WorldCognitionReply, type WorldGeneration } from "@room/schemas";

export type WorldCognitionOutcome = "completed" | "discarded" | "offline" | "budget" | "scene_limit" | "busy_elsewhere";

export interface WorldCognitionRequest {
  worldId: string;
  generation: WorldGeneration;
  agent: string;
  sceneId: string | null;
  priority: "player" | "routine";
  limit: number;
  prompt: string;
  isCurrent: () => boolean;
  onReply: (reply: WorldCognitionReply, runId: string) => Promise<void>;
  onMode: (mode: WorldCognitionMode) => Promise<void>;
  onSettled: (outcome: WorldCognitionOutcome) => Promise<void>;
}

export interface WorldCognitionRunnerDeps {
  budget: WorldBudgetStore;
  /** Returns an uninitialized adapter for a separately isolated, tool-free profile. */
  resolve: (agent: string, signal: AbortSignal) => Promise<RemoteAgentAdapter | null>;
  foregroundBusy: () => boolean;
  emitBudget: (budget: WorldBudget) => void;
  now?: () => Date;
}

interface Slot {
  priority: WorldCognitionRequest["priority"];
  controller: AbortController;
  done: Promise<void>;
}

export class WorldRunNotStoppedError extends Error {
  constructor() { super("世界后台请求尚未确认停止，请稍后重试"); this.name = "WorldRunNotStoppedError"; }
}

/** One world request at a time, including initialization and session cleanup. */
export class WorldCognitionRunner {
  #slot: Slot | null = null;
  #unconfirmed: { adapter: RemoteAgentAdapter; runId: string } | null = null;
  readonly #pending = new Set<Promise<void>>();

  constructor(private readonly deps: WorldCognitionRunnerDeps) {}

  request(input: WorldCognitionRequest): Promise<void> {
    const task = this.#request(input);
    this.#pending.add(task);
    // Skipped requests still have asynchronous mode/settlement callbacks that
    // must finish before shutdown can close the world database.
    void task.then(() => this.#pending.delete(task), () => this.#pending.delete(task));
    return task;
  }

  async #request(input: WorldCognitionRequest): Promise<void> {
    if (!input.isCurrent()) return;
    if (this.deps.foregroundBusy()) {
      try { await this.#mode(input, { mode: "routine", reason: "busy_elsewhere" }); }
      finally { await this.#settled(input, "busy_elsewhere"); }
      return;
    }
    const previous = this.#slot;
    if (previous !== null && !(input.priority === "player" && previous.priority === "routine")) {
      await this.#settled(input, input.priority === "player" ? "discarded" : "busy_elsewhere");
      return;
    }
    const slot: Slot = { priority: input.priority, controller: new AbortController(), done: Promise.resolve() };
    // The waiting player owns admission immediately: a second player cannot
    // also wait for the old routine and then start another concurrent Run.
    this.#slot = slot;
    previous?.controller.abort();
    slot.done = (async () => {
      if (previous !== null) {
        // Previous callers still receive their own cleanup/callback failure.
        // A failed old request must not prevent this replacement from settling.
        await previous.done.catch(() => undefined);
      }
      await this.#execute(input, slot);
    })().finally(() => { if (this.#slot === slot) this.#slot = null; });
    return slot.done;
  }

  cancel(): void { this.#slot?.controller.abort(); }

  async drain(): Promise<void> {
    let failure: { error: unknown } | null = null;
    while (this.#pending.size > 0) {
      const results = await Promise.allSettled([...this.#pending]);
      for (const result of results) if (result.status === "rejected") failure ??= { error: result.reason };
    }
    await this.#confirmRemoteStopped();
    if (failure !== null) throw failure.error;
  }

  async yieldToForeground(): Promise<void> {
    this.cancel();
    await this.drain();
  }

  async #confirmRemoteStopped(): Promise<void> {
    const pending = this.#unconfirmed;
    if (pending === null) return;
    try {
      const runs = await pending.adapter.listRemoteRuns(AbortSignal.timeout(5000));
      // An absent Run may still be created by a delayed POST. Only this Run's
      // explicit terminal state confirms that dispatch can no longer be live.
      if (!runs.some((run) => run.runId === pending.runId && run.state === "finished")) throw new WorldRunNotStoppedError();
    } catch {
      // Keep the barrier after the original request settles. A later foreground
      // handoff or explicit world request must check it again before dispatch.
      throw new WorldRunNotStoppedError();
    }
    if (this.#unconfirmed === pending) this.#unconfirmed = null;
  }

  #allowed(input: WorldCognitionRequest, slot: Slot): boolean {
    return !slot.controller.signal.aborted && input.isCurrent() && !this.deps.foregroundBusy();
  }

  #interrupted(): WorldCognitionOutcome { return this.deps.foregroundBusy() ? "busy_elsewhere" : "discarded"; }

  async #mode(input: WorldCognitionRequest, mode: WorldCognitionMode): Promise<void> {
    if (input.isCurrent()) await input.onMode(mode);
  }

  async #settled(input: WorldCognitionRequest, outcome: WorldCognitionOutcome): Promise<void> {
    if (input.isCurrent()) await input.onSettled(outcome);
  }

  async #execute(input: WorldCognitionRequest, slot: Slot): Promise<void> {
    let adapter: RemoteAgentAdapter | null = null;
    let sessionId: string | null = null;
    let outcome: WorldCognitionOutcome = "discarded";
    try {
      if (!this.#allowed(input, slot)) { outcome = this.#interrupted(); return; }
      await this.#confirmRemoteStopped();
      if (!this.#allowed(input, slot)) { outcome = this.#interrupted(); return; }
      try {
        adapter = await this.deps.resolve(input.agent, slot.controller.signal);
        if (!this.#allowed(input, slot)) { outcome = this.#interrupted(); return; }
        if (adapter !== null) {
          await adapter.initialize();
          if (!this.#allowed(input, slot)) { outcome = this.#interrupted(); return; }
          const session = await adapter.startSession({ projectId: "world:" + input.worldId });
          sessionId = session.sessionId;
          if (!this.#allowed(input, slot)) { outcome = this.#interrupted(); return; }
        }
      } catch {
        if (!this.#allowed(input, slot)) { outcome = this.#interrupted(); return; }
        outcome = "offline";
        await this.#mode(input, { mode: "routine", reason: "offline" });
        return;
      }
      if (adapter === null || sessionId === null) {
        outcome = "offline";
        await this.#mode(input, { mode: "routine", reason: "offline" });
        return;
      }

      await this.#mode(input, { mode: "model" });
      if (!this.#allowed(input, slot)) { outcome = this.#interrupted(); return; }
      const runId = `run_${ulid()}`;
      // This durable reservation is never refunded, even if cancellation lands
      // immediately afterward or the remote node never returns a valid reply.
      const reserved = this.deps.budget.reserve({ runId, agent: input.agent, sceneId: input.sceneId, limit: input.limit, now: this.deps.now?.() ?? new Date() });
      this.deps.emitBudget(reserved.budget);
      if (!reserved.accepted) {
        outcome = reserved.reason === "scene" ? "scene_limit" : "budget";
        if (outcome === "budget") await this.#mode(input, { mode: "routine", reason: "budget" });
        return;
      }
      if (!this.#allowed(input, slot)) { outcome = this.#interrupted(); return; }

      let text: string | null = null;
      let terminal: "completed" | "error" | "cancelled" | "timed_out" | null = null;
      let lastSeq = -1;
      let malformed = false;
      this.#unconfirmed = { adapter, runId };
      try {
        for await (const raw of adapter.run(sessionId, runId, {
          snapshotId: `snap_${ulid()}`, content: input.prompt,
          contentHash: createHash("sha256").update(input.prompt, "utf8").digest("hex"),
        }, {
          signal: slot.controller.signal,
          onPermissionRequest: async () => ({ decision: "deny", decidedBy: "system" }),
          idleTimeoutMs: 30_000, totalTimeoutMs: 120_000,
        })) {
          // Abort invalid work, but keep consuming: returning here closes the
          // HTTP iterator before the node has confirmed cancellation.
          if (!this.#allowed(input, slot)) { slot.controller.abort(); outcome = this.#interrupted(); }
          if (malformed) continue;
          const checked = AgentEvent.safeParse(raw);
          if (!checked.success || checked.data.runId !== runId || checked.data.seq !== lastSeq + 1 || terminal !== null) {
            malformed = true;
            slot.controller.abort();
            continue;
          }
          const event = checked.data;
          lastSeq = event.seq;
          if (event.type === "message_complete") {
            if (text !== null) { malformed = true; slot.controller.abort(); continue; }
            text = event.text;
          }
          if (isTerminalEvent(event)) terminal = event.type;
        }
      } catch {
        // A throwing or contradictory stream never upgrades a preceding
        // message_complete/completed pair into an executable response.
        malformed = true;
        slot.controller.abort();
      }
      // HttpRemoteAgentAdapter can synthesize an unconfirmed cancelled event.
      // The node's structured run state, not terminal text, decides release.
      if (!malformed && terminal === "completed") {
        // Unlike cancellation/timeouts, completed is only forwarded from the
        // node after the process has closed; it needs no second health check.
        if (this.#unconfirmed?.runId === runId) this.#unconfirmed = null;
      } else await this.#confirmRemoteStopped();
      if (!this.#allowed(input, slot)) { outcome = this.#interrupted(); return; }
      if (malformed) return;
      if (terminal === "error" || terminal === "timed_out") {
        outcome = "offline";
        await this.#mode(input, { mode: "routine", reason: "offline" });
        return;
      }
      if (terminal !== "completed" || text === null) return;
      const parsed = extractWorldReply(text);
      if (!parsed.ok || !this.#allowed(input, slot)) return;
      await input.onReply(parsed.reply, runId);
      outcome = "completed";
    } finally {
      try {
        if (adapter !== null && sessionId !== null) await adapter.closeSession(sessionId);
      } finally {
        if (outcome === "busy_elsewhere") await this.#mode(input, { mode: "routine", reason: "busy_elsewhere" });
        await this.#settled(input, outcome);
      }
    }
  }
}
