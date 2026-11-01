import { existsSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { RunRow, SqliteDatabase } from "@room/db";
import { testReviewerNode } from "@room/remote-client";
import {
  BatchModel,
  LOCAL_NODE_IDS,
  NodeToken,
  toRunModel,
  type CommandRequest,
  type LocalNodeId,
  type NodeInfo,
  type NodeTestResult,
  type RunModel,
} from "@room/schemas";
import type { Repository } from "./repository";
import { LEGACY_NODE_ID, type SettingsStore } from "./settings";

/**
 * 节点相关（ADR-002 / D-22c）：node.upsert / node.test / nodes.list，以及 Run 该连哪个节点。
 *
 * Token 的边界：
 * - 只在 main 里解密使用（settings.getNode），**绝不**返回给 renderer、不写日志、不进 SQLite
 * - 查询只暴露 tokenConfigured
 */

/** 业务失败：ipc 里会映射成契约错误码（不是 bug，也不是未预期异常） */
export class NodeServiceError extends Error {
  constructor(
    readonly code: "not_found" | "invalid_state" | "validation_failed" | "internal",
    message: string,
  ) {
    super(message);
    this.name = "NodeServiceError";
  }
}

/** 本机回环地址（ADR-003 §2a / C-44）：只给这三种写法放行 */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

const isLoopback = (baseUrl: string): boolean => {
  try {
    const url = new URL(baseUrl);
    return (url.protocol === "http:" || url.protocol === "https:") && LOOPBACK_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
};

/**
 * 「同一个文件」的判法（C-44）：先 realpath（junction / 符号链接 / `..` 都解析掉），
 * Windows 再按不区分大小写比较；文件还不存在时退回绝对路径比较。
 */
function sameFile(a: string, b: string): boolean {
  const normalize = (path: string): string => {
    let real = path;
    try {
      real = realpathSync.native(path);
    } catch {
      // 文件不存在 / 不可读：按绝对路径比较
    }
    const abs = resolve(real);
    return process.platform === "win32" ? abs.toLowerCase() : abs;
  };
  return normalize(a) === normalize(b);
}

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

  /**
   * C-44 / D-40：从本机读这个节点的 Token 并保存（一键导入）。
   *
   * - 只对 `LOCAL_NODE_IDS` 里的 id（入参 schema 已经卡住）**并且**节点的 baseUrl 是回环地址的节点可用
   * - 路径只来自 main 设置（`localAgentServerTokenFiles` → 旧键 → `<AgentRoom>` 默认），请求里带不了路径
   * - 两个本机节点解析到同一个文件 → invalid_state（同一份 Token 不能给两个节点）
   * - 读到的值按 NodeToken 校验，只进 safeStorage，不回显；错误信息里也不写路径和内容
   * - 不在这里测连接：成功返回后 renderer 自己再调一次 node.test（契约 C-44）
   */
  async importLocalToken(command: CommandRequest<"node.importLocalToken">): Promise<NodeInfo> {
    const id = command.id;
    const row = this.#deps.repo.listNodeRows().find((node) => node.id === id);
    if (row === undefined || row.base_url === null) {
      throw new NodeServiceError("not_found", "节点 " + id + " 还没有添加到节点列表（先在设置里加这个节点的地址）");
    }
    if (!isLoopback(row.base_url)) {
      throw new NodeServiceError("invalid_state", "节点 " + id + " 的地址不是本机回环地址，不能从本机读 Token");
    }

    const file = this.#deps.settings.getLocalTokenFile(id);
    if (file === null) {
      throw new NodeServiceError(
        "not_found",
        "没有配置 " + id + " 的 Token 文件路径（`localAgentServerTokenFiles`），也没有 `agentRoom` 用来推默认位置",
      );
    }
    // 同一份 Token 给了两个节点：两个 id 谁都不许导（契约要求说明是哪两个 id，不写路径）
    for (const other of LOCAL_NODE_IDS) {
      if (other === id) continue;
      const otherFile = this.#deps.settings.getLocalTokenFile(other);
      if (otherFile !== null && sameFile(file, otherFile)) {
        throw new NodeServiceError("invalid_state", other + " 和 " + id + " 指向同一个 Token 文件，不能共用一份 Token");
      }
    }

    if (!existsSync(file)) {
      throw new NodeServiceError("not_found", id + " 的 Token 文件不存在：先在本机节点上生成 Token 再导入");
    }
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "unknown";
      throw new NodeServiceError("internal", "读不了 " + id + " 的 Token 文件（" + code + "）");
    }
    const parsed = NodeToken.safeParse(raw.trim());
    if (!parsed.success) {
      throw new NodeServiceError("validation_failed", id + " 的 Token 文件内容不像是 Token（长度或字符不对）");
    }

    this.#deps.settings.upsertNode(id, { baseUrl: row.base_url, token: parsed.data });
    return { id, label: row.display_name, baseUrl: row.base_url, tokenConfigured: true };
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
  /** C-40：这一项盖章时定下的模型；没有 = 用 profile 自带模型 */
  model?: RunModel;
}

/**
 * C-40：Run 对应的批次项里定下的模型，投影成 StartRun 的 RunModel。
 * 没有 Turn / 没有批次项（Phase 0）或旧批次 model = null → undefined（StartRun 省略 model）。
 */
export function resolveRunModel(db: SqliteDatabase, run: RunRow): RunModel | undefined {
  const row = db.prepare("SELECT model FROM batch_items WHERE approval_id = ?").get(run.approval_id) as
    | { model: string | null }
    | undefined;
  if (row === undefined || row.model === null) return undefined;
  return toRunModel(BatchModel.parse(JSON.parse(row.model)));
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
  // 先看有没有 Turn：有 Turn 的 Run 一定是讨论室的，必须按 agent -> node 走，
  // 不能因为查不到 agent 就悄悄回落到 Phase 0 的 Reviewer 设置
  const turn = db.prepare("SELECT agent FROM turns WHERE run_id = ?").get(run.id) as { agent: string } | undefined;

  if (turn !== undefined) {
    const agent = db.prepare("SELECT node_id, profile_id FROM agents WHERE id = ?").get(turn.agent) as
      | { node_id: string | null; profile_id: string | null }
      | undefined;
    if (agent === undefined) {
      throw new Error("参与者 " + turn.agent + " 还没有配置");
    }
    if (agent.node_id === null || agent.profile_id === null) {
      throw new Error("参与者 " + turn.agent + " 还没有配置节点或 profile");
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
    if (credential.baseUrl !== node.base_url) {
      throw new Error("节点 " + agent.node_id + " 的地址和保存的 Token 不一致，请重新配置这个节点");
    }
    const model = resolveRunModel(db, run);
    return {
      nodeId: agent.node_id,
      baseUrl: credential.baseUrl,
      token: credential.token,
      profileId: agent.profile_id,
      ...(model === undefined ? {} : { model }),
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
