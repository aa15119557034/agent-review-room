import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { countGithubQueue, enqueueGithubPush, getGithubSyncState, insertProjectNote, openDatabase } from "@room/db";
import type { ControlEvent, ProjectNote } from "@room/schemas";
import { GithubError, GithubSyncService, type GithubTransport } from "../src/main/github";
import { SettingsStore, type SafeStorageLike } from "../src/main/settings";

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // Windows 上句柄释放有延迟
    }
  }
});

const TOKEN = "ghp_" + "x".repeat(36);
const NOW = "2026-11-02T00:00:00.000Z";
const CONVERSATION = "conv_" + "0".repeat(26);
const NOTE_PATH = "notes/" + CONVERSATION + "/deepseek.md";
const NOTE_URL = "https://api.github.com/repos/me/notes/contents/" + NOTE_PATH;

const safeStorage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from("enc:" + plain, "utf8"),
  decryptString: (encrypted) => encrypted.toString("utf8").slice(4),
};

const note = (version = 1): ProjectNote => ({
  id: "note_" + "0".repeat(26),
  scope: { kind: "conversation", conversationId: CONVERSATION },
  agent: "deepseek",
  version,
  parentId: null,
  content: "# 笔记\n- 约定",
  contentHash: "a".repeat(64),
  updatedBy: "agent",
  reason: "reply",
  source: { kind: "chat_run", runId: "run_" + "0".repeat(26) },
  revertedFromId: null,
  shrankALot: false,
  createdAt: NOW,
});

function harness(options: { private?: boolean; hangPut?: boolean; requestTimeoutMs?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "room-github-"));
  dirs.push(dir);
  const db = openDatabase(join(dir, "test.db"));
  const settings = new SettingsStore(join(dir, "settings.json"), safeStorage);
  const events: ControlEvent[] = [];
  const calls: { method: string; url: string; body?: unknown }[] = [];
  const files = new Map<string, string>();
  let online = true;
  let repoPrivate = options.private ?? true;
  let putStatus: number | null = null;
  /** #187：让某一次请求停在闸门上（再造一次「等待期间设置 / 队列变了」） */
  let repoGate: Promise<void> | null = null;
  let putGate: Promise<void> | null = null;
  const transport: GithubTransport = async (input) => {
    calls.push({ method: input.method, url: input.url, body: input.body });
    if (!online) throw new Error("ECONNRESET");
    if (input.method === "GET" && /^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+$/.test(input.url)) {
      if (repoGate !== null) {
        const gate = repoGate;
        repoGate = null;
        await gate;
      }
      return { status: 200, json: { private: repoPrivate } };
    }
    if (input.method === "GET" && input.url.includes("/contents/")) {
      const sha = files.get(input.url);
      return sha === undefined ? { status: 404, json: {} } : { status: 200, json: { sha } };
    }
    if (input.method === "PUT") {
      if (options.hangPut === true) return await new Promise<never>(() => undefined);
      if (putGate !== null) {
        const gate = putGate;
        putGate = null;
        await gate;
      }
      if (putStatus !== null) {
        const status = putStatus;
        putStatus = null;
        return { status, json: {} };
      }
      files.set(input.url, "sha-" + (files.size + 1));
      return { status: 201, json: {} };
    }
    return { status: 500, json: {} };
  };
  const github = new GithubSyncService({
    db,
    settings,
    emit: (event) => events.push(event),
    transport,
    now: () => NOW,
    ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
  });
  const enqueue = (content = "# 笔记\n- 约定\n", message = "笔记：deepseek 第 1 版", at = NOW) =>
    enqueueGithubPush(db, { path: NOTE_PATH, content, message, now: at });
  return {
    dir,
    db,
    settings,
    events,
    calls,
    github,
    enqueue,
    setOnline: (value: boolean) => { online = value; },
    setPrivate: (value: boolean) => { repoPrivate = value; },
    setPutStatus: (value: number) => { putStatus = value; },
    /** 返回 release：调用后放行（一次性的闸门） */
    gateRepo: () => {
      let release!: () => void;
      repoGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
    gatePut: () => {
      let release!: () => void;
      putGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
    files,
  };
}

async function until(check: () => boolean, ms = 4_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting");
}

describe("github sync (D-46c)", () => {
  it("公开仓库：保存设置但什么都不推，lastError = public_repo", async () => {
    const h = harness({ private: false });
    try {
      await h.github.update({ repo: "me/notes", token: TOKEN });
      h.enqueue();
      const status = await h.github.pushNow();
      assert.equal(status.private, false);
      assert.equal(status.lastError, "public_repo");
      assert.equal(status.pending, 1);
      assert.equal(h.calls.filter((call) => call.method === "PUT").length, 0);
    } finally {
      h.db.close();
    }
  });

  it("私有仓库：先取 sha（404 = 新建）再覆盖，队列清空", async () => {
    const h = harness();
    try {
      await h.github.update({ repo: "me/notes", token: TOKEN });
      h.enqueue();
      assert.equal(h.github.status().pending, 1);
      const status = await h.github.pushNow();
      assert.equal(status.pending, 0);
      assert.equal(status.lastError, null);
      assert.equal(status.lastPushedAt, NOW);
      const put = h.calls.find((call) => call.method === "PUT")!;
      assert.equal(put.url, NOTE_URL);
      const body = put.body as { content: string; message: string; sha?: string };
      assert.equal(Buffer.from(body.content, "base64").toString("utf8"), "# 笔记\n- 约定\n");
      assert.ok(body.message.includes("第 1 版"));
      assert.equal(body.sha, undefined, "远端没有文件时不带 sha");
    } finally {
      h.db.close();
    }
  });

  it("远端已经有这个文件：先取 sha 再带上覆盖", async () => {
    const h = harness();
    try {
      await h.github.update({ repo: "me/notes", token: TOKEN });
      h.files.set(NOTE_URL, "sha-old");
      h.enqueue();
      await h.github.pushNow();
      const put = h.calls.find((call) => call.method === "PUT")!;
      assert.equal((put.body as { sha?: string }).sha, "sha-old");
    } finally {
      h.db.close();
    }
  });

  it("断网：排队保留、lastError = network；恢复后推上去", async () => {
    const h = harness();
    try {
      await h.github.update({ repo: "me/notes", token: TOKEN });
      h.enqueue();
      h.setOnline(false);
      await h.github.pushNow();
      assert.equal(h.github.status().pending, 1);
      assert.equal(h.github.status().lastError, "network");
      h.setOnline(true);
      await h.github.pushNow();
      assert.equal(h.github.status().pending, 0);
      assert.equal(h.github.status().lastError, null);
    } finally {
      h.db.close();
    }
  });

  it("409 冲突：这一轮留下，下一轮重新取 sha 再推", async () => {
    const h = harness();
    try {
      await h.github.update({ repo: "me/notes", token: TOKEN });
      await h.github.pushNow(); // 先让 update 起的后台检查跑完，避免它抢走这次 409
      h.enqueue();
      h.setPutStatus(409);
      await h.github.pushNow();
      assert.equal(h.github.status().pending, 1);
      assert.equal(getGithubSyncState(h.db).lastPushedAt, null);
      await h.github.pushNow();
      assert.equal(h.github.status().pending, 0);
    } finally {
      h.db.close();
    }
  });

  it("enqueueNote 只在配了仓库时排队（同一个文件只留最新一版）", async () => {
    const h = harness();
    try {
      h.github.enqueueNote(note(1));
      assert.equal(countGithubQueue(h.db), 0, "没配仓库不排队");
      await h.github.update({ repo: "me/notes", token: TOKEN });
      h.github.enqueueNote(note(1));
      h.github.enqueueNote(note(2));
      assert.equal(countGithubQueue(h.db), 1);
      const row = h.db.prepare("SELECT path, content, message FROM github_push_queue").get() as {
        path: string;
        content: string;
        message: string;
      };
      assert.equal(row.path, NOTE_PATH);
      assert.ok(row.message.includes("第 2 版"));
    } finally {
      h.db.close();
    }
  });

  it("第一次设好仓库时，已有笔记的最新版各排一条", async () => {
    const h = harness();
    try {
      insertProjectNote(h.db, note(1));
      assert.equal(countGithubQueue(h.db), 0);
      await h.github.update({ repo: "me/notes", token: TOKEN });
      assert.equal(countGithubQueue(h.db), 1);
    } finally {
      h.db.close();
    }
  });

  it("PUT 返回 422：记 other、带状态码", async () => {
    const h = harness();
    try {
      await h.github.update({ repo: "me/notes", token: TOKEN });
      await h.github.pushNow();
      h.enqueue();
      h.setPutStatus(422);
      await h.github.pushNow();
      assert.equal(h.github.status().lastError, "other");
      assert.ok((h.github.status().lastErrorMessage ?? "").includes("422"));
      assert.equal(h.github.status().pending, 1);
    } finally {
      h.db.close();
    }
  });

  it("Token 不进状态、不进事件、设置文件里是密文", async () => {
    const h = harness();
    try {
      await h.github.update({ repo: "me/notes", token: TOKEN });
      await h.github.pushNow();
      assert.ok(!JSON.stringify(h.github.status()).includes(TOKEN));
      assert.ok(!JSON.stringify(h.events).includes(TOKEN));
      assert.ok(!readFileSync(join(h.dir, "settings.json"), "utf8").includes(TOKEN));
      assert.equal(h.github.status().tokenSet, true);
    } finally {
      h.db.close();
    }
  });

  it("没配仓库：不排、pushNow 报 invalid_state", async () => {
    const h = harness();
    try {
      h.github.enqueueNote(note());
      assert.equal(h.github.status().pending, 0);
      assert.equal(h.github.status().repo, null);
      await assert.rejects(
        () => h.github.pushNow(),
        (error: unknown) => error instanceof GithubError && error.code === "invalid_state",
      );
    } finally {
      h.db.close();
    }
  });

  it("#187 私库检查期间切换仓库：旧响应不写状态、不推没检查过的目标", async () => {
    const h = harness({ private: false });
    try {
      h.enqueue();
      const release = h.gateRepo();
      await h.github.update({ repo: "me/notes", token: TOKEN });
      await h.github.update({ repo: "me/public", token: TOKEN });
      release();
      await until(() => h.calls.some((call) => call.url === "https://api.github.com/repos/me/public"));
      const status = await h.github.pushNow();
      assert.equal(h.calls.filter((call) => call.method === "PUT").length, 0, "不推到没检查过的目标");
      assert.equal(status.repo, "me/public");
      assert.equal(status.private, false, "旧响应没有把新仓库标成 private");
      assert.equal(status.lastError, "public_repo");
    } finally {
      h.db.close();
    }
  });

  it("#187 请求超时：不挂住 running / inflight，队列保留，恢复后能推", async () => {
    const h = harness({ hangPut: true, requestTimeoutMs: 20 });
    try {
      await h.github.update({ repo: "me/notes", token: TOKEN });
      await h.github.pushNow();
      h.enqueue();
      const started = Date.now();
      const status = await h.github.pushNow();
      assert.ok(Date.now() - started < 2_000, "超时后立刻返回");
      assert.equal(status.pending, 1, "队列保留");
      assert.equal(status.lastError, "network");
    } finally {
      h.db.close();
    }
  });

  it("#187 推送期间同路径又存了一版：旧版成功不删新版，下一轮推新版", async () => {
    const h = harness();
    try {
      await h.github.update({ repo: "me/notes", token: TOKEN });
      await h.github.pushNow();
      h.enqueue("v1", "笔记 v1");
      const release = h.gatePut();
      const pushing = h.github.pushNow();
      await until(() => h.calls.filter((call) => call.method === "PUT").length === 1);
      h.enqueue("v2", "笔记 v2", "2026-11-02T00:00:01.000Z");
      release();
      await pushing;
      const puts = h.calls.filter((call) => call.method === "PUT");
      assert.equal(puts.length, 2, "第二版也推了");
      assert.equal(Buffer.from((puts[1]!.body as { content: string }).content, "base64").toString("utf8"), "v2");
      assert.equal(countGithubQueue(h.db), 0);
    } finally {
      h.db.close();
    }
  });
});
