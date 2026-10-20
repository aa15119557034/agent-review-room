import { existsSync } from "node:fs";
import { delimiter as posixDelimiter, extname, isAbsolute, join, win32 } from "node:path";

/**
 * 解析要启动的命令，并在 Windows 上处理 .cmd / .bat。
 *
 * 背景：npm 全局安装的 CLI 在 Windows 上是 claude.cmd 包装脚本，
 * Node 的 spawn(shell:false) 不能直接执行 .cmd / .bat，必须交给 cmd.exe。
 * 原生安装器装的是 claude.exe，可以直接启动。
 *
 * 安全做法：cmd.exe 的转义规则非常容易出错，所以我们不尝试转义，
 * 而是**拒绝**任何含 cmd 元字符的参数（参数全部来自节点本地配置，不来自网络请求）。
 */

export interface SpawnPlan {
  file: string;
  args: string[];
  /** Windows 上通过 cmd.exe 启动时为 true（需要 windowsVerbatimArguments） */
  viaCmd: boolean;
  /** 解析出来的真实路径，用于日志 */
  resolved: string;
}

export interface ResolveEnv {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  exists: (path: string) => boolean;
}

const defaultEnv = (): ResolveEnv => ({ platform: process.platform, env: process.env, exists: existsSync });

/** cmd.exe 会解释的字符。出现在参数里就拒绝 */
const CMD_META = /[\^&|<>%!"()\r\n]/;

export class CommandResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandResolutionError";
  }
}

/** 在 PATH 里查找命令；Windows 上按 PATHEXT 依次尝试扩展名 */
export function findOnPath(command: string, r: ResolveEnv = defaultEnv()): string | null {
  const isWin = r.platform === "win32";
  const pathApi = isWin ? win32 : { isAbsolute, join, extname };
  const hasDir = isWin ? /[\\/]/.test(command) : command.includes("/");

  const candidatesFor = (base: string): string[] => {
    if (!isWin) return [base];
    if (pathApi.extname(base)) return [base];
    const exts = (r.env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
    return exts.map((e) => base + e.toLowerCase());
  };

  if (hasDir || pathApi.isAbsolute(command)) {
    return candidatesFor(command).find((c) => r.exists(c)) ?? null;
  }

  // Windows 的环境变量名不区分大小写：Path / PATH 都可能
  const pathVar = isWin
    ? Object.entries(r.env).find(([k]) => k.toUpperCase() === "PATH")?.[1]
    : r.env["PATH"];
  const dirs = (pathVar ?? "").split(isWin ? ";" : posixDelimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const c of candidatesFor(pathApi.join(dir, command))) {
      if (r.exists(c)) return c;
    }
  }
  return null;
}

/**
 * 生成 spawn 计划。
 * - POSIX：直接启动
 * - Windows .exe / .com：直接启动
 * - Windows .cmd / .bat：cmd.exe /d /s /c "<命令> <参数>"，参数不允许含元字符
 */
export function planSpawn(command: string, args: readonly string[], r: ResolveEnv = defaultEnv()): SpawnPlan {
  const resolved = findOnPath(command, r);
  if (!resolved) {
    throw new CommandResolutionError(
      `找不到命令 "${command}"。请确认已安装，并且在启动 AgentServer 的终端里能直接运行它（或在配置里写绝对路径）。`,
    );
  }

  if (r.platform !== "win32") return { file: resolved, args: [...args], viaCmd: false, resolved };

  const ext = win32.extname(resolved).toLowerCase();
  if (ext !== ".cmd" && ext !== ".bat") return { file: resolved, args: [...args], viaCmd: false, resolved };

  for (const a of [resolved, ...args]) {
    if (CMD_META.test(a)) {
      throw new CommandResolutionError(
        `"${resolved}" 是 ${ext} 脚本，必须经过 cmd.exe 启动；参数 ${JSON.stringify(a)} 含有 cmd 特殊字符（^ & | < > % ! " ( )），为安全起见拒绝启动。`,
      );
    }
  }
  const quote = (s: string) => (/\s/.test(s) ? `"${s}"` : s);
  const line = [quote(resolved), ...args.map(quote)].join(" ");
  const comspec = r.env["ComSpec"] ?? r.env["COMSPEC"] ?? "cmd.exe";
  // /d 不执行 AutoRun，/s 配合外层引号原样传递，/c 执行后退出
  return { file: comspec, args: ["/d", "/s", "/c", `"${line}"`], viaCmd: true, resolved };
}
