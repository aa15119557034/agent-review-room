import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { confirmPlan, finalizePlan, openDatabase, PlanError, ulid, WriteQueue } from "../src/index";
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
    assert.equal(finalized.state, "FINAL");
    assert.ok(finalized.decided_at);
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
});
