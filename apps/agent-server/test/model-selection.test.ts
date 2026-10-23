import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomInt } from "node:crypto";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeHealth, RemoteEvent, type ModelOption, type RunModel } from "@room/schemas";
import { ServerConfig, validateProfiles } from "../src/config";
import { buildArgs, checkModel, modelConfigProblems, type ModelProfile } from "../src/model-args";
import { createAgentServer, type AgentServer } from "../src/server";
import type { ResolveEnv } from "../src/win-command";

/** S-22：节点上报模型清单，把 StartRun.model 翻译成 CLI 参数，清单外的一律拒绝 */

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, "..");

const level = (id: string) => ({ id, displayName: id, note: null });
const sol: ModelOption = { id: "gpt-6.1-sol", displayName: "Sol", efforts: ["low", "medium", "high"].map(level), defaultEffort: "low" };
const flat: ModelOption = { id: "flat-1", displayName: "Flat", efforts: [], defaultEffort: null };
const codex: ModelProfile = {
  args: ["exec", "--json", "{model-args}", "-"],
  models: [sol, flat],
  modelArgs: ["-m", "{model}"],
  effortArgs: ["-c", "model_reasoning_effort={effort}"],
};

describe("checkModel", () => {
  it("accepts only listed models with a listed level (or null for models without levels)", () => {
    assert.equal(checkModel(codex, { model: "gpt-6.1-sol", effort: "medium" }), null);
    assert.equal(checkModel(codex, { model: "flat-1", effort: null }), null);
    const refused: RunModel[] = [
      { model: "gpt-9", effort: "medium" }, // 清单外的模型
      { model: "gpt-6.1-sol", effort: "max" }, // 清单外的档位，不就近取档
      { model: "gpt-6.1-sol", effort: null }, // 有档位的模型必须指定
      { model: "flat-1", effort: "low" }, // 没档位的模型不能带
    ];
    for (const m of refused) assert.notEqual(checkModel(codex, m), null, JSON.stringify(m));
  });

  it("a profile without a catalog refuses any model", () => {
    assert.notEqual(checkModel({ models: [] }, { model: "gpt-6.1-sol", effort: "low" }), null);
  });
});

describe("buildArgs", () => {
  it("puts model args at the marker; no model → marker just removed", () => {
    assert.deepEqual(buildArgs(codex, { model: "gpt-6.1-sol", effort: "high" }), [
      "exec", "--json", "-m", "gpt-6.1-sol", "-c", "model_reasoning_effort=high", "-",
    ]);
    assert.deepEqual(buildArgs(codex), ["exec", "--json", "-"]);
    assert.deepEqual(buildArgs(codex, { model: "flat-1", effort: null }), ["exec", "--json", "-m", "flat-1", "-"]);
  });

  it("without a marker the args go last", () => {
    const claude = { args: ["-p"], models: [sol], modelArgs: ["--model", "{model}"], effortArgs: ["--effort", "{effort}"] };
    assert.deepEqual(buildArgs(claude, { model: "gpt-6.1-sol", effort: "low" }), ["-p", "--model", "gpt-6.1-sol", "--effort", "low"]);
  });
});

describe("model config checks", () => {
  it("catches mappings that don't fit the catalog", () => {
    assert.deepEqual(modelConfigProblems(codex), []);
    assert.deepEqual(modelConfigProblems({ args: ["-p"], models: [], modelArgs: [], effortArgs: [] }), []);
    const bad: [Partial<ModelProfile>, RegExp][] = [
      [{ modelArgs: ["-m"] }, /modelArgs 必须包含 \{model\}/],
      [{ effortArgs: [] }, /effortArgs 必须包含 \{effort\}/],
      [{ args: ["{model-args}", "{model-args}"] }, /只能出现一次/],
      [{ args: ["--model", "{model}"] }, /不能直接写/],
      [{ models: [] }, /没有 models 清单/],
      [{ models: [flat] }, /effortArgs 应该为空/],
    ];
    for (const [patch, msg] of bad) {
      assert.match(modelConfigProblems({ ...codex, ...patch }).join("；"), msg, JSON.stringify(patch));
    }
  });

  it("validateProfiles checks every model and level the way it would be spawned", () => {
    // Windows 上 .cmd 不能带 cmd 特殊字符：档位名合法，但映射里写了 % 就要在启动时报出来
    const files = new Set(["c:\\npm\\codex.cmd", here.toLowerCase()]);
    const r: ResolveEnv = {
      platform: "win32",
      env: { Path: "C:\\npm", PATHEXT: ".EXE;.CMD", ComSpec: "C:\\Windows\\System32\\cmd.exe" },
      exists: (p) => files.has(p.toLowerCase()),
    };
    const cfg = ServerConfig.parse({
      nodeId: "n",
      profiles: {
        good: { command: "codex", cwd: here, ...codex },
        bad: { command: "codex", cwd: here, ...codex, effortArgs: ["-c", "x=%{effort}%"] },
        dup: { command: "codex", cwd: here, ...codex, models: [sol, sol] },
      },
    });
    const problems = validateProfiles(cfg, r);
    assert.ok(!problems.some((p) => p.includes('"good"')), problems.join("\n"));
    assert.ok(problems.some((p) => p.includes('"bad"')), problems.join("\n"));
    assert.ok(problems.some((p) => p.includes('"dup"') && p.includes("重复")), problems.join("\n"));
  });
});

describe("example configs carry the measured catalogs and the user's defaults", () => {
  const read = (f: string) => ServerConfig.parse(JSON.parse(readFileSync(join(appDir, f), "utf8")));
  const reviewer = read("agent-server.config.example.json");
  const local = read("agent-server.config.local.example.json");

  // 江浩 2026-10-23：C酱 / 林离 讨论 medium、汇总 high；汐 固定 deepseek-flash、high
  const wanted: [ServerConfig["profiles"][string], RunModel][] = [
    [reviewer.profiles["claude-review"]!, { model: "claude-opus-5-5", effort: "medium" }],
    [reviewer.profiles["claude-review"]!, { model: "claude-sonnet-5-5", effort: "high" }],
    [local.profiles["codex-discuss"]!, { model: "gpt-6.1-sol", effort: "medium" }],
    [local.profiles["codex-discuss"]!, { model: "gpt-6-astra", effort: "high" }],
    [local.profiles["deepseek-discuss"]!, { model: "deepseek-flash", effort: "high" }],
  ];

  it("every default model and level is in the catalog and maps to the measured CLI flags", () => {
    for (const [p, m] of wanted) assert.equal(checkModel(p, m), null, JSON.stringify(m));
    assert.deepEqual(buildArgs(reviewer.profiles["claude-review"]!, wanted[0]![1]).slice(-4), ["--model", "claude-opus-5-5", "--effort", "medium"]);
    assert.deepEqual(buildArgs(local.profiles["codex-discuss"]!, wanted[2]![1]).slice(-5), [
      "-m", "gpt-6.1-sol", "-c", "model_reasoning_effort=medium", "-",
    ]);
    assert.deepEqual(buildArgs(local.profiles["deepseek-discuss"]!, wanted[4]![1]), [
      "../bin/deepseek-chat.mjs", "--model", "deepseek-flash", "--effort", "high",
    ]);
  });

  it("levels the CLIs rejected or don't have are not offered", () => {
    assert.notEqual(checkModel(local.profiles["deepseek-discuss"]!, { model: "deepseek-flash", effort: "off" }), null);
    assert.notEqual(checkModel(local.profiles["codex-discuss"]!, { model: "gpt-6.1-sol", effort: "ultra" }), null);
    for (const cfg of [reviewer, local]) {
      for (const p of Object.values(cfg.profiles)) assert.deepEqual(modelConfigProblems(p), []);
      // 写死的 --model 和清单不能同时存在
      for (const p of Object.values(cfg.profiles)) if (p.models.length) assert.ok(!p.args.includes("--model") && !p.args.includes("-m"));
    }
  });
});

// ---------------------------------------------------------------- 节点：health 和 StartRun

describe("agent-server with model selection", () => {
  const TOKEN = "m".repeat(40);
  let agent: AgentServer;
  let base: string;
  const auth = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
  // 子进程把自己收到的参数打印出来（raw 解析器原样转发）
  const printArgs = ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", "--"];

  before(async () => {
    const cfg = ServerConfig.parse({
      nodeId: "n",
      maxConcurrentRuns: 4,
      profiles: {
        pick: { ...codex, command: process.execPath, args: [...printArgs, "{model-args}", "tail"], cwd: here },
        fixed: { command: process.execPath, args: printArgs, cwd: here },
      },
    });
    agent = createAgentServer(cfg, TOKEN);
    await new Promise<void>((r) => agent.server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(agent.server.address() as AddressInfo).port}`;
  });
  after(() => agent.close());

  const ULID = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const id = () => Array.from({ length: 26 }, () => ULID[randomInt(32)]).join("");
  const body = (profileId: string, model?: RunModel, runId = "run_" + id()) => ({
    protocol: 1,
    runId,
    profileId,
    snapshot: { id: "snap_" + id(), content: "hi", contentHash: createHash("sha256").update("hi").digest("hex") },
    limits: { idleTimeoutMs: 10_000, totalTimeoutMs: 20_000 },
    ...(model ? { model } : {}),
  });
  const start = (b: unknown) => fetch(`${base}/v1/runs`, { method: "POST", headers: auth, body: JSON.stringify(b) });
  const runCount = async () => ((await (await fetch(`${base}/v1/runs`, { headers: auth })).json()) as unknown[]).length;

  async function argsOf(runId: string): Promise<string[]> {
    const text = await (await fetch(`${base}/v1/runs/${runId}/events?after=-1`, { headers: auth })).text();
    const es = text.split("\n").filter(Boolean).map((l) => RemoteEvent.parse(JSON.parse(l)));
    const out = es.map((e) => (e.type === "output" && e.stream === "stdout" ? e.data : "")).join("");
    const last = es.at(-1);
    assert.ok(last?.type === "terminal" && last.result.outcome === "completed", JSON.stringify(last));
    return JSON.parse(out) as string[]; // node 自己吃掉了 "--"
  }

  it("health reports each profile's catalog; a fixed profile reports []", async () => {
    const h = NodeHealth.parse(await (await fetch(`${base}/v1/health`, { headers: auth })).json());
    assert.deepEqual(h.profileModels, [
      { profileId: "pick", models: [sol, flat] },
      { profileId: "fixed", models: [] },
    ]);
  });

  it("translates the chosen model and level through the node's mapping", async () => {
    const b = body("pick", { model: "gpt-6.1-sol", effort: "high" });
    assert.equal((await start(b)).status, 202);
    assert.deepEqual(await argsOf(b.runId), ["-m", "gpt-6.1-sol", "-c", "model_reasoning_effort=high", "tail"]);

    const plain = body("pick");
    assert.equal((await start(plain)).status, 202);
    assert.deepEqual(await argsOf(plain.runId), ["tail"]);
  });

  it("refuses unlisted models / levels and models on a fixed profile with unknown_model, without starting anything", async () => {
    const before = await runCount();
    const refused: [string, RunModel][] = [
      ["pick", { model: "gpt-9", effort: "high" }],
      ["pick", { model: "gpt-6.1-sol", effort: "max" }],
      ["pick", { model: "gpt-6.1-sol", effort: null }],
      ["pick", { model: "flat-1", effort: "low" }],
      ["fixed", { model: "gpt-6.1-sol", effort: "low" }],
    ];
    for (const [profile, m] of refused) {
      const res = await start(body(profile, m));
      assert.equal(res.status, 400, JSON.stringify(m));
      assert.equal(((await res.json()) as { error: string }).error, "unknown_model");
    }
    assert.equal(await runCount(), before);
  });

  it("a command smuggled as a model id is rejected by the contract before the catalog", async () => {
    const res = await start(body("pick", { model: "--dangerously-skip-permissions", effort: null }));
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { error: string }).error, "bad_request");
  });

  it("resubmitting a runId with a different model is a conflict, the same model is idempotent", async () => {
    const b = body("pick", { model: "gpt-6.1-sol", effort: "low" });
    assert.equal((await start(b)).status, 202);
    assert.equal((await start(b)).status, 200);
    assert.equal((await start({ ...b, model: { model: "gpt-6.1-sol", effort: "medium" } })).status, 409);
    assert.equal((await start({ ...b, model: undefined })).status, 409);
    await argsOf(b.runId);
  });
});
