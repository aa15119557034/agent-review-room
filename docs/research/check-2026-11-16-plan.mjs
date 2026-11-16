// Document consistency only; does not execute upstream software or call paid APIs.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const files = [
  'docs/design/ADR-007-Super-Agent-工作台.md',
  'docs/phase2-候选任务.md',
  'docs/research/2026-11-16-deepseek-integration.md',
];
let localLinks = 0;
const documents = new Map();
for (const file of files) {
  const body = readFileSync(resolve(root, file), 'utf8');
  documents.set(file, body);
  assert.equal((body.match(/^```/gm) ?? []).length % 2, 0, `Unclosed fence: ${file}`);
  assert(!/^(<<<<<<<|=======|>>>>>>>) /m.test(body), `Conflict marker: ${file}`);
  for (const [, link] of body.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    if (/^(https?:|#)/.test(link)) continue;
    const target = resolve(root, dirname(file), decodeURIComponent(link.split('#')[0]));
    assert(existsSync(target), `Broken local link: ${file} -> ${link}`);
    localLinks++;
  }
}
const board = documents.get(files[1]);
const rows = [...board.matchAll(/^\| (P2-[A-Z]\d+) \|([^\n]+)$/gm)];
const taskIds = rows.map(m => m[1]);
assert.equal(taskIds.length, 42, 'Candidate count drift');
assert.equal(new Set(taskIds).size, taskIds.length, 'Duplicate candidate ID');
const allText = [...documents.values()].join('\n');
for (const id of allText.match(/P2-[A-Z]\d+/g) ?? []) {
  assert(taskIds.includes(id), `Undefined candidate: ${id}`);
}
// Conservatively include every named dependency, including alternative-runtime paths.
// Stage prose is manually reviewed; this check covers explicit task-to-task edges.
const edges = new Map(rows.map(m => [m[1], m[2].split('|')[2].match(/P2-[A-Z]\d+/g) ?? []]));
const done = new Set();
function visit(id, chain = []) {
  assert(!chain.includes(id), `Dependency cycle: ${[...chain, id].join(' -> ')}`);
  if (done.has(id)) return;
  for (const dep of edges.get(id)) visit(dep, [...chain, id]);
  done.add(id);
}
for (const id of taskIds) visit(id);
const faults = [...board.matchAll(/^\| (F\d+) \|/gm)].map(m => m[1]);
assert.deepEqual(faults, Array.from({ length: 39 }, (_, n) => `F${String(n + 1).padStart(2, '0')}`));
const index = JSON.parse(readFileSync(resolve(root, 'docs/research/2026-11-16-deepseek-sources.json'), 'utf8'));
assert.equal(index.repositories.length, 3);
assert.equal(new Set(index.repositories.map(r => r.repository)).size, 3);
assert(/^[a-f0-9]{40}$/.test(index.project.baseCommit), 'Invalid project commit');
for (const repo of index.repositories) {
  assert(/^[a-f0-9]{40}$/.test(repo.commit), `Invalid upstream commit: ${repo.repository}`);
  for (const file of repo.files) {
    assert.equal(file.url, `https://github.com/${repo.repository}/blob/${repo.commit}/${file.path}`);
  }
}
assert.equal(new Set(index.serviceDocs.map(d => d.id)).size, index.serviceDocs.length);
for (const doc of index.serviceDocs) assert.equal(new URL(doc.url).hostname, 'api-docs.deepseek.com');
assert(documents.get(files[0]).includes(index.project.baseCommit));
assert(documents.get(files[2]).includes(index.project.baseCommit));
console.log(`PASS: ${files.length} Markdown files; ${localLinks} local links; 42 unique candidates; explicit dependency graph acyclic; F01-F39 continuous; 3 pinned upstreams; ${index.serviceDocs.length} official API references.`);
console.log('NOT RUN: upstream runtimes, paid APIs, application tests, Windows integration, data migration.');
