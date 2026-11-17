import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  ControlCommand, ControlQuery, NodeHealth, ProjectResearchCapability, ProjectResearchPlan,
  ProjectResearchPreview, ProjectResearchQuery, ProjectResearchRemoteEvent, ProjectResearchSource,
  ProjectResearchTarget, ProjectResearchStartRunRequest, ProjectSourcePreview, ProjectSourcesCurrent, RemoteEvent, StartRunRequest,
  StructuredRemoteEvent, PROJECT_RESEARCH_COMMANDS, PROJECT_RESEARCH_MAX_BODY_BYTES,
  PROJECT_RESEARCH_QUERIES, canRunProjectResearch, projectResearchApprovalContent,
} from "../src/index";

const id = "00000000000000000000000001", other = "00000000000000000000000002";
const ts = "2026-11-17T00:00:00.000Z", query = "资料来源 🧪";
const hash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const target = { nodeId: "research-node", baseUrl: "http://127.0.0.1:7421", profileId: "deepseek-search" };
const plan = { version: 1, projectId: `proj_${id}`, snapshotId: `snap_${id}`, query, target } as const;
const snapshot = {
  id: plan.snapshotId, projectId: plan.projectId, content: query, contentHash: hash(query),
  nonce: "0123456789abcdef", contributionIds: [], taskInstruction: "搜索资料", reviewerAgent: target.profileId,
  adapterVersion: "project-research-v1", tokenEstimate: 4, synthesisVersion: null, branch: null,
  commitSha: null, createdAt: ts,
};
const approval = {
  id: `apr_${id}`, projectId: plan.projectId, snapshotId: plan.snapshotId, state: "READY_FOR_REVIEW",
  decidedVia: null, reason: null, createdAt: ts, decidedAt: null,
};
const preview = { plan, researchHash: hash(projectResearchApprovalContent(plan)), snapshot, approval };
const health = {
  protocol: 1, nodeId: target.nodeId, profiles: [target.profileId], activeRuns: 0, maxConcurrentRuns: 1,
  leaseMs: 5000, heartbeatMs: 1000,
};
const start = {
  protocol: 1, runId: `run_${id}`, profileId: target.profileId,
  snapshot: { id: plan.snapshotId, content: query, contentHash: hash(query) },
  limits: { idleTimeoutMs: 30_000, totalTimeoutMs: 60_000 },
};
const optIn = { ...start, structuredResults: { version: 1 }, projectResearch: { version: 1 } };
const capability = { version: 1, profiles: [target.profileId] };
const fullHealth = { ...health, capabilities: { structuredResults: capability, projectResearch: capability } };
const text = "完整网页正文\r\n中文、emoji 🧪\n";
const reference = {
  source: { kind: "web", url: "https://example.com/paper" }, version: hash(text), contentHash: hash(text),
  retrievedAt: ts, status: "readable",
};
const complete = { type: "message_complete", seq: 1, ts, text, source: reference };
const owner = { kind: "snapshot", id: plan.snapshotId };

test("research contracts stay inactive in the existing control command/query registries", () => {
  const prepare = { type: "research.prepare", projectId: plan.projectId, nodeId: target.nodeId, profileId: target.profileId, query };
  assert.deepEqual(PROJECT_RESEARCH_COMMANDS["research.prepare"].request.parse(prepare), prepare);
  assert.equal(ControlCommand.safeParse(prepare).success, false);
  const current = { type: "sources.current", projectId: plan.projectId, owner };
  assert.deepEqual(PROJECT_RESEARCH_QUERIES["sources.current"].request.parse(current), current);
  assert.equal(ControlQuery.safeParse(current).success, false);
  assert.equal(PROJECT_RESEARCH_COMMANDS["research.prepare"].scope, "author");
  assert.equal(PROJECT_RESEARCH_COMMANDS["research.approve"].scope, "approve");
  for (const entry of Object.values(PROJECT_RESEARCH_QUERIES)) assert.equal(entry.scope, "read");
  for (const extra of [{ baseUrl: "http://evil.invalid" }, { sourceRefs: [reference] }, { token: "secret" }, { conversationId: `conv_${id}` }, { attachments: [] }]) {
    assert.equal(PROJECT_RESEARCH_COMMANDS["research.prepare"].request.safeParse({ ...prepare, ...extra }).success, false);
  }
});

test("query limits count Unicode code points and reject implicit normalization / broken surrogates", () => {
  for (const value of [query, "🧪".repeat(128), "中".repeat(128)]) assert.equal(ProjectResearchQuery.parse(value), value);
  for (const value of ["", " ", " before", "after\n", "🧪".repeat(129), "中".repeat(129), "a\ud800b", "\udc00"]) {
    assert.equal(ProjectResearchQuery.safeParse(value).success, false);
  }
});

test("approval fingerprints bind every target and query field without changing the content hash", () => {
  const exact = `["room.project-research",1,"proj_${id}","snap_${id}","资料来源 🧪","research-node","http://127.0.0.1:7421","deepseek-search"]`;
  assert.equal(projectResearchApprovalContent(plan), exact);
  assert.deepEqual(ProjectResearchPreview.parse(preview), preview);
  for (const changed of [
    { ...plan, projectId: `proj_${other}` }, { ...plan, snapshotId: `snap_${other}` }, { ...plan, query: "另一个问题" },
    ...[{ nodeId: "other-node" }, { baseUrl: "http://127.0.0.1:7420" }, { profileId: "other-search" }].map((patch) => ({ ...plan, target: { ...target, ...patch } })),
  ]) assert.notEqual(hash(projectResearchApprovalContent(changed)), preview.researchHash);
  assert.equal(snapshot.contentHash, hash(query));
  assert.notEqual(preview.researchHash, snapshot.contentHash);
  for (const baseUrl of ["invalid", "http://user:password@localhost", "http://LOCALHOST:80/", "http://localhost/", "https://localhost/path", "file:///secret"]) {
    assert.equal(ProjectResearchTarget.safeParse({ ...target, baseUrl }).success, false);
  }
  assert.equal(ProjectResearchPlan.safeParse({ ...plan, version: 2 }).success, false);
  assert.equal(ProjectResearchPlan.safeParse({ ...plan, target: { ...target, token: "hidden" } }).success, false);
});

test("research previews reject mixed projects, snapshots and hidden prompt inputs", () => {
  for (const patch of [
    { projectId: `proj_${other}` }, { id: `snap_${other}` }, { content: "altered" }, { reviewerAgent: "other" },
    { contributionIds: [`c_${id}`] }, { sourceRefs: [reference] }, { branch: "main" },
    { commitSha: "a".repeat(40) }, { projectNoteId: null }, { synthesisVersion: 1 },
  ]) assert.equal(ProjectResearchPreview.safeParse({ ...preview, snapshot: { ...snapshot, ...patch } }).success, false);
  assert.equal(ProjectResearchPreview.safeParse({ ...preview, approval: { ...approval, snapshotId: `snap_${other}` } }).success, false);
  const approve = { type: "research.approve", approvalId: approval.id, expectedSnapshotHash: snapshot.contentHash, expectedResearchHash: preview.researchHash };
  assert.deepEqual(PROJECT_RESEARCH_COMMANDS["research.approve"].request.parse(approve), approve);
  const { expectedResearchHash: _, ...withoutTargetHash } = approve;
  assert.equal(PROJECT_RESEARCH_COMMANDS["research.approve"].request.safeParse(withoutTargetHash).success, false);
});

test("structured display alone cannot negotiate project research", () => {
  const capable = NodeHealth.parse(fullHealth), optedIn = ProjectResearchStartRunRequest.parse(optIn);
  assert.equal(canRunProjectResearch(capable, optedIn), true);
  assert.equal(canRunProjectResearch(NodeHealth.parse(health), optedIn), false);
  assert.equal(canRunProjectResearch(NodeHealth.parse({ ...health, capabilities: { structuredResults: capability } }), optedIn), false);
  assert.equal(canRunProjectResearch(capable, StartRunRequest.parse({ ...start, structuredResults: { version: 1 } })), false);
  assert.equal(canRunProjectResearch(capable, ProjectResearchStartRunRequest.parse({ ...optIn, profileId: "other-search" })), false);
  for (const profiles of [[], [target.profileId, target.profileId], ["unknown"]]) {
    assert.equal(NodeHealth.safeParse({ ...fullHealth, capabilities: { ...fullHealth.capabilities, projectResearch: { version: 1, profiles } } }).success, false);
  }
  assert.equal(NodeHealth.safeParse({ ...health, capabilities: { projectResearch: capability } }).success, false);
  for (const value of [{ version: 2, profiles: [target.profileId] }, { ...capability, allowUpload: true }]) {
    assert.equal(ProjectResearchCapability.safeParse(value).success, false);
  }
});

test("research starts reject chat, world, image, model selection and implicit downgrade", () => {
  assert.equal(StartRunRequest.safeParse(optIn).success, false, "existing HTTP handler must not accept the unimplemented feature");
  assert.equal(ProjectResearchStartRunRequest.safeParse(start).success, false, "research parser cannot infer opt-in");
  for (const patch of [
    { structuredResults: undefined }, { chat: { memory: null } }, { kind: "image" },
    { model: { id: "deepseek-chat", effort: null } }, { attachments: [] }, { imageSlot: "slot" },
    { expectedWorldProfile: {} }, { snapshot: { ...start.snapshot, commitSha: "a".repeat(40) } },
    { snapshot: { ...start.snapshot, content: "x".repeat(129) } }, { projectResearch: { version: 2 } },
    { projectResearch: { version: 1, upload: true } },
  ]) assert.equal(ProjectResearchStartRunRequest.safeParse({ ...optIn, ...patch }).success, false);
});

test("research completion carries the original once with mandatory metadata or explicit no-original", () => {
  assert.deepEqual(ProjectResearchRemoteEvent.parse(complete), complete);
  assert.deepEqual(ProjectResearchRemoteEvent.parse({ ...complete, source: null, text: "没有可取回的结果" }), { ...complete, source: null, text: "没有可取回的结果" });
  const { source: _, ...legacyComplete } = complete;
  assert.equal(ProjectResearchRemoteEvent.safeParse(legacyComplete).success, false);
  assert.deepEqual(RemoteEvent.parse(legacyComplete), legacyComplete);
  assert.deepEqual(StructuredRemoteEvent.parse(legacyComplete), legacyComplete);
  for (const source of [
    { ...reference, status: "missing" }, { ...reference, contentHash: null }, { ...reference, version: "etag" },
    { ...reference, source: { kind: "message", id: `msg_${id}` } }, { ...reference, token: "secret" },
  ]) assert.equal(ProjectResearchSource.safeParse(source).success, false);
  assert.equal(ProjectResearchRemoteEvent.safeParse({ ...complete, rawResponse: {} }).success, false);
  assert.equal(ProjectResearchRemoteEvent.safeParse({ type: "text_delta", seq: 1, ts, text: "not yet committed" }).success, false);
});

test("original UTF-8 byte limits do not silently truncate text", () => {
  const large = "🧪".repeat(PROJECT_RESEARCH_MAX_BODY_BYTES / 4);
  const full = { ...complete, text: large, source: { ...reference, version: hash(large), contentHash: hash(large) } };
  assert.equal(ProjectResearchRemoteEvent.parse(full).type, "message_complete");
  for (const value of [large + "x", "a".repeat(PROJECT_RESEARCH_MAX_BODY_BYTES + 1), "\ud800", " \n", ""]) {
    assert.equal(ProjectResearchRemoteEvent.safeParse({ ...complete, text: value }).success, false);
  }
});

test("research wire admits lifecycle and display records without adding permission or image execution", () => {
  const events = [
    { type: "started", seq: 0, ts },
    { type: "output", seq: 1, ts, stream: "stderr", data: "diagnostic" },
    { type: "heartbeat", ts, lastSeq: 1 },
    { type: "result_display", seq: 2, ts, result: { version: 1, block: { kind: "tool_step", stepId: "fetch", tool: "fetch", status: "failed", summary: "URL rejected" } } },
    { type: "terminal", seq: 3, ts, result: { outcome: "completed", exitCode: 0 } },
    { type: "terminal", seq: 3, ts, result: { outcome: "cancelled", reason: "user cancelled" } },
  ];
  for (const event of events) assert.deepEqual(ProjectResearchRemoteEvent.parse(event), event);
  for (const type of ["permission_request", "prompt_final", "execute"]) {
    assert.equal(ProjectResearchRemoteEvent.safeParse({ type, seq: 1, ts }).success, false);
  }
  const imageTerminal = { type: "terminal", seq: 3, ts, result: { outcome: "completed", exitCode: 0, artifact: { sha256: "a".repeat(64), mime: "image/png", bytes: 10 } } };
  assert.equal(RemoteEvent.safeParse(imageTerminal).success, true);
  assert.equal(ProjectResearchRemoteEvent.safeParse(imageTerminal).success, false);
});

test("approval/results correlate existing entities and never publish readable citations without an original", () => {
  const run = {
    id: `run_${id}`, projectId: plan.projectId, approvalId: approval.id, snapshotId: plan.snapshotId,
    adapterId: "project-research-v1", state: "QUEUED", substate: null, failureReason: null,
    createdAt: ts, startedAt: null, finishedAt: null,
  };
  const approved = { ...approval, state: "APPROVED", decidedVia: "desktop", decidedAt: ts };
  assert.deepEqual(PROJECT_RESEARCH_COMMANDS["research.approve"].response.parse({ approval: approved, run }), { approval: approved, run });
  assert.equal(PROJECT_RESEARCH_COMMANDS["research.approve"].response.safeParse({ approval, run }).success, false);
  for (const patch of [{ projectId: `proj_${other}` }, { snapshotId: `snap_${other}` }, { approvalId: `apr_${other}` }]) {
    assert.equal(PROJECT_RESEARCH_COMMANDS["research.approve"].response.safeParse({ approval: approved, run: { ...run, ...patch } }).success, false);
  }
  const result = { run, plan, originalMessageId: null, blocks: [] };
  const schema = PROJECT_RESEARCH_QUERIES["research.result"].response;
  assert.deepEqual(schema.parse(result), result);
  const blocks = [{ kind: "citation", citationId: "c1", source: reference }];
  assert.equal(schema.safeParse({ ...result, blocks }).success, false);
  const failed = { ...result, run: { ...run, state: "FAILED", failureReason: "postprocess", finishedAt: ts }, originalMessageId: `msg_${id}`, blocks };
  assert.deepEqual(schema.parse(failed), failed, "a committed original must not promote a failed Run to success");
  assert.equal(schema.safeParse({ ...result, plan: { ...plan, projectId: `proj_${other}` } }).success, false);
});

test("source queries accept owned saved IDs only, never arbitrary URLs, chat IDs or provider payloads", () => {
  const request = { type: "sources.preview", projectId: plan.projectId, owner, index: 0 };
  assert.deepEqual(PROJECT_RESEARCH_QUERIES["sources.preview"].request.parse(request), request);
  for (const patch of [
    { owner: { kind: "chat_message", id: `cmsg_${id}` } }, { owner: { kind: "web", url: reference.source.url } },
    { owner: { kind: "message", id: `snap_${id}` } }, { index: -1 }, { index: 100 },
    { url: reference.source.url }, { reference }, { token: "secret" },
  ]) assert.equal(PROJECT_RESEARCH_QUERIES["sources.preview"].request.safeParse({ ...request, ...patch }).success, false);
});

test("current status stays separate from historical references and preserves ordered indexes", () => {
  const result = { projectId: plan.projectId, owner, checkedAt: ts, sources: [{ index: 0, reference, currentStatus: "revoked" }] };
  assert.deepEqual(ProjectSourcesCurrent.parse(result), result);
  assert.equal(result.sources[0]!.reference.status, "readable");
  for (const sources of [
    [{ index: 1, reference, currentStatus: "readable" }],
    [result.sources[0], result.sources[0]],
    [{ index: 0, reference: { ...reference, status: "missing" }, currentStatus: "readable" }],
  ]) assert.equal(ProjectSourcesCurrent.safeParse({ ...result, sources }).success, false);
  assert.deepEqual(ProjectSourcesCurrent.parse({ ...result, sources: [] }).sources, []);
});

test("missing or revoked previews cannot contain stale original text", () => {
  const result = { projectId: plan.projectId, owner, index: 0, reference, checkedAt: ts };
  assert.equal(ProjectSourcePreview.parse({ ...result, status: "readable", content: text }).status, "readable");
  for (const status of ["missing", "revoked"]) {
    assert.deepEqual(ProjectSourcePreview.parse({ ...result, status, content: null }), { ...result, status, content: null });
    assert.equal(ProjectSourcePreview.safeParse({ ...result, status, content: text }).success, false);
  }
  assert.equal(ProjectSourcePreview.safeParse({ ...result, status: "readable", content: null }).success, false);
  assert.equal(ProjectSourcePreview.safeParse({ ...result, reference: { ...reference, status: "missing" }, status: "readable", content: text }).success, false);
});

test("frozen legacy health/start fixtures acquire no research defaults or new serialization", () => {
  for (const [name, schema] of [["legacy-health.json", NodeHealth], ["legacy-start.json", StartRunRequest]] as const) {
    const bytes = readFileSync(new URL(`./fixtures/structured-results/${name}`, import.meta.url));
    assert.deepEqual(Buffer.from(JSON.stringify(schema.parse(JSON.parse(bytes.toString("utf8")))) + "\n"), bytes);
  }
});
