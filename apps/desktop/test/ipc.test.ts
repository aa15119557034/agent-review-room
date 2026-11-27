import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { AgentAdapter } from "@room/core";
import { chatSourceReference, createChatToTopic, openDatabase, retractChatMessage, ulid, WriteQueue } from "@room/db";
import type { ControlEvent } from "@room/schemas";
import { createDispatcher } from "../src/main/ipc";
import { NodeService } from "../src/main/nodes";
import { Repository } from "../src/main/repository";
import { SettingsStore, type SafeStorageLike } from "../src/main/settings";
import { sourceChat, SOURCE_TIME as T } from "../../../packages/db/test/source-fixtures";

const dirs: string[] = [];
after(() => {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // Windows 句柄延迟
    }
  }
});

const fakeSafeStorage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from("enc:" + plain, "utf8"),
  decryptString: (enc) => enc.toString("utf8").slice(4),
};

function makeDispatcher(options: { withToken?: boolean } = {}) {
  const d = mkdtempSync(join(tmpdir(), "room-ipc-"));
  dirs.push(d);
  const db = openDatabase(join(d, "test.db"));
  const queue = new WriteQueue();
  const repo = new Repository(db, queue);
  const settings = new SettingsStore(join(d, "settings.json"), fakeSafeStorage);
  const events: ControlEvent[] = [];

  if (options.withToken === true) {
    settings.updateReviewerNode({ baseUrl: "http://127.0.0.1:7420", profileId: "claude-review", token: "t".repeat(40) });
  }

  const started: string[] = [];
  const orchestrator = {
    start: async (run: { id: string }) => {
      started.push(run.id);
    },
    cancel: () => true,
    isRunning: () => false,
  } as never;

  const nodes = new NodeService({
    repo,
    settings,
    probe: async () => ({ reachable: false, error: "unreachable", message: "unused in these tests" }),
  });

  const dispatcher = createDispatcher({
    repo,
    settings,
    orchestrator,
    discussion: {} as never,
    nodes,
    appVersion: "0.0.0-test",
    recoveredRuns: 0,
    emit: (event: ControlEvent) => events.push(event),
  });

  return { dispatcher, events, started, db, repo, queue };
}

describe("command validation", () => {
  it("reports a revoked approval source as stale_snapshot without consuming the approval or dispatching a run", async () => {
    const { dispatcher, db, repo, queue, started, events } = makeDispatcher({ withToken: true });
    try {
      const c = await sourceChat(db, queue);
      const ref = chatSourceReference(db, c.question.id, c.conversation.id, T);
      const { project } = await createChatToTopic(db, queue, { projectId: "proj_" + ulid(), materialId: "msg_" + ulid(), conversationId: c.conversation.id, name: "approval sources", chatMessageIds: [c.question.id], content: "Use the source", createdAt: T });
      const source = await repo.addSource(project.id, "deepseek", "Use the source", [ref]);
      const contribution = await repo.createContribution({ projectId: project.id, sourceMessageId: source.id, contributionType: "evidence", title: "source", selection: { start: 0, end: 3 } });
      const { snapshot, approval } = await repo.createSnapshot({ projectId: project.id, contributionIds: [contribution.id], reviewerAgent: "claude-review", taskInstruction: "read" });
      retractChatMessage(db, c.question.id, T);
      const result = await dispatcher.handleCommand({ type: "approval.approve", approvalId: approval.id, expectedSnapshotHash: snapshot.contentHash });
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.error, "stale_snapshot");
        assert.match(result.message, /重新生成 Prompt/);
      }
      assert.equal(repo.getApproval(approval.id).state, "READY_FOR_REVIEW");
      assert.deepEqual(started, []);
      assert.deepEqual(events, []);
    } finally { db.close(); }
  });

  it("rejects an unknown command type", async () => {
    const { dispatcher } = makeDispatcher();
    const result = await dispatcher.handleCommand({ type: "nope" });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false ? result.error : null, "validation_failed");
  });

  it("rejects a well-formed type with bad fields", async () => {
    const { dispatcher } = makeDispatcher();
    const result = await dispatcher.handleCommand({ type: "project.create", name: "" });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false ? result.error : null, "validation_failed");
  });
});

describe("not-yet-launched commands and queries", () => {
  const CONV = "conv_01JAAAAAAAAAAAAAAAAAAAAAAA";
  const MSG = "cmsg_01JAAAAAAAAAAAAAAAAAAAAAAA";

  it("rejects commands that are not wired yet with a clear message", async () => {
    const { dispatcher } = makeDispatcher();
    const commands = [
      { type: "image.pick", purpose: "avatar" },
      { type: "appearance.update", userDisplayName: "江浩" },
    ];
    for (const command of commands) {
      const result = await dispatcher.handleCommand(command);
      assert.equal(result.ok, false, command.type);
      assert.equal(result.ok === false ? result.error : null, "validation_failed", command.type);
      assert.match(result.ok === false ? result.message : "", /还没上线/, command.type);
    }
  });

  it("answers the queries the UI makes with contract defaults", async () => {
    const { dispatcher } = makeDispatcher();

    const appearance = await dispatcher.handleQuery({ type: "appearance.get" });
    assert.equal(appearance.ok, true);
    assert.equal(appearance.ok === true ? (appearance.data as { userDisplayName: string }).userDisplayName : "", "我");

    const voices = await dispatcher.handleQuery({ type: "voices.list" });
    assert.equal(voices.ok, true);
    assert.deepEqual(voices.ok === true ? voices.data : null, []);

    // D-39：沉浸模式接到 ChatService；这个 dispatcher 没装聊天服务时明确报错
    const immersive = await dispatcher.handleQuery({ type: "immersive.get", conversationId: CONV });
    assert.equal(immersive.ok, false);
    assert.equal(immersive.ok === false ? immersive.error : null, "internal");
  });
});
describe("phase 0 flow through the dispatcher", () => {
  it("creates a project and lists it", async () => {
    const { dispatcher } = makeDispatcher();
    const created = await dispatcher.handleCommand({ type: "project.create", name: "评审室" });
    assert.equal(created.ok, true);

    const listed = await dispatcher.handleQuery({ type: "projects.list" });
    assert.equal(listed.ok, true);
    assert.equal(listed.ok === true ? (listed.data as unknown[]).length : -1, 1);
  });

  it("builds a snapshot and approval from a selection", async () => {
    const { dispatcher, events } = makeDispatcher();
    const project = await dispatcher.handleCommand({ type: "project.create", name: "p" });
    const projectId = (project as { data: { id: string } }).data.id;

    const message = await dispatcher.handleCommand({
      type: "source.add",
      projectId,
      sourceAgent: "deepseek",
      content: "第一段待审内容",
    });
    assert.equal(events.some((e) => e.type === "message.created"), true);

    const messageId = (message as { data: { id: string } }).data.id;
    const contribution = await dispatcher.handleCommand({
      type: "contribution.create",
      projectId,
      sourceMessageId: messageId,
      contributionType: "issue",
      title: "标题",
      selection: { start: 0, end: 4 },
    });
    assert.equal(contribution.ok, true);

    const contributionId = (contribution as { data: { id: string } }).data.id;
    const snapshot = await dispatcher.handleCommand({
      type: "snapshot.create",
      projectId,
      contributionIds: [contributionId],
      taskInstruction: "找出漏洞",
    });
    assert.equal(snapshot.ok, true);
    const data = (snapshot as {
      data: { snapshot: { content: string; contentHash: string; contributionIds: string[] }; approval: { state: string } };
    }).data;
    assert.equal(data.approval.state, "READY_FOR_REVIEW");
    assert.equal(data.snapshot.contributionIds.length, 1);
    assert.match(data.snapshot.content, /<UNTRUSTED_AGENT_DATA_/);
    assert.equal(data.snapshot.contentHash.length, 64);
  });

  it("refuses to approve when the reviewer node is not configured", async () => {
    const { dispatcher } = makeDispatcher();
    const result = await dispatcher.handleCommand({
      type: "approval.approve",
      approvalId: "apr_01JABCDEFGHJKMNPQRSTVWXYZ0",
      expectedSnapshotHash: "a".repeat(64),
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false ? result.error : null, "reviewer_not_configured");
  });

  it("marks a stale snapshot hash as stale_snapshot", async () => {
    const { dispatcher } = makeDispatcher({ withToken: true });
    const project = await dispatcher.handleCommand({ type: "project.create", name: "p" });
    const projectId = (project as { data: { id: string } }).data.id;
    const message = await dispatcher.handleCommand({ type: "source.add", projectId, sourceAgent: "deepseek", content: "abcdef" });
    const messageId = (message as { data: { id: string } }).data.id;
    const contribution = await dispatcher.handleCommand({
      type: "contribution.create",
      projectId,
      sourceMessageId: messageId,
      contributionType: "issue",
      title: "t",
      selection: { start: 0, end: 3 },
    });
    const contributionId = (contribution as { data: { id: string } }).data.id;
    const snapshot = await dispatcher.handleCommand({
      type: "snapshot.create",
      projectId,
      contributionIds: [contributionId],
      taskInstruction: "x",
    });
    const approvalId = (snapshot as { data: { approval: { id: string } } }).data.approval.id;

    const result = await dispatcher.handleCommand({ type: "approval.approve", approvalId, expectedSnapshotHash: "b".repeat(64) });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false ? result.error : null, "stale_snapshot");
  });
});

describe("settings", () => {
  it("reports no node before configuration and never leaks the token", async () => {
    const { dispatcher } = makeDispatcher();
    const before = await dispatcher.handleQuery({ type: "settings.get" });
    assert.deepEqual((before as { data: unknown }).data, { reviewerNode: null });

    const updated = await dispatcher.handleCommand({
      type: "settings.updateReviewerNode",
      baseUrl: "http://127.0.0.1:7420",
      profileId: "claude-review",
      token: "t".repeat(40),
    });
    assert.equal(updated.ok, true);
    assert.equal(JSON.stringify(updated).includes("t".repeat(40)), false);

    const status = await dispatcher.handleQuery({ type: "system.status" });
    assert.equal((status as { data: { reviewerConfigured: boolean } }).data.reviewerConfigured, true);
  });
});

describe("approve guard", () => {
  async function seedSnapshot(dispatcher: ReturnType<typeof makeDispatcher>["dispatcher"]) {
    const project = await dispatcher.handleCommand({ type: "project.create", name: "p" });
    const projectId = (project as { data: { id: string } }).data.id;
    const message = await dispatcher.handleCommand({ type: "source.add", projectId, sourceAgent: "deepseek", content: "abcdef" });
    const messageId = (message as { data: { id: string } }).data.id;
    const contribution = await dispatcher.handleCommand({
      type: "contribution.create",
      projectId,
      sourceMessageId: messageId,
      contributionType: "issue",
      title: "t",
      selection: { start: 0, end: 3 },
    });
    const contributionId = (contribution as { data: { id: string } }).data.id;
    const snapshot = await dispatcher.handleCommand({
      type: "snapshot.create",
      projectId,
      contributionIds: [contributionId],
      taskInstruction: "x",
    });
    const data = (snapshot as { data: { snapshot: { contentHash: string }; approval: { id: string } } }).data;
    return { approvalId: data.approval.id, contentHash: data.snapshot.contentHash };
  }

  it("approves when the reviewer profile still matches the snapshot", async () => {
    const { dispatcher, started } = makeDispatcher({ withToken: true });
    const { approvalId, contentHash } = await seedSnapshot(dispatcher);

    const result = await dispatcher.handleCommand({ type: "approval.approve", approvalId, expectedSnapshotHash: contentHash });
    assert.equal(result.ok, true);
    assert.equal(started.length, 1, "orchestrator.start must be called");

    const run = (result as { data: { run: { adapterId: string; state: string } } }).data.run;
    assert.equal(run.adapterId, "claude-review", "adapterId 用 snapshot 里的 reviewerAgent");
  });

  it("refuses to approve when the reviewer profile changed since the snapshot", async () => {
    const { dispatcher, started } = makeDispatcher({ withToken: true });
    const { approvalId, contentHash } = await seedSnapshot(dispatcher);

    await dispatcher.handleCommand({
      type: "settings.updateReviewerNode",
      baseUrl: "http://127.0.0.1:7420",
      profileId: "another-profile",
    });

    const result = await dispatcher.handleCommand({ type: "approval.approve", approvalId, expectedSnapshotHash: contentHash });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false ? result.error : null, "invalid_state");
    assert.equal(started.length, 0);
  });
});
