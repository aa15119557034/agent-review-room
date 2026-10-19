import type { SqliteDatabase } from "./database";

/**
 * 单写者队列（D-02）。
 *
 * better-sqlite3 是同步 API，同一进程里多个写事务交错执行时会直接撞上
 * "cannot start a transaction within a transaction"。这里把所有写操作串成一条链：
 * 后一个任务等前一个 settle（成功或失败都算）再开始，失败不会卡死整条队列。
 *
 * 跨进程的互斥由 SQLite 自己保证（BEGIN IMMEDIATE + busy_timeout）。
 */
export class WriteQueue {
  #tail: Promise<unknown> = Promise.resolve();
  #pending = 0;

  /** 还在排队的写任务数量（含正在执行的那个） */
  get pending(): number {
    return this.#pending;
  }

  run<T>(task: () => T | Promise<T>): Promise<T> {
    this.#pending += 1;
    const result = this.#tail.then(async () => task());
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    ).finally(() => {
      this.#pending -= 1;
    });
    return result;
  }

  /** 等待队列里所有任务结束（测试和优雅退出用） */
  async drain(): Promise<void> {
    await this.#tail;
  }
}

/**
 * 在写队列里执行一个 BEGIN IMMEDIATE 事务。
 *
 * 用 IMMEDIATE 而不是 DEFERRED：一开始就拿写锁，避免「先读后写」在两个连接间
 * 升级锁失败（SQLITE_BUSY 且无法重试）。写事务里必须只做同步的 DB 操作——
 * 别把 await 放进 work()，否则写锁会跨越事件循环，其他写者全程阻塞。
 */
export function writeTransaction<T>(
  db: SqliteDatabase,
  queue: WriteQueue,
  work: () => T,
): Promise<T> {
  return queue.run(() => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const value = work();

      // 把「别放 await」从注释变成保证：work() 若返回 Promise，
      // COMMIT 会先于它完成，写进去的就是半成品。
      if (
        value !== null &&
        typeof value === "object" &&
        typeof (value as { then?: unknown }).then === "function"
      ) {
        void (value as unknown as Promise<unknown>).catch(() => {
          // 事务已经回滚，避免未处理的 rejection
        });
        throw new Error(
          "writeTransaction work() must be synchronous: returning a Promise would COMMIT before it settles",
        );
      }

      db.exec("COMMIT");
      return value;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // 事务可能已经被 SQLite 自动回滚（例如约束触发的中止）
      }
      throw error;
    }
  });
}
