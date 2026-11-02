import {
  appendRunEvent,
  finishRun,
  finishSummaryFromRun,
  finishTurnFromRun,
  RunStateConflictError,
  TurnError,
  type RunRow,
  type SqliteDatabase,
  transitionRun,
  type WriteQueue,
} from "@room/db";
import { parseSummaryOutput, type AgentAdapter } from "@room/core";
import type { AgentEvent, ControlEvent, RoomNoteRejectReason } from "@room/schemas";
import type { NotesProvider } from "./notes";

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
  /**
   * 讨论室的 Run：结束时不是写 reviewer_output，而是落 Turn 的结局
   * （汇总者的 Turn 走 finishSummaryFromRun，其他人的走 finishTurnFromRun）。
   */
  discussion?: { turnId: string; isSummary: boolean };
}

/**
 * 讨论室的一次发言收尾后要推给界面的事实。由 main 侧映射成契约对象再 emit
 * （这里不 import repository，避免 Orchestrator 依赖读模型）。
 */
export interface DiscussionSettlement {
  turnId: string;
  roundId: string;
  /** 正式回答 / 汇总的消息；失败或超时为 null */
  messageId: string | null;
  /** 只有成功的汇总才有 */
  roundSummaryId: string | null;
  /** 汇总顺带产生的方案草稿 */
  planVersionId: string | null;
}

export interface OrchestratorDeps {
  readonly db: SqliteDatabase;
  readonly queue: WriteQueue;
  /** 每次 run 新建一个 adapter；讨论室的 Run 按 run.adapter_id 选 profile */
  readonly adapterFactory: (run: RunRow) => Promise<AgentAdapter>;
  /** 讨论室的 Run 收尾后回调（main 用它推 message.created / turn.updated …） */
  readonly onDiscussionSettled?: (settlement: DiscussionSettlement) => void;
  readonly emit: (event: ControlEvent) => void;
  /** C-46：项目笔记（讨论室的答案里切 room-note） */
  readonly notes?: NotesProvider;
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

  /** 还有几个 Run 在跑（优雅退出 / 测试用） */
  activeCount(): number {
    return this.#active.size;
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

      const adapter = await this.#deps.adapterFactory(run);
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
          await this.#finish(run.id, currentState, event, completedText, input.reviewerAgent, input.discussion);
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
      } as AgentEvent, null, input.reviewerAgent, input.discussion);
    } catch (error) {
      const current = this.#deps.getRun(run.id);
      // QUEUED 也要收尾：第一次 transitionRun(QUEUED → STARTING) 失败时（比如数据库忙 / 被触发器拒绝），
      // Run 还停在 QUEUED，讨论的 Turn 会一直是 running，这一轮永远到不了待汇总。
      if (
        current !== undefined &&
        (current.state === "QUEUED" || current.state === "STARTING" || current.state === "RUNNING")
      ) {
        await this.#finish(run.id, current.state, {
          type: "error",
          reason: "internal",
          message: error instanceof Error ? error.message : String(error),
          eventId: run.id + "-internal",
          runId: run.id,
          seq: -1,
          ts: new Date().toISOString(),
        } as AgentEvent, null, input.reviewerAgent, input.discussion);
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
    discussion?: RunInput["discussion"],
  ): Promise<void> {
    if (discussion !== undefined) {
      await this.#finishDiscussion(runId, event, completedText, discussion);
      return;
    }
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
  }

  /**
   * 讨论室的一次 Run 结束：写 Turn 的结局（汇总者的 Turn 走汇总路径）。
   * 迟到的结果（Turn 已经不是 running / Run 已经不是活动的）直接丢掉。
   */
  async #finishDiscussion(
    runId: string,
    event: AgentEvent,
    completedText: string | null,
    discussion: { turnId: string; isSummary: boolean },
  ): Promise<void> {
    // 失败原因原样透传（quota_exhausted 由 db 层映射成 absent_quota），不要压成 internal
    const failure = event.type === "error" ? ({ kind: "failed", failureReason: event.reason } as const) : undefined;
    // C-46：讨论室的回答先切 room-note，正文才是真正要落库的内容（写摘要的 Turn 不切）
    const noteExtract = !discussion.isSummary && event.type === "completed" && completedText !== null
      ? this.#extractNote(completedText)
      : null;
    const answerText = noteExtract === null ? completedText : noteExtract.text;
    // 完成了却没有正文（或正文只有一段 room-note）：算不完整输出，不能记成"答了但内容为空"
    const emptyAnswer = event.type === "completed" && (answerText === null || answerText === "");

    let settlement: DiscussionSettlement;
    try {
      if (discussion.isSummary) {
        let result: Parameters<typeof finishSummaryFromRun>[2]["result"];
        if (event.type === "completed" && !emptyAnswer) {
          // 汇总者按约定输出一个 JSON（X-20 的 parseSummaryOutput）。解析失败也保留全文，
          // 只是没有结构化 report / 方案草稿 —— 0-B 第 11 行允许。
          const parsed = parseSummaryOutput(completedText ?? "");
          result = {
            kind: "answered",
            text: completedText ?? "",
            ...(parsed === null ? {} : { report: parsed.report }),
            ...(parsed === null || parsed.planContent === null
              ? {}
              : { plan: { content: parsed.planContent, changeNote: this.#roundChangeNote(discussion.turnId) } }),
          };
        } else if (emptyAnswer) {
          result = { kind: "failed", failureReason: "incomplete_output" };
        } else if (event.type === "timed_out") {
          result = { kind: "timed_out", timeoutKind: event.kind };
        } else {
          result = failure ?? { kind: "failed", failureReason: "internal" };
        }
        const finished = await finishSummaryFromRun(this.#deps.db, this.#deps.queue, { runId, result });
        settlement = {
          turnId: finished.turnId,
          roundId: finished.roundId,
          messageId: finished.messageId,
          roundSummaryId: finished.roundSummaryId,
          planVersionId: finished.planVersionId,
        };
      } else {
        const terminal =
          event.type === "completed" && !emptyAnswer
            ? ({ kind: "answered", text: noteExtract === null ? (completedText ?? "") : noteExtract.text } as const)
            : emptyAnswer
              ? ({ kind: "failed", failureReason: "incomplete_output" } as const)
            : event.type === "timed_out"
              ? ({ kind: "timed_out", timeoutKind: event.kind } as const)
              : event.type === "cancelled"
                ? ({ kind: "interrupted" } as const)
                : failure ?? ({ kind: "failed", failureReason: "internal" } as const);
        const finished = await finishTurnFromRun(this.#deps.db, this.#deps.queue, { runId, terminal });
        // D-46a：回答落库成功之后才记笔记（迟到 / 被取代 / 空回答的结果都不记）
        if (noteExtract !== null && !emptyAnswer) this.#recordNote(discussion.turnId, noteExtract);
        settlement = {
          turnId: finished.turnId,
          roundId: finished.roundId,
          messageId: finished.messageId,
          roundSummaryId: null,
          planVersionId: null,
        };
      }
    } catch (error) {
      // 暂停 / 结束本轮 / 打断已经把这个 Turn 或 Run 结掉了，这就是迟到结果
      if (error instanceof TurnError) {
        console.warn("[orchestrator] dropped a late discussion result for", runId, "turn", discussion.turnId, error.code);
        return;
      }
      throw error;
    }

    // 讨论室自己的推送（message.created / turn.updated / round.updated / summary.created / plan.updated）
    this.#deps.onDiscussionSettled?.(settlement);

    const current = this.#deps.getRun(runId);
    if (current !== undefined) this.#deps.emit({ type: "run.updated", run: toContractRun(current) });

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

  /** 汇总产生的方案草稿的变化说明（1A 不做 diff，只写它来自哪一轮） */
  /** C-46：从讨论室的回答里切 room-note；没接笔记服务就原样返回 */
  #extractNote(text: string): { text: string; content: string | null; rejected: RoomNoteRejectReason | null } {
    const notes = this.#deps.notes;
    if (notes === undefined) return { text, content: null, rejected: null };
    return notes.extract(text);
  }

  /** C-46：回答已经落库，现在记一版笔记（失败只记日志，不影响回答） */
  #recordNote(turnId: string, extracted: { content: string | null; rejected: RoomNoteRejectReason | null }): void {
    const notes = this.#deps.notes;
    if (notes === undefined) return;
    const row = this.#deps.db
      .prepare("SELECT t.agent AS agent, r.project_id AS projectId FROM turns t JOIN rounds r ON r.id = t.round_id WHERE t.id = ?")
      .get(turnId) as { agent: string; projectId: string } | undefined;
    if (row === undefined) return;
    const scope = { kind: "topic" as const, projectId: row.projectId };
    if (extracted.content !== null) {
      void notes.recordReply({ scope, agent: row.agent, content: extracted.content, source: { kind: "turn", id: turnId } });
    } else if (extracted.rejected !== null) {
      notes.reject({ scope, agent: row.agent, reason: extracted.rejected, source: { kind: "turn", id: turnId } });
    }
  }

  #roundChangeNote(turnId: string): string {
    const row = this.#deps.db
      .prepare("SELECT r.round_index AS round_index FROM turns t JOIN rounds r ON r.id = t.round_id WHERE t.id = ?")
      .get(turnId) as { round_index: number } | undefined;
    return row === undefined ? "由汇总生成" : `由第 ${row.round_index} 轮汇总生成`;
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