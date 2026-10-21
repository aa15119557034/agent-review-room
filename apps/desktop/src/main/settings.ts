import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { ReviewerNodeSettings } from "@room/schemas";

/**
 * Reviewer 节点设置（D-07）。
 *
 * 三件事必须成立：
 * 1. **Token 只写不读**：查询只返回 tokenConfigured，永远不把明文回传给 renderer。
 * 2. **Token 不落 SQLite、不进日志**：用 Electron safeStorage 加密后存成 base64 放在设置文件里。
 * 3. safeStorage 不可用（某些 Linux 环境）时**拒绝保存 Token**，不降级成明文。
 */

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export class SettingsError extends Error {
  readonly code: "token_storage_unavailable" | "invalid_settings";
  constructor(code: "token_storage_unavailable" | "invalid_settings", message: string) {
    super(message);
    this.name = "SettingsError";
    this.code = code;
  }
}

interface StoredReviewerNode {
  baseUrl: string;
  profileId: string;
  /** base64(safeStorage 加密后的 token)；null 表示从未配置 */
  tokenCipher: string | null;
}

/** 一个节点在设置文件里的凭据。地址和 Token 一起存，改了地址就要重新填 Token */
interface StoredNode {
  baseUrl: string;
  /** base64(safeStorage 加密后的 token)；null 表示从未配置 */
  tokenCipher: string | null;
}

interface StoredSettings {
  reviewerNode: StoredReviewerNode | null;
  /** 多节点（ADR-002 / D-22c）：按节点 id 存地址与 Token，Token 只写不读 */
  nodes: Record<string, StoredNode>;
}

/** 旧设置里的 Reviewer 节点自动迁移成这个节点 */
export const LEGACY_NODE_ID = "user-pc";
const NODE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface UpdateReviewerNodeInput {
  baseUrl: string;
  profileId: string;
  /** 不传表示保留原来的 token */
  token?: string | undefined;
}

export class SettingsStore {
  readonly #file: string;
  readonly #safeStorage: SafeStorageLike;
  #data: StoredSettings;

  constructor(file: string, safeStorage: SafeStorageLike) {
    this.#file = file;
    this.#safeStorage = safeStorage;
    this.#data = this.#load();
  }

  #load(): StoredSettings {
    if (!existsSync(this.#file)) return { reviewerNode: null, nodes: {} };
    try {
      const parsed = JSON.parse(readFileSync(this.#file, "utf8")) as { reviewerNode?: unknown; nodes?: unknown };
      const reviewerNode = parseReviewerNode(parsed.reviewerNode);
      const nodes = parseNodes(parsed.nodes);

      // 旧设置文件（没有 nodes 字段）：把原来的 Reviewer 节点迁移成 user-pc。
      // 迁移后单次评审照常能用，多节点也有地方放 Token。
      if (parsed.nodes === undefined && reviewerNode !== null && nodes[LEGACY_NODE_ID] === undefined) {
        const migrated: StoredSettings = {
          reviewerNode,
          nodes: { [LEGACY_NODE_ID]: { baseUrl: reviewerNode.baseUrl, tokenCipher: reviewerNode.tokenCipher } },
        };
        this.#data = migrated;
        try {
          this.#save();
        } catch {
          // 只读目录等情况下迁移写不进去，内存里照样可用
        }
        return migrated;
      }

      return { reviewerNode, nodes };
    } catch {
      // 设置文件损坏：当作未配置，不阻止应用启动
      return { reviewerNode: null, nodes: {} };
    }
  }

  #save(): void {
    writeFileSync(this.#file, JSON.stringify(this.#data, null, 2), { mode: 0o600 });
  }

  /** 对外形状：不含 token，只告诉调用方「配没配」。 */
  get(): ReviewerNodeSettings | null {
    const node = this.#data.reviewerNode;
    if (node === null) return null;
    // tokenConfigured 用「能不能解密」判断，否则会出现设置页说已配置、审批时又说未配置
    return { baseUrl: node.baseUrl, profileId: node.profileId, tokenConfigured: this.getToken() !== null };
  }

  /** 只有主进程用：解密后的 token。 */
  getToken(): string | null {
    const cipher = this.#data.reviewerNode?.tokenCipher ?? null;
    if (cipher === null) return null;
    try {
      return this.#safeStorage.decryptString(Buffer.from(cipher, "base64"));
    } catch {
      // 换机器 / 系统凭据损坏：清掉密文，让状态和实际一致，用户重新填一次
      const node = this.#data.reviewerNode;
      if (node !== null) {
        this.#data = { ...this.#data, reviewerNode: { ...node, tokenCipher: null } };
        try {
          this.#save();
        } catch {
          // 只读目录等情况下保存失败，不影响本次返回 null
        }
      }
      return null;
    }
  }

  updateReviewerNode(input: UpdateReviewerNodeInput): ReviewerNodeSettings {
    const previous = this.#data.reviewerNode;
    let tokenCipher = previous?.tokenCipher ?? null;

    if (input.token !== undefined) {
      if (!this.#safeStorage.isEncryptionAvailable()) {
        throw new SettingsError(
          "token_storage_unavailable",
          "系统提供的加密存储不可用，拒绝以明文保存 Token",
        );
      }
      tokenCipher = this.#safeStorage.encryptString(input.token).toString("base64");
    } else if (previous !== null && previous.baseUrl !== input.baseUrl) {
      // 地址变了又没给新 Token：旧 Token 不能跟着新地址走，清掉等用户重填
      tokenCipher = null;
    }

    this.#data = {
      reviewerNode: { baseUrl: input.baseUrl, profileId: input.profileId, tokenCipher },
      // 单次评审的 Reviewer 节点就是 user-pc，两边保持一致
      nodes: { ...this.#data.nodes, [LEGACY_NODE_ID]: { baseUrl: input.baseUrl, tokenCipher } },
    };
    this.#save();

    return { baseUrl: input.baseUrl, profileId: input.profileId, tokenConfigured: tokenCipher !== null };
  }

  // ---------------------------------------------------------------- 多节点（D-22c）

  /**
   * 主进程用：某个节点解密的地址与 Token。
   * 不经过 IPC，也绝不进日志——renderer 只能拿到 `tokenConfigured`。
   */
  getNode(nodeId: string): { baseUrl: string; token: string } | null {
    const node = this.#data.nodes[nodeId];
    if (node === undefined || node.tokenCipher === null) return null;
    try {
      return {
        baseUrl: node.baseUrl,
        token: this.#safeStorage.decryptString(Buffer.from(node.tokenCipher, "base64")),
      };
    } catch {
      // 换机器 / 系统凭据损坏：清掉这一项的密文，让状态和实际一致
      this.#data = {
        ...this.#data,
        nodes: { ...this.#data.nodes, [nodeId]: { ...node, tokenCipher: null } },
      };
      try {
        this.#save();
      } catch {
        // 只读目录等情况下保存失败，不影响本次返回 null
      }
      return null;
    }
  }

  /** 这个节点存了 Token 吗，且地址还是同一个（地址变了就要求重新填） */
  hasNodeToken(nodeId: string, baseUrl: string): boolean {
    const node = this.#data.nodes[nodeId];
    if (node === undefined || node.baseUrl !== baseUrl || node.tokenCipher === null) return false;
    try {
      this.#safeStorage.decryptString(Buffer.from(node.tokenCipher, "base64"));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 保存节点地址。token 不传时：地址没变就保留原来的 Token；
   * **地址变了就清空**（旧 Token 不能跟着新地址走），tokenConfigured 变回 false。
   */
  upsertNode(nodeId: string, input: { baseUrl: string; token?: string | undefined }): void {
    const existing = this.#data.nodes[nodeId];
    let tokenCipher = existing?.tokenCipher ?? null;

    if (input.token !== undefined) {
      if (!this.#safeStorage.isEncryptionAvailable()) {
        throw new SettingsError(
          "token_storage_unavailable",
          "系统提供的加密存储不可用，拒绝以明文保存 Token",
        );
      }
      tokenCipher = this.#safeStorage.encryptString(input.token).toString("base64");
    } else if (existing !== undefined && existing.baseUrl !== input.baseUrl) {
      tokenCipher = null;
    }

    const reviewer = this.#data.reviewerNode;
    this.#data = {
      // user-pc 同时就是单次评审的那个节点：地址与 Token 保持同步
      reviewerNode:
        nodeId === LEGACY_NODE_ID && reviewer !== null ? { ...reviewer, baseUrl: input.baseUrl, tokenCipher } : reviewer,
      nodes: { ...this.#data.nodes, [nodeId]: { baseUrl: input.baseUrl, tokenCipher } },
    };
    this.#save();
  }

  /** 把旧设置里的 Reviewer 节点写成 user-pc（幂等） */
  migrateLegacyReviewerNode(): void {
    const reviewer = this.#data.reviewerNode;
    if (reviewer === null || this.#data.nodes[LEGACY_NODE_ID] !== undefined) return;
    this.#data = {
      ...this.#data,
      nodes: {
        ...this.#data.nodes,
        [LEGACY_NODE_ID]: { baseUrl: reviewer.baseUrl, tokenCipher: reviewer.tokenCipher },
      },
    };
    this.#save();
  }
}

function parseReviewerNode(value: unknown): StoredReviewerNode | null {
  if (value === null || typeof value !== "object") return null;
  const node = value as { baseUrl?: unknown; profileId?: unknown; tokenCipher?: unknown };
  if (typeof node.baseUrl !== "string" || typeof node.profileId !== "string") return null;
  return {
    baseUrl: node.baseUrl,
    profileId: node.profileId,
    tokenCipher: typeof node.tokenCipher === "string" ? node.tokenCipher : null,
  };
}

function parseNodes(value: unknown): Record<string, StoredNode> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const nodes: Record<string, StoredNode> = {};
  for (const [id, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!NODE_ID_PATTERN.test(id)) continue;
    if (entry === null || typeof entry !== "object") continue;
    const node = entry as { baseUrl?: unknown; tokenCipher?: unknown };
    if (typeof node.baseUrl !== "string") continue;
    nodes[id] = {
      baseUrl: node.baseUrl,
      tokenCipher: typeof node.tokenCipher === "string" ? node.tokenCipher : null,
    };
  }
  return nodes;
}
