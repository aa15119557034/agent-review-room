import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentEvent } from "@room/schemas";
import { createReviewerAdapter, sha256Hex } from "../src/index";

const RUN_ID = "run_01JABCDEFGHJKMNPQRSTVWXYZ0";
const CONTENT = "<UNTRUSTED_AGENT_DATA_abc>待评审内容</UNTRUSTED_AGENT_DATA_abc>";
const HASH = sha256Hex(CONTENT);

const options = {
  signal: new AbortController().signal,
  onPermissionRequest: async () => ({ decision: "deny" as const, decidedBy: "system" as const }),
  idleTimeoutMs: 1000,
  totalTimeoutMs: 5000,
};

function sse(chunks: string[], done = true): string {
  const lines = chunks.map((text) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
  if (done) lines.push("data: [DONE]\n\n");
  return lines.join("");
}

function fakeFetch(body: string, status = 200): { calls: { url: string; init: RequestInit }[]; impl: typeof fetch } {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(body, { status, headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;
  return { calls, impl };
}

async function collect(adapter: ReturnType<typeof createReviewerAdapter>, input: { content: string; contentHash: string }) {
  const events: AgentEvent[] = [];
  for await (const event of adapter.run("sess_1", RUN_ID, { snapshotId: "snap_01JABCDEFGHJKMNPQRSTVWXYZ0", ...input }, options)) {
    events.push(event);
  }
  return events;
}

describe("capabilities", () => {
  it("is read-only and never asks for permissions", async () => {
    const adapter = createReviewerAdapter({ apiKey: "k", model: "m", fetchImpl: fakeFetch("").impl });
    assert.deepEqual(await adapter.initialize(), { streaming: true, permissionRequests: false, readOnly: true });
  });

  it("rejects an empty api key at construction", () => {
    assert.throws(() => createReviewerAdapter({ apiKey: "  ", model: "m" }), /api key is required/);
  });
});

describe("hash guard (AC-7)", () => {
  it("refuses to send anything when the content does not match the hash", async () => {
    const fetchStub = fakeFetch(sse(["不该出现"]));
    const adapter = createReviewerAdapter({ apiKey: "k", model: "m", fetchImpl: fetchStub.impl });

    const events = await collect(adapter, { content: CONTENT, contentHash: "0".repeat(64) });
    assert.equal(fetchStub.calls.length, 0, "must not call the API");
    assert.equal(events.length, 1);
    assert.equal(events[0]?.type, "error");
    assert.equal(events[0]?.type === "error" && events[0].reason, "hash_mismatch");
  });
});

describe("successful run", () => {
  it("streams deltas and ends with exactly one terminal event", async () => {
    const fetchStub = fakeFetch(sse(["你", "好"]));
    const adapter = createReviewerAdapter({ apiKey: "k", model: "m", fetchImpl: fetchStub.impl });

    const events = await collect(adapter, { content: CONTENT, contentHash: HASH });
    const types = events.map((event) => event.type);
    assert.deepEqual(types, ["message_delta", "message_delta", "message_complete", "completed"]);

    const complete = events.find((event) => event.type === "message_complete");
    assert.equal(complete?.type === "message_complete" && complete.text, "你好");

    const terminal = events.filter((event) => ["completed", "error", "cancelled", "timed_out"].includes(event.type));
    assert.equal(terminal.length, 1, "exactly one terminal event");
    assert.deepEqual(events.map((event) => event.seq), [0, 1, 2, 3]);
  });

  it("sends exactly the snapshot content, nothing appended (AC-7)", async () => {
    const fetchStub = fakeFetch(sse(["ok"]));
    const adapter = createReviewerAdapter({ apiKey: "secret-key", model: "reviewer-model", fetchImpl: fetchStub.impl });

    await collect(adapter, { content: CONTENT, contentHash: HASH });
    assert.equal(fetchStub.calls.length, 1);

    const call = fetchStub.calls[0]!;
    const body = JSON.parse(String(call.init.body)) as { model: string; messages: { role: string; content: string }[] };
    assert.equal(body.model, "reviewer-model");
    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0]!.content, CONTENT);
    assert.equal(body.messages[0]!.role, "user");
  });

  it("keeps events ordered and monotonic across chunks", async () => {
    const fetchStub = fakeFetch(sse(["a", "b", "c"]));
    const adapter = createReviewerAdapter({ apiKey: "k", model: "m", fetchImpl: fetchStub.impl });
    const events = await collect(adapter, { content: CONTENT, contentHash: HASH });
    assert.deepEqual(events.map((event) => event.seq), events.map((_, index) => index));
  });
});

describe("failures never throw", () => {
  it("turns an HTTP error into a single error terminal", async () => {
    const fetchStub = fakeFetch("", 500);
    const adapter = createReviewerAdapter({ apiKey: "k", model: "m", fetchImpl: fetchStub.impl });
    const events = await collect(adapter, { content: CONTENT, contentHash: HASH });

    assert.equal(events.length, 1);
    assert.equal(events[0]?.type, "error");
    assert.match(events[0]?.type === "error" ? (events[0].message ?? "") : "", /HTTP 500/);
  });

  it("turns a thrown fetch into an error terminal", async () => {
    const impl = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const adapter = createReviewerAdapter({ apiKey: "k", model: "m", fetchImpl: impl });
    const events = await collect(adapter, { content: CONTENT, contentHash: HASH });

    assert.equal(events.length, 1);
    assert.equal(events[0]?.type, "error");
    assert.match(events[0]?.type === "error" ? (events[0].message ?? "") : "", /network down/);
  });

  it("reports cancelled when the caller already aborted", async () => {
    const fetchStub = fakeFetch(sse(["x"]));
    const adapter = createReviewerAdapter({ apiKey: "k", model: "m", fetchImpl: fetchStub.impl });

    const controller = new AbortController();
    controller.abort();
    const events: AgentEvent[] = [];
    for await (const event of adapter.run(
      "sess_1",
      RUN_ID,
      { snapshotId: "snap_01JABCDEFGHJKMNPQRSTVWXYZ0", content: CONTENT, contentHash: HASH },
      { ...options, signal: controller.signal },
    )) {
      events.push(event);
    }

    assert.equal(fetchStub.calls.length, 0);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.type, "cancelled");
  });
});

describe("stream integrity (D-05b)", () => {
  const opts = {
    signal: new AbortController().signal,
    onPermissionRequest: async () => ({ decision: "deny" as const, decidedBy: "system" as const }),
    idleTimeoutMs: 2000,
    totalTimeoutMs: 5000,
  };

  const runWith = async (impl: typeof fetch, overrides: Partial<typeof opts> = {}) => {
    const adapter = createReviewerAdapter({ apiKey: "k", model: "m", fetchImpl: impl });
    const events: AgentEvent[] = [];
    for await (const event of adapter.run(
      "sess_1",
      RUN_ID,
      { snapshotId: "snap_01JABCDEFGHJKMNPQRSTVWXYZ0", content: CONTENT, contentHash: HASH },
      { ...opts, ...overrides },
    )) {
      events.push(event);
    }
    return events;
  };

  it("treats a stream that ends without [DONE] as an error, not a result", async () => {
    const impl = fakeFetch(sse(["半截"], false)).impl;
    const events = await runWith(impl);
    const last = events[events.length - 1];
    assert.equal(last?.type, "error");
    assert.match(last?.type === "error" ? (last.message ?? "") : "", /without \[DONE\]|unexpectedly/);
    assert.equal(events.filter((e) => ["completed", "error"].includes(e.type)).length, 1);
  });

  it("flags finish_reason=length as truncated instead of completed", async () => {
    const body =
      "data: " + JSON.stringify({ choices: [{ delta: { content: "截断" }, finish_reason: "length" }] }) + "\n\n" +
      "data: " + JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }] }) + "\n\n";
    const impl = fakeFetch(body).impl;
    const events = await runWith(impl);
    const types = events.map((e) => e.type);
    assert.deepEqual(types, ["message_delta", "message_complete", "error"]);
    const last = events[events.length - 1];
    assert.equal(last?.type === "error" ? last.reason : null, "output_limit_exceeded");
  });

  it("aborts the request and cancels the stream when the consumer breaks", async () => {
    const encoder = new TextEncoder();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(sse(["第一块"])));
        // 故意不 close：模拟还在持续返回的流
      },
      cancel() {
        cancelled = true;
      },
    });
    const impl = (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;

    const adapter = createReviewerAdapter({ apiKey: "k", model: "m", fetchImpl: impl });
    const seen: AgentEvent[] = [];
    for await (const event of adapter.run(
      "sess_1",
      RUN_ID,
      { snapshotId: "snap_01JABCDEFGHJKMNPQRSTVWXYZ0", content: CONTENT, contentHash: HASH },
      opts,
    )) {
      seen.push(event);
      break;
    }

    assert.equal(seen.length, 1);
    assert.equal(cancelled, true, "stream must be cancelled after break");
  });

  it("parses CRLF-separated SSE", async () => {
    const body = ("data: " + JSON.stringify({ choices: [{ delta: { content: "OK" } }] }) + "\r\n\r\n") +
      ("data: [DONE]\r\n\r\n");
    const impl = fakeFetch(body).impl;
    const events = await runWith(impl);
    const complete = events.find((e) => e.type === "message_complete");
    assert.equal(complete?.type === "message_complete" ? complete.text : "", "OK");
  });

  it("times out on idle when the stream stalls", async () => {
    const body = new ReadableStream<Uint8Array>({ start() { /* 永不发数据 */ } });
    const impl = (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;

    const events = await runWith(impl, { idleTimeoutMs: 30, totalTimeoutMs: 5000 });
    const last = events[events.length - 1];
    assert.equal(last?.type, "timed_out");
    assert.equal(last?.type === "timed_out" ? last.kind : null, "idle");
  });
});
