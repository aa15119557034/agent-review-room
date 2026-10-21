import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  approveBatch,
  BatchApproveError,
  createDraftTurns,
  createRoundDraft,
  createSummaryDraft,
  openDatabase,
  RoundDraftError,
  ulid,
  WriteQueue,
} from "../src/index";
import type { RoundDraftRecipient, SqliteDatabase } from "../src/index";

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // Windows 句柄释放有延迟
    }
  }
});

const NOW = "2026-10-21T00:00:00.000Z";
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

interface Fixture {
  db: SqliteDatabase;
  queue: WriteQueue;
  projectId: string;
  roundId: string;
  batchId: string;
  items: { recipient: string; approvalId: string; snapshotId: string; contentHash: string }[];
}

/** 一个「已经拼好 Prompt、等盖章」的批次：round(DRAFT) + batch(READY_FOR_REVIEW) + N 份 snapshot/approval */
async function seedBatch(recipients: string[], kind = "initial", draft = true): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), "room-db-d21-"));
  dirs.push(dir);
  const db = openDatabase(join(dir, "test.db"));
  const queue = new WriteQueue();

  const projectId = "proj_" + ulid();
  const roundId = "rnd_" + ulid();
  const batchId = "bat_" + ulid();

  db.prepare("INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)").run(projectId, "议题", NOW);
  db.prepare(
    "INSERT INTO rounds (id, project_id, round_index, state, task, task_source, recipients, history_mode, created_at) " +
      "VALUES (?, ?, 1, 'DRAFT', '本轮任务', 'human', ?, 'recent_with_summaries', ?)",
  ).run(roundId, projectId, JSON.stringify(recipients), NOW);
  db.prepare(
    "INSERT INTO batches (id, project_id, round_id, kind, state, created_at) VALUES (?, ?, ?, ?, 'READY_FOR_REVIEW', ?)",
  ).run(batchId, projectId, roundId, kind, NOW);

  const items = recipients.map((recipient, i) => {
    const content = `发给 ${recipient} 的 Prompt`;
    const contentHash = sha(content);
    const snapshotId = "snap_" + ulid();
    const approvalId = "apr_" + ulid();
    db.prepare(
      "INSERT INTO prompt_snapshots (id, project_id, content, content_hash, nonce, contribution_ids, task_instruction, " +
        "reviewer_agent, adapter_version, token_estimate, created_at) VALUES (?, ?, ?, ?, '0123456789abcdef', '[]', '任务', ?, 'prompt-v3', 10, ?)",
    ).run(snapshotId, projectId, content, contentHash, recipient, NOW);
    db.prepare(
      "INSERT INTO approvals (id, project_id, snapshot_id, state, created_at) VALUES (?, ?, ?, 'READY_FOR_REVIEW', ?)",
    ).run(approvalId, projectId, snapshotId, NOW);
    db.prepare(
      "INSERT INTO batch_items (batch_id, recipient, approval_id, snapshot_id, content_hash, token_estimate) VALUES (?, ?, ?, ?, ?, 10)",
    ).run(batchId, recipient, approvalId, snapshotId, contentHash);
    return { recipient, approvalId, snapshotId, contentHash };
  });

  if (draft) await createDraftTurns(db, queue, batchId);

  return { db, queue, projectId, roundId, batchId, items };
}

const count = (db: SqliteDatabase, sql: string): number => (db.prepare(sql).get() as { n: number }).n;

describe("approveBatch：一次盖章 = N 个 Run", () => {
  it("两个人一起盖章：两个 Run、两个 Turn、两个 Approval 全部落地", async () => {
    const f = await seedBatch(["deepseek", "codex"]);

    const result = await approveBatch(f.db, f.queue, {
      batchId: f.batchId,
      items: f.items.map((item) => ({ approvalId: item.approvalId, expectedContentHash: item.contentHash })),
      via: "desktop",
    });

    assert.equal(result.runIds.length, 2);
    assert.equal(result.turnIds.length, 2);
    assert.equal(count(f.db, "SELECT count(*) AS n FROM runs WHERE state = 'QUEUED'"), 2);
    assert.equal(count(f.db, "SELECT count(*) AS n FROM turns WHERE outcome = 'running'"), 2);
    assert.equal(count(f.db, "SELECT count(*) AS n FROM approvals WHERE state = 'APPROVED'"), 2);
    assert.equal(
      (f.db.prepare("SELECT state FROM batches WHERE id = ?").get(f.batchId) as { state: string }).state,
      "APPROVED",
    );
    assert.equal(
      (f.db.prepare("SELECT state FROM rounds WHERE id = ?").get(f.roundId) as { state: string }).state,
      "RUNNING",
    );

    // 每个 Turn 都指向自己的 Run，且批内不重复
    const pairs = f.db.prepare("SELECT agent, run_id FROM turns ORDER BY agent").all() as { agent: string; run_id: string }[];
    assert.deepEqual(pairs.map((p) => p.agent), ["codex", "deepseek"]);
    assert.equal(new Set(pairs.map((p) => p.run_id)).size, 2);
    f.db.close();
  });

  it("指纹对不上就整批不发，一条都不写", async () => {
    const f = await seedBatch(["deepseek", "codex"]);
    const tampered = f.items.map((item, i) => ({
      approvalId: item.approvalId,
      expectedContentHash: i === 0 ? "b".repeat(64) : item.contentHash,
    }));

    await assert.rejects(
      () => approveBatch(f.db, f.queue, { batchId: f.batchId, items: tampered, via: "desktop" }),
      (error: unknown) => error instanceof BatchApproveError && error.code === "hash_mismatch",
    );

    assert.equal(count(f.db, "SELECT count(*) AS n FROM runs"), 0);
    // 起草时建的 pending Turn 还在，但没有一条变成 running
    assert.equal(count(f.db, "SELECT count(*) AS n FROM turns WHERE outcome = 'running'"), 0);
    assert.equal(count(f.db, "SELECT count(*) AS n FROM turns WHERE outcome = 'pending'"), 2);
    assert.equal(count(f.db, "SELECT count(*) AS n FROM approvals WHERE state = 'APPROVED'"), 0);
    assert.equal(
      (f.db.prepare("SELECT state FROM batches WHERE id = ?").get(f.batchId) as { state: string }).state,
      "READY_FOR_REVIEW",
    );
    assert.equal(
      (f.db.prepare("SELECT state FROM rounds WHERE id = ?").get(f.roundId) as { state: string }).state,
      "DRAFT",
    );
    f.db.close();
  });

  it("少盖一个人也不行（不能只发一半）", async () => {
    const f = await seedBatch(["deepseek", "codex"]);
    await assert.rejects(
      () =>
        approveBatch(f.db, f.queue, {
          batchId: f.batchId,
          items: [{ approvalId: f.items[0]!.approvalId, expectedContentHash: f.items[0]!.contentHash }],
          via: "desktop",
        }),
      (error: unknown) => error instanceof BatchApproveError && error.code === "item_missing",
    );
    assert.equal(count(f.db, "SELECT count(*) AS n FROM runs"), 0);
    f.db.close();
  });

  it("有一个 Approval 已经不在 READY_FOR_REVIEW，整批回滚", async () => {
    const f = await seedBatch(["deepseek", "codex"]);
    f.db.prepare("UPDATE approvals SET state = 'CANCELLED' WHERE id = ?").run(f.items[1]!.approvalId);

    await assert.rejects(
      () =>
        approveBatch(f.db, f.queue, {
          batchId: f.batchId,
          items: f.items.map((item) => ({ approvalId: item.approvalId, expectedContentHash: item.contentHash })),
          via: "desktop",
        }),
      (error: unknown) => error instanceof BatchApproveError && error.code === "approval_not_ready",
    );

    // 第一个已经 APPROVED 的也必须滚回去
    assert.equal(count(f.db, "SELECT count(*) AS n FROM approvals WHERE state = 'APPROVED'"), 0);
    assert.equal(count(f.db, "SELECT count(*) AS n FROM runs"), 0);
    f.db.close();
  });

  it("重复盖章被拒（批次已经不是 READY_FOR_REVIEW）", async () => {
    const f = await seedBatch(["deepseek"]);
    const items = f.items.map((item) => ({ approvalId: item.approvalId, expectedContentHash: item.contentHash }));
    await approveBatch(f.db, f.queue, { batchId: f.batchId, items, via: "desktop" });

    await assert.rejects(
      () => approveBatch(f.db, f.queue, { batchId: f.batchId, items, via: "desktop" }),
      (error: unknown) => error instanceof BatchApproveError && error.code === "batch_not_ready",
    );
    assert.equal(count(f.db, "SELECT count(*) AS n FROM runs"), 1);
    f.db.close();
  });
});

describe("approveBatch：按批次种类转换这一轮", () => {
  it("resume：PAUSED → RUNNING", async () => {
    const f = await seedBatch(["deepseek"], "resume", false);
    f.db.prepare("UPDATE rounds SET state = 'PAUSED' WHERE id = ?").run(f.roundId);
    await createDraftTurns(f.db, f.queue, f.batchId);

    await approveBatch(f.db, f.queue, {
      batchId: f.batchId,
      items: f.items.map((item) => ({ approvalId: item.approvalId, expectedContentHash: item.contentHash })),
      via: "desktop",
    });
    assert.equal(
      (f.db.prepare("SELECT state FROM rounds WHERE id = ?").get(f.roundId) as { state: string }).state,
      "RUNNING",
    );
    f.db.close();
  });

  it("summary：AWAITING_SUMMARY → SUMMARIZING", async () => {
    const f = await seedBatch(["claude"], "summary", false);
    f.db.prepare("UPDATE rounds SET state = 'AWAITING_SUMMARY' WHERE id = ?").run(f.roundId);
    await createDraftTurns(f.db, f.queue, f.batchId);

    await approveBatch(f.db, f.queue, {
      batchId: f.batchId,
      items: f.items.map((item) => ({ approvalId: item.approvalId, expectedContentHash: item.contentHash })),
      via: "desktop",
    });
    assert.equal(
      (f.db.prepare("SELECT state FROM rounds WHERE id = ?").get(f.roundId) as { state: string }).state,
      "SUMMARIZING",
    );
    assert.equal(
      (f.db.prepare("SELECT is_summary FROM turns LIMIT 1").get() as { is_summary: number }).is_summary,
      1,
    );
    f.db.close();
  });

  it("supplement：AWAITING_SUMMARY → RUNNING（C-20c 补的转换）", async () => {
    const f = await seedBatch(["deepseek"], "supplement", false);
    f.db.prepare("UPDATE rounds SET state = 'AWAITING_SUMMARY' WHERE id = ?").run(f.roundId);
    await createDraftTurns(f.db, f.queue, f.batchId);

    await approveBatch(f.db, f.queue, {
      batchId: f.batchId,
      items: f.items.map((item) => ({ approvalId: item.approvalId, expectedContentHash: item.contentHash })),
      via: "desktop",
    });
    assert.equal(
      (f.db.prepare("SELECT state FROM rounds WHERE id = ?").get(f.roundId) as { state: string }).state,
      "RUNNING",
    );
    f.db.close();
  });

  it("retry：RUNNING 不变（不重复写状态）", async () => {
    const f = await seedBatch(["deepseek"], "retry", false);
    f.db.prepare("UPDATE rounds SET state = 'RUNNING' WHERE id = ?").run(f.roundId);
    await createDraftTurns(f.db, f.queue, f.batchId);

    await approveBatch(f.db, f.queue, {
      batchId: f.batchId,
      items: f.items.map((item) => ({ approvalId: item.approvalId, expectedContentHash: item.contentHash })),
      via: "desktop",
    });
    assert.equal(
      (f.db.prepare("SELECT state FROM rounds WHERE id = ?").get(f.roundId) as { state: string }).state,
      "RUNNING",
    );
    f.db.close();
  });

  it("SUMMARIZED 之后不能再塞 initial 批次", async () => {
    const f = await seedBatch(["deepseek"], "initial", false);
    f.db.prepare("UPDATE rounds SET state = 'SUMMARIZED' WHERE id = ?").run(f.roundId);
    await createDraftTurns(f.db, f.queue, f.batchId);

    await assert.rejects(
      () =>
        approveBatch(f.db, f.queue, {
          batchId: f.batchId,
          items: f.items.map((item) => ({ approvalId: item.approvalId, expectedContentHash: item.contentHash })),
          via: "desktop",
        }),
      (error: unknown) => error instanceof BatchApproveError && error.code === "round_transition_invalid",
    );
    assert.equal(count(f.db, "SELECT count(*) AS n FROM runs"), 0);
    f.db.close();
  });

  it("没有起草（没有 pending Turn）就盖章会被拒，且不写 Run", async () => {
    const f = await seedBatch(["deepseek"], "initial", false);

    await assert.rejects(
      () =>
        approveBatch(f.db, f.queue, {
          batchId: f.batchId,
          items: f.items.map((item) => ({ approvalId: item.approvalId, expectedContentHash: item.contentHash })),
          via: "desktop",
        }),
      (error: unknown) => error instanceof BatchApproveError && error.code === "turn_not_pending",
    );
    assert.equal(count(f.db, "SELECT count(*) AS n FROM runs"), 0);
    assert.equal(count(f.db, "SELECT count(*) AS n FROM approvals WHERE state = 'APPROVED'"), 0);
    f.db.close();
  });
});

describe("approveBatch：这种批次能不能从当前状态出发", () => {
  it("resume 在 AWAITING_SUMMARY 被拒（表里允许转 RUNNING，但语义上只能从 PAUSED）", async () => {
    const f = await seedBatch(["deepseek"], "resume", false);
    f.db.prepare("UPDATE rounds SET state = 'AWAITING_SUMMARY' WHERE id = ?").run(f.roundId);
    await createDraftTurns(f.db, f.queue, f.batchId);

    await assert.rejects(
      () =>
        approveBatch(f.db, f.queue, {
          batchId: f.batchId,
          items: f.items.map((item) => ({ approvalId: item.approvalId, expectedContentHash: item.contentHash })),
          via: "desktop",
        }),
      (error: unknown) => error instanceof BatchApproveError && error.code === "round_transition_invalid",
    );
    assert.equal(count(f.db, "SELECT count(*) AS n FROM runs"), 0);
    assert.equal(
      (f.db.prepare("SELECT state FROM rounds WHERE id = ?").get(f.roundId) as { state: string }).state,
      "AWAITING_SUMMARY",
    );
    f.db.close();
  });

  it("summary 在已经 SUMMARIZING 时再盖一次被拒（不能有两个汇总在跑）", async () => {
    const f = await seedBatch(["claude"], "summary", false);
    f.db.prepare("UPDATE rounds SET state = 'SUMMARIZING' WHERE id = ?").run(f.roundId);
    await createDraftTurns(f.db, f.queue, f.batchId);

    await assert.rejects(
      () =>
        approveBatch(f.db, f.queue, {
          batchId: f.batchId,
          items: f.items.map((item) => ({ approvalId: item.approvalId, expectedContentHash: item.contentHash })),
          via: "desktop",
        }),
      (error: unknown) => error instanceof BatchApproveError && error.code === "round_transition_invalid",
    );
    assert.equal(count(f.db, "SELECT count(*) AS n FROM runs"), 0);
    f.db.close();
  });

  it("initial 在 PAUSED 被拒（那时应该走 resume）", async () => {
    const f = await seedBatch(["deepseek"], "initial", false);
    f.db.prepare("UPDATE rounds SET state = 'PAUSED' WHERE id = ?").run(f.roundId);
    await createDraftTurns(f.db, f.queue, f.batchId);

    await assert.rejects(
      () =>
        approveBatch(f.db, f.queue, {
          batchId: f.batchId,
          items: f.items.map((item) => ({ approvalId: item.approvalId, expectedContentHash: item.contentHash })),
          via: "desktop",
        }),
      (error: unknown) => error instanceof BatchApproveError && error.code === "round_transition_invalid",
    );
    f.db.close();
  });
});

function draftProject(prefix = "room-db-draft-"): { db: SqliteDatabase; queue: WriteQueue; projectId: string } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  const db = openDatabase(join(dir, "test.db"));
  const queue = new WriteQueue();
  const projectId = "proj_" + ulid();
  db.prepare("INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)").run(projectId, "议题", NOW);
  return { db, queue, projectId };
}

/** 交给 createRoundDraft 的收件人：Prompt 由 core 拼，这里只造和它一样形状的数据 */
function draftRecipient(
  agent: string,
  options: { content?: string; contentHash?: string; differsFromOthers?: boolean } = {},
): RoundDraftRecipient {
  const content = options.content ?? "发给 " + agent + " 的讨论 Prompt";
  return {
    agent,
    prompt: {
      content,
      contentHash: options.contentHash ?? sha(content),
      nonce: "0123456789abcdef",
      adapterVersion: "discussion-v2",
      tokenEstimate: 42,
      differsFromOthers: options.differsFromOthers ?? false,
    },
  };
}

describe("createRoundDraft：起草一轮", () => {
  it("N 个收件人 → N 份 Snapshot / Approval / batch_item / pending Turn，轮是 DRAFT", async () => {
    const f = draftProject();
    const compressed = [{ roundIndex: 1, summaryMessageId: "msg_0123456789abcdefghijklmn", summarizer: "claude" }];

    const { round, batch } = await createRoundDraft(f.db, f.queue, {
      projectId: f.projectId,
      recipients: [draftRecipient("deepseek"), draftRecipient("codex")],
      task: "各自说说怎么做",
      taskSource: "human",
      historyMode: "recent_with_summaries",
      compressedRounds: compressed,
    });

    assert.equal(round.state, "DRAFT");
    assert.equal(round.round_index, 1);
    assert.equal(round.task, "各自说说怎么做");
    assert.equal(round.task_source, "human");
    assert.equal(round.history_mode, "recent_with_summaries");
    assert.equal(round.plan_version_id, null);
    assert.deepEqual(JSON.parse(round.recipients), ["deepseek", "codex"]);

    assert.equal(batch.kind, "initial");
    assert.equal(batch.state, "READY_FOR_REVIEW");
    assert.equal(batch.round_id, round.id);
    assert.deepEqual(JSON.parse(batch.compressed_rounds), compressed);

    assert.equal(count(f.db, "SELECT count(*) AS n FROM prompt_snapshots"), 2);
    assert.equal(count(f.db, "SELECT count(*) AS n FROM approvals WHERE state = 'READY_FOR_REVIEW'"), 2);
    assert.equal(count(f.db, "SELECT count(*) AS n FROM batch_items"), 2);
    assert.equal(
      count(f.db, "SELECT count(*) AS n FROM turns WHERE outcome = 'pending' AND run_id IS NULL"),
      2,
      "Turn 在盖章之前就是 pending 且没有 Run",
    );

    // Snapshot 的指纹 / nonce / 任务 / 拼装器版本都能对上，而且内容没被改过
    const snapshots = f.db
      .prepare(
        "SELECT content, content_hash, nonce, task_instruction, reviewer_agent, adapter_version, token_estimate FROM prompt_snapshots ORDER BY reviewer_agent",
      )
      .all() as Record<string, string | number>[];
    assert.deepEqual(snapshots.map((s) => s["reviewer_agent"]), ["codex", "deepseek"]);
    for (const snapshot of snapshots) {
      assert.equal(snapshot["content_hash"], sha(snapshot["content"] as string));
      assert.equal(snapshot["nonce"], "0123456789abcdef");
      assert.equal(snapshot["task_instruction"], "各自说说怎么做");
      assert.equal(snapshot["adapter_version"], "discussion-v2");
      assert.equal(snapshot["token_estimate"], 42);
    }

    // batch_item 与 Turn 通过 approval 一一对应，收件人顺序一致
    const pairs = f.db
      .prepare(
        "SELECT bi.recipient, t.agent, t.approval_id, bi.approval_id AS item_approval, t.is_summary " +
          "FROM batch_items bi JOIN turns t ON t.approval_id = bi.approval_id ORDER BY bi.recipient",
      )
      .all() as { recipient: string; agent: string; approval_id: string; item_approval: string; is_summary: number }[];
    assert.deepEqual(pairs.map((p) => p.recipient), ["codex", "deepseek"]);
    assert.deepEqual(pairs.map((p) => p.agent), ["codex", "deepseek"]);
    assert.ok(pairs.every((p) => p.approval_id === p.item_approval));
    assert.ok(pairs.every((p) => p.is_summary === 0));
    f.db.close();
  });

  it("轮号 = 同项目 max + 1（作废 / 已汇总的轮也占号）", async () => {
    const f = draftProject();
    // 上一轮已经汇总，不算「没结束」，可以继续起草下一轮
    f.db
      .prepare(
        "INSERT INTO rounds (id, project_id, round_index, state, task, task_source, recipients, history_mode, created_at) " +
          "VALUES (?, ?, 3, 'SUMMARIZED', '上一轮', 'human', '[\"claude\"]', 'recent_with_summaries', ?)",
      )
      .run("rnd_" + ulid(), f.projectId, NOW);

    const { round } = await createRoundDraft(f.db, f.queue, {
      projectId: f.projectId,
      recipients: [draftRecipient("deepseek")],
      task: "下一轮",
      taskSource: "carried_over",
      historyMode: "full",
    });
    assert.equal(round.round_index, 4, "作废的轮也占号，所以用 max+1");
    assert.equal(round.state, "DRAFT");
    f.db.close();
  });

  it("同一议题同时只能有一轮没结束（ux_round_active 兜底），第二次起草一条都不写", async () => {
    const f = draftProject();
    const input = {
      projectId: f.projectId,
      recipients: [draftRecipient("deepseek")],
      task: "本轮任务",
      taskSource: "human" as const,
      historyMode: "full" as const,
    };
    await createRoundDraft(f.db, f.queue, input);

    await assert.rejects(
      () => createRoundDraft(f.db, f.queue, input),
      (error: unknown) => error instanceof RoundDraftError && error.code === "round_active",
    );

    assert.equal(count(f.db, "SELECT count(*) AS n FROM rounds"), 1);
    assert.equal(count(f.db, "SELECT count(*) AS n FROM batches"), 1);
    assert.equal(count(f.db, "SELECT count(*) AS n FROM prompt_snapshots"), 1);
    assert.equal(count(f.db, "SELECT count(*) AS n FROM turns"), 1);
    f.db.close();
  });

  it("指纹和内容对不上就整笔回滚（轮、批次、批次项都不留）", async () => {
    const f = draftProject();
    await assert.rejects(
      () =>
        createRoundDraft(f.db, f.queue, {
          projectId: f.projectId,
          recipients: [draftRecipient("deepseek"), draftRecipient("codex", { contentHash: "b".repeat(64) })],
          task: "本轮任务",
          taskSource: "human",
          historyMode: "full",
        }),
      (error: unknown) => error instanceof RoundDraftError && error.code === "hash_mismatch",
    );

    assert.equal(count(f.db, "SELECT count(*) AS n FROM rounds"), 0);
    assert.equal(count(f.db, "SELECT count(*) AS n FROM batches"), 0);
    assert.equal(count(f.db, "SELECT count(*) AS n FROM prompt_snapshots"), 0);
    assert.equal(count(f.db, "SELECT count(*) AS n FROM approvals"), 0);
    assert.equal(count(f.db, "SELECT count(*) AS n FROM turns"), 0);
    f.db.close();
  });

  it("附带方案：必须是同一议题的版本", async () => {
    const f = draftProject();
    const planId = "plan_" + ulid();
    f.db
      .prepare(
        "INSERT INTO plan_versions (id, project_id, version, state, content, content_hash, drafted_by_kind, created_at) " +
          "VALUES (?, ?, 1, 'DRAFT', '# 方案', ?, 'human', ?)",
      )
      .run(planId, f.projectId, sha("# 方案"), NOW);

    const { round } = await createRoundDraft(f.db, f.queue, {
      projectId: f.projectId,
      recipients: [draftRecipient("deepseek")],
      task: "带着方案讨论",
      taskSource: "human",
      planVersionId: planId,
      historyMode: "recent_with_summaries",
    });
    assert.equal(round.plan_version_id, planId);

    // 别的议题的方案不能挂上来（外键只保证存在，不保证属于这个议题）
    const otherProjectId = "proj_" + ulid();
    f.db.prepare("INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)").run(otherProjectId, "别的议题", NOW);
    const otherPlanId = "plan_" + ulid();
    f.db
      .prepare(
        "INSERT INTO plan_versions (id, project_id, version, state, content, content_hash, drafted_by_kind, created_at) " +
          "VALUES (?, ?, 1, 'DRAFT', '# 别的方案', ?, 'human', ?)",
      )
      .run(otherPlanId, otherProjectId, sha("# 别的方案"), NOW);

    // 这一轮还没结束，先把它标成已汇总，才能再起草
    f.db.prepare("UPDATE rounds SET state = 'SUMMARIZED' WHERE id = ?").run(round.id);
    await assert.rejects(
      () =>
        createRoundDraft(f.db, f.queue, {
          projectId: f.projectId,
          recipients: [draftRecipient("codex")],
          task: "下一轮",
          taskSource: "human",
          planVersionId: otherPlanId,
          historyMode: "full",
        }),
      (error: unknown) => error instanceof RoundDraftError && error.code === "invalid_input",
    );
    assert.equal(count(f.db, "SELECT count(*) AS n FROM rounds"), 1);
    f.db.close();
  });

  it("收件人重复按 invalid_input 拒绝，不写任何东西", async () => {
    const f = draftProject();
    await assert.rejects(
      () =>
        createRoundDraft(f.db, f.queue, {
          projectId: f.projectId,
          recipients: [draftRecipient("deepseek"), draftRecipient("deepseek")],
          task: "本轮任务",
          taskSource: "human",
          historyMode: "full",
        }),
      (error: unknown) => error instanceof RoundDraftError && error.code === "invalid_input",
    );
    assert.equal(count(f.db, "SELECT count(*) AS n FROM rounds"), 0);
    f.db.close();
  });

  it("「只发给他」的标记照抄进 batch_item；替补这一片还不写 on_behalf_of", async () => {
    const f = draftProject();
    const { batch } = await createRoundDraft(f.db, f.queue, {
      projectId: f.projectId,
      recipients: [draftRecipient("claude", { differsFromOthers: true })],
      task: "本轮任务",
      taskSource: "human",
      historyMode: "recent_with_summaries",
    });

    assert.equal(batch.kind, "initial");
    const turn = f.db.prepare("SELECT agent, on_behalf_of, is_summary, outcome FROM turns").get() as {
      agent: string;
      on_behalf_of: string | null;
      is_summary: number;
      outcome: string;
    };
    assert.equal(turn.agent, "claude");
    // 契约的 round.draft 没有 onBehalfOf：替补那一片再做，这里一律 NULL
    assert.equal(turn.on_behalf_of, null);
    assert.equal(turn.is_summary, 0);
    assert.equal(turn.outcome, "pending");
    const item = f.db.prepare("SELECT recipient, on_behalf_of, differs_from_others FROM batch_items").get() as {
      recipient: string;
      on_behalf_of: string | null;
      differs_from_others: number;
    };
    assert.deepEqual(item, { recipient: "claude", on_behalf_of: null, differs_from_others: 1 });
    f.db.close();
  });
});

function summaryProject(): { db: SqliteDatabase; queue: WriteQueue; projectId: string; roundId: string } {
  const f = draftProject("room-db-summary-");
  const roundId = "rnd_" + ulid();
  f.db
    .prepare(
      "INSERT INTO rounds (id, project_id, round_index, state, task, task_source, recipients, history_mode, created_at) " +
        "VALUES (?, ?, 1, 'AWAITING_SUMMARY', '本轮任务', 'human', '[\"deepseek\",\"codex\"]', 'recent_with_summaries', ?)",
    )
    .run(roundId, f.projectId, NOW);
  return { ...f, roundId };
}

describe("createSummaryDraft：给已有的轮加汇总批次", () => {
  it("AWAITING_SUMMARY 的轮上建 summary 批次，Turn 记 is_summary，轮状态不变", async () => {
    const f = summaryProject();

    const { batch } = await createSummaryDraft(f.db, f.queue, {
      roundId: f.roundId,
      recipients: [draftRecipient("claude")],
      compressedRounds: [{ roundIndex: 1, summaryMessageId: "msg_0123456789abcdefghijklmn", summarizer: "claude" }],
    });

    assert.equal(batch.kind, "summary");
    assert.equal(batch.state, "READY_FOR_REVIEW");
    assert.equal(batch.round_id, f.roundId);
    assert.equal(count(f.db, "SELECT count(*) AS n FROM prompt_snapshots"), 1);
    assert.equal(count(f.db, "SELECT count(*) AS n FROM approvals WHERE state = 'READY_FOR_REVIEW'"), 1);
    assert.equal(count(f.db, "SELECT count(*) AS n FROM batch_items"), 1);
    const turn = f.db.prepare("SELECT agent, is_summary, outcome, run_id FROM turns").get() as {
      agent: string;
      is_summary: number;
      outcome: string;
      run_id: string | null;
    };
    assert.deepEqual(turn, { agent: "claude", is_summary: 1, outcome: "pending", run_id: null });
    // 汇总不改变轮的状态（盖章时才 AWAITING_SUMMARY -> SUMMARIZING）
    assert.equal(
      (f.db.prepare("SELECT state FROM rounds WHERE id = ?").get(f.roundId) as { state: string }).state,
      "AWAITING_SUMMARY",
    );
    f.db.close();
  });

  it("轮不在 AWAITING_SUMMARY 时拒绝，一条都不写", async () => {
    const f = summaryProject();
    f.db.prepare("UPDATE rounds SET state = 'RUNNING' WHERE id = ?").run(f.roundId);

    await assert.rejects(
      () => createSummaryDraft(f.db, f.queue, { roundId: f.roundId, recipients: [draftRecipient("claude")] }),
      (error: unknown) => error instanceof RoundDraftError && error.code === "round_not_awaiting_summary",
    );
    assert.equal(count(f.db, "SELECT count(*) AS n FROM batches"), 0);
    assert.equal(count(f.db, "SELECT count(*) AS n FROM prompt_snapshots"), 0);
    f.db.close();
  });

  it("重新请求汇总：旧的待盖章 summary 批次作废（含 pending Turn），只留新的一张", async () => {
    const f = summaryProject();
    const first = await createSummaryDraft(f.db, f.queue, { roundId: f.roundId, recipients: [draftRecipient("claude")] });

    const second = await createSummaryDraft(f.db, f.queue, { roundId: f.roundId, recipients: [draftRecipient("deepseek")] });

    assert.notEqual(second.batch.id, first.batch.id);
    const firstBatch = f.db.prepare("SELECT state FROM batches WHERE id = ?").get(first.batch.id) as { state: string };
    assert.equal(firstBatch.state, "CANCELLED");
    assert.equal(count(f.db, "SELECT count(*) AS n FROM batches WHERE state = 'READY_FOR_REVIEW'"), 1);
    assert.equal(count(f.db, "SELECT count(*) AS n FROM approvals WHERE state = 'CANCELLED'"), 1);
    assert.equal(count(f.db, "SELECT count(*) AS n FROM turns WHERE outcome = 'rejected'"), 1);
    assert.equal(count(f.db, "SELECT count(*) AS n FROM turns WHERE outcome = 'pending'"), 1);
    f.db.close();
  });

  it("收件人不是一个就拒绝", async () => {
    const f = summaryProject();
    await assert.rejects(
      () =>
        createSummaryDraft(f.db, f.queue, {
          roundId: f.roundId,
          recipients: [draftRecipient("claude"), draftRecipient("deepseek")],
        }),
      (error: unknown) => error instanceof RoundDraftError && error.code === "invalid_input",
    );
    f.db.close();
  });
});

