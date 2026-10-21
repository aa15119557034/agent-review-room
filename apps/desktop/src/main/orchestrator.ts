import {
  appendRunEvent,
  finishRun,
  RunStateConflictError,
  type RunRow,
  type SqliteDatabase,
  transitionRun,
  type WriteQueue,
} from "@room/db";
import type { AgentAdapter } from "@room/core";
import type { AgentEvent, ControlEvent } from "@room/schemas";

/**
 * Run 执行器（D-07）。
 *
 * 负责把 adapter 的事件流落到数据库、推给 renderer，并保证：
 * - 非终止事件走 appendRunEvent（seq 由数据库分配）
 * - 终止事件走 finishRun（状态 + 事件同一事务）
 * - 消费方取消时 abort，adapter 会产出 cancelled 终止事件
 */

const TERMINAL_EVENTS = new Set(["completed", "error", "cancelled", "timed_out"]);

export interface RunInput {
  snapshotId: string;
  content: string;
  contentHash: string;
  /** snapshot 的 reviewerAgent：reviewer_output 的 sourceAgent 用它 */
  reviewerAgent: string;
}

export interface OrchestratorDeps {
  readonly db: SqliteDatabase;
  readonly queue: WriteQueue;
  /** 每次 run 新建一个 adapter，方便用设置里的最新配置 */
  readonly adapterFactory: () => Promise<AgentAdapter>;
  readonly emit: (event: ControlEvent) => void;
  readonly getRun: (runId: string) => RunRow | undefined;
  readonly idleTimeoutMs?: number;
  readonly totalTimeoutMs?: number;
}

export class RunOrchestrator {
  readonly #deps: OrchestratorDeps;
  readonly #active = new Map<string, AbortController>();

  constructor(deps: OrchestratorDeps) {
    this.#deps = deps;
  }

  isRunning(runId: string): boolean {
    return this.#active.has(runId);
  }

  /** 请求取消；真正的终止事件仍由 adapter 产出，保证恰好一个。 */
  cancel(runId: string): boolean {
    const controller = this.#active.get(runId);
    if (controller === undefined) return false;
    controller.abort();
    return true;
  }

  /** 退出前统一取消：让节点立刻停下，而不是等租约过期。 */
  cancelAll(): number {
    const count = this.#active.size;
    for (const controller of this.#active.values()) controller.abort();
    return count;
  }

  /** 执行一个已经落库的 run。调用方不要 await（IPC 要立刻返回）。 */
  async start(run: RunRow, input: RunInput): Promise<void> {
    const controller = new AbortController();
    this.#active.set(run.id, controller);

    let currentState = run.state;

    try {
      const starting = await transitionRun(this.#deps.db, this.#deps.queue, run.id, currentState, "STARTING", {
        startedAt: new Date().toISOString(),
      });
      currentState = starting.state;
      this.#deps.emit({ type: "run.updated", run: toContractRun(starting) });

      const adapter = await this.#deps.adapterFactory();
      const session = await adapter.startSession({ projectId: run.project_id });

      const running = await transitionRun(this.#deps.db, this.#deps.queue, run.id, "STARTING", "RUNNING", {
        substate: "active",
      });
      currentState = running.state;
      this.#deps.emit({ type: "run.updated", run: toContractRun(running) });

      const events = adapter.run(session.sessionId, run.id, input, {
        signal: controller.signal,
        onPermissionRequest: async () => ({ decision: "deny", decidedBy: "system" }),
        idleTimeoutMs: this.#deps.idleTimeoutMs ?? 120_000,
        totalTimeoutMs: this.#deps.totalTimeoutMs ?? 600_000,
      });

      let completedText: string | null = null;

      for await (const event of events) {
        if (TERMINAL_EVENTS.has(event.type)) {
          await this.#finish(run.id, currentState, event, completedText, input.reviewerAgent);
          return;
        }

        // 只有 completed 才用它写 reviewer_output；error 时这段文本会被丢弃
        if (event.type === "message_complete") completedText = event.text;

        const stored = await appendRunEvent(this.#deps.db, this.#deps.queue, run.id, {
          type: event.type,
          payload: event,
        });

        // 推给 renderer 的事件必须用数据库分配的 seq / eventId，否则回放对不上
        const forwarded = { ...event, seq: stored.seq, eventId: stored.eventId, ts: stored.ts } as AgentEvent;
        this.#deps.emit({ type: "run.event", event: forwarded });
      }

      // adapter 契约要求恰好一个终止事件；没有就是实现有问题
      await this.#finish(run.id, currentState, {
        type: "error",
        reason: "internal",
        message: "adapter ended without a terminal event",
        eventId: run.id + "-missing",
        runId: run.id,
        seq: -1,
        ts: new Date().toISOString(),
      } as AgentEvent, null, input.reviewerAgent);
    } catch (error) {
      const current = this.#deps.getRun(run.id);
      if (current !== undefined && (current.state === "STARTING" || current.state === "RUNNING")) {
        await this.#finish(run.id, current.state, {
          type: "error",
          reason: "internal",
          message: error instanceof Error ? error.message : String(error),
          eventId: run.id + "-internal",
          runId: run.id,
          seq: -1,
          ts: new Date().toISOString(),
        } as AgentEvent, null, input.reviewerAgent);
      }
    } finally {
      this.#active.delete(run.id);
    }
  }

  async #finish(
    runId: string,
    from: RunRow["state"],
    event: AgentEvent,
    completedText: string | null,
    reviewerAgent: string,
  ): Promise<void> {
    let terminal: Parameters<typeof finishRun>[3]["terminal"];
    if (event.type === "error") {
      terminal = { type: "error", reason: event.reason, ...(event.message === undefined ? {} : { message: event.message }) };
    } else if (event.type === "timed_out") {
      terminal = { type: "timed_out", kind: event.kind };
    } else if (event.type === "cancelled") {
      terminal = { type: "cancelled" };
    } else {
      terminal = { type: "completed" };
    }

    let finished: Awaited<ReturnType<typeof finishRun>>;
    try {
      finished = await finishRun(this.#deps.db, this.#deps.queue, runId, {
        from,
        terminal,
        // 只有 completed 才落 reviewer_output；截断/失败的结果不能当正式结论。
        // 这一步和终态在同一个事务里，见 packages/db 的 finishRun。
        ...(event.type === "completed" && completedText !== null
          ? { reviewerOutput: { content: completedText, sourceAgent: reviewerAgent } }
          : {}),
      });
    } catch (error) {
      // 迟到的结果：讨论室在暂停 / 结束本轮 / 打断时已经把 Run 标成 CANCELLED 了，
      // 这时适配器再吐一个 completed/cancelled 就是过期的，直接丢掉，别让进程挂着异常。
      if (error instanceof RunStateConflictError) {
        // 迟到结果：讨论室已经把 Run 标成 CANCELLED / 换了新的 Turn，这里只记一行，不覆盖状态
        console.warn("[orchestrator] dropped a late result for", runId, "from", from);
        return;
      }
      throw error;
    }

    // 契约要求的推送顺序：先 message.created，再 run.updated
    if (finished.message !== null) {
      this.#deps.emit({
        type: "message.created",
        message: {
          id: finished.message.id,
          projectId: finished.message.projectId,
          kind: "reviewer_output",
          sourceAgent: finished.message.sourceAgent,
          runId: finished.message.runId,
          content: finished.message.content,
          createdAt: finished.message.createdAt,
        },
      });
    }
    this.#deps.emit({ type: "run.updated", run: toContractRun(finished) });

    const events = this.#deps.db
      .prepare("SELECT seq, event_id AS eventId, type, payload, ts FROM run_events WHERE run_id = ? ORDER BY seq DESC LIMIT 1")
      .get(runId) as { seq: number; eventId: string; type: string; payload: string; ts: string } | undefined;
    if (events !== undefined) {
      this.#deps.emit({
        type: "run.event",
        event: { ...(JSON.parse(events.payload) as object), eventId: events.eventId, runId, seq: events.seq, ts: events.ts } as AgentEvent,
      });
    }
  }
}

function toContractRun(row: RunRow) {
  return {
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
  };
}
