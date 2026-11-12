import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomInt } from "node:crypto";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { RemoteEvent, RemoteProfileQuota } from "@room/schemas";
import { ServerConfig, validateProfiles } from "../src/config";
import { ClaudeStreamJsonParser } from "../src/parsers/claude-stream-json";
import { killTree } from "../src/process-tree";
import { createAgentServer, type AgentServer } from "../src/server";
import { CommandResolutionError, findOnPath, planSpawn, type ResolveEnv } from "../src/win-command";

const here = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- Windows 命令解析（模拟 win32）

const winEnv = (files: string[], env: Record<string, string> = {}): ResolveEnv => {
  const set = new Set(files.map((f) => f.toLowerCase()));
  return {
    platform: "win32",
    env: { Path: "C:\\Windows\\System32;C:\\Users\\me\\AppData\\Roaming\\npm", PATHEXT: ".COM;.EXE;.BAT;.CMD", ComSpec: "C:\\Windows\\System32\\cmd.exe", ...env },
    exists: (p) => set.has(p.toLowerCase()),
  };
};

describe("windows command resolution", () => {
  const ARGS = ["-p", "--output-format", "stream-json", "--verbose"];

  it("wraps an npm .cmd shim in cmd.exe /d /s /c", () => {
    const r = winEnv(["C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd"]);
    const plan = planSpawn("claude", ARGS, r);
    assert.equal(plan.viaCmd, true);
    assert.equal(plan.file, "C:\\Windows\\System32\\cmd.exe");
    assert.deepEqual(plan.args.slice(0, 3), ["/d", "/s", "/c"]);
    assert.equal(plan.args[3], `"C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd -p --output-format stream-json --verbose"`);
  });

  it("starts a native .exe directly (PATHEXT order: .EXE before .CMD)", () => {
    const r = winEnv(["C:\\Users\\me\\AppData\\Roaming\\npm\\claude.exe", "C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd"]);
    const plan = planSpawn("claude", ARGS, r);
    assert.equal(plan.viaCmd, false);
    assert.equal(plan.file, "C:\\Users\\me\\AppData\\Roaming\\npm\\claude.exe");
    assert.deepEqual(plan.args, ARGS);
  });

  it("quotes a .cmd path containing spaces", () => {
    const r = winEnv(["C:\\Program Files\\Claude Tools\\claude.cmd"]);
    const plan = planSpawn("C:\\Program Files\\Claude Tools\\claude", ["-p"], r);
    assert.equal(plan.args[3], `""C:\\Program Files\\Claude Tools\\claude.cmd" -p"`);
  });

  it("refuses cmd metacharacters in .cmd arguments instead of trying to escape them", () => {
    const r = winEnv(["C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd"]);
    for (const bad of ["a&b", "x|y", "%PATH%", "q\"uote", "(x)", "!x!", "a^b", "a>b", "line\nbreak"]) {
      assert.throws(() => planSpawn("claude", ["-p", bad], r), CommandResolutionError, bad);
    }
  });

  it("finds commands case-insensitively via Path and reports a clear error when missing", () => {
    assert.equal(findOnPath("claude", winEnv([])), null);
    assert.throws(() => planSpawn("claude", [], winEnv([])), /找不到命令/);
  });

  it("validateProfiles reports unusable profiles at startup", () => {
    const cfg = ServerConfig.parse({
      nodeId: "n",
      profiles: {
        ok: { command: "claude", args: ["-p"], cwd: "C:\\sandbox" },
        bad: { command: "claude", args: ["a&b"], cwd: "C:\\missing" },
      },
    });
    const r = winEnv(["C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd", "C:\\sandbox"]);
    const problems = validateProfiles(cfg, r);
    assert.equal(problems.length, 2);
    assert.ok(problems.every((p) => p.startsWith('profile "bad"')));
  });

  it("defaults to listening on 0.0.0.0 for LAN access", () => {
    assert.equal(ServerConfig.parse({ nodeId: "n", profiles: {} }).host, "0.0.0.0");
  });
});

// ---------------------------------------------------------------- 进程树终止

describe("killTree", () => {
  const fakeChild = (pid: number) => Object.assign(new EventEmitter(), { pid, exitCode: null, signalCode: null }) as unknown as ChildProcess;

  it("uses taskkill /pid <pid> /T /F on Windows", () => {
    const calls: { file: string; args: string[] }[] = [];
    killTree(fakeChild(4242), 100, {
      platform: "win32",
      run: (file, args, done) => (calls.push({ file, args }), done(null)),
      signalGroup: () => assert.fail("must not signal on Windows"),
      log: () => {},
    });
    assert.deepEqual(calls, [{ file: "taskkill", args: ["/pid", "4242", "/T", "/F"] }]);
  });

  it("logs when taskkill fails while the process is still alive", () => {
    const logs: string[] = [];
    killTree(fakeChild(7), 100, {
      platform: "win32",
      run: (_f, _a, done) => done(new Error("Access is denied.")),
      signalGroup: () => {},
      log: (m) => logs.push(m),
    });
    assert.match(logs[0] ?? "", /taskkill failed for pid 7/);
  });

  it("on POSIX sends SIGTERM to the process group, then SIGKILL after the grace period", async () => {
    const sigs: [number, string][] = [];
    killTree(fakeChild(99), 30, { platform: "linux", run: () => {}, signalGroup: (pid, s) => sigs.push([pid, s]), log: () => {} });
    assert.deepEqual(sigs, [[99, "SIGTERM"]]);
    await new Promise((r) => setTimeout(r, 60));
    assert.deepEqual(sigs, [[99, "SIGTERM"], [99, "SIGKILL"]]);
  });
});

// ---------------------------------------------------------------- claude stream-json 解析器

describe("claude stream-json parser", () => {
  const line = (o: unknown) => JSON.stringify(o) + "\n";
  const d = (text: string, parent: string | null = null) =>
    line({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } }, parent_tool_use_id: parent });

  it("buffers partial lines across chunks and only counts main-thread text", () => {
    const p = new ClaudeStreamJsonParser();
    const all = line({ type: "system", subtype: "init" }) + d("你好") + d("子任务", "toolu_1") + d("😀世界");
    const out = [];
    for (let i = 0; i < all.length; i += 7) out.push(...p.push(all.slice(i, i + 7)));
    assert.deepEqual(out, [{ kind: "text_delta", text: "你好" }, { kind: "text_delta", text: "😀世界" }]);
  });

  it("is complete only with a successful result line; result text is authoritative", () => {
    const p = new ClaudeStreamJsonParser();
    p.push(d("部分"));
    p.push(line({ type: "result", subtype: "success", is_error: false, result: "完整回复" }));
    assert.deepEqual(p.finish().verdict, { ok: true, finalText: "完整回复" });
  });

  it("treats a stream without a result line as incomplete, even if text arrived", () => {
    const p = new ClaudeStreamJsonParser();
    p.push(d("被截断的一半"));
    const v = p.finish().verdict;
    assert.equal(v.ok, false);
    assert.equal(!v.ok && v.reason, "incomplete_output");
  });

  it("reports an error result", () => {
    const p = new ClaudeStreamJsonParser();
    p.push(line({ type: "result", subtype: "error_during_execution", is_error: true, result: "API Error: 529" }));
    const v = p.finish().verdict;
    assert.equal(!v.ok && v.reason, "internal");
    assert.match(!v.ok ? v.message : "", /529/);
  });

  it("handles a final line without trailing newline and CRLF line endings", () => {
    const p = new ClaudeStreamJsonParser();
    const out = p.push(d("a").replace("\n", "\r\n"));
    p.push(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "a" }));
    assert.deepEqual(out, [{ kind: "text_delta", text: "a" }]);
    assert.equal(p.finish().verdict.ok, true);
  });

  it("forwards non-JSON lines as unparsed instead of dropping them", () => {
    const p = new ClaudeStreamJsonParser();
    assert.deepEqual(p.push("Warning: x\n"), [{ kind: "unparsed", line: "Warning: x" }]);
  });
});

// ---------------------------------------------------------------- 端到端：AgentServer + 假 claude

describe("agent-server with the claude-stream-json profile", () => {
  const TOKEN = "k".repeat(40);
  let agent: AgentServer;
  let base: string;
  const fake = join(here, "fixtures", "fake-claude.mjs");
  const profile = (mode: string) => ({
    command: process.execPath,
    args: [fake],
    cwd: here,
    parser: "claude-stream-json",
    env: { FAKE_MODE: mode },
  });

  before(async () => {
    const cfg = ServerConfig.parse({
      nodeId: "test",
      leaseMs: 2000,
      heartbeatMs: 200,
      maxConcurrentRuns: 4,
      profiles: {
        "claude-ok": profile("success"),
        "claude-truncated": profile("truncated"),
        "claude-error": profile("error"),
        "claude-noisy": profile("noisy"),
        "claude-split": profile("split"),
        // S-21：两个 profile 同一个账号：一个跑，另一个（配了 quota）读得到
        "claude-rate": { ...profile("success"), env: { FAKE_MODE: "success", FAKE_RATE: "0.42" } },
        "claude-quota": { ...profile("success"), quota: { source: "claude-stream" } },
        // C-49：另一个账号，5 小时窗口已经用完、而且重置时间早就过了
        "claude-stale": { ...profile("success"), env: { FAKE_MODE: "success", FAKE_RATE: "1", FAKE_RESET_5H: "1700000000" }, quota: { source: "claude-stream", account: "stale" } },
        "claude-crash": profile("crash"),
      },
    });
    agent = createAgentServer(cfg, TOKEN);
    await new Promise<void>((r) => agent.server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(agent.server.address() as AddressInfo).port}`;
  });
  after(() => agent.close());

  const ULID = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const id = () => Array.from({ length: 26 }, () => ULID[randomInt(32)]).join("");
  const auth = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

  async function runProfile(profileId: string, content = "请审查：并发写入的代码") {
    const runId = "run_" + id();
    const res = await fetch(`${base}/v1/runs`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        protocol: 1,
        runId,
        profileId,
        snapshot: { id: "snap_" + id(), content, contentHash: createHash("sha256").update(content).digest("hex") },
        limits: { idleTimeoutMs: 10_000, totalTimeoutMs: 20_000 },
      }),
    });
    assert.equal(res.status, 202);
    const text = await (await fetch(`${base}/v1/runs/${runId}/events?after=-1`, { headers: auth })).text();
    return text.split("\n").filter(Boolean).map((l) => RemoteEvent.parse(JSON.parse(l))).filter((e) => e.type !== "heartbeat");
  }

  const deltas = (es: RemoteEvent[]) => es.flatMap((e) => (e.type === "text_delta" ? [e.text] : [])).join("");
  const final = (es: RemoteEvent[]) => es.find((e) => e.type === "message_complete");
  const terminal = (es: RemoteEvent[]) => es.filter((e) => e.type === "terminal");

  it("streams parsed text, then the authoritative message, then completed", async () => {
    const content = "请审查：并发写入的代码";
    const es = await runProfile("claude-ok", content);
    const expected = `收到 ${content.length} 个字符。风险😀：并发写入。`;
    assert.equal(deltas(es), expected, "main-thread deltas only, emoji intact");
    assert.equal(final(es)?.type === "message_complete" && final(es)?.text, expected);
    assert.equal(es.filter((e) => e.type === "output" && e.stream === "stdout").length, 0, "raw JSON not forwarded");
    const t = terminal(es);
    assert.equal(t.length, 1);
    assert.deepEqual(t[0]?.type === "terminal" && t[0].result, { outcome: "completed", exitCode: 0 });
    const iFinal = es.findIndex((e) => e.type === "message_complete");
    const iTerm = es.findIndex((e) => e.type === "terminal");
    assert.ok(iFinal < iTerm, "message_complete comes before terminal");
  });

  it("S-21: the rate_limit_event of any run on the account becomes that account's quota; it is not forwarded", async () => {
    const read = async () =>
      RemoteProfileQuota.parse(await (await fetch(`${base}/v1/profiles/claude-quota/quota`, { headers: auth })).json());
    const before = await read();
    assert.deepEqual([before.fiveHour, before.weekly, before.creditsInUse], [null, null, null], "no run yet → unknown");
    const es = await runProfile("claude-rate");
    assert.equal(es.filter((e) => e.type === "output").length, 0, "the raw event is not forwarded");
    const q = await read();
    assert.equal(q.fiveHour?.usedPercent, 42);
    assert.equal(q.fiveHour?.windowMinutes, 300);
    assert.equal(q.weekly?.usedPercent, 31);
    assert.equal(q.weekly?.resetsAt, new Date(4102876800 * 1000).toISOString());
    assert.equal(q.creditsInUse, false);
  });

  it("C-49 / A-04: a used-up window whose reset time has passed is not reported as exhausted over HTTP", async () => {
    await runProfile("claude-stale");
    const q = RemoteProfileQuota.parse(await (await fetch(`${base}/v1/profiles/claude-stale/quota`, { headers: auth })).json());
    assert.equal(q.fiveHour, null, "expired window → unknown, so the controller does not keep the agent absent");
    assert.equal(q.weekly?.usedPercent, 31, "the weekly window is still inside its period");
  });

  it("C-49 / A-07: a non-zero exit says so, with the exit code and the tail of stderr", async () => {
    const es = await runProfile("claude-crash");
    const t = terminal(es);
    assert.equal(t.length, 1);
    const r = t[0]?.type === "terminal" ? t[0].result : null;
    assert.ok(r && r.outcome === "error" && r.reason === "process_exit_nonzero" && r.exitCode === 3);
    const message = r.outcome === "error" ? (r.message ?? "") : "";
    assert.match(message, /退出码 3/);
    assert.match(message, /Invalid model name/);
    assert.doesNotMatch(message, /Reviewer/);
  });

  it("a stream without a result line ends as error(incomplete_output) — never as completed", async () => {
    const es = await runProfile("claude-truncated");
    assert.ok(deltas(es).length > 0, "partial text was still streamed");
    assert.equal(final(es), undefined, "no authoritative message");
    const t = terminal(es)[0];
    assert.equal(t?.type === "terminal" && t.result.outcome, "error");
    assert.equal(t?.type === "terminal" && t.result.outcome === "error" && t.result.reason, "incomplete_output");
  });

  it("an error result ends as error(internal) with the message", async () => {
    const es = await runProfile("claude-error");
    const t = terminal(es)[0];
    assert.ok(t?.type === "terminal" && t.result.outcome === "error" && t.result.reason === "internal");
    assert.match(t?.type === "terminal" && t.result.outcome === "error" ? (t.result.message ?? "") : "", /529/);
  });

  it("non-JSON lines are forwarded as stdout output for debugging", async () => {
    const es = await runProfile("claude-noisy");
    assert.ok(es.some((e) => e.type === "output" && e.data.includes("Warning: something non-json")));
    assert.equal(terminal(es)[0]?.type === "terminal" && terminal(es)[0]?.result.outcome, "completed");
  });

  it("JSON lines split across writes are reassembled", async () => {
    const es = await runProfile("claude-split");
    assert.match(deltas(es), /^收到 \d+ 个字符。风险😀：并发写入。$/);
  });
});
