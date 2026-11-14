import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { inspect } from "node:util";

/**
 * 主进程日志文件（C-51）。不依赖 electron，方便单测。
 *
 * - 位置：<数据目录>/logs/main.log；超过 maxBytes 轮转成 main.1.log、main.2.log
 * - 只是把现有的 console.info / warn / error 抄一份到文件，不新增任何内容
 * - 写文件失败（目录不可写等）一律吞掉：日志不能反过来把应用搞挂
 */

export type LogLevel = "info" | "warn" | "error";

export interface FileLogger {
  /** 日志目录 */
  readonly dir: string;
  /** 当前日志文件 */
  readonly file: string;
  write(level: LogLevel, args: readonly unknown[]): void;
}

export interface FileLoggerOptions {
  dir: string;
  /** 单个文件上限，默认约 1MB */
  maxBytes?: number;
  /** 保留几份旧文件（main.1.log …），默认 2 */
  keep?: number;
  now?: () => Date;
}

/**
 * 兜底打码：现有代码不该把 Token 打进 console，这里只是多一道保险，
 * 把常见形状的密钥（Bearer、GitHub Token、sk- 开头的 API Key）换成占位符。
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [已隐藏]")
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, "[已隐藏]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "[已隐藏]")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, "[已隐藏]");
}

function renderArg(arg: unknown): string {
  if (typeof arg === "string") return arg;
  if (arg instanceof Error) return arg.stack ?? `${arg.name}: ${arg.message}`;
  return inspect(arg, { depth: 3, breakLength: Infinity });
}

/** 一行日志：`2026-11-13T08:00:00.000Z [warn] 内容`（多行内容原样保留） */
export function formatLogLine(level: LogLevel, args: readonly unknown[], now: Date): string {
  return `${now.toISOString()} [${level}] ${redactSecrets(args.map(renderArg).join(" "))}\n`;
}

export function createFileLogger(options: FileLoggerOptions): FileLogger {
  const maxBytes = options.maxBytes ?? 1024 * 1024;
  const keep = Math.max(1, options.keep ?? 2);
  const now = options.now ?? (() => new Date());
  const file = join(options.dir, "main.log");
  /** 当前文件大小；-1 = 还没量过 */
  let size = -1;

  const rotated = (index: number): string => join(options.dir, `main.${index}.log`);

  function rotate(): void {
    rmSync(rotated(keep), { force: true });
    for (let index = keep - 1; index >= 1; index -= 1) {
      if (existsSync(rotated(index))) renameSync(rotated(index), rotated(index + 1));
    }
    renameSync(file, rotated(1));
    size = 0;
  }

  return {
    dir: options.dir,
    file,
    write(level, args) {
      try {
        const line = formatLogLine(level, args, now());
        const bytes = Buffer.byteLength(line, "utf8");
        if (size < 0) {
          mkdirSync(options.dir, { recursive: true });
          size = existsSync(file) ? statSync(file).size : 0;
        }
        if (size > 0 && size + bytes > maxBytes) rotate();
        appendFileSync(file, line, "utf8");
        size += bytes;
      } catch {
        // 写不了就算了；下次再量一遍大小重试
        size = -1;
      }
    },
  };
}

type ConsoleLike = Record<LogLevel, (...args: unknown[]) => void>;

/**
 * 把 console.info / warn / error 同时抄到日志文件；原来的输出照旧。
 * 返回一个还原函数（测试用）。console.log 不动——CLI 的机器可读输出走它。
 */
export function teeConsole(logger: FileLogger, target: ConsoleLike = console): () => void {
  const levels: LogLevel[] = ["info", "warn", "error"];
  const originals = new Map<LogLevel, (...args: unknown[]) => void>();
  for (const level of levels) {
    const original = target[level];
    originals.set(level, original);
    target[level] = (...args: unknown[]) => {
      logger.write(level, args);
      original.apply(target, args);
    };
  }
  return () => {
    for (const [level, original] of originals) target[level] = original;
  };
}
