import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  createConversation,
  getMediaJob,
  getSpeechClip,
  insertChatMessage,
  insertChatRun,
  insertChatSlot,
  insertChatSnapshot,
  listMediaJobs,
  openDatabase,
  retractChatMessage,
  ulid,
  WriteQueue,
  type SqliteDatabase,
} from "@room/db";
import type { ChatMessage, ChatRun, ChatReplySlot, ChatSnapshot, ControlEvent, MediaJob } from "@room/schemas";
import { MediaJob as MediaJobSchema } from "@room/schemas";
import { MediaJobsService } from "../src/main/media-jobs";
import { createAudioProtocolHandler, MediaStore } from "../src/main/media-store";
import type { TtsRunner } from "../src/main/tts";
import {
  TtsFailedError,
  TtsRunner,
  TtsUnavailableError,
  voiceOptionsOf,
  waitChildExit,
  type ChildExitLike,
  type TtsConfig,
} from "../src/main/tts";

/**
 * D-37b：播放（speech.play）这一条路。
 * - 合成结果存进 MediaStore（aud_），片段进 speech_clips（缓存键 = 文本 hash + 声音 + 语速 + 引擎 + 版本）
 * - 第二次播放命中缓存，不再建任务
 * - 秘书没选声音 / 声音不在配置 / 没有可朗读文字 / 太长 / 已撤回 → validation_failed
 * - 引擎报错 → failed(generation_failed)；取消 → cancelled
 * - room-audio:// 能按 ref 取回字节（支持 Range，206）
 */

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

const T = "2026-11-02T00:00:00.000Z";
const WAV = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(2044, 7)]);

interface FakeRunner {
  runner: TtsRunner;
  calls: { text: string; speed: number }[];
  fail: Error | null;
  /** 放行一次合成（模拟排队中） */
  gate: Promise<void> | null;
}

function fakeRunner(): FakeRunner {
  const state: FakeRunner = { runner: null as never, calls: [], fail: null, gate: null };
  state.runner = {
    engine: "indextts2",
    engineVersion: "indextts2-2.0.0-test",
    available: () => true,
    voice: (voiceId: string) =>
      voiceId === "xiaoyu" ? { id: "xiaoyu", displayName: "小雨", source: "reference", refAudio: "ref.wav" } : null,
    synthesize: async (input: { text: string; speed: number; signal: AbortSignal }) => {
      state.calls.push({ text: input.text, speed: input.speed });
      if (state.gate !== null) await state.gate;
      if (state.fail !== null) throw state.fail;
      return { bytes: WAV, mime: "audio/wav", durationMs: 1200, sampleRate: 22050, ms: 5 };
    },
    dispose: () => undefined,
  } as unknown as TtsRunner;
  return state;
}

interface Harness {
  service: MediaJobsService;
  db: SqliteDatabase;
  store: MediaStore;
  runner: FakeRunner;
  events: ControlEvent[];
  conversationId: string;
  userMessage: ChatMessage;
  answer: ChatMessage;
  voice: { voiceId: string; speed: number } | null;
}

async function makeHarness(): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), "room-speech-"));
  dirs.push(root);
  const db = openDatabase(join(root, "room.db"));
  const queue = new WriteQueue();
  const store = new MediaStore(join(root, "images"), join(root, "files"), join(root, "audio"), db);
  const runner = fakeRunner();
  const events: ControlEvent[] = [];
  const harness: Partial<Harness> = { db, store, runner, events, voice: { voiceId: "xiaoyu", speed: 1 } };
  const service = new MediaJobsService({
    db,
    queue,
    store,
    emit: (event) => events.push(event),
    comfy: () => null,
    tts: () => runner.runner,
    agentOf: () => ({ voice: harness.voice ?? null }),
    now: () => T,
  });
  harness.service = service;

  const conversation = await createConversation(db, queue, {
    members: { kind: "direct", agent: "deepseek" },
    title: null,
    createdAt: T,
  });
  const userMessage: ChatMessage = {
    id: "cmsg_" + ulid(),
    conversationId: conversation.id,
    createdAt: T,
    sender: "user",
    content: { kind: "text", text: "今天外面怎么样", attachments: [] },
    mentions: { kind: "none" },
    quoteMessageId: null,
    replacesMessageId: null,
    state: "sent",
    retractedAt: null,
  };
  insertChatMessage(db, { message: userMessage });

  const slot: ChatReplySlot = {
    id: "slot_" + ulid(),
    conversationId: conversation.id,
    userMessageId: userMessage.id,
    agent: "deepseek",
    required: true,
    outcome: "running",
    runId: "run_" + ulid(),
    attempt: 1,
    replyMessageId: null,
    failure: null,
    unavailableReason: null,
    createdAt: T,
    finishedAt: null,
  };
  const snapshot: ChatSnapshot = {
    id: "snap_" + ulid(),
    purpose: "reply",
    conversationId: conversation.id,
    userMessageId: userMessage.id,
    agent: "deepseek",
    content: "当前消息：今天外面怎么样",
    contentHash: "a".repeat(64),
    nonce: "0123456789abcdef",
    memorySlot: null,
    includedMessageIds: [userMessage.id],
    includedSummaryIds: [],
    adapterVersion: "chat-v4",
    tokenEstimate: 8,
    createdAt: T,
  };
  const run: ChatRun = {
    id: slot.runId as string,
    kind: "chat",
    purpose: "reply",
    conversationId: conversation.id,
    slotId: slot.id,
    agent: "deepseek",
    snapshotId: snapshot.id,
    snapshotHash: snapshot.contentHash,
    finalPromptHash: null,
    memoryManifest: null,
    model: null,
    adapterId: "remote:deepseek-chat",
    state: "QUEUED",
    substate: null,
    failureReason: null,
    attempt: 1,
    createdAt: T,
    startedAt: null,
    finishedAt: null,
  };
  insertChatSnapshot(db, snapshot);
  insertChatSlot(db, slot);
  insertChatRun(db, run);
  const answer: ChatMessage = {
    id: "cmsg_" + ulid(),
    conversationId: conversation.id,
    createdAt: T,
    sender: "agent",
    agent: "deepseek",
    text: "今天外面起了点风，出门记得系围巾。",
    inReplyTo: userMessage.id,
    slotId: slot.id,
    runId: slot.runId as string,
    memoryEntriesUsed: null,
  };
  insertChatMessage(db, { message: answer });

  harness.conversationId = conversation.id;
  harness.userMessage = userMessage;
  harness.answer = answer;
  return harness as Harness;
}

async function settle(service: MediaJobsService): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    if (!service.busy()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("media queue did not settle");
}

const sourceOf = (h: Harness, messageId = h.answer.id) =>
  ({ kind: "chat", conversationId: h.conversationId, messageId, agent: "deepseek" }) as const;

describe("speech.play (D-37b)", () => {
  it("回答的用户来源已撤回：不能再从这条回答创建画图任务", async () => {
    const h = await makeHarness();
    try {
      retractChatMessage(h.db, h.userMessage.id, T);
      await assert.rejects(
        h.service.start({ prompt: "鲸鱼", size: "1024x1024", backend: "auto" }, sourceOf(h), false),
        (error: unknown) => (error as { code?: string }).code === "validation_failed",
      );
    } finally { await settle(h.service); h.db.close(); }
  });
  it("相同来源的语音并发入队只创建一个任务", async () => {
    const h = await makeHarness();
    try {
      const source = { kind: "chat" as const, conversationId: h.conversationId, messageId: h.answer.id, agent: "deepseek" };
      const [a, b] = await Promise.all([h.service.play(source), h.service.play(source)]);
      await settle(h.service);
      assert.ok(!a.cached && !b.cached);
      assert.equal(a.job.id, b.job.id);
      assert.equal(h.runner.calls.length, 1);
    } finally { h.db.close(); }
  });
  it("沉浸语音前置条件不满足时，真实服务能存下契约合格的失败任务", async () => {
    const h = await makeHarness();
    try {
      h.voice = null;
      const source = { kind: "chat" as const, conversationId: h.conversationId, messageId: h.answer.id, agent: "deepseek" };
      await assert.rejects(h.service.play(source, { authorization: "immersive", intentHash: "a".repeat(64) }));
      const failed = await h.service.failImmersiveSpeech(source, "a".repeat(64), "这位秘书还没选声音");
      MediaJobSchema.parse(failed);
      assert.equal(failed.state, "failed");
      assert.equal(failed.failure?.reason, "backend_unavailable");
      assert.equal(getMediaJob(h.db, failed.id)?.failure?.message, "这位秘书还没选声音");
      assert.ok(h.events.some((event) => event.type === "media.updated" && event.job.id === failed.id));
    } finally { h.db.close(); }
  });
  it("synthesizes an answer, stores the audio and the clip, then serves the clip from cache", async () => {
    const h = await makeHarness();
    try {
      const first = await h.service.play(sourceOf(h));
      assert.equal(first.cached, false);
      await settle(h.service);
      const job = getMediaJob(h.db, (first as { job: MediaJob }).job.id)!;
      assert.equal(job.state, "succeeded");
      assert.equal(job.authorization, "user_play");
      const clip = job.speech!;
      assert.equal(clip.voiceId, "xiaoyu");
      assert.equal(clip.speed, 1);
      assert.equal(clip.engine, "indextts2");
      assert.equal(clip.durationMs, 1200);
      assert.deepEqual(h.store.readAudio(clip.audioRef), WAV, "音频字节进了 MediaStore");
      assert.equal(h.runner.calls[0]!.text, "今天外面起了点风，出门记得系围巾。", "朗读文本走 speakableText");
      assert.equal(getSpeechClip(h.db, clip.id)?.id, clip.id, "片段进缓存表");
      assert.ok(h.events.some((event) => event.type === "media.updated" && event.job.state === "succeeded"));

      const second = await h.service.play(sourceOf(h));
      assert.equal(second.cached, true);
      assert.equal((second as { clip: { id: string } }).clip.id, clip.id);
      assert.equal(h.runner.calls.length, 1, "命中缓存不再合成");
      assert.equal(listMediaJobs(h.db, { kind: "chat", conversationId: h.conversationId }).length, 1);
    } finally {
      h.db.close();
    }
  });

  it("rejects sources that cannot be spoken: user message, no voice, unknown voice, too long, withdrawn", async () => {
    const h = await makeHarness();
    try {
      const validation = (error: unknown) => (error as { code?: string }).code === "validation_failed";
      await assert.rejects(() => h.service.play(sourceOf(h, h.userMessage.id)), validation);
      h.voice = null;
      await assert.rejects(() => h.service.play(sourceOf(h)), (error: unknown) => validation(error) && /声音/.test((error as Error).message));
      h.voice = { voiceId: "nobody", speed: 1 };
      await assert.rejects(() => h.service.play(sourceOf(h)), validation);
      h.voice = { voiceId: "xiaoyu", speed: 1 };

      const long: ChatMessage = { ...(h.answer as never as ChatMessage), id: "cmsg_" + ulid(), text: "好".repeat(2001) } as never;
      insertChatMessage(h.db, { message: long });
      await assert.rejects(() => h.service.play(sourceOf(h, long.id)), validation);

      const blank: ChatMessage = { ...(h.answer as never as ChatMessage), id: "cmsg_" + ulid(), text: "```\ncode only\n```" } as never;
      insertChatMessage(h.db, { message: blank });
      await assert.rejects(() => h.service.play(sourceOf(h, blank.id)), validation);
    } finally {
      h.db.close();
    }
  });

  it("同一回答同时「用语音回」和沉浸自动语音：只建一个任务，授权保持 reply_as_voice", async () => {
    const h = await makeHarness();
    try {
      const source = { kind: "chat" as const, conversationId: h.conversationId, messageId: h.answer.id, agent: "deepseek" };
      const first = await h.service.play(source, { authorization: "reply_as_voice" });
      assert.equal(first.cached, false);
      // 同一条回答、同一段文本 / 声音 / 语速：沉浸自动语音合并到已有任务，不新建第二个
      const second = await h.service.play(source, { authorization: "immersive", intentHash: "b".repeat(64) });
      assert.equal(second.cached, false);
      assert.equal(second.job.id, first.job.id);
      assert.equal(getMediaJob(h.db, first.job.id)?.authorization, "reply_as_voice", "授权保持最先建的那个");
      assert.equal(listMediaJobs(h.db, { kind: "chat", conversationId: h.conversationId }).length, 1);
    } finally {
      await settle(h.service);
      h.db.close();
    }
  });

  it("queues a reply_as_voice job even on a cache hit, and finishes it without calling the engine again", async () => {
    const h = await makeHarness();
    try {
      const first = await h.service.play(sourceOf(h), { authorization: "reply_as_voice" });
      await settle(h.service);
      const firstJob = getMediaJob(h.db, (first as { job: MediaJob }).job.id)!;
      assert.equal(firstJob.authorization, "reply_as_voice");
      assert.equal(firstJob.state, "succeeded");
      const clip = firstJob.speech!;

      const again = await h.service.play(sourceOf(h), { authorization: "reply_as_voice" });
      const secondJob = getMediaJob(h.db, (again as { job: MediaJob }).job.id)!;
      assert.notEqual(secondJob.id, firstJob.id, "自动合成每次都建任务（界面按任务显示有没有语音）");
      assert.equal(secondJob.state, "succeeded");
      assert.equal(secondJob.speech?.id, clip.id, "命中缓存用同一个片段");
      assert.equal(h.runner.calls.length, 1, "缓存命中不调引擎");
    } finally {
      h.db.close();
    }
  });

  it("marks the job failed when the engine errors out, and serves 206 for a ranged request", async () => {
    const h = await makeHarness();
    try {
      h.runner.fail = new TtsFailedError("引擎炸了");
      const started = await h.service.play(sourceOf(h));
      await settle(h.service);
      const job = getMediaJob(h.db, (started as { job: MediaJob }).job.id)!;
      assert.equal(job.state, "failed");
      assert.equal(job.failure?.reason, "generation_failed");
      assert.equal(job.speech, null);

      h.runner.fail = null;
      const ok = await h.service.play(sourceOf(h));
      await settle(h.service);
      const clip = getMediaJob(h.db, (ok as { job: MediaJob }).job.id)!.speech!;
      const handler = createAudioProtocolHandler(h.store);
      const full = await handler(new Request("room-audio://" + clip.audioRef));
      assert.equal(full.status, 200);
      assert.equal(full.headers.get("content-type"), "audio/wav");
      assert.equal((await full.arrayBuffer()).byteLength, WAV.length);
      const ranged = await handler(new Request("room-audio://" + clip.audioRef, { headers: { range: "bytes=0-3" } }));
      assert.equal(ranged.status, 206);
      assert.equal(ranged.headers.get("content-range"), `bytes 0-3/${WAV.length}`);
      assert.equal((await ranged.arrayBuffer()).byteLength, 4);
      const missing = await handler(new Request("room-audio://aud_NOPE"));
      assert.equal(missing.status, 404);
    } finally {
      h.db.close();
    }
  });
});

describe("tts config (D-37b)", () => {
  const config: TtsConfig = {
    engine: "indextts2",
    engineVersion: "indextts2-2.0.0",
    python: "python.exe",
    script: "runner.py",
    modelDir: "models",
    voices: [{ id: "xiaoyu", displayName: "小雨", source: "reference", refAudio: "ref.wav" }],
  };

  it("maps voices to the contract shape", () => {
    assert.deepEqual(voiceOptionsOf(config), [
      { id: "xiaoyu", displayName: "小雨", engine: "indextts2", source: "reference", sampleRef: null },
    ]);
  });
});

describe("TtsRunner 进程生命周期（C酱 #152）", () => {
  const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
  const base = (script: string, patch: Partial<TtsConfig> = {}): TtsConfig => ({
    engine: "indextts2",
    engineVersion: "fake-1",
    // 用 node 冒充 python：spawn(execPath, [script]) 一样是「起一个子进程说行协议」
    python: process.execPath,
    script: join(fixtures, script),
    modelDir: fixtures,
    voices: [{ id: "xiaoyu", displayName: "小雨", source: "reference", refAudio: "ref.wav" }],
    ...patch,
  });
  const voice = { id: "xiaoyu", displayName: "小雨", source: "reference", refAudio: "ref.wav" } as const;

  it("加载超时不会把队列卡死：到点杀进程、报 backend_unavailable 那一类错误", async () => {
    const runner = new TtsRunner(base("tts-hang.mjs", { loadTimeoutMs: 300 }));
    try {
      const started = Date.now();
      await assert.rejects(
        () => runner.synthesize({ text: "你好", voice: voice as never, speed: 1, signal: new AbortController().signal }),
        (error: unknown) => error instanceof TtsUnavailableError && /加载超时/.test((error as Error).message),
      );
      assert.ok(Date.now() - started < 5_000, "不会一直等下去");
    } finally {
      runner.dispose();
    }
  });

  it("加载期间被取消：不再往 stdin 写、进程被杀掉", async () => {
    const runner = new TtsRunner(base("tts-hang.mjs", { loadTimeoutMs: 30_000 }));
    const controller = new AbortController();
    try {
      const pending = runner.synthesize({
        text: "你好",
        voice: voice as never,
        speed: 1,
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(), 100);
      await assert.rejects(() => pending, (error: unknown) => /取消/.test((error as Error).message));
    } finally {
      runner.dispose();
    }
  });

  it("杀掉进程之后下一次合成会重新起（引用不会串到旧进程上）", async () => {
    const runner = new TtsRunner(base("tts-ok.mjs"));
    try {
      const first = await runner.synthesize({ text: "第一句", voice: voice as never, speed: 1, signal: new AbortController().signal });
      assert.ok(first.bytes.length > 0);
      runner.dispose(); // 相当于超时 / 取消把进程杀了
      const second = await runner.synthesize({ text: "第二句", voice: voice as never, speed: 1, signal: new AbortController().signal });
      assert.ok(second.bytes.length > 0, "重启之后还能合成");
    } finally {
      runner.dispose();
    }
  });

  // 林离 #163 必须改 2：等回应这段在 try/finally 外，失败 / 超时 / 取消时临时 wav 不删
  const tempWavs = () => readdirSync(tmpdir()).filter((name) => name.startsWith(`room-tts-${process.pid}-`));

  it("waitChildExit 能分出「真的退出了」和「等到上限还没退」（林离 #165 复审必须改 2）", async () => {
    const fake = (mode: "exited" | "close-soon" | "never"): ChildExitLike => ({
      exitCode: mode === "exited" ? 0 : null,
      signalCode: null,
      once: (_event: "close", fn: () => void) => {
        if (mode === "close-soon") setTimeout(() => fn(), 5);
        return undefined;
      },
      removeListener: () => undefined,
    });
    assert.equal(await waitChildExit(fake("exited"), 1_000), true, "已经退出：立刻 true");
    assert.equal(await waitChildExit(fake("close-soon"), 1_000), true, "等到 close：true");
    const started = Date.now();
    assert.equal(await waitChildExit(fake("never"), 60), false, "等到上限：false，不能当成退出");
    assert.ok(Date.now() - started >= 40, "确实等满了上限");
  });

  it("引擎写了一半报失败：临时 wav 不能留在系统临时目录（林离 #163）", async () => {
    const runner = new TtsRunner(base("tts-fail-after-write.mjs"));
    const before = tempWavs();
    try {
      await assert.rejects(
        () => runner.synthesize({ text: "你好", voice: voice as never, speed: 1, signal: new AbortController().signal }),
        (error: unknown) => error instanceof TtsFailedError && /simulated failure/.test((error as Error).message),
      );
      assert.deepEqual(tempWavs().filter((name) => !before.includes(name)), [], "失败的临时 wav 要删掉");
    } finally {
      runner.dispose();
    }
  });

  it("卸载回 failed（CUDA 释放出错）时杀进程兜底，下一次合成重新起进程（林离 #165 复审必须改 1）", async () => {
    const runner = new TtsRunner(base("tts-unload-fail.mjs"));
    try {
      const first = await runner.synthesize({ text: "第一句", voice: voice as never, speed: 1, signal: new AbortController().signal });
      assert.ok(first.bytes.length > 0);
      const started = Date.now();
      await runner.unload(); // 引擎回 failed → 杀进程 → 等退出 → 返回
      assert.ok(Date.now() - started < 5_000, "不能一直等下去");
      const second = await runner.synthesize({ text: "第二句", voice: voice as never, speed: 1, signal: new AbortController().signal });
      assert.ok(second.bytes.length > 0, "进程被杀之后重新起还能合成");
    } finally {
      runner.dispose();
    }
  });

  it("上一次没收尾的临时 wav，在起新进程前清掉（林离 #165 复审必须改 2）", async () => {
    const stale = join(tmpdir(), `room-tts-${process.pid}-r99.wav`);
    writeFileSync(stale, Buffer.from("RIFF"));
    const runner = new TtsRunner(base("tts-ok.mjs"));
    try {
      const first = await runner.synthesize({ text: "你好", voice: voice as never, speed: 1, signal: new AbortController().signal });
      assert.ok(first.bytes.length > 0);
      assert.equal(existsSync(stale), false, "起进程前要把旧的清掉");
    } finally {
      runner.dispose();
    }
  });

  it("超时杀掉进程后，等它停下来再删掉写了一半的 wav（林离 #163）", async () => {
    const runner = new TtsRunner(base("tts-hang-after-write.mjs", { timeoutMs: 300 }));
    const before = tempWavs();
    try {
      await assert.rejects(
        () => runner.synthesize({ text: "你好", voice: voice as never, speed: 1, signal: new AbortController().signal }),
        (error: unknown) => error instanceof TtsFailedError && /超时/.test((error as Error).message),
      );
      assert.deepEqual(tempWavs().filter((name) => !before.includes(name)), [], "超时留下的临时 wav 也要删掉");
    } finally {
      runner.dispose();
    }
  });

  // 林离 #163 必须改 1：切到画图前要真的释放显存，而且等到释放完才放行
  it("unload 等到引擎确认释放才返回；之后还能继续合成", async () => {
    const runner = new TtsRunner(base("tts-ok.mjs"));
    try {
      assert.equal(tempWavs().length, 0, "前置：没有遗留临时文件");
      await runner.unload(); // 没有进程：空操作，不能抛
      const first = await runner.synthesize({ text: "第一句", voice: voice as never, speed: 1, signal: new AbortController().signal });
      assert.ok(first.bytes.length > 0);
      const started = Date.now();
      await runner.unload();
      assert.ok(Date.now() - started >= 80, "假引擎故意 120ms 才回 unloaded：主控端必须等到回应");
      const second = await runner.synthesize({ text: "第二句", voice: voice as never, speed: 1, signal: new AbortController().signal });
      assert.ok(second.bytes.length > 0, "卸载之后再来合成要能重新加载");
    } finally {
      runner.dispose();
    }
  });
});

describe("语音任务去重（C酱 #152 必须改 1）", () => {
  it("自动任务还没跑完时点「播放」：复用同一个任务，不重复合成", async () => {
    const h = await makeHarness();
    try {
      let release!: () => void;
      h.runner.gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const auto = await h.service.play(sourceOf(h), { authorization: "reply_as_voice" });
      for (let i = 0; i < 400 && h.runner.calls.length === 0; i += 1) await new Promise((r) => setTimeout(r, 5));
      assert.equal(h.runner.calls.length, 1, "自动任务已经在合成");

      const manual = await h.service.play(sourceOf(h));
      assert.equal(
        (manual as { job: MediaJob }).job.id,
        (auto as { job: MediaJob }).job.id,
        "同一来源 + 同一段文本：直接复用那个在跑的任务",
      );

      release();
      await settle(h.service);
      assert.equal(getMediaJob(h.db, (auto as { job: MediaJob }).job.id)!.state, "succeeded");
      assert.equal(h.runner.calls.length, 1, "引擎只调一次，没有第二次合成");
      assert.equal(listMediaJobs(h.db, { kind: "chat", conversationId: h.conversationId }).length, 1);
    } finally {
      h.db.close();
    }
  });
});
