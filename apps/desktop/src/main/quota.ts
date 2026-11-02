import { RemoteProfileQuota, quotaState, type QuotaState } from "@room/schemas";

/**
 * D-32 / C-36：从节点读一个 profile 的额度（`GET /v1/profiles/:profileId/quota`，S-21 的端点）。
 *
 * - 读不到（超时 / 网络错 / 非 200 / 形状不对）一律 null：**未知不等于用完**，调用方按未知处理
 * - 结果短时间缓存（默认 30 秒），免得确认页 / 控制台刷新一次就打一次节点
 * - 记「上次读到 ok 的时间」：C-36 的粘滞缺席规则要用它（最近一次 Run 以 quota_exhausted 结束之后，
 *   只有读到 ok 才算恢复；读到 unknown 不清，免得节点短暂读失败就「恢复」）
 */
export interface QuotaTarget {
  baseUrl: string;
  token: string;
  /** 讨论用的 profileId */
  profileId: string;
}

export interface ProfileQuotaRead {
  /** 同一个节点同一个 profile 的缓存键 */
  key: string;
  quota: RemoteProfileQuota | null;
  state: QuotaState;
  /** 节点明说没有额度来源（404）：不是网络问题，是那个 profile 没配 quota（D-32 的提示用） */
  notConfigured: boolean;
}

export interface QuotaServiceOptions {
  fetch?: typeof fetch;
  now?: () => number;
  /** 缓存多久（毫秒），默认 30 秒 */
  ttlMs?: number;
  /** 单次请求超时，默认 2 秒（和节点那边一致） */
  timeoutMs?: number;
}

export const quotaKeyOf = (target: Pick<QuotaTarget, "baseUrl" | "profileId">): string =>
  target.baseUrl.replace(/\/+$/, "") + "|" + target.profileId;

export class QuotaService {
  readonly #cache = new Map<string, { at: number; read: ProfileQuotaRead }>();
  /** 每个 profile 上次读到 ok 的时间（毫秒） */
  readonly #lastOkAt = new Map<string, number>();
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #timeoutMs: number;

  constructor(options: QuotaServiceOptions = {}) {
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? (() => Date.now());
    this.#ttlMs = options.ttlMs ?? 30_000;
    this.#timeoutMs = options.timeoutMs ?? 2_000;
  }

  /** 上次读到 ok 的时间（从没读到过 → 0） */
  lastOkAt(key: string): number {
    return this.#lastOkAt.get(key) ?? 0;
  }

  async read(target: QuotaTarget, options: { force?: boolean } = {}): Promise<ProfileQuotaRead> {
    const key = quotaKeyOf(target);
    const cached = this.#cache.get(key);
    if (options.force !== true && cached !== undefined && this.#now() - cached.at < this.#ttlMs) {
      return cached.read;
    }
    const fetched = await this.#fetchQuota(target);
    const read: ProfileQuotaRead = {
      key,
      quota: fetched.quota,
      state: fetched.quota === null ? "unknown" : quotaState(fetched.quota),
      notConfigured: fetched.notConfigured,
    };
    if (read.state === "ok") this.#lastOkAt.set(key, this.#now());
    this.#cache.set(key, { at: this.#now(), read });
    return read;
  }

  async #fetchQuota(target: QuotaTarget): Promise<{ quota: RemoteProfileQuota | null; notConfigured: boolean }> {
    const url = target.baseUrl.replace(/\/+$/, "") + "/v1/profiles/" + encodeURIComponent(target.profileId) + "/quota";
    try {
      const res = await this.#fetch(url, {
        headers: { authorization: "Bearer " + target.token, accept: "application/json" },
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
      if (!res.ok) {
        console.warn("[quota] read failed: HTTP " + String(res.status) + " (" + target.profileId + ")");
        return { quota: null, notConfigured: res.status === 404 };
      }
      const parsed = RemoteProfileQuota.safeParse(await res.json());
      if (!parsed.success) {
        console.warn("[quota] read failed: 返回的形状对不上 (" + target.profileId + ")");
        return { quota: null, notConfigured: false };
      }
      return { quota: parsed.data, notConfigured: false };
    } catch (error) {
      // 超时 / 断网都是「未知」，不是「用完」；Key 和 Token 不进日志
      console.warn("[quota] read failed: " + (error instanceof Error ? error.message : String(error)));
      return { quota: null, notConfigured: false };
    }
  }

  /** 测试用：清掉缓存和 ok 时间 */
  reset(): void {
    this.#cache.clear();
    this.#lastOkAt.clear();
  }
}
