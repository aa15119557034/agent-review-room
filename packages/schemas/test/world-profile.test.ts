import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CancelRunResponse, NodeHealth, RemoteErrorResponse, StartRunRequest,
  WorldProfileCapability, WorldProfileExpectation, WORLD_PROFILE_RECIPE_DEEPSEEK_HTTP_V1,
  attachmentImageBlock, attachmentImageSlotMarker, attachmentManifestBlock,
} from "../src/index";

const id = "00000000000000000000000001";
const model = { id: "deepseek-v4-pro", displayName: "DeepSeek", efforts: [{ id: "high", displayName: "高", note: null }], defaultEffort: "high" };
const chosen = { model: model.id, effort: "high" };
const mapping = {
  profileId: "deepseek-world", sourceChatProfileId: "deepseek-chat",
  recipeVersion: WORLD_PROFILE_RECIPE_DEEPSEEK_HTTP_V1, sourceDefaultModel: chosen,
};
const expectation = { sourceChatProfileId: mapping.sourceChatProfileId, recipeVersion: mapping.recipeVersion };
const legacyHealth = {
  protocol: 1, nodeId: "node-a", profiles: [mapping.sourceChatProfileId, mapping.profileId],
  activeRuns: 0, maxConcurrentRuns: 1, leaseMs: 5000, heartbeatMs: 1000,
};
const health = {
  ...legacyHealth,
  profileModels: legacyHealth.profiles.map((profileId) => ({ profileId, models: [model] })),
  capabilities: { runFence: { version: 1, ledgerId: `rled_${id}` }, worldProfiles: [mapping] },
};
const legacyStart = {
  protocol: 1, runId: `run_${id}`, profileId: mapping.profileId,
  snapshot: { id: `snap_${id}`, content: "fixture", contentHash: "a".repeat(64) },
  limits: { idleTimeoutMs: 30_000, totalTimeoutMs: 60_000 },
};
const start = { ...legacyStart, model: chosen, expectedLedgerId: `rled_${id}`, expectedWorldProfile: expectation };
const withMappings = (worldProfiles: unknown[]) => ({ ...health, capabilities: { ...health.capabilities, worldProfiles } });

test("legacy health and requests keep their compatibility without world fields", () => {
  const old = NodeHealth.parse({ ...legacyHealth, extra: true, capabilities: { futureCapability: true, quota: true } });
  assert.deepEqual(old.capabilities, { quota: true });
  assert.equal(NodeHealth.parse(legacyHealth).capabilities?.worldProfiles, undefined);
  assert.deepEqual(StartRunRequest.parse(legacyStart), legacyStart);
  assert.ok(StartRunRequest.safeParse({ ...legacyStart, chat: { memory: null } }).success);
  assert.ok(StartRunRequest.safeParse({ ...legacyStart, snapshot: { ...legacyStart.snapshot, commitSha: "b".repeat(40) } }).success);
  assert.ok(StartRunRequest.safeParse({ ...legacyStart, kind: "image" }).success);
  // Existing unrelated catalog extension handling is not tightened by this addition.
  assert.ok(NodeHealth.safeParse({ ...legacyHealth, capabilities: { imageProfiles: ["future-profile"] } }).success);
});

test("world mappings declare verified source defaults without claiming schema verifies execution", () => {
  assert.deepEqual(NodeHealth.parse(health).capabilities?.worldProfiles, [mapping]);
  assert.ok(NodeHealth.safeParse(withMappings([{ ...mapping, sourceDefaultModel: null }])).success);
  // A fixed source may have no selectable catalog; its actual default is a node assertion.
  assert.ok(NodeHealth.safeParse({ ...health, profileModels: [health.profileModels[1]] }).success);
  assert.ok(NodeHealth.safeParse({ ...health, profileModels: [{ profileId: mapping.sourceChatProfileId, models: [] }, health.profileModels[1]] }).success);
  // Future recipe identifiers parse for ordinary clients; only an implemented recipe may be admitted.
  assert.ok(NodeHealth.safeParse(withMappings([{ ...mapping, recipeVersion: "future-v2" }])).success);
});

test("world mappings require the declared profiles, a target model catalog and fence capability", () => {
  for (const value of [
    { ...health, capabilities: { worldProfiles: [mapping] } },
    { ...health, profiles: [mapping.profileId] },
    { ...health, profiles: [mapping.sourceChatProfileId] },
    { ...health, profileModels: undefined },
    { ...health, profileModels: [{ profileId: mapping.profileId, models: [] }] },
    { ...health, memoryProfiles: [mapping.profileId] },
    { ...health, capabilities: { ...health.capabilities, imageProfiles: [mapping.profileId] } },
  ]) assert.equal(NodeHealth.safeParse(value).success, false);
  assert.ok(NodeHealth.safeParse({ ...health, memoryProfiles: [mapping.sourceChatProfileId] }).success);
});

test("duplicate sources, duplicate targets, self mappings and chains are rejected", () => {
  for (const mappings of [
    [mapping, mapping],
    [mapping, { ...mapping, profileId: "other-world" }],
    [mapping, { ...mapping, sourceChatProfileId: "other-chat" }],
    [{ ...mapping, sourceChatProfileId: mapping.profileId }],
    [mapping, { ...mapping, profileId: "other-world", sourceChatProfileId: mapping.profileId }],
    [mapping, { ...mapping, profileId: mapping.sourceChatProfileId, sourceChatProfileId: mapping.profileId }],
  ]) {
    const profiles = [...new Set(mappings.flatMap((m) => [m.profileId, m.sourceChatProfileId]))];
    const value = { ...withMappings(mappings), profiles, profileModels: profiles.map((profileId) => ({ profileId, models: [model] })) };
    assert.equal(NodeHealth.safeParse(value).success, false);
  }
});

test("source defaults must agree with model and effort catalogs, including null effort rules", () => {
  for (const sourceDefaultModel of [
    { model: "other-model", effort: "high" },
    { model: model.id, effort: "low" },
    { model: model.id, effort: null },
  ]) assert.equal(NodeHealth.safeParse(withMappings([{ ...mapping, sourceDefaultModel }])).success, false);
  const sourceModel = { ...model, efforts: [{ id: "low", displayName: "低", note: null }], defaultEffort: "low" };
  assert.equal(NodeHealth.safeParse({ ...health, profileModels: [{ profileId: mapping.sourceChatProfileId, models: [sourceModel] }, health.profileModels[1]] }).success, false);
  const noEffort = { ...model, efforts: [], defaultEffort: null };
  const fixed = { ...withMappings([{ ...mapping, sourceDefaultModel: { model: model.id, effort: null } }]), profileModels: legacyHealth.profiles.map((profileId) => ({ profileId, models: [noEffort] })) };
  assert.ok(NodeHealth.safeParse(fixed).success);
  assert.equal(NodeHealth.safeParse({ ...fixed, capabilities: health.capabilities }).success, false);
});

test("new capability and expectation shapes cannot carry executable configuration", () => {
  assert.deepEqual(WorldProfileExpectation.parse(expectation), expectation);
  for (const value of [
    { ...mapping, sourceDefaultModel: undefined }, { ...mapping, command: "node.exe" },
    { ...mapping, env: {} }, { ...mapping, recipeVersion: "../recipe" },
  ]) assert.equal(WorldProfileCapability.safeParse(value).success, false);
  for (const value of [{ ...expectation, args: [] }, { ...expectation, recipeVersion: "" }, { ...expectation, sourceChatProfileId: undefined }]) {
    assert.equal(WorldProfileExpectation.safeParse(value).success, false);
  }
});

test("world requests carry explicit model, ledger and immutable recipe expectations", () => {
  assert.deepEqual(StartRunRequest.parse(start), start);
  assert.ok(StartRunRequest.safeParse({ ...start, kind: "text" }).success);
  for (const value of [
    { ...start, expectedLedgerId: undefined }, { ...start, model: undefined },
    { ...start, profileId: mapping.sourceChatProfileId },
    { ...start, chat: { memory: null } },
    { ...start, snapshot: { ...start.snapshot, commitSha: "b".repeat(40) } },
    { ...start, kind: "image" },
  ]) assert.equal(StartRunRequest.safeParse(value).success, false);
});

test("an otherwise valid image request is rejected when bound to a world profile", () => {
  const nonce = "0123456789abcdef";
  const attachments = [{ index: 1, mime: "image/png" as const, bytes: 3, sha256: "b".repeat(64), data: "AAAA" }];
  const image = {
    ...legacyStart, attachments, imageSlot: attachmentImageSlotMarker(nonce),
    snapshot: { ...legacyStart.snapshot, content: `${attachmentManifestBlock(attachments)}${attachmentImageBlock(nonce, 1)}\nfixture` },
  };
  assert.ok(StartRunRequest.safeParse(image).success);
  const parsed = StartRunRequest.safeParse({ ...start, ...image });
  assert.equal(parsed.success, false);
  if (!parsed.success) assert.ok(parsed.error.issues.some((issue) => issue.path[0] === "attachments" && issue.message.includes("世界")));
});

test("world mapping mismatch and cancellation acceptance do not become stop proofs", () => {
  const response = { error: "world_profile_mismatch", message: "isolated mapping changed" };
  assert.deepEqual(RemoteErrorResponse.parse(response), response);
  assert.deepEqual(CancelRunResponse.parse({ ok: true }), { ok: true });
  for (const value of [{}, { ok: false }, { ok: "true" }]) assert.equal(CancelRunResponse.safeParse(value).success, false);
});
