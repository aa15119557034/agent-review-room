import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { CODEX_QUOTA_READ_TIMEOUT_MS, NodeHealth, RemoteProfileQuota } from "@room/schemas";
import { ServerConfig, type Profile } from "../src/config";
import { createAgentServer, type AgentServer } from "../src/server";
import { claudeAccountOf, createClaudeQuotaStore, createQuotaReader, mapClaudeRateLimit, mapCodexRateLimits, mapDeepSeekBalance, readCodexQuota, readDeepSeekBalance } from "../src/quota";
import { validateProfiles } from "../src/config";

/**
 * S-24：读 Codex 订阅额度。「codex app-server」是一个 node 小脚本，按 stdio JSON-RPC 回话：
 * 正常回额度、回「没登录」、一直不回、提前退出、只回 initialize。
 */

const NODE = process.execPath;
const READ_AT = new Date("2026-11-01T05:00:00.000Z");
const RESET_5H = 1793509200; // 2026-11-01T05:00:00Z（和 READ_AT 同一刻）
const RESET_WEEK = 1794009600;

const dir = mkdtempSync(join(tmpdir(), "s24-"));
const FAKE = join(dir, "fake-app-server.mjs");
writeFileSync(
  FAKE,
  `
const mode = process.argv[2];
const result = JSON.parse(process.argv[3] ?? "null");
if (mode === "exit") process.exit(3);
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const m = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (m.id === 1) {
      if (mode === "hang") continue;
      console.log("not json log line");
      console.log(JSON.stringify({ id: 1, result: { userAgent: "fake", codexHome: "/x", platformFamily: "unix", platformOs: "linux" } }));
    } else if (m.method === "initialized") {
      console.log(JSON.stringify({ method: "remoteControl/status/changed", params: {} }));
    } else if (m.id === 2) {
      if (m.method !== "account/rateLimits/read") process.exit(9);
      if (mode === "init-only") continue;
      if (mode === "unauth") console.log(JSON.stringify({ id: 2, error: { code: -32600, message: "codex account authentication required to read rate limits" } }));
      else console.log(JSON.stringify({ id: 2, result }));
    }
  }
});
`,
);
after(() => rmSync(dir, { recursive: true, force: true }));

const win = (usedPercent: number, windowDurationMins: number | null, resetsAt: number | null) => ({ usedPercent, windowDurationMins, resetsAt });
const snapshot = (primary: unknown, secondary: unknown, credits: unknown = { hasCredits: false, unlimited: false, balance: null }) => ({
  limitId: "codex",
  limitName: null,
  normalModelSlug: null,
  primary,
  secondary,
  credits,
  individualLimit: null,
  spendControlReached: null,
  planType: "plus",
  rateLimitReachedType: null,
});
const NORMAL = {
  ordinaryUsageAllowed: true,
  rateLimits: snapshot(win(42, 300, RESET_5H), win(17.5, 10080, RESET_WEEK)),
  rateLimitsByLimitId: null,
  rateLimitResetCredits: null,
  accountId: null,
  rateLimitUpsell: null,
};

const profile = (mode: string, result: unknown = NORMAL, extra: Partial<Profile> = {}): Profile =>
  ServerConfig.parse({
    nodeId: "n",
    profiles: {
      p: {
        command: NODE,
        cwd: process.cwd(),
        envAllowlist: ["PATH"],
        quota: { source: "codex-app-server", args: [FAKE, mode, JSON.stringify(result)] },
        ...extra,
      },
    },
  }).profiles.p!;

describe("mapCodexRateLimits", () => {
  it("maps the 5-hour and weekly windows, reset times and credits state", () => {
    const q = mapCodexRateLimits(NORMAL, READ_AT);
    assert.deepEqual(q, {
      fiveHour: { usedPercent: 42, windowMinutes: 300, resetsAt: new Date(RESET_5H * 1000).toISOString() },
      weekly: { usedPercent: 17.5, windowMinutes: 10080, resetsAt: new Date(RESET_WEEK * 1000).toISOString() },
      creditsInUse: false,
      readAt: READ_AT.toISOString(),
    });
    assert.ok(RemoteProfileQuota.safeParse(q).success);
  });

  it("prefers the codex bucket over the legacy single bucket", () => {
    const q = mapCodexRateLimits(
      { ...NORMAL, rateLimitsByLimitId: { codex: snapshot(win(90, 300, null), win(60, 10080, null)), other: snapshot(win(1, 300, null), null) } },
      READ_AT,
    );
    assert.equal(q.fiveHour?.usedPercent, 90);
    assert.equal(q.weekly?.usedPercent, 60);
  });

  it("recognises windows by length, not by slot", () => {
    const q = mapCodexRateLimits({ ...NORMAL, rateLimits: snapshot(win(70, 10080, null), win(30, 300, null)) }, READ_AT);
    assert.equal(q.fiveHour?.usedPercent, 30);
    assert.equal(q.weekly?.usedPercent, 70);
  });

  it("a window with unknown or unexpected length is null, never guessed", () => {
    const q = mapCodexRateLimits({ ...NORMAL, rateLimits: snapshot(win(42, null, null), win(17, 1440, null)) }, READ_AT);
    assert.equal(q.fiveHour, null);
    assert.equal(q.weekly, null);
  });

  it("missing or bad numbers are null, not 0; over 100 counts as 100", () => {
    const q = mapCodexRateLimits({ ...NORMAL, rateLimits: snapshot({ windowDurationMins: 300, resetsAt: null }, win(130, 10080, -5)) }, READ_AT);
    assert.equal(q.fiveHour, null);
    assert.deepEqual(q.weekly, { usedPercent: 100, windowMinutes: 10080, resetsAt: null });
    const neg = mapCodexRateLimits({ ...NORMAL, rateLimits: snapshot(win(-1, 300, null), win(Number.NaN, 10080, null)) }, READ_AT);
    assert.equal(neg.fiveHour, null);
    assert.equal(neg.weekly, null);
  });

  it("credits in use: only when included usage is exhausted and credits are available", () => {
    const withCredits = { hasCredits: true, unlimited: false, balance: "12.00" };
    const cases: Array<[unknown, unknown, boolean | null]> = [
      [true, withCredits, false],
      [false, withCredits, true],
      [false, { hasCredits: false, unlimited: true, balance: null }, true],
      [false, { hasCredits: false, unlimited: false, balance: null }, null],
      [false, null, null],
      [null, withCredits, null],
      [undefined, withCredits, null],
    ];
    for (const [allowed, credits, want] of cases) {
      const q = mapCodexRateLimits({ ...NORMAL, ordinaryUsageAllowed: allowed, rateLimits: snapshot(win(1, 300, null), win(1, 10080, null), credits) }, READ_AT);
      assert.equal(q.creditsInUse, want, `${String(allowed)} / ${JSON.stringify(credits)}`);
    }
  });

  it("backend says no ordinary usage: low percentages are dropped, so the 85% rule can never pick Codex (林离 #133)", () => {
    for (const credits of [{ hasCredits: false, unlimited: false, balance: null }, null, { hasCredits: true, unlimited: false, balance: "3" }]) {
      const q = mapCodexRateLimits(
        { ...NORMAL, ordinaryUsageAllowed: false, rateLimits: snapshot(win(20, 300, RESET_5H), win(30, 10080, RESET_WEEK), credits) },
        READ_AT,
      );
      assert.equal(q.fiveHour, null, JSON.stringify(credits));
      assert.equal(q.weekly, null, JSON.stringify(credits));
      assert.notEqual(q.creditsInUse, false, "never claims credits are not in use");
    }
  });

  it("garbage is all unknown", () => {
    for (const r of [null, "x", 3, [], {}, { rateLimits: "x" }]) {
      assert.deepEqual(mapCodexRateLimits(r, READ_AT), { fiveHour: null, weekly: null, creditsInUse: null, readAt: READ_AT.toISOString() });
    }
  });
});

describe("readCodexQuota against a fake app-server", () => {
  const quiet = { log: () => {}, now: () => READ_AT };

  it("reads the quota over stdio JSON-RPC, skipping log lines and notifications", async () => {
    const q = await readCodexQuota(profile("ok"), quiet);
    assert.equal(q.fiveHour?.usedPercent, 42);
    assert.equal(q.weekly?.usedPercent, 17.5);
    assert.equal(q.creditsInUse, false);
  });

  it("not logged in → all unknown, and the reason is logged", async () => {
    const logs: string[] = [];
    const q = await readCodexQuota(profile("unauth"), { ...quiet, log: (m) => logs.push(m) });
    assert.deepEqual(q, { fiveHour: null, weekly: null, creditsInUse: null, readAt: READ_AT.toISOString() });
    assert.match(logs.join(), /authentication required/);
  });

  for (const mode of ["hang", "init-only"]) {
    it(`no answer (${mode}) → unknown after the timeout`, async () => {
      const t0 = Date.now();
      const q = await readCodexQuota(profile(mode), { ...quiet, timeoutMs: 300 });
      const took = Date.now() - t0;
      assert.equal(q.fiveHour, null);
      assert.equal(q.creditsInUse, null);
      assert.ok(took >= 280 && took < 1500, `took ${took} ms`);
    });
  }

  it("the timeout can never be longer than the contract's 2 seconds", async () => {
    const t0 = Date.now();
    await readCodexQuota(profile("hang"), { ...quiet, timeoutMs: 60_000 });
    const took = Date.now() - t0;
    assert.ok(took >= CODEX_QUOTA_READ_TIMEOUT_MS - 50 && took < CODEX_QUOTA_READ_TIMEOUT_MS + 1000, `took ${took} ms`);
  });

  it("envFiles unreadable → unknown, logged as env failed (not spawn failed), path only (汐 #164)", async () => {
    const logs: string[] = [];
    const q = await readCodexQuota(profile("ok", NORMAL, { envFiles: { SOME_KEY: join(dir, "no-such-env.txt") } }), { ...quiet, log: (m) => logs.push(m) });
    assert.equal(q.fiveHour, null);
    assert.equal(logs.length, 1);
    assert.match(logs[0]!, /env failed: .*envFiles\.SOME_KEY/);
    assert.doesNotMatch(logs[0]!, /spawn failed/);
  });

  it("app-server exits early or the command is missing → unknown", async () => {
    assert.equal((await readCodexQuota(profile("exit"), quiet)).fiveHour, null);
    const missing = profile("ok", NORMAL, { command: join(dir, "no-such-codex") });
    assert.equal((await readCodexQuota(missing, quiet)).weekly, null);
  });

  it("the app-server only gets the profile's allowlisted environment", async () => {
    process.env.S24_SECRET_FOR_TEST = "x";
    try {
      const seen: string[] = [];
      // 回显脚本把自己看到的环境变量名当错误信息回来，读额度失败时会记进日志
      const echo = ServerConfig.parse({
        nodeId: "n",
        profiles: {
          e: {
            command: NODE,
            cwd: process.cwd(),
            envAllowlist: ["PATH"],
            quota: { source: "codex-app-server", args: ["-e", `console.log(JSON.stringify({id:1,error:{message:Object.keys(process.env).join(",")}}))`] },
          },
        },
      }).profiles.e!;
      await readCodexQuota(echo, { ...quiet, log: (m) => seen.push(m) });
      assert.ok(seen.length === 1);
      assert.match(seen[0]!, /PATH/);
      assert.doesNotMatch(seen[0]!, /S24_SECRET_FOR_TEST/);
    } finally {
      delete process.env.S24_SECRET_FOR_TEST;
    }
  });
});

describe("createQuotaReader", () => {
  it("one read at a time per profile; concurrent callers share it", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const read = createQuotaReader(async () => {
      calls++;
      await gate;
      return mapCodexRateLimits(NORMAL, READ_AT);
    });
    const p = profile("ok");
    const a = read("p", p);
    const b = read("p", p);
    release();
    assert.deepEqual(await a, await b);
    assert.equal(calls, 1);
    await read("p", p);
    assert.equal(calls, 2, "a later request reads again");
  });
});

describe("GET /v1/profiles/:id/quota", () => {
  const TOKEN = "t".repeat(40);
  const auth = { authorization: `Bearer ${TOKEN}` };
  let agent: AgentServer;
  let base: string;
  let reads = 0;
  const cfg = ServerConfig.parse({
    nodeId: "n",
    port: 1,
    profiles: {
      "codex-image": { command: NODE, cwd: process.cwd(), quota: { source: "codex-app-server" } },
      plain: { command: NODE, cwd: process.cwd() },
    },
  });

  before(async () => {
    agent = createAgentServer(cfg, TOKEN, async () => {
      reads++;
      return mapCodexRateLimits(NORMAL, READ_AT);
    });
    await new Promise<void>((r) => agent.server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(agent.server.address() as AddressInfo).port}`;
  });
  after(() => agent.close());

  it("health reports capabilities.quota", async () => {
    const h = NodeHealth.parse(await (await fetch(`${base}/v1/health`, { headers: auth })).json());
    assert.equal(h.capabilities?.quota, true);
  });

  it("returns the quota for a profile with a quota source", async () => {
    const res = await fetch(`${base}/v1/profiles/codex-image/quota`, { headers: auth });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const q = RemoteProfileQuota.parse(await res.json());
    assert.equal(q.fiveHour?.usedPercent, 42);
    assert.equal(reads, 1);
  });

  it("unknown profile / profile without quota / no token", async () => {
    const unknown = await fetch(`${base}/v1/profiles/nope/quota`, { headers: auth });
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json()).error, "unknown_profile");
    const proto = await fetch(`${base}/v1/profiles/__proto__/quota`, { headers: auth });
    assert.equal(proto.status, 404);
    const plain = await fetch(`${base}/v1/profiles/plain/quota`, { headers: auth });
    assert.equal(plain.status, 404);
    assert.equal((await plain.json()).error, "not_found");
    assert.equal((await fetch(`${base}/v1/profiles/codex-image/quota`)).status, 401);
  });

  it("a node without quota profiles says so in health", async () => {
    const other = createAgentServer(ServerConfig.parse({ nodeId: "n", port: 1, profiles: { plain: { command: NODE, cwd: "." } } }), TOKEN);
    await new Promise<void>((r) => other.server.listen(0, "127.0.0.1", () => r()));
    try {
      const url = `http://127.0.0.1:${(other.server.address() as AddressInfo).port}`;
      const h = NodeHealth.parse(await (await fetch(`${url}/v1/health`, { headers: auth })).json());
      assert.equal(h.capabilities?.quota, false);
    } finally {
      await other.close();
    }
  });
});

// ---------------------------------------------------------------- S-21

describe("S-21: Claude quota from rate_limit_event", () => {
  const BEFORE_RESET = new Date(RESET_5H * 1000 - 3_600_000);
  const info = (patch: Record<string, unknown> = {}) => ({
    status: "allowed", resetsAt: RESET_5H, rateLimitType: "five_hour", isUsingOverage: false,
    unifiedWindows: {
      five_hour: { utilization: 0.11, resetsAt: RESET_5H, status: "allowed" },
      seven_day: { utilization: 0.31, resetsAt: RESET_WEEK, status: "allowed" },
    },
    ...patch,
  });

  it("maps utilization (0–1) to percent with window lengths and reset times", () => {
    const q = mapClaudeRateLimit(info(), READ_AT);
    assert.deepEqual(q.fiveHour, { usedPercent: 11, windowMinutes: 300, resetsAt: new Date(RESET_5H * 1000).toISOString() });
    assert.equal(q.weekly?.usedPercent, 31);
    assert.equal(q.weekly?.windowMinutes, 10080);
    assert.equal(q.creditsInUse, false);
    assert.equal(q.readAt, READ_AT.toISOString());
  });

  it("percent keeps one decimal, no float tails (汐 #156)", () => {
    const q = mapClaudeRateLimit(info({
      unifiedWindows: { five_hour: { utilization: 0.29 }, seven_day: { utilization: 0.07 } },
    }), READ_AT);
    assert.deepEqual([q.fiveHour?.usedPercent, q.weekly?.usedPercent], [29, 7]);
    const r = mapClaudeRateLimit(info({ unifiedWindows: { five_hour: { utilization: 0.12345 } } }), READ_AT);
    assert.equal(r.fiveHour?.usedPercent, 12.3);
  });

  it("a rejected window counts as 100; over 1 caps at 100; bad numbers are null", () => {
    const q = mapClaudeRateLimit(info({
      unifiedWindows: { five_hour: { utilization: 0.4, status: "rejected" }, seven_day: { utilization: 1.7 } },
    }), READ_AT);
    assert.equal(q.fiveHour?.usedPercent, 100);
    assert.equal(q.weekly?.usedPercent, 100);
    const bad = mapClaudeRateLimit(info({ unifiedWindows: { five_hour: { utilization: "x" }, seven_day: { utilization: -1 } } }), READ_AT);
    assert.deepEqual([bad.fiveHour, bad.weekly], [null, null]);
  });

  it("without unifiedWindows only a rejected top-level window is known; never guessed otherwise", () => {
    const rejected = mapClaudeRateLimit({ status: "rejected", rateLimitType: "seven_day", resetsAt: RESET_WEEK }, READ_AT);
    assert.equal(rejected.weekly?.usedPercent, 100);
    assert.equal(rejected.fiveHour, null);
    const allowed = mapClaudeRateLimit({ status: "allowed", rateLimitType: "five_hour" }, READ_AT);
    assert.deepEqual([allowed.fiveHour, allowed.weekly, allowed.creditsInUse], [null, null, null]);
    assert.deepEqual([mapClaudeRateLimit(null, READ_AT).fiveHour, mapClaudeRateLimit("x", READ_AT).weekly], [null, null]);
  });

  it("the store keeps the latest per account, and garbage never overwrites good data", () => {
    // 窗口还没重置的时候读（RESET_5H 和 READ_AT 是同一刻，过期的窗口不再报，见下面 A-04）
    const store = createClaudeQuotaStore(() => BEFORE_RESET);
    assert.equal(store.read("claude").fiveHour, null, "nothing seen yet");
    store.record("claude", info());
    store.record("claude", { nonsense: true });
    assert.equal(store.read("claude").fiveHour?.usedPercent, 11);
    assert.equal(store.read("other").fiveHour, null, "accounts are separate");
  });

  it("C-49 / A-04: a window whose reset time has passed is no longer reported (recovers without a node restart)", () => {
    let clock = BEFORE_RESET;
    const store = createClaudeQuotaStore(() => clock);
    // 5 小时窗口用完了，每周还有
    store.record("claude", info({
      unifiedWindows: {
        five_hour: { status: "rejected", resetsAt: RESET_5H },
        seven_day: { utilization: 0.5, resetsAt: RESET_WEEK, status: "allowed" },
      },
      isUsingOverage: false,
    }));
    assert.equal(store.read("claude").fiveHour?.usedPercent, 100, "still inside the window: exhausted");

    clock = new Date(RESET_5H * 1000); // 到重置时间的那一刻就算过期
    const afterFive = store.read("claude");
    assert.equal(afterFive.fiveHour, null, "the expired window is unknown again, not 100 and not 0");
    assert.equal(afterFive.weekly?.usedPercent, 50, "the other window is still valid");
    assert.equal(afterFive.creditsInUse, null, "credits flag belonged to the old reading");
    assert.equal(RemoteProfileQuota.safeParse(afterFive).success, true);

    clock = new Date(RESET_WEEK * 1000 + 1000);
    const afterAll = store.read("claude");
    assert.deepEqual([afterAll.fiveHour, afterAll.weekly, afterAll.creditsInUse], [null, null, null]);
    assert.equal(afterAll.readAt, clock.toISOString(), "all expired = same as never read");
  });

  it("C-49 / A-04: a window without resetsAt cannot be judged and is kept", () => {
    let clock = BEFORE_RESET;
    const store = createClaudeQuotaStore(() => clock);
    store.record("claude", info({ unifiedWindows: { five_hour: { utilization: 0.4 }, seven_day: { utilization: 0.1 } } }));
    clock = new Date(RESET_WEEK * 1000 + 86_400_000);
    assert.equal(store.read("claude").fiveHour?.usedPercent, 40);
  });

  it("which account a profile's runs belong to", () => {
    const p = (patch: Partial<Profile>) => ({ parser: "raw", quota: undefined, ...patch }) as unknown as Profile;
    assert.equal(claudeAccountOf(p({ parser: "claude-stream-json" })), "claude");
    assert.equal(claudeAccountOf(p({ parser: "claude-stream-json", quota: { source: "claude-stream", account: "work" } })), "work");
    assert.equal(claudeAccountOf(p({ parser: "codex-exec-json" })), null);
  });
});

describe("S-21: DeepSeek balance", () => {
  const body = { is_available: true, balance_infos: [{ currency: "USD", total_balance: "2.00" }, { currency: "CNY", total_balance: "110.50", granted_balance: "10.00", topped_up_balance: "100.50" }] };

  it("prefers CNY, takes total_balance as is; subscription windows stay null", () => {
    const q = mapDeepSeekBalance(body, READ_AT);
    assert.deepEqual(q.balance, { amount: "110.50", currency: "CNY" });
    assert.deepEqual([q.fiveHour, q.weekly, q.creditsInUse], [null, null, null]);
    assert.ok(RemoteProfileQuota.safeParse(q).success);
    assert.deepEqual(mapDeepSeekBalance({ balance_infos: [{ currency: "USD", total_balance: 3 }] }, READ_AT).balance, { amount: "3", currency: "USD" });
  });

  it("is_available=false keeps the balance but logs a warning (汐 #156)", () => {
    const logs: string[] = [];
    const q = mapDeepSeekBalance({ ...body, is_available: false }, READ_AT, (m) => logs.push(m));
    assert.equal(q.balance?.amount, "110.50");
    assert.equal(logs.length, 1);
    mapDeepSeekBalance(body, READ_AT, (m) => logs.push(m));
    assert.equal(logs.length, 1, "no warning when available");
  });

  it("anything unexpected is unknown (null), never 0", () => {
    for (const b of [null, {}, { balance_infos: [] }, { balance_infos: [{ currency: "CNY", total_balance: "lots" }] }]) {
      assert.equal(mapDeepSeekBalance(b, READ_AT).balance, null, JSON.stringify(b));
    }
  });

  const dsProfile = (patch: Record<string, unknown> = {}) =>
    ServerConfig.parse({
      nodeId: "n", port: 1,
      profiles: { ds: { command: NODE, cwd: ".", envAllowlist: ["S21_KEY"], quota: { source: "deepseek-balance", apiKeyEnv: "S21_KEY" }, ...patch } },
    }).profiles.ds!;

  it("reads with the key from the allowlisted env var; the key goes only into the header", async () => {
    process.env.S21_KEY = "sk-test-s21";
    try {
      const seen: { url: string; auth: string | null }[] = [];
      const fake = (async (url: string, init: RequestInit) => {
        seen.push({ url, auth: new Headers(init.headers).get("authorization") });
        return new Response(JSON.stringify(body), { status: 200 });
      }) as unknown as typeof fetch;
      const q = await readDeepSeekBalance(dsProfile(), { fetch: fake, now: () => READ_AT, log: () => {} });
      assert.equal(q.balance?.amount, "110.50");
      assert.deepEqual(seen, [{ url: "https://api.deepseek.com/user/balance", auth: "Bearer sk-test-s21" }]);
    } finally {
      delete process.env.S21_KEY;
    }
  });

  it("reads the key from envFiles (how install-secretary sets it up), no allowlist needed (林离 #163)", async () => {
    const keyFile = join(dir, "ds-key.txt");
    writeFileSync(keyFile, "sk-file-s21\n");
    const seen: (string | null)[] = [];
    const fake = (async (_url: string, init: RequestInit) => {
      seen.push(new Headers(init.headers).get("authorization"));
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
    const q = await readDeepSeekBalance(dsProfile({ envAllowlist: [], envFiles: { S21_KEY: keyFile } }), { fetch: fake, now: () => READ_AT, log: () => {} });
    assert.equal(q.balance?.amount, "110.50");
    assert.deepEqual(seen, ["Bearer sk-file-s21"]);

    // 文件读不了：unknown，不发请求，日志只有路径不含内容
    const logs: string[] = [];
    const missing = join(dir, "no-such-key.txt");
    const q2 = await readDeepSeekBalance(dsProfile({ envAllowlist: [], envFiles: { S21_KEY: missing } }), { fetch: fake, log: (m) => logs.push(m) });
    assert.equal(q2.balance ?? null, null);
    assert.equal(seen.length, 1);
    assert.equal(logs.length, 1);
    assert.match(logs[0]!, /envFiles\.S21_KEY/);
    assert.ok(!logs[0]!.includes("sk-file-s21"));
  });

  it("no key / HTTP error / network error / timeout → unknown, and the log never contains the key", async () => {
    const logs: string[] = [];
    const log = (m: string) => logs.push(m);
    const ok = (async () => new Response(JSON.stringify(body))) as unknown as typeof fetch;
    assert.equal((await readDeepSeekBalance(dsProfile(), { fetch: ok, log })).balance ?? null, null, "key not set");
    process.env.S21_KEY = "sk-test-s21";
    try {
      const status = (async () => new Response("no", { status: 401 })) as unknown as typeof fetch;
      assert.equal((await readDeepSeekBalance(dsProfile(), { fetch: status, log })).balance ?? null, null);
      const boom = (async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch;
      assert.equal((await readDeepSeekBalance(dsProfile(), { fetch: boom, log })).balance ?? null, null);
      const hang = ((_u: string, init: RequestInit) =>
        new Promise((_r, reject) => {
          // AbortSignal.timeout 的计时器不占住事件循环（真节点有 HTTP 服务占着）；测试里自己占一下
          const keep = setTimeout(() => {}, 5000);
          init.signal!.addEventListener("abort", () => {
            clearTimeout(keep);
            reject(new Error("aborted"));
          });
        })) as unknown as typeof fetch;
      const t0 = Date.now();
      assert.equal((await readDeepSeekBalance(dsProfile(), { fetch: hang, log, timeoutMs: 50 })).balance ?? null, null);
      assert.ok(Date.now() - t0 < CODEX_QUOTA_READ_TIMEOUT_MS);
      assert.equal(logs.length, 4);
      assert.ok(logs.every((l) => !l.includes("sk-test-s21")));
    } finally {
      delete process.env.S21_KEY;
    }
  });

  it("config checks: the key env must be allowlisted or in envFiles; claude-stream needs the claude parser", () => {
    const cfg = (profiles: Record<string, unknown>) => ServerConfig.parse({ nodeId: "n", port: 1, profiles });
    const problems = (profiles: Record<string, unknown>) => validateProfiles(cfg(profiles)).join("\n");
    assert.match(problems({ ds: { command: NODE, cwd: ".", quota: { source: "deepseek-balance" } } }), /envAllowlist 或 envFiles 要包含 DEEPSEEK_API_KEY/);
    // 安装脚本的形状：Key 不在 allowlist，改从 envFiles 读（envFiles 的文件存在性另有检查）
    assert.doesNotMatch(
      problems({ ds: { command: NODE, cwd: ".", envFiles: { DEEPSEEK_API_KEY: FAKE }, quota: { source: "deepseek-balance" } } }),
      /envAllowlist 或 envFiles 要包含/,
    );
    // 写进 env 不算（env 不放密钥，汐 #164）
    assert.match(
      problems({ ds: { command: NODE, cwd: ".", env: { DEEPSEEK_API_KEY: "x" }, quota: { source: "deepseek-balance" } } }),
      /envAllowlist 或 envFiles 要包含/,
    );
    assert.match(problems({ c: { command: NODE, cwd: ".", quota: { source: "claude-stream" } } }), /parser 要是 claude-stream-json/);
    assert.equal(problems({ c: { command: NODE, cwd: ".", parser: "claude-stream-json", quota: { source: "claude-stream" } } }), "");
  });
});
