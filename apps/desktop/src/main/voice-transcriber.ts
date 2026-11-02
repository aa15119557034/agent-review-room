import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

/**
 * 本地转写 sidecar（D-34b 第二段，ADR-004 转写一节）。
 *
 * 主进程是 Node，跑不了 Python 模型；这里起一个独立的 `python transcribe.py --model <dir>`，
 * 用 stdin/stdout 上的「一行一条 JSON」通信：
 *   → {"id":1,"cmd":"probe","path":"..."}      ← {"id":1,"ok":true,"durationMs":8920}
 *   → {"id":2,"cmd":"transcribe","path":"..."} ← {"id":2,"ok":true,"text":"...","language":"zh"}
 * 读不到 / 出错时回 {"id":n,"ok":false,"error":"..."}。
 *
 * - 模型只在第一次 transcribe 时加载；probe 只解码容器，不加载模型
 * - 主进程崩溃 / 退出时不连累界面：sidecar 是独立进程，退出时 dispose() 杀掉
 * - 空闲一段时间（默认 5 分钟）自动退出，省内存；下次请求再起
 * - 进程死了会自动重启（下一次请求时）
 */

export interface AsrConfig {
  python: string;
  script: string;
  modelDir: string;
  /** 记进转写的 engine.model（默认取 modelDir 的目录名） */
  modelName: string;
  /** 单次 transcribe 的超时，默认 180 秒 */
  transcribeTimeoutMs?: number;
  /** 空闲多久退出 sidecar，默认 5 分钟 */
  idleMs?: number;
  /** 推理设备：auto（默认）/ cuda —— 只走 GPU，sidecar 已经删掉 CPU 版本 */
  device?: "auto" | "cuda";
  /** 精度：auto（= float16）/ float16 / int8_float16 / float32（都只在 GPU 上） */
  computeType?: string;
}

export interface AsrConfigFile {
  python?: unknown;
  script?: unknown;
  modelDir?: unknown;
  modelName?: unknown;
  transcribeTimeoutMs?: unknown;
  idleMs?: unknown;
  device?: unknown;
  computeType?: unknown;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim().length > 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);

/**
 * 读 `userData/asr.json`。缺字段 / 路径不存在时返回 null（调用方按「转写还没配好」处理），
 * 并给出原因，方便日志里看到到底缺什么。
 */
export function loadAsrConfigFile(path: string, defaultScript?: string): { config: AsrConfig | null; problem: string | null } {
  if (!existsSync(path)) return { config: null, problem: `没有 ${path}` };
  let raw: AsrConfigFile;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as AsrConfigFile;
  } catch (error) {
    return { config: null, problem: `asr.json 不是合法 JSON：${error instanceof Error ? error.message : String(error)}` };
  }
  const python = str(raw.python);
  const script = str(raw.script) ?? defaultScript ?? null;
  const modelDir = str(raw.modelDir);
  if (python === null || script === null || modelDir === null) {
    return { config: null, problem: "asr.json 需要 python、script（可省）、modelDir" };
  }
  for (const [label, p] of [
    ["python", python],
    ["script", script],
    ["modelDir", modelDir],
  ] as const) {
    if (!existsSync(p)) return { config: null, problem: `asr.json 里的 ${label} 不存在：${p}` };
  }
  return {
    config: {
      python,
      script,
      modelDir,
      modelName: str(raw.modelName) ?? modelDir.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "faster-whisper",
      transcribeTimeoutMs: num(raw.transcribeTimeoutMs) ?? undefined,
      idleMs: num(raw.idleMs) ?? undefined,
      // CPU 版本已删：旧配置里写了 "cpu" 的按 auto（= CUDA）处理，并提醒一句
      device: raw.device === "cpu" ? (console.warn("[voice] asr.json 里配的 device=cpu 已不支持（CPU 转写已删），改用 CUDA"), "auto") : raw.device === "cuda" ? "cuda" : "auto",
      computeType: str(raw.computeType) ?? undefined,
    },
    problem: null,
  };
}

export interface Transcriber {
  probe(path: string): Promise<number>;
  transcribe(path: string): Promise<{ text: string; language: string | null; durationMs: number }>;
  dispose(): void;
}

interface Pending {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  /** 这一条挂在哪个 sidecar 实例上：旧进程退出时不能把新进程的请求也拒掉 */
  child: ChildProcess;
}

export class SidecarTranscriber implements Transcriber {
  #child: ChildProcess | null = null;
  #pending = new Map<number, Pending>();
  #nextId = 1;
  #buffer = "";
  #stderr = "";
  #idleTimer: NodeJS.Timeout | null = null;
  #disposed = false;

  constructor(private readonly config: AsrConfig) {}

  /** 记进 transcription.engine.model */
  get modelName(): string {
    return this.config.modelName;
  }

  async probe(path: string): Promise<number> {
    const reply = await this.#request("probe", path, 15_000);
    const ms = reply["durationMs"];
    if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) throw new Error("sidecar 没有给出时长");
    return Math.round(ms);
  }

  async transcribe(path: string): Promise<{ text: string; language: string | null; durationMs: number }> {
    const reply = await this.#request("transcribe", path, this.config.transcribeTimeoutMs ?? 180_000);
    const text = reply["text"];
    if (typeof text !== "string" || text.trim().length === 0) throw new Error("没听到说话");
    const language = typeof reply["language"] === "string" && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(reply["language"]) ? reply["language"] : null;
    const durationMs = typeof reply["durationMs"] === "number" && reply["durationMs"] > 0 ? Math.round(reply["durationMs"]) : 0;
    return { text: text.trim(), language, durationMs };
  }

  dispose(): void {
    this.#disposed = true;
    this.#stop("转写进程已关闭");
  }

  async #request(cmd: "probe" | "transcribe", path: string, timeoutMs: number): Promise<Record<string, unknown>> {
    if (this.#disposed) throw new Error("转写进程已关闭");
    this.#clearIdle();
    const child = this.#ensureChild();
    const id = this.#nextId++;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        // #137 评审第 3 条：超时就把 sidecar 杀掉，别让它继续跑那一段（后面每一条都会排在它后面超时）；
        // 下一次请求会重新拉起进程（#ensureChild 里有重启逻辑）
        this.#killChild();
        reject(new Error(`转写超时（${Math.round(timeoutMs / 1000)} 秒）`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer, child });
      const line = JSON.stringify({ id, cmd, path }) + "\n";
      try {
        child.stdin?.write(line, "utf8");
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    }).finally(() => this.#armIdle());
  }

  #ensureChild(): ChildProcess {
    if (this.#child !== null) return this.#child;
    // 只给 sidecar 它需要的环境变量；Python 的 stdio 强制 UTF-8（Windows 默认可能是 cp936）
    const env: NodeJS.ProcessEnv = { PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" };
    for (const key of ["PATH", "SYSTEMROOT", "TEMP", "TMP", "USERPROFILE", "HOME", "LANG"]) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
    // 江浩：只要 GPU（sidecar 已经删掉 CPU 版本）；没 CUDA 时 sidecar 会直接报错
    const device = this.config.device ?? "auto";
    const args = [this.config.script, "--model", this.config.modelDir, "--device", device];
    if (this.config.computeType !== undefined) args.push("--compute-type", this.config.computeType);
    const child = spawn(this.config.python, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env,
      windowsHide: true,
      shell: false,
    });
    this.#child = child;
    this.#buffer = "";
    this.#stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.#onData(chunk));
    child.stderr?.on("data", (chunk: Buffer | string) => {
      this.#stderr = (this.#stderr + chunk.toString()).slice(-4000);
    });
    child.stdin?.on("error", () => {
      /* 进程先退出时写 stdin 会 EPIPE，由 exit 处理 */
    });
    child.once("error", (error) => {
      this.#failAll(`转写进程起不来：${error.message}`);
      this.#child = null;
    });
    child.once("exit", (code) => {
      if (this.#child === child) this.#child = null;
      const tail = this.#stderr.trim().split("\n").slice(-2).join(" ");
      // 只拒掉挂在这个进程上的请求：超时杀掉旧进程之后，新进程的请求不能被误伤
      this.#failAll(`转写进程退出了（${code ?? "?"}）${tail ? "：" + tail : ""}`, child);
    });
    return child;
  }

  #onData(chunk: string): void {
    this.#buffer += chunk;
    let nl: number;
    while ((nl = this.#buffer.indexOf("\n")) >= 0) {
      const line = this.#buffer.slice(0, nl).trim();
      this.#buffer = this.#buffer.slice(nl + 1);
      if (!line) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue; // 不是 JSON 的行跳过
      }
      const id = typeof msg["id"] === "number" ? msg["id"] : null;
      if (id === null) continue;
      const pending = this.#pending.get(id);
      if (pending === undefined) continue;
      this.#pending.delete(id);
      clearTimeout(pending.timer);
      if (msg["ok"] === true) pending.resolve(msg);
      else pending.reject(new Error(typeof msg["error"] === "string" ? msg["error"] : "转写失败"));
    }
  }

  /** 失败挂在某个 sidecar 上的请求（only 不给 = 全部）；旧进程退出不能误伤新进程的请求 */
  #failAll(message: string, only?: ChildProcess): void {
    for (const [id, pending] of this.#pending) {
      if (only !== undefined && pending.child !== only) continue;
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
      this.#pending.delete(id);
    }
  }

  #armIdle(): void {
    this.#clearIdle();
    const idleMs = this.config.idleMs ?? 5 * 60_000;
    this.#idleTimer = setTimeout(() => this.#stop("空闲退出"), idleMs);
    this.#idleTimer.unref?.();
  }

  #clearIdle(): void {
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = null;
  }

  #stop(reason: string): void {
    this.#clearIdle();
    this.#failAll(reason);
    this.#killChild();
  }

  /** 杀掉当前 sidecar（超时 / 退出时用）；下一次请求会重新拉起 */
  #killChild(): void {
    const child = this.#child;
    this.#child = null;
    try {
      child?.kill();
    } catch {
      // 已经退出
    }
  }
}


