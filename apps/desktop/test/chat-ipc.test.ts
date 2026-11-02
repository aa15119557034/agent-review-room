import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  insertChatMessage,
  listLatestProjectNotes,
  upsertImmersiveSettings,
  insertChatRun,
  insertChatSlot,
  insertChatSnapshot,
  insertChatSummary,
  insertMediaJob,
  getChatSnapshot,
  getChatMessage,
  getChatWindowDraft,
  currentChatWindow,
  listChatSlotsForMessage,
  listChatSummaries,
  insertFile,
  insertImageRef,
  insertSticker,
  insertVoiceRecording,
  markVoiceReady,
  openDatabase,
  ulid,
  WriteQueue,
} from "@room/db";
import {
  CHAT_LIMITS,
  ChatHistorySummary,
  ChatMessage,
  MediaJob as MediaJobSchema,
  ChatRun,
  ChatSnapshot,
  ControlEvent,
  attachmentImageBlock,
  attachmentImageSlotMarker,
  attachmentManifestBlock,
  type AgentEvent,
  type AgentModelSettings,
  type CommandRequest,
  type ProfileModels,
} from "@room/schemas";
import { sha256Hex, type AgentAdapter } from "@room/core";
import { ChatError, ChatService, type ChatRunTarget } from "../src/main/chat";
import { NotesService } from "../src/main/notes";
import { CHAT_MATERIAL_MAX_CHARS, CHAT_MATERIAL_PROMPT_HEADROOM } from "../src/main/chat-material";
import { Repository } from "../src/main/repository";
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

const NOW = "2026-10-26T00:00:00.000Z";
const NODE_URL = "http://192.168.1.20:7420";
const ID = "0".repeat(26);

const fakeSafeStorage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (plain: string) => Buffer.from(plain, "utf8"),
  decryptString: (encrypted: Buffer) => encrypted.toString("utf8"),
};

type Script = Record<string, unknown>[];

function fakeAdapter(script: Script): AgentAdapter {
  return {
    id: "fake",
    kind: "api",
    initialize: async () => ({ streaming: true, permissionRequests: false, readOnly: true }),
    startSession: async () => ({ sessionId: "sess_1", adapterId: "fake" }),
    closeSession: async () => undefined,
    run: async function* (_sessionId, runId) {
      let seq = 0;
      for (const part of script) {
        yield { eventId: runId + "-" + seq, runId, seq: seq++, ts: NOW, ...part } as AgentEvent;
      }
    },
  };
}

function reply(text: string): Script {
  return [
    { type: "message_delta", text: "想一下" },
    { type: "message_complete", text: JSON.stringify({ kind: "reply", text }) },
    { type: "completed" },
  ];
}

/** D-45：历史摘要 Run 的输出是纯文本 */
function summaryReply(text: string): Script {
  return [
    { type: "message_complete", text },
    { type: "completed" },
  ];
}

function skip(): Script {
  return [
    { type: "message_complete", text: JSON.stringify({ kind: "skip" }) },
    { type: "completed" },
  ];
}

/** C-42e：回答里带媒体意图（speak / draw 原样放进信封，内容合不合格由 extractMediaIntent 判） */
function replyWithMedia(text: string, media: Record<string, unknown>): Script {
  return [
    { type: "message_complete", text: JSON.stringify({ kind: "reply", text, ...media }) },
    { type: "completed" },
  ];
}

interface Harness {
  chat: ChatService;
  repo: Repository;
  db: ReturnType<typeof openDatabase>;
  events: ControlEvent[];
  conversationId: string;
  /** 每次 adapterFactory 收到的目标（看模型有没有传下去） */
  targets: ChatRunTarget[];
  /** D-36b：file ref → 文本（测试注入） */
  fileTexts: Map<string, string>;
  /** 撤回时 main 会通知它取消画图任务（ADR-004 §3a） */
  cancelledMedia: string[][];
  /** C-42a：每次 adapter.run 收到的输入（看带没带图、带的是什么） */
  runInputs: { agent: string; input: { attachments?: unknown; imageSlot?: unknown; content: string } }[];
  /** D-39：沉浸模式自动排的任务（测试记下来看） */
  mediaCalls: { kind: "draw" | "speak" | "stop" | "fail-speak"; source?: unknown; intentHash?: string; scope?: unknown }[];
}

async function makeHarness(
  options: {
    scripts?: Record<string, Script>;
    paused?: string[];
    unavailableProfiles?: string[];
    /** 这些 agent 的 adapter 一直等到被 abort 才结束（测取消 / 中断修复） */
    hold?: string[];
    profileModels?: ProfileModels[];
    modelSettings?: Record<string, AgentModelSettings>;
    /** C-42a：节点报的能力（不传 = 老节点，什么都不支持） */
    capabilities?: { attachments?: boolean };
    /** C-42a：图片库里的字节（ref → Buffer）；不传 = 没图，带图会起跑失败 */
    imageBytes?: Map<string, Buffer>;
    /** 可控时钟（撤回 / 重新编辑的时间窗口） */
    now?: () => string;
    /** 取消画图任务先失败几次（测撤回不被拖垮、会重试） */
    cancelMediaFails?: number;
    /** D-45：写历史摘要的 Run 回什么（默认一串要点） */
    summaryScript?: Script;
    /** D-45：摘要 Run 先等这个 promise 再回（测「跑的时候来源被撤回」） */
    summaryGate?: Promise<void>;
    /** #187：节点探测（换窗口 redo 的闸门） */
    probe?: (params: { baseUrl: string; token: string; profileId: string }) => Promise<NodeTestResult>;
    /** D-39：自动画图先等这个 promise 再建任务 */
    drawGate?: Promise<void>;
    /** D-39：自动语音排任务时故意失败（测「前置条件不满足要补一条失败任务」） */
    speakMediaFails?: boolean;
  } = {},
): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "room-chat-ipc-"));
  dirs.push(dir);
  const db = openDatabase(join(dir, "test.db"));
  const queue = new WriteQueue();
  const repo = new Repository(db, queue);
  const settings = new SettingsStore(join(dir, "settings.json"), fakeSafeStorage);
  const fileTexts = new Map<string, string>();
  const cancelledMedia: string[][] = [];
  const imageBytes = options.imageBytes ?? new Map<string, Buffer>();
  const runInputs: Harness["runInputs"] = [];
  const mediaCalls: Harness["mediaCalls"] = [];
  const speakRequests: Harness["speakRequests"] = [];
  settings.upsertNode("controller-local", { baseUrl: NODE_URL, token: "t".repeat(40) });
  await repo.upsertNodeRow({ id: "controller-local", label: "主控机", baseUrl: NODE_URL });

  const addAgent = db.prepare(
    "INSERT INTO agents (id, display_name, color, role_note, can_discuss, can_summarize, can_execute, node_id, " +
      "profile_id, chat_profile_id, chat_persona, paused_by_user, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, 1, 0, 0, 'controller-local', ?, ?, ?, ?, ?, ?)",
  );
  const paused = new Set(options.paused ?? []);
  for (const [id, name] of [["claude", "C酱"], ["codex", "林离"], ["deepseek", "汐"]] as const) {
    addAgent.run(
      id, name, "#1f6b55", "人设", id + "-review", id + "-chat", "你是" + name, paused.has(id) ? 1 : 0, NOW, NOW,
    );
  }

  for (const [agentId, settings] of Object.entries(options.modelSettings ?? {})) {
    db.prepare("UPDATE agents SET model_settings = ? WHERE id = ?").run(JSON.stringify(settings), agentId);
  }

  const scripts = options.scripts ?? {};
  const events: ControlEvent[] = [];
  const targets: ChatRunTarget[] = [];
  const held = new Set(options.hold ?? []);
  const notesService = new NotesService({ db, queue, emit: (event) => events.push(ControlEvent.parse(event)) });
  const chat = new ChatService({
    db,
    queue,
    repo,
    settings,
    emit: (event) => events.push(ControlEvent.parse(event)),
    notes: notesService,
    readFileText: (ref) => fileTexts.get(ref) ?? null,
    readImage: (ref) => imageBytes.get(ref) ?? null,
    drawMedia: async (source, draw, intentHash) => {
      mediaCalls.push({ kind: "draw", source, intentHash });
      if (options.drawGate !== undefined) await options.drawGate;
      insertMediaJob(db, MediaJobSchema.parse({
        id: "mjob_" + ulid(), kind: "draw", state: "queued", authorization: "immersive", source, intentHash,
        draw: { ...draw, backend: "auto" }, route: null, remoteRunId: null, result: null, speech: null,
        failure: null, cancelReason: null, createdAt: NOW, startedAt: null, finishedAt: null,
      }));
    },
    speakMedia: async (source, intentHash) => {
      if (options.speakMediaFails === true) throw new Error("没有能用的声音");
      mediaCalls.push({ kind: "speak", source, intentHash });
      insertMediaJob(db, MediaJobSchema.parse({
        id: "mjob_" + ulid(), kind: "speech", state: "queued", authorization: "immersive", source, intentHash,
        draw: null, route: null, remoteRunId: null, result: null, speech: null,
        failure: null, cancelReason: null, createdAt: NOW, startedAt: null, finishedAt: null,
      }));
    },
    failSpeech: async (source, intentHash, message) => {
      mediaCalls.push({ kind: "fail-speak", source, intentHash });
      void message;
    },
    stopMedia: async (scope) => {
      mediaCalls.push({ kind: "stop", scope });
    },
    speakAnswer: async (source) => {
      speakRequests.push({ messageId: source.messageId, agent: source.agent });
    },
    cancelMediaJobs: async (messageIds) => {
      if ((options.cancelMediaFails ?? 0) > 0) {
        options.cancelMediaFails = (options.cancelMediaFails ?? 0) - 1;
        throw new Error("画图服务暂时不可用");
      }
      cancelledMedia.push([...messageIds]);
    },
    adapterFactory: async (target: ChatRunTarget) => {
      targets.push(target);
      if (held.has(target.agent)) {
        return {
          id: "hold",
          kind: "api" as const,
          initialize: async () => ({ streaming: true, permissionRequests: false, readOnly: true }),
          startSession: async () => ({ sessionId: "hold", adapterId: "hold" }),
          closeSession: async () => undefined,
          run: async function* (_sessionId, runId, _input, opts) {
            await new Promise<void>((resolve) => {
              if (opts.signal.aborted) resolve();
              else opts.signal.addEventListener("abort", () => resolve(), { once: true });
            });
            yield { eventId: runId + "-0", runId, seq: 0, ts: NOW, type: "cancelled" } as AgentEvent;
          },
        };
      }
      const inner = fakeAdapter(scripts[target.agent] ?? reply("好的"));
      return {
        ...inner,
        run: (sessionId, runId, input, opts) => {
          runInputs.push({ agent: target.agent as string, input: input as never });
          const isSummaryRun = (input as { content?: string }).content?.includes("写摘要") === true;
          if (!isSummaryRun) return inner.run(sessionId, runId, input, opts);
          const summary = fakeAdapter(options.summaryScript ?? summaryReply("- 要点：用户下周三去上海"));
          return (async function* () {
            if (options.summaryGate !== undefined) await options.summaryGate;
            yield* summary.run(sessionId, runId, input, opts);
          })();
        },
      };
    },
    probe: options.probe ?? (async (params) => ({
      reachable: true,
      health: {
        protocol: 1,
        nodeId: "controller-local",
        profiles: ["claude-chat", "codex-chat", "deepseek-chat"],
        activeRuns: 0,
        maxConcurrentRuns: 4,
        leaseMs: 30_000,
        heartbeatMs: 5_000,
        ...(options.profileModels === undefined ? {} : { profileModels: options.profileModels }),
        ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }),
      },
      // profileAvailable 是 per-profile 的：同节点上不同秘书不能共用一次探测结果
      profileAvailable: !(options.unavailableProfiles ?? []).includes(params.profileId),
      latencyMs: 1,
    })),
    now: options.now ?? (() => NOW),
  });

  const conversation = await chat.createConversation({
    type: "chat.conversation.create",
    members: { kind: "direct", agent: "deepseek" },
    title: null,
  } as never);
  return { chat, repo, db, events, conversationId: conversation.id, targets, fileTexts, cancelledMedia, runInputs, speakRequests, mediaCalls, notes: notesService };
}

const userMessageId = (n: number): string => "cmsg_" + String(n).padStart(26, "0");

async function settle(chat: ChatService): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (chat.activeCount() === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("chat runs did not settle");
}

function send(conversationId: string, messageId: string, text: string): CommandRequest<"chat.send"> {
  return {
    type: "chat.send",
    conversationId,
    messageId,
    content: { kind: "text", text, attachments: [] },
    mentions: { kind: "none" },
    quoteMessageId: null,
    replacesMessageId: null,
  };
}

describe("chat send voice (D-34b)", () => {
  it("sends a voice message from a ready recording and marks edited text", async () => {
    const h = await makeHarness();
    try {
      const audio = `aud_${ulid()}`;
      insertVoiceRecording(h.db, {
        recording: { audio, durationMs: 1200, status: "transcribing", transcript: null, error: null, createdAt: "2026-10-26T00:00:00.000Z" } as never,
        sha256: "d".repeat(64),
        mime: "audio/wav",
        bytes: 100,
      });
      markVoiceReady(h.db, audio, {
        text: "你好，在吗",
        language: "zh",
        source: "transcribed",
        engine: { engine: "faster-whisper", model: "small" },
      });

      const sent = await h.chat.send({
        ...send(h.conversationId, userMessageId(140), ""),
        content: { kind: "voice", audio, transcriptText: "你好，在吗" },
      });
      assert.equal(sent.message.content.kind, "voice");
      if (sent.message.content.kind === "voice") {
        assert.equal(sent.message.content.audio, audio);
        assert.equal(sent.message.content.durationMs, 1200);
        assert.equal(sent.message.content.transcript.source, "transcribed");
      }

      const edited = await h.chat.send({
        ...send(h.conversationId, userMessageId(141), ""),
        content: { kind: "voice", audio, transcriptText: "你好，在吗？" },
      });
      if (edited.message.content.kind === "voice") {
        assert.equal(edited.message.content.transcript.text, "你好，在吗？");
        assert.equal(edited.message.content.transcript.source, "edited");
      }
      await settle(h.chat);
    } finally {
      h.db.close();
    }
  });

  it("refuses to send a recording that is still transcribing", async () => {
    const h = await makeHarness();
    try {
      const audio = `aud_${ulid()}`;
      insertVoiceRecording(h.db, {
        recording: { audio, durationMs: 1200, status: "transcribing", transcript: null, error: null, createdAt: "2026-10-26T00:00:00.000Z" } as never,
        sha256: "e".repeat(64),
        mime: "audio/wav",
        bytes: 100,
      });
      await assert.rejects(
        () =>
          h.chat.send({
            ...send(h.conversationId, userMessageId(142), ""),
            content: { kind: "voice", audio, transcriptText: "还没好" },
          }),
        (error: unknown) => (error as { code?: string }).code === "invalid_state",
      );
    } finally {
      h.db.close();
    }
  });
});

describe("chat send attachments (D-34a / D-36b)", () => {
  it("refuses to send when a text file's bytes are gone, but binary files still go (林离 #124)", async () => {
    const h = await makeHarness();
    try {
      // 记录说是文本文件，但 userData/files/<sha> 已经不在了
      const lost = `file_${ulid()}`;
      insertFile(h.db, {
        ref: lost as never,
        sha256: "a".repeat(64),
        name: "说明.md",
        mime: "text/plain",
        bytes: 12,
        isText: true,
        createdAt: NOW,
      });
      await assert.rejects(
        () =>
          h.chat.send({
            ...send(h.conversationId, userMessageId(31), "看文件"),
            content: { kind: "text", text: "看文件", attachments: [{ kind: "file", ref: lost, name: "说明.md" }] },
          }),
        (error: unknown) =>
          (error as { code?: string }).code === "validation_failed" && /找不到/.test((error as Error).message),
        "文本文件本体丢了要明确报错，不能只留一个文件名",
      );

      // 二进制文件本来就没有正文：照常发
      const binary = `file_${ulid()}`;
      insertFile(h.db, {
        ref: binary as never,
        sha256: "b".repeat(64),
        name: "a.zip",
        mime: "application/zip",
        bytes: 10,
        isText: false,
        createdAt: NOW,
      });
      const sent = await h.chat.send({
        ...send(h.conversationId, userMessageId(32), "看压缩包"),
        content: { kind: "text", text: "看压缩包", attachments: [{ kind: "file", ref: binary, name: "a.zip" }] },
      });
      assert.equal(sent.message.content.kind, "text");
      await settle(h.chat);
    } finally {
      h.db.close();
    }
  });
  it("sends a text file (content goes into the prompt), turns images into placeholders for a node that cannot take them, and sends stickers", async () => {
    const h = await makeHarness();
    const validation = (error: unknown) => (error as { code?: string }).code === "validation_failed";
    try {
      // 图片：引用有效就收下；但这位节点没报 capabilities.attachments，图发不过去 → 正文里给名字占位
      const imageRef = `img_${ulid()}`;
      insertImageRef(h.db, {
        ref: imageRef as never,
        purpose: "chat",
        sha256: "e".repeat(64),
        mime: "image/png",
        bytes: 2048,
        width: 64,
        height: 64,
        createdAt: NOW,
      });
      const sentImage = await h.chat.send({
        ...send(h.conversationId, userMessageId(21), "看图"),
        content: { kind: "text", text: "看图", attachments: [{ kind: "image", ref: imageRef }] },
      });
      await settle(h.chat);
      const imageSnapshot = getChatSnapshot(h.db, sentImage.runs[0]!.snapshotId)!;
      assert.equal(imageSnapshot.attachments, undefined, "节点不支持带图：Snapshot 里没有附件清单");
      assert.ok(imageSnapshot.content.includes("[图片：图片.png]"), "看不到图的人拿到名字占位（ADR-004 §2）");
      assert.equal(h.runInputs[0]?.input.attachments, undefined, "StartRun 里不带图");

      // 文件：真的存过、能当文本读，就能发；正文进 Prompt 的资料区，指纹跟着变
      const fileRef = `file_${ulid()}`;
      insertFile(h.db, {
        ref: fileRef as never,
        sha256: "f".repeat(64),
        name: "说明.md",
        mime: "text/plain",
        bytes: 24,
        isText: true,
        createdAt: NOW,
      });
      h.fileTexts.set(fileRef, "上面这段是文件里的正文。");
      const sentFile = await h.chat.send({
        ...send(h.conversationId, userMessageId(24), "看文件"),
        content: { kind: "text", text: "看文件", attachments: [{ kind: "file", ref: fileRef, name: "说明.md" }] },
      });
      const snapshotId = sentFile.runs[0]?.snapshotId;
      assert.ok(snapshotId !== undefined);
      const snapshot = getChatSnapshot(h.db, snapshotId!);
      assert.ok(snapshot !== null);
      assert.ok(snapshot!.content.includes("[文件：说明.md]"));
      assert.ok(snapshot!.content.includes("上面这段是文件里的正文。"));
      assert.equal(snapshot!.contentHash, sha256Hex(snapshot!.content));
      assert.equal(snapshot!.attachments, undefined);

      // 表情：库里没有就拒，有就发得出去
      await assert.rejects(
        () => h.chat.send({ ...send(h.conversationId, userMessageId(22), "表情"), content: { kind: "sticker", stickerId: `stk_${ulid()}` } }),
        validation,
        "unknown sticker",
      );
      const stickerImage = `img_${ulid()}`;
      insertImageRef(h.db, {
        ref: stickerImage as never,
        purpose: "sticker",
        sha256: "b".repeat(64),
        mime: "image/png",
        bytes: 100,
        width: 10,
        height: 10,
        createdAt: NOW,
      });
      const stickerId = `stk_${ulid()}`;
      insertSticker(h.db, { id: stickerId as never, image: stickerImage as never, label: "比心", createdAt: NOW });
      const sentSticker = await h.chat.send({
        ...send(h.conversationId, userMessageId(23), "表情"),
        content: { kind: "sticker", stickerId },
      });
      assert.equal(sentSticker.message.content.kind, "sticker");
      await settle(h.chat);
    } finally {
      h.db.close();
    }
  });
});
describe("chat service (D-31b)", () => {
  it("sends a direct message, runs it and stores the reply", async () => {
    const h = await makeHarness({ scripts: { deepseek: reply("在。") } });
    try {
      const result = await h.chat.send(send(h.conversationId, userMessageId(1), "在吗"));
      assert.equal(result.message.sender, "user");
      assert.equal(result.slots.length, 1);
      assert.equal(result.slots[0]?.outcome, "running");
      assert.equal(result.runs.length, 1);
      await settle(h.chat);

      const page = h.chat.listMessages({
        type: "chat.messages.list",
        conversationId: h.conversationId,
        limit: 20,
      } as never);
      assert.equal(page.messages.length, 2);
      const agent = page.messages.find((message) => message.sender === "agent");
      assert.ok(agent !== undefined && agent.sender === "agent");
      assert.equal(agent.text, "在。");
      const slot = h.chat.listSlotRuns(result.slots[0]!.id);
      assert.equal(slot.length, 1);
      assert.equal(slot[0]?.state, "COMPLETED");
      assert.ok(h.events.some((event) => event.type === "chat.message.created"));
      assert.ok(h.events.some((event) => event.type === "chat.slot.updated" && (event as never as { slot: { outcome: string } }).slot.outcome === "answered"));
    } finally {
      h.db.close();
    }
  });

  it("stores the qualified media intent with the reply and logs the dropped ones (C-42e / D-31d)", async () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((arg) => String(arg)).join(" "));
    };
    const lastReply = (h: Harness) => {
      const page = h.chat.listMessages({ type: "chat.messages.list", conversationId: h.conversationId, limit: 20 } as never);
      return page.messages.find((message) => message.sender === "agent");
    };
    try {
      // 合格的两项都存进去
      const draw = { prompt: "小鲸鱼", size: "1024x1024" };
      const h = await makeHarness({ scripts: { deepseek: replyWithMedia("给你画一张", { speak: true, draw }) } });
      try {
        await h.chat.send(send(h.conversationId, userMessageId(11), "画一张"));
        await settle(h.chat);
        const agent = lastReply(h);
        assert.ok(agent !== undefined && agent.sender === "agent");
        assert.deepEqual(agent.mediaIntent, { speak: true, draw });
        assert.deepEqual(warnings, []);
        // 界面拿到的是 chat.message.created 里这条（不是重新查一次），媒体意图要一起带上。
        // 发消息时也会推一条 created（你那条），所以取最后一条秘书的
        const created = h.events
          .filter((event): event is Extract<ControlEvent, { type: "chat.message.created" }> => event.type === "chat.message.created")
          .at(-1);
        assert.ok(created !== undefined);
        assert.deepEqual(created.message.sender === "agent" ? created.message.mediaIntent : undefined, { speak: true, draw });
      } finally {
        h.db.close();
      }

      // 朗读过滤后超过 2000 字：speak 丢掉、draw 保留，丢掉的原值进审计日志
      const long = "说".repeat(2500);
      const h2 = await makeHarness({ scripts: { deepseek: replyWithMedia(long, { speak: true, draw }) } });
      try {
        await h2.chat.send(send(h2.conversationId, userMessageId(12), "画一张"));
        await settle(h2.chat);
        const agent = lastReply(h2);
        assert.ok(agent !== undefined && agent.sender === "agent");
        assert.deepEqual(agent.mediaIntent, { draw });
        assert.equal(warnings.length, 1);
        assert.match(warnings[0]!, /dropped an invalid media intent/);
        assert.match(warnings[0]!, /"speak":true/);
      } finally {
        h2.db.close();
      }

      // 尺寸不合格：draw 丢掉、speak 保留；一项都不合格时不传 mediaIntent（列是 NULL）
      const h3 = await makeHarness({
        scripts: {
          deepseek: replyWithMedia("好", { speak: true, draw: { prompt: "小鲸鱼", size: "8192x8192" } }),
        },
      });
      try {
        await h3.chat.send(send(h3.conversationId, userMessageId(13), "画一张"));
        await settle(h3.chat);
        const agent = lastReply(h3);
        assert.ok(agent !== undefined && agent.sender === "agent");
        assert.deepEqual(agent.mediaIntent, { speak: true });
        assert.equal(warnings.length, 2);
      } finally {
        h3.db.close();
      }
    } finally {
      console.warn = originalWarn;
    }
  });

  it("treats skip as answered-no for unmentioned group members, but as failure when required", async () => {
    const h = await makeHarness({ scripts: { deepseek: skip(), codex: skip() } });
    try {
      const group = await h.chat.createConversation({
        type: "chat.conversation.create",
        members: { kind: "group", agents: ["deepseek", "codex"] },
        title: null,
      } as never);
      const sent = await h.chat.send(send(group.id, userMessageId(2), "随便聊聊"));
      await settle(h.chat);
      const list = h.chat.listMessages({ type: "chat.messages.list", conversationId: group.id, limit: 10 } as never);
      assert.equal(list.messages.length, 1, "skip 不建消息");
      const slot = h.chat.listSlotRuns(sent.slots[0]!.id)[0];
      assert.equal(slot?.state, "COMPLETED");
      const slots = list.slots;
      assert.deepEqual(slots.map((item) => item.outcome).sort(), ["skipped", "skipped"]);

      // 单聊里 skip 算失败
      const fail = await h.chat.send(send(h.conversationId, userMessageId(3), "必须回答"));
      await settle(h.chat);
      const failedSlot = h.chat.listMessages({ type: "chat.messages.list", conversationId: h.conversationId, limit: 10 } as never);
      assert.equal(failedSlot.slots[0]?.outcome, "failed");
      assert.equal(failedSlot.slots[0]?.failure?.kind, "skip_not_allowed");
      assert.equal(h.chat.listSlotRuns(fail.slots[0]!.id)[0]?.state, "COMPLETED");
    } finally {
      h.db.close();
    }
  });

  it("is idempotent by messageId and rejects the same id with different intent", async () => {
    const h = await makeHarness();
    try {
      const command = send(h.conversationId, userMessageId(4), "同一条");
      const first = await h.chat.send(command);
      const second = await h.chat.send(command);
      assert.equal(second.message.id, first.message.id);
      assert.equal(h.chat.listMessages({ type: "chat.messages.list", conversationId: h.conversationId, limit: 10 } as never).messages.length, 1);

      await assert.rejects(
        h.chat.send({ ...command, content: { kind: "text", text: "改了内容", attachments: [] } }),
        (error: unknown) => (error as { code?: string }).code === "idempotency_conflict",
      );
      await settle(h.chat);
    } finally {
      h.db.close();
    }
  });

  it("rate limits after CHAT_LIMITS.messagesPerMinute", async () => {
    const h = await makeHarness();
    try {
      for (let i = 0; i < 6; i += 1) await h.chat.send(send(h.conversationId, userMessageId(10 + i), "第 " + i + " 条"));
      await assert.rejects(
        h.chat.send(send(h.conversationId, userMessageId(20), "第 7 条")),
        (error: unknown) => (error as { code?: string }).code === "rate_limited",
      );
      await settle(h.chat);
    } finally {
      h.db.close();
    }
  });

  it("marks paused agents unavailable and starts no run for them", async () => {
    const h = await makeHarness({ paused: ["deepseek"] });
    try {
      const result = await h.chat.send(send(h.conversationId, userMessageId(30), "在吗"));
      assert.equal(result.slots[0]?.outcome, "unavailable");
      assert.equal(result.slots[0]?.unavailableReason, "paused_by_user");
      assert.equal(result.runs.length, 0);
      assert.equal(h.chat.activeCount(), 0);
    } finally {
      h.db.close();
    }
  });

  it("retries a failed slot with attempt + 1 and the new answer", async () => {
    const scripts: Record<string, Script> = { deepseek: [{ type: "error", reason: "internal", message: "boom" }] };
    const h = await makeHarness({ scripts });
    try {
      const sent = await h.chat.send(send(h.conversationId, userMessageId(50), "先失败一次"));
      await settle(h.chat);
      const failed = h.chat.listMessages({ type: "chat.messages.list", conversationId: h.conversationId, limit: 10 } as never);
      assert.equal(failed.slots[0]?.outcome, "failed");
      assert.equal(failed.slots[0]?.attempt, 1);

      scripts["deepseek"] = reply("第二次答上了");
      const retried = await h.chat.retry({ type: "chat.retry", slotId: sent.slots[0]!.id } as never);
      assert.equal(retried.slot.outcome, "running");
      assert.equal(retried.slot.attempt, 2);
      await settle(h.chat);

      const after = h.chat.listMessages({ type: "chat.messages.list", conversationId: h.conversationId, limit: 10 } as never);
      assert.equal(after.slots[0]?.outcome, "answered");
      assert.equal(after.slots[0]?.attempt, 2);
      const runs = h.chat.listSlotRuns(sent.slots[0]!.id);
      assert.equal(runs.length, 2);
      assert.equal(runs[1]?.state, "COMPLETED");
      assert.equal(after.messages.filter((message) => message.sender === "agent").length, 1);
    } finally {
      h.db.close();
    }
  });

  it("probes per profile even on the same node", async () => {
    const h = await makeHarness({ unavailableProfiles: ["codex-chat"] });
    try {
      const group = await h.chat.createConversation({
        type: "chat.conversation.create",
        members: { kind: "group", agents: ["claude", "codex"] },
        title: null,
      } as never);
      const sent = await h.chat.send(send(group.id, userMessageId(60), "都在吗"));
      const byAgent = Object.fromEntries(sent.slots.map((slot) => [slot.agent, slot]));
      assert.equal(byAgent["claude"]?.outcome, "running");
      assert.equal(byAgent["codex"]?.outcome, "unavailable");
      assert.equal(byAgent["codex"]?.unavailableReason, "offline");
      assert.equal(sent.runs.length, 1, "只有 claude 起 Run");
      await settle(h.chat);
    } finally {
      h.db.close();
    }
  });

  it("two concurrent sends with the same messageId return the first result, not internal", async () => {
    const h = await makeHarness();
    try {
      const command = send(h.conversationId, userMessageId(70), "并发同一条");
      const results = await Promise.allSettled([h.chat.send(command), h.chat.send(command)]);
      assert.equal(results.filter((result) => result.status === "fulfilled").length, 2, JSON.stringify(results));
      const ids = new Set(
        results.map((result) => (result as PromiseFulfilledResult<{ message: { id: string } }>).value.message.id),
      );
      assert.equal(ids.size, 1);
      const stored = h.db.prepare("SELECT count(*) AS n FROM chat_messages WHERE sender = 'user'").get() as { n: number };
      assert.equal(stored.n, 1);
      await settle(h.chat);
    } finally {
      h.db.close();
    }
  });

  it("cannot exceed the per-minute limit with concurrent sends", async () => {
    const h = await makeHarness();
    try {
      const results = await Promise.allSettled(
        Array.from({ length: 7 }, (_, index) => h.chat.send(send(h.conversationId, userMessageId(80 + index), "并发 " + index))),
      );
      const rejected = results.filter((result) => result.status === "rejected");
      assert.equal(rejected.length, 1);
      assert.equal((rejected[0] as PromiseRejectedResult).reason.code, "rate_limited");
      const stored = h.db.prepare("SELECT count(*) AS n FROM chat_messages WHERE sender = 'user'").get() as { n: number };
      assert.equal(stored.n, CHAT_LIMITS.messagesPerMinute);
      await settle(h.chat);
    } finally {
      h.db.close();
    }
  });

  it("classifies a blank reply as empty_output, not parse_error", async () => {
    const h = await makeHarness({ scripts: { deepseek: reply("   ") } });
    try {
      const sent = await h.chat.send(send(h.conversationId, userMessageId(90), "说点什么"));
      await settle(h.chat);
      const page = h.chat.listMessages({ type: "chat.messages.list", conversationId: h.conversationId, limit: 10 } as never);
      assert.equal(page.slots[0]?.outcome, "failed");
      assert.equal(page.slots[0]?.failure?.kind, "empty_output");
      assert.equal(page.messages.length, 1);
      assert.equal(h.chat.listSlotRuns(sent.slots[0]!.id)[0]?.state, "COMPLETED");
    } finally {
      h.db.close();
    }
  });

  it("retries with the context from before the original message", async () => {
    const scripts: Record<string, Script> = { deepseek: [{ type: "error", reason: "internal", message: "boom" }] };
    const h = await makeHarness({ scripts });
    try {
      const first = await h.chat.send(send(h.conversationId, userMessageId(95), "问题 A"));
      await settle(h.chat);
      scripts["deepseek"] = reply("好的");
      await h.chat.send(send(h.conversationId, userMessageId(96), "后来的 B"));
      await h.chat.send(send(h.conversationId, userMessageId(97), "后来的 C"));
      await settle(h.chat);

      const retried = await h.chat.retry({ type: "chat.retry", slotId: first.slots[0]!.id } as never);
      const snapshot = h.chat.getSnapshot(retried.run.snapshotId);
      assert.ok(!snapshot.includedMessageIds.includes(userMessageId(96)), "重试看不到 B");
      assert.ok(!snapshot.includedMessageIds.includes(userMessageId(97)), "重试看不到 C");
      assert.ok(snapshot.includedMessageIds.includes(userMessageId(95)), "能看到原来的问题");
      await settle(h.chat);
    } finally {
      h.db.close();
    }
  });

  it("counts only agent messages as unread", async () => {
    const h = await makeHarness();
    try {
      await h.chat.send(send(h.conversationId, userMessageId(98), "在吗"));
      await settle(h.chat);
      const item = h.chat.listConversations().find((entry) => entry.conversation.id === h.conversationId);
      assert.ok(item !== undefined);
      assert.equal(item.unreadCount, 1, "只有秘书那一条算未读");
    } finally {
      h.db.close();
    }
  });

  it("selects the chat model from modelSettings and passes it to the node", async () => {
    const efforts = [
      { id: "low", displayName: "低", note: null },
      { id: "high", displayName: "高", note: null },
    ];
    const h = await makeHarness({
      modelSettings: {
        deepseek: { primaryModel: "deepseek-flash", fallbackModel: null, effort: { chat: "high", discussion: null, summary: null } },
      },
      profileModels: [
        {
          profileId: "deepseek-chat",
          models: [{ id: "deepseek-flash", displayName: "Flash", efforts, defaultEffort: "low" }],
        },
      ],
    });
    try {
      const sent = await h.chat.send(send(h.conversationId, userMessageId(100), "用哪个模型？"));
      const run = h.chat.getRun(sent.runs[0]!.id);
      assert.deepEqual(run.model, { model: "deepseek-flash", effort: "high", usedFallback: false, effortSource: "configured" });
      await settle(h.chat);
      // adapter 是异步起的：等 Run 跑完再看节点收到的目标
      assert.deepEqual(h.targets[0]?.model, { model: "deepseek-flash", effort: "high" });
      assert.equal(h.targets[0]?.profileId, "deepseek-chat");
    } finally {
      h.db.close();
    }
  });

  it("falls back to the fallback model and marks usedFallback", async () => {
    const h = await makeHarness({
      modelSettings: {
        deepseek: { primaryModel: "missing-model", fallbackModel: "deepseek-flash", effort: { chat: null, discussion: null, summary: null } },
      },
      profileModels: [
        {
          profileId: "deepseek-chat",
          models: [{ id: "deepseek-flash", displayName: "Flash", efforts: [{ id: "low", displayName: "低", note: null }], defaultEffort: "low" }],
        },
      ],
    });
    try {
      const sent = await h.chat.send(send(h.conversationId, userMessageId(101), "备选"));
      assert.deepEqual(h.chat.getRun(sent.runs[0]!.id).model, {
        model: "deepseek-flash",
        effort: "low",
        usedFallback: true,
        effortSource: "node_default",
      });
      await settle(h.chat);
    } finally {
      h.db.close();
    }
  });

  it("marks the slot unavailable when neither configured model exists", async () => {
    const h = await makeHarness({
      modelSettings: {
        deepseek: { primaryModel: "ghost-a", fallbackModel: "ghost-b", effort: { chat: null, discussion: null, summary: null } },
      },
      profileModels: [
        { profileId: "deepseek-chat", models: [{ id: "deepseek-flash", displayName: "Flash", efforts: [], defaultEffort: null }] },
      ],
    });
    try {
      const sent = await h.chat.send(send(h.conversationId, userMessageId(102), "模型都不在"));
      assert.equal(sent.slots[0]?.outcome, "unavailable");
      assert.equal(sent.slots[0]?.unavailableReason, "unconfigured");
      assert.equal(sent.runs.length, 0);
      assert.equal(h.targets.length, 0);
    } finally {
      h.db.close();
    }
  });

  it("a failing media cancel does not break the retract and is retried once", async () => {
    const h = await makeHarness({ cancelMediaFails: 1 });
    try {
      const sent = await h.chat.send(send(h.conversationId, userMessageId(121), "画一张"));
      await settle(h.chat);
      const retracted = await h.chat.retract({ type: "chat.retract", messageId: sent.message.id } as never);
      assert.equal(retracted.message.state, "retracted");
      // 第二次尝试成功，回调收到了 id
      assert.ok(h.cancelledMedia.at(-1)?.includes(sent.message.id));
    } finally {
      h.db.close();
    }
  });
  it("retracting a message also tells main to cancel draw jobs from it and its replies (ADR-004 §3a)", async () => {
    const h = await makeHarness({ scripts: { deepseek: reply("画好啦") } });
    try {
      const sent = await h.chat.send(send(h.conversationId, userMessageId(120), "画一张"));
      await settle(h.chat);
      const replyRow = h.db
        .prepare("SELECT id FROM chat_messages WHERE conversation_id = ? AND sender = 'agent' LIMIT 1")
        .get(h.conversationId) as { id: string } | undefined;
      assert.ok(replyRow !== undefined);
      await h.chat.retract({ type: "chat.retract", messageId: sent.message.id } as never);
      assert.deepEqual(h.cancelledMedia.at(-1)?.slice().sort(), [sent.message.id, replyRow.id].sort());
    } finally {
      h.db.close();
    }
  });
  it("re-edits a retracted message as a new message with new slots", async () => {
    const h = await makeHarness();
    try {
      const first = await h.chat.send(send(h.conversationId, userMessageId(110), "打错了"));
      await settle(h.chat);
      await h.chat.retract({ type: "chat.retract", messageId: first.message.id } as never);

      const edited = await h.chat.send({
        ...send(h.conversationId, userMessageId(111), "改好了"),
        replacesMessageId: first.message.id,
      });
      assert.equal(edited.message.replacesMessageId, first.message.id);
      assert.equal(edited.slots[0]?.outcome, "running");
      const old = h.chat.listMessages({ type: "chat.messages.list", conversationId: h.conversationId, limit: 20 } as never);
      assert.equal(old.messages.find((message) => message.id === first.message.id)?.state, "retracted");
      assert.equal(old.slots.find((slot) => slot.userMessageId === first.message.id)?.outcome, "retracted");
      await settle(h.chat);
    } finally {
      h.db.close();
    }
  });

  it("cancels a running reply and lets the late terminal close only the run", async () => {
    const h = await makeHarness({ hold: ["deepseek"] });
    try {
      const sent = await h.chat.send(send(h.conversationId, userMessageId(120), "慢慢答"));
      const cancelled = await h.chat.cancelReply({ type: "chat.cancelReply", slotId: sent.slots[0]!.id } as never);
      assert.equal(cancelled.outcome, "cancelled");
      await settle(h.chat);
      const runs = h.chat.listSlotRuns(sent.slots[0]!.id);
      assert.equal(runs[0]?.state, "CANCELLED");
      assert.equal(h.chat.listMessages({ type: "chat.messages.list", conversationId: h.conversationId, limit: 10 } as never).slots[0]?.outcome, "cancelled");
    } finally {
      h.db.close();
    }
  });

  it("repairs an interrupted chat run on startup", async () => {
    const h = await makeHarness();
    try {
      // 直接造一个「上次崩溃时停在 RUNNING」的库状态（不经过 ChatService.send，避免和活着的执行器抢）
      const messageId = userMessageId(130);
      insertChatMessage(h.db, {
        message: {
          id: messageId,
          conversationId: h.conversationId,
          createdAt: NOW,
          sender: "user",
          content: { kind: "text", text: "重启前", attachments: [] },
          mentions: { kind: "none" },
          quoteMessageId: null,
          replacesMessageId: null,
          state: "sent",
          retractedAt: null,
        },
      });
      const slotId = "slot_" + ulid();
      const runId = "run_" + ulid();
      insertChatSlot(h.db, {
        id: slotId,
        conversationId: h.conversationId,
        userMessageId: messageId,
        agent: "deepseek",
        required: true,
        outcome: "running",
        runId,
        attempt: 1,
        replyMessageId: null,
        failure: null,
        unavailableReason: null,
        createdAt: NOW,
        finishedAt: null,
      });
      insertChatSnapshot(h.db, {
        id: "snap_" + ulid(),
        purpose: "reply",
        conversationId: h.conversationId,
        userMessageId: messageId,
        agent: "deepseek",
        content: "上下文",
        contentHash: "a".repeat(64),
        nonce: "0123456789abcdef",
        memorySlot: null,
        includedMessageIds: [messageId],
        includedSummaryIds: [],
        adapterVersion: "chat-v2",
        tokenEstimate: 1,
        createdAt: NOW,
      });
      const snapshotId = h.db.prepare("SELECT id FROM chat_snapshots").get() as { id: string };
      insertChatRun(h.db, {
        id: runId,
        kind: "chat",
        purpose: "reply",
        conversationId: h.conversationId,
        slotId,
        agent: "deepseek",
        snapshotId: snapshotId.id,
        snapshotHash: "a".repeat(64),
        finalPromptHash: null,
        memoryManifest: null,
        model: null,
        adapterId: "remote:deepseek-chat",
        state: "QUEUED",
        substate: null,
        failureReason: null,
        createdAt: NOW,
        startedAt: null,
        finishedAt: null,
      });
      h.db.prepare("UPDATE chat_runs SET state = 'RUNNING', substate = 'active', started_at = ? WHERE id = ?").run(NOW, runId);

      const repaired = await h.chat.repairInterrupted();
      assert.equal(repaired, 1);
      const runs = h.chat.listSlotRuns(slotId);
      assert.equal(runs[0]?.state, "FAILED");
      assert.equal(runs[0]?.failureReason, "interrupted");
      const page = h.chat.listMessages({ type: "chat.messages.list", conversationId: h.conversationId, limit: 10 } as never);
      assert.equal(page.slots[0]?.outcome, "failed");
      assert.equal(page.slots[0]?.failure?.kind, "interrupted");
    } finally {
      h.db.close();
    }
  });

  it("converts selected messages into a topic with one chat_material", async () => {
    const h = await makeHarness({ scripts: { deepseek: reply("我也觉得") } });
    try {
      await h.chat.send(send(h.conversationId, userMessageId(140), "把这段转成议题"));
      await settle(h.chat);
      const page = h.chat.listMessages({ type: "chat.messages.list", conversationId: h.conversationId, limit: 10 } as never);
      const ids = page.messages.map((message) => message.id);

      const result = await h.chat.toTopic({
        type: "chat.toTopic",
        conversationId: h.conversationId,
        messageIds: ids,
        name: "从聊天来的议题",
      } as never);

      assert.equal(result.project.name, "从聊天来的议题");
      assert.equal(result.project.fromConversationId, h.conversationId);
      assert.equal(result.material.kind, "chat_material");
      assert.deepEqual([...result.material.chatMessageIds].sort(), [...ids].sort());
      assert.ok(result.material.content.includes("把这段转成议题"));
      assert.ok(result.material.content.includes("我也觉得"));
      assert.ok(result.material.content.includes("汐"), "秘书用显示名");

      // repository 读得出来（讨论室后面直接用它当材料）
      const stored = h.repo.getMessage(result.material.id);
      assert.equal(stored.kind, "chat_material");
      if (stored.kind === "chat_material") assert.deepEqual([...stored.chatMessageIds].sort(), [...ids].sort());
    } finally {
      h.db.close();
    }
  });

  it("refuses to convert retracted messages or messages from another conversation", async () => {
    const h = await makeHarness();
    try {
      const sent = await h.chat.send(send(h.conversationId, userMessageId(141), "撤回我"));
      await settle(h.chat);
      await h.chat.retract({ type: "chat.retract", messageId: sent.message.id } as never);
      await assert.rejects(
        h.chat.toTopic({
          type: "chat.toTopic",
          conversationId: h.conversationId,
          messageIds: [sent.message.id],
          name: "不该建出来",
        } as never),
        (error: unknown) => (error as { code?: string }).code === "invalid_state",
      );

      const other = await h.chat.createConversation({
        type: "chat.conversation.create",
        members: { kind: "direct", agent: "codex" },
        title: null,
      } as never);
      await assert.rejects(
        h.chat.toTopic({
          type: "chat.toTopic",
          conversationId: h.conversationId,
          messageIds: [userMessageId(142)],
          name: "别处的消息",
        } as never),
        (error: unknown) => (error as { code?: string }).code === "validation_failed",
      );
      assert.notEqual(other.id, h.conversationId);

      await assert.rejects(
        h.chat.toTopic({
          type: "chat.toTopic",
          conversationId: h.conversationId,
          messageIds: [userMessageId(143), userMessageId(143)],
          name: "重复",
        } as never),
        (error: unknown) => (error as { code?: string }).code === "validation_failed",
      );
    } finally {
      h.db.close();
    }
  });

  it("leaves headroom between the material cap and the node prompt limit", async () => {
    const h = await makeHarness();
    try {
      const ids: string[] = [];
      for (let index = 0; index < 99; index += 1) {
        const id = "cmsg_" + String(index).padStart(26, "0");
        ids.push(id);
        insertChatMessage(h.db, {
          message: {
            id,
            conversationId: h.conversationId,
            createdAt: NOW,
            sender: "user",
            content: { kind: "text", text: "长".repeat(20_000), attachments: [] },
            mentions: { kind: "none" },
            quoteMessageId: null,
            replacesMessageId: null,
            state: "sent",
            retractedAt: null,
          },
        });
      }

      // 99 条 × 2 万字 = 198 万，超过「2,000,000 − Prompt 余量」
      await assert.rejects(
        h.chat.toTopic({ type: "chat.toTopic", conversationId: h.conversationId, messageIds: ids, name: "太大" } as never),
        (error: unknown) => (error as { code?: string }).code === "validation_failed",
      );
      // 98 条可以，材料本身离节点上限还有余量
      const ok = await h.chat.toTopic({
        type: "chat.toTopic",
        conversationId: h.conversationId,
        messageIds: ids.slice(0, 98),
        name: "刚好",
      } as never);
      assert.ok(ok.material.content.length > 1_900_000);
      assert.ok(ok.material.content.length <= CHAT_MATERIAL_MAX_CHARS - CHAT_MATERIAL_PROMPT_HEADROOM);
    } finally {
      h.db.close();
    }
  });

  it("refuses to build a material larger than the message limit", async () => {
    const h = await makeHarness();
    try {
      const ids: string[] = [];
      for (let index = 0; index < 101; index += 1) {
        const id = "cmsg_" + String(index).padStart(26, "0");
        ids.push(id);
        insertChatMessage(h.db, {
          message: {
            id,
            conversationId: h.conversationId,
            createdAt: NOW,
            sender: "user",
            content: { kind: "text", text: "长".repeat(20_000), attachments: [] },
            mentions: { kind: "none" },
            quoteMessageId: null,
            replacesMessageId: null,
            state: "sent",
            retractedAt: null,
          },
        });
      }
      await assert.rejects(
        h.chat.toTopic({ type: "chat.toTopic", conversationId: h.conversationId, messageIds: ids, name: "太大" } as never),
        (error: unknown) => (error as { code?: string }).code === "validation_failed",
      );
      assert.equal((h.db.prepare("SELECT count(*) AS n FROM projects").get() as { n: number }).n, 0);
    } finally {
      h.db.close();
    }
  });

  it("refuses a second concurrent re-edit of the same message", async () => {
    const h = await makeHarness();
    try {
      const sent = await h.chat.send(send(h.conversationId, userMessageId(160), "原文"));
      await settle(h.chat);
      await h.chat.retract({ type: "chat.retract", messageId: sent.message.id } as never);

      const results = await Promise.allSettled([
        h.chat.send({ ...send(h.conversationId, userMessageId(161), "改一"), replacesMessageId: sent.message.id }),
        h.chat.send({ ...send(h.conversationId, userMessageId(162), "改二"), replacesMessageId: sent.message.id }),
      ]);
      const fulfilled = results.filter((result) => result.status === "fulfilled");
      const rejected = results.filter((result) => result.status === "rejected");
      assert.equal(fulfilled.length, 1, JSON.stringify(results));
      assert.equal(rejected.length, 1);
      assert.equal((rejected[0] as PromiseRejectedResult).reason.code, "invalid_state");
      assert.equal(
        (h.db.prepare("SELECT count(*) AS n FROM chat_messages WHERE replaces_message_id = ?").get(sent.message.id) as { n: number }).n,
        1,
        "只有一个新消息指向原消息",
      );
      await settle(h.chat);
    } finally {
      h.db.close();
    }
  });

  it("re-edit window counts from retracting, not from sending", async () => {
    let clock = NOW;
    const at = (minutes: number) => new Date(Date.parse(NOW) + minutes * 60_000).toISOString();
    const h = await makeHarness({ now: () => clock });
    try {
      const sent = await h.chat.send(send(h.conversationId, userMessageId(150), "早发的"));
      await settle(h.chat);
      // 第 4 分钟撤回：距离「发出」已经快 5 分钟
      clock = at(4);
      await h.chat.retract({ type: "chat.retract", messageId: sent.message.id } as never);
      // 撤回后再过 4 分钟（距发出 8 分钟）：仍能重新编辑
      clock = at(8);
      const edited = await h.chat.send({
        ...send(h.conversationId, userMessageId(151), "改好了"),
        replacesMessageId: sent.message.id,
      });
      assert.equal(edited.message.replacesMessageId, sent.message.id);
      await settle(h.chat);

      // 另一条：撤回后超过 5 分钟就不能再编辑
      const second = await h.chat.send(send(h.conversationId, userMessageId(152), "第二条"));
      await settle(h.chat);
      clock = at(9);
      await h.chat.retract({ type: "chat.retract", messageId: second.message.id } as never);
      clock = at(14);
      await assert.rejects(
        h.chat.send({ ...send(h.conversationId, userMessageId(153), "太晚了"), replacesMessageId: second.message.id }),
        (error: unknown) => (error as { code?: string }).code === "invalid_state",
      );
    } finally {
      h.db.close();
    }
  });

  it("retract window is exclusive at exactly five minutes", async () => {
    let clock = NOW;
    const h = await makeHarness({ now: () => clock });
    try {
      const sent = await h.chat.send(send(h.conversationId, userMessageId(154), "卡点"));
      await settle(h.chat);
      clock = new Date(Date.parse(NOW) + CHAT_LIMITS.retractWindowMs).toISOString();
      await assert.rejects(
        h.chat.retract({ type: "chat.retract", messageId: sent.message.id } as never),
        (error: unknown) => (error as { code?: string }).code === "invalid_state",
      );
    } finally {
      h.db.close();
    }
  });

  it("retracts a message and its slots", async () => {
    const h = await makeHarness({ scripts: { deepseek: reply("答完了") } });
    try {
      const sent = await h.chat.send(send(h.conversationId, userMessageId(40), "说点什么"));
      await settle(h.chat);
      const result = await h.chat.retract({ type: "chat.retract", messageId: sent.message.id } as never);
      assert.equal(result.message.state, "retracted");
      assert.equal(result.slots[0]?.outcome, "retracted");
      const list = h.chat.listMessages({ type: "chat.messages.list", conversationId: h.conversationId, limit: 10 } as never);
      assert.equal(list.messages.find((message) => message.id === sent.message.id)?.state, "retracted");
      // 撤回之后不能再发同一个 messageId（意图不同会冲突、相同会返回原消息）
      await assert.rejects(
        h.chat.send(send(h.conversationId, sent.message.id, "再说一次")),
        (error: unknown) => (error as { code?: string }).code === "idempotency_conflict",
      );
    } finally {
      h.db.close();
    }
  });
});

describe("chat prompt wiring (D-41)", () => {
  it("uses the core builder: format instructions first, reminder last, and the required rule in a direct chat", async () => {
    const h = await makeHarness();
    try {
      const sent = await h.chat.send(send(h.conversationId, userMessageId(41), "在吗"));
      const snapshot = getChatSnapshot(h.db, sent.runs[0]!.snapshotId)!;
      assert.equal(snapshot.adapterVersion, "chat-v4");
      assert.ok(snapshot.content.includes("回答格式（必须遵守）："));
      assert.ok(
        snapshot.content.trimEnd().endsWith("请按上面的「回答格式」只输出一个 JSON 对象。"),
        "结尾要再提醒一次",
      );
      assert.match(snapshot.content, /必须回答，不能用 skip/);
      assert.equal(snapshot.memorySlot, null, "记忆来源关着的时候不给节点槽位");
    } finally {
      h.db.close();
    }
  });

  it("tells unmentioned group members they may skip", async () => {
    const h = await makeHarness();
    try {
      const group = await h.chat.createConversation({
        type: "chat.conversation.create",
        members: { kind: "group", agents: ["deepseek", "codex"] },
        title: null,
      } as never);
      const sent = await h.chat.send(send(group.id, userMessageId(42), "随便聊聊"));
      await settle(h.chat);
      assert.equal(sent.runs.length, 2);
      for (const run of sent.runs) {
        const snapshot = getChatSnapshot(h.db, run.snapshotId)!;
        assert.match(snapshot.content, /没有点名你：觉得不需要你说话时回 skip/);
        assert.doesNotMatch(snapshot.content, /必须回答，不能用 skip/);
      }
    } finally {
      h.db.close();
    }
  });

  it("puts current summaries in the prompt, leaves stale ones out, and marks them stale on retract", async () => {
    const h = await makeHarness();
    try {
      const first = await h.chat.send(send(h.conversationId, userMessageId(43), "第一句"));
      await settle(h.chat);
      const coveringMessageId = userMessageId(43);
      const summaryRun = historySummaryRun(h, [coveringMessageId]);
      const currentSummary = summary(h, summaryRun, [coveringMessageId], "第一句在讲部署");
      insertChatSummary(h.db, currentSummary);

      // D-41b：只覆盖「秘书复述这条消息」的摘要（切段切在一问一答之间）也要一起失效
      const replyId = (h.db.prepare("SELECT id FROM chat_messages WHERE in_reply_to = ?").get(coveringMessageId) as { id: string }).id;
      const echoSummary = summary(h, historySummaryRun(h, [replyId]), [replyId], "汐复述了第一句");
      insertChatSummary(h.db, echoSummary);

      const sent = await h.chat.send(send(h.conversationId, userMessageId(44), "接着说"));
      const snapshot = getChatSnapshot(h.db, sent.runs[0]!.snapshotId)!;
      assert.ok(snapshot.content.includes("第一句在讲部署"), "current 的摘要进 Prompt");
      assert.deepEqual(snapshot.includedSummaryIds, [currentSummary.id, echoSummary.id]);

      // 撤回覆盖到的消息：两条摘要都变 stale、各推一次事件，之后的 Prompt 都不再带
      h.events.length = 0;
      await h.chat.retract({ type: "chat.retract", messageId: first.message.id } as never);
      const stale = listChatSummaries(h.db, h.conversationId);
      assert.equal(stale.find((s) => s.id === currentSummary.id)?.state, "stale", "覆盖撤回消息的摘要");
      assert.equal(stale.find((s) => s.id === echoSummary.id)?.state, "stale", "只覆盖复述的摘要一起失效");
      assert.deepEqual(
        h.events
          .filter((e) => e.type === "chat.summary.updated")
          .map((e) => (e as { summary: { id: string } }).summary.id)
          .sort(),
        [currentSummary.id, echoSummary.id].sort(),
      );

      const after = await h.chat.send(send(h.conversationId, userMessageId(45), "再说一句"));
      const afterSnapshot = getChatSnapshot(h.db, after.runs[0]!.snapshotId)!;
      assert.ok(!afterSnapshot.content.includes("第一句在讲部署"), "stale 的摘要不进任何 Snapshot");
      assert.ok(!afterSnapshot.content.includes("汐复述了第一句"), "只覆盖复述的摘要也不进");
      assert.deepEqual(afterSnapshot.includedSummaryIds, []);
    } finally {
      h.db.close();
    }
  });
});

/** 摘要来自一个 history_summary 的聊天 Run：先 Snapshot，再 Run（测试里直接写库） */
function historySummaryRun(h: Harness, covered: string[]): string {
  const content = "历史资料\n" + covered.join("\n");
  const snapshot = ChatSnapshot.parse({
    id: "snap_" + ulid(),
    purpose: "history_summary",
    conversationId: h.conversationId,
    userMessageId: null,
    agent: "deepseek",
    content,
    contentHash: sha256Hex(content),
    nonce: "0123456789abcdef",
    memorySlot: null,
    includedMessageIds: covered,
    includedSummaryIds: [],
    adapterVersion: "chat-v4",
    tokenEstimate: 10,
    createdAt: NOW,
  });
  insertChatSnapshot(h.db, snapshot);
  const run = ChatRun.parse({
    id: "run_" + ulid(),
    kind: "chat",
    purpose: "history_summary",
    conversationId: h.conversationId,
    slotId: null,
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
    createdAt: NOW,
    startedAt: null,
    finishedAt: null,
  });
  insertChatRun(h.db, run);
  return run.id;
}

function summary(h: Harness, runId: string, covered: string[], text: string) {
  return ChatHistorySummary.parse({
    id: "csum_" + ulid(),
    conversationId: h.conversationId,
    sourceMessageIds: covered,
    content: text,
    contentHash: sha256Hex(text),
    state: "current",
    runId,
    agent: "deepseek",
    createdAt: NOW,
  });
}

describe("chat images (C-42a / X-34b)", () => {
  const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  const shaBytes = (b: Buffer) => createHash("sha256").update(b).digest("hex");
  const visionModels = (vision: "yes" | "no" | "unknown") => [
    {
      profileId: "deepseek-chat",
      models: [{ id: "deepseek-flash", displayName: "DeepSeek", efforts: [], defaultEffort: null, vision }],
    },
  ];
  const modelSettings: AgentModelSettings = {
    primaryModel: "deepseek-flash",
    fallbackModel: null,
    effort: { chat: null, discussion: null, summary: null },
  };

  async function imageEnv(options: { capabilities?: { attachments?: boolean }; vision?: "yes" | "no" | "unknown"; withBytes?: boolean }) {
    const ref = `img_${ulid()}`;
    const h = await makeHarness({
      profileModels: visionModels(options.vision ?? "yes"),
      modelSettings: { deepseek: modelSettings },
      ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }),
      ...(options.withBytes === false ? {} : { imageBytes: new Map([[ref, PNG]]) }),
    });
    insertImageRef(h.db, {
      ref: ref as never,
      purpose: "chat",
      sha256: shaBytes(PNG),
      mime: "image/png",
      bytes: PNG.length,
      width: 2,
      height: 2,
      createdAt: NOW,
    });
    return { h, ref };
  }

  const imageMessage = (ref: string, n: number) => ({
    ...send(userMessageId(0), userMessageId(n), "看看这张"),
    content: { kind: "text" as const, text: "看看这张", attachments: [{ kind: "image" as const, ref }] },
  });

  it("sends the manifest, the image block and the bytes when the node and the model can take images", async () => {
    const { h, ref } = await imageEnv({ capabilities: { attachments: true } });
    try {
      const sent = await h.chat.send({ ...imageMessage(ref, 61), conversationId: h.conversationId });
      await settle(h.chat);
      const snapshot = getChatSnapshot(h.db, sent.runs[0]!.snapshotId)!;
      const manifest = [{ index: 1, ref, name: "图片.png", mime: "image/png", bytes: PNG.length, sha256: shaBytes(PNG) }];
      assert.deepEqual(snapshot.attachments, manifest, "清单按图片记录补齐（mime / bytes / sha256）");
      assert.equal(snapshot.imageSlot, attachmentImageSlotMarker(snapshot.nonce), "图片位置标记用 Snapshot 的 nonce");
      assert.ok(snapshot.content.startsWith(attachmentManifestBlock(manifest)), "content 以清单块开头");
      assert.ok(snapshot.content.includes("[图 1：图片.png]"), "图名进资料区");
      assert.ok(snapshot.content.includes(attachmentImageBlock(snapshot.nonce, 1)), "图片资料块在 content 里");
      const input = h.runInputs[0]!.input as { attachments?: { index: number; data: string; sha256: string }[]; imageSlot?: string };
      assert.equal(input.attachments?.[0]?.data, PNG.toString("base64"), "字节原样交给 Adapter");
      assert.equal(input.attachments?.[0]?.sha256, shaBytes(PNG));
      assert.equal(input.imageSlot, snapshot.imageSlot);
    } finally {
      h.db.close();
    }
  });

  it("gives 「[图片：名字]」 placeholders without sending bytes when the model cannot see images or the node is old", async () => {
    const cases = [
      { capabilities: { attachments: true }, vision: "no" as const },
      { capabilities: { attachments: true }, vision: "unknown" as const },
      { vision: "yes" as const },
    ];
    for (const options of cases) {
      const { h, ref } = await imageEnv(options);
      try {
        const sent = await h.chat.send({ ...imageMessage(ref, 62), conversationId: h.conversationId });
        await settle(h.chat);
        const snapshot = getChatSnapshot(h.db, sent.runs[0]!.snapshotId)!;
        assert.equal(snapshot.attachments, undefined, JSON.stringify(options));
        assert.ok(snapshot.content.includes("[图片：图片.png]"), JSON.stringify(options));
        assert.ok(!snapshot.content.includes("[图 1：图片.png]"), "没有清单就不列图名");
        assert.equal(h.runInputs[0]?.input.attachments, undefined, JSON.stringify(options));
      } finally {
        h.db.close();
      }
    }
  });

  it("dedupes the same image attached twice (the manifest requires a unique sha256)", async () => {
    const { h, ref } = await imageEnv({ capabilities: { attachments: true } });
    try {
      const sent = await h.chat.send({
        ...imageMessage(ref, 64),
        conversationId: h.conversationId,
        content: {
          kind: "text",
          text: "两张一样的",
          attachments: [
            { kind: "image", ref },
            { kind: "image", ref },
          ],
        },
      });
      await settle(h.chat);
      assert.equal(sent.message.content.kind === "text" ? sent.message.content.attachments.length : 0, 2, "消息原样存两条");
      const snapshot = getChatSnapshot(h.db, sent.runs[0]!.snapshotId)!;
      assert.equal(snapshot.attachments?.length, 1, "清单里只留一张（不然 AttachmentManifest 会抛 ZodError）");
      assert.equal((h.runInputs[0]!.input.attachments as unknown[]).length, 1, "StartRun 里也只带一张");
    } finally {
      h.db.close();
    }
  });

  it("fails the run before sending anything when the image bytes are gone from the local store", async () => {
    const { h, ref } = await imageEnv({ capabilities: { attachments: true }, withBytes: false });
    try {
      const sent = await h.chat.send({ ...imageMessage(ref, 63), conversationId: h.conversationId });
      await settle(h.chat);
      const list = h.chat.listMessages({ type: "chat.messages.list", conversationId: h.conversationId, limit: 10 } as never);
      const slot = list.slots.find((item) => item.userMessageId === sent.message.id)!;
      assert.equal(slot.outcome, "failed");
      assert.equal(slot.failure?.kind, "run_failed");
      assert.equal(h.runInputs.length, 0, "起跑前就失败，一个请求都没发");
    } finally {
      h.db.close();
    }
  });
  it("keeps the original file name when the renderer sends one (D-43 / C-42i)", async () => {
    const { h, ref } = await imageEnv({ capabilities: { attachments: true } });
    try {
      const sent = await h.chat.send({
        ...imageMessage(ref, 65),
        conversationId: h.conversationId,
        content: {
          kind: "text",
          text: "看看这张",
          attachments: [{ kind: "image", ref, name: "海边落日.png" }],
        },
      });
      await settle(h.chat);
      const snapshot = getChatSnapshot(h.db, sent.runs[0]!.snapshotId)!;
      assert.equal(
        sent.message.content.kind === "text" ? (sent.message.content.attachments[0] as { name: string }).name : null,
        "海边落日.png",
        "消息里存的是原名",
      );
      assert.equal(snapshot.attachments?.[0]?.name, "海边落日.png", "清单里也是原名");
      assert.ok(snapshot.content.includes("[图 1：海边落日.png]"), "Prompt 资料区显示原名");
      assert.ok(!snapshot.content.includes("图片.png"), "不再出现占位名");

      const blind = await h.chat.send({
        ...imageMessage(ref, 66),
        conversationId: h.conversationId,
        content: { kind: "text", text: "再看看", attachments: [{ kind: "image", ref }] },
      });
      await settle(h.chat);
      const blindSnapshot = getChatSnapshot(h.db, blind.runs[0]!.snapshotId)!;
      assert.equal(blindSnapshot.attachments?.[0]?.name, "图片.png", "不带名字的老界面还是按 mime 起名");
      assert.ok(blindSnapshot.content.includes("[图 1：图片.png]"), "Prompt 里显示占位名");
    } finally {
      h.db.close();
    }
  });
});

describe("replyAsVoice (D-37b)", () => {
  it("排语音合成：只有开了「用语音回」的用户消息，回答落库后 main 才让语音服务合成", async () => {
    const h = await makeHarness({ scripts: { deepseek: reply("好的") } });
    try {
      const plain = await h.chat.send(send(h.conversationId, userMessageId(71), "普通消息"));
      await settle(h.chat);
      assert.equal(h.speakRequests.length, 0, "没开语音回就不合成");

      const voice = await h.chat.send({
        ...send(h.conversationId, userMessageId(72), "用语音回我"),
        replyAsVoice: true,
      } as never);
      await settle(h.chat);
      await new Promise((resolve) => setTimeout(resolve, 20)); // speakAnswer 是落库之后异步排的
      const answer = (h.db.prepare("SELECT id FROM chat_messages WHERE in_reply_to = ?").get(voice.message.id) as { id: string }).id;
      assert.deepEqual(h.speakRequests, [{ messageId: answer, agent: "deepseek" }], "回答落库后才排合成");
      assert.ok(plain.message.id !== voice.message.id);
    } finally {
      h.db.close();
    }
  });
});


// ================================================================ D-46a 项目笔记

describe("project notes wiring (D-46a)", () => {
  const textScript = (text: string): Script => [
    { type: "message_complete", text: JSON.stringify({ kind: "reply", text }) },
    { type: "completed" },
  ];
  const scopeOf = (h: Harness) => ({ kind: "conversation" as const, conversationId: h.conversationId });

  it("stores one version from a reply, strips the block, and the next Snapshot carries it", async () => {
    const h = await makeHarness({ scripts: { deepseek: textScript("好的\n\n\u0060\u0060\u0060room-note\n# 笔记\n- 约定\n\u0060\u0060\u0060") } });
    try {
      await h.chat.send(send(h.conversationId, userMessageId(300), "记住这个约定"));
      await settle(h.chat);

      const notes = listLatestProjectNotes(h.db, scopeOf(h));
      assert.equal(notes.length, 1);
      assert.equal(notes[0]!.content, "# 笔记\n- 约定");
      assert.equal(notes[0]!.reason, "reply");
      assert.equal(notes[0]!.agent, "deepseek");
      assert.equal(notes[0]!.source?.kind, "chat_run");
      assert.ok(h.events.some((event) => event.type === "projectNote.created"), "发事件");

      // 回答正文里不再显示 room-note 段
      // 正文去掉 room-note 段由契约的 extractRoomNote 覆盖（schemas 测试）

      // 第一条回答是在笔记之前拼的：Snapshot 里没有笔记版本
      const firstRun = h.db.prepare("SELECT snapshot_id FROM chat_runs ORDER BY created_at, rowid LIMIT 1").get() as { snapshot_id: string };
      assert.equal(getChatSnapshot(h.db, firstRun.snapshot_id)!.projectNoteId ?? null, null);

      // 第二条回答的 Snapshot 带上了这份笔记（版本 1），正文在不可信边界里
      await h.chat.send(send(h.conversationId, userMessageId(301), "接着聊"));
      await settle(h.chat);
      const secondRun = h.db.prepare("SELECT snapshot_id FROM chat_runs ORDER BY created_at, rowid LIMIT 1 OFFSET 1").get() as { snapshot_id: string };
      const snapshot = getChatSnapshot(h.db, secondRun.snapshot_id)!;
      assert.equal(snapshot.projectNoteId, notes[0]!.id);
      assert.ok(snapshot.content.includes("项目笔记（第 1 版）"));
      assert.ok(snapshot.content.includes("- 约定"));
      assert.ok(snapshot.content.includes("<UNTRUSTED_CHAT_DATA_" + snapshot.nonce + ">"));
    } finally {
      h.db.close();
    }
  });

  it("two room-note blocks: no note, the reply still goes through, rejected event", async () => {
    const two = "好的\n\u0060\u0060\u0060room-note\nA\n\u0060\u0060\u0060\n中间\n\u0060\u0060\u0060room-note\nB\n\u0060\u0060\u0060";
    const h = await makeHarness({ scripts: { deepseek: textScript(two) } });
    try {
      await h.chat.send(send(h.conversationId, userMessageId(310), "记两段"));
      await settle(h.chat);
      assert.equal(listLatestProjectNotes(h.db, scopeOf(h)).length, 0);
      const rejected = h.events.find((event) => event.type === "projectNote.rejected");
      assert.ok(rejected && rejected.type === "projectNote.rejected" && rejected.reason === "multiple");
      // 正文去掉 room-note 段由契约的 extractRoomNote 覆盖（schemas 测试）
    } finally {
      h.db.close();
    }
  });
});

// ================================================================ D-46b 换窗口

describe("chat windows (D-46b)", () => {
  const seedUserMessage = (h: Harness, id: string, text: string) => {
    insertChatMessage(h.db, {
      message: {
        id,
        conversationId: h.conversationId,
        createdAt: NOW,
        sender: "user",
        content: { kind: "text", text, attachments: [] },
        mentions: { kind: "none" },
        quoteMessageId: null,
        replacesMessageId: null,
        state: "sent",
        retractedAt: null,
      },
    });
  };

  it("写交接的 Run 把正文写进草稿；confirm 建窗口和交接笔记", async () => {
    const h = await makeHarness({
      scripts: { deepseek: [{ type: "message_complete", text: "## 做到哪了\n- 聊了天气" }, { type: "completed" }] },
    });
    try {
      seedUserMessage(h, userMessageId(400), "旧窗口的最后一句话");
      const draft = await h.chat.prepareWindow({
        type: "chat.window.prepare",
        conversationId: h.conversationId,
        agent: "deepseek",
      } as never);
      assert.equal(draft.state, "pending");
      assert.ok(draft.runId !== null, "起了写交接的 Run");
      assert.equal(draft.startsAfterMessageId, userMessageId(400));
      await settle(h.chat);

      const stored = getChatWindowDraft(h.db, draft.id)!;
      assert.equal(stored.content, "## 做到哪了\n- 聊了天气");
      assert.equal(stored.contentBy, "agent");
      assert.equal(stored.contentHash, sha256Hex("## 做到哪了\n- 聊了天气"));

      const done = await h.chat.confirmWindow({
        type: "chat.window.confirm",
        draftId: draft.id,
        expectedContentHash: stored.contentHash,
      } as never);
      assert.equal(done.window.index, 2);
      assert.equal(done.window.startsAfterMessageId, userMessageId(400));
      assert.equal(done.note.reason, "window_handoff");
      assert.equal(done.note.content, stored.content);
      assert.equal(done.note.source?.kind, "chat_run");
      assert.equal(currentChatWindow(h.db, h.conversationId, "deepseek")?.id, done.window.id);

      const status = h.chat.windowStatuses(h.conversationId).find((item) => item.agent === "deepseek")!;
      assert.equal(status.index, 2);
      assert.equal(status.window?.id, done.window.id);
      assert.equal(status.pendingDraft, null);
      assert.equal(h.chat.windowList(h.conversationId).length, 1);
    } finally {
      h.db.close();
    }
  });

  it("取消：不留窗口、不留笔记，Run 只有一个终止事件", async () => {
    const h = await makeHarness();
    try {
      seedUserMessage(h, userMessageId(410), "先聊这句");
      const draft = await h.chat.prepareWindow({
        type: "chat.window.prepare",
        conversationId: h.conversationId,
        agent: "deepseek",
        writeYourself: true,
      } as never);
      assert.equal(draft.content, "");
      const cancelled = await h.chat.cancelWindow({ type: "chat.window.cancel", draftId: draft.id } as never);
      assert.equal(cancelled.state, "cancelled");
      assert.equal(h.chat.windowList(h.conversationId).length, 0);
      assert.equal(listLatestProjectNotes(h.db, { kind: "conversation", conversationId: h.conversationId }).length, 0);
    } finally {
      h.db.close();
    }
  });

  it("换了窗口以后，回答的 Snapshot 只带窗口里的消息和摘要", async () => {
    const h = await makeHarness();
    try {
      seedUserMessage(h, userMessageId(420), "窗口外的一句话");
      const oldSummary = summary(h, historySummaryRun(h, [userMessageId(420)]), [userMessageId(420)], "窗口外的摘要");
      insertChatSummary(h.db, oldSummary);
      assert.equal(
        h.chat.windowStatuses(h.conversationId).find((item) => item.agent === "deepseek")!.compactionsInWindow,
        1,
        "第 1 个窗口里有一份摘要",
      );

      const draft = await h.chat.prepareWindow({
        type: "chat.window.prepare",
        conversationId: h.conversationId,
        agent: "deepseek",
        writeYourself: true,
      } as never);
      await h.chat.confirmWindow({
        type: "chat.window.confirm",
        draftId: draft.id,
        expectedContentHash: sha256Hex(""),
      } as never);
      assert.equal(
        h.chat.windowStatuses(h.conversationId).find((item) => item.agent === "deepseek")!.compactionsInWindow,
        0,
        "跨窗口边界的摘要不算这个窗口里的",
      );

      const sent = await h.chat.send(send(h.conversationId, userMessageId(421), "换了窗口以后的新问题"));
      await settle(h.chat);
      const snapshot = getChatSnapshot(h.db, sent.runs[0]!.snapshotId)!;
      assert.ok(!snapshot.includedMessageIds.includes(userMessageId(420)));
      assert.ok(!snapshot.content.includes("窗口外的一句话"));
      assert.ok(!snapshot.content.includes("窗口外的摘要"));
      assert.ok(snapshot.includedMessageIds.includes(userMessageId(421)));
    } finally {
      h.db.close();
    }
  });
});

﻿
// ================================================================ D-45 历史摘要接线

/** 旧消息：放在撤回窗口内（最近 5 分钟），新建的那条在最后 */
async function seedOldMessages(h: Harness, count: number): Promise<void> {
  const base = Date.parse(NOW) - 240_000;
  for (let i = 1; i <= count; i += 1) {
    const message = ChatMessage.parse({
      id: "cmsg_" + ulid(),
      conversationId: h.conversationId,
      createdAt: new Date(base + i * 1_000).toISOString(),
      sender: "user",
      content: { kind: "text", text: "旧消息第" + i + "条", attachments: [] },
      mentions: { kind: "none" },
      quoteMessageId: null,
      replacesMessageId: null,
      state: "sent",
      retractedAt: null,
    });
    insertChatMessage(h.db, { message });
  }
}

const summaryRuns = (h: Harness) =>
  h.db.prepare("SELECT id, state FROM chat_runs WHERE purpose = 'history_summary'").all() as {
    id: string;
    state: string;
  }[];

async function waitFor(check: () => boolean, ms = 4_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting");
}

describe("chat history summary wiring (D-45)", () => {
  it("攒够旧消息后写一份摘要，下一次回答的 Prompt 带上它、不再带被摘要的原文", async () => {
    const h = await makeHarness({ summaryScript: summaryReply("- 用户下周三去上海出差") });
    try {
      await seedOldMessages(h, 40);
      await h.chat.send(send(h.conversationId, userMessageId(901), "现在几点"));
      await settle(h.chat);

      await waitFor(() => listChatSummaries(h.db, h.conversationId).length === 1);
      const summary = listChatSummaries(h.db, h.conversationId)[0]!;
      assert.equal(summary.state, "current");
      assert.equal(summary.content, "- 用户下周三去上海出差");
      // 40 条旧消息 + 这一问 + 秘书的回答 = 42；保留最近 20 条，最老的 22 条进摘要
      assert.equal(summary.sourceMessageIds.length, 22, "最老的 22 条（保留最近 20 条原文）");
      assert.ok(h.events.some((event) => event.type === "chat.summary.updated"));
      assert.equal(summaryRuns(h)[0]!.state, "COMPLETED");

      const before = h.runInputs.length;
      await h.chat.send(send(h.conversationId, userMessageId(902), "接着聊"));
      await settle(h.chat);
      const replyInput = h.runInputs.slice(before).find((entry) => entry.agent === "deepseek");
      assert.ok(replyInput !== undefined);
      assert.ok(replyInput.input.content.includes("历史摘要"), "Prompt 里有摘要");
      assert.ok(!replyInput.input.content.includes("旧消息第1条"), "被摘要的原文不再进 Prompt");
    } finally {
      h.db.close();
    }
  });

  it("摘要输出为空：Run 记失败、不写摘要、不当场重试", async () => {
    const h = await makeHarness({ summaryScript: summaryReply("   ") });
    try {
      await seedOldMessages(h, 40);
      await h.chat.send(send(h.conversationId, userMessageId(911), "现在几点"));
      await settle(h.chat);

      await waitFor(() => summaryRuns(h).length === 1 && summaryRuns(h)[0]!.state === "FAILED");
      assert.equal(listChatSummaries(h.db, h.conversationId).length, 0);
      await new Promise((resolve) => setTimeout(resolve, 60));
      assert.equal(summaryRuns(h).length, 1, "失败之后不当场重来");
    } finally {
      h.db.close();
    }
  });

  it("摘要跑的时候来源被撤回：这份丢掉、不存 current", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = await makeHarness({ summaryScript: summaryReply("- 要点的内容"), summaryGate: gate });
    try {
      await seedOldMessages(h, 40);
      await h.chat.send(send(h.conversationId, userMessageId(921), "现在几点"));
      // 摘要 Run 会在回答结束后起来并卡在 gate 上，不能用 settle（它等的是「没有活跃 Run」）
      await waitFor(() => summaryRuns(h).length === 1);

      const oldest = h.db
        .prepare("SELECT id FROM chat_messages WHERE conversation_id = ? AND sender = 'user' ORDER BY created_at ASC, id ASC LIMIT 1")
        .get(h.conversationId) as { id: string };
      await h.chat.retract({ type: "chat.retract", messageId: oldest.id } as never);

      release();
      await waitFor(() => summaryRuns(h)[0]!.state === "COMPLETED");
      assert.equal(listChatSummaries(h.db, h.conversationId).length, 0, "来源被撤回，这份摘要丢掉");
    } finally {
      h.db.close();
    }
  });

  it("同一会话同时只写一份摘要：摘要 Run 还在跑时，别的回答结束不再起一个", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = await makeHarness({ summaryScript: summaryReply("- 要点"), summaryGate: gate });
    try {
      await seedOldMessages(h, 40);
      await h.chat.send(send(h.conversationId, userMessageId(931), "现在几点"));
      await waitFor(() => summaryRuns(h).length === 1);
      assert.notEqual(summaryRuns(h)[0]!.state, "COMPLETED", "摘要 Run 卡在 gate 上");

      // 再发一条：它的回答结束也会调一次规划，但同一会话已经有摘要 Run
      await h.chat.send(send(h.conversationId, userMessageId(932), "再问一句"));
      await waitFor(() => {
        const slots = h.db.prepare("SELECT outcome FROM chat_reply_slots WHERE user_message_id = ?").all(userMessageId(932)) as {
          outcome: string;
        }[];
        return slots.length > 0 && slots.every((slot) => slot.outcome !== "running");
      });
      assert.equal(summaryRuns(h).length, 1, "没有起第二个摘要 Run");

      release();
      await waitFor(() => summaryRuns(h)[0]!.state === "COMPLETED");
      await waitFor(() => h.chat.activeCount() === 0);
      assert.equal(listChatSummaries(h.db, h.conversationId).length, 1);
    } finally {
      h.db.close();
    }
  });

  it("摘要 Run 没有终止事件：记失败、不无限起新的（#173 评审必须改 1）", async () => {
    const h = await makeHarness({ summaryScript: [] });
    try {
      await seedOldMessages(h, 40);
      await h.chat.send(send(h.conversationId, userMessageId(941), "现在几点"));
      await waitFor(() => summaryRuns(h).length === 1 && summaryRuns(h)[0]!.state === "FAILED");
      await new Promise((resolve) => setTimeout(resolve, 120));
      assert.equal(summaryRuns(h).length, 1, "不会当场再起一个新的摘要 Run");
      assert.equal(listChatSummaries(h.db, h.conversationId).length, 0);
    } finally {
      h.db.close();
    }
  });

  it("注入时钟时回答和 Run 的结束时间用同一个时钟（#173 补充评审）", async () => {
    const fixed = "2026-11-02T12:00:00.000Z";
    const h = await makeHarness({ now: () => fixed });
    try {
      await h.chat.send(send(h.conversationId, userMessageId(951), "现在几点"));
      await settle(h.chat);
      const reply = h.db.prepare("SELECT created_at FROM chat_messages WHERE sender <> 'user'").get() as {
        created_at: string;
      };
      assert.equal(reply.created_at, fixed, "回答消息用注入时钟");
      const run = h.db
        .prepare("SELECT finished_at FROM chat_runs WHERE purpose = 'reply' ORDER BY created_at DESC LIMIT 1")
        .get() as { finished_at: string };
      assert.equal(run.finished_at, fixed, "Run 的结束时间也用同一个时钟");
    } finally {
      h.db.close();
    }
  });
});
// ================================================================ D-39 沉浸模式

describe("immersive (D-39)", () => {
  const mediaScript = (text: string): Script => [
    {
      type: "message_complete",
      text: JSON.stringify({ kind: "reply", text, draw: { prompt: "小鲸鱼", size: "1024x1024" }, speak: true }),
    },
    { type: "completed" },
  ];
  const replyOf = (h: Harness, id: string) => {
    const replyId = listChatSlotsForMessage(h.db, id)[0]!.replyMessageId!;
    return getChatMessage(h.db, replyId)!;
  };

  it("关着：媒体意图照样存下来，但不自动执行、没有退回原因", async () => {
    const h = await makeHarness({ scripts: { deepseek: mediaScript("好呀") } });
    try {
      await h.chat.send(send(h.conversationId, userMessageId(960), "画一张吗"));
      await settle(h.chat);
      const reply = replyOf(h, userMessageId(960));
      assert.ok(reply.sender === "agent");
      assert.deepEqual(reply.mediaIntent, { draw: { prompt: "小鲸鱼", size: "1024x1024" }, speak: true });
      assert.equal(reply.immersiveDeferred, undefined);
      assert.deepEqual(h.mediaCalls, []);
    } finally {
      h.db.close();
    }
  });

  it("开着：在名额内自动排画图和语音，没有退回原因", async () => {
    const h = await makeHarness({ scripts: { deepseek: mediaScript("好呀") } });
    try {
      upsertImmersiveSettings(h.db, h.conversationId, {
        enabled: true,
        autoDrawUsesSubscription: true,
        drawsPerHour: 6,
        voiceClipsPerHour: 30,
      }, NOW);
      await h.chat.send(send(h.conversationId, userMessageId(961), "画一张吗"));
      await settle(h.chat);
      const reply = replyOf(h, userMessageId(961));
      assert.equal(reply.immersiveDeferred, undefined);
      assert.deepEqual(h.mediaCalls.map((call) => call.kind).sort(), ["draw", "speak"]);
    } finally {
      h.db.close();
    }
  });

  it("名额用完：退回 hourly_limit，不自动排；说话和画图各自算", async () => {
    const h = await makeHarness({ scripts: { deepseek: mediaScript("好呀") } });
    try {
      upsertImmersiveSettings(h.db, h.conversationId, {
        enabled: true,
        autoDrawUsesSubscription: true,
        drawsPerHour: 0,
        voiceClipsPerHour: 0,
      }, NOW);
      await h.chat.send(send(h.conversationId, userMessageId(962), "画一张吗"));
      await settle(h.chat);
      const reply = replyOf(h, userMessageId(962));
      assert.deepEqual(reply.immersiveDeferred, { draw: "hourly_limit", speak: "hourly_limit" });
      assert.deepEqual(h.mediaCalls, []);
    } finally {
      h.db.close();
    }
  });

  it("从开到关：取消这个会话的媒体任务（cancelReason = immersive_off）", async () => {
    const h = await makeHarness();
    try {
      const on = { enabled: true, autoDrawUsesSubscription: true, drawsPerHour: 6, voiceClipsPerHour: 30 };
      await h.chat.updateImmersive(h.conversationId, on);
      assert.deepEqual(h.mediaCalls, []);
      await h.chat.updateImmersive(h.conversationId, { ...on, enabled: false });
      assert.equal(h.mediaCalls.length, 1);
      assert.equal(h.mediaCalls[0]!.kind, "stop");
      assert.deepEqual(h.mediaCalls[0]!.scope, { kind: "chat", conversationId: h.conversationId });
    } finally {
      h.db.close();
    }
  });

  it("自动语音的前置条件不满足：补一条立刻失败的 immersive 任务（failSpeech）", async () => {
    const h = await makeHarness({ scripts: { deepseek: mediaScript("好呀") }, speakMediaFails: true });
    try {
      upsertImmersiveSettings(h.db, h.conversationId, {
        enabled: true,
        autoDrawUsesSubscription: true,
        drawsPerHour: 6,
        voiceClipsPerHour: 30,
      }, NOW);
      await h.chat.send(send(h.conversationId, userMessageId(963), "说句话"));
      await settle(h.chat);
      await waitFor(() => h.mediaCalls.some((call) => call.kind === "fail-speak"));
      const kinds = h.mediaCalls.map((call) => call.kind);
      assert.ok(kinds.includes("draw"));
      assert.ok(kinds.includes("fail-speak"));
      assert.equal(kinds.includes("speak"), false);
    } finally {
      h.db.close();
    }
  });

  it("两位秘书同时要画：上限 1 时只建一个任务，另一条记 hourly_limit（D-39b 原子占名额）", async () => {
    const h = await makeHarness({
      scripts: { deepseek: mediaScript("我也画"), codex: mediaScript("我也画") },
    });
    try {
      const group = await h.chat.createConversation({
        type: "chat.conversation.create",
        members: { kind: "group", agents: ["deepseek", "codex"] },
        title: null,
      } as never);
      upsertImmersiveSettings(h.db, group.id, {
        enabled: true,
        autoDrawUsesSubscription: true,
        drawsPerHour: 1,
        voiceClipsPerHour: 30,
      }, NOW);
      await h.chat.send(send(group.id, userMessageId(970), "都画一张"));
      await settle(h.chat);
      const replies = h.db
        .prepare("SELECT immersive_deferred FROM chat_messages WHERE conversation_id = ? AND sender = 'agent'")
        .all(group.id) as { immersive_deferred: string | null }[];
      assert.equal(replies.length, 2);
      const deferred = replies.filter((row) => row.immersive_deferred !== null);
      assert.equal(deferred.length, 1, "只有一条退回");
      assert.deepEqual(JSON.parse(deferred[0]!.immersive_deferred as string), { draw: "hourly_limit" });
      assert.equal(h.mediaCalls.filter((call) => call.kind === "draw").length, 1, "只建了一个画图任务");
    } finally {
      h.db.close();
    }
  });

  it("#187 第 5 条：关模式排在旧计划后面时，旧计划建出来的任务会被收掉", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const drawOnly = (text: string): Script => [
      { type: "message_complete", text: JSON.stringify({ kind: "reply", text, draw: { prompt: "小鲸鱼", size: "1024x1024" } }) },
      { type: "completed" },
    ];
    const h = await makeHarness({ scripts: { deepseek: drawOnly("好") }, drawGate: gate });
    try {
      upsertImmersiveSettings(h.db, h.conversationId, {
        enabled: true,
        autoDrawUsesSubscription: true,
        drawsPerHour: 6,
        voiceClipsPerHour: 30,
      }, NOW);
      await h.chat.send(send(h.conversationId, userMessageId(990), "画一张"));
      await waitFor(() => h.mediaCalls.some((call) => call.kind === "draw"));
      const disabling = h.chat.updateImmersive(h.conversationId, {
        enabled: false,
        autoDrawUsesSubscription: true,
        drawsPerHour: 6,
        voiceClipsPerHour: 30,
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(h.mediaCalls.some((call) => call.kind === "stop"), false, "关模式在等会话锁");
      release();
      await disabling;
      assert.deepEqual(h.mediaCalls.map((call) => call.kind), ["draw", "stop"]);
    } finally {
      h.db.close();
    }
  });
});

// ================================================================ #187 复审发现

describe("review fixes (#187)", () => {
  it("#180 撤回的原文不进交接 Prompt（换窗口不会把撒回内容带到新窗口）", async () => {
    const h = await makeHarness({
      scripts: {
        deepseek: [
          { type: "message_complete", text: JSON.stringify({ kind: "reply", text: "记住了" }) },
          { type: "completed" },
          { type: "message_complete", text: JSON.stringify({ kind: "reply", text: "好的" }) },
          { type: "completed" },
          { type: "message_complete", text: "## 交接\n- 没什么" },
          { type: "completed" },
        ],
      },
    });
    try {
      await h.chat.send(send(h.conversationId, userMessageId(981), "暗号 SENTINEL-XYZ"));
      await settle(h.chat);
      await h.chat.send(send(h.conversationId, userMessageId(982), "普通一句"));
      await settle(h.chat);
      await h.chat.retract({ type: "chat.retract", messageId: userMessageId(981) } as never);
      const draft = await h.chat.prepareWindow({
        type: "chat.window.prepare",
        conversationId: h.conversationId,
        agent: "deepseek",
      } as never);
      await waitFor(() => h.db.prepare("SELECT content FROM chat_window_drafts WHERE id = ?").get(draft.id) !== undefined);
      await settle(h.chat);
      const handoffInput = [...h.runInputs].reverse().find((entry) => entry.input.content.includes("交接"));
      assert.ok(handoffInput !== undefined, "写交接的 Run 到了节点");
      assert.equal(handoffInput.input.content.includes("SENTINEL-XYZ"), false, "撤回的原文不进交接 Prompt");
    } finally {
      h.db.close();
    }
  });

  it("#173 少于 40 条但旧区超 2 万字也会写摘要", async () => {
    const h = await makeHarness({ summaryScript: summaryReply("- 长回答摘要") });
    try {
      for (const [i, offset] of [600_000, 599_000].entries()) {
        insertChatMessage(h.db, {
          message: {
            id: "cmsg_" + ulid(),
            conversationId: h.conversationId,
            createdAt: new Date(Date.parse(NOW) - offset).toISOString(),
            sender: "user",
            content: { kind: "text", text: String(i) + "长".repeat(12_000), attachments: [] },
            mentions: { kind: "none" },
            quoteMessageId: null,
            replacesMessageId: null,
            state: "sent",
            retractedAt: null,
          },
        });
      }
      await seedOldMessages(h, 20);
      await h.chat.send(send(h.conversationId, userMessageId(983), "现在几点"));
      await settle(h.chat);
      await waitFor(() => listChatSummaries(h.db, h.conversationId).length === 1);
      assert.equal(listChatSummaries(h.db, h.conversationId)[0]!.state, "current");
    } finally {
      h.db.close();
    }
  });

  it("#178 并发人工保存：expectedParentId 在事务里核对，旧内容不会盖掉新版", async () => {
    const h = await makeHarness();
    try {
      const scope = { kind: "conversation" as const, conversationId: h.conversationId };
      const results = await Promise.allSettled([
        h.notes.edit({ scope, agent: "deepseek", content: "A", expectedParentId: null }),
        h.notes.edit({ scope, agent: "deepseek", content: "B", expectedParentId: null }),
      ]);
      assert.equal(results.filter((result) => result.status === "fulfilled").length, 1, "只成功一个");
      const rejected = results.find((result) => result.status === "rejected");
      assert.ok(rejected !== undefined);
      assert.equal(rejected.reason instanceof Error && rejected.reason.message.includes("变了"), true);
      const latest = listLatestProjectNotes(h.db, scope);
      assert.equal(latest.length, 1);
      assert.ok(["A", "B"].includes(latest[0]!.content));
    } finally {
      h.db.close();
    }
  });
});


// ================================================================ #187 草稿状态转换（探测闸门）

describe("window draft state transitions (#187)", () => {
  it("redo 探测期间取消：不会把 cancelled 改回 pending、也不起新的交接 Run", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let gated = false;
    const h = await makeHarness({
      probe: async () => {
        if (gated) await gate;
        return { reachable: true, profileAvailable: true, latencyMs: 1 } as never;
      },
      scripts: {
        deepseek: [
          { type: "message_complete", text: JSON.stringify({ kind: "reply", text: "好" }) },
          { type: "completed" },
          { type: "message_complete", text: "## 交接\n- 一" },
          { type: "completed" },
        ],
      },
    });
    try {
      insertChatMessage(h.db, {
        message: {
          id: userMessageId(995),
          conversationId: h.conversationId,
          createdAt: NOW,
          sender: "user",
          content: { kind: "text", text: "聊聊", attachments: [] },
          mentions: { kind: "none" },
          quoteMessageId: null,
          replacesMessageId: null,
          state: "sent",
          retractedAt: null,
        },
      });
      const draft = await h.chat.prepareWindow({
        type: "chat.window.prepare",
        conversationId: h.conversationId,
        agent: "deepseek",
      } as never);
      await waitFor(() => {
        const row = h.db.prepare("SELECT content FROM chat_window_drafts WHERE id = ?").get(draft.id) as { content: string | null };
        return row.content !== null && h.chat.activeCount() === 0;
      });
      gated = true;
      const redoing = h.chat.redoWindowDraft({ type: "chat.window.redo", draftId: draft.id } as never);
      await new Promise((resolve) => setTimeout(resolve, 20));
      await h.chat.cancelWindow({ type: "chat.window.cancel", draftId: draft.id } as never);
      release();
      await assert.rejects(
        () => redoing,
        (error: unknown) => error instanceof ChatError && error.code === "invalid_state",
      );
      const row = h.db.prepare("SELECT state FROM chat_window_drafts WHERE id = ?").get(draft.id) as { state: string };
      assert.equal(row.state, "cancelled");
      const runs = h.db.prepare("SELECT COUNT(*) AS n FROM chat_runs WHERE purpose = 'window_handoff'").get() as { n: number };
      assert.equal(runs.n, 1, "没有新起交接 Run");
    } finally {
      h.db.close();
    }
  });

  it("redo 探测期间手写内容：redo 拒绝，草稿保留人工内容、不起新 Run", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let gated = false;
    const h = await makeHarness({
      probe: async () => {
        if (gated) await gate;
        return { reachable: true, profileAvailable: true, latencyMs: 1 } as never;
      },
      scripts: {
        deepseek: [
          { type: "message_complete", text: JSON.stringify({ kind: "reply", text: "好" }) },
          { type: "completed" },
          { type: "message_complete", text: "## 交接\n- 一" },
          { type: "completed" },
        ],
      },
    });
    try {
      insertChatMessage(h.db, {
        message: {
          id: userMessageId(996),
          conversationId: h.conversationId,
          createdAt: NOW,
          sender: "user",
          content: { kind: "text", text: "聊聊", attachments: [] },
          mentions: { kind: "none" },
          quoteMessageId: null,
          replacesMessageId: null,
          state: "sent",
          retractedAt: null,
        },
      });
      const draft = await h.chat.prepareWindow({
        type: "chat.window.prepare",
        conversationId: h.conversationId,
        agent: "deepseek",
      } as never);
      await waitFor(() => {
        const row = h.db.prepare("SELECT content FROM chat_window_drafts WHERE id = ?").get(draft.id) as { content: string | null };
        return row.content !== null && h.chat.activeCount() === 0;
      });
      gated = true;
      const redoing = h.chat.redoWindowDraft({ type: "chat.window.redo", draftId: draft.id } as never);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const edited = await h.chat.editWindowDraft({
        type: "chat.window.editDraft",
        draftId: draft.id,
        content: "我自己写",
      } as never);
      assert.equal(edited.content, "我自己写");
      release();
      await assert.rejects(
        () => redoing,
        (error: unknown) => error instanceof ChatError && error.code === "invalid_state",
      );
      const row = h.db.prepare("SELECT state, content FROM chat_window_drafts WHERE id = ?").get(draft.id) as {
        state: string;
        content: string | null;
      };
      assert.equal(row.state, "pending");
      assert.equal(row.content, "我自己写");
      const runs = h.db.prepare("SELECT COUNT(*) AS n FROM chat_runs WHERE purpose = 'window_handoff'").get() as { n: number };
      assert.equal(runs.n, 1, "没有新起交接 Run");
    } finally {
      h.db.close();
    }
  });
});
