import {
  countGithubQueue,
  enqueueGithubPush,
  getGithubSyncState,
  listGithubQueue,
  markGithubPushFailed,
  removeGithubPush,
  updateGithubSyncState,
  type SqliteDatabase,
} from "@room/db";
import {
  githubNotePath,
  type ControlErrorCode,
  type ControlEvent,
  type GithubSyncStatus,
  type ProjectNote,
} from "@room/schemas";
import { SettingsError, type SettingsStore } from "./settings";

/**
 * 项目笔记同步到 GitHub（C-46 / ADR-005 §5，D-46c）。
 *
 * - 仓库必须是私有的（public → 什么都不推，lastError = public_repo）
 * - 只往上推：先取远端 sha 再覆盖（以主控机为准）；推不上去就排队，下次再试
 * - Token 只在 main：设置文件里加密存，不进 renderer、不进日志、不进队列
 */

export type GithubTransport = (input: {
  method: "GET" | "PUT";
  url: string;
  token: string;
  body?: unknown;
}) => Promise<{ status: number; json: unknown }>;

export class GithubError extends Error {
  readonly code: ControlErrorCode;
  constructor(code: ControlErrorCode, message: string) {
    super(message);
    this.name = "GithubError";
    this.code = code;
  }
}

const API = "https://api.github.com";
const RETRY_MS = 30_000;

const defaultTransport: GithubTransport = async (input) => {
  const response = await fetch(input.url, {
    method: input.method,
    headers: {
      Authorization: "Bearer " + input.token,
      Accept: "application/vnd.github+json",
      "User-Agent": "agent-review-room",
      ...(input.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
  });
  let json: unknown = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  return { status: response.status, json };
};

const encodePath = (path: string): string => path.split("/").map(encodeURIComponent).join("/");

export class GithubSyncService {
  readonly #db: SqliteDatabase;
  readonly #settings: SettingsStore;
  readonly #emit: (event: ControlEvent) => void;
  readonly #transport: GithubTransport;
  readonly #now: () => string;
  #timer: ReturnType<typeof setInterval> | null = null;
  #running = false;

  constructor(deps: {
    db: SqliteDatabase;
    settings: SettingsStore;
    emit: (event: ControlEvent) => void;
    transport?: GithubTransport;
    now?: () => string;
  }) {
    this.#db = deps.db;
    this.#settings = deps.settings;
    this.#emit = deps.emit;
    this.#transport = deps.transport ?? defaultTransport;
    this.#now = deps.now ?? (() => new Date().toISOString());
  }

  status(): GithubSyncStatus {
    const { repo, token } = this.#settings.getGithub();
    const state = getGithubSyncState(this.#db);
    return {
      repo: repo as GithubSyncStatus["repo"],
      tokenSet: token !== null,
      private: state.private,
      pending: countGithubQueue(this.#db),
      lastPushedAt: state.lastPushedAt,
      lastError: state.lastError as GithubSyncStatus["lastError"],
      lastErrorMessage: state.lastErrorMessage,
    };
  }

  /** 保存仓库 / Token：离线也能存（private 置 null，后台再查） */
  async update(command: { repo: string | null; token?: string }): Promise<GithubSyncStatus> {
    try {
      this.#settings.setGithub({ repo: command.repo, ...(command.token === undefined ? {} : { token: command.token }) });
    } catch (error) {
      if (error instanceof SettingsError) throw new GithubError("internal", error.message);
      throw error;
    }
    updateGithubSyncState(this.#db, { private: null, lastError: null, lastErrorMessage: null });
    this.#publish();
    if (command.repo !== null) void this.#check().catch(() => undefined);
    return this.status();
  }

  /** 立刻推一次；没配仓库 → invalid_state */
  async pushNow(): Promise<GithubSyncStatus> {
    const { repo } = this.#settings.getGithub();
    if (repo === null) throw new GithubError("invalid_state", "还没有设置仓库");
    await this.#check();
    return this.status();
  }

  /** 笔记存了一版就排一条（同一个文件只留最新内容） */
  enqueueNote(note: ProjectNote): void {
    const { repo } = this.#settings.getGithub();
    if (repo === null) return;
    enqueueGithubPush(this.#db, {
      path: githubNotePath(note.scope, note.agent),
      content: note.content.endsWith("\n") ? note.content : note.content + "\n",
      message: "笔记：" + note.agent + " 第 " + note.version + " 版（" + note.reason + "）",
      now: this.#now(),
    });
    this.#publish();
    void this.#kick();
  }

  start(): void {
    if (this.#timer !== null) return;
    this.#timer = setInterval(() => {
      void this.#kick();
    }, RETRY_MS);
    if (typeof this.#timer.unref === "function") this.#timer.unref();
    // 启动时先把上次没推完的试一次（没网就算了，等下一轮）
    void this.#kick().catch(() => undefined);
  }

  stop(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** 有仓库、有 Token、队列里有东西才动 */
  async #kick(): Promise<void> {
    if (this.#running) return;
    const { repo, token } = this.#settings.getGithub();
    if (repo === null || token === null) return;
    if (countGithubQueue(this.#db) === 0) return;
    this.#running = true;
    try {
      await this.#check();
    } catch {
      // 后台同步失败不影响聊天 / 笔记；状态由 #check 自己写
    } finally {
      this.#running = false;
    }
  }

  /** 查仓库是不是私有、Token 能不能写；私有才继续推队列 */
  async #check(): Promise<void> {
    const { repo, token } = this.#settings.getGithub();
    if (repo === null) return;
    if (token === null) {
      updateGithubSyncState(this.#db, { private: null, lastError: "no_token", lastErrorMessage: "还没有填 Token" });
      this.#publish();
      return;
    }
    let result: { status: number; json: unknown };
    try {
      result = await this.#transport({ method: "GET", url: API + "/repos/" + repo, token });
    } catch {
      updateGithubSyncState(this.#db, { lastError: "network", lastErrorMessage: "连不上 api.github.com" });
      this.#publish();
      return;
    }
    if (result.status === 401 || result.status === 403) {
      updateGithubSyncState(this.#db, { lastError: "unauthorized", lastErrorMessage: "Token 没有权限（或已失效）" });
      this.#publish();
      return;
    }
    if (result.status === 404) {
      updateGithubSyncState(this.#db, { lastError: "not_found", lastErrorMessage: "找不到这个仓库（或 Token 看不到它）" });
      this.#publish();
      return;
    }
    if (result.status !== 200) {
      updateGithubSyncState(this.#db, { lastError: "other", lastErrorMessage: "GitHub 返回 " + result.status });
      this.#publish();
      return;
    }
    const info = result.json as { private?: unknown };
    if (info.private !== true) {
      updateGithubSyncState(this.#db, { private: false, lastError: "public_repo", lastErrorMessage: "这个仓库是公开的，不同步" });
      this.#publish();
      return;
    }
    updateGithubSyncState(this.#db, { private: true, lastError: null, lastErrorMessage: null });
    await this.#flush();
    this.#publish();
  }

  /** 一条一条推：先取远端 sha（404 = 新建），再 PUT 覆盖 */
  async #flush(): Promise<void> {
    const { repo, token } = this.#settings.getGithub();
    if (repo === null || token === null) return;
    if (getGithubSyncState(this.#db).private !== true) return;
    for (const item of listGithubQueue(this.#db, 20)) {
      try {
        const url = API + "/contents/" + encodePath(item.path);
        const head = await this.#transport({ method: "GET", url, token });
        const sha = head.status === 200 ? (head.json as { sha?: unknown }).sha : null;
        if (head.status !== 200 && head.status !== 404) throw new Error("head " + head.status);
        const put = await this.#transport({
          method: "PUT",
          url,
          token,
          body: {
            message: item.message,
            content: Buffer.from(item.content, "utf8").toString("base64"),
            ...(typeof sha === "string" ? { sha } : {}),
          },
        });
        if (put.status === 409) {
          markGithubPushFailed(this.#db, item.path, "conflict");
          continue;
        }
        if (put.status < 200 || put.status >= 300) throw new Error("put " + put.status);
        removeGithubPush(this.#db, item.path);
        updateGithubSyncState(this.#db, { lastPushedAt: this.#now(), lastError: null, lastErrorMessage: null });
      } catch (error) {
        markGithubPushFailed(this.#db, item.path, error instanceof Error ? error.message : String(error));
        updateGithubSyncState(this.#db, { lastError: "network", lastErrorMessage: "推不上去，排队等下次" });
        break;
      }
    }
    this.#publish();
  }

  #publish(): void {
    this.#emit({ type: "github.updated", status: this.status() });
  }
}
