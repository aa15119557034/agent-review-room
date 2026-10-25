import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AgentChatMessage,
  ChatContentInput,
  ChatSnapshot,
  chatSendIntentJson,
  isExcludedFromContext,
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

  it("at most 4 images per message, 9 attachments in total", () => {
    const img = (i: number) => ({ kind: "image", ref: `img_${ID}`, name: `${i}.png` });
    const file = (i: number) => ({ kind: "file", ref: `file_${ID}`, name: `${i}.txt`, mime: "text/plain", bytes: 1, sha256: HASH, isText: true });
    const msg = (atts: unknown[]) => ({ kind: "text", text: "", attachments: atts });
    assert.ok(ChatContent.safeParse(msg([0, 1, 2, 3].map(img))).success);
    assert.equal(ChatContent.safeParse(msg([0, 1, 2, 3, 4].map(img))).success, false, "5 images");
    assert.ok(ChatContent.safeParse(msg([...[0, 1, 2, 3].map(img), ...[0, 1, 2, 3, 4].map(file)])).success, "4 + 5 = 9");
    assert.equal(ChatContent.safeParse(msg([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(file))).success, false, "10 attachments");
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
    for (const ok of ["L1/identity.md", "汐/锚点.md", "notes 2026.md", "café.md", "メモ.md", "🧠.md"]) {
      assert.ok(MemoryEntryId.safeParse(ok).success, ok);
    }
    for (const bad of ["../x", "a/../b", "/etc/passwd", "C:/x", "a\\b", "a//b", "./a", "", "a/ /b", "a\nb", "a?.md", "a/.. /b", "a/. /b", "a/b. ", "a/b "]) {
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
    const withSlot = { ...start, snapshot: { ...start.snapshot, content: `a ${slot.marker} b` } };
    assert.ok(StartRunRequest.safeParse({ ...withSlot, chat: { memory: slot } }).success);
    assert.equal(StartRunRequest.safeParse({ ...start, chat: { memory: slot } }).success, false, "marker missing");
    const twice = { ...start, snapshot: { ...start.snapshot, content: `${slot.marker}${slot.marker}` } };
    assert.equal(StartRunRequest.safeParse({ ...twice, chat: { memory: slot } }).success, false, "marker twice");
    const start2 = withSlot;
    assert.equal(StartRunRequest.safeParse({ ...start2, chat: { memory: { ...slot, path: "C:/mem" } } }).success, false);
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

describe("review round 1 (汐 / 林离 on 919ea67)", () => {
  const snap = {
    id: `snap_${ID}`, purpose: "reply", conversationId: CONV, userMessageId: MSG, agent: "deepseek",
    content: "hello", contentHash: HASH, nonce: "0123456789abcdef", memorySlot: null,
    includedMessageIds: [MSG], includedSummaryIds: [], adapterVersion: "1", tokenEstimate: 1, createdAt: TS,
  };

  it("a history-summary snapshot has no user message but needs sources", () => {
    assert.ok(ChatSnapshot.safeParse(snap).success);
    assert.ok(ChatSnapshot.safeParse({ ...snap, purpose: "history_summary", userMessageId: null }).success);
    assert.equal(ChatSnapshot.safeParse({ ...snap, purpose: "history_summary" }).success, false, "summary with a user message");
    assert.equal(ChatSnapshot.safeParse({ ...snap, userMessageId: null }).success, false, "reply without one");
    assert.equal(
      ChatSnapshot.safeParse({ ...snap, purpose: "history_summary", userMessageId: null, includedMessageIds: [] }).success,
      false,
      "summary without sources",
    );
  });

  it("memory slot marker occurs exactly once and shares the snapshot nonce", () => {
    const slot = { nonce: snap.nonce, marker: "<<memory-slot 0123456789abcdef>>" };
    assert.ok(ChatSnapshot.safeParse({ ...snap, content: `x${slot.marker}y`, memorySlot: slot }).success);
    assert.equal(ChatSnapshot.safeParse({ ...snap, memorySlot: slot }).success, false, "missing");
    assert.equal(ChatSnapshot.safeParse({ ...snap, content: slot.marker + slot.marker, memorySlot: slot }).success, false, "twice");
    assert.equal(
      ChatSnapshot.safeParse({ ...snap, content: `x${slot.marker}`, memorySlot: { ...slot, nonce: "f".repeat(16) } }).success,
      false,
      "different nonce",
    );
  });

  it("conversation.create rejects a 1-member group and a 2-member direct chat", () => {
    const req = COMMANDS["chat.conversation.create"].request;
    assert.ok(req.safeParse({ type: "chat.conversation.create", members: { kind: "direct", agent: "deepseek" }, title: null }).success);
    assert.ok(req.safeParse({ type: "chat.conversation.create", members: { kind: "group", agents: ["deepseek", "codex"] }, title: null }).success);
    assert.equal(req.safeParse({ type: "chat.conversation.create", members: { kind: "group", agents: ["deepseek"] }, title: null }).success, false);
    assert.equal(
      req.safeParse({ type: "chat.conversation.create", members: { kind: "direct", agent: "deepseek", agents: ["codex"] }, title: null }).success,
      false,
    );
  });

  it("finished slots must point at their run", () => {
    const slot = {
      id: `slot_${ID}`, conversationId: CONV, userMessageId: MSG, agent: "deepseek", required: false,
      outcome: "answered", runId: null, attempt: 1, replyMessageId: `cmsg_${ID2}`, failure: null,
      unavailableReason: null, createdAt: TS, finishedAt: TS,
    };
    assert.equal(ChatReplySlot.safeParse(slot).success, false, "answered without run");
    assert.equal(ChatReplySlot.safeParse({ ...slot, outcome: "skipped", replyMessageId: null }).success, false);
    assert.ok(ChatReplySlot.safeParse({ ...slot, runId: `run_${ID}` }).success);
    assert.ok(ChatReplySlot.safeParse({ ...slot, outcome: "absent_quota", replyMessageId: null }).success, "quota known at send");
  });

  it("node health: memoryProfiles must be reported profiles", () => {
    const health = { protocol: 1, nodeId: "n", profiles: ["claude-chat"], activeRuns: 0, maxConcurrentRuns: 1, leaseMs: 1, heartbeatMs: 1 };
    assert.equal(NodeHealth.safeParse({ ...health, memoryProfiles: ["codex-chat"] }).success, false);
  });

  it("a blank reply can never become an answer", () => {
    assert.equal(ChatAgentOutput.safeParse({ kind: "reply", text: "   \n" }).success, false);
    const reply = {
      id: `cmsg_${ID2}`, conversationId: CONV, createdAt: TS, sender: "agent", agent: "deepseek", text: "  ",
      inReplyTo: MSG, slotId: `slot_${ID}`, runId: `run_${ID}`, memoryEntriesUsed: null,
    };
    assert.equal(AgentChatMessage.safeParse(reply).success, false);
  });

  it("replies to a retracted message are excluded (quote, topic, prompt)", () => {
    const user = UserChatMessage.parse({
      id: MSG, conversationId: CONV, createdAt: TS, sender: "user", content: text("hi"), mentions: { kind: "none" },
      quoteMessageId: null, replacesMessageId: null, state: "retracted", retractedAt: TS,
    });
    const reply = AgentChatMessage.parse({
      id: `cmsg_${ID2}`, conversationId: CONV, createdAt: TS, sender: "agent", agent: "deepseek", text: "嗯",
      inReplyTo: MSG, slotId: `slot_${ID}`, runId: `run_${ID}`, memoryEntriesUsed: null,
    });
    const find = (id: string) => (id === MSG ? user : undefined);
    assert.equal(isExcludedFromContext(user, find), true);
    assert.equal(isExcludedFromContext(reply, find), true);
    const sent = { ...user, state: "sent" as const, retractedAt: null };
    assert.equal(isExcludedFromContext(reply, () => sent), false);
  });

  it("idempotency compares the whole send intent", () => {
    const send = {
      type: "chat.send" as const, conversationId: CONV, messageId: MSG, content: { kind: "text" as const, text: "hi", attachments: [] },
      mentions: { kind: "none" as const }, quoteMessageId: null, replacesMessageId: null,
    };
    const base = chatSendIntentJson(send);
    assert.equal(chatSendIntentJson({ ...send, content: { attachments: [], text: "hi", kind: "text" } }), base, "key order does not matter");
    assert.notEqual(chatSendIntentJson({ ...send, mentions: { kind: "all" } }), base, "mentions");
    assert.notEqual(chatSendIntentJson({ ...send, quoteMessageId: `cmsg_${ID2}` }), base, "quote");
    assert.notEqual(chatSendIntentJson({ ...send, conversationId: `conv_${ID2}` }), base, "conversation");
    assert.ok(!chatSendIntentJson(send).includes(MSG), "messageId is the key, not part of the intent");
  });

  it("chat.send only takes references; metadata comes from main's records", () => {
    assert.ok(ChatContentInput.safeParse({ kind: "text", text: "", attachments: [{ kind: "file", ref: `file_${ID}` }] }).success);
    assert.equal(
      ChatContentInput.safeParse({ kind: "text", text: "x", attachments: [{ kind: "file", ref: `file_${ID}`, isText: true }] }).success,
      false,
      "forged isText",
    );
    assert.equal(
      ChatContentInput.safeParse({ kind: "text", text: "x", attachments: [{ kind: "file", ref: `file_${ID}`, sha256: HASH }] }).success,
      false,
      "forged sha256",
    );
    assert.equal(ChatContentInput.safeParse({ kind: "sticker", stickerId: `stk_${ID}`, label: "伪造" }).success, false, "forged label");
    assert.equal(
      ChatContentInput.safeParse({ kind: "voice", audio: `aud_${ID}`, transcriptText: "hi", durationMs: 1 }).success,
      false,
      "forged duration",
    );
    const dup = { kind: "image", ref: `img_${ID}` };
    assert.equal(ChatContentInput.safeParse({ kind: "text", text: "", attachments: [dup, dup] }).success, false, "same attachment twice");
  });
});

describe("review round 2 (汐 on 6d8a06f)", () => {
  const slot = {
    id: `slot_${ID}`, conversationId: CONV, userMessageId: MSG, agent: "deepseek", required: false,
    outcome: "retracted", runId: `run_${ID}`, attempt: 1, replyMessageId: null, failure: null,
    unavailableReason: null, createdAt: TS, finishedAt: TS,
  };

  it("a retracted slot keeps what it had before (reply / failure / reason)", () => {
    assert.ok(ChatReplySlot.safeParse(slot).success);
    assert.ok(ChatReplySlot.safeParse({ ...slot, replyMessageId: `cmsg_${ID2}` }).success, "was answered");
    assert.ok(ChatReplySlot.safeParse({ ...slot, failure: { kind: "timed_out", message: "x" } }).success, "was failed");
    assert.ok(ChatReplySlot.safeParse({ ...slot, runId: null, unavailableReason: "offline" }).success, "was unavailable");
    assert.equal(ChatReplySlot.safeParse({ ...slot, outcome: "cancelled", replyMessageId: `cmsg_${ID2}` }).success, false);
    assert.equal(ChatReplySlot.safeParse({ ...slot, outcome: "running", finishedAt: null, failure: { kind: "timed_out", message: "x" } }).success, false, "retry clears failure");
  });

  it("a reply snapshot always includes at least the current message", () => {
    const snap = {
      id: `snap_${ID}`, purpose: "reply", conversationId: CONV, userMessageId: MSG, agent: "deepseek",
      content: "hello", contentHash: HASH, nonce: "0123456789abcdef", memorySlot: null,
      includedMessageIds: [], includedSummaryIds: [], adapterVersion: "1", tokenEstimate: 1, createdAt: TS,
    };
    assert.equal(ChatSnapshot.safeParse(snap).success, false);
  });
});
