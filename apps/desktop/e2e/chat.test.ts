import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ulid } from "@room/db";
import { CHAT_LIMITS, type CommandRequest } from "@room/schemas";
import { ANSWER_JSON, approveOf, draft, failure, makeE2E, sleep, waitFor, waitRoundDone, type BatchLike, type E2E } from "./harness";
import type { NodeBehavior } from "./fake-node";

/**
 * X-31：聊天端到端（ADR-003 §2）。
 * 真的 dispatcher / ChatService / DiscussionService / DB / HttpRemoteAgentAdapter，节点是本地假 AgentServer。
 * 聊天 profile：claude-chat 在「你的电脑」，deepseek-chat / codex-chat 在主控机。
 */

const T0 = Date.parse("2026-11-01T10:00:00.000Z");

/** 可控时钟：撤回 / 重新编辑窗口和限流都按它算 */
function clock() {
  let t = T0;
  return {
    now: () => new Date(t).toISOString(),
    advance: (ms: number) => {
      t += ms;
    },
  };
}

const reply = (text: string): NodeBehavior => ({ kind: "answer", text: JSON.stringify({ kind: "reply", text }) });
const skip: NodeBehavior = { kind: "answer", text: JSON.stringify({ kind: "skip" }) };

type Ok<T> = { ok: true; data: T };

async function ok<T>(h: E2E, req: CommandRequest): Promise<T> {
  const result = (await h.dispatcher.handleCommand(req)) as Ok<T> | { ok: false };
  assert.equal(result.ok, true, JSON.stringify(result));
  return (result as Ok<T>).data;
}

async function conversation(h: E2E, members: CommandRequest<"chat.conversation.create">["members"]): Promise<string> {
  const conv = await ok<{ id: string }>(h, { type: "chat.conversation.create", members, title: null });
  return conv.id;
}

interface SentSlot {
  id: string;
  agent: string;
  required: boolean;
  outcome: string;
  runId: string | null;
  replyMessageId: string | null;
  failure: { kind: string } | null;
}

async function send(
  h: E2E,
  conversationId: string,
  text: string,
  extra: Partial<Pick<CommandRequest<"chat.send">, "mentions" | "replacesMessageId" | "quoteMessageId">> = {},
): Promise<{ messageId: string; slots: SentSlot[] }> {
  const messageId = "cmsg_" + ulid();
  const data = await ok<{ slots: SentSlot[] }>(h, {
    type: "chat.send",
    conversationId,
    messageId,
    content: { kind: "text", text, attachments: [] },
    mentions: extra.mentions ?? { kind: "none" },
    quoteMessageId: extra.quoteMessageId ?? null,
    replacesMessageId: extra.replacesMessageId ?? null,
  });
  return { messageId, slots: data.slots };
}

function slotsOf(h: E2E, messageId: string): Map<string, { outcome: string; failure: string | null; reply: string | null; runId: string | null; attempt: number }> {
  const rows = h.db
    .prepare("SELECT agent, outcome, failure, reply_message_id, run_id, attempt FROM chat_reply_slots WHERE user_message_id = ?")
    .all(messageId) as { agent: string; outcome: string; failure: string | null; reply_message_id: string | null; run_id: string | null; attempt: number }[];
  return new Map(rows.map((r) => [r.agent, { outcome: r.outcome, failure: r.failure === null ? null : (JSON.parse(r.failure) as { kind: string }).kind, reply: r.reply_message_id, runId: r.run_id, attempt: r.attempt }]));
}

async function settled(h: E2E, messageId: string): Promise<ReturnType<typeof slotsOf>> {
  await waitFor(() => [...slotsOf(h, messageId).values()].every((s) => s.outcome !== "running") && h.chat.activeCount() === 0, "slots of " + messageId);
  return slotsOf(h, messageId);
}

function chatStarts(h: E2E) {
  return [...h.nodes.userPc.bodies, ...h.nodes.controller.bodies].filter((b) => b.profileId.endsWith("-chat"));
}

function chatRunCount(h: E2E): number {
  return (h.db.prepare("SELECT COUNT(*) AS n FROM chat_runs").get() as { n: number }).n;
}

function agentReplies(h: E2E, inReplyTo: string): { agent: string; text: string }[] {
  return h.db.prepare("SELECT agent, text FROM chat_messages WHERE in_reply_to = ? ORDER BY created_at, id").all(inReplyTo) as { agent: string; text: string }[];
}

describe("X-31 聊天 @ 规则", () => {
  it("#1 单聊：对方必须回答，回答落库；单聊里给 skip 记失败（skip_not_allowed）", async () => {
    const h = await makeE2E();
    try {
      const conv = await conversation(h, { kind: "direct", agent: "deepseek" });
      h.nodes.controller.setBehavior("deepseek-chat", [reply("在的"), skip]);
      const first = await send(h, conv, "在吗");
      assert.deepEqual(first.slots.map((s) => [s.agent, s.required]), [["deepseek", true]]);
      const a = await settled(h, first.messageId);
      assert.equal(a.get("deepseek")?.outcome, "answered");
      assert.deepEqual(agentReplies(h, first.messageId), [{ agent: "deepseek", text: "在的" }]);
      assert.deepEqual(chatStarts(h).map((b) => b.profileId), ["deepseek-chat"], "走聊天 profile，不走讨论 profile");

      const second = await send(h, conv, "那你说句话");
      const b = await settled(h, second.messageId);
      assert.equal(b.get("deepseek")?.outcome, "failed");
      assert.equal(b.get("deepseek")?.failure, "skip_not_allowed");
      assert.deepEqual(agentReplies(h, second.messageId), []);
    } finally {
      await h.close();
    }
  });

  it("#2 群聊 @一人：只有被点到的人有回答位，别人不发请求", async () => {
    const h = await makeE2E();
    try {
      const conv = await conversation(h, { kind: "group", agents: ["claude", "codex", "deepseek"] });
      h.nodes.controller.setBehavior("codex-chat", reply("我来"));
      const sent = await send(h, conv, "林离你看看", { mentions: { kind: "agents", agents: ["codex"] } });
      assert.deepEqual(sent.slots.map((s) => [s.agent, s.required]), [["codex", true]]);
      const slots = await settled(h, sent.messageId);
      assert.deepEqual([...slots.keys()], ["codex"]);
      assert.equal(slots.get("codex")?.outcome, "answered");
      assert.deepEqual(chatStarts(h).map((b) => b.profileId), ["codex-chat"]);
    } finally {
      await h.close();
    }
  });

  it("#3 群聊 @所有人：每人都必须答；有人 skip 记失败，其他人照常", async () => {
    const h = await makeE2E();
    try {
      const conv = await conversation(h, { kind: "group", agents: ["claude", "codex", "deepseek"] });
      h.nodes.userPc.setBehavior("claude-chat", reply("C酱在"));
      h.nodes.controller.setBehavior("codex-chat", skip);
      h.nodes.controller.setBehavior("deepseek-chat", reply("汐在"));
      const sent = await send(h, conv, "大家都说说", { mentions: { kind: "all" } });
      assert.ok(sent.slots.every((s) => s.required));
      const slots = await settled(h, sent.messageId);
      assert.equal(slots.get("claude")?.outcome, "answered");
      assert.equal(slots.get("deepseek")?.outcome, "answered");
      assert.equal(slots.get("codex")?.outcome, "failed");
      assert.equal(slots.get("codex")?.failure, "skip_not_allowed");
    } finally {
      await h.close();
    }
  });

  it("#4 群聊没点名：reply / skip 混合；空输出、超时和明确 skip 各走各的；没有自动下一轮", async () => {
    const h = await makeE2E();
    try {
      const conv = await conversation(h, { kind: "group", agents: ["claude", "codex", "deepseek"] });
      h.nodes.userPc.setBehavior("claude-chat", reply("我补一句"));
      h.nodes.controller.setBehavior("codex-chat", skip);
      h.nodes.controller.setBehavior("deepseek-chat", { kind: "answer", text: "   " });
      const sent = await send(h, conv, "随便聊聊");
      assert.ok(sent.slots.every((s) => !s.required), "没点名：都可以 skip");
      const slots = await settled(h, sent.messageId);
      assert.equal(slots.get("claude")?.outcome, "answered");
      assert.equal(slots.get("codex")?.outcome, "skipped", "明确 skip = 不回答");
      assert.equal(slots.get("deepseek")?.outcome, "failed", "空输出不算 skip");
      assert.equal(slots.get("deepseek")?.failure, "empty_output");

      h.nodes.controller.setBehavior("codex-chat", { kind: "timeout" });
      h.nodes.controller.setBehavior("deepseek-chat", { kind: "answer", text: '{"kind":"reply","text":"半截' });
      const next = await send(h, conv, "再聊");
      const later = await settled(h, next.messageId);
      assert.equal(later.get("codex")?.outcome, "failed", "超时不算 skip");
      assert.equal(later.get("codex")?.failure, "timed_out");
      assert.equal(later.get("deepseek")?.failure, "parse_error", "半截 JSON 是格式错，不降级成 skip");

      // 没有自动下一轮：两条消息 × 三个人 = 6 个 Run，稍等一下也不会多
      await sleep(300);
      assert.equal(chatRunCount(h), 6);
      assert.equal(chatStarts(h).length, 6);
    } finally {
      await h.close();
    }
  });

  it("#5 正文里打了 @ 但没选人：按没点名处理（可以 skip）", async () => {
    const h = await makeE2E();
    try {
      const conv = await conversation(h, { kind: "group", agents: ["codex", "deepseek"] });
      h.nodes.controller.setBehavior("codex-chat", skip);
      h.nodes.controller.setBehavior("deepseek-chat", skip);
      const sent = await send(h, conv, "@汐 你怎么看");
      assert.deepEqual(sent.slots.map((s) => [s.agent, s.required]).sort(), [["codex", false], ["deepseek", false]]);
      const slots = await settled(h, sent.messageId);
      assert.equal(slots.get("deepseek")?.outcome, "skipped");
      assert.equal(slots.get("codex")?.outcome, "skipped");
    } finally {
      await h.close();
    }
  });
});

describe("X-31 撤回", () => {
  const SENTINEL = "SENTINEL-" + ulid();

  it("#6 撤回后发给每位的 Snapshot、节点请求、转议题材料都不含哨兵串，数据库仍能读到原文", async () => {
    const c = clock();
    const h = await makeE2E({ now: c.now });
    try {
      const conv = await conversation(h, { kind: "group", agents: ["claude", "codex", "deepseek"] });
      // 秘书在回答里复述了哨兵：回答已撤回消息的发言也要一起排除
      h.nodes.userPc.setBehavior("claude-chat", [reply("好"), reply("收到 " + SENTINEL), reply("好")]);
      h.nodes.controller.setBehavior("codex-chat", [reply("好"), reply("收到 " + SENTINEL), reply("好")]);
      h.nodes.controller.setBehavior("deepseek-chat", [reply("好"), reply("收到 " + SENTINEL), reply("好")]);

      const before = await send(h, conv, "先说个正常的");
      await settled(h, before.messageId);
      c.advance(15_000);
      const secret = await send(h, conv, "这条要撤回 " + SENTINEL);
      await settled(h, secret.messageId);
      const seen = new Set(chatStarts(h));
      assert.ok(chatStarts(h).some((b) => b.snapshot.content.includes(SENTINEL)), "撤回前确实发出去过");

      c.advance(60_000);
      const retracted = await ok<{ slots: { outcome: string }[] }>(h, { type: "chat.retract", messageId: secret.messageId });
      assert.ok(retracted.slots.every((s) => s.outcome === "retracted"));

      c.advance(15_000);
      const after = await send(h, conv, "撤回之后的新消息");
      await settled(h, after.messageId);

      const newStarts = chatStarts(h).filter((b) => !seen.has(b));
      assert.equal(newStarts.length, 3);
      for (const body of newStarts) assert.ok(!body.snapshot.content.includes(SENTINEL), body.profileId + " 的节点请求不含哨兵");
      const snapshots = h.db.prepare("SELECT content FROM chat_snapshots WHERE user_message_id = ?").all(after.messageId) as { content: string }[];
      assert.equal(snapshots.length, 3);
      assert.ok(snapshots.every((s) => !s.content.includes(SENTINEL)), "落库的 Snapshot 也不含");

      // 审计：原文还在
      const row = h.db.prepare("SELECT content, state FROM chat_messages WHERE id = ?").get(secret.messageId) as { content: string; state: string };
      assert.equal(row.state, "retracted");
      assert.ok(row.content.includes(SENTINEL));

      // 转议题：选撤回的消息或回答它的发言 → invalid_state；选其他消息 → 材料不含
      const echo = agentReplies(h, secret.messageId);
      assert.equal(echo.length, 3);
      const echoId = (h.db.prepare("SELECT id FROM chat_messages WHERE in_reply_to = ? LIMIT 1").get(secret.messageId) as { id: string }).id;
      for (const ids of [[secret.messageId], [echoId]]) {
        const refused = await h.dispatcher.handleCommand({ type: "chat.toTopic", conversationId: conv, messageIds: ids, name: "不行" });
        assert.equal(failure(refused).error, "invalid_state");
      }
      const topic = await ok<{ material: { content: string } }>(h, {
        type: "chat.toTopic",
        conversationId: conv,
        messageIds: [before.messageId, after.messageId],
        name: "撤回之后",
      });
      assert.ok(!topic.material.content.includes(SENTINEL));
    } finally {
      await h.close();
    }
  });

  it("#7 五分钟边界：差 1 毫秒能撤，正好五分钟不能；秘书的消息不能撤", async () => {
    const c = clock();
    const h = await makeE2E({ now: c.now });
    try {
      const conv = await conversation(h, { kind: "direct", agent: "deepseek" });
      h.nodes.controller.setBehavior("deepseek-chat", [reply("一"), reply("二")]);
      const a = await send(h, conv, "第一条");
      await settled(h, a.messageId);
      c.advance(15_000);
      const b = await send(h, conv, "第二条");
      await settled(h, b.messageId);

      c.advance(CHAT_LIMITS.retractWindowMs - 15_000); // a 正好五分钟，b 差 15 秒
      const late = await h.dispatcher.handleCommand({ type: "chat.retract", messageId: a.messageId });
      assert.equal(failure(late).error, "invalid_state");
      c.advance(15_000 - 1); // b 差 1 毫秒
      await ok(h, { type: "chat.retract", messageId: b.messageId });

      const agentMessage = (h.db.prepare("SELECT id FROM chat_messages WHERE in_reply_to = ?").get(a.messageId) as { id: string }).id;
      const refused = await h.dispatcher.handleCommand({ type: "chat.retract", messageId: agentMessage });
      assert.equal(refused.ok, false, "秘书的消息不能撤");

      // 群聊里另一位秘书的消息也不能撤（ADR-003：别人的消息不能撤）
      const group = await conversation(h, { kind: "group", agents: ["codex", "deepseek"] });
      h.nodes.controller.setBehavior("codex-chat", reply("林离说"));
      h.nodes.controller.setBehavior("deepseek-chat", reply("汐说"));
      c.advance(60_000);
      const asked = await send(h, group, "你们说", { mentions: { kind: "all" } });
      await settled(h, asked.messageId);
      for (const other of h.db.prepare("SELECT id FROM chat_messages WHERE in_reply_to = ?").all(asked.messageId) as { id: string }[]) {
        const no = await h.dispatcher.handleCommand({ type: "chat.retract", messageId: other.id });
        assert.equal(no.ok, false, "群聊里秘书的消息不能撤");
      }
      assert.ok(agentReplies(h, asked.messageId).length === 2);
    } finally {
      await h.close();
    }
  });

  it("#8 迟到结果不回流：撤回时节点还在答、之后才交卷，回答位仍是 retracted、没有回答消息", async () => {
    const h = await makeE2E();
    try {
      const conv = await conversation(h, { kind: "direct", agent: "deepseek" });
      h.nodes.controller.setBehavior("deepseek-chat", { kind: "late", text: JSON.stringify({ kind: "reply", text: "迟到的回答" }), delayMs: 400 });
      const sent = await send(h, conv, "问一句");
      await waitFor(() => h.nodes.controller.bodies.length === 1, "run started");
      await ok(h, { type: "chat.retract", messageId: sent.messageId });
      // 节点不理 cancel，400ms 后照样交卷：等节点真的发出终止事件，再等主控端收尾（不靠固定 sleep）
      const lateRunId = h.nodes.controller.bodies[0]!.runId;
      await waitFor(() => h.nodes.controller.isFinished(lateRunId), "节点交卷");
      await waitFor(() => h.chat.activeCount() === 0, "run settled");
      assert.equal(slotsOf(h, sent.messageId).get("deepseek")?.outcome, "retracted");
      assert.deepEqual(agentReplies(h, sent.messageId), []);
    } finally {
      await h.close();
    }
  });

  it("#9 停掉再重试：旧 Run 在新尝试开始之后才交卷，不覆盖新尝试", async () => {
    const h = await makeE2E();
    try {
      const conv = await conversation(h, { kind: "direct", agent: "deepseek" });
      h.nodes.controller.setBehavior("deepseek-chat", [
        { kind: "late", text: JSON.stringify({ kind: "reply", text: "旧尝试" }), delayMs: 500 },
        { kind: "hold" },
      ]);
      const sent = await send(h, conv, "问一句");
      await waitFor(() => h.nodes.controller.bodies.length === 1, "first run");
      const slotId = sent.slots[0]!.id;
      await ok(h, { type: "chat.cancelReply", slotId });
      await waitFor(() => slotsOf(h, sent.messageId).get("deepseek")?.outcome === "cancelled", "cancelled");
      const retried = await ok<{ run: { id: string } }>(h, { type: "chat.retry", slotId });
      await waitFor(() => h.nodes.controller.bodies.length === 2, "second run");
      // 等旧尝试在节点那边真的交卷（不靠固定 sleep），再给主控端一点时间处理迟到的事件流
      const oldRunId = h.nodes.controller.bodies[0]!.runId;
      await waitFor(() => h.nodes.controller.isFinished(oldRunId), "旧尝试交卷");
      await sleep(100);
      const slot = slotsOf(h, sent.messageId).get("deepseek");
      assert.equal(slot?.attempt, 2);
      assert.equal(slot?.runId, retried.run.id);
      assert.equal(slot?.outcome, "running", "旧 Run 的结果不改当前尝试");
      assert.deepEqual(agentReplies(h, sent.messageId), []);
      assert.notEqual(h.nodes.controller.bodies[1]!.snapshot.id, h.nodes.controller.bodies[0]!.snapshot.id, "重试重新拼 Snapshot，不重放旧的");
    } finally {
      await h.close();
    }
  });

  it("#10 重新编辑：是新消息、新回答位，旧回答位不复活", async () => {
    const c = clock();
    const h = await makeE2E({ now: c.now });
    try {
      const conv = await conversation(h, { kind: "direct", agent: "deepseek" });
      h.nodes.controller.setBehavior("deepseek-chat", [reply("旧回答"), reply("新回答")]);
      const old = await send(h, conv, "写错了");
      await settled(h, old.messageId);
      c.advance(30_000);
      await ok(h, { type: "chat.retract", messageId: old.messageId });
      c.advance(30_000);
      const edited = await send(h, conv, "改好了", { replacesMessageId: old.messageId });
      assert.notEqual(edited.messageId, old.messageId);
      const fresh = await settled(h, edited.messageId);
      assert.equal(fresh.get("deepseek")?.outcome, "answered");
      const stale = slotsOf(h, old.messageId).get("deepseek");
      assert.equal(stale?.outcome, "retracted", "旧回答位保持撤回");
      assert.equal(stale?.attempt, 1);
      // 新 Snapshot 不含旧回答
      const last = h.nodes.controller.bodies.at(-1)!;
      assert.ok(!last.snapshot.content.includes("旧回答"));
      assert.ok(!last.snapshot.content.includes("写错了"));
    } finally {
      await h.close();
    }
  });
});

describe("X-31 聊天 → 转议题 → 跑一轮", () => {
  it("#11 选中的消息变成议题材料，盖章后每人收到材料并答完一轮", async () => {
    const c = clock();
    const h = await makeE2E({ now: c.now, controller: { "deepseek-discuss": { kind: "answer", text: ANSWER_JSON }, "codex-discuss": { kind: "answer", text: ANSWER_JSON } } });
    try {
      const conv = await conversation(h, { kind: "group", agents: ["codex", "deepseek"] });
      h.nodes.controller.setBehavior("codex-chat", reply("可以先迁数据库"));
      h.nodes.controller.setBehavior("deepseek-chat", reply("要先备份"));
      const sent = await send(h, conv, "迁移怎么做", { mentions: { kind: "all" } });
      await settled(h, sent.messageId);
      const ids = [sent.messageId, ...(h.db.prepare("SELECT id FROM chat_messages WHERE in_reply_to = ? ORDER BY id").all(sent.messageId) as { id: string }[]).map((r) => r.id)];

      const discussStartsBefore = h.nodes.controller.bodies.filter((b) => b.profileId.endsWith("-discuss")).length;
      const topic = await ok<{ project: { id: string }; material: { content: string } }>(h, {
        type: "chat.toTopic",
        conversationId: conv,
        messageIds: ids,
        name: "迁移方案",
      });
      for (const text of ["迁移怎么做", "可以先迁数据库", "要先备份"]) assert.ok(topic.material.content.includes(text), text);
      assert.equal(h.nodes.controller.bodies.filter((b) => b.profileId.endsWith("-discuss")).length, discussStartsBefore, "转议题本身不发给任何人");

      const result = (await draft(h, ["codex", "deepseek"], { projectId: topic.project.id })) as { ok: boolean; data?: { round: { id: string }; batch: BatchLike } };
      assert.equal(result.ok, true, JSON.stringify(result));
      await approveOf(h, result);
      await waitRoundDone(h, result.data!.round.id, "AWAITING_SUMMARY");
      const discuss = h.nodes.controller.bodies.filter((b) => b.profileId.endsWith("-discuss"));
      assert.equal(discuss.length, 2);
      for (const body of discuss) assert.ok(body.snapshot.content.includes("要先备份"), body.profileId + " 收到聊天材料");
    } finally {
      await h.close();
    }
  });
});
