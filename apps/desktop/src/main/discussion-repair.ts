import { finishSummaryFromRun, finishTurnFromRun, TurnError, writeTransaction, type SqliteDatabase, type WriteQueue } from "@room/db";

/**
 * 启动修复（V0.4 §32 第 3 步的讨论室部分）：应用在回答 / 汇总途中被关掉或崩溃时，
 * `repairInterruptedRuns` 只把 Run 标成 FAILED(interrupted)，Turn 还停在 running、
 * 轮停在 RUNNING / SUMMARIZING —— 重开后界面永远「回答中」，只能作废。
 *
 * 这里在它**之前**跑：还活着的 Run 走正常收尾（Run 终态 + Turn 结局 + 轮推进在一个事务里）；
 * Run 已经是终态但 Turn 还挂着的（旧版本留下的半截数据）只补 Turn 和轮。
 * 结局统一记 failed：界面会显示「失败」并给「单独重试」/「重新汇总」。
 */
export async function repairInterruptedTurns(db: SqliteDatabase, queue: WriteQueue): Promise<number> {
  const stale = db
    .prepare(
      "SELECT t.id AS turnId, t.round_id AS roundId, t.is_summary AS isSummary, t.run_id AS runId, r.state AS runState " +
        "FROM turns t LEFT JOIN runs r ON r.id = t.run_id WHERE t.outcome = 'running'",
    )
    .all() as { turnId: string; roundId: string; isSummary: number; runId: string | null; runState: string | null }[];

  let repaired = 0;
  for (const turn of stale) {
    const runActive = turn.runId !== null && turn.runState !== null && ["QUEUED", "STARTING", "RUNNING"].includes(turn.runState);
    if (runActive) {
      try {
        if (turn.isSummary === 1) {
          await finishSummaryFromRun(db, queue, { runId: turn.runId!, result: { kind: "failed", failureReason: "interrupted" } });
        } else {
          await finishTurnFromRun(db, queue, { runId: turn.runId!, terminal: { kind: "failed", failureReason: "interrupted" } });
        }
        repaired += 1;
        continue;
      } catch (error) {
        // 轮的状态对不上（比如汇总 Turn 挂着但轮已不是 SUMMARIZING）：退到下面只补 Turn
        if (!(error instanceof TurnError)) throw error;
      }
    }

    const changed = await writeTransaction(db, queue, () => {
      const ts = new Date().toISOString();
      const updated = db.prepare("UPDATE turns SET outcome = 'failed', finished_at = ? WHERE id = ? AND outcome = 'running'").run(ts, turn.turnId);
      if (updated.changes !== 1) return false;
      if (turn.isSummary === 1) {
        db.prepare("UPDATE rounds SET state = 'AWAITING_SUMMARY' WHERE id = ? AND state = 'SUMMARIZING'").run(turn.roundId);
      } else {
        const live = db
          .prepare("SELECT count(*) AS n FROM turns WHERE round_id = ? AND outcome IN ('pending', 'running')")
          .get(turn.roundId) as { n: number };
        if (live.n === 0) {
          db.prepare("UPDATE rounds SET state = 'AWAITING_SUMMARY', finished_at = ? WHERE id = ? AND state = 'RUNNING'").run(ts, turn.roundId);
        }
      }
      return true;
    });
    if (changed) repaired += 1;
  }
  return repaired;
}
