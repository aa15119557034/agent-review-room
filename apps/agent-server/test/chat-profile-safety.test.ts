import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chatProfileProblems, ServerConfig } from "../src/config";
import { buildArgs } from "../src/model-args";

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
