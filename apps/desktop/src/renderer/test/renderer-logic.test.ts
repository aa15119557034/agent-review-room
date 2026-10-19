import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { AgentEvent, ControlEvent, RoomBridge } from "@room/schemas";
import { createMockBridge } from "../mock/mock-backend";
import { createClient, ControlFailure } from "../lib/client";
import { createStore } from "../lib/store";
import { appendEvents, applyEvent, initialState, type AppState } from "../lib/state";
import { createActions } from "../lib/actions";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TS = "2026-10-20T00:00:00.000Z";
const RUN = "run_01JAAAAAAAAAAAAAAAAAAAAAAA";

const delta = (seq: number): AgentEvent =>
  ({ eventId: `e${seq}`, runId: RUN, seq, ts: TS, type: "message_delta", text: String(seq) }) as AgentEvent;

describe("state reducer", () => {
  it("appendEvents keeps seq strictly increasing and drops duplicates", () => {
    const merged = appendEvents([delta(0), delta(1)], [delta(1), delta(3), delta(2), delta(0)]);
    assert.deepEqual(merged.map((e) => e.seq), [0, 1, 2, 3]);
  });

  it("ignores events for other projects and unknown runs", () => {
    const s: AppState = { ...initialState, currentProjectId: "proj_A" };
    const other: ControlEvent = {
      type: "message.created",
      message: { id: "msg_x", projectId: "proj_B", kind: "source_input", sourceAgent: "x", content: "c", createdAt: TS },
    } as ControlEvent;
    assert.equal(applyEvent(s, other), s);
    assert.equal(applyEvent(s, { type: "run.event", event: delta(0) }), s);
  });
});

describe("mock backend + actions: Phase 0 loop", () => {
  let bridge: RoomBridge & { reset(): void };
  let store: ReturnType<typeof createStore<AppState>>;
  let actions: ReturnType<typeof createActions>;

  beforeEach(async () => {
    bridge = createMockBridge({ tickMs: 2 });
    store = createStore(initialState);
    actions = createActions(store, createClient(bridge));
    await actions.start();
    await actions.createProject("测试项目");
  });

  async function prepareApproval() {
    const msg = await actions.addSource("deepseek", "第一行\n风险：并发写入\n第三行");
    assert.ok(msg);
    const start = msg.content.indexOf("风险");
    const c = await actions.createContribution({
      sourceMessageId: msg.id,
      contributionType: "risk",
      title: "并发",
      selection: { start, end: start + 7 },
    });
    assert.ok(c);
    assert.equal(c.content, "风险：并发写入", "content is cut server-side from the selection");
    actions.setTaskInstruction("请审查");
    const snap = await actions.createSnapshot();
    assert.ok(snap);
    const approval = store.get().approvals.find((a) => a.snapshotId === snap.id);
    assert.equal(approval?.state, "READY_FOR_REVIEW");
    return { snap, approval: approval! };
  }

  it("runs the full loop and ends with exactly one terminal event", async () => {
    const { snap, approval } = await prepareApproval();
    const run = await actions.approve(approval.id, snap.contentHash);
    assert.ok(run);
    await sleep(80);
    const s = store.get();
    assert.equal(s.runs.find((r) => r.id === run.id)?.state, "COMPLETED");
    const events = s.runEvents[run.id] ?? [];
    const terminals = events.filter((e) => ["completed", "error", "cancelled", "timed_out"].includes(e.type));
    assert.equal(terminals.length, 1);
    events.forEach((e, i) => assert.equal(e.seq, i));
    assert.ok(s.messages.some((m) => m.kind === "reviewer_output" && m.runId === run.id), "reviewer output stored");
  });

  it("rejects approval with a stale hash and leaves state untouched", async () => {
    const { approval } = await prepareApproval();
    const run = await actions.approve(approval.id, "0".repeat(64));
    assert.equal(run, undefined);
    assert.match(store.get().notice?.message ?? "", /已经变了/);
    assert.equal(store.get().approvals.find((a) => a.id === approval.id)?.state, "READY_FOR_REVIEW");
  });

  it("double approve creates only one run", async () => {
    const { snap, approval } = await prepareApproval();
    const [a, b] = await Promise.all([
      actions.approve(approval.id, snap.contentHash),
      actions.approve(approval.id, snap.contentHash),
    ]);
    assert.equal([a, b].filter(Boolean).length, 1);
    await sleep(80);
    assert.equal(store.get().runs.length, 1);
  });

  it("a new snapshot expires the previous pending approval", async () => {
    const first = await prepareApproval();
    actions.setTaskInstruction("换一个问法");
    await actions.createSnapshot();
    await sleep(5);
    assert.equal(store.get().approvals.find((a) => a.id === first.approval.id)?.state, "EXPIRED");
  });

  it("cancel produces CANCELLED and a single cancelled event", async () => {
    const { snap, approval } = await prepareApproval();
    const run = await actions.approve(approval.id, snap.contentHash);
    await sleep(5);
    await actions.cancelRun(run!.id);
    await sleep(60);
    const s = store.get();
    assert.equal(s.runs.find((r) => r.id === run!.id)?.state, "CANCELLED");
    const terminals = (s.runEvents[run!.id] ?? []).filter((e) =>
      ["completed", "error", "cancelled", "timed_out"].includes(e.type),
    );
    assert.deepEqual(terminals.map((e) => e.type), ["cancelled"]);
  });

  it("history survives a reload (AC-10 for the UI layer)", async () => {
    const { snap, approval } = await prepareApproval();
    const run = await actions.approve(approval.id, snap.contentHash);
    await sleep(80);
    // 模拟重启：新的 store，同一个后端
    const store2 = createStore(initialState);
    await createActions(store2, createClient(bridge)).start();
    const s2 = store2.get();
    assert.equal(s2.runs[0]?.id, run!.id);
    assert.equal(s2.runs[0]?.state, "COMPLETED");
    assert.ok((s2.runEvents[run!.id]?.length ?? 0) > 3);
  });

  it("client turns ok:false into ControlFailure", async () => {
    const client = createClient(bridge);
    await assert.rejects(client.query({ type: "runs.get", runId: RUN }), (e) => e instanceof ControlFailure && e.code === "not_found");
  });

  it("mock rejects malformed requests with validation_failed instead of throwing", async () => {
    const r = await bridge.command({ type: "approval.approve" } as never);
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.error, "validation_failed");
  });
});

describe("selection helpers", async () => {
  const { segmentText, suggestTitle, trimSelection } = await import("../lib/selection");

  it("segments always concatenate back to the original text", () => {
    const content = "第一行\n风险：并发😀写入\n第三行";
    const segs = segmentText(content, [
      { id: "a", start: 4, end: 12 },
      { id: "b", start: 8, end: 16 },
      { id: "bad", start: 10, end: 999 },
    ]);
    assert.equal(segs.map((s) => s.text).join(""), content);
    assert.deepEqual(segs.find((s) => s.start === 8)?.covers, ["a", "b"]);
    assert.ok(segs.every((s) => !s.covers.includes("bad")));
  });

  it("trims whitespace and never splits a surrogate pair", () => {
    const content = "  a😀b  ";
    const emoji = content.indexOf("😀");
    assert.deepEqual(trimSelection(content, { start: 0, end: 8 }), { start: 2, end: 6 });
    // 只选中 emoji 的后半个 code unit → 扩展到完整字符
    assert.deepEqual(trimSelection(content, { start: emoji + 1, end: emoji + 2 }), { start: emoji, end: emoji + 2 });
    assert.equal(trimSelection(content, { start: 0, end: 2 }), null);
  });

  it("suggests a short title from the first line", () => {
    assert.equal(suggestTitle("风险：main 进程和 utilityProcess 各自写库\n第二行"), "main 进程和 utilityProcess 各自写库");
    assert.equal(Array.from(suggestTitle("😀".repeat(40))).length, 31);
  });
});

describe("prompt draft", () => {
  it("new fragments are pre-selected, toggling works, and switching projects resets the draft", async () => {
    const bridge = createMockBridge({ tickMs: 2 });
    const store = createStore(initialState);
    const actions = createActions(store, createClient(bridge));
    await actions.start();
    await actions.createProject("A");
    const msg = await actions.addSource("deepseek", "abcdef");
    const c1 = await actions.createContribution({ sourceMessageId: msg!.id, contributionType: "risk", title: "1", selection: { start: 0, end: 2 } });
    const c2 = await actions.createContribution({ sourceMessageId: msg!.id, contributionType: "risk", title: "2", selection: { start: 2, end: 4 } });
    assert.deepEqual(store.get().draft.contributionIds, [c1!.id, c2!.id]);
    actions.toggleDraftContribution(c1!.id);
    assert.deepEqual(store.get().draft.contributionIds, [c2!.id]);

    const snap = await actions.createSnapshot();
    assert.deepEqual(snap?.contributionIds, [c2!.id], "snapshot uses only ticked fragments");
    assert.ok(store.get().snapshots[snap!.id], "snapshot is cached");
    assert.deepEqual(store.get().draft.contributionIds, [c2!.id], "draft kept after generating");

    const projectA = store.get().currentProjectId!;
    await actions.createProject("B");
    assert.deepEqual(store.get().draft.contributionIds, [], "draft reset for another project");
    await actions.selectProject(projectA);
    assert.deepEqual(store.get().draft.contributionIds, [], "draft not resurrected (drafts are per session view)");
  });

  it("does nothing when no fragment is ticked or the task is blank", async () => {
    const bridge = createMockBridge({ tickMs: 2 });
    const store = createStore(initialState);
    const actions = createActions(store, createClient(bridge));
    await actions.start();
    await actions.createProject("A");
    assert.equal(await actions.createSnapshot(), undefined);
    const msg = await actions.addSource("deepseek", "abcdef");
    await actions.createContribution({ sourceMessageId: msg!.id, contributionType: "risk", title: "1", selection: { start: 0, end: 2 } });
    actions.setTaskInstruction("   ");
    assert.equal(await actions.createSnapshot(), undefined);
    assert.equal(store.get().approvals.length, 0);
  });
});

describe("run results", async () => {
  const { runTranscript, selectedRun, terminalEvent } = await import("../lib/state");

  async function setup(opts: Parameters<typeof createMockBridge>[0] = {}) {
    const bridge = createMockBridge({ tickMs: 2, ...opts });
    const store = createStore(initialState);
    const actions = createActions(store, createClient(bridge));
    await actions.start();
    await actions.createProject("R");
    const msg = await actions.addSource("deepseek", "abcdef");
    await actions.createContribution({ sourceMessageId: msg!.id, contributionType: "risk", title: "t", selection: { start: 0, end: 3 } });
    return { store, actions };
  }
  async function approveOnce(store: ReturnType<typeof createStore<AppState>>, actions: ReturnType<typeof createActions>) {
    const snap = await actions.createSnapshot();
    const apr = store.get().approvals.find((a) => a.snapshotId === snap!.id)!;
    return (await actions.approve(apr.id, snap!.contentHash))!;
  }

  it("streams, then switches to the stored final result; approved run becomes selected", async () => {
    const { store, actions } = await setup();
    const run = await approveOnce(store, actions);
    assert.equal(store.get().selectedRunId, run.id);
    await sleep(12);
    const mid = runTranscript(store.get(), run.id);
    assert.ok(mid.source === "streaming" || mid.source === "empty", `mid-run source ${mid.source}`);
    await sleep(80);
    const end = runTranscript(store.get(), run.id);
    assert.equal(end.source, "final");
    assert.match(end.text, /mock Reviewer/);
    assert.equal(terminalEvent(store.get(), run.id)?.type, "completed");
  });

  it("keeps partial output after a failure and exposes the failure reason", async () => {
    const { store, actions } = await setup({ reviewerOutcome: "error" });
    const run = await approveOnce(store, actions);
    await sleep(80);
    const s = store.get();
    assert.equal(s.runs.find((r) => r.id === run.id)?.state, "FAILED");
    assert.equal(runTranscript(s, run.id).source, "partial");
    const t = terminalEvent(s, run.id);
    assert.equal(t?.type === "error" && t.reason, "internal");
  });

  it("selectedRun falls back to the newest run and follows explicit selection", async () => {
    const { store, actions } = await setup();
    const r1 = await approveOnce(store, actions);
    await sleep(80);
    const r2 = await approveOnce(store, actions);
    await sleep(80);
    assert.equal(selectedRun(store.get())?.id, r2.id);
    actions.selectRun(r1.id);
    assert.equal(selectedRun(store.get())?.id, r1.id);
    store.set((st) => ({ ...st, selectedRunId: null }));
    assert.equal(selectedRun(store.get())?.id, r2.id);
  });
});
