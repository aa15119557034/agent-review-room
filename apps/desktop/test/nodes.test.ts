import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { approveAndCreateRun, openDatabase, ulid, WriteQueue } from "@room/db";
import type { NodeHealth, NodeTestResult } from "@room/schemas";
import { migrateLegacyReviewerNode, NodeService, resolveRunTarget } from "../src/main/nodes";
import { Repository } from "../src/main/repository";
import { SettingsStore, type SafeStorageLike } from "../src/main/settings";

/**
 * D-22c：多节点。
 * - 每个节点的 Token 用 safeStorage 加密存在设置文件里（只写不读，不进 renderer / 日志 / SQLite）
 * - 旧设置里的 Reviewer 节点自动迁移成 user-pc
 * - adapterFactory(run) 用 agent -> node 找地址与 Token；Phase 0 的 Run 走原来的设置
 */

const dirs: string[] = [];
after(() => {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // Windows 句柄延迟
    }
  }
});

const TOKEN = "t".repeat(40);
const NODE_URL = "http://127.0.0.1:7421";
const LEGACY_URL = "http://127.0.0.1:7420";

const fakeSafeStorage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from("enc:" + plain, "utf8"),
  decryptString: (enc) => enc.toString("utf8").slice(4),
};

interface Env {
  file: string;
  db: ReturnType<typeof openDatabase>;
  queue: WriteQueue;
  repo: Repository;
  settings: SettingsStore;
}

function makeEnv(): Env {
  const dir = mkdtempSync(join(tmpdir(), "room-nodes-"));
  dirs.push(dir);
  const file = join(dir, "settings.json");
  const db = openDatabase(join(dir, "test.db"));
  const queue = new WriteQueue();
  return { file, db, queue, repo: new Repository(db, queue), settings: new SettingsStore(file, fakeSafeStorage) };
}

const health = (nodeId: string, profiles: string[]): NodeHealth => ({
  protocol: 1,
  nodeId,
  profiles,
  activeRuns: 0,
  maxConcurrentRuns: 2,
  leaseMs: 20_000,
  heartbeatMs: 5_000,
});

describe("旧设置迁移成 user-pc", () => {
  it("设置文件里的 Reviewer 节点迁移成 user-pc，Token 仍能解密使用", () => {
    const dir = mkdtempSync(join(tmpdir(), "room-nodes-legacy-"));
    dirs.push(dir);
    const file = join(dir, "settings.json");
    writeFileSync(
      file,
      JSON.stringify({
        reviewerNode: {
          baseUrl: LEGACY_URL,
          profileId: "claude-review",
          tokenCipher: fakeSafeStorage.encryptString(TOKEN).toString("base64"),
        },
      }),
    );

    const settings = new SettingsStore(file, fakeSafeStorage);
    assert.deepEqual(settings.getNode("user-pc"), { baseUrl: LEGACY_URL, token: TOKEN });

    // 迁移结果写回文件（下次启动不用再算）
    const persisted = JSON.parse(readFileSync(file, "utf8")) as { nodes?: Record<string, unknown> };
    assert.deepEqual(Object.keys(persisted.nodes ?? {}), ["user-pc"]);
    assert.equal(readFileSync(file, "utf8").includes(TOKEN), false, "明文 Token 不能出现在设置文件里");
  });

  it("DB 里补一行 user-pc 节点，幂等；单次评审的设置还在", () => {
    const env = makeEnv();
    env.settings.updateReviewerNode({ baseUrl: LEGACY_URL, profileId: "claude-review", token: TOKEN });

    migrateLegacyReviewerNode(env.db, env.settings);
    migrateLegacyReviewerNode(env.db, env.settings);

    const rows = env.db.prepare("SELECT id, display_name, base_url FROM nodes").all() as {
      id: string;
      display_name: string;
      base_url: string;
    }[];
    assert.deepEqual(rows, [{ id: "user-pc", display_name: "你的电脑", base_url: LEGACY_URL }]);
    assert.equal(env.settings.get()?.profileId, "claude-review", "Phase 0 的 Reviewer 设置原样保留");
    assert.equal(env.settings.getToken(), TOKEN);
    env.db.close();
  });
});

describe("node.upsert / nodes.list / node.test", () => {
  it("保存节点：Token 加密存储，查询只返回 tokenConfigured", async () => {
    const env = makeEnv();
    const service = new NodeService({
      repo: env.repo,
      settings: env.settings,
      probe: async () => ({ reachable: false, error: "unreachable", message: "not used" }),
    });

    const saved = await service.upsert({
      type: "node.upsert",
      id: "controller-local",
      label: "主控机",
      baseUrl: NODE_URL,
      token: TOKEN,
    });

    assert.deepEqual(saved, { id: "controller-local", label: "主控机", baseUrl: NODE_URL, tokenConfigured: true });
    assert.equal(JSON.stringify(saved).includes(TOKEN), false, "查询结果里不能有 Token");
    assert.equal(readFileSync(env.file, "utf8").includes(TOKEN), false, "设置文件里只能有密文");

    const listed = service.list();
    assert.deepEqual(listed, [saved]);
    assert.equal(JSON.stringify(listed).includes(TOKEN), false);
    env.db.close();
  });

  it("node.test：地址没变时复用已保存的 Token；地址变了要求重新输入", async () => {
    const env = makeEnv();
    let seen: { baseUrl: string; token: string; profileId: string } | null = null;
    const service = new NodeService({
      repo: env.repo,
      settings: env.settings,
      probe: async (params): Promise<NodeTestResult> => {
        seen = params;
        return {
          reachable: true,
          health: health("controller-local", ["deepseek-discuss"]),
          profileAvailable: true,
          latencyMs: 3,
        };
      },
    });
    await service.upsert({ type: "node.upsert", id: "controller-local", label: "主控机", baseUrl: NODE_URL, token: TOKEN });

    const same = await service.test({
      type: "node.test",
      id: "controller-local",
      baseUrl: NODE_URL,
      profileId: "deepseek-discuss",
    });
    assert.equal(same.reachable, true);
    assert.equal(seen?.token, TOKEN);

    seen = null;
    const changed = await service.test({
      type: "node.test",
      id: "controller-local",
      baseUrl: "http://127.0.0.1:9999",
      profileId: "deepseek-discuss",
    });
    assert.equal(changed.reachable, false);
    assert.equal(changed.reachable === false ? changed.error : null, "no_token");
    assert.equal(seen, null, "地址变了就不能把旧 Token 发过去");
    env.db.close();
  });
});

describe("resolveRunTarget：Run 该连哪个节点", () => {
  async function seedRun(env: Env, adapterId: string, options: { withTurn: boolean; saveToken: boolean }) {
    const now = new Date().toISOString();
    env.db
      .prepare("INSERT INTO nodes (id, display_name, base_url, created_at) VALUES (?, ?, ?, ?)")
      .run("controller-local", "主控机", NODE_URL, now);
    env.db
      .prepare(
        "INSERT INTO agents (id, display_name, color, role_note, can_discuss, can_summarize, node_id, profile_id, created_at, updated_at) " +
          "VALUES ('deepseek', 'DeepSeek', '#2f5aa0', '', 1, 0, 'controller-local', 'deepseek-discuss', ?, ?)",
      )
      .run(now, now);
    if (options.saveToken) env.settings.upsertNode("controller-local", { baseUrl: NODE_URL, token: TOKEN });
    env.settings.updateReviewerNode({ baseUrl: LEGACY_URL, profileId: "claude-review", token: TOKEN });

    const project = await env.repo.createProject("议题");
    const message = await env.repo.addSource(project.id, "deepseek", "abcdef");
    const contribution = await env.repo.createContribution({
      projectId: project.id,
      sourceMessageId: message.id,
      contributionType: "issue",
      title: "t",
      selection: { start: 0, end: 3 },
    });
    const { snapshot, approval } = await env.repo.createSnapshot({
      projectId: project.id,
      contributionIds: [contribution.id],
      taskInstruction: "看着办",
      reviewerAgent: "deepseek",
    });
    const approved = await approveAndCreateRun(env.db, env.queue, {
      approvalId: approval.id,
      expectedSnapshotHash: snapshot.contentHash,
      adapterId,
    });

    if (options.withTurn) {
      const roundId = "rnd_" + ulid();
      const batchId = "bat_" + ulid();
      env.db
        .prepare(
          "INSERT INTO rounds (id, project_id, round_index, state, task, task_source, recipients, history_mode, created_at) " +
            "VALUES (?, ?, 1, 'RUNNING', '本轮任务', 'human', '[\"deepseek\"]', 'recent_with_summaries', ?)",
        )
        .run(roundId, project.id, now);
      env.db
        .prepare(
          "INSERT INTO batches (id, project_id, round_id, kind, state, created_at) VALUES (?, ?, ?, 'initial', 'APPROVED', ?)",
        )
        .run(batchId, project.id, roundId, now);
      env.db
        .prepare(
          "INSERT INTO turns (id, round_id, batch_id, agent, is_summary, approval_id, run_id, outcome, created_at) " +
            "VALUES (?, ?, ?, 'deepseek', 0, ?, ?, 'running', ?)",
        )
        .run("turn_" + ulid(), roundId, batchId, approved.run.approval_id, approved.run.id, now);
    }

    return approved.run;
  }

  it("讨论室的 Run：按 agent -> node 取地址、Token、profile", async () => {
    const env = makeEnv();
    const run = await seedRun(env, "remote:deepseek-discuss", { withTurn: true, saveToken: true });

    assert.deepEqual(resolveRunTarget(env.db, env.settings, run), {
      nodeId: "controller-local",
      baseUrl: NODE_URL,
      token: TOKEN,
      profileId: "deepseek-discuss",
    });
    env.db.close();
  });

  it("没有 Turn 的 Phase 0 Run：沿用原来的 Reviewer 设置", async () => {
    const env = makeEnv();
    const run = await seedRun(env, "claude-review", { withTurn: false, saveToken: true });

    assert.deepEqual(resolveRunTarget(env.db, env.settings, run), {
      nodeId: "user-pc",
      baseUrl: LEGACY_URL,
      token: TOKEN,
      profileId: "claude-review",
    });
    env.db.close();
  });

  it("节点没存 Token 时直接报错，不悄悄连别的节点", async () => {
    const env = makeEnv();
    const run = await seedRun(env, "remote:deepseek-discuss", { withTurn: true, saveToken: false });

    assert.throws(() => resolveRunTarget(env.db, env.settings, run), /Token/);
    env.db.close();
  });
});
