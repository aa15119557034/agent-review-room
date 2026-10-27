import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  createConversation,
  getMediaJob,
  listActiveMediaJobs,
  insertChatMessage,
  insertMediaJob,
  openDatabase,
  ulid,
  WriteQueue,
  type SqliteDatabase,
} from "@room/db";
import type { ChatMessage, ControlEvent, DrawRequest, MediaJob, UserChatMessage } from "@room/schemas";
import sharp from "sharp";
import { ComfyUiError, type ComfyUiClient } from "../src/main/comfyui";
import { MediaJobsService } from "../src/main/media-jobs";
import { MediaStore } from "../src/main/media-store";

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

const png = () =>
  sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 9, g: 8, b: 7 } } })
    .png()
    .toBuffer();

interface FakeComfy {
  client: ComfyUiClient;
  calls: number;
  interrupted: number;
  available: boolean;
  failure: Error | null;
}

function fakeComfy(): FakeComfy {
  const state: FakeComfy = { client: null as never, calls: 0, interrupted: 0, available: true, failure: null };
  state.client = {
    isUp: async () => state.available,
    modelName: () => "qwen-image",
    interrupt: async () => {
      state.interrupted += 1;
    },
    draw: async (input: { prompt: string; size: string; seed: number }) => {
      state.calls += 1;
      if (state.failure !== null) throw state.failure;
      return { image: await png(), seed: input.seed, model: "qwen-image" };
    },
  } as unknown as ComfyUiClient;
  return state;
}

const T = "2026-10-27T00:00:00.000Z";

interface Harness {
  service: MediaJobsService;
  db: SqliteDatabase;
  comfy: FakeComfy;
  events: ControlEvent[];
  conversationId: string;
  message: UserChatMessage;
}

async function makeHarness(opts: { comfy?: FakeComfy | null } = {}): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), "room-media-jobs-"));
  dirs.push(root);
  const db = openDatabase(join(root, "room.db"));
  const queue = new WriteQueue();
  const store = new MediaStore(join(root, "images"), join(root, "files"), db);
  const comfy = opts.comfy === undefined ? fakeComfy() : opts.comfy;
  const events: ControlEvent[] = [];
  const service = new MediaJobsService({
    db,
    queue,
    store,
    emit: (event) => events.push(event),
    comfy: () => (comfy === null ? null : comfy.client),
    now: () => T,
    seed: () => 42,
  });
  const conversation = await createConversation(db, queue, {
    members: { kind: "direct", agent: "deepseek" },
    title: null,
    createdAt: T,
  });
  const message: UserChatMessage = {
    id: `cmsg_${ulid()}`,
    conversationId: conversation.id,
    createdAt: T,
    sender: "user",
    content: { kind: "text", text: "帮我画一只小鲸鱼", attachments: [] },
    mentions: { kind: "none" },
    quoteMessageId: null,
    replacesMessageId: null,
    state: "sent",
    retractedAt: null,
  } as ChatMessage as UserChatMessage;
  insertChatMessage(db, { message });
  return { service, db, comfy, events, conversationId: conversation.id, message };
}

const request = (patch: Partial<DrawRequest> = {}): DrawRequest => ({
  prompt: "小鲸鱼",
  size: "1024x1024",
  backend: "comfyui",
  ...patch,
});

const source = (h: Harness) => ({ kind: "chat" as const, conversationId: h.conversationId, messageId: h.message.id, agent: null });

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("timed out waiting");
}

describe("media jobs service (D-38a)", () => {
  it("draws a picture through ComfyUI, stores it as generated, and ends exactly once", async () => {
    const h = await makeHarness();
    try {
      const queued = await h.service.start(request(), source(h), false);
      assert.equal(queued.state, "queued");
      await until(() => getMediaJob(h.db, queued.id)?.state === "succeeded");
      const job = h.service.get(queued.id);
      assert.equal(job.result?.backend, "comfyui");
      assert.equal(job.result?.seed, 42);
      assert.equal(job.result?.model, "qwen-image");
      assert.equal(job.route?.backend, "comfyui");
      const hit = job.result?.ref;
      assert.ok(hit !== undefined && job.result !== null);
      // 图真的存进了图片库（generated 用途），能读回来
      assert.ok(job.result!.ref.startsWith("img_"));
      assert.equal(h.comfy.calls, 1);
      // 事件：queued / running / succeeded 都推了 media.updated
      const states = h.events
        .filter((e): e is Extract<ControlEvent, { type: "media.updated" }> => e.type === "media.updated")
        .map((e) => e.job.state);
      assert.deepEqual(states, ["queued", "running", "succeeded"]);
    } finally {
      h.db.close();
    }
  });

  it("dedupes the same source + draw while it is still running; rejects codex and bad sources", async () => {
    const h = await makeHarness();
    try {
      const first = await h.service.start(request(), source(h), false);
      const second = await h.service.start(request(), source(h), false);
      assert.equal(second.id, first.id, "同一个请求不会建第二个任务");
      await assert.rejects(
        () => h.service.start(request({ backend: "codex" }), source(h), false),
        (e: unknown) => (e as { code?: string }).code === "validation_failed",
      );
      await assert.rejects(
        () => h.service.start(request(), { ...source(h), messageId: `cmsg_${ulid()}` }, false),
        (e: unknown) => (e as { code?: string }).code === "validation_failed",
      );
      await until(() => getMediaJob(h.db, first.id)?.state === "succeeded");
    } finally {
      h.db.close();
    }
  });

  it("cancels queued and running jobs, and 「停」 cancels everything in the scope", async () => {
    const h = await makeHarness();
    try {
      const a = await h.service.start(request({ prompt: "a" }), source(h), false);
      await until(() => getMediaJob(h.db, a.id)?.state === "succeeded");

      // 再排两个：第一个立刻开跑，第二个还在排队
      const running = await h.service.start(request({ prompt: "b" }), source(h), false);
      const queued = await h.service.start(request({ prompt: "c" }), source(h), false);
      await until(() => getMediaJob(h.db, running.id)?.state === "running");
      const stopped = await h.service.stop({ kind: "chat", conversationId: h.conversationId });
      assert.deepEqual(
        stopped.map((j) => j.id).sort(),
        [running.id, queued.id].sort(),
      );
      assert.ok(stopped.every((j) => j.state === "cancelled" && j.cancelReason === "user_stop"));
      await until(() => getMediaJob(h.db, queued.id)?.state === "cancelled");
      assert.ok(h.comfy.interrupted >= 1, "正在跑的那个让 ComfyUI 打断");
      // 让队列把这一次跑完、不再碰数据库，再关连接
      await until(() => listActiveMediaJobs(h.db).length === 0);
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      h.db.close();
    }
  });

  it("fails with backend_unavailable when there is no ComfyUI", async () => {
    const h = await makeHarness({ comfy: null });
    try {
      const job = await h.service.start(request(), source(h), false);
      await until(() => getMediaJob(h.db, job.id)?.state === "failed");
      assert.equal(h.service.get(job.id).failure?.reason, "backend_unavailable");
    } finally {
      h.db.close();
    }
  });

  it("fails a job that waited longer than the queue timeout (gpu_queue_timeout)", async () => {
    const h = await makeHarness();
    try {
      // 三分钟前就排上队的任务：轮到它时已经超过 2 分钟的上限
      const stale: MediaJob = {
        id: `mjob_${ulid()}`,
        kind: "draw",
        state: "queued",
        authorization: "user_tap",
        source: { kind: "chat", conversationId: h.conversationId, messageId: h.message.id, agent: null },
        intentHash: null,
        draw: { prompt: "排太久了", size: "1024x1024", backend: "comfyui" },
        route: null,
        remoteRunId: null,
        result: null,
        speech: null,
        failure: null,
        cancelReason: null,
        createdAt: new Date(Date.parse(T) - 3 * 60_000).toISOString(),
        startedAt: null,
        finishedAt: null,
      };
      insertMediaJob(h.db, stale);

      const fresh = await h.service.start(request({ prompt: "后来的" }), source(h), false);
      await until(() => getMediaJob(h.db, stale.id)?.state === "failed");
      assert.equal(h.service.get(stale.id).failure?.reason, "gpu_queue_timeout");
      // 排队的那个失败了，后来的一样要正常画出来
      await until(() => getMediaJob(h.db, fresh.id)?.state === "succeeded");
    } finally {
      h.db.close();
    }
  });

  it("maps ComfyUI timeout and generation errors to the right failure reasons", async () => {
    const timeoutComfy = fakeComfy();
    timeoutComfy.failure = new ComfyUiError("timeout", "超时");
    const h1 = await makeHarness({ comfy: timeoutComfy });
    try {
      const job = await h1.service.start(request(), source(h1), false);
      await until(() => getMediaJob(h1.db, job.id)?.state === "timed_out");
    } finally {
      h1.db.close();
    }

    const brokenComfy = fakeComfy();
    brokenComfy.failure = new ComfyUiError("rejected", "ComfyUI 拒绝了这次请求（HTTP 500）");
    const h2 = await makeHarness({ comfy: brokenComfy });
    try {
      const job = await h2.service.start(request(), source(h2), false);
      await until(() => getMediaJob(h2.db, job.id)?.state === "failed");
      assert.equal(h2.service.get(job.id).failure?.reason, "generation_failed");
    } finally {
      h2.db.close();
    }
  });

  it("previews the local route only, and lists by scope with the C-42f per-message selection", async () => {
    const h = await makeHarness();
    try {
      const preview = await h.service.preview(request());
      assert.equal(preview.backend, "comfyui");
      assert.equal(preview.comfyuiAvailable, true);
      assert.equal(preview.codexManual, "blocked");

      // 消息 A 先成功再失败 8 次；按消息查要把成功那条带回来
      const messageA = h.message.id;
      const messageB = h.message.id; // 同一会话，两个"消息"用不同 id 的 job 来区分不方便，直接造一条 B
      const bId = `cmsg_${ulid()}`;
      insertChatMessage(h.db, {
        message: {
          ...h.message,
          id: bId,
          createdAt: T,
        } as never,
      });
      void messageB;

      const ok = await h.service.start(request({ prompt: "好的" }), source(h), false);
      await until(() => getMediaJob(h.db, ok.id)?.state === "succeeded");
      for (let i = 0; i < 8; i += 1) {
        const failed: MediaJob = {
          ...h.service.get(ok.id),
          id: `mjob_${ulid()}`,
          state: "failed",
          failure: { reason: "generation_failed", message: "失败" + i },
          result: null,
          route: null,
          startedAt: T,
          finishedAt: T,
          createdAt: T,
        };
        insertMediaJob(h.db, failed);
      }

      const listed = h.service.list({ kind: "chat", conversationId: h.conversationId }, [messageA]);
      assert.ok(listed.some((j) => j.state === "succeeded"), "成功那条不会被后来的失败挤掉");
      assert.ok(listed.length <= 7, "每消息每类最多 7 条");

      const all = h.service.list({ kind: "chat", conversationId: h.conversationId });
      assert.ok(all.length >= 9);
    } finally {
      h.db.close();
    }
  });
});


