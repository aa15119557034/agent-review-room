import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AgentChatMessage,
  AgentEvent,
  AgentProfile,
  CHAT_LIMITS,
  CHAT_PERSONA_MAX_CHARS,
  CHAT_SLOT_INITIAL_OUTCOMES,
  CHAT_SLOT_TRANSITIONS,
  ChatAgentOutput,
  ChatContent,
  ChatMentions,
  ChatReplySlot,
  ChatRun,
  ChatSlotOutcome,
  COMMANDS,
  ControlCommand,
  ControlEvent,
  ControlQuery,
  Conversation,
  MemoryEntryId,
  MemoryManifest,
  Message,
  NodeHealth,
  Project,
  QUERIES,
  RemoteEvent,
  StartRunRequest,
  TurnOutcome,
  UserChatMessage,
  VoiceRecording,
  canTransition,
} from "../src/index";

const ID = "01JAAAAAAAAAAAAAAAAAAAAAAA";
const ID2 = "01JBBBBBBBBBBBBBBBBBBBBBBB";
const TS = "2026-10-23T00:00:00.000Z";
const HASH = "c".repeat(64);
const CONV = `conv_${ID}`;
const MSG = `cmsg_${ID}`;

const text = (t: string) => ({ kind: "text", text: t, attachments: [] });

describe("chat slot outcomes (C-34)", () => {
  const states = ChatSlotOutcome.options;
  const terminal = ["retracted"] as const;

  it("only references known outcomes and has no self-loops", () => {
    for (const from of states) {
      for (const to of CHAT_SLOT_TRANSITIONS[from]) assert.ok(states.includes(to), `${from} -> ${to}`);
      assert.ok(!canTransition(CHAT_SLOT_TRANSITIONS, from, from), from);
    }
  });

  it("every outcome can reach retracted, and retracted is final", () => {
    assert.deepEqual(CHAT_SLOT_TRANSITIONS.retracted, []);
    for (const s of states) {
      const seen = new Set([s]);
      const q = [s];
      while (q.length) for (const n of CHAT_SLOT_TRANSITIONS[q.shift()!]) if (!seen.has(n)) (seen.add(n), q.push(n));
      assert.ok(terminal.some((t) => seen.has(t)), s);
    }
  });

  it("every outcome is reachable from the outcomes a send can create", () => {
    const seen = new Set<string>(CHAT_SLOT_INITIAL_OUTCOMES);
    const q = [...CHAT_SLOT_INITIAL_OUTCOMES] as ChatSlotOutcome[];
    while (q.length) for (const n of CHAT_SLOT_TRANSITIONS[q.shift()!]) if (!seen.has(n)) (seen.add(n), q.push(n));
    for (const s of states) assert.ok(seen.has(s), s);
  });

  it("answered and skipped cannot be retried; failures can", () => {
    for (const s of ["answered", "skipped"] as const) assert.ok(!canTransition(CHAT_SLOT_TRANSITIONS, s, "running"), s);
    for (const s of ["failed", "absent_quota", "unavailable", "cancelled"] as const) {
      assert.ok(canTransition(CHAT_SLOT_TRANSITIONS, s, "running"), s);
    }
    assert.ok(!canTransition(CHAT_SLOT_TRANSITIONS, "retracted", "running"));
  });

  it("is its own set, not the discussion TurnOutcome", () => {
    assert.ok(!TurnOutcome.options.includes("skipped" as never));
    assert.ok(!TurnOutcome.options.includes("retracted" as never));
  });
});

describe("conversation", () => {
  const conv = {
    id: CONV, kind: "direct", members: ["deepseek"], title: null, pinned: false, muted: false,
    lastReadMessageId: null, lastActivityAt: TS, createdAt: TS,
  };
  it("direct has exactly one member, group 2..8 without duplicates", () => {
    assert.ok(Conversation.safeParse(conv).success);
    assert.equal(Conversation.safeParse({ ...conv, members: ["deepseek", "codex"] }).success, false);
    assert.equal(Conversation.safeParse({ ...conv, kind: "group" }).success, false);
    assert.ok(Conversation.safeParse({ ...conv, kind: "group", members: ["deepseek", "codex"] }).success);
    assert.equal(Conversation.safeParse({ ...conv, kind: "group", members: ["codex", "codex"] }).success, false);
    const nine = Array.from({ length: 9 }, (_, i) => `a${i}`);
    assert.equal(Conversation.safeParse({ ...conv, kind: "group", members: nine }).success, false);
  });
});

describe("user messages", () => {
  const msg = {
    id: MSG, conversationId: CONV, createdAt: TS, sender: "user", content: text("hi"),
    mentions: { kind: "none" }, quoteMessageId: null, replacesMessageId: null, state: "sent", retractedAt: null,
  };

  it("mentions are structured only: no free-form strings, no extra fields", () => {
    assert.ok(ChatMentions.safeParse({ kind: "all" }).success);
    assert.ok(ChatMentions.safeParse({ kind: "agents", agents: ["deepseek"] }).success);
    assert.equal(ChatMentions.safeParse({ kind: "agents", agents: [] }).success, false);
    assert.equal(ChatMentions.safeParse({ kind: "agents", agents: ["x", "x"] }).success, false);
    assert.equal(ChatMentions.safeParse("@汐").success, false);
    assert.equal(ChatMentions.safeParse({ kind: "none", agents: ["deepseek"] }).success, false);
  });

  it("text needs text or an attachment", () => {
    assert.equal(ChatContent.safeParse(text("   ")).success, false);
    assert.ok(
      ChatContent.safeParse({ kind: "text", text: "", attachments: [{ kind: "image", ref: `img_${ID}`, name: "a.png" }] }).success,
    );
  });

  it("voice carries a transcript; sticker carries its label", () => {
    const voice = {
      kind: "voice", audio: `aud_${ID}`, durationMs: 3200,
      transcript: { text: "你好", language: "zh-CN", source: "edited", engine: { engine: "sherpa-onnx", model: "paraformer" } },
    };
    assert.ok(ChatContent.safeParse(voice).success);
    assert.equal(ChatContent.safeParse({ ...voice, durationMs: CHAT_LIMITS.voiceMaxMs + 1 }).success, false);
    assert.equal(ChatContent.safeParse({ ...voice, transcript: { ...voice.transcript, text: "" } }).success, false);
    assert.ok(ChatContent.safeParse({ kind: "sticker", stickerId: `stk_${ID}`, image: `img_${ID}`, label: "小鲸鱼比心" }).success);
  });

  it("retracted iff retractedAt; cannot replace itself", () => {
    assert.ok(UserChatMessage.safeParse(msg).success);
    assert.equal(UserChatMessage.safeParse({ ...msg, state: "retracted" }).success, false);
    assert.ok(UserChatMessage.safeParse({ ...msg, state: "retracted", retractedAt: TS }).success);
    assert.equal(UserChatMessage.safeParse({ ...msg, replacesMessageId: MSG }).success, false);
  });

  it("agent messages have no state / mentions and cannot be retracted", () => {
    const reply = {
      id: `cmsg_${ID2}`, conversationId: CONV, createdAt: TS, sender: "agent", agent: "deepseek", text: "嗯",
      inReplyTo: MSG, slotId: `slot_${ID}`, runId: `run_${ID}`, memoryEntriesUsed: 2,
    };
    assert.ok(AgentChatMessage.safeParse(reply).success);
    assert.equal(AgentChatMessage.safeParse({ ...reply, state: "retracted" }).success, false);
    assert.equal(AgentChatMessage.safeParse({ ...reply, mentions: { kind: "all" } }).success, false);
  });
});

describe("reply slots", () => {
  const slot = {
    id: `slot_${ID}`, conversationId: CONV, userMessageId: MSG, agent: "deepseek", required: false,
    outcome: "running", runId: `run_${ID}`, attempt: 1, replyMessageId: null, failure: null,
    unavailableReason: null, createdAt: TS, finishedAt: null,
  };

  it("outcome details are consistent", () => {
    assert.ok(ChatReplySlot.safeParse(slot).success);
    assert.equal(ChatReplySlot.safeParse({ ...slot, runId: null }).success, false, "running needs a run");
    assert.equal(ChatReplySlot.safeParse({ ...slot, outcome: "answered", finishedAt: TS }).success, false, "answered needs reply");
    assert.ok(ChatReplySlot.safeParse({ ...slot, outcome: "answered", finishedAt: TS, replyMessageId: `cmsg_${ID2}` }).success);
    assert.equal(ChatReplySlot.safeParse({ ...slot, outcome: "failed", finishedAt: TS }).success, false, "failed needs failure");
    assert.ok(
      ChatReplySlot.safeParse({ ...slot, outcome: "unavailable", runId: null, finishedAt: TS, unavailableReason: "offline" }).success,
    );
    assert.equal(
      ChatReplySlot.safeParse({ ...slot, outcome: "unavailable", finishedAt: TS, unavailableReason: "offline" }).success,
      false,
      "unavailable is decided before any run",
    );
  });

  it("a required slot can never be shown as skipped", () => {
    assert.ok(ChatReplySlot.safeParse({ ...slot, outcome: "skipped", finishedAt: TS }).success);
    assert.equal(ChatReplySlot.safeParse({ ...slot, required: true, outcome: "skipped", finishedAt: TS }).success, false);
    assert.ok(
      ChatReplySlot.safeParse({
        ...slot, required: true, outcome: "failed", finishedAt: TS, failure: { kind: "skip_not_allowed", message: "被点名但没回答" },
      }).success,
    );
  });
});

describe("agent output", () => {
  it("reply / skip are strict; skip with media or text is a parse error", () => {
    assert.ok(ChatAgentOutput.safeParse({ kind: "reply", text: "好" }).success);
    assert.ok(ChatAgentOutput.safeParse({ kind: "skip" }).success);
    assert.equal(ChatAgentOutput.safeParse({ kind: "skip", text: "x" }).success, false);
    assert.equal(ChatAgentOutput.safeParse({ kind: "skip", draw: { prompt: "x" } }).success, false);
    assert.equal(ChatAgentOutput.safeParse({ kind: "reply", text: "x", tool: "rm" }).success, false);
    assert.equal(ChatAgentOutput.safeParse({ kind: "maybe" }).success, false);
  });
});

describe("memory", () => {
  it("entry ids stay inside the memory folder", () => {
    for (const ok of ["L1/identity.md", "汐/锚点.md", "notes 2026.md"]) assert.ok(MemoryEntryId.safeParse(ok).success, ok);
    for (const bad of ["../x", "a/../b", "/etc/passwd", "C:/x", "a\\b", "a//b", "./a", ""]) {
      assert.equal(MemoryEntryId.safeParse(bad).success, false, bad);
    }
  });

  it("manifest stores ids + hashes only, consistent with status", () => {
    assert.ok(MemoryManifest.safeParse({ status: "filled", entries: [{ id: "a.md", sha256: HASH }] }).success);
    assert.equal(MemoryManifest.safeParse({ status: "filled", entries: [] }).success, false);
    assert.equal(MemoryManifest.safeParse({ status: "unavailable", entries: [{ id: "a.md", sha256: HASH }] }).success, false);
    assert.equal(
      MemoryManifest.safeParse({ status: "filled", entries: [{ id: "a.md", sha256: HASH, content: "secret" }] }).success,
      false,
      "no memory body",
    );
  });
});

describe("chat runs and the node protocol", () => {
  const run = {
    id: `run_${ID}`, kind: "chat", purpose: "reply", conversationId: CONV, slotId: `slot_${ID}`, agent: "claude",
    snapshotId: `snap_${ID}`, snapshotHash: HASH, finalPromptHash: null, memoryManifest: null, model: null,
    adapterId: "remote", state: "QUEUED", substate: null, failureReason: null, createdAt: TS, startedAt: null, finishedAt: null,
  };

  it("has no approval and keeps the Run state rules", () => {
    assert.ok(ChatRun.safeParse(run).success);
    assert.equal(ChatRun.safeParse({ ...run, state: "FAILED" }).success, false, "FAILED needs a reason");
    assert.equal(ChatRun.safeParse({ ...run, slotId: null }).success, false, "reply needs a slot");
    assert.ok(ChatRun.safeParse({ ...run, purpose: "history_summary", slotId: null }).success);
  });

  const start = {
    protocol: 1, runId: `run_${ID}`, profileId: "claude-chat",
    snapshot: { id: `snap_${ID}`, content: "hi", contentHash: HASH },
    limits: { idleTimeoutMs: 60_000, totalTimeoutMs: 600_000 },
  };

  it("StartRun.chat is optional and strict", () => {
    assert.ok(StartRunRequest.safeParse(start).success, "discussion runs unchanged");
    assert.ok(StartRunRequest.safeParse({ ...start, chat: { memory: null } }).success);
    const slot = { nonce: "0123456789abcdef", marker: "<<memory-slot 0123456789abcdef>>" };
    assert.ok(StartRunRequest.safeParse({ ...start, chat: { memory: slot } }).success);
    assert.equal(StartRunRequest.safeParse({ ...start, chat: { memory: { ...slot, path: "C:/mem" } } }).success, false);
    assert.equal(StartRunRequest.safeParse({ ...start, chat: { memory: null, tools: true } }).success, false);
  });

  it("prompt_final carries the final hash and manifest, and is not terminal", () => {
    const ev = { type: "prompt_final", seq: 1, ts: TS, finalPromptHash: HASH, memory: { status: "empty", entries: [] } };
    assert.ok(RemoteEvent.safeParse(ev).success);
    const mapped = AgentEvent.parse({ eventId: "e1", runId: `run_${ID}`, seq: 1, ts: TS, type: "prompt_final", finalPromptHash: HASH, memory: null });
    assert.equal(mapped.type, "prompt_final");
  });

  it("node health may report memory profiles; old nodes omit it", () => {
    const health = { protocol: 1, nodeId: "user-pc", profiles: ["claude-chat"], activeRuns: 0, maxConcurrentRuns: 2, leaseMs: 30_000, heartbeatMs: 5_000 };
    assert.ok(NodeHealth.safeParse(health).success);
    assert.ok(NodeHealth.safeParse({ ...health, memoryProfiles: ["claude-chat"] }).success);
  });
});

describe("participants and topics", () => {
  it("AgentProfile has chat persona, chat profile and memory source, but no vision flag", () => {
    for (const k of ["chatPersona", "chatProfileId", "memorySource"]) assert.ok(k in AgentProfile.shape, k);
    assert.ok(!("canSeeImages" in AgentProfile.shape) && !("vision" in AgentProfile.shape));
    assert.equal(AgentProfile.shape.chatPersona.safeParse("x".repeat(CHAT_PERSONA_MAX_CHARS + 1)).success, false);
    assert.equal(CHAT_LIMITS.chatPersonaMaxChars, CHAT_PERSONA_MAX_CHARS);
  });

  it("projects record where they came from; chat material is a Message", () => {
    assert.ok(Project.safeParse({ id: `proj_${ID}`, name: "x", fromConversationId: CONV, createdAt: TS }).success);
    assert.ok(Project.safeParse({ id: `proj_${ID}`, name: "x", fromConversationId: null, createdAt: TS }).success);
    const mat = { id: `msg_${ID}`, projectId: `proj_${ID}`, content: "记录", createdAt: TS, kind: "chat_material", conversationId: CONV };
    assert.equal(Message.safeParse({ ...mat, chatMessageIds: [] }).success, false);
    assert.ok(Message.safeParse({ ...mat, chatMessageIds: [MSG] }).success);
  });
});

describe("chat commands, queries, events", () => {
  it("are registered", () => {
    for (const c of ["chat.conversation.create", "chat.send", "chat.retract", "chat.retry", "chat.cancelReply", "chat.toTopic", "chat.voice.import"]) {
      assert.ok(c in COMMANDS, c);
    }
    for (const q of ["chat.conversations.list", "chat.messages.list", "chat.snapshots.get", "chat.runs.get"]) assert.ok(q in QUERIES, q);
  });

  it("chat.send needs a client message id and structured mentions; no approval fields", () => {
    const send = {
      type: "chat.send", conversationId: CONV, messageId: MSG, content: text("hi"),
      mentions: { kind: "none" }, quoteMessageId: null, replacesMessageId: null,
    };
    assert.ok(ControlCommand.safeParse(send).success);
    const { messageId: _m, ...noId } = send;
    assert.equal(ControlCommand.safeParse(noId).success, false);
    assert.equal(ControlCommand.safeParse({ ...send, mentions: "@all" }).success, false);
  });

  it("chat.toTopic rejects duplicates and an empty selection", () => {
    const base = { type: "chat.toTopic", conversationId: CONV, name: "议题" };
    assert.ok(ControlCommand.safeParse({ ...base, messageIds: [MSG] }).success);
    assert.equal(ControlCommand.safeParse({ ...base, messageIds: [] }).success, false);
    assert.equal(ControlCommand.safeParse({ ...base, messageIds: [MSG, MSG] }).success, false);
  });

  it("voice import is base64 only and bounded", () => {
    const req = COMMANDS["chat.voice.import"].request;
    assert.ok(req.safeParse({ type: "chat.voice.import", format: "wav", data: "UklGRg==" }).success);
    assert.equal(req.safeParse({ type: "chat.voice.import", format: "wav", data: "../../x" }).success, false);
    assert.equal(req.safeParse({ type: "chat.voice.import", format: "mp4", data: "UklGRg==" }).success, false);
  });

  it("agent.update accepts the chat fields", () => {
    assert.ok(
      ControlCommand.safeParse({
        type: "agent.update", id: "deepseek", chatPersona: "汐的完整人设", chatProfileId: "deepseek-chat", memorySource: { nodeFolder: true },
      }).success,
    );
  });

  it("messages.list pages by cursor", () => {
    assert.ok(ControlQuery.safeParse({ type: "chat.messages.list", conversationId: CONV, before: { createdAt: TS, id: MSG }, limit: 50 }).success);
    assert.equal(ControlQuery.safeParse({ type: "chat.messages.list", conversationId: CONV, limit: 500 }).success, false);
  });

  it("voice recordings only carry an engine transcript when ready", () => {
    const rec = { audio: `aud_${ID}`, durationMs: 1000, status: "transcribing", transcript: null, error: null, createdAt: TS };
    assert.ok(VoiceRecording.safeParse(rec).success);
    assert.equal(VoiceRecording.safeParse({ ...rec, status: "ready" }).success, false);
    assert.equal(VoiceRecording.safeParse({ ...rec, status: "failed" }).success, false);
  });

  it("events parse", () => {
    assert.ok(ControlEvent.safeParse({ type: "chat.voice.updated", recording: { audio: `aud_${ID}`, durationMs: 1, status: "failed", transcript: null, error: "x", createdAt: TS } }).success);
  });
});
