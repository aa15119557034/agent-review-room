/** Drives the world from monotonic elapsed time; wall time never advances a world. */
export interface WorldClockDeps {
  advance: (elapsedMs: number) => Promise<void>;
  onDiscontinuity: () => Promise<void>;
  onError: (error: unknown) => void;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

export class WorldClock {
  readonly #now: () => number;
  readonly #setTimer: (callback: () => void, delayMs: number) => unknown;
  readonly #clearTimer: (timer: unknown) => void;
  #running = false;
  #timer: unknown = null;
  #inflight: Promise<void> | null = null;
  #last = 0;

  constructor(private readonly deps: WorldClockDeps) {
    this.#now = deps.now ?? (() => performance.now());
    this.#setTimer = deps.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.#clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#last = this.#now();
    if (this.#inflight === null) this.#schedule();
  }

  /** Stops future ticks immediately, then waits for the already accepted tick. */
  async stop(): Promise<void> {
    this.#running = false;
    if (this.#timer !== null) this.#clearTimer(this.#timer);
    this.#timer = null;
    await this.#inflight;
  }

  #schedule(): void {
    this.#timer = this.#setTimer(() => {
      this.#timer = null;
      if (!this.#running) return;
      const task = Promise.resolve().then(async () => {
        const now = this.#now();
        const elapsed = now - this.#last;
        this.#last = now;
        if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > 5_000) {
          await this.deps.onDiscontinuity();
        } else if (elapsed > 0) {
          await this.deps.advance(elapsed);
        }
      }).catch((error: unknown) => {
        this.#running = false;
        this.deps.onError(error);
      }).finally(() => {
        this.#inflight = null;
        if (this.#running) this.#schedule();
      });
      this.#inflight = task;
    }, 1_000);
  }
}
