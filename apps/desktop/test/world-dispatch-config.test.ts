import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorldBudgetStore, ulid } from '@room/db';
import { AgentProfile, DEFAULT_AGENT_MODEL_SETTINGS } from '@room/schemas';
import { WorldCognitionRunner } from '../src/main/world-cognition';
import { WorldRunFenceBarrier } from '../src/main/world-run-fence';
import { resolveWorldNode, resolveWorldFence } from '../src/main/world-node';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

for (const change of ['pause', 'model', 'profile', 'url'] as const) test(change + ' during final bound health must prevent POST', { timeout: 10000 }, async () => {
  const entered = deferred(), release = deferred();
  let healthCalls = 0;
  const posts: unknown[] = [];
  const fenced = new Set<string>();
  const ledgerId = 'rled_' + ulid();
  const server = createServer(async (req, res) => {
    const json = (value: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (req.url === '/v1/health') {
      if (++healthCalls === 3) { entered.resolve(); await release.promise; }
      return json({ protocol: 1, nodeId: 'test-node', profiles: ['source-chat', 'target-world'], activeRuns: 0, maxConcurrentRuns: 1, leaseMs: 100, heartbeatMs: 20,
        profileModels: ['source-chat', 'target-world'].map(profileId => ({ profileId, models: [{ id: 'original-model', displayName: 'Original', efforts: [], defaultEffort: null }] })),
        capabilities: { runFence: { version: 1, ledgerId }, worldProfiles: [{ profileId: 'target-world', sourceChatProfileId: 'source-chat', recipeVersion: 'deepseek-http-v1', sourceDefaultModel: { model: 'original-model', effort: null } }] } });
    }
    if (req.method === 'POST' && req.url === '/v1/runs') {
      let body = '';
      for await (const chunk of req) body += chunk.toString();
      posts.push(JSON.parse(body));
      return json({ error: 'node_busy', message: 'review fixture records but never launches a model' }, 429);
    }
    if (req.url?.endsWith('/cancel')) { fenced.add(req.url.split('/')[3]!); return json({ ok: true }, 202); }
    if (req.url?.endsWith('/proof')) { const runId = req.url.split('/')[3]!; return json({ runId, ledgerId, status: fenced.has(runId) ? 'fenced_never_started' : 'missing' }); }
    return json({ error: 'not_found' }, 404);
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture listen failed');
  let baseUrl = 'http://127.0.0.1:' + address.port;
  const resident = AgentProfile.parse({ id: 'deepseek', displayName: 'DeepSeek', color: '#557799', avatarRef: null, roleNote: '', canDiscuss: true, canSummarize: true, canExecute: false,
    nodeId: 'test-node', profileId: 'source-chat', pausedByUser: false, substitute: null, modelSettings: structuredClone(DEFAULT_AGENT_MODEL_SETTINGS), chatPersona: '', chatProfileId: 'source-chat', memorySource: { nodeFolder: false } });
  const deps = { repo: { listAgents: () => [structuredClone(resident)], getNodeRow: () => ({ id: 'test-node', base_url: baseUrl }) }, settings: { getNode: () => ({ baseUrl, token: 'fake-token-'.repeat(6) }) } };
  const budget = new WorldBudgetStore(join(mkdtempSync(join(tmpdir(), 'independent-late-config-')), 'usage.sqlite'));
  const fence = new WorldRunFenceBarrier({ budget, resolve: binding => resolveWorldFence(deps, binding) });
  const runner = new WorldCognitionRunner({ budget, fence, resolve: (agent, signal) => resolveWorldNode(deps, agent, signal), foregroundBusy: () => false, emitBudget: () => {} });
  let requested: Promise<void> | undefined;
  try {
    requested = runner.request({ worldId: 'world_' + ulid(), generation: { session: 'wses_' + ulid(), runSeq: 1 }, agent: 'deepseek', sceneId: null, priority: 'player', limit: 3, prompt: 'fixture',
      isCurrent: () => true, onReply: async () => assert.fail('fixture must not supply a reply'), onMode: async () => {}, onSettled: async () => {} });
    await entered.promise;
    if (change === 'pause') resident.pausedByUser = true;
    else if (change === 'model') resident.modelSettings.chat = { model: 'different-model', effort: null };
    else if (change === 'profile') resident.chatProfileId = 'different-chat';
    else baseUrl += '/changed';
    release.resolve();
    await requested;
    assert.equal(posts.length, 0, 'paused resident must not dispatch after the delayed final health response');
  } finally {
    release.resolve();
    await Promise.allSettled([requested]);
    budget.close();
    server.closeAllConnections();
    await new Promise<void>(r => server.close(() => r()));
  }
});
