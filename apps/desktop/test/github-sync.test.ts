import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { countGithubQueue, enqueueGithubPush, getGithubSyncState, openDatabase } from "@room/db";
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
const NOTE_URL = "https://api.github.com/contents/" + NOTE_PATH;

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

function harness(options: { private?: boolean } = {}) {
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
  const transport: GithubTransport = async (input) => {
    calls.push({ method: input.method, url: input.url, body: input.body });
    if (!online) throw new Error("ECONNRESET");
    if (input.method === "GET" && input.url === "https://api.github.com/repos/me/notes") {
      return { status: 200, json: { private: repoPrivate } };
    }
    if (input.method === "GET" && input.url.includes("/contents/")) {
      const sha = files.get(input.url);
      return sha === undefined ? { status: 404, json: {} } : { status: 200, json: { sha } };
    }
    if (input.method === "PUT") {
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
  const github = new GithubSyncService({ db, settings, emit: (event) => events.push(event), transport, now: () => NOW });
  const enqueue = (content = "# 笔记\n- 约定\n", message = "笔记：deepseek 第 1 版") =>
    enqueueGithubPush(db, { path: NOTE_PATH, content, message, now: NOW });
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
    files,
  };
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
});
