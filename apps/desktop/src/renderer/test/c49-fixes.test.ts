import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { COMMANDS, type AgentProfile, type AgentStatus, type Conversation, type ConversationListItem, type NodeTestResult } from "@room/schemas";
import { createMockBridge } from "../mock/mock-backend";
import { createActions } from "../lib/actions";
import { ControlFailure, createClient, describeFailure, withAgentNames } from "../lib/client";
import { existingDirectWith, nodeDiagnosis, pickerKey, pickerOptions, slotLabel, UNAVAILABLE_LABEL } from "../lib/chat";
import { availabilityText, chatNotConfigured } from "../lib/console";
import { initialDiscussion, recipientBlock, sendableRecipients, setupHint, type DiscussionState } from "../lib/discussion";
import { hasMarkup, inlineMarkup, parseMarkup } from "../lib/markup";
import { quotaText } from "../lib/media";
import { githubSaveBlocker } from "../lib/notes";
import { showTopPackError } from "../lib/packs-actions";
import { RECOMMENDED_AGENTS, presetSteps } from "../lib/presets";
import { initialState } from "../lib/state";
import { createStore } from "../lib/store";

/**
 * C-49：2026-11-12 整体测试（真 Electron + 真 Claude）找到的问题的回归测试。
 * 每组标着测试报告里的编号。
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..", "..", "..");

const agent = (patch: Partial<AgentProfile> & { id: string }): AgentProfile =>
  ({
    displayName: patch.id, color: "#000000", avatarRef: null, roleNote: "", canDiscuss: true, canSummarize: false, canExecute: false,
    nodeId: "user-pc", profileId: `${patch.id}-discuss`, pausedByUser: false, substitute: null,
    modelSettings: { primaryModel: null, fallbackModel: null, effort: { chat: null, discussion: null, summary: null } },
    chatPersona: "", chatProfileId: `${patch.id}-chat`, memorySource: { chatHistory: true, nodeFolder: false },
    ...patch,
  }) as AgentProfile;
const status = (id: string, availability: AgentStatus["availability"]) => ({ agent: id, availability }) as AgentStatus;

describe("B-01: a clean machine can chat after applying the recommended configuration", () => {
  it("every recommended agent carries the chat profile that the shipped node configs define", () => {
    const profilesIn = (file: string) => Object.keys(JSON.parse(readFileSync(join(repoRoot, "apps", "agent-server", file), "utf8")).profiles);
    const shipped = [...profilesIn("agent-server.config.example.json"), ...profilesIn("agent-server.config.local.example.json")];
    for (const a of RECOMMENDED_AGENTS) {
      assert.ok(a.chatProfileId, `${a.id} has a chat profile`);
      assert.ok(shipped.includes(a.chatProfileId!), `${a.chatProfileId} exists in an example node config`);
      assert.ok(shipped.includes(a.profileId!), `${a.profileId} exists in an example node config`);
      assert.notEqual(a.chatProfileId, a.profileId, "chat and discussion use different profiles (C-34)");
      assert.ok(COMMANDS["agent.update"].request.safeParse({ type: "agent.update", ...a }).success, a.id);
    }
  });

  it("through the mock: after the preset, the agent has a chat profile and a direct chat gets answered", async () => {
    const bridge = createMockBridge({ tickMs: 1, reviewerConfigured: true });
    const store = createStore(initialState);
    const actions = createActions(store, createClient(bridge));
    await actions.updateAgent({ id: "gemini", displayName: "新来的", color: "#123456" });
    assert.equal(store.get().disc.agents.find((a) => a.id === "gemini")?.chatProfileId, null, "a fresh agent has no chat profile");
    for (const a of RECOMMENDED_AGENTS) assert.equal(await actions.updateAgent(a), true);
    for (const a of RECOMMENDED_AGENTS) {
      assert.equal(store.get().disc.agents.find((x) => x.id === a.id)?.chatProfileId, a.chatProfileId);
    }
  });

  it("the secretary page does not just say 在线 when chat is not configured", () => {
    const noChat = agent({ id: "claude", chatProfileId: null });
    assert.equal(chatNotConfigured(noChat), true);
    assert.equal(availabilityText(noChat, status("claude", "available")), "在线（讨论室）· 聊天没配");
    assert.equal(availabilityText(agent({ id: "claude" }), status("claude", "available")), "在线");
    assert.equal(availabilityText(noChat, status("claude", "offline")), "离线");
    assert.equal(availabilityText(noChat, undefined), "未知");
    assert.equal(chatNotConfigured(agent({ id: "claude", nodeId: null, chatProfileId: null })), false, "no node at all is 未配置, not this hint");
    assert.match(UNAVAILABLE_LABEL.unconfigured, /聊天 profile/, "the slot label says what to fill in");
  });
});

describe("B-02: people who cannot be sent to are not stuck as checked recipients", () => {
  const disc = (statuses: Record<string, AgentStatus["availability"]>, recipients: string[], agents = [agent({ id: "claude" }), agent({ id: "deepseek" }), agent({ id: "codex" })]): DiscussionState => ({
    ...initialDiscussion,
    agents,
    status: Object.fromEntries(Object.entries(statuses).map(([id, a]) => [id, status(id, a)])),
    ui: { ...initialDiscussion.ui, composer: { text: "x", recipients } },
  });

  it("only C酱 configured: the default selection (汐、林离) is dropped and C酱 alone can be sent", () => {
    const d = disc({ claude: "available", deepseek: "unconfigured", codex: "unconfigured" }, ["deepseek", "codex", "claude"]);
    assert.deepEqual(sendableRecipients(d), ["claude"]);
    assert.equal(recipientBlock(d, "deepseek"), "unconfigured");
    assert.equal(recipientBlock(d, "claude"), null);
  });

  it("offline and paused are blocked too; nobody sendable means nothing to send", () => {
    const d = disc({ claude: "offline", deepseek: "paused_by_user", codex: "unconfigured" }, ["claude", "deepseek", "codex"]);
    assert.deepEqual(sendableRecipients(d), []);
    assert.deepEqual(["claude", "deepseek", "codex"].map((id) => recipientBlock(d, id)), ["offline", "paused_by_user", "unconfigured"]);
  });

  it("quota absence: kept when a substitute is set (main drafts the substitution), blocked when not", () => {
    const withSub = disc({ claude: "available", deepseek: "available", codex: "absent_quota" }, ["codex", "claude"], [
      agent({ id: "claude" }), agent({ id: "deepseek" }), agent({ id: "codex", substitute: "deepseek" }),
    ]);
    assert.deepEqual(sendableRecipients(withSub), ["codex", "claude"]);
    const noSub = disc({ claude: "available", codex: "absent_quota" }, ["codex", "claude"]);
    assert.deepEqual(sendableRecipients(noSub), ["claude"]);
    assert.equal(recipientBlock(noSub, "codex"), "absent_quota");
  });

  it("status not read yet does not block (main decides); people who left the discussion are not sent to", () => {
    const d = disc({}, ["claude", "gone"]);
    assert.deepEqual(sendableRecipients(d), ["claude"]);
  });

  it("through the mock: round.draft is called with the sendable people only", async () => {
    const bridge = createMockBridge({ tickMs: 1, reviewerConfigured: true });
    const sent: unknown[] = [];
    const spy = { ...bridge, command: (req: never) => (sent.push(req), bridge.command(req)) } as typeof bridge;
    const store = createStore(initialState);
    const actions = createActions(store, createClient(spy));
    await actions.start();
    const project = await actions.createProject("B-02");
    assert.ok(project);
    await actions.updateAgent({ id: "codex", pausedByUser: true });
    const ids = store.get().disc.agents.filter((a) => a.canDiscuss).map((a) => a.id);
    store.set((s) => ({ ...s, disc: { ...s.disc, ui: { ...s.disc.ui, composer: { text: "第一轮", recipients: ids } } } }));
    await actions.draftRound();
    const draft = sent.find((r) => (r as { type: string }).type === "round.draft") as { recipients: string[] } | undefined;
    assert.ok(draft, "round.draft was sent");
    assert.ok(!draft.recipients.includes("codex"), "the paused person is not in the request");
    assert.ok(draft.recipients.length > 0);
    assert.equal(store.get().notice, null, "no error notice");
  });
});

describe("B-08: notices are not doubled and do not show internal ids", () => {
  const agents = [{ id: "claude", displayName: "C酱" }, { id: "codex", displayName: "林离" }];

  it("retry while still unavailable: one sentence, no 'claude'", () => {
    const text = describeFailure(new ControlFailure("agent_unavailable", "claude 现在还是不能答"), agents);
    assert.equal(text, "这位现在还是不能回答。");
  });

  it("rate limit: the hint already says it, the backend sentence is not appended", () => {
    const text = describeFailure(new ControlFailure("rate_limited", "这个会话每分钟最多 6 条，稍等一下"), agents);
    assert.equal(text, "发得太快了：每个会话每分钟最多 6 条，稍等一下再发。");
  });

  it("a specific reason from the backend is shown as is, with display names", () => {
    assert.equal(describeFailure(new ControlFailure("agent_unavailable", "claude 没有配置聊天节点 / profile"), agents), "C酱 没有配置聊天节点 / profile");
    assert.equal(withAgentNames("林离 的 profile codex-discuss 不在节点上", agents), "林离 的 profile codex-discuss 不在节点上", "profile ids are left alone");
    assert.equal(withAgentNames("参与者 codex 还没有配置", agents), "参与者 林离 还没有配置");
  });

  it("other codes keep hint + detail; unknown errors pass through", () => {
    assert.equal(describeFailure(new ControlFailure("not_found", "回答位不存在")), "要找的记录不存在，可能已被删除。（回答位不存在）");
    assert.equal(describeFailure(new Error("boom")), "boom");
  });
});

describe("B-09: 'node offline' can be told apart from a wrong token", () => {
  const health = { profiles: ["claude-review"] } as Extract<NodeTestResult, { reachable: true }>["health"];
  it("each node.test outcome gets its own sentence", () => {
    const d = (r: NodeTestResult) => nodeDiagnosis(r, "你的电脑", "claude-chat");
    assert.match(d({ reachable: false, error: "unauthorized", message: "401" }).text, /Token 不对/);
    assert.match(d({ reachable: false, error: "unreachable", message: "ECONNREFUSED" }).text, /连不上.*ECONNREFUSED/);
    assert.match(d({ reachable: false, error: "timeout", message: "t" }).text, /超时/);
    assert.match(d({ reachable: false, error: "no_token", message: "t" }).text, /还没填 Token/);
    const missing = d({ reachable: true, health, profileAvailable: false, latencyMs: 3 });
    assert.equal(missing.ok, false);
    assert.match(missing.text, /没有 claude-chat.*claude-review/);
    assert.equal(d({ reachable: true, health, profileAvailable: true, latencyMs: 3 }).ok, true);
    assert.notEqual(d({ reachable: false, error: "unauthorized", message: "" }).text, d({ reachable: false, error: "unreachable", message: "" }).text);
  });
  it("the slot label still follows the contract's three reasons", () => {
    assert.equal(slotLabel({ outcome: "unavailable", unavailableReason: "offline" } as never), "不能回答（节点连不上）");
  });
});

describe("B-07: the @ list works from the keyboard", () => {
  it("↑↓ move and wrap, Enter / Tab pick instead of sending, other keys are left alone", () => {
    const options = pickerOptions(["claude", "deepseek"]);
    assert.deepEqual(options, ["all", "claude", "deepseek"]);
    assert.equal(pickerKey("ArrowDown", 0, 3), 1);
    assert.equal(pickerKey("ArrowDown", 2, 3), 0);
    assert.equal(pickerKey("ArrowUp", 0, 3), 2);
    assert.equal(pickerKey("Enter", 1, 3), "pick");
    assert.equal(pickerKey("Tab", 1, 3), "pick");
    assert.equal(pickerKey("a", 1, 3), null);
    assert.equal(pickerKey("Enter", 0, 0), null);
  });
});

describe("B-10: quota percentages say whether they are used or left", () => {
  it("the drawing line says 已用", () => {
    const q = { fiveHour: { usedPercent: 42, windowMinutes: 300, resetsAt: null }, weekly: null, creditsInUse: false, readAt: "2026-11-12T00:00:00.000Z" };
    assert.equal(quotaText(q as never), "5 小时已用 42%、每周 读不到");
  });
});

describe("B-11: a name typed for an existing direct chat is not silently dropped", () => {
  it("finds the existing direct chat", () => {
    const conv = (id: string, kind: "direct" | "group", members: string[]) => ({ conversation: { id, kind, members } as Conversation }) as ConversationListItem;
    const list = [conv("g", "group", ["claude", "codex"]), conv("d", "direct", ["claude"])];
    assert.equal(existingDirectWith(list, "claude")?.id, "d");
    assert.equal(existingDirectWith(list, "codex"), null);
    assert.equal(existingDirectWith(null, "claude"), null);
  });

  it("through the mock: creating it again with a name renames the existing one", async () => {
    const bridge = createMockBridge({ tickMs: 1, reviewerConfigured: true });
    const store = createStore(initialState);
    const actions = createActions(store, createClient(bridge));
    await actions.start();
    await actions.chat.createConversation({ kind: "direct", agent: "claude" }, null);
    const first = store.get().chat.currentId;
    await actions.chat.createConversation({ kind: "direct", agent: "claude" }, "首席");
    assert.equal(store.get().chat.currentId, first, "the same conversation is opened");
    assert.equal(store.get().chat.list?.find((x) => x.conversation.id === first)?.conversation.title, "首席");
    await actions.chat.createConversation({ kind: "direct", agent: "claude" }, null);
    assert.equal(store.get().chat.list?.find((x) => x.conversation.id === first)?.conversation.title, "首席", "no name typed = keep the old one");
  });
});

describe("B-14 / B-15: settings messages", () => {
  it("the same pack error is not shown at the top and in the row", () => {
    const failed = [{ progress: { phase: "failed", error: "PACK_INCOMPLETE" as const } }];
    assert.equal(showTopPackError("PACK_INCOMPLETE", failed), false);
    assert.equal(showTopPackError("PACK_UNKNOWN", failed), true, "an error no row shows stays at the top");
    assert.equal(showTopPackError("PACK_INCOMPLETE", [{ progress: null }]), true);
    assert.equal(showTopPackError(null, failed), false);
  });

  it("GitHub: says why Save is disabled", () => {
    assert.equal(githubSaveBlocker({ repo: "me/notes", repoOk: true, token: "", tokenSet: false }), "还要填 Token 才能保存。");
    assert.equal(githubSaveBlocker({ repo: "me/notes", repoOk: true, token: "", tokenSet: true }), null);
    assert.equal(githubSaveBlocker({ repo: "", repoOk: false, token: "", tokenSet: false }), null, "nothing typed yet");
    assert.match(githubSaveBlocker({ repo: "", repoOk: false, token: "ghp_x", tokenSet: false }) ?? "", /仓库/);
    assert.equal(githubSaveBlocker({ repo: "bad", repoOk: false, token: "", tokenSet: false }), null, "the field already shows a format error");
  });
});

describe("B-16: first launch points at Settings", () => {
  it("no agents / no node → hint; not before the first read, not once someone is configured", () => {
    assert.equal(setupHint({ available: true, agents: [], agentsLoaded: true }), "no_agents");
    assert.equal(setupHint({ available: true, agents: [] }), null, "not loaded yet");
    assert.equal(setupHint({ available: true, agents: [agent({ id: "claude", nodeId: null })], agentsLoaded: true }), "no_node");
    assert.equal(setupHint({ available: true, agents: [agent({ id: "claude" })], agentsLoaded: true }), null);
    assert.equal(setupHint({ available: false, agents: [], agentsLoaded: true }), null);
  });
});

describe("B-03: the minimal markup in replies (bold, inline code, code blocks) — text nodes only", () => {
  it("bold and inline code", () => {
    assert.deepEqual(inlineMarkup("答案是 **4 位数字**，用 `npm test`。"), [
      { kind: "plain", text: "答案是 " },
      { kind: "bold", text: "4 位数字" },
      { kind: "plain", text: "，用 " },
      { kind: "code", text: "npm test" },
      { kind: "plain", text: "。" },
    ]);
  });

  it("things that only look like markup stay as typed", () => {
    for (const t of ["2 ** 3 ** 4", "a ** b", "**没闭合", "`没闭合", "**跨\n行**", "* 列表项\n* 第二项", "# 标题"]) {
      assert.deepEqual(inlineMarkup(t), [{ kind: "plain", text: t }], t);
    }
    assert.deepEqual(inlineMarkup("`a ** b ** c`"), [{ kind: "code", text: "a ** b ** c" }], "code wins over bold");
  });

  it("nothing becomes HTML or a link: tags and links are plain text", () => {
    const t = '<img src=x onerror=alert(1)> [点我](javascript:alert(1)) <b>x</b>';
    assert.deepEqual(parseMarkup(t), [{ kind: "text", spans: [{ kind: "plain", text: t }] }]);
    assert.deepEqual(inlineMarkup("**<script>x</script>**"), [{ kind: "bold", text: "<script>x</script>" }], "still just a string for a text node");
  });

  it("closed code fences become code blocks; unclosed ones stay text; every character is kept", () => {
    const t = "先看：\n```ts\nconst a = 1;\n**不加粗**\n```\n然后 **好**";
    assert.deepEqual(parseMarkup(t), [
      { kind: "text", spans: [{ kind: "plain", text: "先看：" }] },
      { kind: "code", text: "const a = 1;\n**不加粗**" },
      { kind: "text", spans: [{ kind: "plain", text: "然后 " }, { kind: "bold", text: "好" }] },
    ]);
    const open = "```\n没闭合";
    assert.deepEqual(parseMarkup(open), [{ kind: "text", spans: [{ kind: "plain", text: open }] }]);
    assert.deepEqual(parseMarkup(""), [{ kind: "text", spans: [{ kind: "plain", text: "" }] }]);
  });

  it("plain replies skip the extra structure", () => {
    assert.equal(hasMarkup("1加1等于2。"), false);
    assert.equal(hasMarkup("**x**"), true);
  });
});

describe("C-49: applying the recommended configuration does not stop at the first unsaved node", () => {
  it("only 你的电脑 saved: the two controller nodes are created first, everyone is applied", () => {
    const plan = presetSteps(["user-pc"]);
    assert.deepEqual(plan.nodes.map((n) => [n.id, n.baseUrl]), [["controller-local", "http://127.0.0.1:7420"], ["controller-local-codex", "http://127.0.0.1:7421"]]);
    assert.deepEqual(plan.agents.map((a) => a.nodeId), ["user-pc", "controller-local", "controller-local-codex"]);
    assert.deepEqual(plan.unplaced, []);
  });

  it("nothing saved: C酱 is still created, without a node, and the user is told", () => {
    const plan = presetSteps([]);
    assert.equal(plan.agents.find((a) => a.id === "claude")?.nodeId, null);
    assert.equal(plan.agents.find((a) => a.id === "claude")?.chatProfileId, "claude-chat");
    assert.deepEqual(plan.unplaced, ["C酱"]);
    for (const a of plan.agents) assert.ok(COMMANDS["agent.update"].request.safeParse({ type: "agent.update", ...a }).success, a.id);
  });

  it("everything saved: nothing to create", () => {
    const plan = presetSteps(["user-pc", "controller-local", "controller-local-codex"]);
    assert.deepEqual([plan.nodes, plan.unplaced], [[], []]);
    assert.deepEqual(plan.agents, [...RECOMMENDED_AGENTS]);
  });
});

describe("C-49 / B-09: the secretary page re-reads who is online when it opens", () => {
  it("opening the console queries agents.status again (node settings changes send no event)", async () => {
    const bridge = createMockBridge({ tickMs: 1, reviewerConfigured: true });
    let statusReads = 0;
    const spy = { ...bridge, query: (req: never) => ((req as { type: string }).type === "agents.status" && statusReads++, bridge.query(req)) } as typeof bridge;
    const store = createStore(initialState);
    const actions = createActions(store, createClient(spy));
    await actions.start();
    const before = statusReads;
    await actions.agentConsole.open();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(statusReads, before + 1);
    await actions.refreshStatus();
    assert.equal(statusReads, before + 2);
    assert.ok(Object.keys(store.get().disc.status).length > 0);
  });
});
