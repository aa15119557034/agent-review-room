import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { AgentAdapter } from "@room/core";
import { openDatabase, type RunRow, ulid, WriteQueue } from "@room/db";
import type { AgentEvent, ControlEvent } from "@room/schemas";
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
  projectId: string;
}

async function makeHarness(options: {
  probe?: (params: { baseUrl: string; token: string; profileId: string }) => Promise<NodeProbeResult>;
  scripts?: Map<string, Record<string, unknown>[]>;
} = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "room-discussion-ipc-"));
  dirs.push(dir);
  const db = openDatabase(join(dir, "test.db"));
  const queue = new WriteQueue();
  const repo = new Repository(db, queue);
  const settings = new SettingsStore(join(dir, "settings.json"), fakeSafeStorage);
  settings.updateReviewerNode({ baseUrl: NODE_URL, profileId: "claude-review", token: "t".repeat(40) });

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
    emit: (e) => events.push(e),
    getRun: (runId) => db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as never,
    adapterFactory: async (run) => {
      started.push(run);
      const script = scripts.get(run.adapter_id) ?? ANSWER;
      return fakeAdapter(async function* (_sessionId, runId) {
        let seq = 0;
        for (const part of script) yield event(runId, seq++, part);
      });
    },
    onDiscussionSettled: (settlement) => service?.settled(settlement),
  });

  service = new DiscussionService({ db, queue, repo, settings, orchestrator, emit: (e) => events.push(e), probeNode: probe });

  const dispatcher = createDispatcher({
    repo,
    settings,
    orchestrator,
    discussion: service,
    appVersion: "0.0.0-test",
    recoveredRuns: 0,
    emit: (e) => events.push(e),
  });

  const project = await dispatcher.handleCommand({ type: "project.create", name: "议题" });
  const projectId = (project as { data: { id: string } }).data.id;
  return { db, dispatcher, repo, orchestrator, events, started, probeCalls, projectId };
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

    const next = await draft(h, ["deepseek"]);
    assert.equal(failure(next).error, "agent_unavailable");
    assert.match(failure(next).message, /额度用尽/);
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
