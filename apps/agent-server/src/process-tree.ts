import { execFile, type ChildProcess } from "node:child_process";

export interface KillDeps {
  platform: NodeJS.Platform;
  /** 可注入，测试用 */
  run: (file: string, args: string[], done: (err: Error | null) => void) => void;
  signalGroup: (pid: number, sig: NodeJS.Signals) => void;
  log: (msg: string) => void;
}

const defaultDeps = (): KillDeps => ({
  platform: process.platform,
  run: (file, args, done) => {
    execFile(file, args, { windowsHide: true }, (err) => done(err));
  },
  signalGroup: (pid, sig) => process.kill(-pid, sig),
  log: (msg) => console.warn(msg),
});

/**
 * 终止整个进程树，防止后台残留。
 *
 * - Windows：taskkill /pid <pid> /T /F。/T 连同子进程一起结束——经 cmd.exe 启动 claude.cmd 时，
 *   pid 是 cmd.exe，claude（node）是它的子进程，必须用 /T 才杀得干净。
 *   Windows 没有可靠的"礼貌退出"信号，所以直接 /F。
 * - POSIX：子进程以 detached 启动、自成进程组，先 SIGTERM 整组，graceMs 后 SIGKILL。
 */
export function killTree(child: ChildProcess, graceMs: number, deps: KillDeps = defaultDeps()): void {
  const pid = child.pid;
  if (pid === undefined) return;

  if (deps.platform === "win32") {
    deps.run("taskkill", ["/pid", String(pid), "/T", "/F"], (err) => {
      // 进程已经自己退出时 taskkill 会报 "not found"，这种情况可以忽略
      if (err && child.exitCode === null && child.signalCode === null) {
        deps.log(`[agent-server] taskkill failed for pid ${pid}: ${err.message}`);
      }
    });
    return;
  }

  const signal = (sig: NodeJS.Signals) => {
    try {
      deps.signalGroup(pid, sig);
    } catch {
      /* ESRCH：整组都已退出 */
    }
  };
  signal("SIGTERM");
  const timer = setTimeout(() => signal("SIGKILL"), graceMs);
  timer.unref();
  child.once("close", () => clearTimeout(timer));
}

/** POSIX 上用 detached 让子进程自成进程组；Windows 上 detached 会弹出新控制台，不用 */
export const spawnDetached = process.platform !== "win32";
