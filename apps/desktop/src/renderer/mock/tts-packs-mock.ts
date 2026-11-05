import type { ControlEvent, TtsPackErrorCode, TtsPackKind, TtsPackStatus, TtsPacks } from "@room/schemas";

/**
 * 语音包导入的内存实现（C-47 界面开发用，契约 #212）。演示用，不是汐 main 里真实现的参考。
 * 初始：运行环境已装，模型没装。导入 = 假进度 extracting → checking → ready，每步推 tts.packs.updated。
 * failOnce 让下一次导入失败一次，演示原因码。
 */
export interface TtsPacksMockOptions {
  /** 导入前的状态；默认 runtime 已装、model 没装 */
  installed?: TtsPackKind[];
  /** 下一次导入以这个原因码失败（只失败一次） */
  failOnce?: TtsPackErrorCode;
}

const EXPECTED = "2026.11";
const TOTAL: Record<TtsPackKind, number> = { runtime: 4_200_000_000, model: 13_800_000_000 };

export function createTtsPacksMock(ctx: { emit(e: ControlEvent): void; tickMs: number }, options: TtsPacksMockOptions = {}) {
  const installed = new Set<TtsPackKind>(options.installed ?? ["runtime"]);
  let failOnce = options.failOnce ?? null;
  const progress = new Map<TtsPackKind, NonNullable<TtsPackStatus["progress"]>>();
  const timers: ReturnType<typeof setTimeout>[] = [];

  const status = (kind: TtsPackKind): TtsPackStatus => ({
    kind,
    state: installed.has(kind) ? "installed" : "missing",
    version: installed.has(kind) ? EXPECTED : null,
    expectedVersion: EXPECTED,
    path: installed.has(kind) ? `C:\\Users\\演示\\AppData\\Local\\评审室\\tts\\${kind}` : null,
    missing: [],
    totalBytes: installed.has(kind) ? TOTAL[kind] : null,
    progress: progress.get(kind) ?? null,
  });
  const packs = (): TtsPacks => [status("runtime"), status("model")];
  const push = () => ctx.emit({ type: "tts.packs.updated", packs: packs() });
  const busy = () => [...progress.values()].some((p) => p.phase === "extracting" || p.phase === "checking");

  return {
    queries: {
      async "tts.packs"() {
        return packs();
      },
    },
    commands: {
      async "tts.import"(req: { kind: TtsPackKind; mode: "zip" | "folder" }) {
        if (busy()) return { cancelled: false, error: "PACK_BUSY" as const, packs: packs() };
        const total = TOTAL[req.kind];
        const fail = failOnce;
        failOnce = null;
        const step = (phase: "extracting" | "checking" | "ready" | "failed", done: number, error: TtsPackErrorCode | null = null) => {
          progress.set(req.kind, { phase, doneBytes: done, totalBytes: total, error });
          push();
        };
        step("extracting", 0);
        const at = (n: number, f: () => void) => timers.push(setTimeout(f, ctx.tickMs * n));
        at(2, () => step("extracting", Math.floor(total * 0.4)));
        if (fail) {
          at(4, () => step("failed", Math.floor(total * 0.4), fail));
          return { cancelled: false, error: fail, packs: packs() };
        }
        at(4, () => step("extracting", total));
        at(6, () => step("checking", total));
        at(8, () => {
          installed.add(req.kind);
          progress.delete(req.kind);
          push();
        });
        return { cancelled: false, error: null, packs: packs() };
      },
    },
    reset() {
      for (const t of timers.splice(0)) clearTimeout(t);
      progress.clear();
      installed.clear();
      for (const k of options.installed ?? ["runtime"]) installed.add(k);
      failOnce = options.failOnce ?? null;
    },
  };
}
