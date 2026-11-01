import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { openDatabase, WriteQueue } from "@room/db";
import { LOCAL_NODE_ID, LOCAL_CODEX_NODE_ID } from "@room/schemas";
import { NodeService, NodeServiceError } from "../src/main/nodes";
import { Repository } from "../src/main/repository";
import { SettingsStore, type SafeStorageLike } from "../src/main/settings";

/**
 * C-44 / D-40：`node.importLocalToken`。
 * - 只认本机节点白名单 + 回环地址；路径只来自 main 设置（`localAgentServerTokenFiles` / 旧键 / `agentRoom` 默认）
 * - 两个 id 指向同一个文件 → invalid_state
 * - Token 只进 safeStorage：返回给 renderer 的只有 tokenConfigured，设置文件里不是明文
 */

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // Windows 句柄延迟
    }
  }
});

const TOKEN = "tok_" + "a".repeat(36);
const TOKEN2 = "tok_" + "b".repeat(36);

const fakeSafeStorage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from("enc:" + plain, "utf8"),
  decryptString: (enc) => {
    const text = enc.toString("utf8");
    if (!text.startsWith("enc:")) throw new Error("bad cipher");
    return text.slice(4);
  },
};

interface Env {
  dir: string;
  settingsFile: string;
  settings: SettingsStore;
  nodes: NodeService;
  db: ReturnType<typeof openDatabase>;
  repo: Repository;
}

function makeEnv(options: { settings?: Record<string, unknown> } = {}): Env {
  const dir = mkdtempSync(join(tmpdir(), "room-local-token-"));
  dirs.push(dir);
  const settingsFile = join(dir, "settings.json");
  if (options.settings !== undefined) writeFileSync(settingsFile, JSON.stringify(options.settings), "utf8");
  const db = openDatabase(join(dir, "test.db"));
  const queue = new WriteQueue();
  const repo = new Repository(db, queue);
  const settings = new SettingsStore(settingsFile, fakeSafeStorage);
  const nodes = new NodeService({ repo, settings });
  return { dir, settingsFile, settings, nodes, db, repo };
}

async function seedNodes(env: Env, options: { controllerUrl?: string; codexUrl?: string | null } = {}): Promise<void> {
  await env.repo.upsertNodeRow({ id: LOCAL_NODE_ID, label: "主控机", baseUrl: options.controllerUrl ?? "http://127.0.0.1:7420" });
  if (options.codexUrl !== null) {
    await env.repo.upsertNodeRow({ id: LOCAL_CODEX_NODE_ID, label: "主控机（林离）", baseUrl: options.codexUrl ?? "http://127.0.0.1:7421" });
  }
}

function writeToken(dir: string, name: string, text = TOKEN): string {
  const file = join(dir, name);
  writeFileSync(file, text + "\n", "utf8");
  return file;
}

const expectCode = async (run: () => Promise<unknown>, code: NodeServiceError["code"]): Promise<string> => {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof NodeServiceError, "应该是 NodeServiceError：" + String(error));
    assert.equal(error.code, code);
    return error.message;
  }
  assert.fail("应该失败（" + code + "）");
};

describe("node.importLocalToken (C-44)", () => {
  it("imports the codex node token from its own file and only exposes tokenConfigured", async () => {
    const env = makeEnv();
    await seedNodes(env);
    const file = writeToken(env.dir, "codex.token");
    env.settings.setLocalTokenFile(LOCAL_CODEX_NODE_ID, file);

    const info = await env.nodes.importLocalToken({ type: "node.importLocalToken", id: LOCAL_CODEX_NODE_ID });
    assert.deepEqual(info, {
      id: LOCAL_CODEX_NODE_ID,
      label: "主控机（林离）",
      baseUrl: "http://127.0.0.1:7421",
      tokenConfigured: true,
    });
    assert.equal(JSON.stringify(info).includes(TOKEN), false, "Token 不能回显");
    assert.equal(env.settings.getNode(LOCAL_CODEX_NODE_ID)?.token, TOKEN);
    // 设置文件里是密文，不是明文；也没有路径以外的渲染通道
    assert.equal(readFileSync(env.settingsFile, "utf8").includes(TOKEN), false);
  });

  it("rejects nodes that are not in the local list, and nodes that are not loopback", async () => {
    const missing = makeEnv();
    await expectCode(
      () => missing.nodes.importLocalToken({ type: "node.importLocalToken", id: LOCAL_CODEX_NODE_ID }),
      "not_found",
    );

    const remote = makeEnv();
    await seedNodes(remote, { codexUrl: "http://192.168.0.9:7421" });
    remote.settings.setLocalTokenFile(LOCAL_CODEX_NODE_ID, writeToken(remote.dir, "codex.token"));
    const message = await expectCode(
      () => remote.nodes.importLocalToken({ type: "node.importLocalToken", id: LOCAL_CODEX_NODE_ID }),
      "invalid_state",
    );
    assert.match(message, /回环/);
  });

  it("uses `<AgentRoom>\\node\\codex\\agent-server.token` when only agentRoom is configured", async () => {
    const env = makeEnv({ settings: { agentRoom: join(tmpdir(), "does-not-exist-agentroom") } });
    await seedNodes(env);
    assert.equal(
      env.settings.getLocalTokenFile(LOCAL_CODEX_NODE_ID),
      join(tmpdir(), "does-not-exist-agentroom", "node", "codex", "agent-server.token"),
    );
    // 默认路径下没有文件：报 not_found，不是 internal
    await expectCode(
      () => env.nodes.importLocalToken({ type: "node.importLocalToken", id: LOCAL_CODEX_NODE_ID }),
      "not_found",
    );
    assert.equal(
      env.settings.getLocalTokenFile(LOCAL_NODE_ID),
      join(tmpdir(), "does-not-exist-agentroom", "node", "deepseek", "agent-server.token"),
    );
  });

  it("refuses when both local nodes resolve to the same file (also through `..`)", async () => {
    const env = makeEnv();
    await seedNodes(env);
    const sub = join(env.dir, "node", "codex");
    mkdirSync(sub, { recursive: true });
    const file = writeToken(sub, "agent-server.token");
    env.settings.setLocalTokenFile(LOCAL_NODE_ID, join(sub, "..", "codex", "agent-server.token"));
    env.settings.setLocalTokenFile(LOCAL_CODEX_NODE_ID, file);

    for (const id of [LOCAL_NODE_ID, LOCAL_CODEX_NODE_ID] as const) {
      const message = await expectCode(() => env.nodes.importLocalToken({ type: "node.importLocalToken", id }), "invalid_state");
      assert.match(message, /同一个 Token 文件/);
      assert.match(message, id === LOCAL_NODE_ID ? /controller-local-codex/ : /controller-local/);
    }
    assert.equal(env.settings.getNode(LOCAL_CODEX_NODE_ID), null, "被拒时不能写进任何槽位");
  });

  it("reports missing / unreadable / invalid token files with the right codes", async () => {
    const env = makeEnv();
    await seedNodes(env);
    env.settings.setLocalTokenFile(LOCAL_CODEX_NODE_ID, join(env.dir, "nope.token"));
    await expectCode(() => env.nodes.importLocalToken({ type: "node.importLocalToken", id: LOCAL_CODEX_NODE_ID }), "not_found");

    // 目录当文件读：ReadFileSync 抛 EISDIR → internal
    const asDir = join(env.dir, "dir.token");
    mkdirSync(asDir, { recursive: true });
    env.settings.setLocalTokenFile(LOCAL_CODEX_NODE_ID, asDir);
    const internal = await expectCode(
      () => env.nodes.importLocalToken({ type: "node.importLocalToken", id: LOCAL_CODEX_NODE_ID }),
      "internal",
    );
    assert.equal(internal.includes(asDir), false, "错误信息里不写路径");

    env.settings.setLocalTokenFile(LOCAL_CODEX_NODE_ID, writeToken(env.dir, "short.token", "too-short"));
    await expectCode(() => env.nodes.importLocalToken({ type: "node.importLocalToken", id: LOCAL_CODEX_NODE_ID }), "validation_failed");
  });

  it("reads the legacy single-path setting only for controller-local and migrates it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "room-local-token-"));
    dirs.push(dir);
    const legacyFile = writeToken(dir, "legacy.token", TOKEN2);
    const settingsFile = join(dir, "settings.json");
    writeFileSync(settingsFile, JSON.stringify({ localAgentServerTokenFile: legacyFile }), "utf8");
    const db = openDatabase(join(dir, "test.db"));
    const repo = new Repository(db, new WriteQueue());
    await repo.upsertNodeRow({ id: LOCAL_NODE_ID, label: "主控机", baseUrl: "http://127.0.0.1:7420" });
    const settings = new SettingsStore(settingsFile, fakeSafeStorage);
    const nodes = new NodeService({ repo, settings });

    assert.equal(settings.getLocalTokenFile(LOCAL_CODEX_NODE_ID), null, "旧键不能给 codex 节点用");
    const info = await nodes.importLocalToken({ type: "node.importLocalToken", id: LOCAL_NODE_ID });
    assert.equal(info.tokenConfigured, true);
    assert.equal(settings.getNode(LOCAL_NODE_ID)?.token, TOKEN2);
    const saved = JSON.parse(readFileSync(settingsFile, "utf8")) as { localAgentServerTokenFiles?: Record<string, string> };
    assert.equal(saved.localAgentServerTokenFiles?.[LOCAL_NODE_ID], legacyFile, "读到时应该写进新表");
  });

  it("keeps address and token paired after import (agent -> node -> address)", async () => {
    const env = makeEnv();
    await seedNodes(env);
    env.settings.setLocalTokenFile(LOCAL_CODEX_NODE_ID, writeToken(env.dir, "codex.token"));
    await env.nodes.importLocalToken({ type: "node.importLocalToken", id: LOCAL_CODEX_NODE_ID });

    assert.deepEqual(env.settings.getNode(LOCAL_CODEX_NODE_ID), { baseUrl: "http://127.0.0.1:7421", token: TOKEN });
    // 另一个节点不会被顺带写上
    assert.equal(env.settings.getNode(LOCAL_NODE_ID), null);
  });
});
