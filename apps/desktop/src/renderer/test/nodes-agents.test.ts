import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AgentProfile, COMMANDS, type NodeInfo } from "@room/schemas";
import { createMockBridge } from "../mock/mock-backend";
import { CONTROLLER_NODE, RECOMMENDED_AGENTS, RECOMMENDED_NODES, USER_PC_NODE } from "../lib/presets";

/** C-27：设置页的节点与参与者。mock 的语义和 D-22c / D-22e 一致 */

async function call<T>(p: Promise<{ ok: true; data: T } | { ok: false; error: string; message: string }>): Promise<T> {
  const r = await p;
  if (!r.ok) throw new Error(`${r.error}: ${r.message}`);
  return r.data;
}

describe("recommended configuration", () => {
  it("every preset is a valid agent.update request and points at a recommended node", () => {
    for (const a of RECOMMENDED_AGENTS) {
      assert.ok(COMMANDS["agent.update"].request.safeParse({ type: "agent.update", ...a }).success, a.id);
      assert.ok(RECOMMENDED_NODES.some((n) => n.id === a.nodeId), a.id);
    }
    assert.deepEqual(RECOMMENDED_AGENTS.filter((a) => a.canSummarize).map((a) => a.id), ["claude"], "C酱 is the only summarizer");
    assert.equal(RECOMMENDED_AGENTS.find((a) => a.id === "claude")?.nodeId, USER_PC_NODE);
    assert.ok(RECOMMENDED_AGENTS.filter((a) => a.id !== "claude").every((a) => a.nodeId === CONTROLLER_NODE));
  });

  it("role notes describe the job, and stay short", () => {
    for (const a of RECOMMENDED_AGENTS) {
      const note = a.roleNote ?? "";
      assert.equal(note.split("\n").length, 3, a.id + " 三句");
      assert.ok(note.length <= 400 && AgentProfile.shape.roleNote.safeParse(note).success, a.id);
    }
  });
});

describe("mock nodes and agents (aligned with D-22c / D-22e)", () => {
  it("changing a node's address without a new token drops the saved token", async () => {
    const bridge = createMockBridge({ tickMs: 1, reviewerConfigured: true });
    const cmd = <T>(req: Record<string, unknown>) => call<T>(bridge.command(req as never) as never);
    await cmd<NodeInfo>({ type: "node.upsert", id: "controller-local", label: "主控机", baseUrl: "http://127.0.0.1:7420", token: "x".repeat(40) });
    const same = await cmd<NodeInfo>({ type: "node.upsert", id: "controller-local", label: "主控机（本机）", baseUrl: "http://127.0.0.1:7420" });
    assert.equal(same.tokenConfigured, true, "same address keeps the token");
    const moved = await cmd<NodeInfo>({ type: "node.upsert", id: "controller-local", label: "主控机", baseUrl: "http://10.9.9.9:7420" });
    assert.equal(moved.tokenConfigured, false, "new address needs the token again");
  });

  it("agent.update creates a missing agent only with a name and a colour, then applies the preset", async () => {
    const bridge = createMockBridge({ tickMs: 1, reviewerConfigured: true });
    const r = await bridge.command({ type: "agent.update", id: "gemini", canDiscuss: true } as never);
    assert.equal(!r.ok && r.error, "validation_failed");
    for (const a of RECOMMENDED_AGENTS) {
      const saved = await call(bridge.command({ type: "agent.update", ...a } as never) as never);
      const parsed = AgentProfile.parse(saved);
      assert.equal(parsed.nodeId, a.nodeId);
      assert.equal(parsed.profileId, a.profileId);
    }
  });
});
