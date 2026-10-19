import { execFile, type ChildProcess } from "node:child_process";

const isWindows = process.platform === "win32";

/**
 * 终止整个进程树。
 * - POSIX：子进程以 detached 启动，自成进程组，kill(-pid) 杀整个组。先 SIGTERM，graceMs 后 SIGKILL。
 * - Windows：taskkill /T /F 直接强杀整棵树（Windows 没有可靠的"礼貌退出"信号）。
 */
export function killTree(child: ChildProcess, graceMs: number): void {
  const pid = child.pid;
  if (pid === undefined) return;

  if (isWindows) {
    execFile("taskkill", ["/pid", String(pid), "/T", "/F"], () => {
      /* 进程可能已经退出，忽略错误 */
    });
    return;
  }

  const signalGroup = (sig: NodeJS.Signals) => {
    try {
      process.kill(-pid, sig);
    } catch {
      /* ESRCH：整组都已退出 */
    }
  };

  signalGroup("SIGTERM");
  const timer = setTimeout(() => signalGroup("SIGKILL"), graceMs);
  timer.unref();
  child.once("close", () => clearTimeout(timer));
}

export const spawnDetached = !isWindows;
