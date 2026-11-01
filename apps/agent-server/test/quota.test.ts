import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { CODEX_QUOTA_READ_TIMEOUT_MS, NodeHealth, RemoteProfileQuota } from "@room/schemas";
import { ServerConfig, type Profile } from "../src/config";
import { createAgentServer, type AgentServer } from "../src/server";
import { createQuotaReader, mapCodexRateLimits, readCodexQuota } from "../src/quota";

/**
 * S-24：读 Codex 订阅额度。「codex app-server」是一个 node 小脚本，按 stdio JSON-RPC 回话：
 * 正常回额度、回「没登录」、一直不回、提前退出、只回 initialize。
 */

const NODE = process.execPath;
const READ_AT = new Date("2026-11-01T05:00:00.000Z");
const RESET_5H = 1793509200; // 2026-11-01T06:20:00Z
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
