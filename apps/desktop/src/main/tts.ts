import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { TtsEngine, VoiceId, VoiceOption } from "@room/schemas";

/**
 * 语音合成（D-37b，契约 C-42c / ADR-004 §4）。
 *
 * - 引擎是独立进程（`apps/desktop/tts/runner.py`），一次加载模型、串行处理请求；main 只经 stdin/stdout 说话
 * - 配置在 `userData/tts.json`（和 comfyui.json 同一个位置）：用哪个引擎、python 和脚本在哪、有哪些声音
 * - 合成结果直接落在 `outPath`，主控端读成 Buffer 再存进 MediaStore（main 拿到字节，renderer 只拿 aud_ ref）
 * - 没配置 / python 起不来 → `TtsUnavailableError`：播放按钮显示「还没配好声音」，不是任务失败
 */

export interface TtsVoiceConfig {
  id: VoiceId;
  displayName: string;
  /** preset = 引擎自带音色；reference = 用参考录音克隆 */
  source: "preset" | "reference";
  /** source = reference 时的参考录音路径（绝对路径） */
  refAudio?: string;
  /** source = preset 时给引擎的音色名（IndexTTS2 现在没有预置音色，留空即可） */
  preset?: string;
}

export interface TtsConfig {
  engine: TtsEngine;
  /** 进缓存键：换权重就换版本号 */
  engineVersion: string;
  python: string;
  script: string;
  modelDir: string;
  /** IndexTTS 的代码目录（安装包自带时指向 resources/tts/index-tts）；不填就按 runner.py 的默认 */
  root?: string;
  /** 安装包自带的 site-packages（设了就用 PYTHONPATH 指过去，不用 venv 的绝对路径） */
  sitePackages?: string;
  /** 一次合成最多等多久 */
  timeoutMs?: number;
  /** 起进程 + 加载模型最多等多久（默认 120 秒） */
  loadTimeoutMs?: number;
  voices: TtsVoiceConfig[];
}

const DEFAULT_TIMEOUT_MS = 180_000;
/** 起进程 + 加载模型最多等多久（C酱 #152 必须改 2）：卡住就把整条显卡队列拖死，所以必须有上限 */
const DEFAULT_LOAD_TIMEOUT_MS = 120_000;
/** 让引擎卸载模型最多等多久（D-37b，林离 #163）：卸 9GB 是秒级的事，这么久没回就杀进程 */
const UNLOAD_TIMEOUT_MS = 30_000;
/** 取消 / 超时杀掉进程后，等它真的退出再删临时文件，最多等多久 */
const KILL_WAIT_MS = 5_000;

/** 配置缺失 / python 或脚本不存在 / 进程起不来 */
export class TtsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TtsUnavailableError";
  }
}

/** 合成失败（引擎报错、超时、输出对不上） */
export class TtsFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TtsFailedError";
  }
}

export interface TtsSynthesis {
  bytes: Buffer;
  mime: "audio/wav";
  durationMs: number;
  sampleRate: number;
  /** 引擎侧耗时（不含模型加载） */
  ms: number;
}

interface RunnerReply {
  type: "ready" | "done" | "failed" | "unloaded";
  id?: string | null;
  error?: string;
  ms?: number;
  durationMs?: number;
  sampleRate?: number;
  engineVersion?: string;
}

/** 读配置：字段不全 / 声音列表不对就当没配置（和 loadComfyUiConfigFile 一个风格） */
export function loadTtsConfigFile(path: string): TtsConfig | null {
  try {
    if (!existsSync(path)) return null;
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<TtsConfig>;
    if (typeof raw.python !== "string" || typeof raw.script !== "string") return null;
    if (typeof raw.modelDir !== "string" || typeof raw.engineVersion !== "string") return null;
    if (raw.engine !== "cosyvoice" && raw.engine !== "indextts2" && raw.engine !== "gpt-sovits") return null;
    if (!Array.isArray(raw.voices) || raw.voices.length === 0) return null;
    const voices: TtsVoiceConfig[] = [];
    for (const voice of raw.voices) {
      if (typeof voice?.id !== "string" || typeof voice.displayName !== "string") return null;
      if (voice.source !== "preset" && voice.source !== "reference") return null;
      const entry: TtsVoiceConfig = {
        id: voice.id as VoiceId,
        displayName: voice.displayName,
        source: voice.source,
        ...(typeof voice.refAudio === "string" ? { refAudio: voice.refAudio } : {}),
        ...(typeof voice.preset === "string" ? { preset: voice.preset } : {}),
      };
      if (entry.source === "reference" && entry.refAudio === undefined) return null;
      voices.push(entry);
    }
    return {
      engine: raw.engine,
      engineVersion: raw.engineVersion,
      python: raw.python,
      script: raw.script,
      modelDir: raw.modelDir,
      ...(typeof raw.timeoutMs === "number" ? { timeoutMs: raw.timeoutMs } : {}),
      ...(typeof raw.loadTimeoutMs === "number" ? { loadTimeoutMs: raw.loadTimeoutMs } : {}),
      voices,
    };
  } catch {
    return null;
  }
}

/** 契约 voices.list 的样子（试听音频这一版还没有，先给 null） */
export function voiceOptionsOf(config: TtsConfig): VoiceOption[] {
  return config.voices.map((voice) => ({
    id: voice.id,
    displayName: voice.displayName,
    engine: config.engine,
    source: voice.source,
    sampleRef: null,
  }));
}

/** 等退出用的最小接口（测试可以传假对象） */
export interface ChildExitLike {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  once(event: "close", listener: () => void): unknown;
  removeListener(event: "close", listener: () => void): unknown;
}

/**
 * 等子进程真的退出（最多 ms 毫秒）。
 * 返回 true = 确认已经退出；false = 等到上限还没退。
 * 「等够了」不等于「退出了」：取消 / 超时清理和画图前的显存交接都靠这个返回值，
 * 不能把等待上限当成退出确认（林离 #165 复审必须改 2）。
 */
export function waitChildExit(child: ChildExitLike, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (exited: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("close", onClose);
      resolve(exited);
    };
    const onClose = () => done(true);
    const timer = setTimeout(() => done(false), ms);
    child.once("close", onClose);
  });
}

/**
 * 独立进程的客户端。一个实例一个进程；`synthesize` 串行（一次只跑一个，显卡一次只跑一个）。
 */
export class TtsRunner {
  #child: ChildProcessWithoutNullStreams | null = null;
  /** 这次启动的 promise（只在还没 ready 时有意义） */
  #loading: Promise<void> | null = null;
  #ready = false;
  /** stdout 按行切好、等着回应的请求 */
  #pending: { id: string; resolve: (reply: RunnerReply) => void; reject: (error: Error) => void } | null = null;
  #buffer = "";
  #seq = 0;

  constructor(private readonly config: TtsConfig) {}

  get engine(): TtsEngine {
    return this.config.engine;
  }

  get engineVersion(): string {
    return this.config.engineVersion;
  }

  voice(voiceId: string): TtsVoiceConfig | null {
    return this.config.voices.find((voice) => voice.id === voiceId) ?? null;
  }

  /** python / 脚本在不在；起不来的时候上层显示「还没配好」 */
  available(): boolean {
    return existsSync(this.config.python) && existsSync(this.config.script);
  }

  /**
   * 杀掉当前进程并立刻清掉引用（C酱 #152 建议 3）。
   * 立刻清很重要：旧进程的 exit 可能晚于下一次 #start，如果那时才清会把新进程的引用一起清掉。
   */
  #kill(reason?: Error): void {
    const child = this.#child;
    this.#child = null;
    this.#loading = null;
    this.#ready = false;
    this.#buffer = "";
    const pending = this.#pending;
    this.#pending = null;
    if (child !== null) {
      child.removeAllListeners("exit");
      child.kill();
    }
    if (reason !== undefined) pending?.reject(reason);
    else pending?.reject(new TtsFailedError("语音合成被取消"));
  }

  /**
   * 上一次没收尾的临时 wav（旧进程没按时退出时留下的）：起新进程前清掉，别越积越多。
   * 只在没有进程的时候调，所以不会删到正在写的那份。
   */
  #cleanStaleTempFiles(): void {
    try {
      for (const name of readdirSync(tmpdir())) {
        if (name.startsWith(`room-tts-${process.pid}-`)) rmSync(join(tmpdir(), name), { force: true });
      }
    } catch {
      // 清不掉不影响合成
    }
  }

  /**
   * 起进程并等 `ready`。C酱 #152 必须改 2：加载阶段也要有超时、也要听取消，
   * 否则卡在加载时整条显卡队列（画图 + 语音共用）都不动。
   */
  async #start(signal: AbortSignal): Promise<void> {
    if (!this.available()) throw new TtsUnavailableError("语音合成的 python 或脚本找不到，检查 userData/tts.json");
    if (this.#child !== null && this.#ready) return;
    if (this.#child !== null && this.#loading !== null) return this.#loading;

    this.#cleanStaleTempFiles();
    const loadTimeoutMs = this.config.loadTimeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS;
    const child = spawn(this.config.python, [this.config.script], {
      cwd: this.config.modelDir,
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
        PYTHONUTF8: "1",
        INDEXTTS_MODEL_DIR: this.config.modelDir,
        ...(this.config.root === undefined ? {} : { INDEXTTS_ROOT: this.config.root }),
        ...(this.config.sitePackages === undefined
          ? {}
          : {
              PYTHONPATH: [this.config.sitePackages, process.env.PYTHONPATH].filter(Boolean).join(delimiter),
              ROOM_SITE_PACKAGES: this.config.sitePackages,
            }),
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.#child = child;
    this.#ready = false;

    this.#loading = new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        // 这次启动失败：把进程和引用一起清掉，下一次重新起
        this.#loading = null;
        this.#kill();
        reject(error);
      };
      const timer = setTimeout(() => {
        fail(new TtsUnavailableError("语音合成进程加载超时（" + Math.round(loadTimeoutMs / 1000) + " 秒）"));
      }, loadTimeoutMs);
      const onAbort = () => fail(new TtsFailedError("语音合成启动时被取消"));
      signal.addEventListener("abort", onAbort, { once: true });

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (this.#child !== child) return;
        this.#buffer += chunk;
        let index = this.#buffer.indexOf("\n");
        while (index >= 0) {
          const line = this.#buffer.slice(0, index).trim();
          this.#buffer = this.#buffer.slice(index + 1);
          if (line !== "") {
            this.#onLine(
              line,
              () => {
                if (settled) return;
                settled = true;
                cleanup();
                this.#ready = true;
                this.#loading = null;
                resolve();
              },
              fail,
            );
          }
          index = this.#buffer.indexOf("\n");
        }
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        // 引擎的日志进 main 的控制台，不进 renderer、不进 git
        for (const line of chunk.split(/\r?\n/)) if (line.trim() !== "") console.warn("[tts]", line.trim());
      });
      child.on("error", (error) => fail(new TtsUnavailableError("语音合成进程起不来：" + error.message)));
      child.on("exit", (code) => {
        // 不是「当前这个进程」的 exit（上一轮已经被 kill 掉的），忽略
        if (this.#child !== child) return;
        const wasReady = this.#ready;
        const pending = this.#pending;
        this.#pending = null;
        this.#child = null;
        this.#loading = null;
        this.#ready = false;
        this.#buffer = "";
        const message = "语音合成进程退出了（code " + String(code) + "）";
        if (!settled) {
          settled = true;
          cleanup();
          reject(new TtsUnavailableError(message));
        }
        // 已经在合成中途：算这次合成失败（generation_failed），不是「起不来」
        if (pending !== null) pending.reject(new TtsFailedError(message));
        void wasReady;
      });
    });
    return this.#loading;
  }

  #onLine(line: string, onReady: () => void, onFail: (error: Error) => void): void {
    let reply: RunnerReply;
    try {
      reply = JSON.parse(line) as RunnerReply;
    } catch {
      console.warn("[tts] 看不懂的一行输出：", line.slice(0, 200));
      return;
    }
    if (reply.type === "ready") {
      onReady();
      return;
    }
    if (reply.type === "failed" && (reply.id === null || reply.id === undefined)) {
      onFail(new TtsFailedError(reply.error ?? "语音引擎加载失败"));
      return;
    }
    if (this.#pending === null || this.#pending.id !== reply.id) {
      console.warn("[tts] 收到不认识的回应：", line.slice(0, 200));
      return;
    }
    const pending = this.#pending;
    this.#pending = null;
    if (reply.type === "failed") pending.reject(new TtsFailedError(reply.error ?? "语音合成失败"));
    else pending.resolve(reply);
  }

  /**
   * 让引擎把模型卸掉、把显存还给驱动（D-37b，林离 #163 必须改 1）。
   * 语音和画图共用一张显卡，而语音的进程会一直等 stdin、模型一直占着显存；切到画图之前必须先卸掉并等它确认。
   * 没有进程 / 还没 ready = 没占显存，直接返回（画图前调用依赖显卡队列串行：这时不会有合成在进行中）；
   * 引擎不回应或报错就杀进程兜底，但**必须确认它真的退出了**才返回——没确认退出就抛错，
   * 由调用方让这次画图失败，不能把「等够了」当成「显存放掉了」（林离 #165 复审必须改 2）。
   */
  async unload(): Promise<void> {
    const child = this.#child;
    if (child === null || !this.#ready || this.#pending !== null) return;
    const id = "u" + String((this.#seq += 1));
    try {
      await new Promise<RunnerReply>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (this.#pending?.id === id) this.#pending = null;
          this.#kill();
          reject(new TtsFailedError("语音引擎卸载超时"));
        }, UNLOAD_TIMEOUT_MS);
        this.#pending = {
          id,
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        };
        child.stdin.write(JSON.stringify({ type: "unload", id }) + "\n");
      });
    } catch {
      // 卸载失败 / 超时 / 进程先退出：杀掉进程，等它退出（退出同样会释放显存），不让画图接着撞显存
      this.#kill();
      const exited = await waitChildExit(child, KILL_WAIT_MS);
      if (!exited) throw new TtsFailedError("语音引擎没能在限定时间内退出，显存可能还占着");
    }
  }

  /** 合成一段话。串行：上一段没结束，这一段排队等着（上层本来也只有一个队列） */
  async synthesize(input: {
    text: string;
    voice: TtsVoiceConfig;
    speed: number;
    signal: AbortSignal;
  }): Promise<TtsSynthesis> {
    await this.#start(input.signal);
    // 加载期间被取消：不再写 stdin，也别让 GPU 白跑一遍
    if (input.signal.aborted) {
      this.#kill(new TtsFailedError("语音合成被取消"));
      throw new TtsFailedError("语音合成被取消");
    }
    if (this.#pending !== null) throw new TtsFailedError("上一段语音还没合成完");
    const child = this.#child;
    if (child === null) throw new TtsUnavailableError("语音合成进程不在了");
    const id = "r" + String((this.#seq += 1));
    const outPath = join(tmpdir(), `room-tts-${process.pid}-${id}.wav`);
    const timeoutMs = this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    /** 取消 / 超时把进程杀了：它可能还在往 outPath 里写，要等它停下来再删（林离 #163 必须改 2） */
    let killed = false;

    // 清理覆盖「等回应」的全过程：引擎写了一半报 failed、或者超时 / 取消，都不留临时 wav
    try {
      const reply = await new Promise<RunnerReply>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (this.#pending?.id === id) this.#pending = null;
          killed = true;
          // 超时就把进程杀掉，下次重新起（别留着卡住的进程）
          this.#kill();
          reject(new TtsFailedError("语音合成超时"));
        }, timeoutMs);
        const onAbort = () => {
          clearTimeout(timer);
          if (this.#pending?.id === id) this.#pending = null;
          killed = true;
          this.#kill();
          reject(new TtsFailedError("语音合成被取消"));
        };
        input.signal.addEventListener("abort", onAbort, { once: true });
        this.#pending = {
          id,
          resolve: (value) => {
            clearTimeout(timer);
            input.signal.removeEventListener("abort", onAbort);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            input.signal.removeEventListener("abort", onAbort);
            reject(error);
          },
        };
        child.stdin.write(
          JSON.stringify({
            type: "synth",
            id,
            text: input.text,
            out: outPath,
            speed: input.speed,
            voice:
              input.voice.source === "reference"
                ? { source: "reference", refAudio: input.voice.refAudio }
                : { source: "preset", preset: input.voice.preset ?? null },
          }) + "\n",
        );
      });

      if (!existsSync(outPath)) throw new TtsFailedError("语音引擎说合成好了，但文件不在");
      const bytes = readFileSync(outPath);
      if (bytes.length === 0) throw new TtsFailedError("合成出来的音频是空的");
      return {
        bytes,
        mime: "audio/wav",
        durationMs: Math.max(1, Math.round(reply.durationMs ?? 0)),
        sampleRate: reply.sampleRate ?? 0,
        ms: reply.ms ?? 0,
      };
    } finally {
      // 只有确认进程停下来了才删文件：它还在写的时候删掉，会被旧进程又写回来（林离 #163）
      const exited = killed ? await waitChildExit(child, KILL_WAIT_MS) : true;
      if (exited) {
        try {
          rmSync(outPath, { force: true });
        } catch {
          // 临时文件删不掉不影响结果
        }
      } else {
        // 进程没停下来：先留着（也留个线索），下次起进程前统一清（林离 #165 复审必须改 2）
        console.warn("[tts] 语音进程没有在限定时间内退出，临时文件先留着：", outPath);
      }
    }
  }

  dispose(): void {
    this.#kill();
  }
}
