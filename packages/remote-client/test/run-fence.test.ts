import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import type { AgentInput } from "@room/core";
import { NodeHealth, RunId, RemoteRunLedgerId, WORLD_PROFILE_RECIPE_DEEPSEEK_HTTP_V1, type AgentEvent } from "@room/schemas";
import { HttpRemoteAgentAdapter } from "../src/index";

const runId = RunId.parse("run_" + "0".repeat(26));
const ledgerId = RemoteRunLedgerId.parse("rled_" + "0".repeat(26));
const otherLedger = RemoteRunLedgerId.parse("rled_" + "1".repeat(26));
const token = "fixture-only-token".repeat(3);
const model = { model: "deepseek-chat", effort: null };
const expectation = { sourceChatProfileId: "deepseek-chat", recipeVersion: WORLD_PROFILE_RECIPE_DEEPSEEK_HTTP_V1 };
const catalogue = [{ id: model.model, displayName: "Fixture model", efforts: [], defaultEffort: null }];
const health = () => NodeHealth.parse({
  protocol: 1, nodeId: "fixture-node", profiles: ["deepseek-chat", "deepseek-world"],
  activeRuns: 0, maxConcurrentRuns: 1, leaseMs: 1000, heartbeatMs: 100,
  profileModels: ["deepseek-chat", "deepseek-world"].map(profileId => ({ profileId, models: catalogue })),
  capabilities: { runFence: { version: 1, ledgerId }, worldProfiles: [{ profileId: "deepseek-world", ...expectation, sourceDefaultModel: model }] },
});
const input = (extra: Partial<AgentInput> = {}): AgentInput => {
  const content = "Only this resident's observation.";
  return { snapshotId: "snap_" + "0".repeat(26), content, contentHash: createHash("sha256").update(content).digest("hex"), ...extra };
};
function reply(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}
async function body(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}
async function fixture(t: TestContext, handler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean> | boolean) {
  const errors: unknown[] = [];
  const server = createServer((req, res) => {
    void (async () => {
      assert.equal(req.headers.authorization, `Bearer ${token}`);
      if (await handler(req, res)) return;
      if (req.url === "/v1/health") return reply(res, 200, health());
      if (req.url?.includes("/events?")) {
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        res.end(JSON.stringify({ type: "terminal", seq: 0, ts: new Date().toISOString(), result: { outcome: "completed", exitCode: 0 } }) + "\n");
        return;
      }
      reply(res, 404, { error: "not_found" });
    })().catch(error => { errors.push(error); res.destroy(); });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    assert.deepEqual(errors, []);
  });
  const options = {
    nodeId: "fixture-node", baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, profileId: "deepseek-world", token,
    heartbeatTimeoutMs: 500, reconnectGraceMs: 2000, requestTimeoutMs: 500, reconnectDelayMs: 5,
    expectedLedgerId: ledgerId, expectedWorldProfile: { ...expectation }, model: { ...model },
  };
  return { options, adapter: (extra: Partial<typeof options> = {}) => new HttpRemoteAgentAdapter({ ...options, ...extra }) };
}
async function collect(adapter: HttpRemoteAgentAdapter, inp = input(), signal = new AbortController().signal) {
  const events: AgentEvent[] = [];
  for await (const event of adapter.run("unused-session", runId, inp, {
    signal, idleTimeoutMs: 10000, totalTimeoutMs: 30000,
    onPermissionRequest: async () => ({ decision: "deny", decidedBy: "system" }),
  })) events.push(event);
  assert.equal(events.filter(e => ["completed", "cancelled", "error", "timed_out"].includes(e.type)).length, 1);
  return events;
}

test("world requests retain immutable bindings on retries; completed does not invent proof", async t => {
  const requests: string[] = [], cancels: unknown[] = [];
  let proofCalls = 0;
  const f = await fixture(t, async (req, res) => {
    if (req.url === "/v1/runs") {
      requests.push(JSON.stringify(await body(req)));
      reply(res, requests.length === 1 ? 503 : 202, { ok: true }); return true;
    }
    if (req.url?.endsWith("/cancel")) { cancels.push(await body(req)); reply(res, 202, { ok: true }); return true; }
    if (req.url?.endsWith("/proof")) { proofCalls++; reply(res, 200, { runId, ledgerId, status: "unconfirmed" }); return true; }
    return false;
  });
  const a = new HttpRemoteAgentAdapter(f.options);
  f.options.expectedWorldProfile.sourceChatProfileId = "different-chat";
  f.options.model.model = "different-model";
  f.options.expectedLedgerId = otherLedger;
  await a.initialize();
  assert.equal((await collect(a)).at(-1)?.type, "completed");
  assert.equal(requests.length, 2);
  assert.equal(requests[0], requests[1]);
  const sent = JSON.parse(requests[0]!);
  assert.equal(sent.expectedLedgerId, ledgerId);
  assert.deepEqual(sent.expectedWorldProfile, expectation);
  assert.deepEqual(sent.model, model);
  assert.equal(proofCalls, 0);
  await a.runFence!.cancel(runId, "cleanup");
  assert.deepEqual(cancels, [{ reason: "cleanup", expectedLedgerId: ledgerId }]);
  assert.equal((await a.runFence!.proof(runId)).status, "unconfirmed");
});

test("initialization and dispatch reject wrong node, ledger, mapping, recipe or model without POST", async t => {
  for (const variant of ["node", "ledger", "missing", "mapping", "recipe", "model", "effort"] as const) await t.test(variant, async t => {
    let starts = 0;
    const f = await fixture(t, (req, res) => {
      if (req.url === "/v1/runs") { starts++; reply(res, 202, { ok: true }); return true; }
      if (req.url === "/v1/health") {
        const h = health();
        if (variant === "node") h.nodeId = "different-node";
        if (variant === "ledger") h.capabilities!.runFence!.ledgerId = otherLedger;
        if (variant === "missing") delete h.capabilities!.runFence;
        if (variant === "mapping") h.capabilities!.worldProfiles = [];
        if (variant === "recipe") h.capabilities!.worldProfiles![0]!.recipeVersion = "future-recipe";
        reply(res, 200, h); return true;
      }
      return false;
    });
    const a = f.adapter(variant === "model" ? { model: { model: "wrong-model", effort: null } } : variant === "effort" ? { model: { ...model, effort: "high" as never } } : {});
    await assert.rejects(a.initialize());
    const last = (await collect(a)).at(-1)!;
    assert.equal(last.type === "error" && last.reason, "remote_rejected");
    assert.equal(starts, 0);
  });
});

test("world input with chat or commit context is refused locally; unknown recipe never dispatches", async t => {
  let calls = 0;
  const f = await fixture(t, () => { calls++; return false; });
  for (const extra of [{ chat: null } as unknown as Partial<AgentInput>, { commitSha: "a".repeat(40) }]) {
    const last = (await collect(f.adapter(), input(extra))).at(-1)!;
    assert.equal(last.type === "error" && last.reason, "remote_rejected");
  }
  assert.equal(calls, 0);
  assert.throws(() => new HttpRemoteAgentAdapter({ ...f.options, expectedLedgerId: undefined }), /账本/);
  assert.throws(() => new HttpRemoteAgentAdapter({ ...f.options, model: undefined }), /模型/);
  const a = f.adapter({ expectedWorldProfile: { ...expectation, recipeVersion: "future-recipe" } });
  await assert.rejects(a.initialize(), /recipe/);
});

test("server final profile mismatch is terminal, without unbound retry", async t => {
  const sent: unknown[] = [];
  const f = await fixture(t, async (req, res) => {
    if (req.url !== "/v1/runs") return false;
    sent.push(await body(req)); reply(res, 409, { error: "world_profile_mismatch", message: "mapping changed after health" }); return true;
  });
  const last = (await collect(f.adapter())).at(-1)!;
  assert.equal(last.type === "error" && last.reason, "remote_rejected");
  assert.equal(sent.length, 1);
  assert.equal((sent[0] as { expectedLedgerId: string }).expectedLedgerId, ledgerId);
});

test("proof and public cancel require neither initialize nor a surviving profile", async t => {
  let status: "missing" | "unconfirmed" | "fenced_never_started" | "closed_process" = "missing";
  const f = await fixture(t, async (req, res) => {
    assert.ok(req.url?.endsWith("/proof") || req.url?.endsWith("/cancel"), "no health, session, or profile lookup");
    if (req.url!.endsWith("/cancel")) { assert.equal((await body(req)).expectedLedgerId, ledgerId); reply(res, 202, { ok: true }); }
    else { assert.equal(req.headers["cache-control"], "no-store"); reply(res, 200, { runId, ledgerId, status }); }
    return true;
  });
  const a = new HttpRemoteAgentAdapter({ ...f.options, profileId: "deleted-profile", expectedWorldProfile: undefined, model: undefined });
  for (status of ["missing", "unconfirmed", "fenced_never_started", "closed_process"] as const) assert.equal((await a.runFence!.proof(runId)).status, status);
  await a.runFence!.cancel(runId);
  await assert.rejects(a.runFence!.proof("../../different" as RunId));
});

test("cancel rejects wrong HTTP status, invalid body, connection loss, and stalled body", async t => {
  for (const variant of ["200", "401", "409", "500", "false", "invalid", "disconnect", "stalled"] as const) await t.test(variant, async t => {
    const f = await fixture(t, async (req, res) => {
      assert.ok(req.url?.endsWith("/cancel")); await body(req);
      if (variant === "disconnect") { res.destroy(); return true; }
      if (variant === "stalled") { res.writeHead(202, { "content-type": "application/json" }); res.write('{"ok":'); return true; }
      if (variant === "invalid") { res.writeHead(202); res.end("not JSON"); return true; }
      reply(res, variant === "false" ? 202 : Number(variant), { ok: variant !== "false" }); return true;
    });
    await assert.rejects(f.adapter({ requestTimeoutMs: 150 }).runFence!.cancel(runId));
  });
});

test("proof rejects wrong RunId/ledger, malformed data and 404", async t => {
  for (const variant of ["run", "ledger", "malformed", "404", "201"] as const) await t.test(variant, async t => {
    const f = await fixture(t, (req, res) => {
      assert.ok(req.url?.endsWith("/proof"));
      reply(res, variant === "404" ? 404 : variant === "201" ? 201 : 200, { runId: variant === "run" ? "run_" + "1".repeat(26) : runId,
        ledgerId: variant === "ledger" ? otherLedger : ledgerId, status: variant === "malformed" ? "finished" : "closed_process" }); return true;
    });
    await assert.rejects(f.adapter().runFence!.proof(runId));
  });
});

test("abort during held creation sends an independently bounded cancel with the original ledger", async t => {
  const abort = new AbortController();
  let accept!: () => void;
  const accepted = new Promise<void>(resolve => { accept = resolve; });
  let fenced = false, delayedStarts = 0;
  const f = await fixture(t, async (req, res) => {
    if (req.url === "/v1/runs") {
      assert.equal((await body(req)).expectedLedgerId, ledgerId);
      abort.abort();
      await accepted;
      if (!fenced) delayedStarts++;
      reply(res, 409, { error: "run_cancelled" }); return true;
    }
    if (req.url?.endsWith("/cancel")) {
      assert.equal((await body(req)).expectedLedgerId, ledgerId);
      fenced = true; reply(res, 202, { ok: true }); accept(); return true;
    }
    return false;
  });
  const a = f.adapter();
  const result = await collect(a, input(), abort.signal);
  assert.equal(result.at(-1)?.type, "cancelled");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([accepted, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("cancel never arrived")), 2000); })]); }
  finally { clearTimeout(timer); }
  assert.equal(delayedStarts, 0);
  assert.equal(fenced, true);
});
