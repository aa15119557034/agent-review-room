import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { CODEX_QUOTA_READ_TIMEOUT_MS, RemoteProfileQuota, type RemoteQuotaWindow } from "@room/schemas";
import type { Profile } from "./config";
import { killTree, spawnDetached } from "./process-tree";
import { planSpawn } from "./win-command";

/**
 * S-24：读 Codex 订阅额度（契约 C-42b 的 GET /v1/profiles/:profileId/quota，ADR-004 §3）。
 *
 * 每次读都新起一个 `codex app-server`（stdio 上的 JSON-RPC，一行一条），依次发
 * initialize → initialized → account/rateLimits/read，拿到结果就结束进程。
 * - 整个过程（含启动）不超过 2 秒（CODEX_QUOTA_READ_TIMEOUT_MS）；超时、出错、没登录、
 *   字段缺失或对不上，相应各项报 null（「读不到」），不猜、不报 0
 * - 同一个 profile 同时只起一个进程：读到一半又来请求，就共用这一次的结果
 * - 环境变量只给 profile 的 envAllowlist（和跑 Run 一样），密钥不经过节点
 */

/** 5 小时窗口和每周窗口的长度（分钟）。Codex 用 primary / secondary 两个槽，按长度认，不按位置猜 */
export const FIVE_HOUR_MINUTES = 300;
export const WEEKLY_MINUTES = 7 * 24 * 60;
const MAX_STDOUT_BYTES = 1024 * 1024;

export function unknownQuota(readAt: Date): RemoteProfileQuota {
  return { fiveHour: null, weekly: null, creditsInUse: null, readAt: readAt.toISOString() };
}

// ---------------------------------------------------------------- 把 Codex 的结果翻成契约的形状

interface CodexWindow {
  usedPercent?: unknown;
  windowDurationMins?: unknown;
  resetsAt?: unknown;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function toWindow(w: CodexWindow): RemoteQuotaWindow | null {
  const used = w.usedPercent;
  if (typeof used !== "number" || !Number.isFinite(used) || used < 0) return null;
  const mins = w.windowDurationMins;
  const reset = w.resetsAt;
  let resetsAt: string | null = null;
  // Codex 的 resetsAt 是 Unix 秒
  if (typeof reset === "number" && Number.isFinite(reset) && reset > 0) {
    const d = new Date(reset * 1000);
    if (!Number.isNaN(d.getTime())) resetsAt = d.toISOString();
  }
  return {
    // 超过 100 也是「用完了」，契约上限 100
    usedPercent: Math.min(used, 100),
    windowMinutes: typeof mins === "number" && Number.isInteger(mins) && mins > 0 ? mins : null,
    resetsAt,
  };
}

/**
 * account/rateLimits/read 的 result → RemoteProfileQuota。
 * - 优先用 rateLimitsByLimitId.codex，没有再用兼容的 rateLimits
 * - 窗口按 windowDurationMins 认：300 = 5 小时，10080 = 每周；长度缺失或是别的值，那一项为 null
 * - creditsInUse：ordinaryUsageAllowed 为 true → false（还在用订阅里的额度）；
 *   为 false（订阅额度已用尽）且账户有 credits / 不限量 → true；为 false 且确定没有 credits → false
 *   （这时窗口会是 100%，照样不走 Codex）；其余读不准的情况 → null
 */
export function mapCodexRateLimits(result: unknown, readAt: Date): RemoteProfileQuota {
  const out = unknownQuota(readAt);
  if (!isObj(result)) return out;
  const byId = isObj(result.rateLimitsByLimitId) ? result.rateLimitsByLimitId : null;
  const snap = byId && isObj(byId.codex) ? byId.codex : isObj(result.rateLimits) ? result.rateLimits : null;

  if (snap) {
    for (const slot of [snap.primary, snap.secondary]) {
      if (!isObj(slot)) continue;
      const w = toWindow(slot);
      if (!w) continue;
      if (w.windowMinutes === FIVE_HOUR_MINUTES && out.fiveHour === null) out.fiveHour = w;
      else if (w.windowMinutes === WEEKLY_MINUTES && out.weekly === null) out.weekly = w;
    }
  }

  const allowed = result.ordinaryUsageAllowed;
  if (allowed === true) out.creditsInUse = false;
  else if (allowed === false) {
    const credits = snap && isObj(snap.credits) ? snap.credits : null;
    if (credits && (credits.hasCredits === true || credits.unlimited === true)) out.creditsInUse = true;
    else if (credits && credits.hasCredits === false && credits.unlimited === false) out.creditsInUse = false;
  }

  // 最后按契约再核一遍；对不上就整体当读不到
  const checked = RemoteProfileQuota.safeParse(out);
  return checked.success ? checked.data : unknownQuota(readAt);
}

// ---------------------------------------------------------------- 起 codex app-server 读一次

export interface QuotaReadOptions {
  timeoutMs?: number;
  now?: () => Date;
  /** 读不到时记一行原因（不含额度数字以外的内容） */
  log?: (msg: string) => void;
}

function errorText(e: unknown): string {
  return (isObj(e) && typeof e.message === "string" ? e.message : "error").slice(0, 200);
}

function buildEnv(profile: Profile): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of profile.envAllowlist) {
    const v = process.env[key];
    if (v !== undefined) env[key] = v;
  }
  return { ...env, ...profile.env };
}

export function readCodexQuota(profile: Profile, opts: QuotaReadOptions = {}): Promise<RemoteProfileQuota> {
  const timeoutMs = Math.min(opts.timeoutMs ?? CODEX_QUOTA_READ_TIMEOUT_MS, CODEX_QUOTA_READ_TIMEOUT_MS);
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? ((m: string) => console.warn(m));
  const quota = profile.quota;
  if (!quota) return Promise.resolve(unknownQuota(now()));

  return new Promise((resolve) => {
    let done = false;
    let child: ChildProcess | undefined;
    const finish = (q: RemoteProfileQuota, why?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (why) log(`[agent-server] quota read failed: ${why}`);
      if (child && child.exitCode === null && child.signalCode === null) killTree(child, 500);
      resolve(q);
    };
    const timer = setTimeout(() => finish(unknownQuota(now()), `timed out after ${timeoutMs} ms`), timeoutMs);

    try {
      const plan = planSpawn(profile.command, quota.args);
      child = spawn(plan.file, plan.args, {
        cwd: profile.cwd,
        env: buildEnv(profile),
        stdio: ["pipe", "pipe", "ignore"],
        detached: spawnDetached,
        windowsHide: true,
        windowsVerbatimArguments: plan.viaCmd,
        shell: false,
      });
    } catch (err) {
      finish(unknownQuota(now()), `spawn failed: ${String(err)}`);
      return;
    }

    const send = (msg: unknown) => {
      if (!child?.stdin?.writable) return;
      child.stdin.write(JSON.stringify(msg) + "\n");
    };
    child.on("error", (err) => finish(unknownQuota(now()), `spawn failed: ${err.message}`));
    child.on("close", (code) => finish(unknownQuota(now()), `app-server exited (${code}) before answering`));
    child.stdin?.on("error", () => {
      /* 进程先退出时写 stdin 会 EPIPE，由 close 处理 */
    });

    const decoder = new StringDecoder("utf8");
    let buf = "";
    let total = 0;
    child.stdout?.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_STDOUT_BYTES) return finish(unknownQuota(now()), "app-server output too large");
      buf += decoder.write(chunk);
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg: unknown;
        try {
          msg = JSON.parse(line);
        } catch {
          continue; // 不是 JSON 的行（日志）跳过
        }
        if (!isObj(msg)) continue;
        if (msg.id === 1) {
          if (msg.error !== undefined) return finish(unknownQuota(now()), `initialize: ${errorText(msg.error)}`);
          send({ method: "initialized" });
          send({ id: 2, method: "account/rateLimits/read", params: { excludeResetCreditDetails: true } });
        } else if (msg.id === 2) {
          if (msg.error !== undefined) return finish(unknownQuota(now()), `account/rateLimits/read: ${errorText(msg.error)}`);
          return finish(mapCodexRateLimits(msg.result, now()));
        }
      }
    });

    send({ id: 1, method: "initialize", params: { clientInfo: { name: "agent-room", title: null, version: "1" }, capabilities: null } });
  });
}

/** 同一个 profile 同时只起一个 app-server：读到一半又来请求就共用结果 */
export function createQuotaReader(read: (profileId: string, profile: Profile) => Promise<RemoteProfileQuota> = (_id, p) => readCodexQuota(p)) {
  const inFlight = new Map<string, Promise<RemoteProfileQuota>>();
  return (profileId: string, profile: Profile): Promise<RemoteProfileQuota> => {
    const existing = inFlight.get(profileId);
    if (existing) return existing;
    const p = read(profileId, profile).finally(() => inFlight.delete(profileId));
    inFlight.set(profileId, p);
    return p;
  };
}
