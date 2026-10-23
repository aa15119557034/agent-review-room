import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { NodeHealth, RemoteEvent, type StartRunRequest } from "@room/schemas";
import { FakeNode } from "./fake-node";

describe("X-33 FakeNode 的 HTTP 模型记录", () => {
  for (const selectable of [false, true]) {
    it(selectable ? "上报 profileModels，记录实际 model / effort" : "老节点省略 profileModels，保留请求中 model 的缺省", async (t) => {
      const node = new FakeNode({
        nodeId: "model-test",
        profiles: ["codex-discuss"],
        token: "test-token-".repeat(4),
        profileModels: selectable ? [{ profileId: "codex-discuss", models: [{
          id: "gpt-6.1-sol",
          displayName: "GPT-6.1 Sol",
          efforts: [{ id: "medium", displayName: "中等", note: null }],
          defaultEffort: "medium",
        }] }] : undefined,
        behavior: { "codex-discuss": { kind: "hold" } },
        heartbeatMs: 10,
      });
      t.after(() => node.stop());
      await node.start();
      const headers = { authorization: "Bearer " + node.token, "content-type": "application/json" };
      const healthResponse = await fetch(node.url + "/v1/health", { headers });
      assert.equal(healthResponse.status, 200);
      const health = NodeHealth.parse(await healthResponse.json());
      assert.equal(Object.hasOwn(health, "profileModels"), selectable);
      if (selectable) assert.deepEqual(health.profileModels, node.profileModels);

      const content = "X-33 HTTP fixture";
      const request: StartRunRequest = {
        protocol: 1,
        runId: "run_01JAAAAAAAAAAAAAAAAAAAAAAA",
        profileId: "codex-discuss",
        snapshot: {
          id: "snap_01JAAAAAAAAAAAAAAAAAAAAAAA",
          content,
          contentHash: createHash("sha256").update(content, "utf8").digest("hex"),
        },
        limits: { idleTimeoutMs: 1_000, totalTimeoutMs: 5_000 },
        ...(selectable ? { model: { model: "gpt-6.1-sol", effort: "medium" } } : {}),
      };
      const response = await fetch(node.url + "/v1/runs", { method: "POST", headers, body: JSON.stringify(request) });
      assert.equal(response.status, 202, await response.text());
      assert.equal(node.starts.length, 1);
      assert.equal(Object.hasOwn(node.starts[0]!, "model"), selectable);
      if (selectable) assert.deepEqual(node.starts[0]!.model, { model: "gpt-6.1-sol", effort: "medium" });

      const events = await fetch(node.url + "/v1/runs/" + request.runId + "/events?after=-1", {
        headers, signal: AbortSignal.timeout(2_000),
      });
      assert.equal(events.status, 200);
      assert.ok(events.body);
      const reader = events.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let lastSeq = -1;
      let heartbeatAfterStart = false;
      try {
        while (!heartbeatAfterStart) {
          const chunk = await reader.read();
          assert.equal(chunk.done, false);
          buffer += decoder.decode(chunk.value, { stream: true });
          let newline: number;
          while ((newline = buffer.indexOf("\n")) !== -1) {
            const raw: unknown = JSON.parse(buffer.slice(0, newline));
            buffer = buffer.slice(newline + 1);
            const event = RemoteEvent.parse(raw);
            if (event.type === "heartbeat") {
              assert.equal(Object.hasOwn(raw as object, "seq"), false, "heartbeat 不占用可重放事件的 seq");
              assert.equal(event.lastSeq, lastSeq);
              heartbeatAfterStart = lastSeq >= 0;
            } else {
              assert.equal(event.seq, lastSeq + 1);
              lastSeq = event.seq;
            }
          }
        }
      } finally {
        await reader.cancel();
      }
    });
  }
});
