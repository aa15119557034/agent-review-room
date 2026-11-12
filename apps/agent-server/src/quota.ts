import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { CODEX_QUOTA_READ_TIMEOUT_MS, RemoteBalance, RemoteProfileQuota, type RemoteQuotaWindow } from "@room/schemas";
import type { Profile } from "./config";
import { killTree, spawnDetached } from "./process-tree";
import { planSpawn } from "./win-command";
import { buildProfileEnv } from "./profile-env";

/**
 * S-24：读 Codex 订阅额度（契约 C-42b 的 GET /v1/profiles/:profileId/quota，ADR-004 §3）。
 *
 * 每次读都新起一个 `codex app-server`（stdio 上的 JSON-RPC，一行一条），依次发
 * initialize → initialized → account/rateLimits/read，拿到结果就结束进程。
 * - 整个过程（含启动）不超过 2 秒（CODEX_QUOTA_READ_TIMEOUT_MS）；超时、出错、没登录、
 *   字段缺失或对不上，相应各项报 null（「读不到」），不猜、不报 0
 * - 同一个 profile 同时只起一个进程：读到一半又来请求，就共用这一次的结果
 * - 环境变量和跑 Run 一样（envAllowlist + env + envFiles，见 profile-env.ts）
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
 * - ordinaryUsageAllowed 为 true → creditsInUse = false（还在用订阅里的额度）
 * - ordinaryUsageAllowed 为 false（后端不许再用订阅额度）→ 两个窗口一律 null，不管百分比多少，
 *   保证按现有选路规则（读不到就走本机）一定不走 Codex；账户有 credits / 不限量时 creditsInUse = true，否则 null
 * - ordinaryUsageAllowed 缺失或为 null → creditsInUse = null
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
    // 后端明确不许再用订阅额度（林离 #133）：百分比再低也不能信（Codex 协议说不能从百分比推断恢复），
    // 两个窗口都报 null（读不到）→ 主控端按 quota_unknown 走本机；有 credits 时 creditsInUse 为 true
    out.fiveHour = null;
    out.weekly = null;
    const credits = snap && isObj(snap.credits) ? snap.credits : null;
    if (credits && (credits.hasCredits === true || credits.unlimited === true)) out.creditsInUse = true;
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

export function readCodexQuota(profile: Profile, opts: QuotaReadOptions = {}): Promise<RemoteProfileQuota> {
  const timeoutMs = Math.min(opts.timeoutMs ?? CODEX_QUOTA_READ_TIMEOUT_MS, CODEX_QUOTA_READ_TIMEOUT_MS);
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? ((m: string) => console.warn(m));
  const quota = profile.quota;
  if (quota?.source !== "codex-app-server") return Promise.resolve(unknownQuota(now()));

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

    let env: NodeJS.ProcessEnv;
    try {
      env = buildProfileEnv(profile);
    } catch (err) {
      finish(unknownQuota(now()), `env failed: ${errorText(err)}`);
      return;
    }
    try {
      const plan = planSpawn(profile.command, quota.args);
      child = spawn(plan.file, plan.args, {
        cwd: profile.cwd,
        env,
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

// ---------------------------------------------------------------- S-21：Claude（从 Run 的输出里记）

/**
 * Claude 的 rate_limit_event.rate_limit_info → RemoteProfileQuota（2.1.x 实测形状）：
 *   { status, resetsAt, rateLimitType, isUsingOverage, overageStatus,
 *     unifiedWindows: { five_hour: { utilization: 0.11, resetsAt: <Unix 秒>, status }, seven_day: {…} } }
 * - utilization 是 0～1 的比例 → usedPercent ×100（超过 100 按 100）；窗口 status 是 rejected 时按 100
 * - 没有 unifiedWindows 时，用顶层 rateLimitType + status：rejected 的那个窗口记 100，其余未知（不猜百分比）
 * - isUsingOverage 是布尔 → creditsInUse；字段对不上的那项 null
 */
export function mapClaudeRateLimit(info: unknown, readAt: Date): RemoteProfileQuota {
  const out = unknownQuota(readAt);
  if (!isObj(info)) return out;
  const resets = (v: unknown): string | null => {
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return null;
    const d = new Date(v * 1000);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  };
  const toWin = (w: unknown, minutes: number): RemoteQuotaWindow | null => {
    if (!isObj(w)) return null;
    if (w.status === "rejected") return { usedPercent: 100, windowMinutes: minutes, resetsAt: resets(w.resetsAt) };
    const u = w.utilization;
    if (typeof u !== "number" || !Number.isFinite(u) || u < 0) return null;
    // 保留 1 位小数：0.29 × 100 不带出 28.999999999999996（汐 #156）
    return { usedPercent: Math.min(Math.round(u * 1000) / 10, 100), windowMinutes: minutes, resetsAt: resets(w.resetsAt) };
  };
  const windows = isObj(info.unifiedWindows) ? info.unifiedWindows : null;
  if (windows) {
    out.fiveHour = toWin(windows.five_hour, FIVE_HOUR_MINUTES);
    out.weekly = toWin(windows.seven_day, WEEKLY_MINUTES);
  } else if (info.status === "rejected") {
    const w = { usedPercent: 100, resetsAt: resets(info.resetsAt) };
    if (info.rateLimitType === "five_hour") out.fiveHour = { ...w, windowMinutes: FIVE_HOUR_MINUTES };
    else if (info.rateLimitType === "seven_day") out.weekly = { ...w, windowMinutes: WEEKLY_MINUTES };
  }
  if (typeof info.isUsingOverage === "boolean") out.creditsInUse = info.isUsingOverage;
  const checked = RemoteProfileQuota.safeParse(out);
  return checked.success ? checked.data : unknownQuota(readAt);
}

/**
 * 窗口的重置时间已经过了：那份百分比说的是上一个窗口，不能再报（C-49 / A-04）。
 * 过期的窗口报 null（读不到，不猜、不报 0）。没有 resetsAt 的窗口没法判断，原样留着。
 * creditsInUse 是账号级的（isUsingOverage 在 info 顶层，不属于哪一个窗口）：只要还有一个窗口没过期，
 * 那次读数就还在有效期里，它跟着留下；已知的窗口全过期了，整份读数都是上一轮的，才一起作废（汐 #219）。
 */
export function dropExpiredWindows(q: RemoteProfileQuota, now: Date): RemoteProfileQuota {
  const expired = (w: RemoteQuotaWindow | null) => w !== null && w.resetsAt !== null && Date.parse(w.resetsAt) <= now.getTime();
  const five = expired(q.fiveHour);
  const week = expired(q.weekly);
  if (!five && !week) return q;
  const someWindowStillValid = (q.fiveHour !== null && !five) || (q.weekly !== null && !week);
  return { ...q, fiveHour: five ? null : q.fiveHour, weekly: week ? null : q.weekly, creditsInUse: someWindowStillValid ? q.creditsInUse : null };
}

/**
 * 每个 Claude 账号最近一次从 Run 输出里看到的额度。只在内存里：节点重启后到下一次 Run 之前报「未知」。
 * Claude 的额度只能从 Run 的输出里读到，所以「用完了」那一份不能一直留着：主控端看到用完就不再派 Run，
 * 也就永远读不到新的。读的时候按 resetsAt 判过期（dropExpiredWindows），窗口重置后自己恢复成「未知」。
 */
export function createClaudeQuotaStore(now: () => Date = () => new Date()) {
  const latest = new Map<string, RemoteProfileQuota>();
  return {
    record(account: string, info: unknown): void {
      const q = mapClaudeRateLimit(info, now());
      // 什么都没认出来就不覆盖上一次的好数据
      if (q.fiveHour === null && q.weekly === null && q.creditsInUse === null) return;
      latest.set(account, q);
    },
    read(account: string): RemoteProfileQuota {
      const stored = latest.get(account);
      if (!stored) return unknownQuota(now());
      const fresh = dropExpiredWindows(stored, now());
      if (fresh === stored) return stored;
      if (fresh.fiveHour === null && fresh.weekly === null) {
        // 全过期了：和没读过一样
        latest.delete(account);
        return unknownQuota(now());
      }
      latest.set(account, fresh);
      return fresh;
    },
  };
}
export type ClaudeQuotaStore = ReturnType<typeof createClaudeQuotaStore>;

/** 这个 profile 的 Run 输出里的额度记在哪个 Claude 账号下（没配 quota 的 claude-stream-json profile 记在默认账号） */
export const claudeAccountOf = (profile: Profile): string | null =>
  profile.parser !== "claude-stream-json" ? null : profile.quota?.source === "claude-stream" ? profile.quota.account : "claude";

// ---------------------------------------------------------------- S-21：DeepSeek 余额

/**
 * GET <baseUrl>/user/balance 的结果 → RemoteProfileQuota（只填 balance）：
 *   { is_available: true, balance_infos: [{ currency: "CNY", total_balance: "110.00", granted_balance, topped_up_balance }] }
 * 有 CNY 用 CNY，否则第一项；total_balance 原样当金额（格式对不上就 null）。订阅窗口一律 null
 */
export function mapDeepSeekBalance(body: unknown, readAt: Date, log: (m: string) => void = () => {}): RemoteProfileQuota {
  const out: RemoteProfileQuota = { ...unknownQuota(readAt), balance: null };
  if (!isObj(body) || !Array.isArray(body.balance_infos)) return out;
  // is_available = false：账号现在不能调 API（停用 / 冻结），但契约里没有「不可用」这一态，硬说成余额 0 不对；
  // 余额照报，记一行日志，真跑时由 Run 的 quota_exhausted 兜（汐 #156）
  if (body.is_available === false) log("[agent-server] deepseek balance: is_available=false (account cannot call the API right now)");
  const infos = body.balance_infos.filter(isObj);
  const pick = infos.find((i) => i.currency === "CNY") ?? infos[0];
  if (!pick) return out;
  const amount = typeof pick.total_balance === "number" ? String(pick.total_balance) : pick.total_balance;
  const balance = RemoteBalance.safeParse({ amount, currency: pick.currency });
  if (balance.success) out.balance = balance.data;
  return out;
}

export async function readDeepSeekBalance(profile: Profile, opts: QuotaReadOptions & { fetch?: typeof fetch } = {}): Promise<RemoteProfileQuota> {
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? ((m: string) => console.warn(m));
  const quota = profile.quota;
  if (quota?.source !== "deepseek-balance") return unknownQuota(now());
  // 和跑 Run 同一个环境边界：安装脚本把 Key 放在 envFiles（林离 #163），也可能在 envAllowlist / env 里
  let key: string | undefined;
  try {
    key = buildProfileEnv(profile)[quota.apiKeyEnv];
  } catch (err) {
    log(`[agent-server] quota read failed: ${errorText(err)}`);
    return unknownQuota(now());
  }
  if (!key) {
    log(`[agent-server] quota read failed: ${quota.apiKeyEnv} is not set`);
    return unknownQuota(now());
  }
  const timeoutMs = Math.min(opts.timeoutMs ?? CODEX_QUOTA_READ_TIMEOUT_MS, CODEX_QUOTA_READ_TIMEOUT_MS);
  try {
    const res = await (opts.fetch ?? fetch)(`${quota.baseUrl.replace(/\/+$/, "")}/user/balance`, {
      headers: { authorization: `Bearer ${key}`, accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      log(`[agent-server] quota read failed: balance HTTP ${res.status}`);
      return unknownQuota(now());
    }
    return mapDeepSeekBalance(await res.json(), now(), log);
  } catch (err) {
    log(`[agent-server] quota read failed: balance ${errorText(err)}`);
    return unknownQuota(now());
  }
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
