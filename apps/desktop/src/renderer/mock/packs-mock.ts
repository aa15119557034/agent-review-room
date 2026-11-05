import type { ControlEvent, PackErrorCode, PackId, PackStatus, Packs } from "@room/schemas";

/**
 * 包导入的内存实现（C-47 界面开发用，契约 #214）。演示用，不是汐 main 里真实现的参考。
 * 登记表三项：语音运行环境（已装）、语音模型（没装）、补丁（没装，没有硬性版本）。
 * 导入 = 假进度 extracting → checking → 装好，每步推 packs.updated；id = null 时「认」出第一个没装的包。
 * failOnce 让下一次导入以这个原因码失败一次。
 */
export interface PacksMockOptions {
  /** 导入前已装的包；默认只有 tts-runtime */
  installed?: PackId[];
  failOnce?: PackErrorCode;
}

interface Entry {
  id: PackId;
  label: string;
  description: string;
  expectedVersion: string | null;
  totalBytes: number;
}
const REGISTRY: Entry[] = [
  { id: "tts-runtime", label: "语音运行环境", description: "语音合成用的 Python 和依赖", expectedVersion: "2026.11", totalBytes: 4_200_000_000 },
  { id: "tts-model", label: "语音模型", description: "语音合成的模型文件", expectedVersion: "2026.11", totalBytes: 13_800_000_000 },
  { id: "patch-2026-11", label: "补丁 2026-11", description: "程序补丁，覆盖安装", expectedVersion: null, totalBytes: 60_000_000 },
];

export function createPacksMock(ctx: { emit(e: ControlEvent): void; tickMs: number }, options: PacksMockOptions = {}) {
  const installed = new Set<PackId>(options.installed ?? ["tts-runtime"]);
  let failOnce = options.failOnce ?? null;
  const progress = new Map<PackId, NonNullable<PackStatus["progress"]>>();
  const timers: ReturnType<typeof setTimeout>[] = [];

  const status = (e: Entry): PackStatus => ({
    id: e.id,
    label: e.label,
    description: e.description,
    state: installed.has(e.id) ? "installed" : "missing",
    version: installed.has(e.id) ? (e.expectedVersion ?? "1") : null,
    expectedVersion: e.expectedVersion,
    path: installed.has(e.id) ? `C:\\Users\\演示\\AppData\\Local\\评审室\\packs\\${e.id}` : null,
    missing: [],
    totalBytes: installed.has(e.id) ? e.totalBytes : null,
    progress: progress.get(e.id) ?? null,
  });
  const packs = (): Packs => REGISTRY.map(status);
  const push = () => ctx.emit({ type: "packs.updated", packs: packs() });
  const busy = () => [...progress.values()].some((p) => p.phase === "extracting" || p.phase === "checking");

  return {
    queries: {
      async "packs.list"() {
        return packs();
      },
    },
    commands: {
      async "packs.import"(req: { id: PackId | null; mode: "zip" | "folder" }) {
        const result = (packId: PackId | null, error: PackErrorCode | null) => ({ cancelled: false, packId, error, packs: packs() });
        if (busy()) return result(req.id, "PACK_BUSY");
        // id = null：像 main 读 pack.json 那样「认」包；演示里认第一个没装的
        const entry = req.id ? REGISTRY.find((e) => e.id === req.id) : REGISTRY.find((e) => !installed.has(e.id));
        if (!entry) return result(null, "PACK_UNKNOWN");
        const total = entry.totalBytes;
        const fail = failOnce;
        failOnce = null;
        const step = (phase: "extracting" | "checking" | "ready" | "failed", done: number, error: PackErrorCode | null = null) => {
          progress.set(entry.id, { phase, doneBytes: done, totalBytes: total, error });
          push();
        };
        step("extracting", 0);
        const at = (n: number, f: () => void) => timers.push(setTimeout(f, ctx.tickMs * n));
        at(2, () => step("extracting", Math.floor(total * 0.4)));
        if (fail) {
          at(4, () => step("failed", Math.floor(total * 0.4), fail));
          return result(entry.id, fail);
        }
        at(4, () => step("extracting", total));
        at(6, () => step("checking", total));
        at(8, () => {
          installed.add(entry.id);
          progress.delete(entry.id);
          push();
        });
        return result(entry.id, null);
      },
    },
    reset() {
      for (const t of timers.splice(0)) clearTimeout(t);
      progress.clear();
      installed.clear();
      for (const k of options.installed ?? ["tts-runtime"]) installed.add(k);
      failOnce = options.failOnce ?? null;
    },
  };
}
