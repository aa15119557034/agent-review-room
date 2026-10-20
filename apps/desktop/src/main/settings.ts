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

interface StoredSettings {
  reviewerNode: StoredReviewerNode | null;
}

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
    if (!existsSync(this.#file)) return { reviewerNode: null };
    try {
      const parsed = JSON.parse(readFileSync(this.#file, "utf8")) as Partial<StoredSettings>;
      const node = parsed.reviewerNode;
      if (node === null || node === undefined) return { reviewerNode: null };
      if (typeof node.baseUrl !== "string" || typeof node.profileId !== "string") {
        return { reviewerNode: null };
      }
      return {
        reviewerNode: {
          baseUrl: node.baseUrl,
          profileId: node.profileId,
          tokenCipher: typeof node.tokenCipher === "string" ? node.tokenCipher : null,
        },
      };
    } catch {
      // 设置文件损坏：当作未配置，不阻止应用启动
      return { reviewerNode: null };
    }
  }

  #save(): void {
    writeFileSync(this.#file, JSON.stringify(this.#data, null, 2), { mode: 0o600 });
  }

  /** 对外形状：不含 token，只告诉调用方「配没配」。 */
  get(): ReviewerNodeSettings | null {
    const node = this.#data.reviewerNode;
    if (node === null) return null;
    return { baseUrl: node.baseUrl, profileId: node.profileId, tokenConfigured: node.tokenCipher !== null };
  }

  /** 只有主进程用：解密后的 token。 */
  getToken(): string | null {
    const cipher = this.#data.reviewerNode?.tokenCipher ?? null;
    if (cipher === null) return null;
    try {
      return this.#safeStorage.decryptString(Buffer.from(cipher, "base64"));
    } catch {
      // 换机器 / 系统凭据损坏：当作没有 token，让用户重填，而不是崩掉
      return null;
    }
  }

  updateReviewerNode(input: UpdateReviewerNodeInput): ReviewerNodeSettings {
    let tokenCipher = this.#data.reviewerNode?.tokenCipher ?? null;

    if (input.token !== undefined) {
      if (!this.#safeStorage.isEncryptionAvailable()) {
        throw new SettingsError(
          "token_storage_unavailable",
          "系统提供的加密存储不可用，拒绝以明文保存 Token",
        );
      }
      tokenCipher = this.#safeStorage.encryptString(input.token).toString("base64");
    }

    this.#data = { reviewerNode: { baseUrl: input.baseUrl, profileId: input.profileId, tokenCipher } };
    this.#save();

    return { baseUrl: input.baseUrl, profileId: input.profileId, tokenConfigured: tokenCipher !== null };
  }
}
