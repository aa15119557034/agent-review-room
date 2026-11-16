import type { RemoteRunFenceAccess } from "@room/core";
import type { WorldBudgetStore } from "@room/db";
import { RemoteRunProof, WORLD_PROFILE_RECIPE_DEEPSEEK_HTTP_V1 } from "@room/schemas";

export class WorldRunNotStoppedError extends Error {
  constructor(cause?: unknown) {
    super("世界后台请求尚未确认停止，请检查原节点后重试", { cause });
    this.name = "WorldRunNotStoppedError";
  }
}

/** Shared by world, chat and discussion admission. Only a durable positive
 * proof for the original binding can remove a reservation from this barrier. */
export class WorldRunFenceBarrier {
  #work: Promise<void> | null = null;
  constructor(private readonly deps: {
    budget: WorldBudgetStore;
    resolve: (binding: NonNullable<ReturnType<WorldBudgetStore["pending"]>[number]["binding"]>) => RemoteRunFenceAccess | null;
    timeoutMs?: number;
  }) {}

  reconcile(): Promise<void> {
    this.#work ??= this.#reconcile().finally(() => { this.#work = null; });
    return this.#work;
  }

  /** Shutdown waits for an already running confirmation write before closing SQLite. */
  settle(): Promise<void> { return this.#work ?? Promise.resolve(); }

  async #reconcile(): Promise<void> {
    const signal = AbortSignal.timeout(this.deps.timeoutMs ?? 5000);
    try {
      for (const pending of this.deps.budget.pending()) {
        const binding = pending.binding;
        if (!binding || binding.worldProfile.recipeVersion !== WORLD_PROFILE_RECIPE_DEEPSEEK_HTTP_V1) throw new Error("unknown original execution scope");
        const access = this.deps.resolve(binding);
        if (!access || access.ledgerId !== binding.ledgerId) throw new Error("original node credentials or ledger are unavailable");
        const read = async () => {
          signal.throwIfAborted();
          const proof = RemoteRunProof.parse(await access.proof(pending.runId, signal));
          if (proof.runId !== pending.runId || proof.ledgerId !== binding.ledgerId) throw new Error("stop proof identity mismatch");
          return proof;
        };
        let proof = await read();
        if (proof.status === "missing" || proof.status === "unconfirmed") {
          await access.cancel(pending.runId, "确认旧世界请求结束", signal);
          for (;;) {
            proof = await read();
            if (proof.status === "fenced_never_started" || proof.status === "closed_process") break;
            await new Promise<void>(resolve => setTimeout(resolve, 50));
          }
        }
        this.deps.budget.confirmStopped(proof);
      }
      if (this.deps.budget.pending().length) throw new Error("world reservation remains unconfirmed");
    } catch (cause) {
      throw new WorldRunNotStoppedError(cause);
    }
  }
}
