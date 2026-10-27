import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CHART_FENCE, MEDIA_LIST_MESSAGE_IDS_MAX, SPEAK_MAX_CHARS, type AgentChatMessage, type AgentProfile, type ChatMessage, type MediaJob, type NodeHealth } from "@room/schemas";
import { createMockBridge, type MockOptions } from "../mock/mock-backend";
import { createActions } from "../lib/actions";
import { applyMediaJob, initialMedia, type ChatDraft, type ChatState } from "../lib/chat";
import { draftContent } from "../lib/chat-actions";
import { createClient } from "../lib/client";
import { asksForVoiceReply, canSpeak, chatVision, mergeJobs, routeText, showDrawCard, splitReply, stripCharts } from "../lib/media";
import { initialState } from "../lib/state";
import { createStore } from "../lib/store";

/**
 * C-43：聊天多模态的界面逻辑（图表、看图提示、用语音回、媒体任务合并 / 自动播放）
 * 和 mock 下的流程（画图 / 取消 / 停、沉浸模式名额、播放缓存、撤回取消任务）。
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(check: () => Promise<boolean> | boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(5);
  }
  throw new Error("timed out waiting");
}

const at = (s: number) => new Date(Date.UTC(2026, 9, 27, 0, 0, s)).toISOString();

function job(patch: Partial<MediaJob> & Pick<MediaJob, "id">): MediaJob {
  return {
    kind: "draw", state: "queued", authorization: "user_tap",
    source: { kind: "chat", conversationId: "conv_1", messageId: "cmsg_a", agent: "deepseek" },
    intentHash: null, draw: { prompt: "鲸鱼", size: "1024x1024", backend: "auto" },
    route: null, remoteRunId: null, result: null, speech: null, failure: null, cancelReason: null,
    createdAt: at(0), startedAt: null, finishedAt: null, ...patch,
  } as MediaJob;
}

const clip = (n: number) => ({
  id: `spch_${n}`, textHash: "a".repeat(64), voiceId: "qingning", speed: 1, engine: "cosyvoice", engineVersion: "1",
  audioRef: `aud_${n}`, mime: "audio/wav", durationMs: 1000, createdAt: at(n),
}) as MediaJob["speech"];

describe("media lib", () => {
  it("splitReply: text / chart / bad chart; an unclosed fence stays text", () => {
    const good = JSON.stringify({ type: "bar", categories: ["a", "b"], series: [{ name: "x", values: [1, 2] }] });
    const segs = splitReply(`前面\n\n\`\`\`${CHART_FENCE}\n${good}\n\`\`\`\n\n中间\n\`\`\`${CHART_FENCE}\nnot json\n\`\`\`\n后面`);
    assert.deepEqual(segs.map((s) => s.kind), ["text", "chart", "text", "bad_chart", "text"]);
    assert.equal(segs[0]!.kind === "text" && segs[0]!.text, "前面");
    assert.equal(segs[3]!.kind === "bad_chart" && segs[3]!.reason, "not_json");

    const open = `看这个\n\`\`\`${CHART_FENCE}\n{"type":"bar"`;
    assert.deepEqual(splitReply(open), [{ kind: "text", text: open }]);
    assert.deepEqual(splitReply(""), [{ kind: "text", text: "" }]);
    assert.equal(stripCharts(`甲\n\`\`\`${CHART_FENCE}\n${good}\n\`\`\`\n乙`), "甲\n[图表]\n乙");
  });

  it("chatVision follows the chat model the agent would actually use", () => {
    const settings = (primaryModel: string | null) => ({ primaryModel, fallbackModel: null, effort: { chat: null, discussion: null, summary: null } });
    const agent = { id: "codex", chatProfileId: "codex-chat", modelSettings: settings(null) } as unknown as AgentProfile;
    const health = (patch: Partial<NodeHealth>) => ({ capabilities: { attachments: true }, profileModels: [], ...patch }) as unknown as NodeHealth;
    const models = [{ id: "sol", label: "sol", vision: "no", efforts: [] }, { id: "astra", label: "astra", vision: "yes", efforts: [] }];

    assert.equal(chatVision(agent, null), "offline");
    assert.equal(chatVision({ ...agent, chatProfileId: null }, health({})), "offline");
    assert.equal(chatVision(agent, health({ capabilities: undefined })), "no_attachments");
    assert.equal(chatVision(agent, health({})), "unknown");
    assert.equal(chatVision(agent, health({ profileModels: [{ profileId: "codex-chat", models: [], fixedModelVision: "yes" }] } as never)), "yes");
    // profile 有模型列表却没选模型 → 不能带图
    const pm = { profileModels: [{ profileId: "codex-chat", models }] } as never;
    assert.equal(chatVision(agent, health(pm)), "no");
    const pick = (m: string) => ({ ...agent, modelSettings: settings(m) }) as unknown as AgentProfile;
    assert.equal(chatVision(pick("sol"), health(pm)), "no");
    assert.equal(chatVision(pick("astra"), health(pm)), "yes");
    assert.equal(chatVision(pick("gone"), health(pm)), "unknown", "the picked model is not on the node");
  });

  it("asksForVoiceReply only matches asking for a voice answer", () => {
    for (const t of ["用语音回我", "这次语音回复我吧", "发条语音", "念给我听听"]) assert.equal(asksForVoiceReply(t), true, t);
    for (const t of ["语音识别准不准？", "你好", "这段录音转写错了"]) assert.equal(asksForVoiceReply(t), false, t);
  });

  it("mergeJobs never moves a job backwards (command result vs. events out of order)", () => {
    const queued = job({ id: "j1" });
    const running = job({ id: "j1", state: "running", startedAt: at(1) });
    const done = job({ id: "j1", state: "succeeded", finishedAt: at(2) });
    assert.deepEqual(mergeJobs([done], [running]), [done]);
    assert.deepEqual(mergeJobs([queued], [running]), [running]);
    assert.deepEqual(mergeJobs([running], [job({ id: "j2" })]).map((j) => j.id), ["j1", "j2"]);
  });

  it("showDrawCard: card when nothing is drawing or drawn; job instead while it runs or after it succeeds", () => {
    const m = { id: "cmsg_a", mediaIntent: { draw: { prompt: "鲸鱼", size: "1024x1024" } } } as unknown as AgentChatMessage;
    assert.equal(showDrawCard({ ...m, mediaIntent: undefined }, []), false);
    assert.equal(showDrawCard(m, []), true);
    assert.equal(showDrawCard(m, [job({ id: "j1", state: "running" })]), false);
    assert.equal(showDrawCard(m, [job({ id: "j1", state: "succeeded" })]), false);
    // 沉浸模式自动画失败（显卡排队超时）→ 退回成卡片，可以再点「画」
    assert.equal(showDrawCard(m, [job({ id: "j1", state: "failed", authorization: "immersive" })]), true);
    assert.equal(showDrawCard(m, [job({ id: "j1", state: "cancelled" })]), true);
    // 林离额度用完：入口只留失败那行的「改用本机画」，不再同时出卡片
    assert.equal(showDrawCard(m, [job({ id: "j1", state: "failed", failure: { reason: "quota_exhausted", message: "x" } })]), false);
  });

  it("canSpeak uses the contract's speakableText, like main does (汐 #115)", () => {
    assert.equal(canSpeak("说".repeat(SPEAK_MAX_CHARS)), true);
    assert.equal(canSpeak("说".repeat(SPEAK_MAX_CHARS + 1)), false);
    assert.equal(canSpeak("说".repeat(1900) + "\n```ts\n" + "x".repeat(9000) + "\n```"), true, "long code block is not read aloud");
    assert.equal(canSpeak("```\nonly code\n```"), false);
  });

  it("routeText says who drew it and the quota before", () => {
    const q = { fiveHour: { usedPercent: 42, windowMinutes: 300, resetsAt: at(9) }, weekly: { usedPercent: 22, windowMinutes: 10080, resetsAt: at(9) }, creditsInUse: false, readAt: at(0) };
    const text = routeText({ backend: "codex", manual: false, confirmedOverThreshold: false, fallbackReason: null, quotaBefore: q, quotaAfter: null } as never);
    assert.match(text, /^林离画的 · 画前：/);
  });

  it("applyMediaJob: a newly finished voice clip plays, or queues behind the one playing; replays don't requeue", () => {
    let c = { ...initialState.chat, currentId: "conv_1", media: initialMedia } as ChatState;
    const speech = (id: string, messageId: string, state: MediaJob["state"], n: number) =>
      job({ id, kind: "speech", state, draw: null, speech: state === "succeeded" ? clip(n) : null, source: { kind: "chat", conversationId: "conv_1", messageId, agent: "claude" } });

    c = applyMediaJob(c, speech("s1", "m1", "running", 1));
    assert.equal(c.media.playing, null);
    c = applyMediaJob(c, speech("s1", "m1", "succeeded", 1));
    assert.equal(c.media.playing, "m1");
    assert.equal(c.media.clips.m1?.audioRef, "aud_1");
    c = applyMediaJob(c, speech("s2", "m2", "succeeded", 2));
    assert.deepEqual([c.media.playing, c.media.playQueue], ["m1", ["m2"]]);
    // 同一个事件再来一次（重连补发）不重复排队
    c = applyMediaJob(c, speech("s2", "m2", "succeeded", 2));
    assert.deepEqual(c.media.playQueue, ["m2"]);
    // 别的会话的任务不管
    const other = applyMediaJob(c, { ...speech("s3", "m3", "succeeded", 3), source: { kind: "chat", conversationId: "conv_2", messageId: "m3", agent: "claude" } });
    assert.equal(other, c);
  });

  it("draftContent: voice needs a transcript; text needs text or an attachment", () => {
    const d = { text: "", attachments: [], voice: null } as unknown as ChatDraft;
    assert.equal(draftContent(d), null);
    assert.equal(draftContent({ ...d, voice: { audio: "aud_1", text: "  " } }), null);
    assert.deepEqual(draftContent({ ...d, voice: { audio: "aud_1", text: " 你好 " } }), { kind: "voice", audio: "aud_1", transcriptText: "你好" });
    assert.deepEqual(draftContent({ ...d, attachments: [{ kind: "image", ref: "img_1", name: "a.jpg" }] }), {
      kind: "text", text: "", attachments: [{ kind: "image", ref: "img_1" }],
    });
  });
});

describe("C-43 through the UI actions (mock)", () => {
  function app(opts: MockOptions = {}) {
    const mock = createMockBridge({ tickMs: 1, reviewerConfigured: true, ...opts });
    // 测试能看到发出去的查询，也能把某个命令的回包扣住，等测试放行（模拟对话框开着、IPC 慢）
    const queries: { type: string; messageIds?: string[] }[] = [];
    const held = new Map<string, Promise<void>>();
    const bridge: typeof mock = {
      ...mock,
      query: ((r: { type: string; messageIds?: string[] }) => {
        queries.push(structuredClone(r));
        return mock.query(r as never);
      }) as typeof mock.query,
      command: (async (r: { type: string }) => {
        const result = await mock.command(r as never);
        await held.get(r.type);
        return result;
      }) as typeof mock.command,
    };
    const hold = (type: string) => {
      let release!: () => void;
      held.set(type, new Promise<void>((r) => (release = r)));
      return () => {
        held.delete(type);
        release();
      };
    };
    const store = createStore(initialState);
    const actions = createActions(store, createClient(bridge));
    return { store, actions, queries, hold };
  }
  const agentReply = (msgs: readonly ChatMessage[]) => msgs.filter((m): m is AgentChatMessage => m.sender === "agent").at(-1);
  const jobsOf = (store: ReturnType<typeof app>["store"], kind: MediaJob["kind"]) => store.get().chat.media.jobs.filter((j) => j.kind === kind);

  it("a reply that asks to draw → tap 「画」 → one job that ends exactly once with an image", async () => {
    const { store, actions } = app();
    await actions.start();
    actions.goChat();
    await actions.chat.createConversation({ kind: "direct", agent: "deepseek" }, null);
    actions.chat.setDraftText("帮我画个头像");
    await actions.chat.send();
    await until(() => !!agentReply(store.get().chat.messages));
    const reply = agentReply(store.get().chat.messages)!;
    assert.ok(reply.mediaIntent?.draw);
    assert.equal(showDrawCard(reply, store.get().chat.media.jobs), true);

    const src = { kind: "chat" as const, conversationId: reply.conversationId, messageId: reply.id, agent: reply.agent };
    const request = { ...reply.mediaIntent.draw, backend: "auto" as const };
    const preview = await actions.chat.media.previewDraw(request);
    assert.equal(preview?.backend, "codex");
    assert.equal(await actions.chat.media.startDraw(request, src, false), true);
    await until(() => jobsOf(store, "draw").some((j) => j.state === "succeeded"));
    const [j] = jobsOf(store, "draw");
    assert.equal(j!.authorization, "user_tap");
    assert.equal(j!.route?.backend, "codex");
    assert.ok(j!.result?.ref);
    assert.equal(showDrawCard(reply, store.get().chat.media.jobs), false);
    assert.equal(store.get().notice, null);
  });

  it("over 85% the auto route goes local; cancel and 「停」 end jobs as cancelled", async () => {
    const { store, actions } = app({ media: { codexQuotaPercent: 90 } });
    await actions.start();
    actions.goChat();
    await actions.chat.createConversation({ kind: "direct", agent: "deepseek" }, null);
    actions.chat.setDraftText("画一张");
    await actions.chat.send();
    await until(() => !!agentReply(store.get().chat.messages));
    const reply = agentReply(store.get().chat.messages)!;
    const src = { kind: "chat" as const, conversationId: reply.conversationId, messageId: reply.id, agent: reply.agent };
    const request = { ...reply.mediaIntent!.draw!, backend: "auto" as const };
    const preview = await actions.chat.media.previewDraw(request);
    assert.deepEqual([preview?.backend, preview?.fallbackReason, preview?.codexManual], ["comfyui", "quota_threshold", "confirm"]);

    await actions.chat.media.startDraw(request, src, false);
    const first = jobsOf(store, "draw")[0]!;
    await actions.chat.media.cancelJob(first.id);
    assert.equal(jobsOf(store, "draw")[0]!.cancelReason, "user_cancel");

    await actions.chat.media.startDraw({ ...request, prompt: "换一张" }, src, false);
    await actions.chat.media.stop();
    const all = jobsOf(store, "draw");
    assert.deepEqual(all.map((j) => [j.state, j.cancelReason]), [["cancelled", "user_cancel"], ["cancelled", "user_stop"]]);
    // 取消之后不会再来结果
    await sleep(40);
    assert.ok(jobsOf(store, "draw").every((j) => j.state === "cancelled" && j.result === null));
  });

  it("「用语音回」 makes a reply_as_voice clip that autoplays; 「播放」 again uses the cache", async () => {
    const { store, actions } = app();
    await actions.start();
    actions.goChat();
    await actions.chat.createConversation({ kind: "direct", agent: "claude" }, null);
    actions.chat.setDraftText("用语音回我：今天几点开会");
    // 说了「用语音回我」→ 自动点亮
    const cid = store.get().chat.currentId!;
    assert.equal(store.get().chat.drafts[cid]?.replyAsVoice, true);
    await actions.chat.send();
    await until(() => jobsOf(store, "speech").some((j) => j.state === "succeeded"));
    const reply = agentReply(store.get().chat.messages)!;
    assert.equal(jobsOf(store, "speech")[0]!.authorization, "reply_as_voice");
    assert.equal(store.get().chat.media.playing, reply.id);

    actions.chat.media.playEnded();
    assert.equal(store.get().chat.media.playing, null);
    await actions.chat.media.play(reply.id, reply.agent);
    assert.equal(store.get().chat.media.playing, reply.id);
    assert.equal(jobsOf(store, "speech").length, 1);
  });

  it("immersive: auto-draw within the hourly limit, the rest is deferred and shown as a card", async () => {
    const { store, actions } = app();
    await actions.start();
    actions.goChat();
    await actions.chat.createConversation({ kind: "direct", agent: "deepseek" }, null);
    await actions.chat.media.updateImmersive({ enabled: true, autoDrawUsesSubscription: false, drawsPerHour: 1, voiceClipsPerHour: 0 });
    assert.equal(store.get().chat.media.immersive?.settings.enabled, true);

    for (const t of ["画一张海", "再画一张山"]) {
      actions.chat.setDraftText(t);
      await actions.chat.send();
      await until(() => store.get().chat.slots.every((s) => s.outcome !== "running") && store.get().chat.messages.filter((m) => m.sender === "agent").length === (t.startsWith("画") ? 1 : 2));
    }
    const [r1, r2] = store.get().chat.messages.filter((m): m is AgentChatMessage => m.sender === "agent");
    await until(() => jobsOf(store, "draw").some((j) => j.state === "succeeded"));
    const auto = jobsOf(store, "draw");
    assert.equal(auto.length, 1);
    assert.equal(auto[0]!.authorization, "immersive");
    // 这个会话关了「自动画图用订阅」→ 只走本机
    assert.deepEqual([auto[0]!.route?.backend, auto[0]!.route?.fallbackReason], ["comfyui", "session_local_only"]);
    assert.equal(r1!.immersiveDeferred, undefined);
    assert.deepEqual(r2!.immersiveDeferred, { draw: "hourly_limit" });
    assert.equal(showDrawCard(r2!, store.get().chat.media.jobs), true);
  });

  it("one draw at a time per message: a second start while the first is in flight or running is refused", async () => {
    const { store, actions } = app();
    await actions.start();
    actions.goChat();
    await actions.chat.createConversation({ kind: "direct", agent: "deepseek" }, null);
    actions.chat.setDraftText("画一张");
    await actions.chat.send();
    await until(() => !!agentReply(store.get().chat.messages));
    const reply = agentReply(store.get().chat.messages)!;
    const src = { kind: "chat" as const, conversationId: reply.conversationId, messageId: reply.id, agent: reply.agent };
    const d = reply.mediaIntent!.draw!;
    const [a, b] = await Promise.all([
      actions.chat.media.startDraw({ ...d, backend: "comfyui" }, src, false),
      actions.chat.media.startDraw({ ...d, backend: "auto" }, src, false),
    ]);
    assert.deepEqual([a, b], [true, false]);
    assert.equal(await actions.chat.media.startDraw({ ...d, backend: "codex" }, src, false), false, "still running");
    assert.equal(jobsOf(store, "draw").length, 1);
    assert.equal(store.get().chat.media.drawRequested[reply.id], true);
    assert.deepEqual(store.get().chat.media.drawStarting, {});
  });

  it("「照这条画一张」 on your own message: the job belongs to that message (shown under it, 汐 #115)", async () => {
    const { store, actions } = app();
    await actions.start();
    actions.goChat();
    await actions.chat.createConversation({ kind: "direct", agent: "claude" }, null);
    actions.chat.setDraftText("一只小鲸鱼");
    await actions.chat.send();
    const mine = store.get().chat.messages.find((m) => m.sender === "user")!;
    const src = { kind: "chat" as const, conversationId: mine.conversationId, messageId: mine.id, agent: null };
    assert.equal(await actions.chat.media.startDraw({ prompt: "一只小鲸鱼", size: "1024x1024", backend: "comfyui" }, src, false), true);
    await until(() => jobsOf(store, "draw")[0]?.state === "succeeded");
    const j = jobsOf(store, "draw")[0]!;
    assert.deepEqual([j.source.kind === "chat" && j.source.messageId, j.source.kind === "chat" && j.source.agent], [mine.id, null]);
  });

  it("re-edit puts the text back but not the old attachments or voice", async () => {
    const { store, actions } = app();
    await actions.start();
    actions.goChat();
    await actions.chat.createConversation({ kind: "direct", agent: "claude" }, null);
    actions.chat.setDraftText("看看这个");
    await actions.chat.send();
    const mine = store.get().chat.messages.find((m) => m.sender === "user")!;
    await actions.chat.retract(mine.id);
    await actions.chat.media.pickAttachment("image");
    const cid = store.get().chat.currentId!;
    assert.equal(store.get().chat.drafts[cid]!.attachments.length, 1);
    actions.chat.startReedit(mine.id);
    const d = store.get().chat.drafts[cid]!;
    assert.deepEqual([d.text, d.attachments, d.voice, d.replacesMessageId], ["看看这个", [], null, mine.id]);
  });

  it("a recording and a late cancel stay with the conversation they started in (林离 #115)", async () => {
    const { store, actions } = app();
    await actions.start();
    actions.goChat();
    await actions.chat.createConversation({ kind: "direct", agent: "deepseek" }, null);
    const a = store.get().chat.currentId!;
    actions.chat.setDraftText("画一张");
    await actions.chat.send();
    await until(() => !!agentReply(store.get().chat.messages));
    const reply = agentReply(store.get().chat.messages)!;
    const src = { kind: "chat" as const, conversationId: a, messageId: reply.id, agent: reply.agent };
    await actions.chat.media.startDraw({ ...reply.mediaIntent!.draw!, backend: "comfyui" }, src, false);
    const jobId = jobsOf(store, "draw")[0]!.id;

    await actions.chat.createConversation({ kind: "direct", agent: "claude" }, null);
    const b = store.get().chat.currentId!;
    assert.notEqual(a, b);
    // 在 A 录的音，停的时候已经在 B：只进 A 的草稿
    await actions.chat.media.importVoice(a, "webm", "AAAA");
    assert.ok(store.get().chat.drafts[a]?.voice);
    assert.equal(store.get().chat.drafts[b]?.voice ?? null, null);
    // A 的任务取消回包到了 B：不并进 B
    await actions.chat.media.cancelJob(jobId);
    assert.ok(store.get().chat.media.jobs.every((j) => j.source.kind === "chat" && j.source.conversationId === b));
  });

  it("while a recording uploads you can't add files, and a late draw result only closes its own card (林离 #115)", async () => {
    const { store, actions, hold } = app();
    await actions.start();
    actions.goChat();
    await actions.chat.createConversation({ kind: "direct", agent: "deepseek" }, null);
    const a = store.get().chat.currentId!;
    const importing = actions.chat.media.importVoice(a, "webm", "AAAA");
    assert.equal(store.get().chat.media.voiceImporting[a], true);
    await actions.chat.media.pickAttachment("image");
    await importing;
    const d = store.get().chat.drafts[a]!;
    assert.deepEqual([!!d.voice, d.attachments.length], [true, 0]);
    assert.deepEqual(store.get().chat.media.voiceImporting, {});

    // 草稿里已经有附件时录音回来：不丢附件，录音不放进去，并提示
    actions.chat.media.cancelVoice();
    await actions.chat.media.pickAttachment("file");
    await actions.chat.media.importVoice(a, "webm", "AAAA");
    const d2 = store.get().chat.drafts[a]!;
    assert.deepEqual([d2.voice, d2.attachments.length], [null, 1]);
    assert.ok(store.get().notice);

    // A 的画图回包到达时你开着 B 的请求卡：不关 B 的卡
    actions.chat.setDraftText("画一张");
    await actions.chat.send();
    await until(() => !!agentReply(store.get().chat.messages));
    const reply = agentReply(store.get().chat.messages)!;
    const src = { kind: "chat" as const, conversationId: a, messageId: reply.id, agent: reply.agent };
    const p = actions.chat.media.startDraw({ ...reply.mediaIntent!.draw!, backend: "comfyui" }, src, false);
    actions.chat.media.openDrawCard("cmsg_other", "别的");
    await p;
    assert.deepEqual(store.get().chat.sheet, { kind: "draw", messageId: "cmsg_other", prompt: "别的" });

    // 选文件对话框开着时切了会话：回包扣到切换完成后才放行，附件进开始时的会话（林离 #115）
    const release = hold("chat.attachment.pick");
    const picking = actions.chat.media.pickAttachment("image");
    await actions.chat.createConversation({ kind: "direct", agent: "claude" }, null);
    const b = store.get().chat.currentId!;
    assert.notEqual(b, a);
    assert.equal(store.get().chat.drafts[a]!.attachments.length, 0, "reply still held");
    release();
    await picking;
    assert.equal(store.get().chat.drafts[a]!.attachments.length, 1);
    assert.equal(store.get().chat.drafts[b]?.attachments.length ?? 0, 0);
  });

  it("reopening a chat finds an old drawing behind many later cancels; no request card again (林离 #116)", async () => {
    const { store, actions, queries } = app();
    await actions.start();
    actions.goChat();
    await actions.chat.createConversation({ kind: "direct", agent: "deepseek" }, null);
    const a = store.get().chat.currentId!;
    actions.chat.setDraftText("画一张");
    await actions.chat.send();
    await until(() => !!agentReply(store.get().chat.messages));
    const reply = agentReply(store.get().chat.messages)!;
    const src = { kind: "chat" as const, conversationId: a, messageId: reply.id, agent: reply.agent };
    const d = { ...reply.mediaIntent!.draw!, backend: "comfyui" as const };
    assert.equal(await actions.chat.media.startDraw(d, src, false), true);
    await until(() => jobsOf(store, "draw").some((j) => j.state === "succeeded"));
    const ok = jobsOf(store, "draw").find((j) => j.state === "succeeded")!;
    for (let i = 0; i < 6; i++) {
      assert.equal(await actions.chat.media.startDraw(d, src, false), true);
      const j = jobsOf(store, "draw").find((x) => x.state === "queued" || x.state === "running")!;
      await actions.chat.media.cancelJob(j.id);
      await until(() => jobsOf(store, "draw").every((x) => x.state !== "queued" && x.state !== "running"));
    }
    assert.equal(jobsOf(store, "draw").length, 7);
    assert.ok(jobsOf(store, "draw").filter((j) => j.id !== ok.id).every((j) => j.state === "cancelled"), "later ones all cancelled");

    // 换个会话再回来：按消息查，成功的那张排在 6 次取消后面也查得到
    await actions.chat.createConversation({ kind: "direct", agent: "claude" }, null);
    queries.length = 0;
    await actions.chat.openConversation(a);
    await until(() => jobsOf(store, "draw").length > 0);
    const back = agentReply(store.get().chat.messages)!;
    assert.ok(jobsOf(store, "draw").some((j) => j.id === ok.id && j.state === "succeeded"));
    assert.equal(jobsOf(store, "draw").length, 6, "latest 5 + the old success");
    assert.equal(showDrawCard(back, store.get().chat.media.jobs), false);
    const lists = queries.filter((q) => q.type === "media.list");
    assert.ok(lists.length > 0 && lists.every((q) => q.messageIds && q.messageIds.length > 0));
  });

  it("media.list goes by message, at most MEDIA_LIST_MESSAGE_IDS_MAX ids per query; ids never repeat", async () => {
    const { store, actions, queries } = app();
    await actions.start();
    actions.goChat();
    await actions.chat.createConversation({ kind: "direct", agent: "deepseek" }, null);
    const a = store.get().chat.currentId!;
    // 每分钟只能发 6 条，凑不出一页 14 条以上的真消息：直接按 30 个 id 查（mock 里查不到任务的 id 返回空）
    const ids = Array.from({ length: 30 }, (_, i) => `cmsg_${String(i).padStart(26, "0")}`);
    queries.length = 0;
    await actions.chat.media.loadJobs(a, [...ids, ids[0]!]);
    const lists = queries.filter((q) => q.type === "media.list");
    assert.equal(lists.length, Math.ceil(ids.length / MEDIA_LIST_MESSAGE_IDS_MAX));
    assert.ok(lists.every((q) => q.messageIds!.length <= MEDIA_LIST_MESSAGE_IDS_MAX));
    assert.deepEqual(lists.flatMap((q) => q.messageIds!), ids);
    assert.equal(store.get().notice, null);

    // 打开会话：按那页消息的 id 查
    actions.chat.setDraftText("你好");
    await actions.chat.send();
    await until(() => !!agentReply(store.get().chat.messages));
    await actions.chat.createConversation({ kind: "direct", agent: "claude" }, null);
    queries.length = 0;
    await actions.chat.openConversation(a);
    await until(() => queries.some((q) => q.type === "media.list"));
    const loaded = store.get().chat.messages.map((m) => m.id).sort();
    assert.deepEqual(queries.filter((q) => q.type === "media.list").flatMap((q) => q.messageIds!).sort(), loaded);
  });

  it("retracting a message cancels the media jobs of its answers", async () => {
    const { store, actions } = app();
    await actions.start();
    actions.goChat();
    await actions.chat.createConversation({ kind: "direct", agent: "deepseek" }, null);
    actions.chat.setDraftText("画一张");
    await actions.chat.send();
    await until(() => !!agentReply(store.get().chat.messages));
    const reply = agentReply(store.get().chat.messages)!;
    const src = { kind: "chat" as const, conversationId: reply.conversationId, messageId: reply.id, agent: reply.agent };
    await actions.chat.media.startDraw({ ...reply.mediaIntent!.draw!, backend: "comfyui" }, src, false);
    const mine = store.get().chat.messages.find((m) => m.sender === "user")!;
    await actions.chat.retract(mine.id);
    await until(() => jobsOf(store, "draw")[0]?.state === "cancelled");
    assert.equal(jobsOf(store, "draw")[0]!.cancelReason, "message_withdrawn");
  });
});
