import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomInt } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RemoteEvent } from "@room/schemas";
import { ServerConfig } from "../src/config";
import { ClaudeStreamJsonParser } from "../src/parsers/claude-stream-json";
import { CodexExecJsonParser } from "../src/parsers/codex-exec-json";
import { looksLikeQuota } from "../src/parsers/common";
import { RoomJsonlParser } from "../src/parsers/room-jsonl";
import { createAgentServer, type AgentServer } from "../src/server";

/**
 * S-10：主控机本机节点上的讨论用 profile（codex-discuss / deepseek-discuss）
 * 以及 C-25：节点能把"额度用尽"报告成 quota_exhausted。
 */

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, "..");
const line = (o: unknown) => JSON.stringify(o) + "\n";

// ---------------------------------------------------------------- 解析器

describe("codex exec --json parser", () => {
  const ok = [
    line({ type: "thread.started", thread_id: "t" }),
    line({ type: "turn.started" }),
    line({ type: "item.completed", item: { type: "reasoning", text: "想一想" } }),
    line({ type: "item.completed", item: { type: "agent_message", text: "第一段" } }),
    line({ type: "item.completed", item: { type: "command_execution", command: "ls" } }),
    line({ type: "item.completed", item: { type: "agent_message", text: "最终回答😀" } }),
    line({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }),
  ].join("");

  it("streams every agent_message and takes the last one as the final answer (like codex -o)", () => {
    const p = new CodexExecJsonParser();
    const out = [];
    for (let i = 0; i < ok.length; i += 9) out.push(...p.push(ok.slice(i, i + 9)));
    assert.deepEqual(out, [{ kind: "text_delta", text: "第一段" }, { kind: "text_delta", text: "\n\n最终回答😀" }]);
    assert.deepEqual(p.finish().verdict, { ok: true, finalText: "最终回答😀" });
  });

  it("is incomplete without turn.completed, even after agent messages", () => {
    const p = new CodexExecJsonParser();
    p.push(line({ type: "item.completed", item: { type: "agent_message", text: "半截" } }));
    const v = p.finish().verdict;
    assert.equal(!v.ok && v.reason, "incomplete_output");
  });

  it("a non-fatal error (reconnect notice) followed by turn.completed is still a success", () => {
    const p = new CodexExecJsonParser();
    p.push(line({ type: "error", message: "Reconnecting... 1/5" }));
    p.push(line({ type: "item.completed", item: { type: "agent_message", text: "好了" } }));
    p.push(line({ type: "turn.completed", usage: {} }));
    assert.deepEqual(p.finish().verdict, { ok: true, finalText: "好了" });
  });

  it("turn.failed with a usage-limit message → quota_exhausted", () => {
    const p = new CodexExecJsonParser();
    p.push(line({ type: "turn.failed", error: { message: "You've hit your usage limit. Upgrade or try again later." } }));
    const v = p.finish().verdict;
    assert.equal(!v.ok && v.reason, "quota_exhausted");
  });

  it("turn.failed for another reason → internal (no guessing)", () => {
    const p = new CodexExecJsonParser();
    p.push(line({ type: "turn.failed", error: { message: "stream disconnected before completion" } }));
    const v = p.finish().verdict;
    assert.equal(!v.ok && v.reason, "internal");
  });

  it("real `codex exec --json` output from the controller (Codex v0.163.0): warning item is not a failure", () => {
    // 2026-10-21 DeepSeek 在主控机上抓的原文。第 2 行是 item.completed + type "error"（功能开关警告），不是失败
    const p = new CodexExecJsonParser();
    const out = p.push(readFileSync(join(here, "fixtures", "codex-real-hello.jsonl"), "utf8"));
    assert.deepEqual(out, [{ kind: "text_delta", text: "hello" }]);
    assert.deepEqual(p.finish().verdict, { ok: true, finalText: "hello" });
  });

  it("completed turn with no agent_message is not a successful answer", () => {
    const p = new CodexExecJsonParser();
    p.push(line({ type: "turn.completed", usage: {} }));
    assert.equal(p.finish().verdict.ok, false);
  });
});

describe("claude parser recognises quota errors", () => {
  it("usage limit result → quota_exhausted; other API errors stay internal", () => {
    const limit = new ClaudeStreamJsonParser();
    limit.push(line({ type: "result", subtype: "success", is_error: true, result: "Claude AI usage limit reached|1760000000" }));
    assert.equal(((v) => !v.ok && v.reason)(limit.finish().verdict), "quota_exhausted");

    const status429 = new ClaudeStreamJsonParser();
    status429.push(line({ type: "result", subtype: "error_during_execution", is_error: true, result: "API Error", api_error_status: 429 }));
    assert.equal(((v) => !v.ok && v.reason)(status429.finish().verdict), "quota_exhausted");

    const overloaded = new ClaudeStreamJsonParser();
    overloaded.push(line({ type: "result", subtype: "error_during_execution", is_error: true, result: "API Error: 529 Overloaded" }));
    assert.equal(((v) => !v.ok && v.reason)(overloaded.finish().verdict), "internal");
  });

  it("the quota matcher does not fire on ordinary failures", () => {
    for (const m of ["API Error: 529 Overloaded", "stream disconnected", "ENOENT", "Invalid API key"]) assert.equal(looksLikeQuota(m), false, m);
    for (const m of ["You've hit your usage limit", "Rate limit reached", "429 Too Many Requests", "DeepSeek 402 余额不足"]) {
      assert.equal(looksLikeQuota(m), true, m);
    }
  });
});

describe("C-49 / A-03: limits that are not the subscription quota", () => {
  it("context / budget / turn limits are ordinary errors, not quota_exhausted", () => {
    for (const m of ["Context limit reached", "Budget limit reached", "Context window limit reached · /compact or /clear to continue", "Max turns limit reached"]) {
      assert.equal(looksLikeQuota(m), false, m);
    }
    const ctx = new ClaudeStreamJsonParser();
    ctx.push(line({ type: "result", subtype: "success", is_error: true, result: "Context limit reached" }));
    const v = ctx.finish().verdict;
    assert.equal(!v.ok && v.reason, "internal");
  });

  it("real quota wording still counts, with or without a 429", () => {
    for (const m of ["You've hit your limit · resets 3pm", "You've hit your session limit", "You've hit your weekly limit · resets Mon", "5-hour limit reached ∙ resets 7pm", "Weekly limit reached", "Claude AI usage limit reached|1760000000"]) {
      assert.equal(looksLikeQuota(m), true, m);
    }
    // 即使文字像「上下文」，服务商明说 429 就是限流
    const both = new ClaudeStreamJsonParser();
    both.push(line({ type: "result", subtype: "error_during_execution", is_error: true, result: "Context limit reached", api_error_status: 429 }));
    const v = both.finish().verdict;
    assert.equal(!v.ok && v.reason, "quota_exhausted");
  });
});

describe("room-jsonl parser", () => {
  it("done is required; error carries the quota flag", () => {
    const ok = new RoomJsonlParser();
    assert.deepEqual(ok.push(line({ type: "delta", text: "你" }) + line({ type: "delta", text: "好" })), [
      { kind: "text_delta", text: "你" },
      { kind: "text_delta", text: "好" },
    ]);
    ok.push(line({ type: "done", text: "你好", finishReason: "stop" }));
    assert.deepEqual(ok.finish().verdict, { ok: true, finalText: "你好" });

    const cut = new RoomJsonlParser();
    cut.push(line({ type: "delta", text: "半" }));
    assert.equal(((v) => !v.ok && v.reason)(cut.finish().verdict), "incomplete_output");

    const quota = new RoomJsonlParser();
    quota.push(line({ type: "error", message: "DeepSeek 402 余额不足", quota: true }));
    assert.equal(((v) => !v.ok && v.reason)(quota.finish().verdict), "quota_exhausted");

    const other = new RoomJsonlParser();
    other.push(line({ type: "error", message: "DeepSeek 401 API Key 无效", quota: false }));
    assert.equal(((v) => !v.ok && v.reason)(other.finish().verdict), "internal");
  });
});

// ---------------------------------------------------------------- 示例配置

describe("controller-local example config", () => {
  const cfg = ServerConfig.parse(JSON.parse(readFileSync(join(appDir, "agent-server.config.local.example.json"), "utf8")));

  it("listens only on loopback and runs two agents at once", () => {
    assert.equal(cfg.host, "127.0.0.1");
    assert.ok(cfg.maxConcurrentRuns >= 2);
  });

  it("codex-discuss reads the prompt from stdin, read-only, without saving sessions", () => {
    const p = cfg.profiles["codex-discuss"]!;
    assert.equal(p.parser, "codex-exec-json");
    for (const a of ["exec", "--json", "--skip-git-repo-check", "--ephemeral", "-"]) assert.ok(p.args.includes(a), a);
    assert.equal(p.args[p.args.indexOf("--sandbox") + 1], "read-only");
    // 汐 #131 实测：讨论/聊天时不让 Codex 自己画图（不白烧额度、不往 generated_images 塞图）
    assert.equal(p.args[p.args.indexOf("--disable") + 1], "image_generation");
    assert.ok(p.args.indexOf("--disable") < p.args.indexOf("-"), "--disable must come before the stdin marker");
  });

  it("the DeepSeek key reaches only the deepseek profile, never via fixed env", () => {
    const ds = cfg.profiles["deepseek-discuss"]!;
    assert.equal(ds.parser, "room-jsonl");
    assert.ok(ds.envAllowlist.includes("DEEPSEEK_API_KEY"));
    assert.ok(!cfg.profiles["codex-discuss"]!.envAllowlist.includes("DEEPSEEK_API_KEY"));
    for (const p of Object.values(cfg.profiles)) assert.ok(!Object.keys(p.env).some((k) => /key|token|secret/i.test(k)));
  });
});

// ---------------------------------------------------------------- deepseek-chat.mjs 对着假的 DeepSeek

describe("bin/deepseek-chat.mjs", () => {
  let fake: Server;
  let baseUrl: string;
  const seen: { auth?: string; body?: Record<string, unknown> }[] = [];

  before(async () => {
    fake = createServer((req, res) => {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        const body = JSON.parse(raw) as Record<string, unknown>;
        seen.push({ auth: req.headers.authorization, body });
        const prompt = ((body["messages"] as { content: string }[])[0]?.content ?? "");
        if (prompt.includes("402")) {
          res.writeHead(402, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "Insufficient Balance" } }));
          return;
        }
        if (prompt.includes("401")) {
          res.writeHead(401).end("{}");
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        const chunk = (delta: object, finish: string | null = null) =>
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
        res.write(": keep-alive\n\n");
        chunk({ reasoning_content: "思考不算回答" });
        chunk({ content: "同意" });
        if (prompt.includes("cut")) {
          res.end(); // 没有 finish_reason，也没有 [DONE]
          return;
        }
        chunk({ content: "😀，理由如下" }, "stop");
        res.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>((r) => fake.listen(0, "127.0.0.1", () => r()));
    baseUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  });
  after(() => fake.close());

  function run(
    prompt: string,
    env: Record<string, string | undefined> = { DEEPSEEK_API_KEY: "sk-test-not-real" },
    modelArgs: string[] = ["--model", "m-test"],
  ) {
    return new Promise<{ code: number | null; lines: Record<string, unknown>[]; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [join(appDir, "bin", "deepseek-chat.mjs"), ...modelArgs, "--base-url", baseUrl], {
        env: { PATH: process.env["PATH"], ...env },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (code) =>
        resolve({ code, stdout, stderr, lines: stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) }),
      );
      child.stdin.end(prompt, "utf8");
    });
  }

  it("streams content (not reasoning) and ends with done; prompt sent verbatim with the key as Bearer", async () => {
    const r = await run("请讨论：方案 A");
    assert.equal(r.code, 0);
    assert.deepEqual(r.lines, [
      { type: "delta", text: "同意" },
      { type: "delta", text: "😀，理由如下" },
      { type: "done", text: "同意😀，理由如下", finishReason: "stop" },
    ]);
    const last = seen[seen.length - 1]!;
    assert.equal(last.auth, "Bearer sk-test-not-real");
    assert.equal(last.body?.["model"], "m-test");
    assert.equal(last.body?.["stream"], true);
    assert.deepEqual(last.body?.["messages"], [{ role: "user", content: "请讨论：方案 A" }]);
    assert.ok(!r.stdout.includes("sk-test-not-real") && !r.stderr.includes("sk-test-not-real"), "key never printed");
  });

  it("S-22: --effort goes out as reasoning_effort; without flags it is deepseek-flash and the API's default effort", async () => {
    await run("hi", undefined, ["--model", "deepseek-flash", "--effort", "max"]);
    assert.equal(seen.at(-1)?.body?.["model"], "deepseek-flash");
    assert.equal(seen.at(-1)?.body?.["reasoning_effort"], "max");
    await run("hi", undefined, []);
    assert.equal(seen.at(-1)?.body?.["model"], "deepseek-flash");
    assert.ok(!("reasoning_effort" in (seen.at(-1)?.body ?? {})));
  });

  it("402 insufficient balance → error with quota=true, exit 1", async () => {
    const r = await run("触发 402");
    assert.equal(r.code, 1);
    assert.equal(r.lines.at(-1)?.["type"], "error");
    assert.equal(r.lines.at(-1)?.["quota"], true);
  });

  it("401 → error with quota=false", async () => {
    const r = await run("触发 401");
    assert.equal(r.lines.at(-1)?.["quota"], false);
  });

  it("a stream cut before finish is an error, never done", async () => {
    const r = await run("cut");
    assert.equal(r.code, 1);
    assert.ok(!r.lines.some((l) => l["type"] === "done"));
  });

  it("S-23: --input-format content-json sends the node's text / image blocks as the message content, in order", async () => {
    const blocks = [
      { type: "text", text: "资料：[图片位置 0123456789abcdef]" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      { type: "text", text: "\n当前消息：图里写了什么？" },
    ];
    const r = await run(JSON.stringify({ content: blocks }), undefined, ["--model", "m-test", "--input-format", "content-json"]);
    assert.equal(r.code, 0);
    assert.deepEqual(seen.at(-1)?.body?.["messages"], [{ role: "user", content: blocks }]);
  });

  it("S-23: content-json refuses anything but text blocks and data: URL images, without calling the API", async () => {
    const before = seen.length;
    for (const bad of [
      "not json",
      JSON.stringify({ content: [] }),
      JSON.stringify({ content: [{ type: "image_url", image_url: { url: "https://example.com/a.png" } }] }),
      JSON.stringify({ content: [{ type: "text", text: "x", cache_control: {} }] }),
      JSON.stringify({ content: [{ type: "input_audio", input_audio: {} }] }),
    ]) {
      const r = await run(bad, undefined, ["--input-format", "content-json"]);
      assert.equal(r.code, 1, bad);
      assert.equal(r.lines.at(-1)?.["type"], "error");
    }
    assert.equal(seen.length, before);
  });

  it("missing key → clear error without calling the API", async () => {
    const before = seen.length;
    const r = await run("hi", {});
    assert.equal(r.code, 1);
    assert.match(String(r.lines.at(-1)?.["message"]), /DEEPSEEK_API_KEY/);
    assert.equal(seen.length, before);
  });
});

// ---------------------------------------------------------------- 端到端：AgentServer + 假 codex

describe("agent-server with the codex-exec-json profile", () => {
  const TOKEN = "c".repeat(40);
  let agent: AgentServer;
  let base: string;
  const fake = join(here, "fixtures", "fake-codex.mjs");
  const profile = (mode: string) => ({
    command: process.execPath,
    args: [fake],
    cwd: here,
    parser: "codex-exec-json",
    env: { FAKE_MODE: mode },
  });

  before(async () => {
    const cfg = ServerConfig.parse({
      nodeId: "test",
      leaseMs: 2000,
      heartbeatMs: 200,
      maxConcurrentRuns: 4,
      profiles: {
        "codex-ok": profile("success"),
        "codex-quota": profile("quota"),
        "codex-truncated": profile("truncated"),
        "codex-retry": profile("retry_then_success"),
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

  async function runProfile(profileId: string, content = "请讨论：群聊模式") {
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
  const terminals = (es: RemoteEvent[]) => es.flatMap((e) => (e.type === "terminal" ? [e.result] : []));

  it("completes with the last agent message as the authoritative text", async () => {
    const content = "请讨论：群聊模式";
    const es = await runProfile("codex-ok", content);
    const final = es.find((e) => e.type === "message_complete");
    assert.equal(final?.type === "message_complete" && final.text, `收到 ${content.length} 个字符。结论：同意😀`);
    assert.deepEqual(terminals(es), [{ outcome: "completed", exitCode: 0 }]);
    assert.ok(es.some((e) => e.type === "output" && e.stream === "stderr"), "stderr progress still forwarded");
  });

  it("usage limit (non-zero exit) is reported as quota_exhausted, exactly one terminal", async () => {
    const es = await runProfile("codex-quota");
    const t = terminals(es);
    assert.equal(t.length, 1);
    assert.equal(t[0]?.outcome === "error" && t[0].reason, "quota_exhausted");
    assert.equal(t[0]?.outcome === "error" && t[0].exitCode, 1);
    assert.equal(es.find((e) => e.type === "message_complete"), undefined);
  });

  it("exit 0 without turn.completed is incomplete_output", async () => {
    const t = terminals(await runProfile("codex-truncated"));
    assert.equal(t[0]?.outcome === "error" && t[0].reason, "incomplete_output");
  });

  it("a reconnect notice does not fail a turn that completes", async () => {
    const t = terminals(await runProfile("codex-retry"));
    assert.deepEqual(t, [{ outcome: "completed", exitCode: 0 }]);
  });
});
