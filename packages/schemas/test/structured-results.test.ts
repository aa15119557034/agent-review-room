import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  AgentChatMessage, AgentEvent, ChatSnapshot, Message, NodeHealth, PromptSnapshot, RemoteEvent,
  ResultDisplay, ResultDisplayBlock, SourceIdentity, SourceReference, SourceReferences, SourceUrl,
  StartRunRequest, StartRunResponse, StructuredAgentEvent, StructuredRemoteEvent, StructuredResultCapability, UsageCost, UsageCount,
  canEmitStructuredResults, isTerminalEvent,
} from "../src/index";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/structured-results/${name}`, import.meta.url));
const json = (name: string) => JSON.parse(fixture(name).toString("utf8"));
const lines = (name: string): unknown[] => fixture(name).toString("utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const health = NodeHealth.parse(json("legacy-health.json"));
const start = StartRunRequest.parse(json("legacy-start.json"));
const id = "00000000000000000000000001", ts = "2026-11-16T00:00:00.000Z";
const provider = json("deepseek-search-fetch.json");
const source = SourceReference.parse(provider.cases[0].expectedReference);
const enabled = lines("enabled-events.ndjson").map((event) => StructuredRemoteEvent.parse(event));

test("F34: frozen pre-C11 request, health, response and NDJSON remain byte-for-byte identical", () => {
  const provenance = json("provenance.json");
  assert.equal(provenance.roomCommit, "77e31174b14036d94988e33e0809c0447efa182d");
  assert.equal(provenance.kind, "synthetic");
  for (const [name, expected] of Object.entries(provenance.hashes)) assert.equal(hash(fixture(name)), expected, name);
  for (const [name, schema] of [["legacy-health.json", NodeHealth], ["legacy-start.json", StartRunRequest], ["legacy-accepted.json", StartRunResponse]] as const) {
    assert.deepEqual(Buffer.from(JSON.stringify(schema.parse(json(name))) + "\n"), fixture(name), name);
  }
  const reencoded = lines("legacy-events.ndjson").map((event) => JSON.stringify(RemoteEvent.parse(event))).join("\n") + "\n";
  assert.deepEqual(Buffer.from(reencoded), fixture("legacy-events.ndjson"));
  assert.ok(!Object.hasOwn(start, "structuredResults"));
  assert.equal(hash(start.snapshot.content), start.snapshot.contentHash);
});

test("F34: capability and per-request opt-in are both required, including the selected profile", () => {
  const capable = NodeHealth.parse({ ...health, capabilities: { structuredResults: { version: 1, profiles: health.profiles } } });
  const optedIn = StartRunRequest.parse({ ...start, structuredResults: { version: 1 } });
  for (const [node, request, expected] of [[health, start, false], [capable, start, false], [health, optedIn, false], [capable, optedIn, true]] as const) {
    assert.equal(canEmitStructuredResults(node, request), expected);
  }
  assert.equal(canEmitStructuredResults(capable, StartRunRequest.parse({ ...optedIn, profileId: "another-chat" })), false);
  assert.deepEqual(Buffer.from(JSON.stringify(start) + "\n"), fixture("legacy-start.json"), "negotiation must not mutate legacy payloads");
  assert.equal(NodeHealth.safeParse({ ...health, capabilities: { structuredResults: { version: 1, profiles: ["missing"] } } }).success, false);
  for (const profiles of [[], ["deepseek-chat", "deepseek-chat"]]) assert.equal(StructuredResultCapability.safeParse({ version: 1, profiles }).success, false);
});

test("unknown feature versions, execution grants and image opt-in are rejected", () => {
  for (const structuredResults of [true, false, null, {}, { version: 2 }, { version: 1, tools: true }, { version: 1, permission: "allow" }]) {
    assert.equal(StartRunRequest.safeParse({ ...start, structuredResults }).success, false);
  }
  assert.equal(StartRunRequest.safeParse({ ...start, kind: "image", structuredResults: { version: 1 } }).success, false);
  assert.equal(StructuredResultCapability.safeParse({ version: 2, profiles: health.profiles }).success, false);
});

test("F34: normalized events preserve the complete authoritative body and remain nonterminal", () => {
  const complete = enabled.filter((event) => event.type === "message_complete");
  assert.equal(complete.length, 1);
  assert.equal(complete[0]?.text, start.snapshot.content);
  assert.equal(enabled.at(-1)?.type, "terminal");
  for (const event of enabled) {
    if (event.type !== "result_display") continue;
    const internal = StructuredAgentEvent.parse({ ...event, eventId: `evt-${event.seq}`, runId: start.runId });
    assert.equal(isTerminalEvent(internal), false);
    assert.equal(RemoteEvent.safeParse(event).success, false, "legacy consumer does not recognize new events");
    assert.equal(AgentEvent.safeParse(internal).success, false);
    assert.equal(StructuredRemoteEvent.safeParse({ ...event, permission: "allow" }).success, false);
  }
});

test("F29: unsupported display is explicit; unknown wire/execution types and malformed blocks fail closed", () => {
  assert.ok(enabled.some((event) => event.type === "result_display" && event.result.block.kind === "unsupported"));
  for (const block of [
    { kind: "future_chart", data: [] }, { kind: "tool_call", command: "shell" },
    { kind: "permission", decision: "allow" }, { kind: "unsupported", originalKind: "chart", reason: "unknown_display_kind", payload: { secret: "do not retain" } },
    { kind: "tool_step", stepId: "s", tool: "shell", status: "completed", summary: "", arguments: ["execute"] },
  ]) assert.equal(ResultDisplayBlock.safeParse(block).success, false);
  const block = { kind: "unsupported", originalKind: "chart", reason: "unknown_display_kind" };
  assert.equal(ResultDisplay.safeParse({ version: 2, block }).success, false);
  assert.equal(StructuredRemoteEvent.safeParse({ type: "execute", seq: 0, ts, command: "shell" }).success, false);
});

test("F35: unknown counts/costs cannot become zero; actual zero remains measurable", () => {
  const unknown = { status: "unknown", reason: "not_reported" };
  assert.deepEqual(UsageCount.parse(unknown), unknown);
  assert.deepEqual(UsageCount.parse({ status: "measured", value: 0 }), { status: "measured", value: 0 });
  assert.deepEqual(UsageCost.parse({ status: "measured", amount: 0, currency: "USD" }), { status: "measured", amount: 0, currency: "USD" });
  for (const value of [undefined, null, 0, {}, { ...unknown, value: 0 }, { status: "measured" }, { status: "measured", value: -1 }, { status: "measured", value: 1.5 }, { status: "measured", value: Number.MAX_SAFE_INTEGER + 1 }]) {
    assert.equal(UsageCount.safeParse(value).success, false);
  }
  for (const amount of [-1, Infinity, NaN]) assert.equal(UsageCost.safeParse({ status: "measured", amount, currency: "USD" }).success, false);
  const usage = enabled.find((event) => event.type === "result_display" && event.result.block.kind === "usage");
  assert.ok(usage?.type === "result_display" && usage.result.block.kind === "usage");
  assert.equal(usage.result.block.inputTokens.status, "unknown");
  assert.deepEqual(usage.result.block.toolCalls, { status: "measured", value: 1 });
  assert.equal(ResultDisplayBlock.safeParse({ ...usage.result.block, maxTokens: 100, budget: 5 }).success, false);
});

test("source references preserve version/hash/time/status; unreadable records do not invent content", () => {
  for (const status of ["readable", "missing", "revoked"] as const) assert.deepEqual(SourceReference.parse({ ...source, status }), { ...source, status });
  for (const key of ["version", "contentHash", "retrievedAt", "status"] as const) {
    const bad = { ...source }; delete (bad as Partial<typeof source>)[key];
    assert.equal(SourceReference.safeParse(bad).success, false, key);
  }
  assert.equal(SourceReference.safeParse({ ...source, contentHash: null }).success, false);
  assert.equal(SourceReference.safeParse({ ...source, version: null }).success, false);
  assert.equal(SourceReference.safeParse({ ...source, status: "missing", version: null, contentHash: null }).success, true);
  assert.equal(SourceReference.safeParse({ ...source, contentHash: "bad", status: "revoked" }).success, false);
  assert.equal(SourceReferences.safeParse([]).success, false);
  assert.equal(SourceReferences.safeParse(Array(101).fill(source)).success, false);
});

test("source identity uses existing IDs or HTTP(S), and never carries filesystem paths or provider state", () => {
  assert.ok(SourceIdentity.safeParse({ kind: "message", id: `msg_${id}` }).success);
  assert.ok(SourceIdentity.safeParse({ kind: "chat_message", id: `cmsg_${id}` }).success);
  assert.equal(SourceIdentity.safeParse({ kind: "message", id: `cmsg_${id}` }).success, false);
  for (const url of ["file:///C:/secret", "javascript:alert(1)", "https://user:password@example.com/a", "data:text/html,test", "https://"]) {
    assert.equal(SourceUrl.safeParse(url).success, false, url);
  }
  for (const extension of [{ signature: "opaque" }, { file_id: "remote-file" }, { path: "C:/secret" }, { content: "duplicate body" }, { authorization: "allow" }]) {
    assert.equal(SourceReference.safeParse({ ...source, ...extension }).success, false);
  }
});

test("optional references attach to existing materials and snapshots without changing legacy records", () => {
  const message = { id: `msg_${id}`, projectId: `proj_${id}`, kind: "source_input", content: "material", createdAt: ts, sourceAgent: "human" };
  const snapshot = { id: `snap_${id}`, projectId: `proj_${id}`, content: "prompt", contentHash: "a".repeat(64), nonce: "0123456789abcdef", contributionIds: [`c_${id}`], taskInstruction: "review", reviewerAgent: "claude", adapterVersion: "1", tokenEstimate: 1, synthesisVersion: null, branch: null, commitSha: null, createdAt: ts };
  const chatSnapshot = { id: `snap_${id}`, purpose: "reply", conversationId: `conv_${id}`, userMessageId: `cmsg_${id}`, agent: "deepseek", content: "prompt", contentHash: "a".repeat(64), nonce: "0123456789abcdef", memorySlot: null, includedMessageIds: [`cmsg_${id}`], includedSummaryIds: [], adapterVersion: "1", tokenEstimate: 1, createdAt: ts };
  const reply = { id: `cmsg_${id}`, conversationId: `conv_${id}`, createdAt: ts, sender: "agent", agent: "deepseek", text: "answer", inReplyTo: `cmsg_${id}`, slotId: `slot_${id}`, runId: `run_${id}`, memoryEntriesUsed: null };
  for (const [schema, value] of [[Message, message], [PromptSnapshot, snapshot], [ChatSnapshot, chatSnapshot], [AgentChatMessage, reply]] as const) {
    assert.deepEqual(schema.parse(value), value);
    assert.deepEqual(schema.parse({ ...value, sourceRefs: [source] }), { ...value, sourceRefs: [source] });
    assert.equal(schema.safeParse({ ...value, sourceRefs: [{ ...source, status: "readable", contentHash: null }] }).success, false);
  }
});

test("X11: synthetic Search/Fetch expectations do not turn snippets, missing pages or empty results into material", () => {
  assert.equal(provider.kind, "synthetic_not_live");
  assert.equal(provider.upstream.commit, "5d5dd754ebc1948e977ddb880a9eb5aa25f37b4c");
  const [fetched, snippet, empty, missing] = provider.cases;
  assert.equal(source.contentHash, hash(fetched.response.content));
  assert.equal(source.version, source.contentHash);
  assert.equal(snippet.response.results[0].content, "");
  for (const item of [snippet, missing]) {
    const ref = SourceReference.parse(item.expectedReference);
    assert.equal(ref.status, "missing");
    assert.equal(ref.contentHash, null);
    assert.equal(ref.version, null);
  }
  assert.deepEqual(empty.response.results, []);
  assert.equal(missing.httpStatus, 404);
});
