import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ulid } from "@room/db";
import type { CommandRequest } from "@room/schemas";
import type { NodeBehavior } from "./fake-node";
import { makeE2E, waitFor, type E2E } from "./harness";

/**
 * X-35b：聊天历史摘要端到端（X-35 core + D-45 main 接线）。
 * 真的 dispatcher / ChatService / DB / HttpRemoteAgentAdapter，节点是本地假 AgentServer。
 * 单聊汐（deepseek-chat 在主控机）：汐既是回答的人，也是写摘要的人（D-45 优先汐）。
 *
 * 数字（core 的常量）：最近 20 条不摘要；更早的攒够 20 条才写。20 问 20 答 = 40 条 → 最老的 20 条（10 问 10 答）进第一份摘要。
 *
 * 注意：时钟是假的（撤回窗口、限流都按它算），回答消息的时间也要用同一个时钟，不然回答会排到所有提问后面。
 */

const T0 = Date.parse("2026-11-02T10:00:00.000Z");
/** 两次发送间隔：每分钟最多 6 条（滑动 60 秒）不触发限流；撤回第 1 条时还在 5 分钟窗口里 */
const GAP_MS = 12_000;

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
/** 摘要 Run 的输出是纯文本，不是聊天 JSON */
const summaryText = (text: string): NodeBehavior => ({ kind: "answer", text });

type Ok<T> = { ok: true; data: T };

async function ok<T>(h: E2E, req: CommandRequest): Promise<T> {
  const result = (await h.dispatcher.handleCommand(req)) as Ok<T> | { ok: false };
  assert.equal(result.ok, true, JSON.stringify(result));
  return (result as Ok<T>).data;
}

interface SummaryRow {
  id: string;
  state: string;
  content: string;
  sourceMessageIds: string[];
  runId: string;
}

async function summaries(h: E2E, conversationId: string): Promise<SummaryRow[]> {
  const listed = (await h.dispatcher.handleQuery({ type: "chat.summaries.list", conversationId })) as Ok<SummaryRow[]>;
  assert.equal(listed.ok, true);
  return listed.data;
}

function summaryRuns(h: E2E): { id: string; state: string; agent: string }[] {
  return h.db
    .prepare("SELECT id, state, agent FROM chat_runs WHERE purpose = 'history_summary' ORDER BY created_at, id")
    .all() as { id: string; state: string; agent: string }[];
}

function startOf(h: E2E, runId: string) {
  const body = h.nodes.controller.bodies.find((b) => b.runId === runId);
  assert.ok(body !== undefined, "节点收到了 Run " + runId + " 的 StartRun");
  return body;
}

/** 这条消息那次回答实际发给节点的 Snapshot 正文 */
function replyContent(h: E2E, messageId: string): string {
  const row = h.db
    .prepare("SELECT id FROM chat_runs WHERE purpose = 'reply' AND slot_id IN (SELECT id FROM chat_reply_slots WHERE user_message_id = ?)")
    .get(messageId) as { id: string } | undefined;
  assert.ok(row !== undefined, "这条消息有回答 Run");
  return startOf(h, row.id).snapshot.content;
}

const TERMINAL_RUN = new Set(["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"]);

/** 回答答完、而且没有还在跑的摘要 Run（摘要是回答收尾后异步起的，不能只看回答位） */
async function quiet(h: E2E, messageId: string, summaryRunsAfter: number): Promise<void> {
  await waitFor(() => {
    const slot = h.db.prepare("SELECT outcome FROM chat_reply_slots WHERE user_message_id = ?").get(messageId) as
      | { outcome: string }
      | undefined;
    const runs = summaryRuns(h);
    return (
      slot !== undefined &&
      slot.outcome !== "running" &&
      runs.length === summaryRunsAfter &&
      runs.every((run) => TERMINAL_RUN.has(run.state)) &&
      h.chat.activeCount() === 0
    );
  }, "message " + messageId + " settled with " + summaryRunsAfter + " summary runs");
}

const marker = (n: number) => "M" + String(n).padStart(2, "0") + "号";

describe("X-35b 聊天历史摘要（真流程）", () => {
  const SENTINEL = "SENTINEL-" + ulid();

  it("#1 聊满 40 条后写出摘要，之后的回答带摘要、不带被摘要的原文；撤回被摘要的一条 → stale、下一次回答不含它、之后重写", async () => {
    const c = clock();
    const h = await makeE2E({ now: c.now });
    try {
      const conv = (await ok<{ id: string }>(h, {
        type: "chat.conversation.create",
        members: { kind: "direct", agent: "deepseek" },
        title: null,
      })).id;
      const node = h.nodes.controller;
      const ids: string[] = [];

      /** 第 n 条：只排这一次要用的行为，多排了会串到下一次 */
      const say = async (n: number, behaviors: NodeBehavior[], summaryRunsAfter: number, text = marker(n) + " 随便聊聊") => {
        if (n > 1) c.advance(GAP_MS);
        node.setBehavior("deepseek-chat", behaviors);
        const messageId = "cmsg_" + ulid();
        await ok(h, {
          type: "chat.send",
          conversationId: conv,
          messageId,
          content: { kind: "text", text, attachments: [] },
          mentions: { kind: "none" },
          quoteMessageId: null,
          replacesMessageId: null,
        });
        await quiet(h, messageId, summaryRunsAfter);
        ids[n] = messageId;
        return messageId;
      };

      // ① 前 19 问：38 条，还不够（保留 20 + 攒 20 才写），节点上没有任何摘要 Run
      await say(1, [reply("好")], 0, marker(1) + " 这条之后要撤回 " + SENTINEL);
      for (let n = 2; n <= 19; n += 1) await say(n, [reply("好")], 0);
      assert.equal(summaryRuns(h).length, 0, "38 条时还不写摘要");

      // ② 第 20 问：40 条 → 回答结束后起一个 history_summary Run，写的人是汐
      await say(20, [reply("好"), summaryText("- 用户在随便聊；第一条提到了一个暗号")], 1);
      const [firstRun] = summaryRuns(h);
      assert.equal(firstRun!.state, "COMPLETED");
      assert.equal(firstRun!.agent, "deepseek");
      const firstStart = startOf(h, firstRun!.id);
      assert.equal(firstStart.profileId, "deepseek-chat");
      const firstSnapshot = h.db.prepare("SELECT purpose, content_hash FROM chat_snapshots WHERE id = ?").get(firstStart.snapshot.id) as {
        purpose: string;
        content_hash: string;
      };
      assert.equal(firstSnapshot.purpose, "history_summary");
      assert.equal(firstStart.snapshot.contentHash, firstSnapshot.content_hash, "节点收到的就是落库的那份");
      for (let n = 1; n <= 10; n += 1) assert.ok(firstStart.snapshot.content.includes(marker(n)), "摘要 Prompt 带最老的 " + marker(n));
      for (let n = 11; n <= 20; n += 1) assert.ok(!firstStart.snapshot.content.includes(marker(n)), "最近 20 条不进摘要：" + marker(n));

      const [first] = await summaries(h, conv);
      assert.equal(first!.state, "current");
      assert.equal(first!.runId, firstRun!.id);
      assert.equal(first!.sourceMessageIds.length, 20, "最老的 20 条（10 问 10 答）");
      assert.ok(first!.sourceMessageIds.includes(ids[1]!));
      assert.ok(h.events.some((e) => e.type === "chat.summary.updated" && e.summary.id === first!.id && e.summary.state === "current"));

      // ③ 第 21 问：回答 Snapshot 带这份摘要，被摘要的原文不再发给节点（42 条，没覆盖的旧消息只有 2 条，不再写）
      await say(21, [reply("好")], 1);
      const withSummary = replyContent(h, ids[21]!);
      assert.ok(withSummary.includes("第一条提到了一个暗号"), "回答的 Prompt 带摘要");
      assert.ok(withSummary.includes(first!.id));
      for (let n = 1; n <= 10; n += 1) assert.ok(!withSummary.includes(marker(n)), "被摘要的原文不再进：" + marker(n));
      assert.ok(!withSummary.includes(SENTINEL));
      for (let n = 11; n <= 21; n += 1) assert.ok(withSummary.includes(marker(n)), "没被摘要的原文照常进：" + marker(n));

      // ④ 撤回第 1 条（被摘要覆盖的）→ 这份摘要变 stale
      c.advance(GAP_MS);
      await ok(h, { type: "chat.retract", messageId: ids[1]! });
      const afterRetract = await summaries(h, conv);
      assert.equal(afterRetract.find((s) => s.id === first!.id)?.state, "stale");
      assert.ok(h.events.some((e) => e.type === "chat.summary.updated" && e.summary.id === first!.id && e.summary.state === "stale"));

      // ⑤ 第 22 问：回答不含哨兵、不含 stale 摘要；回答结束后把没被覆盖的旧消息重写一份（不含撤回的那条）
      await say(22, [reply("好"), summaryText("- 用户在随便聊（重写）")], 2);
      const afterStale = replyContent(h, ids[22]!);
      assert.ok(!afterStale.includes(SENTINEL), "下一次回答不含被撤回的那条");
      assert.ok(!afterStale.includes("第一条提到了一个暗号"), "stale 的摘要不再发");
      for (let n = 2; n <= 10; n += 1) assert.ok(afterStale.includes(marker(n)), "摘要失效后原文重新进：" + marker(n));

      const secondRun = summaryRuns(h)[1]!;
      assert.equal(secondRun.state, "COMPLETED");
      const secondStart = startOf(h, secondRun.id);
      assert.ok(!secondStart.snapshot.content.includes(SENTINEL), "重写摘要的 Prompt 也不含撤回的那条");
      const rewritten = (await summaries(h, conv)).find((s) => s.runId === secondRun.id);
      assert.ok(rewritten !== undefined);
      assert.equal(rewritten.state, "current");
      assert.ok(!rewritten.sourceMessageIds.includes(ids[1]!), "来源不含撤回的那条");
      assert.ok(rewritten.sourceMessageIds.includes(ids[2]!), "从没被撤回的最早一条开始");

      // ⑥ 第 23 问：带新摘要，不带旧的
      await say(23, [reply("好")], 2);
      const latest = replyContent(h, ids[23]!);
      assert.ok(latest.includes("用户在随便聊（重写）"));
      assert.ok(!latest.includes("第一条提到了一个暗号"));
      assert.ok(!latest.includes(SENTINEL));
    } finally {
      await h.close();
    }
  });

  it("#2 摘要 Run 失败：只起一个、记失败、不写摘要、不当场重来；下一次回答结束再写成功", async () => {
    const c = clock();
    const h = await makeE2E({ now: c.now });
    try {
      const conv = (await ok<{ id: string }>(h, {
        type: "chat.conversation.create",
        members: { kind: "direct", agent: "deepseek" },
        title: null,
      })).id;
      const node = h.nodes.controller;
      const say = async (n: number, behaviors: NodeBehavior[], summaryRunsAfter: number) => {
        if (n > 1) c.advance(GAP_MS);
        node.setBehavior("deepseek-chat", behaviors);
        const messageId = "cmsg_" + ulid();
        await ok(h, {
          type: "chat.send",
          conversationId: conv,
          messageId,
          content: { kind: "text", text: marker(n), attachments: [] },
          mentions: { kind: "none" },
          quoteMessageId: null,
          replacesMessageId: null,
        });
        await quiet(h, messageId, summaryRunsAfter);
        return messageId;
      };

      for (let n = 1; n <= 19; n += 1) await say(n, [reply("好")], 0);
      await say(20, [reply("好"), { kind: "error", reason: "internal", message: "节点挂了" }], 1);
      // 给「当场重来」留时间：如果会重试风暴，这段时间里会冒出更多摘要 Run
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(summaryRuns(h).length, 1, "失败后不当场重来");
      assert.notEqual(summaryRuns(h)[0]!.state, "COMPLETED");
      assert.equal((await summaries(h, conv)).length, 0, "失败不写摘要");
      assert.equal(h.chat.activeCount(), 0);

      await say(21, [reply("好"), summaryText("- 第二次写成功了")], 2);
      const runs = summaryRuns(h);
      assert.equal(runs[1]!.state, "COMPLETED");
      const written = await summaries(h, conv);
      assert.equal(written.length, 1);
      assert.equal(written[0]!.state, "current");
      assert.equal(written[0]!.content, "- 第二次写成功了");
    } finally {
      await h.close();
    }
  });
});
