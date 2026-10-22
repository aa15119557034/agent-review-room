import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { confirmPlan, createPlan, derivePlan, editPlan, finalizePlan, openDatabase, PlanError, ulid, WriteQueue } from "../src/index";
import type { SqliteDatabase } from "../src/index";

/**
 * 方案版本的写入：plan.confirm（DRAFT → CURRENT）与 plan.finalize（CURRENT → FINAL，校验指纹）。
 */

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

const NOW = "2026-10-22T00:00:00.000Z";
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

interface Fixture {
  db: SqliteDatabase;
  queue: WriteQueue;
  projectId: string;
}

function makeFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "room-db-plan-"));
  dirs.push(dir);
  const db = openDatabase(join(dir, "test.db"));
  const queue = new WriteQueue();
  const projectId = "proj_" + ulid();
  db.prepare("INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)").run(projectId, "议题", NOW);
  return { db, queue, projectId };
}

function insertPlan(
  f: Fixture,
  input: { version: number; state: "DRAFT" | "CURRENT" | "FINAL" | "SUPERSEDED"; content: string },
): { id: string; contentHash: string } {
  const id = "plan_" + ulid();
  const contentHash = sha(input.content);
  f.db
    .prepare(
      "INSERT INTO plan_versions (id, project_id, version, state, content, content_hash, change_note, drafted_by_kind, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, '', 'human', ?)",
    )
    .run(id, f.projectId, input.version, input.state, input.content, contentHash, NOW);
  return { id, contentHash };
}

const stateOf = (f: Fixture, id: string): string =>
  (f.db.prepare("SELECT state FROM plan_versions WHERE id = ?").get(id) as { state: string }).state;

const decidedAtOf = (f: Fixture, id: string): string | null =>
  (f.db.prepare("SELECT decided_at FROM plan_versions WHERE id = ?").get(id) as { decided_at: string | null }).decided_at;

describe("confirmPlan：草稿 → 当前", () => {
  it("DRAFT 变 CURRENT，原来的 CURRENT 变 SUPERSEDED（同一个事务）", async () => {
    const f = makeFixture();
    const previous = insertPlan(f, { version: 1, state: "CURRENT", content: "# 旧方案" });
    const draft = insertPlan(f, { version: 2, state: "DRAFT", content: "# 新方案" });

    const result = await confirmPlan(f.db, f.queue, draft.id);

    assert.equal(result.plan.state, "CURRENT");
    assert.ok(result.plan.decided_at);
    assert.deepEqual(
      result.superseded.map((p) => p.id),
      [previous.id],
    );
    assert.equal(stateOf(f, previous.id), "SUPERSEDED");
    assert.ok(decidedAtOf(f, previous.id), "被取代的版本也要记 decided_at");
    assert.equal(stateOf(f, draft.id), "CURRENT");
    f.db.close();
  });

  it("不是 DRAFT 就拒绝，一条都不改", async () => {
    const f = makeFixture();
    const current = insertPlan(f, { version: 1, state: "CURRENT", content: "# 当前" });

    await assert.rejects(
      () => confirmPlan(f.db, f.queue, current.id),
      (error: unknown) => error instanceof PlanError && error.code === "plan_not_draft",
    );
    assert.equal(stateOf(f, current.id), "CURRENT");
    f.db.close();
  });

  it("方案不存在返回 plan_not_found", async () => {
    const f = makeFixture();
    await assert.rejects(
      () => confirmPlan(f.db, f.queue, "plan_" + ulid()),
      (error: unknown) => error instanceof PlanError && error.code === "plan_not_found",
    );
    f.db.close();
  });
});

describe("finalizePlan：盖章定稿（校验指纹）", () => {
  it("CURRENT 变 FINAL，记 decided_at", async () => {
    const f = makeFixture();
    const plan = insertPlan(f, { version: 1, state: "CURRENT", content: "# 方案 v1" });

    const finalized = await finalizePlan(f.db, f.queue, { planVersionId: plan.id, expectedContentHash: plan.contentHash });
    assert.equal(finalized.plan.state, "FINAL");
    assert.ok(finalized.plan.decided_at);
    assert.deepEqual(finalized.superseded, []);
    assert.equal(stateOf(f, plan.id), "FINAL");
    f.db.close();
  });

  it("指纹对不上就拒绝，状态不变", async () => {
    const f = makeFixture();
    const plan = insertPlan(f, { version: 1, state: "CURRENT", content: "# 方案 v1" });

    await assert.rejects(
      () => finalizePlan(f.db, f.queue, { planVersionId: plan.id, expectedContentHash: "b".repeat(64) }),
      (error: unknown) => error instanceof PlanError && error.code === "hash_mismatch",
    );
    assert.equal(stateOf(f, plan.id), "CURRENT");
    f.db.close();
  });

  it("不是 CURRENT 不能定稿", async () => {
    const f = makeFixture();
    const draft = insertPlan(f, { version: 1, state: "DRAFT", content: "# 草稿" });
    await assert.rejects(
      () => finalizePlan(f.db, f.queue, { planVersionId: draft.id, expectedContentHash: draft.contentHash }),
      (error: unknown) => error instanceof PlanError && error.code === "plan_not_current",
    );

    const final = insertPlan(f, { version: 2, state: "FINAL", content: "# 已定稿" });
    await assert.rejects(
      () => finalizePlan(f.db, f.queue, { planVersionId: final.id, expectedContentHash: final.contentHash }),
      (error: unknown) => error instanceof PlanError && error.code === "plan_not_current",
    );
    f.db.close();
  });

  it("定稿 → 派生 → 确认 → 再定稿：旧的 FINAL 变成 SUPERSEDED（C-26）", async () => {
    const f = makeFixture();
    const v1 = insertPlan(f, { version: 1, state: "CURRENT", content: "# 方案 v1" });
    const first = await finalizePlan(f.db, f.queue, { planVersionId: v1.id, expectedContentHash: v1.contentHash });
    assert.equal(first.plan.state, "FINAL");

    const derived = (await derivePlan(f.db, f.queue, v1.id)).plan;
    assert.equal(derived.version, 2);
    assert.equal(derived.state, "DRAFT");
    assert.equal(derived.parent_id, v1.id);
    assert.equal(derived.content, "# 方案 v1", "派生版本内容不变");

    const confirmed = await confirmPlan(f.db, f.queue, derived.id);
    assert.equal(confirmed.plan.state, "CURRENT");

    const second = await finalizePlan(f.db, f.queue, {
      planVersionId: derived.id,
      expectedContentHash: derived.content_hash,
    });
    assert.equal(second.plan.state, "FINAL");
    assert.deepEqual(
      second.superseded.map((plan) => plan.id),
      [v1.id],
      "旧的 FINAL 在同一事务里被取代",
    );
    const old = f.db.prepare("SELECT state, superseded_reason FROM plan_versions WHERE id = ?").get(v1.id) as {
      state: string;
      superseded_reason: string | null;
    };
    assert.equal(old.state, "SUPERSEDED");
    assert.ok(old.superseded_reason);
    assert.equal(stateOf(f, derived.id), "FINAL");
    f.db.close();
  });
});

describe("editPlan / derivePlan", () => {
  it("plan.edit 基于 parentId 生成新 DRAFT，并作废其它草稿", async () => {
    const f = makeFixture();
    const parent = insertPlan(f, { version: 1, state: "CURRENT", content: "# 当前" });
    const oldDraft = insertPlan(f, { version: 2, state: "DRAFT", content: "# 旧草稿" });

    const result = await editPlan(f.db, f.queue, { parentId: parent.id, content: "# 改过的方案", changeNote: "+1 条" });
    assert.equal(result.plan.version, 3);
    assert.equal(result.plan.state, "DRAFT");
    assert.equal(result.plan.parent_id, parent.id);
    assert.equal(result.plan.based_on_round_id, null, "沿用 parent 的 based_on_round_id");
    assert.equal(result.plan.drafted_by_kind, "human");
    assert.deepEqual(result.superseded.map((plan) => plan.id), [oldDraft.id]);
    assert.equal(stateOf(f, oldDraft.id), "SUPERSEDED");
    assert.equal(stateOf(f, parent.id), "CURRENT", "parent 不动");
    f.db.close();
  });

  it("连点 plan.derive 不会叠出多个空版本：旧版本不是最新的就拒绝", async () => {
    const f = makeFixture();
    const v1 = insertPlan(f, { version: 1, state: "FINAL", content: "# 定稿" });
    const v2 = (await derivePlan(f.db, f.queue, v1.id)).plan;

    await assert.rejects(
      () => derivePlan(f.db, f.queue, v1.id),
      (error: unknown) => error instanceof PlanError && error.code === "plan_not_latest",
    );
    assert.equal(stateOf(f, v2.id), "DRAFT", "v2 还是唯一的草稿");
    assert.equal(
      (f.db.prepare("SELECT count(*) AS n FROM plan_versions WHERE project_id = ? AND state = 'DRAFT'").get(f.projectId) as { n: number }).n,
      1,
      "同一议题只能有一个 DRAFT",
    );

    // 定稿 v2 之后，v2 是最新的有效版本，可以从它派生 v3
    await confirmPlan(f.db, f.queue, v2.id);
    await finalizePlan(f.db, f.queue, { planVersionId: v2.id, expectedContentHash: v2.content_hash });
    const v3 = (await derivePlan(f.db, f.queue, v2.id)).plan;
    assert.equal(v3.version, 3);
    assert.equal(v3.parent_id, v2.id);
    f.db.close();
  });

  it("plan.derive 只能从 FINAL 派生", async () => {
    const f = makeFixture();
    const current = insertPlan(f, { version: 1, state: "CURRENT", content: "# 当前" });
    await assert.rejects(
      () => derivePlan(f.db, f.queue, current.id),
      (error: unknown) => error instanceof PlanError && error.code === "plan_not_final",
    );
    f.db.close();
  });
});

describe("createPlan：用户写第一版（C-28）", () => {
  it("议题还没有版本时生成 v1 DRAFT（human），再次调用被拒", async () => {
    const f = makeFixture();
    const plan = await createPlan(f.db, f.queue, {
      projectId: f.projectId,
      content: "# 你写的第一版",
      changeNote: "你写的第一版",
    });

    assert.equal(plan.version, 1);
    assert.equal(plan.state, "DRAFT");
    assert.equal(plan.parent_id, null);
    assert.equal(plan.based_on_round_id, null);
    assert.equal(plan.drafted_by_kind, "human");
    assert.equal(plan.content_hash, sha("# 你写的第一版"));
    assert.equal(plan.change_note, "你写的第一版");

    await assert.rejects(
      () => createPlan(f.db, f.queue, { projectId: f.projectId, content: "第二版", changeNote: "" }),
      (error: unknown) => error instanceof PlanError && error.code === "plan_exists",
    );
    assert.equal(
      (f.db.prepare("SELECT count(*) AS n FROM plan_versions WHERE project_id = ?").get(f.projectId) as { n: number }).n,
      1,
    );
    f.db.close();
  });
});
