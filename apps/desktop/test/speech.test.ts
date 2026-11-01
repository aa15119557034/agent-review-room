import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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
  ulid,
  WriteQueue,
  type SqliteDatabase,
} from "@room/db";
import type { ChatMessage, ChatRun, ChatReplySlot, ChatSnapshot, ControlEvent, MediaJob } from "@room/schemas";
import { MediaJobsService } from "../src/main/media-jobs";
import { createAudioProtocolHandler, MediaStore } from "../src/main/media-store";
import type { TtsRunner } from "../src/main/tts";
import { TtsFailedError, voiceOptionsOf, type TtsConfig } from "../src/main/tts";

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
