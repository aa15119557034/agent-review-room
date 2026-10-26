import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { userInfo } from "node:os";
import { join, posix, win32 } from "node:path";
import type { ServerConfig } from "./config";

/**
 * S-20：节点「是谁、在哪、以什么账号跑」的启动检查（ADR-003 §2a）。
 * 这些检查不过就拒绝启动：权限由系统账号保证，配置错了（比如用江浩的账号跑起来）等于没有隔离。
 */

export interface IdentityProbe {
  /** 当前进程的用户名（Windows 上可能带 DOMAIN\ 前缀） */
  currentUser(): string;
  /** 这个路径所在的盘：文件系统名和类型；拿不到返回 null */
  volume(path: string): { format: string; type: string } | null;
  /** 真实路径；不存在返回 null */
  realpath(path: string): string | null;
  platform: NodeJS.Platform;
}

export const systemProbe: IdentityProbe = {
  currentUser: () => userInfo().username,
  volume: windowsVolume,
  realpath: (p) => {
    try {
      return realpathSync.native(p);
    } catch {
      return null;
    }
  },
  platform: process.platform,
};

/** 用 .NET 的 DriveInfo 查盘的格式和类型：不用管理员权限，输出不随系统语言变 */
function windowsVolume(path: string): { format: string; type: string } | null {
  if (process.platform !== "win32") return null;
  const quoted = path.replaceAll("'", "''");
  const script = `$d=[System.IO.DriveInfo]::new([System.IO.Path]::GetPathRoot('${quoted}')); "$($d.DriveFormat)|$($d.DriveType)"`;
  try {
    const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", timeout: 10_000 });
    const [format, type] = out.trim().split("|");
    return format && type ? { format, type } : null;
  } catch {
    return null;
  }
}

const bareUser = (u: string) => (u.includes("\\") ? u.slice(u.lastIndexOf("\\") + 1) : u).toLowerCase();

/** 记忆文件夹的绝对路径：`<homeDir>/memory/<agent>`。配置校验通过后才调用 */
export const memoryDirOf = (config: ServerConfig): string => join(config.homeDir!, "memory", config.agent!);

export function identityProblems(config: ServerConfig, probe: IdentityProbe = systemProbe): string[] {
  const problems: string[] = [];
  const { agent, homeDir, runAsUser } = config;
  const memoryProfiles = Object.entries(config.profiles).filter(([, p]) => p.memory);
  const path = probe.platform === "win32" ? win32 : posix;

  if (runAsUser !== undefined && bareUser(probe.currentUser()) !== bareUser(runAsUser)) {
    problems.push(`节点必须以账号 ${runAsUser} 运行，现在是 ${probe.currentUser()}。用计划任务启动，不要从自己的会话里直接运行`);
  }

  if (agent !== undefined) {
    for (const id of Object.keys(config.profiles)) {
      if (!id.startsWith(`${agent}-`)) problems.push(`profile "${id}" 不属于 ${agent}：这个节点只能跑 ${agent}- 开头的 profile`);
    }
  }

  if (memoryProfiles.length === 0) return problems;
  if (agent === undefined) problems.push("配了记忆的节点必须填 agent");
  if (homeDir === undefined) problems.push("配了记忆的节点必须填 homeDir");
  else if (!path.isAbsolute(homeDir)) problems.push("homeDir 必须是绝对路径");
  if (problems.length) return problems;

  for (const [id, p] of memoryProfiles) {
    if (!id.endsWith("-chat")) problems.push(`profile "${id}"：只有聊天 profile（-chat）能配记忆`);
    if (p.memory!.dir !== `memory/${agent}`) problems.push(`profile "${id}"：memory.dir 只能是 memory/${agent}，现在是 ${p.memory!.dir}`);
  }

  if (probe.platform === "win32") {
    const v = probe.volume(homeDir!);
    if (!v) problems.push(`查不到 homeDir 所在的盘（${homeDir}）`);
    else if (v.format !== "NTFS" || v.type !== "Fixed") {
      problems.push(`homeDir 必须在本机 NTFS 盘上（现在是 ${v.format} / ${v.type}）：FAT、exFAT、网络盘、可移动盘上权限不生效`);
    }
  }

  // 真实路径必须正好是 <homeDir>/memory/<agent>（防止 homeDir 里的 memory 或 <agent> 是指到别处的链接）
  const home = probe.realpath(homeDir!);
  const dir = probe.realpath(path.join(homeDir!, "memory", agent!));
  if (home && dir) {
    const norm = (s: string) => (probe.platform === "win32" ? s.toLowerCase() : s);
    if (norm(dir) !== norm(path.join(home, "memory", agent!))) problems.push(`记忆文件夹的真实路径不在 homeDir/memory/${agent} 下：${dir}`);
  }
  // 文件夹还没建不算配置错误：启动后这个来源是 unavailable
  return problems;
}
