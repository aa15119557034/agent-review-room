import type { RunRow, SqliteDatabase } from "@room/db";
import { testReviewerNode } from "@room/remote-client";
import type { CommandRequest, NodeInfo, NodeTestResult } from "@room/schemas";
import type { Repository } from "./repository";
import { LEGACY_NODE_ID, type SettingsStore } from "./settings";

/**
 * 节点相关（ADR-002 / D-22c）：node.upsert / node.test / nodes.list，以及 Run 该连哪个节点。
 *
 * Token 的边界：
 * - 只在 main 里解密使用（settings.getNode），**绝不**返回给 renderer、不写日志、不进 SQLite
 * - 查询只暴露 tokenConfigured
 */

export type NodeProbe = (params: {
  baseUrl: string;
  token: string;
  profileId: string;
  timeoutMs?: number;
}) => Promise<NodeTestResult>;

export interface NodeServiceDeps {
  readonly repo: Repository;
  readonly settings: SettingsStore;
  /** 测试注入；默认真的打节点 */
  readonly probe?: NodeProbe;
}

export class NodeService {
  readonly #deps: NodeServiceDeps;

  constructor(deps: NodeServiceDeps) {
    this.#deps = deps;
  }

  list(): NodeInfo[] {
    return this.#deps.repo
      .listNodeRows()
      // nodes.base_url 历史上允许为空；契约要求 NodeInfo.baseUrl 是合法 URL，没有地址的节点不算「节点」
      .filter((row): row is { id: string; display_name: string; base_url: string } => row.base_url !== null)
      .map((row) => ({
        id: row.id,
        label: row.display_name,
        baseUrl: row.base_url,
        tokenConfigured: this.#deps.settings.hasNodeToken(row.id, row.base_url),
      }));
  }

  /** 保存节点地址；token 不传表示保留原来的（只写不读） */
  async upsert(command: CommandRequest<"node.upsert">): Promise<NodeInfo> {
    await this.#deps.repo.upsertNodeRow({ id: command.id, label: command.label, baseUrl: command.baseUrl });
    this.#deps.settings.upsertNode(command.id, { baseUrl: command.baseUrl, token: command.token });
    const saved = this.list().find((node) => node.id === command.id);
    if (saved === undefined) throw new Error("node " + command.id + " was not saved");
    return saved;
  }

  /**
   * 测试连接（不保存）。token 规则同 settings.testReviewerNode：
   * 不传 token 时，只有 baseUrl 与这个节点已保存的完全相同才用已保存的 token。
   */
  async test(command: CommandRequest<"node.test">): Promise<NodeTestResult> {
    const saved = this.#deps.settings.getNode(command.id);
    const sameTarget = saved !== null && saved.baseUrl === command.baseUrl;
    const token = command.token ?? (sameTarget ? saved.token : null);
    if (token === null) {
      return {
        reachable: false,
        error: "no_token",
        message: sameTarget ? "还没有填写 Token" : "地址变了，请重新输入 Token",
      };
    }
    const probe = this.#deps.probe ?? testReviewerNode;
    return probe({ baseUrl: command.baseUrl, token, profileId: command.profileId, timeoutMs: 5_000 });
  }
}

/**
 * 启动时把旧设置里的 Reviewer 节点变成 user-pc：
 * settings 里补一条节点凭据，DB 里补一行 nodes（已有就不动，幂等）。
 */
export function migrateLegacyReviewerNode(db: SqliteDatabase, settings: SettingsStore): void {
  settings.migrateLegacyReviewerNode();
  const legacy = settings.get();
  if (legacy === null) return;
  if (db.prepare("SELECT 1 FROM nodes WHERE id = ?").get(LEGACY_NODE_ID) !== undefined) return;
  db.prepare("INSERT INTO nodes (id, display_name, base_url, created_at) VALUES (?, ?, ?, ?)").run(
    LEGACY_NODE_ID,
    "你的电脑",
    legacy.baseUrl,
    new Date().toISOString(),
  );
}

export interface RunTarget {
  nodeId: string;
  baseUrl: string;
  token: string;
  profileId: string;
}

/**
 * 这个 Run 该连哪个节点：**agent → node → 地址与 Token**。
 *
 * - 讨论室的 Run 有 Turn，Turn 的 agent 决定节点与 profile
 * - Phase 0 的评审 Run 没有 Turn，沿用原来的 Reviewer 设置（单次评审照常能用）
 */
export function resolveRunTarget(
  db: SqliteDatabase,
  settings: SettingsStore,
  run: RunRow,
): RunTarget {
  const agent = db
    .prepare(
      "SELECT a.id AS agent, a.node_id AS node_id, a.profile_id AS profile_id " +
        "FROM turns t JOIN agents a ON a.id = t.agent WHERE t.run_id = ?",
    )
    .get(run.id) as { agent: string; node_id: string | null; profile_id: string | null } | undefined;

  if (agent !== undefined) {
    if (agent.node_id === null || agent.profile_id === null) {
      throw new Error("参与者 " + agent.agent + " 还没有配置节点或 profile");
    }
    const node = db.prepare("SELECT base_url FROM nodes WHERE id = ?").get(agent.node_id) as
      | { base_url: string | null }
      | undefined;
    if (node === undefined || node.base_url === null) {
      throw new Error("节点 " + agent.node_id + " 还没有配置地址");
    }
    const credential = settings.getNode(agent.node_id);
    if (credential === null) {
      throw new Error("节点 " + agent.node_id + " 的 Token 还没有配置");
    }
    return {
      nodeId: agent.node_id,
      baseUrl: credential.baseUrl,
      token: credential.token,
      profileId: agent.profile_id,
    };
  }

  // Phase 0：没有 Turn 的 Run 走原来的 Reviewer 设置
  const reviewer = settings.get();
  const token = settings.getToken();
  if (reviewer === null || token === null) throw new Error("reviewer node is not configured");
  const profileId = run.adapter_id.startsWith("remote:")
    ? run.adapter_id.slice("remote:".length)
    : run.adapter_id;
  return { nodeId: LEGACY_NODE_ID, baseUrl: reviewer.baseUrl, token, profileId };
}
