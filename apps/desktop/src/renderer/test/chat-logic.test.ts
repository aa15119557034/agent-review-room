import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AgentChatMessage, ChatReplySlot, Conversation, UserChatMessage } from "@room/schemas";
import {
  applyChatEvent,
  canReedit,
  canRetract,
  initialChat,
  mentionHint,
  mergeMessages,
  mergeSlots,
  partialReplyText,
  pruneMentions,
  slotIsNewer,
  timeline,
  toggleMention,
  type ChatState,
} from "../lib/chat";
import { applyEvent, initialState } from "../lib/state";

const T = (min: number) => new Date(Date.UTC(2026, 9, 26, 12, min)).toISOString();
const ULID = (n: number) => `01JC${String(n).padStart(22, "0")}`;
const CONV = `conv_${ULID(1)}`;

const user = (n: number, min: number, patch: Partial<UserChatMessage> = {}): UserChatMessage => ({
  id: `cmsg_${ULID(n)}`, conversationId: CONV, createdAt: T(min), sender: "user",
  content: { kind: "text", text: `问题 ${n}`, attachments: [] }, mentions: { kind: "none" },
  quoteMessageId: null, replacesMessageId: null, state: "sent", retractedAt: null, ...patch,
});
const agent = (n: number, min: number, inReplyTo: string, who = "deepseek"): AgentChatMessage => ({
  id: `cmsg_${ULID(n)}`, conversationId: CONV, createdAt: T(min), sender: "agent", agent: who, text: `回答 ${n}`,
  inReplyTo, slotId: `slot_${ULID(n)}`, runId: `run_${ULID(n)}`, memoryEntriesUsed: null,
});
const slot = (patch: Partial<ChatReplySlot>): ChatReplySlot => ({
  id: `slot_${ULID(900)}`, conversationId: CONV, userMessageId: `cmsg_${ULID(1)}`, agent: "deepseek", required: true,
  outcome: "running", runId: `run_${ULID(900)}`, attempt: 1, replyMessageId: null, failure: null, unavailableReason: null,
  createdAt: T(0), finishedAt: null, ...patch,
});
const group: Conversation = {
  id: CONV, kind: "group", members: ["claude", "deepseek", "codex"], title: null, pinned: false, muted: false,
  lastReadMessageId: null, lastActivityAt: T(0), createdAt: T(0),
};
const names: Record<string, string> = { claude: "C酱", deepseek: "汐", codex: "林离" };
const name = (id: string) => names[id] ?? id;
const state = (patch: Partial<ChatState>): ChatState => ({ ...initialChat, currentId: CONV, ...patch });

describe("chat state merging", () => {
  it("a late 'running' copy of a finished slot does not undo the result", () => {
    const answered = slot({ outcome: "answered", replyMessageId: `cmsg_${ULID(5)}`, finishedAt: T(1) });
    const running = slot({});
    assert.equal(slotIsNewer(answered, running), false);
    assert.deepEqual(mergeSlots([answered], [running]), [answered]);
  });

  it("a retry (higher attempt) replaces a failed slot; a stale old attempt does not", () => {
    const failed = slot({ outcome: "failed", failure: { kind: "timed_out", message: "" }, finishedAt: T(1) });
    const retry = slot({ attempt: 2, runId: `run_${ULID(901)}` });
    assert.equal(mergeSlots([failed], [retry])[0]!.attempt, 2);
    assert.equal(mergeSlots([retry], [failed])[0]!.attempt, 2);
  });

  it("a retracted message is not flipped back to sent by a late copy", () => {
    const retracted = user(1, 0, { state: "retracted", retractedAt: T(1) });
    assert.equal((mergeMessages([retracted], [user(1, 0)])[0] as UserChatMessage).state, "retracted");
  });

  it("messages are kept in time order and de-duplicated", () => {
    const merged = mergeMessages([user(2, 2)], [user(1, 1), user(2, 2), user(3, 3)]);
    assert.deepEqual(merged.map((m) => m.id), [1, 2, 3].map((n) => `cmsg_${ULID(n)}`));
  });

  it("only takes events for the open conversation", () => {
    const other = { ...user(1, 0), conversationId: `conv_${ULID(2)}` };
    const c = state({});
    assert.equal(applyChatEvent(c, { type: "chat.message.created", message: other }), c);
    assert.equal(applyChatEvent(c, { type: "chat.message.created", message: user(1, 0) }).messages.length, 1);
  });

  it("streams run.event for chat slots of the open conversation (and only those)", () => {
    const s = { ...initialState, chat: state({ slots: [slot({})] }) };
    const ev = (runId: string) => ({ type: "run.event" as const, event: { type: "message_delta" as const, text: "你", eventId: "e", runId, seq: 0, ts: T(0) } });
    assert.equal(applyEvent(s, ev(`run_${ULID(900)}`)).runEvents[`run_${ULID(900)}`]?.length, 1);
    assert.equal(applyEvent(s, ev(`run_${ULID(999)}`)), s);
  });
});

describe("chat timeline", () => {
  it("a re-edited message takes the original's place, and replies carry a reference when not adjacent", () => {
    const q1 = user(1, 0, { state: "retracted", retractedAt: T(1) });
    const q2 = user(2, 2);
    const q3 = user(3, 3, { replacesMessageId: q1.id });
    const a3 = agent(4, 4, q3.id);
    const a2 = agent(5, 5, q2.id);
    const t = timeline(state({ messages: mergeMessages([], [q1, q2, q3, a3, a2]) }));
    assert.deepEqual(t.map((e) => [e.kind, e.message.id]), [
      ["user", q3.id],
      ["user", q2.id],
      ["agent", a3.id],
      ["agent", a2.id],
    ]);
    assert.equal(t[0]!.kind === "user" && t[0]!.reedited, true);
    // a3 answers q3, which is not right before it → shows「回复 你：…」
    assert.equal(t[2]!.kind === "agent" && t[2]!.replyTo?.id, q3.id);
  });

  it("a retracted message shows as a notice; its replies are shown as excluded", () => {
    const q = user(1, 0, { state: "retracted", retractedAt: T(1) });
    const a = agent(2, 1, q.id);
    const t = timeline(state({ messages: [q, a] }));
    assert.deepEqual(t.map((e) => e.kind), ["retracted", "agent"]);
    assert.equal(t[1]!.kind === "agent" && t[1]!.excluded, true);
  });

  it("an answer whose question is not loaded yet is not marked excluded", () => {
    const a = agent(2, 1, `cmsg_${ULID(77)}`);
    const t = timeline(state({ messages: [a] }));
    assert.equal(t[0]!.kind === "agent" && t[0]!.excluded, false);
  });
});

describe("retract / re-edit windows (display only)", () => {
  it("retract within 5 minutes of sending", () => {
    const m = user(1, 0);
    assert.equal(canRetract(m, Date.parse(T(4))), true);
    assert.equal(canRetract(m, Date.parse(T(5))), false);
  });

  it("re-edit within 5 minutes of retracting, once", () => {
    const m = user(1, 0, { state: "retracted", retractedAt: T(2) });
    assert.equal(canReedit(m, [m], Date.parse(T(6))), true);
    assert.equal(canReedit(m, [m], Date.parse(T(7))), false);
    assert.equal(canReedit(m, [m, user(2, 3, { replacesMessageId: m.id })], Date.parse(T(4))), false);
  });
});

describe("@ mentions", () => {
  it("toggle: 所有人 overrides, agents accumulate, clicking again removes", () => {
    let m = toggleMention({ kind: "none" }, "deepseek");
    m = toggleMention(m, "codex");
    assert.deepEqual(m, { kind: "agents", agents: ["deepseek", "codex"] });
    assert.deepEqual(toggleMention(m, "all"), { kind: "all" });
    assert.deepEqual(toggleMention(toggleMention(m, "deepseek"), "codex"), { kind: "none" });
  });

  it("hint says who must answer, from the structured field only", () => {
    assert.equal(mentionHint(group, { kind: "none" }, name), "没点名：每位自己决定回不回");
    assert.equal(mentionHint(group, { kind: "all" }, name), "@所有人：每位都必须回答");
    assert.equal(mentionHint(group, { kind: "agents", agents: ["deepseek"] }, name), "汐 必须回答；其他人这条不回");
    assert.equal(mentionHint({ ...group, kind: "direct", members: ["claude"] }, { kind: "none" }, name), "C酱 会回答");
  });

  it("pruning drops people who left the group", () => {
    assert.deepEqual(pruneMentions({ kind: "agents", agents: ["codex"] }, ["claude", "deepseek"]), { kind: "none" });
  });
});

describe("partialReplyText", () => {
  it("pulls the reply text out of half-streamed JSON", () => {
    assert.equal(partialReplyText('{"kind":"reply","te'), "");
    assert.equal(partialReplyText('{"kind":"reply","text":"你好\\n第二'), "你好\n第二");
    assert.equal(partialReplyText('{"kind":"reply","text":"引号\\"和\\u4e2d'), '引号"和中');
    assert.equal(partialReplyText('{"kind":"reply","text":"完"}'), "完");
    assert.equal(partialReplyText('{"kind":"skip"}'), "");
    // 半截转义不吐出反斜杠
    assert.equal(partialReplyText('{"kind":"reply","text":"a\\'), "a");
    assert.equal(partialReplyText('{"kind":"reply","text":"a\\u4e'), "a");
  });
});
