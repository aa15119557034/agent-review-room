import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ChatRun,
  ChatWindowDraft,
  ChatWindowStatus,
  COMMANDS,
  ControlEvent,
  extractRoomNote,
  GithubRepoName,
  GithubSyncStatus,
  githubNotePath,
  noteShrankALot,
  PROJECT_NOTE_LIMITS,
  ProjectNote,
  QUERIES,
} from "../src/index";

const ID = "01JAAAAAAAAAAAAAAAAAAAAAAA";
const ID2 = "01JAAAAAAAAAAAAAAAAAAAAAAB";
const T = "2026-11-02T12:00:00.000Z";
const H = "a".repeat(64);
const conv = { kind: "conversation", conversationId: `conv_${ID}` } as const;
const topic = { kind: "topic", projectId: `proj_${ID}` } as const;

const note = (o: Record<string, unknown> = {}) => ({
  id: `note_${ID}`,
  scope: topic,
  agent: "claude",
  version: 1,
  parentId: null,
  content: "我负责界面",
  contentHash: H,
  updatedBy: "agent",
  reason: "reply",
  source: { kind: "turn", turnId: `turn_${ID}` },
  revertedFromId: null,
  shrankALot: false,
  createdAt: T,
  ...o,
});

describe("room-note block (C-46)", () => {
  it("cuts exactly one block out of the reply", () => {
    const r = extractRoomNote("好的，我记下了。\n\n```room-note\n- 我负责界面\n- 周五前交\n```\n\n还有问题吗？");
    assert.deepEqual(r, { kind: "ok", content: "- 我负责界面\n- 周五前交", text: "好的，我记下了。\n\n\n还有问题吗？" });
  });

  it("no block → none; empty block clears the note", () => {
    assert.deepEqual(extractRoomNote("```js\nx\n```"), { kind: "none" });
    assert.deepEqual(extractRoomNote("```room-note\n```"), { kind: "ok", content: "", text: "" });
  });

  it("a longer fence may contain ``` code blocks", () => {
    const r = extractRoomNote("````room-note\n约定：\n```\nnpm test\n```\n````\n");
    assert.equal(r.kind, "ok");
    assert.equal(r.kind === "ok" && r.content, "约定：\n```\nnpm test\n```");
  });

  it("an inner ``` closes a 3-backtick block (CommonMark), and the rest stays in the reply", () => {
    const r = extractRoomNote("```room-note\na\n```\nb\n```");
    assert.equal(r.kind === "ok" && r.content, "a");
  });

  it("two blocks, too long, or unclosed → not saved, and the block text never shows as the reply", () => {
    const two = extractRoomNote("x\n```room-note\na\n```\ny\n```room-note\nb\n```\nz");
    assert.deepEqual(two, { kind: "invalid", reason: "multiple", text: "x\ny\nz" });
    const long = extractRoomNote("```room-note\n" + "字".repeat(PROJECT_NOTE_LIMITS.maxChars + 1) + "\n```\n好");
    assert.deepEqual(long, { kind: "invalid", reason: "too_long", text: "好" });
    const open = extractRoomNote("前面\n```room-note\n半截笔记");
    assert.deepEqual(open, { kind: "invalid", reason: "unclosed", text: "前面" });
  });

  it("the fence must start the line; quoted or indented text is not a block", () => {
    assert.deepEqual(extractRoomNote("他写了 ```room-note 这样的块"), { kind: "none" });
    assert.deepEqual(extractRoomNote("  ```room-note\na\n  ```"), { kind: "none" });
  });

  it("shrink warning only when the new version loses more than half", () => {
    assert.equal(noteShrankALot("1234567890", "1234"), true);
    assert.equal(noteShrankALot("1234567890", "12345"), false);
    assert.equal(noteShrankALot("", ""), false);
  });
});

describe("ProjectNote (C-46)", () => {
  it("accepts a reply version and a human edit", () => {
    assert.ok(ProjectNote.safeParse(note()).success);
    const edit = note({ version: 2, parentId: `note_${ID2}`, updatedBy: "human", reason: "human_edit", source: null });
    assert.ok(ProjectNote.safeParse(edit).success);
  });

  it("rejects mismatched reason / author / source / scope", () => {
    const bad = [
      note({ parentId: `note_${ID2}` }), // 第 1 版有上一版
      note({ version: 2 }), // 第 2 版没有上一版
      note({ updatedBy: "human" }), // reply 却是用户
      note({ source: null }), // reply 没来源
      note({ reason: "human_edit", updatedBy: "human" }), // human_edit 带来源
      note({ reason: "revert", updatedBy: "human", source: null }), // revert 没写回退自哪一版
      note({ scope: conv }), // 聊天的笔记来源是 Turn
      note({ reason: "window_handoff" }), // 换窗口只在聊天里
      note({ content: "x".repeat(PROJECT_NOTE_LIMITS.maxChars + 1) }),
    ];
    for (const b of bad) assert.equal(ProjectNote.safeParse(b).success, false, JSON.stringify(b).slice(0, 120));
  });

  it("a handoff note may be written by the agent (with its run) or by you (no run)", () => {
    const base = { scope: conv, reason: "window_handoff", version: 3, parentId: `note_${ID2}` };
    assert.ok(ProjectNote.safeParse(note({ ...base, source: { kind: "chat_run", runId: `run_${ID}` } })).success);
    assert.ok(ProjectNote.safeParse(note({ ...base, updatedBy: "human", source: null })).success);
  });
});

describe("chat window (C-46)", () => {
  const draft = (o: Record<string, unknown> = {}) => ({
    id: `cwd_${ID}`,
    conversationId: `conv_${ID}`,
    agent: "deepseek",
    startsAfterMessageId: `cmsg_${ID}`,
    runId: `run_${ID}`,
    content: null,
    contentBy: null,
    state: "pending",
    windowId: null,
    createdAt: T,
    updatedAt: T,
    ...o,
  });
  const window = {
    id: `cwin_${ID}`,
    conversationId: `conv_${ID}`,
    agent: "deepseek",
    index: 2,
    startsAfterMessageId: `cmsg_${ID}`,
    handoffNoteId: `note_${ID}`,
    draftId: `cwd_${ID}`,
    createdAt: T,
  };

  it("draft: content and author go together; confirmed needs content and a window", () => {
    assert.ok(ChatWindowDraft.safeParse(draft()).success);
    assert.ok(ChatWindowDraft.safeParse(draft({ content: "交接", contentBy: "agent" })).success);
    assert.equal(ChatWindowDraft.safeParse(draft({ content: "交接" })).success, false);
    assert.equal(ChatWindowDraft.safeParse(draft({ state: "confirmed" })).success, false);
    assert.equal(ChatWindowDraft.safeParse(draft({ state: "confirmed", content: "交接", contentBy: "agent" })).success, false);
    assert.ok(ChatWindowDraft.safeParse(draft({ state: "confirmed", content: "交接", contentBy: "agent", windowId: `cwin_${ID}` })).success);
  });

  it("status: window 1 has no record; the reminder follows the compaction count", () => {
    const s = { agent: "deepseek", index: 1, window: null, compactionsInWindow: 2, suggestSwitch: false, pendingDraft: null };
    assert.ok(ChatWindowStatus.safeParse(s).success);
    assert.equal(ChatWindowStatus.safeParse({ ...s, compactionsInWindow: 3 }).success, false);
    assert.ok(ChatWindowStatus.safeParse({ ...s, compactionsInWindow: 3, suggestSwitch: true }).success);
    assert.equal(ChatWindowStatus.safeParse({ ...s, index: 2 }).success, false);
    assert.ok(ChatWindowStatus.safeParse({ ...s, index: 2, window }).success);
    assert.equal(ChatWindowStatus.safeParse({ ...s, pendingDraft: draft({ agent: "claude" }) }).success, false);
  });

  it("window_handoff runs have no reply slot", () => {
    const run = {
      id: `run_${ID}`, kind: "chat", purpose: "window_handoff", conversationId: `conv_${ID}`, slotId: null, agent: "deepseek",
      snapshotId: `snap_${ID}`, snapshotHash: H, finalPromptHash: null, memoryManifest: null, model: null, adapterId: "x",
      state: "QUEUED", substate: null, failureReason: null, createdAt: T, startedAt: null, finishedAt: null,
    };
    assert.ok(ChatRun.safeParse(run).success);
    assert.equal(ChatRun.safeParse({ ...run, slotId: `slot_${ID}` }).success, false);
  });

  it("confirm requires the hash of what you looked at", () => {
    const req = COMMANDS["chat.window.confirm"].request;
    assert.equal(req.safeParse({ type: "chat.window.confirm", draftId: `cwd_${ID}` }).success, false);
    assert.ok(req.safeParse({ type: "chat.window.confirm", draftId: `cwd_${ID}`, expectedContentHash: H }).success);
  });
});

describe("GitHub sync (C-46)", () => {
  it("repo names", () => {
    for (const ok of ["aa15119557034/agent-room-notes", "a/b.c_d-e"]) assert.ok(GithubRepoName.safeParse(ok).success, ok);
    for (const bad of ["no-slash", "a/b/c", "a/.hidden", "a/b.git", "https://github.com/a/b", "a/b c"])
      assert.equal(GithubRepoName.safeParse(bad).success, false, bad);
  });

  it("status never carries the token, and the github.* calls are admin-only", () => {
    const st = { repo: "a/b", tokenSet: true, private: true, pending: 0, lastPushedAt: null, lastError: null, lastErrorMessage: null };
    assert.equal(GithubSyncStatus.safeParse({ ...st, token: "x".repeat(40) }).success, false);
    assert.ok(GithubSyncStatus.safeParse(st).success);
    assert.equal(COMMANDS["github.update"].scope, "admin");
    assert.equal(COMMANDS["github.pushNow"].scope, "admin");
    assert.equal(QUERIES["github.get"].scope, "admin");
  });

  it("note path uses ids, not names", () => {
    assert.equal(githubNotePath(topic, "claude"), `notes/proj_${ID}/claude.md`);
    assert.equal(githubNotePath(conv, "deepseek"), `notes/conv_${ID}/deepseek.md`);
  });

  it("events parse", () => {
    assert.ok(ControlEvent.safeParse({ type: "projectNote.created", note: note() }).success);
    assert.ok(
      ControlEvent.safeParse({ type: "projectNote.rejected", scope: topic, agent: "claude", reason: "multiple", turnId: `turn_${ID}`, runId: null }).success,
    );
  });
});
