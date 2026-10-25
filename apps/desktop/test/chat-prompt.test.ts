import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ChatMessage, ChatSnapshot, type UserChatMessage } from "@room/schemas";
import { buildChatSnapshot } from "../src/main/chat-prompt";
import { createHash } from "node:crypto";

const ID = "0".repeat(26);
const CONV = "conv_" + ID;
const TS = "2026-10-26T00:00:00.000Z";

const user = (n: string, text: string, extra: Record<string, unknown> = {}): ChatMessage =>
  ChatMessage.parse({
    id: "cmsg_" + n.padStart(26, "0"),
    conversationId: CONV,
    createdAt: TS,
    sender: "user",
    content: { kind: "text", text, attachments: [] },
    mentions: { kind: "none" },
    quoteMessageId: null,
    replacesMessageId: null,
    state: "sent",
    retractedAt: null,
    ...extra,
  });

const agent = (n: string, text: string, inReplyTo: string): ChatMessage =>
  ChatMessage.parse({
    id: "cmsg_" + n.padStart(26, "0"),
    conversationId: CONV,
    createdAt: TS,
    sender: "agent",
    agent: "deepseek",
    text,
    inReplyTo,
    slotId: "slot_" + ID,
    runId: "run_" + ID,
    memoryEntriesUsed: null,
  });

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

describe("chat prompt (D-31b)", () => {
  const persona = "你是汐。说话直接，不客套。";
  const current = user("3", "今天想聊聊迁移的边界") as UserChatMessage;
  const first = user("1", "第一条");
  const reply = agent("2", "我在", (first as UserChatMessage).id);

  const build = (history: ChatMessage[], extra: Partial<Parameters<typeof buildChatSnapshot>[0]> = {}) =>
    buildChatSnapshot({
      snapshotId: "snap_" + ID,
      conversationId: CONV,
      userMessage: current,
      agent: { id: "deepseek", displayName: "汐", persona },
      history,
      quote: null,
      inReplyToOf: (id) => (id === (first as UserChatMessage).id ? (first as UserChatMessage) : undefined),
      createdAt: TS,
      nonce: "0123456789abcdef",
      ...extra,
    });

  it("puts the persona in the trusted area and the current message outside the boundary", () => {
    const snapshot = build([first, reply]);
    assert.ok(snapshot.content.startsWith("你是 汐，正在和用户聊天。"));
    assert.ok(snapshot.content.includes(persona), "人设在可信区");
    const open = "<UNTRUSTED_CHAT_DATA_0123456789abcdef>";
    const close = "</UNTRUSTED_CHAT_DATA_0123456789abcdef>";
    assert.ok(snapshot.content.includes(open) && snapshot.content.includes(close));
    const currentIndex = snapshot.content.indexOf("今天想聊聊迁移的边界");
    assert.ok(currentIndex > snapshot.content.indexOf(close), "当前消息在边界之后（可信）");
    assert.ok(snapshot.content.includes("你：第一条"), "历史在边界里");
    assert.deepEqual(snapshot.includedMessageIds, [
      (first as UserChatMessage).id,
      agent("2", "我在", (first as UserChatMessage).id).id,
      current.id,
    ]);
    ChatSnapshot.parse(snapshot);
  });

  it("drops excluded messages from the content and the audit list", () => {
    const retracted = user("1", "撤回的那条", { state: "retracted", retractedAt: TS });
    const snapshot = build([retracted, reply], { inReplyToOf: () => retracted as UserChatMessage });
    assert.ok(!snapshot.content.includes("撤回的那条"));
    assert.deepEqual(snapshot.includedMessageIds, [current.id], "回答已撤回消息的秘书发言也一起排除");
  });

  it("includes the quote inside the boundary and hashes the content", () => {
    const snapshot = build([first], { quote: reply });
    const close = "</UNTRUSTED_CHAT_DATA_0123456789abcdef>";
    assert.ok(snapshot.content.indexOf("我在") < snapshot.content.indexOf(close));
    assert.equal(snapshot.contentHash, sha(snapshot.content));
    assert.ok(snapshot.includedMessageIds.includes(reply.id));
    assert.ok(snapshot.tokenEstimate > 0);
    assert.equal(snapshot.memorySlot, null);
  });
});
