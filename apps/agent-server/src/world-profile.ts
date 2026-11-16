import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { RunModel, WORLD_PROFILE_RECIPE_DEEPSEEK_HTTP_V1, type WorldProfileCapability } from "@room/schemas";
import type { Profile, ServerConfig } from "./config";
import { buildArgs, checkModel, modelConfigProblems } from "./model-args";
import { planSpawn } from "./win-command";

// LF-normalized SHA-256 of the audited bundled bin/deepseek-chat.mjs. A script
// change requires another isolation review, not just updating a config flag.
const SCRIPT_SHA256 = "6902836a665c878cc6adbab8f3937c78c04f71953838ab5f852ca58d9b581814";
const SYSTEM_ENV = ["SYSTEMROOT", "WINDIR", "TEMP", "TMP", "LANG"];
const UNSAFE_ENV = /^(NODE_OPTIONS|NODE_PATH|NODE_USE_ENV_PROXY|ELECTRON_RUN_AS_NODE|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_.*)$/i;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** This is one audited recipe, not a generic profile/plugin registry. Invalid
 * sources produce no capability. Re-evaluate immediately before admission. */
export function worldProfiles(cfg: ServerConfig): Map<string, { capability: WorldProfileCapability; profile: Profile }> {
  const result = new Map<string, { capability: WorldProfileCapability; profile: Profile }>();
  const entries = cfg.worldProfiles ?? [];
  if (!cfg.runFenceDir || Object.keys(cfg.profiles).length + entries.length > 64) return result;
  const targets = new Set(entries.map(e => e.profileId));
  for (const entry of entries) {
    if (entry.recipeVersion !== WORLD_PROFILE_RECIPE_DEEPSEEK_HTTP_V1 ||
        (cfg.agent && (!entry.profileId.startsWith(cfg.agent + "-") || !entry.sourceChatProfileId.startsWith(cfg.agent + "-"))) ||
        targets.has(entry.sourceChatProfileId) || Object.hasOwn(cfg.profiles, entry.profileId) ||
        entries.filter(e => e.profileId === entry.profileId || e.sourceChatProfileId === entry.sourceChatProfileId).length !== 1) continue;
    const source = Object.hasOwn(cfg.profiles, entry.sourceChatProfileId) ? cfg.profiles[entry.sourceChatProfileId] : undefined;
    if (!source || !entry.sourceChatProfileId.endsWith("-chat")) continue;
    const constructed = construct(source, cfg.runFenceDir);
    if (constructed) result.set(entry.profileId, { capability: { ...entry, sourceDefaultModel: constructed.sourceDefaultModel }, profile: constructed.profile });
  }
  return result;
}

function construct(source: Profile, fenceDir: string): { profile: Profile; sourceDefaultModel: RunModel | null } | null {
  try {
    if (source.parser !== "room-jsonl" || source.imageRun || source.verifyCommit || source.models.length === 0 || modelConfigProblems(source).length ||
        new Set(source.models.map(m => m.id)).size !== source.models.length ||
        !same(source.modelArgs, ["--model", "{model}"]) ||
        !same(source.effortArgs, source.models.some(m => m.efforts.length > 0) ? ["--effort", "{effort}"] : [])) return null;
    if ([...source.envAllowlist, ...Object.keys(source.env), ...Object.keys(source.envFiles)].some(k => UNSAFE_ENV.test(k))) return null;
    // Only the same Node binary as this running node is recognized; cmd/npm/CLI
    // wrappers and executable overrides cannot be declared isolated by config.
    const plan = planSpawn(source.command, []);
    if (plan.viaCmd || realpathSync.native(plan.file) !== realpathSync.native(process.execPath)) return null;
    const args = buildArgs(source), first = args.shift();
    if (!first || first.startsWith("-")) return null;
    const script = realpathSync.native(isAbsolute(first) ? first : resolve(source.cwd, first));
    if (createHash("sha256").update(readFileSync(script, "utf8").replace(/\r\n/g, "\n")).digest("hex") !== SCRIPT_SHA256) return null;
    const options = new Map<string, string>();
    if (args.length % 2) return null;
    for (let i = 0; i < args.length; i += 2) {
      const key = args[i]!, value = args[i + 1]!;
      if (!["--model", "--effort", "--base-url", "--max-tokens"].includes(key) || options.has(key) || !value || value.startsWith("--")) return null;
      options.set(key, value);
    }
    // The source's own argument order must really honor every advertised
    // selection. A model marker before a later fixed --model/--effort does not.
    for (const model of source.models) for (const effort of model.efforts.length ? model.efforts.map(e => e.id) : [null]) {
      const selected = buildArgs(source, { model: model.id, effort }).slice(1);
      const effective = new Map<string, string>();
      for (let i = 0; i < selected.length; i += 2) effective.set(selected[i]!, selected[i + 1]!);
      if (effective.get("--model") !== model.id || (effective.get("--effort") ?? null) !== effort) return null;
    }
    const endpoint = options.get("--base-url") ?? "https://api.deepseek.com";
    const url = new URL(endpoint);
    if (url.username || url.password || url.search || url.hash ||
        (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))) return null;
    const maxTokens = options.get("--max-tokens") ?? "2048";
    if (!/^\d+$/.test(maxTokens) || Number(maxTokens) < 1 || Number(maxTokens) > 8192) return null;
    const sourceDefault = RunModel.safeParse({ model: options.get("--model") ?? "deepseek-flash", effort: options.get("--effort") ?? null });
    const sourceDefaultModel = sourceDefault.success && checkModel(source, sourceDefault.data) === null ? sourceDefault.data : null;
    // Key lookup preserves source precedence, but no arbitrary environment,
    // home, hooks, modelArgs, memory, images, quota, or resume settings are copied.
    const key = "DEEPSEEK_API_KEY";
    if (!source.envAllowlist.includes(key) && source.env[key] === undefined && source.envFiles[key] === undefined) return null;
    const cwd = join(realpathSync.native(fenceDir), "world-empty");
    try { mkdirSync(cwd); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    if (lstatSync(cwd).isSymbolicLink() || realpathSync.native(cwd) !== cwd || readdirSync(cwd).length !== 0) return null;
    const profile: Profile = {
      command: realpathSync.native(process.execPath), args: [script, "--base-url", endpoint, "--max-tokens", maxTokens], cwd,
      envAllowlist: [...SYSTEM_ENV, ...(source.envAllowlist.includes(key) ? [key] : [])],
      env: source.env[key] === undefined ? {} : { [key]: source.env[key] },
      envFiles: source.envFiles[key] === undefined ? {} : { [key]: source.envFiles[key] },
      parser: "room-jsonl", verifyCommit: false, models: structuredClone(source.models),
      modelArgs: ["--model", "{model}"], effortArgs: source.effortArgs.length ? ["--effort", "{effort}"] : [],
      maxIdleTimeoutMs: Math.min(source.maxIdleTimeoutMs, 120_000), maxTotalTimeoutMs: Math.min(source.maxTotalTimeoutMs, 120_000),
    };
    return { profile, sourceDefaultModel };
  } catch {
    // Capability absence is explicit to callers. No source paths, credentials,
    // provider response, or prompt content are included in health/error output.
    return null;
  }
}
