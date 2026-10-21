import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { AgentAdapter } from "@room/core";
import { openDatabase, type RunRow, ulid, WriteQueue } from "@room/db";
import { ControlEvent, type AgentEvent } from "@room/schemas";
import { DiscussionService, type NodeProbeResult } from "../src/main/discussion";
import { createDispatcher } from "../src/main/ipc";
import { RunOrchestrator } from "../src/main/orchestrator";
import { Repository } from "../src/main/repository";
import { SettingsStore, type SafeStorageLike } from "../src/main/settings";

/**
 * DiscussionService 的接线（D-22 / PR B）：
 * round.draft → batch.approve →（Run 真跑）→ round.summarize → 再盖章 → summary。
 *
 * 用真实的 RunOrchestrator + 假适配器，这样「盖章 → 起跑 → 收尾推事件」整条链都会被走到；
 * 节点健康检查用注入的 probeNode，不打网络。
 */

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

const NODE_URL = "http://127.0.0.1:7420";
const ANSWER = [{ type: "message_complete", text: "我的回答" }, { type: "completed" }];
/** 汇总者按 X-20 的约定输出一个 JSON；解析出来要有 report 和方案草稿 */
const SUMMARY_JSON = JSON.stringify({
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

const fakeSafeStorage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from("enc:" + plain, "utf8"),
  decryptString: (enc) => enc.toString("utf8").slice(4),
};

const event = (runId: string, seq: number, rest: Record<string, unknown>): AgentEvent =>
  ({ eventId: "adapter-" + seq, runId, seq, ts: new Date().toISOString(), ...rest }) as AgentEvent;

function fakeAdapter(run: AgentAdapter["run"]): AgentAdapter {
  return {
    id: "fake",
    kind: "api",
    initialize: async () => ({ streaming: true, permissionRequests: false, readOnly: true }),
    startSession: async () => ({ sessionId: "sess_1", adapterId: "fake" }),
    closeSession: async () => undefined,
    run,
  };
}

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

interface Harness {
  db: ReturnType<typeof openDatabase>;
  dispatcher: ReturnType<typeof createDispatcher>;
  repo: Repository;
  orchestrator: RunOrchestrator;
  events: ControlEvent[];
  started: RunRow[];
  /** 节点探针被调用了几次、探的哪个 profile（用来验证按节点去重） */
  probeCalls: string[];
  settings: SettingsStore;
  projectId: string;
}

async function makeHarness(options: {
  probe?: (params: { baseUrl: string; token: string; profileId: string }) => Promise<NodeProbeResult>;
  scripts?: Map<string, Record<string, unknown>[]>;
  /** 这些 adapter_id 的 Run 不自己结束，一直等到被 abort（测暂停 / 打断 / 结束本轮用） */
  holdProfiles?: string[];
} = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "room-discussion-ipc-"));
  dirs.push(dir);
  const db = openDatabase(join(dir, "test.db"));
  const queue = new WriteQueue();
  const repo = new Repository(db, queue);
  const settings = new SettingsStore(join(dir, "settings.json"), fakeSafeStorage);
  settings.updateReviewerNode({ baseUrl: NODE_URL, profileId: "claude-review", token: "t".repeat(40) });
  // 多节点（D-22c）：agents 都在 controller-local 上，凭据按节点存
  settings.upsertNode("controller-local", { baseUrl: NODE_URL, token: "t".repeat(40) });

  const now = new Date().toISOString();
  db.prepare("INSERT INTO nodes (id, display_name, base_url, created_at) VALUES (?, ?, ?, ?)").run(
    "controller-local",
    "主控机",
    NODE_URL,
    now,
  );
  const addAgent = db.prepare(
    "INSERT INTO agents (id, display_name, color, role_note, can_discuss, can_summarize, node_id, profile_id, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, 'controller-local', ?, ?, ?)",
  );
  addAgent.run("claude", "C酱", "#a0522d", "汇总者：找出一致、分歧和遗漏", 1, 1, "claude-review", now, now);
  addAgent.run("deepseek", "DeepSeek", "#2f5aa0", "后端视角：关注一致性", 1, 0, "deepseek-discuss", now, now);
  addAgent.run("codex", "Codex", "#1f6b55", "务实派：关注实现成本", 1, 0, "codex-discuss", now, now);

  const events: ControlEvent[] = [];
  // 每条 emit 都过一次契约校验：事件形状不对，测试立刻失败
  const record = (e: ControlEvent): void => {
    events.push(ControlEvent.parse(e));
  };
  const started: RunRow[] = [];
  const scripts = options.scripts ?? new Map<string, Record<string, unknown>[]>();
  const probeCalls: string[] = [];
  const nodeProbe =
    options.probe ??
    (async () => ({
      reachable: true,
      profiles: ["claude-review", "deepseek-discuss", "codex-discuss"],
    }));
  const probe = async (params: { baseUrl: string; token: string; profileId: string }): Promise<NodeProbeResult> => {
    probeCalls.push(params.profileId);
    return nodeProbe(params);
  };

  let service: DiscussionService | null = null;
  const orchestrator = new RunOrchestrator({
    db,
    queue,
    emit: record,
    getRun: (runId) => db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as never,
    adapterFactory: async (run) => {
      started.push(run);
      if ((options.holdProfiles ?? []).includes(run.adapter_id)) {
        return fakeAdapter(async function* (_sessionId, runId, _input, opts) {
          if (!opts.signal.aborted) {
            await new Promise<void>((resolve) => {
              opts.signal.addEventListener("abort", () => resolve(), { once: true });
            });
          }
          yield event(runId, 0, { type: "cancelled", reason: "aborted" });
        });
      }
      const script = scripts.get(run.adapter_id) ?? ANSWER;
      return fakeAdapter(async function* (_sessionId, runId) {
        let seq = 0;
        for (const part of script) yield event(runId, seq++, part);
      });
    },
    onDiscussionSettled: (settlement) => service?.settled(settlement),
  });

  service = new DiscussionService({ db, queue, repo, settings, orchestrator, emit: record, probeNode: probe });

  const dispatcher = createDispatcher({
    repo,
    settings,
    orchestrator,
    discussion: service,
    appVersion: "0.0.0-test",
    recoveredRuns: 0,
    emit: record,
  });

  const project = await dispatcher.handleCommand({ type: "project.create", name: "议题" });
  const projectId = (project as { data: { id: string } }).data.id;
  return { db, dispatcher, repo, orchestrator, events, started, probeCalls, settings, projectId };
}

function draft(
  h: Harness,
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

function failure(result: { ok: boolean }): { error: string; message: string } {
  return result.ok ? { error: "ok", message: "" } : (result as unknown as { error: string; message: string });
}

async function waitFor(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timeout waiting for " + what);
}

/** 后台 Run 还在收尾时关库会撞上 "connection is not open"，所以先等它跑完 */
async function close(h: Harness): Promise<void> {
  await waitFor(() => h.orchestrator.activeCount() === 0, "orchestrator idle");
  h.db.close();
}

interface BatchLike {
  id: string;
  items: { approvalId: string; contentHash: string }[];
}

async function approveBatchOf(h: Harness, batch: BatchLike) {
  return h.dispatcher.handleCommand({
    type: "batch.approve",
    batchId: batch.id,
    expected: batch.items.map((item) => ({ approvalId: item.approvalId, contentHash: item.contentHash })),
  });
}

async function summarizeOf(h: Harness, roundId: string, summarizer: string) {
  return h.dispatcher.handleCommand({ type: "round.summarize", roundId, summarizer });
}

/** 走完「起草 → 盖章 → 汇总 → 盖章」，拿到汇总产出的方案 v1 */
async function makePlan(h: Harness): Promise<{ planId: string; contentHash: string }> {
  const created = (await draft(h, ["deepseek"])) as unknown as { data: { round: { id: string }; batch: BatchLike } };
  const roundId = created.data.round.id;
  await approveBatchOf(h, created.data.batch);
  await waitFor(
    () => (h.db.prepare("SELECT state FROM rounds WHERE id = ?").get(roundId) as { state: string }).state === "AWAITING_SUMMARY",
    "awaiting summary",
  );
  const requested = (await summarizeOf(h, roundId, "claude")) as unknown as { data: BatchLike };
  await approveBatchOf(h, requested.data);
  await waitFor(
    () => (h.db.prepare("SELECT state FROM rounds WHERE id = ?").get(roundId) as { state: string }).state === "SUMMARIZED",
    "summarized",
  );
  const plans = (await h.dispatcher.handleQuery({ type: "plans.list", projectId: h.projectId })) as {
    data: { id: string; contentHash: string }[];
  };
  return { planId: plans.data[0]!.id, contentHash: plans.data[0]!.contentHash };
}

describe("round.draft：起草一轮", () => {
  it("两个收件人 → 一份待盖章的 initial 批次，Prompt 由 core 拼好并带不可信边界", async () => {
    const h = await makeHarness();
    const result = await draft(h, ["deepseek", "codex"]);

    assert.equal(result.ok, true, JSON.stringify(result));
    const data = (result as unknown as { data: { round: any; batch: any } }).data;
    assert.equal(data.round.state, "DRAFT");
    assert.equal(data.round.index, 1);
    assert.deepEqual(data.round.recipients, ["deepseek", "codex"]);
    assert.equal(data.batch.kind, "initial");
    assert.equal(data.batch.state, "READY_FOR_REVIEW");
    assert.equal(data.batch.items.length, 2);

    const snapshots = h.db
      .prepare("SELECT content, content_hash, reviewer_agent, nonce FROM prompt_snapshots ORDER BY reviewer_agent")
      .all() as { content: string; content_hash: string; reviewer_agent: string; nonce: string }[];
    assert.deepEqual(snapshots.map((s) => s.reviewer_agent), ["codex", "deepseek"]);
    for (const snapshot of snapshots) {
      assert.equal(snapshot.content_hash, sha(snapshot.content));
      assert.match(snapshot.content, /# 不可信资料/);
      assert.match(snapshot.content, /各自说说怎么做/);
    }
    assert.match(snapshots[0]!.content, /Codex/);
    assert.match(snapshots[1]!.content, /DeepSeek/);
    // 两个收件人在同一个节点上：只探一次
    assert.equal(h.probeCalls.length, 1, "同一个节点只探一次");

    // 事件：轮、批次、每个 Turn、每个 Approval
    assert.ok(h.events.some((e) => e.type === "round.updated"));
    assert.equal(h.events.filter((e) => e.type === "turn.updated").length, 2);
    assert.equal(h.events.filter((e) => e.type === "approval.updated").length, 2);
    assert.ok(h.events.some((e) => e.type === "batch.updated"));
    await close(h);
  });

  it("已经有一轮没结束时返回 invalid_state", async () => {
    const h = await makeHarness();
    assert.equal((await draft(h, ["deepseek"])).ok, true);

    const second = await draft(h, ["codex"]);
    assert.equal(second.ok, false);
    assert.equal(failure(second).error, "invalid_state");
    await close(h);
  });
});

describe("round.draft：收件人不可用", () => {
  it("没配置的参与者", async () => {
    const h = await makeHarness();
    const result = await draft(h, ["ghost"]);
    assert.equal(failure(result).error, "agent_unavailable");
    assert.match(failure(result).message, /ghost/);
    await close(h);
  });

  it("被手动暂停的参与者", async () => {
    const h = await makeHarness();
    h.db.prepare("UPDATE agents SET paused_by_user = 1 WHERE id = 'codex'").run();
    const result = await draft(h, ["deepseek", "codex"]);
    assert.equal(failure(result).error, "agent_unavailable");
    assert.match(failure(result).message, /Codex/);
    await close(h);
  });

  it("节点离线", async () => {
    const h = await makeHarness({
      probe: async () => ({ reachable: false, profiles: [], message: "connection refused" }),
    });
    const result = await draft(h, ["deepseek"]);
    assert.equal(failure(result).error, "agent_unavailable");
    assert.match(failure(result).message, /离线/);
    await close(h);
  });

  it("节点上没有这个 profile", async () => {
    const h = await makeHarness({ probe: async () => ({ reachable: true, profiles: ["claude-review"] }) });
    const result = await draft(h, ["deepseek"]);
    assert.equal(failure(result).error, "agent_unavailable");
    assert.match(failure(result).message, /profile/);
    await close(h);
  });

  it("上一轮额度缺席过的人，下一轮不再自动发给他", async () => {
    const h = await makeHarness({
      scripts: new Map([["remote:deepseek-discuss", [{ type: "error", reason: "quota_exhausted" }]]]),
    });
    const created = await draft(h, ["deepseek"]);
    const data = (created as unknown as { data: { batch: { items: { approvalId: string; contentHash: string }[] } } }).data;
    const approved = await h.dispatcher.handleCommand({
      type: "batch.approve",
      batchId: (created as unknown as { data: { batch: { id: string } } }).data.batch.id,
      expected: data.batch.items.map((item) => ({ approvalId: item.approvalId, contentHash: item.contentHash })),
    });
    assert.equal(approved.ok, true);

    await waitFor(
      () => (h.db.prepare("SELECT outcome FROM turns").get() as { outcome: string }).outcome === "absent_quota",
      "quota turn",
    );
    // 这一轮结束（模拟汇总过 / 作废），下一轮起草时按「额度缺席」挡住
    h.db.prepare("UPDATE rounds SET state = 'SUMMARIZED'").run();

    // 额度是按账号算的：换一个议题也照样挡住
    const other = await h.dispatcher.handleCommand({ type: "project.create", name: "另一个议题" });
    const otherProjectId = (other as { data: { id: string } }).data.id;
    const next = await draft(h, ["deepseek"], { projectId: otherProjectId });
    assert.equal(failure(next).error, "agent_unavailable");
    assert.match(failure(next).message, /额度用尽/);
    await close(h);
  });

  it("汇总时额度用尽也算缺席（不因为 is_summary 放过）", async () => {
    const h = await makeHarness();
    const now = new Date().toISOString();
    const roundId = "rnd_" + ulid();
    const snapshotId = "snap_" + ulid();
    const approvalId = "apr_" + ulid();
    const batchId = "bat_" + ulid();
    h.db
      .prepare(
        "INSERT INTO prompt_snapshots (id, project_id, content, content_hash, nonce, contribution_ids, task_instruction, " +
          "reviewer_agent, adapter_version, token_estimate, created_at) " +
          "VALUES (?, ?, '汇总 Prompt', ?, '0123456789abcdef', '[]', '旧任务', 'claude', 'discussion-v2', 1, ?)",
      )
      .run(snapshotId, h.projectId, sha("汇总 Prompt"), now);
    h.db
      .prepare("INSERT INTO approvals (id, project_id, snapshot_id, state, created_at) VALUES (?, ?, ?, 'APPROVED', ?)")
      .run(approvalId, h.projectId, snapshotId, now);
    h.db
      .prepare(
        "INSERT INTO rounds (id, project_id, round_index, state, task, task_source, recipients, history_mode, created_at) " +
          "VALUES (?, ?, 1, 'SUMMARIZED', '上一轮', 'human', '[\"deepseek\"]', 'recent_with_summaries', ?)",
      )
      .run(roundId, h.projectId, now);
    h.db
      .prepare(
        "INSERT INTO batches (id, project_id, round_id, kind, state, created_at) VALUES (?, ?, ?, 'summary', 'APPROVED', ?)",
      )
      .run(batchId, h.projectId, roundId, now);
    h.db
      .prepare(
        "INSERT INTO turns (id, round_id, batch_id, agent, is_summary, approval_id, run_id, outcome, created_at, finished_at) " +
          "VALUES (?, ?, ?, 'claude', 1, ?, NULL, 'absent_quota', ?, ?)",
      )
      .run("turn_" + ulid(), roundId, batchId, approvalId, now, now);

    const result = await draft(h, ["claude"]);
    assert.equal(failure(result).error, "agent_unavailable");
    assert.match(failure(result).message, /额度用尽/);

    const statuses = (await h.dispatcher.handleQuery({ type: "agents.status" })) as any;
    const claude = statuses.data.find((status: any) => status.agent === "claude");
    assert.equal(claude.availability, "absent_quota");
    await close(h);
  });

  it("6 小时前额度缺席的，现在可以起草（超过 5 小时就不算缺席）", async () => {
    const h = await makeHarness();
    const roundId = "rnd_" + ulid();
    const snapshotId = "snap_" + ulid();
    const approvalId = "apr_" + ulid();
    const batchId = "bat_" + ulid();
    const old = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();

    h.db
      .prepare(
        "INSERT INTO prompt_snapshots (id, project_id, content, content_hash, nonce, contribution_ids, task_instruction, " +
          "reviewer_agent, adapter_version, token_estimate, created_at) " +
          "VALUES (?, ?, '旧 Prompt', ?, '0123456789abcdef', '[]', '旧任务', 'deepseek', 'discussion-v2', 1, ?)",
      )
      .run(snapshotId, h.projectId, sha("旧 Prompt"), old);
    h.db
      .prepare("INSERT INTO approvals (id, project_id, snapshot_id, state, created_at) VALUES (?, ?, ?, 'APPROVED', ?)")
      .run(approvalId, h.projectId, snapshotId, old);
    h.db
      .prepare(
        "INSERT INTO rounds (id, project_id, round_index, state, task, task_source, recipients, history_mode, created_at) " +
          "VALUES (?, ?, 1, 'SUMMARIZED', '上一轮', 'human', '[\"deepseek\"]', 'recent_with_summaries', ?)",
      )
      .run(roundId, h.projectId, old);
    h.db
      .prepare("INSERT INTO batches (id, project_id, round_id, kind, state, created_at) VALUES (?, ?, ?, 'initial', 'APPROVED', ?)")
      .run(batchId, h.projectId, roundId, old);
    h.db
      .prepare(
        "INSERT INTO turns (id, round_id, batch_id, agent, is_summary, approval_id, run_id, outcome, created_at, finished_at) " +
          "VALUES (?, ?, ?, 'deepseek', 0, ?, NULL, 'absent_quota', ?, ?)",
      )
      .run("turn_" + ulid(), roundId, batchId, approvalId, old, old);

    const result = await draft(h, ["deepseek"]);
    assert.equal(result.ok, true, JSON.stringify(result));
    await close(h);
  });
});

describe("batch.approve：一次盖章 = N 个 Run", () => {
  it("整批批准、起 Run、收尾后推 message.created / turn.updated / round.updated", async () => {
    const h = await makeHarness();
    const created = (await draft(h, ["deepseek", "codex"])) as unknown as {
      data: { round: { id: string }; batch: { id: string; items: { approvalId: string; contentHash: string }[] } };
    };

    const result = await h.dispatcher.handleCommand({
      type: "batch.approve",
      batchId: created.data.batch.id,
      expected: created.data.batch.items.map((item) => ({ approvalId: item.approvalId, contentHash: item.contentHash })),
    });

    assert.equal(result.ok, true, JSON.stringify(result));
    const approved = (result as unknown as { data: { batch: any; turns: any[] } }).data;
    assert.equal(approved.batch.state, "APPROVED");
    assert.equal(approved.turns.length, 2);
    assert.ok(approved.turns.every((turn) => turn.outcome === "running" && turn.runId !== null));

    const round = (h.db.prepare("SELECT state FROM rounds WHERE id = ?").get(created.data.round.id) as { state: string }).state;
    assert.equal(round, "RUNNING");
    await waitFor(() => h.started.length === 2, "two runs started");
    assert.equal(h.started.length, 2, "每个 Run 都交给 Orchestrator");

    await waitFor(
      () =>
        (h.db.prepare("SELECT count(*) AS n FROM turns WHERE outcome = 'answered'").get() as { n: number }).n === 2,
      "two answered turns",
    );

    assert.equal(
      (h.db.prepare("SELECT state FROM rounds WHERE id = ?").get(created.data.round.id) as { state: string }).state,
      "AWAITING_SUMMARY",
    );
    const messages = h.db.prepare("SELECT kind, content FROM messages WHERE kind = 'agent_reply'").all() as {
      kind: string;
      content: string;
    }[];
    assert.deepEqual(messages.map((m) => m.content), ["我的回答", "我的回答"]);
    assert.equal(h.events.filter((e) => e.type === "message.created").length, 2);
    assert.ok(h.events.some((e) => e.type === "round.updated" && (e as any).round.state === "AWAITING_SUMMARY"));
    await close(h);
  });

  it("指纹对不上就整批不发（stale_snapshot），一个 Run 都不起", async () => {
    const h = await makeHarness();
    const created = (await draft(h, ["deepseek"])) as unknown as {
      data: { batch: { id: string; items: { approvalId: string; contentHash: string }[] } };
    };

    const result = await h.dispatcher.handleCommand({
      type: "batch.approve",
      batchId: created.data.batch.id,
      expected: [{ approvalId: created.data.batch.items[0]!.approvalId, contentHash: "b".repeat(64) }],
    });

    assert.equal(failure(result).error, "stale_snapshot");
    assert.equal(h.started.length, 0);
    assert.equal((h.db.prepare("SELECT count(*) AS n FROM runs").get() as { n: number }).n, 0);
    await close(h);
  });

  it("重复盖章返回 already_decided", async () => {
    const h = await makeHarness();
    const created = (await draft(h, ["deepseek"])) as unknown as {
      data: { batch: { id: string; items: { approvalId: string; contentHash: string }[] } };
    };
    const expected = created.data.batch.items.map((item) => ({ approvalId: item.approvalId, contentHash: item.contentHash }));
    assert.equal((await h.dispatcher.handleCommand({ type: "batch.approve", batchId: created.data.batch.id, expected })).ok, true);

    const again = await h.dispatcher.handleCommand({ type: "batch.approve", batchId: created.data.batch.id, expected });
    assert.equal(failure(again).error, "already_decided");
    await close(h);
  });
});

describe("round.summarize：汇总也要盖章", () => {
  it("先挡掉不能汇总的人；盖章后写 summary 消息与 RoundSummary，轮变 SUMMARIZED", async () => {
    const h = await makeHarness({
      scripts: new Map([["remote:claude-review", [{ type: "message_complete", text: SUMMARY_JSON }, { type: "completed" }]]]),
    });
    const created = (await draft(h, ["deepseek"])) as unknown as {
      data: { round: { id: string }; batch: { id: string; items: { approvalId: string; contentHash: string }[] } };
    };
    const roundId = created.data.round.id;
    await h.dispatcher.handleCommand({
      type: "batch.approve",
      batchId: created.data.batch.id,
      expected: created.data.batch.items.map((item) => ({ approvalId: item.approvalId, contentHash: item.contentHash })),
    });
    await waitFor(
      () => (h.db.prepare("SELECT state FROM rounds WHERE id = ?").get(roundId) as { state: string }).state === "AWAITING_SUMMARY",
      "awaiting summary",
    );

    // 没有开启「可以做汇总」的人
    const unavailable = await h.dispatcher.handleCommand({ type: "round.summarize", roundId, summarizer: "deepseek" });
    assert.equal(failure(unavailable).error, "agent_unavailable");

    const requested = await h.dispatcher.handleCommand({ type: "round.summarize", roundId, summarizer: "claude" });
    assert.equal(requested.ok, true, JSON.stringify(requested));
    const batch = (requested as unknown as { data: any }).data;
    assert.equal(batch.kind, "summary");
    assert.equal(batch.state, "READY_FOR_REVIEW");
    assert.equal(batch.items.length, 1);
    assert.equal(
      (h.db.prepare("SELECT is_summary FROM turns WHERE batch_id = ?").get(batch.id) as { is_summary: number }).is_summary,
      1,
    );

    const approved = await h.dispatcher.handleCommand({
      type: "batch.approve",
      batchId: batch.id,
      expected: batch.items.map((item: any) => ({ approvalId: item.approvalId, contentHash: item.contentHash })),
    });
    assert.equal(approved.ok, true, JSON.stringify(approved));

    await waitFor(
      () => (h.db.prepare("SELECT state FROM rounds WHERE id = ?").get(roundId) as { state: string }).state === "SUMMARIZED",
      "summarized",
    );
    const summaryMessage = h.db.prepare("SELECT kind, content FROM messages WHERE kind = 'summary'").get() as {
      kind: string;
      content: string;
    };
    // 全文照存（JSON 也是原文），结构化部分另存
    assert.equal(summaryMessage.content, SUMMARY_JSON);
    const summary = h.db.prepare("SELECT summarizer, answered, expected, report, plan_version_id FROM round_summaries").get() as {
      summarizer: string;
      answered: number;
      expected: number;
      report: string;
      plan_version_id: string;
    };
    assert.equal(summary.summarizer, "claude");
    assert.equal(summary.answered, 1);
    assert.equal(summary.expected, 1);
    assert.deepEqual(JSON.parse(summary.report).risks, ["风险一"]);
    assert.ok(h.events.some((e) => e.type === "summary.created"));

    // 汇总顺带产生的方案草稿 + plan.updated
    const plan = h.db.prepare("SELECT version, state, content, based_on_round_id FROM plan_versions WHERE id = ?").get(
      summary.plan_version_id,
    ) as { version: number; state: string; content: string; based_on_round_id: string };
    assert.deepEqual(plan, {
      version: 1,
      state: "DRAFT",
      content: "# 方案 v1\n第一版",
      based_on_round_id: roundId,
    });
    assert.ok(h.events.some((e) => e.type === "plan.updated"));

    // 下一轮起草时，第 1 轮的记录会进 Prompt（最近两轮发全文）
    const next = await draft(h, ["codex"]);
    assert.equal(next.ok, true, JSON.stringify(next));
    const prompt = h.db
      .prepare("SELECT content FROM prompt_snapshots ORDER BY created_at DESC LIMIT 1")
      .get() as { content: string };
    assert.match(prompt.content, /第 1 轮/);
    assert.match(prompt.content, /我的回答/);
    await close(h);
  });

  it("轮不在待汇总 / 没有任何回答时返回 invalid_state", async () => {
    const h = await makeHarness();
    const created = (await draft(h, ["deepseek"])) as unknown as { data: { round: { id: string } } };
    const roundId = created.data.round.id;

    const draftState = await h.dispatcher.handleCommand({ type: "round.summarize", roundId, summarizer: "claude" });
    assert.equal(failure(draftState).error, "invalid_state");

    h.db.prepare("UPDATE rounds SET state = 'AWAITING_SUMMARY' WHERE id = ?").run(roundId);
    const noAnswers = await h.dispatcher.handleCommand({ type: "round.summarize", roundId, summarizer: "claude" });
    assert.equal(failure(noAnswers).error, "invalid_state");
    assert.match(failure(noAnswers).message, /没有任何回答/);
    await close(h);
  });
});

describe("讨论室读取（rounds.list / rounds.get / batches.get / plans.list / agents.status）", () => {
  async function approveBatchOf(h: Harness, batch: { id: string; items: { approvalId: string; contentHash: string }[] }) {
    return h.dispatcher.handleCommand({
      type: "batch.approve",
      batchId: batch.id,
      expected: batch.items.map((item) => ({ approvalId: item.approvalId, contentHash: item.contentHash })),
    });
  }

  it("起草之后：rounds.list / rounds.get / batches.get 都能读出轮、批次、Turn 和逐字 Snapshot", async () => {
    const h = await makeHarness();
    const created = (await draft(h, ["deepseek", "codex"])) as unknown as {
      data: { round: { id: string }; batch: { id: string; items: { approvalId: string; contentHash: string }[] } };
    };
    const { round, batch } = created.data;

    const listed = (await h.dispatcher.handleQuery({ type: "rounds.list", projectId: h.projectId })) as any;
    assert.equal(listed.ok, true, JSON.stringify(listed));
    assert.equal(listed.data.length, 1);
    assert.equal(listed.data[0].id, round.id);
    assert.equal(listed.data[0].state, "DRAFT");

    const got = (await h.dispatcher.handleQuery({ type: "rounds.get", roundId: round.id })) as any;
    assert.equal(got.ok, true, JSON.stringify(got));
    assert.equal(got.data.round.id, round.id);
    assert.equal(got.data.batches.length, 1);
    assert.equal(got.data.batches[0].id, batch.id);
    assert.equal(got.data.turns.length, 2);
    assert.equal(got.data.summary, null);

    const batchView = (await h.dispatcher.handleQuery({ type: "batches.get", batchId: batch.id })) as any;
    assert.equal(batchView.ok, true, JSON.stringify(batchView));
    assert.equal(batchView.data.batch.id, batch.id);
    assert.equal(batchView.data.snapshots.length, 2);
    const hashes = new Set(batchView.data.batch.items.map((item: any) => item.contentHash));
    for (const snapshot of batchView.data.snapshots) {
      assert.equal(snapshot.contentHash, sha(snapshot.content), "逐字查看的内容要能对上指纹");
      assert.equal(hashes.has(snapshot.contentHash), true);
    }
    await close(h);
  });

  it("汇总之后：rounds.get.summary 与 plans.list 能读到 RoundSummary 和方案 v1", async () => {
    const h = await makeHarness({
      scripts: new Map([["remote:claude-review", [{ type: "message_complete", text: SUMMARY_JSON }, { type: "completed" }]]]),
    });
    const created = (await draft(h, ["deepseek"])) as unknown as {
      data: { round: { id: string }; batch: { id: string; items: { approvalId: string; contentHash: string }[] } };
    };
    const roundId = created.data.round.id;
    await approveBatchOf(h, created.data.batch);
    await waitFor(
      () => (h.db.prepare("SELECT state FROM rounds WHERE id = ?").get(roundId) as { state: string }).state === "AWAITING_SUMMARY",
      "awaiting summary",
    );

    const requested = (await h.dispatcher.handleCommand({ type: "round.summarize", roundId, summarizer: "claude" })) as any;
    assert.equal(requested.ok, true, JSON.stringify(requested));
    await approveBatchOf(h, requested.data);
    await waitFor(
      () => (h.db.prepare("SELECT state FROM rounds WHERE id = ?").get(roundId) as { state: string }).state === "SUMMARIZED",
      "summarized",
    );

    const plans = (await h.dispatcher.handleQuery({ type: "plans.list", projectId: h.projectId })) as any;
    assert.equal(plans.ok, true, JSON.stringify(plans));
    assert.equal(plans.data.length, 1);
    assert.equal(plans.data[0].version, 1);
    assert.equal(plans.data[0].state, "DRAFT");
    assert.equal(plans.data[0].content, "# 方案 v1\n第一版");

    const got = (await h.dispatcher.handleQuery({ type: "rounds.get", roundId })) as any;
    assert.equal(got.ok, true, JSON.stringify(got));
    assert.ok(got.data.summary, "汇总之后 rounds.get 里要有 summary");
    assert.deepEqual(got.data.summary.report.risks, ["风险一"]);
    await close(h);
  });

  it("agents.status：可用 / 未配置 / 暂停", async () => {
    const h = await makeHarness();
    const statuses = (await h.dispatcher.handleQuery({ type: "agents.status" })) as any;
    assert.equal(statuses.ok, true, JSON.stringify(statuses));
    assert.deepEqual(
      statuses.data.map((s: any) => [s.agent, s.availability]),
      [
        ["claude", "available"],
        ["codex", "available"],
        ["deepseek", "available"],
      ],
    );
    // 1A 读不到的字段一律 null，不猜
    assert.equal(statuses.data[0].billing, "unknown");
    assert.equal(statuses.data[0].fiveHour, null);
    assert.equal(statuses.data[0].model, null);

    h.db.prepare("UPDATE agents SET paused_by_user = 1 WHERE id = 'codex'").run();
    h.db.prepare("UPDATE agents SET node_id = NULL WHERE id = 'claude'").run();
    const changed = (await h.dispatcher.handleQuery({ type: "agents.status" })) as any;
    const byAgent = Object.fromEntries(changed.data.map((s: any) => [s.agent, s.availability]));
    assert.equal(byAgent["claude"], "unconfigured");
    assert.equal(byAgent["codex"], "paused_by_user");
    await close(h);
  });

  it("agents.status：节点离线", async () => {
    const h = await makeHarness({ probe: async () => ({ reachable: false, profiles: [], message: "down" }) });
    const statuses = (await h.dispatcher.handleQuery({ type: "agents.status" })) as any;
    assert.equal(statuses.ok, true, JSON.stringify(statuses));
    assert.deepEqual(
      statuses.data.map((s: any) => s.availability),
      ["offline", "offline", "offline"],
    );
    await close(h);
  });

  it("agents.status：5 小时内额度缺席", async () => {
    const h = await makeHarness();
    const now = new Date().toISOString();
    const roundId = "rnd_" + ulid();
    const snapshotId = "snap_" + ulid();
    const approvalId = "apr_" + ulid();
    const batchId = "bat_" + ulid();
    h.db
      .prepare(
        "INSERT INTO prompt_snapshots (id, project_id, content, content_hash, nonce, contribution_ids, task_instruction, " +
          "reviewer_agent, adapter_version, token_estimate, created_at) " +
          "VALUES (?, ?, '旧 Prompt', ?, '0123456789abcdef', '[]', '旧任务', 'deepseek', 'discussion-v2', 1, ?)",
      )
      .run(snapshotId, h.projectId, sha("旧 Prompt"), now);
    h.db
      .prepare("INSERT INTO approvals (id, project_id, snapshot_id, state, created_at) VALUES (?, ?, ?, 'APPROVED', ?)")
      .run(approvalId, h.projectId, snapshotId, now);
    h.db
      .prepare(
        "INSERT INTO rounds (id, project_id, round_index, state, task, task_source, recipients, history_mode, created_at) " +
          "VALUES (?, ?, 1, 'SUMMARIZED', '上一轮', 'human', '[\"deepseek\"]', 'recent_with_summaries', ?)",
      )
      .run(roundId, h.projectId, now);
    h.db
      .prepare("INSERT INTO batches (id, project_id, round_id, kind, state, created_at) VALUES (?, ?, ?, 'initial', 'APPROVED', ?)")
      .run(batchId, h.projectId, roundId, now);
    h.db
      .prepare(
        "INSERT INTO turns (id, round_id, batch_id, agent, is_summary, approval_id, run_id, outcome, created_at, finished_at) " +
          "VALUES (?, ?, ?, 'deepseek', 0, ?, NULL, 'absent_quota', ?, ?)",
      )
      .run("turn_" + ulid(), roundId, batchId, approvalId, now, now);

    const statuses = (await h.dispatcher.handleQuery({ type: "agents.status" })) as any;
    const byAgent = Object.fromEntries(statuses.data.map((s: any) => [s.agent, s.availability]));
    assert.equal(byAgent["deepseek"], "absent_quota");
    await close(h);
  });
});

describe("agent.update：把参与者配到各自节点", () => {
  it("改已有 Agent 的节点 / profile，并推 agent.status", async () => {
    const h = await makeHarness();
    const now = new Date().toISOString();
    h.db.prepare("INSERT INTO nodes (id, display_name, base_url, created_at) VALUES (?, ?, ?, ?)").run(
      "user-pc",
      "你的电脑",
      "http://192.168.190.10:7420",
      now,
    );
    h.settings.upsertNode("user-pc", { baseUrl: "http://192.168.190.10:7420", token: "t".repeat(40) });

    const updated = await h.dispatcher.handleCommand({
      type: "agent.update",
      id: "claude",
      nodeId: "user-pc",
      profileId: "claude-review",
    });
    assert.equal(updated.ok, true, JSON.stringify(updated));
    const profile = (updated as unknown as { data: { nodeId: string; profileId: string; canSummarize: boolean } }).data;
    assert.equal(profile.nodeId, "user-pc");
    assert.equal(profile.profileId, "claude-review");
    assert.equal(profile.canSummarize, true, "只改传进来的字段");

    const listed = (await h.dispatcher.handleQuery({ type: "agents.list" })) as any;
    const claude = listed.data.find((agent: any) => agent.id === "claude");
    assert.equal(claude.nodeId, "user-pc");
    assert.ok(
      h.events.some((e) => e.type === "agent.status" && (e as any).status.agent === "claude"),
      "agent.update 之后要推 agent.status",
    );
    await close(h);
  });

  it("新建 Agent（契约没有 create，第一条靠它建）", async () => {
    const h = await makeHarness();
    const created = await h.dispatcher.handleCommand({
      type: "agent.update",
      id: "gemini",
      displayName: "Gemini",
      color: "#123456",
      canDiscuss: true,
      nodeId: "controller-local",
      profileId: "deepseek-discuss",
    });
    assert.equal(created.ok, true, JSON.stringify(created));
    const profile = (created as unknown as { data: { id: string; displayName: string; pausedByUser: boolean } }).data;
    assert.equal(profile.id, "gemini");
    assert.equal(profile.displayName, "Gemini");
    assert.equal(profile.pausedByUser, false);

    const listed = (await h.dispatcher.handleQuery({ type: "agents.list" })) as any;
    assert.equal(listed.data.length, 4);
    await close(h);
  });

  it("新建时缺 displayName / color、替补不存在、节点不存在、替补是自己，都按 validation_failed 拒绝", async () => {
    const h = await makeHarness();
    const attempts = [
      { type: "agent.update", id: "gemini", displayName: "Gemini" },
      { type: "agent.update", id: "gemini", displayName: "Gemini", color: "#123456", substitute: "nobody" },
      { type: "agent.update", id: "gemini", displayName: "Gemini", color: "#123456", nodeId: "ghost-node" },
      { type: "agent.update", id: "gemini", displayName: "Gemini", color: "#123456", substitute: "gemini" },
    ];
    for (const attempt of attempts) {
      const result = await h.dispatcher.handleCommand(attempt);
      assert.equal(failure(result).error, "validation_failed", JSON.stringify(result));
    }
    assert.equal((h.db.prepare("SELECT count(*) AS n FROM agents").get() as { n: number }).n, 3);
    await close(h);
  });
});

describe("batch.reject：只作废这一批", () => {
  it("批次 / Approval / pending Turn 一起作废，轮留在 DRAFT", async () => {
    const h = await makeHarness();
    const created = (await draft(h, ["deepseek", "codex"])) as unknown as {
      data: { round: { id: string }; batch: BatchLike };
    };
    const rejected = await h.dispatcher.handleCommand({ type: "batch.reject", batchId: created.data.batch.id, reason: "再想想" });
    assert.equal(rejected.ok, true, JSON.stringify(rejected));
    const batch = (rejected as unknown as { data: { state: string } }).data;
    assert.equal(batch.state, "REJECTED");

    assert.equal((h.db.prepare("SELECT state FROM rounds WHERE id = ?").get(created.data.round.id) as { state: string }).state, "DRAFT");
    assert.equal((h.db.prepare("SELECT count(*) AS n FROM approvals WHERE state = 'REJECTED'").get() as { n: number }).n, 2);
    assert.equal((h.db.prepare("SELECT count(*) AS n FROM turns WHERE outcome = 'rejected'").get() as { n: number }).n, 2);
    assert.ok(h.events.some((e) => e.type === "batch.updated"));
    assert.ok(h.events.some((e) => e.type === "turn.updated" && (e as any).turn.outcome === "rejected"));
    await close(h);
  });

  it("重复拒绝返回 already_decided；不存在的批次返回 not_found", async () => {
    const h = await makeHarness();
    const created = (await draft(h, ["deepseek"])) as unknown as { data: { batch: BatchLike } };
    assert.equal((await h.dispatcher.handleCommand({ type: "batch.reject", batchId: created.data.batch.id })).ok, true);

    const again = await h.dispatcher.handleCommand({ type: "batch.reject", batchId: created.data.batch.id });
    assert.equal(failure(again).error, "already_decided");

    const missing = await h.dispatcher.handleCommand({ type: "batch.reject", batchId: "bat_" + ulid() });
    assert.equal(failure(missing).error, "not_found");
    await close(h);
  });
});

describe("plan.confirm / plan.finalize", () => {
  it("草稿 → 当前 → 定稿，两步都推 plan.updated", async () => {
    const h = await makeHarness({
      scripts: new Map([["remote:claude-review", [{ type: "message_complete", text: SUMMARY_JSON }, { type: "completed" }]]]),
    });
    const { planId, contentHash } = await makePlan(h);

    const confirmed = await h.dispatcher.handleCommand({ type: "plan.confirm", planVersionId: planId });
    assert.equal(confirmed.ok, true, JSON.stringify(confirmed));
    assert.equal((confirmed as unknown as { data: { state: string } }).data.state, "CURRENT");
    assert.ok(h.events.some((e) => e.type === "plan.updated" && (e as any).plan.state === "CURRENT"));

    // 再看一次，定稿；指纹必须和确认页看到的一致
    const plans = (await h.dispatcher.handleQuery({ type: "plans.list", projectId: h.projectId })) as any;
    assert.equal(plans.data[0].contentHash, contentHash);

    const wrong = await h.dispatcher.handleCommand({
      type: "plan.finalize",
      planVersionId: planId,
      expectedContentHash: "b".repeat(64),
    });
    assert.equal(failure(wrong).error, "stale_snapshot");

    const finalized = await h.dispatcher.handleCommand({
      type: "plan.finalize",
      planVersionId: planId,
      expectedContentHash: contentHash,
    });
    assert.equal(finalized.ok, true, JSON.stringify(finalized));
    assert.equal((finalized as unknown as { data: { state: string } }).data.state, "FINAL");
    assert.ok(h.events.some((e) => e.type === "plan.updated" && (e as any).plan.state === "FINAL"));
    await close(h);
  });

  it("不是草稿不能确认，不是当前不能定稿", async () => {
    const h = await makeHarness({
      scripts: new Map([["remote:claude-review", [{ type: "message_complete", text: SUMMARY_JSON }, { type: "completed" }]]]),
    });
    const { planId, contentHash } = await makePlan(h);

    // 还没确认就定稿
    const early = await h.dispatcher.handleCommand({ type: "plan.finalize", planVersionId: planId, expectedContentHash: contentHash });
    assert.equal(failure(early).error, "invalid_state");

    assert.equal((await h.dispatcher.handleCommand({ type: "plan.confirm", planVersionId: planId })).ok, true);
    const again = await h.dispatcher.handleCommand({ type: "plan.confirm", planVersionId: planId });
    assert.equal(failure(again).error, "invalid_state");
    await close(h);
  });
});



describe("round.pause / round.resume：先落库再 abort", () => {
  it("暂停 → 恢复复用同一 Snapshot（内容与指纹不变）", async () => {
    const h = await makeHarness({ holdProfiles: ["remote:deepseek-discuss"] });
    const created = (await draft(h, ["deepseek"])) as unknown as {
      data: { round: { id: string }; batch: BatchLike };
    };
    const roundId = created.data.round.id;
    await approveBatchOf(h, created.data.batch);
    await waitFor(
      () => (h.db.prepare("SELECT outcome FROM turns").get() as { outcome: string }).outcome === "running",
      "turn running",
    );

    const paused = (await h.dispatcher.handleCommand({ type: "round.pause", roundId })) as any;
    assert.equal(paused.ok, true, JSON.stringify(paused));
    assert.equal(paused.data.state, "PAUSED");
    assert.equal(
      (h.db.prepare("SELECT state FROM runs").get() as { state: string }).state,
      "CANCELLED",
      "先落库：Run 已经是 CANCELLED",
    );
    assert.equal((h.db.prepare("SELECT outcome FROM turns").get() as { outcome: string }).outcome, "paused");

    const originalSnapshot = (h.db.prepare("SELECT snapshot_id FROM batch_items ORDER BY recipient LIMIT 1").get() as {
      snapshot_id: string;
    }).snapshot_id;
    const resumed = (await h.dispatcher.handleCommand({ type: "round.resume", roundId })) as any;
    assert.equal(resumed.ok, true, JSON.stringify(resumed));
    assert.equal(resumed.data.round.state, "PAUSED", "盖章前轮还是暂停中");
    assert.equal(resumed.data.batch.kind, "resume");
    assert.equal(resumed.data.batch.items[0].snapshotId, originalSnapshot, "复用原来的 Snapshot");
    assert.equal(
      (h.db.prepare("SELECT state FROM batches WHERE id = ?").get(resumed.data.batch.id) as { state: string }).state,
      "READY_FOR_REVIEW",
    );

    await approveBatchOf(h, resumed.data.batch);
    assert.equal(
      (h.db.prepare("SELECT state FROM rounds WHERE id = ?").get(roundId) as { state: string }).state,
      "RUNNING",
    );
    h.orchestrator.cancelAll();
    await close(h);
  });

  it("结束本轮把没答完的标 round_ended；再结束返回 invalid_state", async () => {
    const h = await makeHarness({ holdProfiles: ["remote:deepseek-discuss"] });
    const created = (await draft(h, ["deepseek"])) as unknown as { data: { round: { id: string }; batch: BatchLike } };
    const roundId = created.data.round.id;
    await approveBatchOf(h, created.data.batch);
    await waitFor(
      () => (h.db.prepare("SELECT outcome FROM turns").get() as { outcome: string }).outcome === "running",
      "turn running",
    );

    const ended = (await h.dispatcher.handleCommand({ type: "round.end", roundId })) as any;
    assert.equal(ended.ok, true, JSON.stringify(ended));
    assert.equal(ended.data.state, "AWAITING_SUMMARY");
    assert.equal((h.db.prepare("SELECT outcome FROM turns").get() as { outcome: string }).outcome, "round_ended");
    assert.equal((h.db.prepare("SELECT state FROM runs").get() as { state: string }).state, "CANCELLED");

    const again = await h.dispatcher.handleCommand({ type: "round.end", roundId });
    assert.equal(failure(again).error, "invalid_state");
    h.orchestrator.cancelAll();
    await close(h);
  });
});

describe("round.supplement / round.retry / round.void", () => {
  it("restart_now：打断正在答的人，旧 Turn interrupted、新批次 supplement", async () => {
    const h = await makeHarness({ holdProfiles: ["remote:deepseek-discuss"] });
    const created = (await draft(h, ["deepseek"])) as unknown as { data: { round: { id: string }; batch: BatchLike } };
    const roundId = created.data.round.id;
    await approveBatchOf(h, created.data.batch);
    await waitFor(
      () => (h.db.prepare("SELECT outcome FROM turns").get() as { outcome: string }).outcome === "running",
      "turn running",
    );

    const result = (await h.dispatcher.handleCommand({
      type: "round.supplement",
      roundId,
      content: "再补一句：先看失败路径",
      mode: "restart_now",
      targets: ["deepseek"],
    })) as any;
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.data.note.kind, "human_note");
    assert.equal(result.data.note.roundId, roundId);
    assert.equal(result.data.batch.kind, "supplement");

    const turns = h.db.prepare("SELECT id, outcome, superseded_by FROM turns ORDER BY rowid").all() as {
      id: string;
      outcome: string;
      superseded_by: string | null;
    }[];
    assert.equal(turns[0]!.outcome, "interrupted");
    assert.ok(turns[0]!.superseded_by, "旧 Turn 接到新 Turn");
    assert.equal(turns[1]!.outcome, "pending");

    const prompt = h.db
      .prepare("SELECT content FROM prompt_snapshots ORDER BY created_at DESC LIMIT 1")
      .get() as { content: string };
    assert.match(prompt.content, /再补一句：先看失败路径/);
    h.orchestrator.cancelAll();
    await close(h);
  });

  it("only：只发给一个人，标 differsFromOthers", async () => {
    const h = await makeHarness();
    const created = (await draft(h, ["deepseek"])) as unknown as { data: { round: { id: string }; batch: BatchLike } };
    const roundId = created.data.round.id;
    await approveBatchOf(h, created.data.batch);
    await waitFor(
      () => (h.db.prepare("SELECT state FROM rounds WHERE id = ?").get(roundId) as { state: string }).state === "AWAITING_SUMMARY",
      "awaiting summary",
    );

    const result = (await h.dispatcher.handleCommand({
      type: "round.supplement",
      roundId,
      content: "只给 Codex 看",
      mode: "only",
      targets: ["codex"],
    })) as any;
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.data.batch.kind, "supplement");
    assert.equal(result.data.batch.items.length, 1);
    assert.equal(result.data.batch.items[0].recipient, "codex");
    assert.equal(result.data.batch.items[0].differsFromOthers, true);
    await close(h);
  });

  it("retry：只重试失败的人，旧 Turn 被新 Turn 接上", async () => {
    const h = await makeHarness({
      scripts: new Map([["remote:deepseek-discuss", [{ type: "error", reason: "internal" }]]]),
    });
    const created = (await draft(h, ["deepseek"])) as unknown as { data: { round: { id: string }; batch: BatchLike } };
    const roundId = created.data.round.id;
    await approveBatchOf(h, created.data.batch);
    await waitFor(
      () => (h.db.prepare("SELECT outcome FROM turns").get() as { outcome: string }).outcome === "failed",
      "failed turn",
    );

    const retried = (await h.dispatcher.handleCommand({ type: "round.retry", roundId, agent: "deepseek" })) as any;
    assert.equal(retried.ok, true, JSON.stringify(retried));
    assert.equal(retried.data.kind, "retry");
    assert.equal(retried.data.items[0].recipient, "deepseek");
    assert.ok(
      (h.db.prepare("SELECT superseded_by FROM turns ORDER BY rowid LIMIT 1").get() as { superseded_by: string })
        .superseded_by,
    );
    await close(h);
  });

  it("retry：额度缺席的人也能重试（不被 round.draft 的缺席判断挡住）", async () => {
    const h = await makeHarness({
      scripts: new Map([["remote:deepseek-discuss", [{ type: "error", reason: "quota_exhausted" }]]]),
    });
    const created = (await draft(h, ["deepseek"])) as unknown as { data: { round: { id: string }; batch: BatchLike } };
    const roundId = created.data.round.id;
    await approveBatchOf(h, created.data.batch);
    await waitFor(
      () => (h.db.prepare("SELECT outcome FROM turns").get() as { outcome: string }).outcome === "absent_quota",
      "quota turn",
    );

    const retried = (await h.dispatcher.handleCommand({ type: "round.retry", roundId, agent: "deepseek" })) as any;
    assert.equal(retried.ok, true, JSON.stringify(retried));
    assert.equal(retried.data.kind, "retry");
    await close(h);
  });

  it("void：轮到 VOIDED（记录保留），再操作返回 invalid_state", async () => {
    const h = await makeHarness();
    const created = (await draft(h, ["deepseek"])) as unknown as { data: { round: { id: string }; batch: BatchLike } };
    const roundId = created.data.round.id;
    const approved = await approveBatchOf(h, created.data.batch);
    assert.equal(approved.ok, true);
    await waitFor(
      () => (h.db.prepare("SELECT state FROM rounds WHERE id = ?").get(roundId) as { state: string }).state === "AWAITING_SUMMARY",
      "awaiting summary",
    );

    const voided = (await h.dispatcher.handleCommand({ type: "round.void", roundId, reason: "方向变了" })) as any;
    assert.equal(voided.ok, true, JSON.stringify(voided));
    assert.equal(voided.data.state, "VOIDED");
    assert.equal(voided.data.voidReason, "方向变了");
    assert.equal((h.db.prepare("SELECT count(*) AS n FROM messages").get() as { n: number }).n > 0, true, "记录保留");

    const again = await h.dispatcher.handleCommand({ type: "round.void", roundId, reason: "再作废一次" });
    assert.equal(failure(again).error, "invalid_state");
    await close(h);
  });
});

describe("round.redraft / note.add", () => {
  it("redraft：改任务和收件人，旧批次 CANCELLED，新 initial 批次", async () => {
    const h = await makeHarness();
    const created = (await draft(h, ["deepseek"])) as unknown as { data: { round: { id: string }; batch: BatchLike } };
    const roundId = created.data.round.id;

    const redrafted = (await h.dispatcher.handleCommand({
      type: "round.redraft",
      roundId,
      recipients: ["codex"],
      task: "换个问题",
      historyMode: "full",
    })) as any;
    assert.equal(redrafted.ok, true, JSON.stringify(redrafted));
    assert.equal(redrafted.data.round.task, "换个问题");
    assert.deepEqual(redrafted.data.round.recipients, ["codex"]);
    assert.equal(redrafted.data.round.historyMode, "full");
    assert.equal(redrafted.data.batch.kind, "initial");
    assert.equal(redrafted.data.batch.items[0].recipient, "codex");

    const old = h.db.prepare("SELECT state FROM batches WHERE id = ?").get(created.data.batch.id) as { state: string };
    assert.equal(old.state, "CANCELLED");
    await close(h);
  });

  it("note.add：写进时间线；轮进行中带 roundId，否则为 null", async () => {
    const h = await makeHarness();
    const created = (await draft(h, ["deepseek"])) as unknown as { data: { round: { id: string }; batch: BatchLike } };
    const roundId = created.data.round.id;

    const before = (await h.dispatcher.handleCommand({ type: "note.add", projectId: h.projectId, content: "先记一句" })) as any;
    assert.equal(before.ok, true, JSON.stringify(before));
    assert.equal(before.data.kind, "human_note");
    assert.equal(before.data.roundId, null);

    await approveBatchOf(h, created.data.batch);
    await waitFor(
      () => (h.db.prepare("SELECT state FROM rounds WHERE id = ?").get(roundId) as { state: string }).state === "AWAITING_SUMMARY",
      "awaiting summary",
    );
    const during = (await h.dispatcher.handleCommand({ type: "note.add", projectId: h.projectId, content: "进行中记一句" })) as any;
    assert.equal(during.data.roundId, roundId);
    assert.ok(h.events.some((e) => e.type === "message.created" && (e as any).message.kind === "human_note"));
    await close(h);
  });
});

describe("方案：定稿 → 派生 → 确认 → 再定稿（C-26），edit / derive", () => {
  it("派生版本定稿时旧 FINAL 变 SUPERSEDED；edit 生成新草稿", async () => {
    const h = await makeHarness({
      scripts: new Map([["remote:claude-review", [{ type: "message_complete", text: SUMMARY_JSON }, { type: "completed" }]]]),
    });
    const { planId: v1Id, contentHash: v1Hash } = await makePlan(h);

    assert.equal((await h.dispatcher.handleCommand({ type: "plan.confirm", planVersionId: v1Id })).ok, true);
    const v1Final = (await h.dispatcher.handleCommand({
      type: "plan.finalize",
      planVersionId: v1Id,
      expectedContentHash: v1Hash,
    })) as any;
    assert.equal(v1Final.ok, true, JSON.stringify(v1Final));
    assert.equal(v1Final.data.state, "FINAL");

    const derived = (await h.dispatcher.handleCommand({ type: "plan.derive", planVersionId: v1Id })) as any;
    assert.equal(derived.ok, true, JSON.stringify(derived));
    assert.equal(derived.data.version, 2);
    assert.equal(derived.data.state, "DRAFT");
    assert.equal(derived.data.parentId, v1Id);
    assert.equal(derived.data.content, "# 方案 v1\n第一版", "派生内容不变");

    assert.equal((await h.dispatcher.handleCommand({ type: "plan.confirm", planVersionId: derived.data.id })).ok, true);
    const v2Final = (await h.dispatcher.handleCommand({
      type: "plan.finalize",
      planVersionId: derived.data.id,
      expectedContentHash: derived.data.contentHash,
    })) as any;
    assert.equal(v2Final.ok, true, JSON.stringify(v2Final));
    assert.equal(v2Final.data.state, "FINAL");

    const v1Row = h.db.prepare("SELECT state, superseded_reason FROM plan_versions WHERE id = ?").get(v1Id) as {
      state: string;
      superseded_reason: string | null;
    };
    assert.equal(v1Row.state, "SUPERSEDED");
    assert.ok(v1Row.superseded_reason);
    assert.ok(
      h.events.some(
        (e) => e.type === "plan.updated" && (e as any).plan.id === v1Id && (e as any).plan.state === "SUPERSEDED",
      ),
      "旧 FINAL 的 plan.updated 也要推",
    );

    const edited = (await h.dispatcher.handleCommand({
      type: "plan.edit",
      parentId: derived.data.id,
      content: "# 方案 v3",
      changeNote: "再补一条",
    })) as any;
    assert.equal(edited.ok, true, JSON.stringify(edited));
    assert.equal(edited.data.version, 3);
    assert.equal(edited.data.state, "DRAFT");
    assert.equal(edited.data.parentId, derived.data.id);
    assert.equal(
      (h.db.prepare("SELECT state FROM plan_versions WHERE id = ?").get(derived.data.id) as { state: string }).state,
      "FINAL",
      "从 FINAL 编辑不会把 FINAL 变成别的",
    );
    await close(h);
  });
});

describe("batch.reject：拒绝原因落库", () => {
  it("Approval.reason 记下用户填的原因", async () => {
    const h = await makeHarness();
    const created = (await draft(h, ["deepseek", "codex"])) as unknown as { data: { batch: BatchLike } };
    const rejected = await h.dispatcher.handleCommand({
      type: "batch.reject",
      batchId: created.data.batch.id,
      reason: "先补背景",
    });
    assert.equal(rejected.ok, true, JSON.stringify(rejected));

    const reasons = h.db.prepare("SELECT reason FROM approvals WHERE state = 'REJECTED'").all() as { reason: string | null }[];
    assert.equal(reasons.length, 2);
    assert.ok(reasons.every((row) => row.reason === "先补背景"));
    await close(h);
  });
});
