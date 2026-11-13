import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SqliteDatabase } from "@room/db";
import type { NodeService } from "./nodes";
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
  nodes: NodeService;
  userData: string;
  localAppData: string | undefined;
  installDir: string;
  resourcesPath: string;
  execPath: string;
}

const LOCAL_NODE_IDS = ["controller-local", "controller-local-codex"] as const;

/**
 * 自检的结论：只把「已经配置了但坏了」算失败。
 * - 包：incomplete / version_mismatch 算坏；missing 不算
 * - 所有已知包都 installed 但 TTS bundle 找不到 → 算坏（配置说装好了，实际用不了）
 * - 节点：有密文但解不开算坏；配了 Token 但 health 不是 200 算坏；controller-local 还要有 deepseek-chat
 */
/** peekNode 的结果 → 自检报告里的节点条目（单独抽出来测空配置） */
export function nodeEntry(
  id: string,
  baseUrl: string | null,
  peek: { token: string | null; undecryptable: boolean } | null,
): { id: string; baseUrl: string | null; tokenSet: boolean; undecryptable: boolean; health: null } {
  return {
    id,
    baseUrl,
    tokenSet: peek !== null && (peek.token !== null || peek.undecryptable),
    undecryptable: peek?.undecryptable === true,
    health: null,
  };
}

export function selfTestOk(
  packs: { id: string; state: string }[],
  nodes: { id: string; tokenSet: boolean; undecryptable: boolean; health: { status?: number; body?: { profiles?: string[] } } | null }[],
  bundleAvailable: boolean,
): boolean {
  const packsBroken = packs.some((pack) => pack.state === "incomplete" || pack.state === "version_mismatch");
  const allInstalled = packs.length > 0 && packs.every((pack) => pack.state === "installed");
  const bundleBroken = allInstalled && !bundleAvailable;
  const nodesBroken = nodes.some((node) => {
    if (node.undecryptable) return true;
    if (!node.tokenSet) return false;
    if (node.health?.status !== 200) return true;
    if (node.id === "controller-local" && !(node.health.body?.profiles ?? []).includes("deepseek-chat")) return true;
    return false;
  });
  return !packsBroken && !bundleBroken && !nodesBroken;
}

export async function runCliIfRequested(deps: CliDeps): Promise<number | null> {
  const argv = process.argv;
  const importAt = argv.indexOf("--import-local-token");
  if (importAt >= 0) {
    const id = argv[importAt + 1];
    if (id !== "controller-local" && id !== "controller-local-codex") {
      console.log(JSON.stringify({ ok: false, error: "只有 controller-local / controller-local-codex 能导入本机 Token" }));
      return 2;
    }
    try {
      const node = await deps.nodes.importLocalToken({ type: "node.importLocalToken", id });
      console.log(JSON.stringify({ ok: true, id, baseUrl: node.baseUrl, tokenSet: true }));
      return 0;
    } catch (error) {
      console.log(JSON.stringify({ ok: false, id, error: error instanceof Error ? error.message : String(error) }));
      return 1;
    }
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
    return changed > 0 ? 0 : 1;
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
  const nodes: { id: string; baseUrl: string | null; tokenSet: boolean; undecryptable: boolean; health: unknown }[] = [];
  for (const id of LOCAL_NODE_IDS) {
    const row = deps.db.prepare("SELECT base_url FROM nodes WHERE id = ?").get(id) as { base_url: string } | undefined;
    const node = deps.settings.peekNode(id);
    const baseUrl = row?.base_url ?? node?.baseUrl ?? null;
    let health: unknown = null;
    if (node !== null && node.token !== null && baseUrl !== null) {
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
    nodes.push({ ...nodeEntry(id, baseUrl, node), health });
  }
  const ok = selfTestOk(
    packs.map((pack) => ({ id: pack.id, state: pack.state })),
    nodes as Parameters<typeof selfTestOk>[1],
    bundle.bundle !== null,
  );
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
