import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import { sha256Hex } from "@room/core";
import { openDatabase, previewProjectSource, WriteQueue, type RunRow } from "@room/db";
import type { ControlEvent } from "@room/schemas";
import { ServerConfig } from "../../agent-server/src/config";
import { createAgentServer } from "../../agent-server/src/server";
import { Repository } from "../src/main/repository";
import { SettingsStore } from "../src/main/settings";
import { ProjectResearchService } from "../src/main/project-research";
import { RunOrchestrator } from "../src/main/orchestrator";

const TOKEN = "e2e-controller-token-".repeat(3), KEY = "e2e-provider-secret-do-not-persist", TEXT = "# 原始资料\r\n  🧪 Unicode 和空白完整保留\n";
function deferred() { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; }

for (const mode of ["success", "empty", "fetch-failed", "cancel-fetch"] as const) {
  it(`P2-X12 HTTP node + Search/Fetch process + main + DB: ${mode}`, { timeout: 20000 }, async () => {
    const calls: { path: string; body: unknown }[] = [], reached = deferred(), completed = deferred();
    let held: ServerResponse | undefined;
    const provider = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      calls.push({ path: req.url!, body: JSON.parse(raw) });
      if (req.headers.authorization !== "Bearer " + KEY) { res.writeHead(401).end(); return; }
      if (req.url === "/v1/tools/search") {
        res.end(JSON.stringify({ results: mode === "empty" ? [] : [{ url: "https://example.com/original", title: "<script>title</script>", summary: "not the original" }] }));
      } else {
        reached.resolve();
        if (mode === "cancel-fetch") { held = res; return; }
        if (mode === "fetch-failed") { res.writeHead(404).end(KEY); return; }
        res.end(JSON.stringify({ title: "<script>inert title</script>", content: TEXT }));
      }
    });
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const providerUrl = "http://127.0.0.1:" + (provider.address() as AddressInfo).port;
    const node = createAgentServer(ServerConfig.parse({ nodeId: "research-node", maxConcurrentRuns: 1, leaseMs: 2000, heartbeatMs: 100, killGraceMs: 100,
      profiles: { research: { command: process.execPath, args: [fileURLToPath(new URL("../../agent-server/bin/deepseek-search-fetch.mjs", import.meta.url)), "--base-url", providerUrl], cwd: process.cwd(), parser: "room-jsonl", searchFetch: "deepseek-v1", env: { DEEPSEEK_API_KEY: KEY } } },
    }), TOKEN);
    await new Promise<void>((resolve) => node.server.listen(0, "127.0.0.1", resolve));
    const nodeUrl = "http://127.0.0.1:" + (node.server.address() as AddressInfo).port;
    const dir = mkdtempSync(join(tmpdir(), "room-research-e2e-")), db = openDatabase(join(dir, "room.db")), queue = new WriteQueue(), repo = new Repository(db, queue);
    const settings = new SettingsStore(join(dir, "settings.json"), { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() });
    await repo.upsertNodeRow({ id: "research-node", label: "Research", baseUrl: nodeUrl });
    settings.upsertNode("research-node", { baseUrl: nodeUrl, token: TOKEN });
    const project = await repo.createProject("P2-X12 isolated research");
    const events: ControlEvent[] = [];
    const emit = (event: ControlEvent) => { events.push(event); if (event.type === "run.updated" && ["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"].includes(event.run.state)) completed.resolve(); };
    let service!: ProjectResearchService;
    const orchestrator = new RunOrchestrator({ db, queue, emit, idleTimeoutMs: 5000, totalTimeoutMs: 12000, getRun: (id) => db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunRow | undefined, adapterFactory: (run, signal) => service.createAdapter(run, signal) });
    service = new ProjectResearchService({ db, queue, repo, settings, orchestrator, emit });
    try {
      const preview = await service.prepare({ type: "research.prepare", projectId: project.id, nodeId: "research-node", profileId: "research", query: "公开的 Unicode 资料" });
      assert.equal(calls.length, 0, "prepare only probes health");
      const approved = await service.approve({ type: "research.approve", approvalId: preview.approval.id, expectedSnapshotHash: preview.snapshot.contentHash, expectedResearchHash: preview.researchHash });
      if (mode === "cancel-fetch") { await reached.promise; assert.equal(orchestrator.cancel(approved.run.id), true); held?.end(JSON.stringify({ title: "too late", content: TEXT })); }
      await completed.promise;
      await queue.drain();
      const result = service.result({ type: "research.result", projectId: project.id, runId: approved.run.id });
      assert.equal(result.run.state, mode === "fetch-failed" ? "FAILED" : mode === "cancel-fetch" ? "CANCELLED" : "COMPLETED");
      assert.equal(calls.filter((call) => call.path === "/v1/tools/search").length, 1);
      assert.equal(calls.filter((call) => call.path === "/v1/tools/fetch").length, mode === "empty" ? 0 : 1);
      assert.equal(repo.listMessages(project.id).length, mode === "success" ? 1 : 0);
      assert.equal(events.filter((event) => event.type === "message.created").length, mode === "success" ? 1 : 0);
      assert.equal(JSON.stringify(events).includes(KEY), false);
      assert.equal(JSON.stringify(result).includes(TOKEN), false);
      if (mode === "success") {
        const original = repo.getMessage(result.originalMessageId!);
        assert.equal(original.kind, "source_input");
        assert.equal(original.content, TEXT);
        assert.equal(original.sourceRefs?.[0]?.contentHash, sha256Hex(TEXT));
        const events = repo.listEvents(approved.run.id, -1);
        assert.equal(events.filter((e) => e.type === "completed").length, 1);
        const stored = db.prepare("SELECT type, payload FROM run_events WHERE run_id = ? ORDER BY seq").all(approved.run.id) as { type: string; payload: string }[];
        const bodyIndex = stored.findIndex((e) => e.type === "message_complete"), citationIndex = stored.findIndex((e) => e.type === "result_display" && JSON.parse(e.payload).result.block.kind === "citation");
        assert.ok(bodyIndex >= 0 && citationIndex > bodyIndex);
        const backup = join(dir, "backup.db");
        await db.backup(backup);
        const restored = openDatabase(backup);
        try { assert.equal(previewProjectSource(restored, { type: "sources.preview", projectId: project.id, owner: { kind: "message", id: original.id }, index: 0 }).content, TEXT); }
        finally { restored.close(); }
      } else assert.equal(result.originalMessageId, null);
      if (mode !== "cancel-fetch") {
        const usage = result.blocks.find((b) => b.kind === "usage");
        assert.ok(usage?.kind === "usage");
        assert.deepEqual(usage.toolCalls, { status: "measured", value: calls.length });
        assert.equal(usage.cost.status, "unknown");
      }
      assert.equal((db.prepare("SELECT count(*) AS n FROM turns").get() as { n: number }).n, 0);
    } finally {
      service.invalidate(); orchestrator.cancelAll();
      await queue.drain();
      held?.destroy(); await node.close();
      provider.closeAllConnections();
      await new Promise<void>((resolve) => provider.close(() => resolve()));
      db.close();
    }
  });
}
