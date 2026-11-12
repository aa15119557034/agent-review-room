import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chatProfileProblems, chatProfileWarnings, ServerConfig } from "../src/config";
import { buildArgs } from "../src/model-args";
import { planSpawn } from "../src/win-command";

describe("chat profile effective arguments", () => {
  it("keeps safe mappings valid and leaves discussion profiles outside the chat restriction", () => {
    const profile = ServerConfig.parse({ nodeId: "test", profiles: { "codex-chat": {
      command: "codex", args: ["exec", "--sandbox", "read-only", "--disable", "shell_tool"], cwd: process.cwd(),
      models: [{ id: "test-model", displayName: "model", efforts: [], defaultEffort: null }], modelArgs: ["--model", "{model}"],
    } } }).profiles["codex-chat"]!;
    assert.deepEqual(chatProfileProblems("codex-chat", profile), []);
    assert.deepEqual(chatProfileProblems("codex-discuss", { ...profile, args: ["--full-auto"] }), []);
  });
  it("checks forbidden flags added through model/effort mappings and image arguments", () => {
    const base = {
      command: "codex", args: ["exec", "--sandbox", "read-only", "--disable", "shell_tool"], cwd: process.cwd(),
    };
    for (const extra of [
      { models: [{ id: "full-auto", displayName: "model", efforts: [], defaultEffort: null }], modelArgs: ["--{model}"] },
      { models: [{ id: "test-model", displayName: "model", efforts: [{ id: "full-auto", displayName: "effort", note: null }], defaultEffort: "full-auto" }], modelArgs: ["--model", "{model}"], effortArgs: ["--{effort}"] },
      { images: { input: "openai-content-json", args: ["--full-auto"] } },
    ]) {
      const profile = ServerConfig.parse({ nodeId: "test", profiles: { "codex-chat": { ...base, ...extra } } }).profiles["codex-chat"]!;
      const option = profile.models[0];
      const args = [...buildArgs(profile, option ? { model: option.id, effort: option.defaultEffort } : undefined), ...(profile.images?.args ?? [])];
      assert.ok(args.includes("--full-auto"));
      assert.ok(chatProfileProblems("codex-chat", profile).some((problem) => problem.includes("--full-auto")), JSON.stringify(extra));
    }
  });
});

describe("C-49 / A-02: claude chat profiles should not load hooks from settings files", () => {
  const claudeChat = (extra: string[]) =>
    ServerConfig.parse({ nodeId: "test", profiles: { "claude-chat": {
      command: "claude", cwd: process.cwd(),
      args: ["-p", "--tools=", "--strict-mcp-config", "--permission-mode", "dontAsk", ...extra],
    } } }).profiles["claude-chat"]!;

  it("warns (does not refuse) when nothing keeps user / project settings out", () => {
    const p = claudeChat([]);
    assert.deepEqual(chatProfileProblems("claude-chat", p), [], "still starts: existing nodes must not break on upgrade");
    assert.equal(chatProfileWarnings("claude-chat", p).length, 1);
    assert.match(chatProfileWarnings("claude-chat", p)[0]!, /--setting-sources=/);
  });

  it("is quiet with --setting-sources= / --safe-mode, and for non-chat or non-claude profiles", () => {
    for (const extra of [["--setting-sources="], ["--setting-sources", ""], ["--safe-mode"]]) {
      assert.deepEqual(chatProfileWarnings("claude-chat", claudeChat(extra)), [], extra.join(" "));
    }
    assert.deepEqual(chatProfileWarnings("claude-review", claudeChat([])), []);
    assert.deepEqual(chatProfileWarnings("codex-chat", { ...claudeChat([]), command: "codex" }), []);
  });

  it("a --setting-sources with a value still reads some settings, so it does not silence the warning (汐 #219)", () => {
    for (const extra of [["--setting-sources", "user"], ["--setting-sources", "project,user"], ["--setting-sources=user"], ["--setting-sources=project,local"], ["--setting-sources"]]) {
      assert.equal(chatProfileWarnings("claude-chat", claudeChat(extra)).length, 1, extra.join(" "));
    }
    // 空值后面再跟别的参数、前面有别的参数都照样认
    assert.deepEqual(chatProfileWarnings("claude-chat", claudeChat(["--model", "x", "--setting-sources", "", "--verbose"])), []);
    // 「user」是别的参数的值、不是 --setting-sources 的：空值在前面一个位置才算
    assert.equal(chatProfileWarnings("claude-chat", claudeChat(["--setting-sources", "user", ""])).length, 1);
  });

  it("the shipped example config has the flag and passes the Windows .cmd argument check", () => {
    const example = ServerConfig.parse(JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "agent-server.config.example.json"), "utf8")));
    const chat = example.profiles["claude-chat"]!;
    assert.ok(chat.args.includes("--setting-sources="));
    assert.deepEqual(chatProfileWarnings("claude-chat", chat), []);
    assert.deepEqual(chatProfileProblems("claude-chat", chat), []);
    // npm 装的 claude 在 Windows 上是 claude.cmd：参数里不能有 cmd 元字符
    const win = { platform: "win32" as const, env: { PATH: "C:\\npm", PATHEXT: ".CMD" }, exists: (f: string) => f.toLowerCase() === "c:\\npm\\claude.cmd" };
    for (const m of chat.models) {
      for (const e of m.efforts) assert.doesNotThrow(() => planSpawn("claude", buildArgs(chat, { model: m.id, effort: e.id }), win), `${m.id} ${e.id}`);
    }
    assert.ok(chat.models.some((m) => m.id === "claude-haiku-5-5"), "Haiku 5.5 is selectable (D-02)");
  });
});
