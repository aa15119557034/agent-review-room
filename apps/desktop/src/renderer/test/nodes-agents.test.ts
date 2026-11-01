import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AgentProfile, COMMANDS, type NodeInfo } from "@room/schemas";
import { createMockBridge } from "../mock/mock-backend";
import { LOCAL_NODE_IDS } from "@room/schemas";
import {
  CONTROLLER_CODEX_NODE,
  CONTROLLER_NODE,
  LOCAL_RECOMMENDED_NODES,
  RECOMMENDED_AGENTS,
  RECOMMENDED_NODES,
  USER_PC_NODE,
} from "../lib/presets";

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
    // ADR-003 §2a / D-40：主控机一位秘书一个节点，林离必须在 7421，不然新装的库（已经是 v13）会把林离发到 7420
    assert.equal(RECOMMENDED_AGENTS.find((a) => a.id === "deepseek")?.nodeId, CONTROLLER_NODE);
    assert.equal(RECOMMENDED_AGENTS.find((a) => a.id === "codex")?.nodeId, CONTROLLER_CODEX_NODE);
  });

  it("local nodes match the C-44 whitelist and ports", () => {
    const urls = Object.fromEntries(RECOMMENDED_NODES.map((n) => [n.id, n.baseUrl]));
    assert.equal(urls[CONTROLLER_NODE], "http://127.0.0.1:7420");
    assert.equal(urls[CONTROLLER_CODEX_NODE], "http://127.0.0.1:7421");
    assert.deepEqual(LOCAL_RECOMMENDED_NODES.map((n) => n.id).sort(), [...LOCAL_NODE_IDS].sort());
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

  it("node.importLocalToken only works on loopback whitelist nodes, then node.test works without typing a token", async () => {
    const bridge = createMockBridge({ tickMs: 1, reviewerConfigured: true });
    const raw = (req: Record<string, unknown>) => bridge.command(req as never) as unknown as Promise<{ ok: boolean; error?: string }>;
    const ok = <T>(req: Record<string, unknown>) => call<T>(bridge.command(req as never) as never);

    // 种子节点和推荐配置一致：林离在 7421
    const seeded = await call<NodeInfo[]>(bridge.query({ type: "nodes.list" } as never) as never);
    assert.equal(seeded.find((n) => n.id === CONTROLLER_CODEX_NODE)?.baseUrl, "http://127.0.0.1:7421");

    // 换了地址、Token 作废，再从本机导入
    const moved = await ok<NodeInfo>({ type: "node.upsert", id: CONTROLLER_CODEX_NODE, label: "主控机（林离）", baseUrl: "http://localhost:7421" });
    assert.equal(moved.tokenConfigured, false);
    const info = await ok<NodeInfo>({ type: "node.importLocalToken", id: CONTROLLER_CODEX_NODE });
    assert.equal(info.tokenConfigured, true);
    const test = await ok<{ reachable: boolean }>({ type: "node.test", id: CONTROLLER_CODEX_NODE, baseUrl: "http://localhost:7421", profileId: "codex-discuss" });
    assert.equal(test.reachable, true);

    await ok({ type: "node.upsert", id: CONTROLLER_NODE, label: "主控机（汐）", baseUrl: "http://10.0.0.5:7420" });
    assert.equal((await raw({ type: "node.importLocalToken", id: CONTROLLER_NODE })).error, "invalid_state", "non-loopback address is refused");
    assert.equal((await raw({ type: "node.importLocalToken", id: USER_PC_NODE })).error, "validation_failed", "only whitelisted ids");
  });
});
