import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { openDatabase, type RunRow, WriteQueue } from "@room/db";
import { HttpRemoteAgentAdapter } from "@room/remote-client";
import { ControlEvent, toRunModel, type ApprovalBatch, type CommandRequest, type NodeHealth } from "@room/schemas";
import { ChatService } from "../src/main/chat";
import { DiscussionService } from "../src/main/discussion";
import { createDispatcher } from "../src/main/ipc";
import { NodeService, resolveRunTarget } from "../src/main/nodes";
import { RunOrchestrator } from "../src/main/orchestrator";
import { Repository } from "../src/main/repository";
import { SettingsStore, type SafeStorageLike } from "../src/main/settings";
import { FakeNode, type NodeBehavior } from "./fake-node";

/**
 * X-21 的 e2e harness：真的 DB、真的 dispatcher / DiscussionService / Orchestrator，
 * 节点是本地假 AgentServer（HTTP），主控端走真的 HttpRemoteAgentAdapter。
 */

const dirs: string[] = [];
export const nodes: FakeNode[] = [];
after(async () => {
  for (const node of nodes) await node.stop();
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

export const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

export interface E2E {
  db: ReturnType<typeof openDatabase>;
  dispatcher: ReturnType<typeof createDispatcher>;
  repo: Repository;
  orchestrator: RunOrchestrator;
  settings: SettingsStore;
  events: ControlEvent[];
  projectId: string;
  nodes: { userPc: FakeNode; controller: FakeNode };
  chat: ChatService;
  close: () => Promise<void>;
}

export const ANSWER_JSON = JSON.stringify({
  report: {
    points: [
      {
        text: "要点一",
        source: { kind: "human" },
        stances: [{ agent: "deepseek", stance: "agree", note: null, bySubstituteFor: null }],
      },
    ],
    risks: ["风险一"],
    gaps: [],
    alternatives: [],
    extraInfoNotes: [],
  },
  planContent: "# 方案 v1\n第一版",
});

export async function makeE2E(options: {
  userPc?: Record<string, NodeBehavior | readonly NodeBehavior[]>;
  controller?: Record<string, NodeBehavior | readonly NodeBehavior[]>;
  userPcModels?: NodeHealth["profileModels"];
  controllerModels?: NodeHealth["profileModels"];
  /** X-31：聊天服务的时钟（撤回 / 重新编辑窗口、限流）；不传用真时间 */
  now?: () => string;
  /** X-34b：主控机节点上报的可选能力（带图要 attachments: true） */
  controllerCapabilities?: NodeHealth["capabilities"];
  /** X-34b：图片库（ref → 字节），聊天起跑时按 ref 读本体 */
  imageBytes?: Map<string, Buffer>;
} = {}): Promise<E2E> {
  const dir = mkdtempSync(join(tmpdir(), "room-e2e-"));
  dirs.push(dir);
  const db = openDatabase(join(dir, "test.db"));
  const queue = new WriteQueue();
  const repo = new Repository(db, queue);

  const userPc = new FakeNode({
    nodeId: "user-pc",
    profiles: ["claude-review", "claude-chat"],
    token: "u".repeat(40),
    behavior: options.userPc,
    profileModels: options.userPcModels,
    heartbeatMs: 80,
    leaseMs: 1_000,
  });
  const controller = new FakeNode({
    nodeId: "controller-local",
    profiles: ["deepseek-discuss", "codex-discuss", "deepseek-chat", "codex-chat"],
    token: "c".repeat(40),
    behavior: options.controller,
    profileModels: options.controllerModels,
    capabilities: options.controllerCapabilities,
    heartbeatMs: 80,
    leaseMs: 1_000,
  });
  nodes.push(userPc, controller);
  await userPc.start();
  await controller.start();

  const settings = new SettingsStore(join(dir, "settings.json"), fakeSafeStorage);
  settings.upsertNode("user-pc", { baseUrl: userPc.url, token: userPc.token });
  settings.upsertNode("controller-local", { baseUrl: controller.url, token: controller.token });

  const now = new Date().toISOString();
  const addNode = db.prepare("INSERT INTO nodes (id, display_name, base_url, created_at) VALUES (?, ?, ?, ?)");
  addNode.run("user-pc", "你的电脑", userPc.url, now);
  addNode.run("controller-local", "主控机", controller.url, now);
  const addAgent = db.prepare(
    "INSERT INTO agents (id, display_name, color, role_note, can_discuss, can_summarize, node_id, profile_id, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  addAgent.run("claude", "C酱", "#a0522d", "从整体看问题", 1, 1, "user-pc", "claude-review", now, now);
  addAgent.run("codex", "Codex", "#1f6b55", "务实", 1, 0, "controller-local", "codex-discuss", now, now);
  addAgent.run("deepseek", "DeepSeek", "#2f5aa0", "后端视角", 1, 0, "controller-local", "deepseek-discuss", now, now);
  // X-31：聊天 profile（ADR-003：和讨论分开，只读无工具）
  for (const id of ["claude", "codex", "deepseek"]) db.prepare("UPDATE agents SET chat_profile_id = ? WHERE id = ?").run(id + "-chat", id);

  const events: ControlEvent[] = [];
  const emit = (event: ControlEvent): void => {
    events.push(ControlEvent.parse(event));
  };

  let discussion: DiscussionService | null = null;
  const orchestrator = new RunOrchestrator({
    db,
    queue,
    emit,
    getRun: (runId) => db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as never,
    idleTimeoutMs: 5_000,
    totalTimeoutMs: 15_000,
    onDiscussionSettled: (settlement) => discussion?.settled(settlement),
    adapterFactory: async (run: RunRow) => {
      const target = resolveRunTarget(db, settings, run);
      const adapter = new HttpRemoteAgentAdapter({
        nodeId: target.nodeId,
        baseUrl: target.baseUrl,
        profileId: target.profileId,
        token: target.token,
        ...(target.model === undefined ? {} : { model: target.model }),
        heartbeatTimeoutMs: 2_000,
        reconnectGraceMs: 6_000,
        requestTimeoutMs: 3_000,
        startAttempts: 1,
        reconnectDelayMs: 50,
      });
      await adapter.initialize();
      return adapter;
    },
  });

  discussion = new DiscussionService({ db, queue, repo, settings, orchestrator, emit });
  const chat = new ChatService({
    db,
    queue,
    repo,
    settings,
    emit,
    ...(options.now === undefined ? {} : { now: options.now }),
    readImage: (ref) => options.imageBytes?.get(ref) ?? null,
    idleTimeoutMs: 5_000,
    totalTimeoutMs: 15_000,
    adapterFactory: async (target) => {
      const adapter = new HttpRemoteAgentAdapter({
        nodeId: target.nodeId,
        baseUrl: target.baseUrl,
        profileId: target.profileId,
        token: target.token,
        ...(target.model === undefined ? {} : { model: target.model }),
        heartbeatTimeoutMs: 2_000,
        reconnectGraceMs: 6_000,
        requestTimeoutMs: 3_000,
        startAttempts: 1,
        reconnectDelayMs: 50,
      });
      await adapter.initialize();
      return adapter;
    },
  });
  const dispatcher = createDispatcher({
    repo,
    settings,
    orchestrator,
    discussion,
    chat,
    nodes: new NodeService({ repo, settings }),
    appVersion: "0.0.0-e2e",
    recoveredRuns: 0,
    emit,
  });

  const created = (await dispatcher.handleCommand({ type: "project.create", name: "0-B e2e" })) as {
    ok: boolean;
    data: { id: string };
  };
  assert.equal(created.ok, true);

  const close = async (): Promise<void> => {
    // 正常测试结束时已经没有活跃 Run；hold 类用例还没答完，先取消再等它收尾
    orchestrator.cancelAll();
    chat.cancelAll();
    const deadline = Date.now() + 3_000;
    while ((orchestrator.activeCount() > 0 || chat.activeCount() > 0) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    await userPc.stop();
    await controller.stop();
    db.close();
  };

  return { db, dispatcher, repo, orchestrator, settings, events, projectId: created.data.id, nodes: { userPc, controller }, chat, close };
}

export function failure(result: { ok: boolean }): { error: string; message: string } {
  return result.ok ? { error: "ok", message: "" } : (result as unknown as { error: string; message: string });
}

export async function waitFor(check: () => boolean, what: string, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timeout waiting for " + what);
}

export async function draft(
  h: E2E,
  recipients: string[],
  extra: Partial<{ projectId: string; task: string; planVersionId: string | null; historyMode: "recent_with_summaries" | "full" }> = {},
) {
  return h.dispatcher.handleCommand({
    type: "round.draft",
    projectId: extra.projectId ?? h.projectId,
    recipients,
    task: extra.task ?? "各自说说怎么做",
    taskSource: "human",
    planVersionId: extra.planVersionId ?? null,
    historyMode: extra.historyMode ?? "recent_with_summaries",
  });
}

export interface BatchLike {
  id: string;
  kind: string;
  state: string;
  items: ApprovalBatch["items"];
}

export function approveRequest(batch: BatchLike): CommandRequest<"batch.approve"> {
  return {
    type: "batch.approve",
    batchId: batch.id,
    expected: batch.items.map((item) => ({
      approvalId: item.approvalId,
      contentHash: item.contentHash,
      model: item.model === null ? null : toRunModel(item.model),
    })),
  };
}

export async function approve(h: E2E, batch: BatchLike) {
  return h.dispatcher.handleCommand(approveRequest(batch));
}

export async function approveOf(h: E2E, result: unknown): Promise<BatchLike> {
  const data = (result as { data: { batch: BatchLike } }).data;
  const approved = await approve(h, data.batch);
  assert.equal(approved.ok, true, JSON.stringify(approved));
  return data.batch;
}

export function roundState(h: E2E, roundId: string): string {
  return (h.db.prepare("SELECT state FROM rounds WHERE id = ?").get(roundId) as { state: string }).state;
}

export function turnRows(h: E2E, roundId: string) {
  return h.db
    .prepare("SELECT id, agent, outcome, on_behalf_of, partial_text FROM turns WHERE round_id = ? ORDER BY rowid")
    .all(roundId) as { id: string; agent: string; outcome: string; on_behalf_of: string | null; partial_text: string | null }[];
}

export function runEvents(h: E2E, runId: string): { type: string }[] {
  return h.db.prepare("SELECT type FROM run_events WHERE run_id = ? ORDER BY seq").all(runId) as { type: string }[];
}

/** 等这一轮的所有非汇总 Turn 都有结局 */
export async function waitRoundDone(h: E2E, roundId: string, expected: string): Promise<void> {
  await waitFor(() => roundState(h, roundId) === expected, "round " + expected, 12_000);
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
