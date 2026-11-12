import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SqliteDatabase } from "@room/db";
import type { PacksService } from "./packs";
import type { SettingsStore } from "./settings";
import { bundledTtsConfig, findTtsBundle } from "./tts-paths";
import { loadTtsConfigFile, TtsRunner } from "./tts";

/**
 * 无界面自检 / 修复入口（验收和排障用，不弹窗、不依赖 UI）：
 *
 *   app.exe --self-test                    打印 JSON 报告：数据目录、包状态、TTS 包、节点 token + /v1/health
 *   app.exe --import-local-token <id> [url] 从 AgentRoom 的 token 文件导入本机节点 token（main 里加密）
 *
 * 走的是和界面完全一样的主进程逻辑；测试不再需要外部 UI 或手动点按钮。
 */
export interface CliDeps {
  db: SqliteDatabase;
  settings: SettingsStore;
  packs: PacksService;
  userData: string;
  localAppData: string | undefined;
  installDir: string;
  resourcesPath: string;
  execPath: string;
}

const LOCAL_NODE_IDS = ["controller-local", "controller-local-codex"] as const;

export async function runCliIfRequested(deps: CliDeps): Promise<number | null> {
  const argv = process.argv;
  const importAt = argv.indexOf("--import-local-token");
  if (importAt >= 0) {
    const id = argv[importAt + 1];
    const baseUrlArg = argv[importAt + 2];
    if (id === undefined) {
      console.log(JSON.stringify({ ok: false, error: "用法：--import-local-token <nodeId> [baseUrl]" }));
      return 2;
    }
    const row = deps.db.prepare("SELECT base_url FROM nodes WHERE id = ?").get(id) as { base_url: string } | undefined;
    const baseUrl = baseUrlArg ?? row?.base_url ?? null;
    const file = deps.settings.getLocalTokenFile(id as never);
    if (file === null) {
      console.log(JSON.stringify({ ok: false, id, error: "没有配置 token 文件路径（localAgentServerTokenFiles / agentRoom）" }));
      return 1;
    }
    if (!existsSync(file)) {
      console.log(JSON.stringify({ ok: false, id, file, error: "token 文件不存在" }));
      return 1;
    }
    const token = readFileSync(file, "utf8").trim();
    if (!/^[0-9a-f]{64}$/i.test(token) || baseUrl === null) {
      console.log(JSON.stringify({ ok: false, id, file, baseUrl, error: "token 格式不对或没有节点地址" }));
      return 1;
    }
    deps.settings.upsertNode(id, { baseUrl, token });
    console.log(JSON.stringify({ ok: true, id, baseUrl, file, tokenSet: true }));
    return 0;
  }

  if (argv.includes("--set-voice")) {
    const agentId = argv[argv.indexOf("--set-voice") + 1];
    const voiceId = argv[argv.indexOf("--set-voice") + 2];
    const configured = loadTtsConfigFile(join(deps.userData, "tts.json"));
    const voice = configured?.voices.find((item) => item.id === voiceId) ?? null;
    if (agentId === undefined || voice === undefined || voice === null) {
      console.log(JSON.stringify({ ok: false, error: "用法：--set-voice <agentId> <voiceId>；voiceId 必须在 tts.json 里" }));
      return 2;
    }
    const changed = deps.db.prepare("UPDATE agents SET voice = ? WHERE id = ?").run(JSON.stringify({ voiceId: voice.id, speed: 1 }), agentId).changes;
    console.log(JSON.stringify({ ok: changed > 0, agent: agentId, voice: voice.id, changed }));
    return 0;
  }

  if (argv.includes("--tts-test")) {
    const text = argv[argv.indexOf("--tts-test") + 1] ?? "你好，我是汐。这是一段语音测试。";
    const configured = loadTtsConfigFile(join(deps.userData, "tts.json"));
    const bundle = findTtsBundle({ execPath: deps.execPath, resourcesPath: deps.resourcesPath, localAppData: deps.localAppData });
    const bundled = bundle.bundle === null ? null : bundledTtsConfig(bundle.bundle, configured?.voices);
    const config = bundled ?? (configured !== null && existsSync(configured.python) && existsSync(configured.script) ? configured : null);
    if (config === null || config.voices.length === 0) {
      console.log(JSON.stringify({ ok: false, error: "没有可用的语音配置或音色", bundle: bundle.reason }));
      return 1;
    }
    const voiceId = argv.includes("--voice") ? argv[argv.indexOf("--voice") + 1] : config.voices[0]!.id;
    const voice = config.voices.find((item) => item.id === voiceId);
    if (voice === undefined) {
      console.log(JSON.stringify({ ok: false, error: "音色不存在：" + voiceId, voices: config.voices.map((item) => item.id) }));
      return 1;
    }
    try {
      const started = Date.now();
      const result = await new TtsRunner({ ...config, tempDir: join(deps.userData, "tmp") }).synthesize({ text, voice, speed: 1, signal: AbortSignal.timeout(600000) });
      const wav = Buffer.from(result.bytes);
      const out = join(deps.userData, "tts-test.wav");
      // eslint 风格：直接写文件，CLI 只用于排障
      writeFileSync(out, wav);
      console.log(JSON.stringify({ ok: true, voice: voice.id, bytes: wav.length, durationMs: Date.now() - started, file: out }));
      return 0;
    } catch (error) {
      console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
      return 1;
    }
  }

  if (!argv.includes("--self-test")) return null;

  const packs = deps.packs.list().map((pack) => ({
    id: pack.id,
    state: pack.state,
    version: pack.version,
    expectedVersion: pack.expectedVersion,
    path: pack.path,
    missing: pack.missing,
  }));
  const bundle = findTtsBundle({ execPath: deps.execPath, resourcesPath: deps.resourcesPath, localAppData: deps.localAppData });
  const nodes: unknown[] = [];
  for (const id of LOCAL_NODE_IDS) {
    const row = deps.db.prepare("SELECT base_url FROM nodes WHERE id = ?").get(id) as { base_url: string } | undefined;
    const node = deps.settings.getNode(id);
    const baseUrl = row?.base_url ?? node?.baseUrl ?? null;
    let health: unknown = null;
    if (node !== null && baseUrl !== null) {
      try {
        const response = await fetch(baseUrl + "/v1/health", {
          headers: { Authorization: "Bearer " + node.token },
          signal: AbortSignal.timeout(5000),
        });
        health = { status: response.status, body: response.ok ? await response.json() : null };
      } catch (error) {
        health = { error: error instanceof Error ? error.message : String(error) };
      }
    }
    nodes.push({ id, baseUrl, tokenSet: node !== null, health });
  }
  const runtime = packs.find((pack) => pack.id === "tts-runtime");
  const model = packs.find((pack) => pack.id === "tts-model");
  const chatNode = nodes.find((node) => (node as { id: string }).id === "controller-local") as
    | { health: { status?: number; body?: { profiles?: string[] } } | null }
    | undefined;
  const chatOk = chatNode?.health?.status === 200 && (chatNode.health.body?.profiles ?? []).includes("deepseek-chat");
  const ok = runtime?.state === "installed" && model?.state === "installed" && bundle.bundle !== null && chatOk;
  console.log(
    JSON.stringify(
      {
        ok,
        userData: deps.userData,
        packs,
        ttsBundle: bundle.bundle === null ? { available: false, reason: bundle.reason } : { available: true, baseDir: bundle.bundle.baseDir, runtime: bundle.bundle.runtimeVersion, model: bundle.bundle.modelVersion },
        nodes,
      },
      null,
      2,
    ),
  );
  return ok ? 0 : 1;
}
