import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ResultDisplayBlock, RoomBridge } from "@room/schemas";
import { SourceReferenceCard, SourceReferences, ResultDisplayView } from "../ui/SourceReferences";
import { sourceDemoOriginal, sourceDemoReference } from "../mock/source-preview";
import { createActions } from "../lib/actions";
import { createClient } from "../lib/client";
import { initialState } from "../lib/state";
import { createStore } from "../lib/store";
import { createMockBridge } from "../mock/mock-backend";

it("citation titles, identities and all display text remain inert text without links or embedded resources", () => {
  const attack = '<img src="https://example.com/track" onerror="alert(1)"><script>bad()</script>[link](javascript:bad())';
  const html = renderToStaticMarkup(createElement(ResultDisplayView, { blocks: [
    { kind: "citation", citationId: "x", title: attack, source: sourceDemoReference },
    { kind: "tool_step", stepId: "x", tool: attack.slice(0, 100), status: "completed", summary: attack },
    { kind: "unsupported", originalKind: attack.slice(0, 128), reason: "unknown_display_kind" },
  ] }));
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /<(img|script|a|iframe)\b|<[^>]+\s(?:href|src)=/i);
  assert.match(html, /运行方报告/);
  assert.match(html, /记录时已取回/);
  assert.match(html, /重新检查/);
  assert.match(html, /https:\/\/example.com\/research/);
});

it("missing and revoked references disclose missing original/version instead of fabricating readable content", () => {
  for (const status of ["missing", "revoked"] as const) {
    const html = renderToStaticMarkup(createElement(SourceReferenceCard, { reference: { ...sourceDemoReference, status, contentHash: null, version: null } }));
    assert.match(html, /未知（没有已校验的正文）/);
    assert.match(html, /重新生成预览/);
    assert.doesNotMatch(html, /记录时已取回|<pre/);
  }
  assert.equal(renderToStaticMarkup(createElement(SourceReferences, {})), "", "old messages stay unchanged");
});

it("measured zero and small costs stay distinct from unknown usage", () => {
  const block: ResultDisplayBlock = { kind: "usage", scope: "run", inputTokens: { status: "unknown", reason: "not_reported" }, outputTokens: { status: "measured", value: 0 }, toolCalls: { status: "unknown", reason: "unavailable" }, cost: { status: "measured", amount: 0.0015, currency: "USD" } };
  const html = renderToStaticMarkup(createElement(ResultDisplayView, { blocks: [block] }));
  assert.match(html, /未知（未返回）/);
  assert.match(html, /未知（暂不可用）/);
  assert.match(html, /<dd>0<\/dd>/);
  assert.match(html, /0.0015 USD/);
  assert.equal(createHash("sha256").update(sourceDemoOriginal, "utf8").digest("hex"), sourceDemoReference.contentHash);
});

async function setup(target: "approval.approve" | "batch.approve") {
  const mock = createMockBridge({ reviewerConfigured: true, tickMs: 1 });
  let stale = true, calls = 0;
  const bridge: RoomBridge = { ...mock, command: (async (req: Parameters<RoomBridge["command"]>[0]) => {
    if (req.type === target) {
      calls++;
      if (stale) return { ok: false, error: "stale_snapshot", message: "source revoked after preview" };
    }
    return mock.command(req);
  }) as RoomBridge["command"] };
  const store = createStore(initialState), actions = createActions(store, createClient(bridge));
  await actions.start();
  await actions.createProject("引用验收");
  return { mock, store, actions, calls: () => calls, available: () => { stale = false; } };
}

it("a stale single approval is not retried, stays immutable, and a rebuilt preview can be approved", async () => {
  const h = await setup("approval.approve");
  try {
    const message = await h.actions.addSource("human", "授权原文");
    assert.ok(message);
    await h.actions.createContribution({ sourceMessageId: message.id, contributionType: "risk", title: "引用", selection: { start: 0, end: 4 } });
    const old = await h.actions.createSnapshot();
    assert.ok(old);
    const approval = h.store.get().approvals.find((a) => a.snapshotId === old.id)!;
    assert.equal(await h.actions.approve(approval.id, old.contentHash), undefined);
    assert.deepEqual(h.store.get().staleApprovalIds, [approval.id]);
    assert.equal(h.store.get().runs.length, 0);
    assert.equal(h.store.get().snapshots[old.id]?.contentHash, old.contentHash);
    assert.match(h.store.get().notice?.message ?? "", /重新生成预览/);
    await h.actions.approve(approval.id, old.contentHash);
    assert.equal(h.calls(), 1);
    h.available();
    const fresh = await h.actions.createSnapshot();
    assert.ok(fresh && fresh.id !== old.id);
    const current = h.store.get().approvals.find((a) => a.snapshotId === fresh.id)!;
    assert.ok(await h.actions.approve(current.id, fresh.contentHash));
    assert.equal(h.calls(), 2);
  } finally { h.mock.reset(); }
});

it("a stale batch stays blocked across reopening, and explicit reject/redraft creates a new approvable preview", async () => {
  const h = await setup("batch.approve");
  try {
    h.actions.setComposerText("请查看资料");
    await h.actions.draftRound();
    const old = h.store.get().disc.confirm;
    assert.ok(old);
    await h.actions.approveBatch();
    assert.deepEqual(h.store.get().disc.staleBatchIds, [old.batch.id]);
    assert.equal(h.store.get().runs.length, 0);
    h.actions.closeConfirm();
    await h.actions.openConfirm(old.batch.id);
    await h.actions.approveBatch();
    assert.equal(h.calls(), 1);
    await h.actions.rejectBatch("资料失效，需要重建");
    h.available();
    await h.actions.draftRound();
    assert.notEqual(h.store.get().disc.confirm?.batch.id, old.batch.id);
    assert.ok(h.store.get().disc.confirm);
    await h.actions.approveBatch();
    assert.equal(h.calls(), 2);
    assert.equal(h.store.get().disc.confirm, null);
  } finally { h.mock.reset(); }
});
