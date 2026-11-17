import assert from "node:assert/strict";
import { it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProjectResearchPreview, ProjectSourcePreview, QueryResponse } from "@room/schemas";
import { createResearchActions } from "../lib/research-actions";
import { ControlFailure, type RoomClient } from "../lib/client";
import { initialState, type AppState } from "../lib/state";
import { createStore } from "../lib/store";
import { ResearchApprovalView } from "../ui/ProjectResearch";

const id = "01ARZ3NDEKTSV4RRFFQ69G5FAV", projectId = "proj_" + id, snapshotId = "snap_" + id, approvalId = "apr_" + id;
const owner = { kind: "snapshot" as const, id: snapshotId }, ts = "2026-11-17T00:00:00.000Z";
const preview: ProjectResearchPreview = {
  plan: { version: 1, projectId, snapshotId, query: "<script>查询🧪</script>", target: { nodeId: "research", baseUrl: "https://node.example", profileId: "search-fetch" } }, researchHash: "1".repeat(64),
  snapshot: { id: snapshotId, projectId, content: "<script>查询🧪</script>", contentHash: "2".repeat(64), nonce: "0123456789abcdef", contributionIds: [], taskInstruction: "query", reviewerAgent: "search-fetch", adapterVersion: "project-research-v1", tokenEstimate: 2, synthesisVersion: null, branch: null, commitSha: null, createdAt: ts },
  approval: { id: approvalId, projectId, snapshotId, state: "READY_FOR_REVIEW", decidedVia: null, decidedAt: null, reason: null, createdAt: ts },
};
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }

it("research approval shows exact query, captured target, call ceiling and unknown cost as inert text", () => {
  const html = renderToStaticMarkup(createElement(ResearchApprovalView, { preview, busy: false, stale: true, onApprove: () => {}, onReject: () => {} }));
  assert.match(html, /&lt;script&gt;查询🧪&lt;\/script&gt;/);
  assert.match(html, /https:\/\/node.example/);
  assert.match(html, /search-fetch/);
  assert.match(html, /1 次搜索 \+ 最多 1 次网页读取/);
  assert.match(html, /未知，以服务商实际账单为准/);
  assert.match(html, /检索预览已失效/);
  assert.doesNotMatch(html, /<script|<iframe|<img|href=/);
  assert.match(html, /disabled=""[^>]*>批准并检索/);
});

it("prepare sends only query and configured IDs; stale approval stays blocked until a new preview", async () => {
  const store = createStore<AppState>({ ...initialState, currentProjectId: projectId });
  const requests: unknown[] = [], errors: unknown[] = [];
  let approveCalls = 0;
  const client = { command: async (request: { type: string }) => {
    requests.push(request);
    if (request.type === "research.prepare") return preview;
    approveCalls++;
    throw new ControlFailure("stale_snapshot", "target changed");
  } } as unknown as RoomClient;
  const actions = createResearchActions(store, client, (error) => errors.push(error), () => 1);
  const input = { projectId, nodeId: "research", profileId: "search-fetch", query: preview.plan.query };
  assert.equal(await actions.prepare(input), preview);
  assert.deepEqual(requests, [{ type: "research.prepare", ...input }]);
  assert.equal(store.get().snapshots[snapshotId], preview.snapshot);
  await actions.approve(preview);
  await actions.approve(preview);
  assert.equal(approveCalls, 1);
  assert.equal(errors.length, 1);
  assert.deepEqual(requests[1], { type: "research.approve", approvalId, expectedSnapshotHash: preview.snapshot.contentHash, expectedResearchHash: preview.researchHash });
  await actions.approve({ ...preview, approval: { ...preview.approval, id: approvalId + "new" } });
  assert.equal(approveCalls, 2);
});

for (const changed of ["project-away-and-back", "source-retracted", "workspace-switch"] as const) {
  it(`drops a late readable preview after ${changed}`, async () => {
    const store = createStore<AppState>({ ...initialState, currentProjectId: projectId });
    const waiting = deferred<ProjectSourcePreview>(), calls: unknown[] = [];
    let epoch = 1;
    const client = { query: async (request: unknown) => { calls.push(request); return waiting.promise; } } as unknown as RoomClient;
    const actions = createResearchActions(store, client, () => assert.fail("stale request must not show an error in the new view"), () => epoch);
    const pending = actions.previewSource(projectId, owner, 0);
    if (changed === "source-retracted") store.set((s) => ({ ...s, sourceRevision: s.sourceRevision + 1 }));
    else { epoch++; store.set((s) => ({ ...s, currentProjectId: changed === "workspace-switch" ? null : projectId })); }
    waiting.resolve({ projectId, owner, index: 0, reference: { source: { kind: "web", url: "https://example.com" }, version: "v1", contentHash: "a".repeat(64), retrievedAt: ts, status: "readable" }, checkedAt: ts, status: "readable", content: "must not appear after switching" });
    assert.equal(await pending, undefined);
    assert.deepEqual(calls, [{ type: "sources.preview", projectId, owner, index: 0 }]);
  });
}

it("concurrent clicks send only one research approval while it is pending", async () => {
  const store = createStore<AppState>({ ...initialState, currentProjectId: projectId });
  const waiting = deferred<unknown>();
  let calls = 0;
  const client = { command: async () => { calls++; return waiting.promise; } } as unknown as RoomClient;
  const actions = createResearchActions(store, client, () => {}, () => 1);
  const first = actions.approve(preview), second = actions.approve(preview);
  assert.equal(await second, undefined);
  assert.equal(calls, 1);
  const run: QueryResponse<"research.result">["run"] = { id: "run_" + id, projectId, snapshotId, approvalId, adapterId: "remote:search-fetch", state: "QUEUED", substate: null, failureReason: null, createdAt: ts, startedAt: null, finishedAt: null };
  waiting.resolve({ approval: { ...preview.approval, state: "APPROVED" }, run });
  await first;
  assert.equal(store.get().runs.length, 1);
});
