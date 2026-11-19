'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');

const [outArg, beforeArg, afterArg, baselineArg, electronArg, phase = 'timing'] = process.argv.slice(2);
assert([outArg, beforeArg, afterArg, baselineArg, electronArg].every(Boolean));
assert(['timing', 'candidate-photos', 'before', 'after'].concat('preflight').includes(phase));
const out = path.resolve(outArg);
const fixtures = { before: path.resolve(beforeArg), after: path.resolve(afterArg) };
const baseline = path.resolve(baselineArg);
const electron = path.resolve(electronArg);
const tools = path.join(__dirname, 'x51-r8-evidence');
const audit = 'D:/codex/2026-11-16/world-implementation/world-request-audit/apps/desktop/e2e/fixtures/world-base';
const json = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const digest = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const git = (arm, ...args) => execFileSync('git', [
  '-c', 'safe.directory=' + path.resolve(fixtures[arm], '../../../../..').split(path.sep).join('/'), ...args,
], { cwd: fixtures[arm], encoding: 'utf8', windowsHide: true }).trim();
const sources = { before: git('before', 'rev-parse', 'HEAD'), after: git('after', 'rev-parse', 'HEAD') };
assert.notEqual(sources.before, sources.after);
git('after', 'merge-base', '--is-ancestor', sources.before, sources.after);

const cameras = json(path.join(tools, 'cameras.json'));
const photoReport = json(path.join(baseline, 'report.json'));
assert.equal(photoReport.source, sources.before);
assert(photoReport.complete && photoReport.transportAudit.payloadIntegrityClean);
assert.deepEqual(photoReport.exceptions, []);
for (const v of cameras) {
  const photo = photoReport.photos[v.name];
  assert.deepEqual(photo.eye, v.eye);
  assert.deepEqual(photo.view.target, v.target);
  assert.deepEqual(photo.canvas, [1440, 900]);
  assert.equal(photo.fov, v.fov);
  assert.equal(photo.time, 14);
  assert.equal(photo.timeOfDay, 'evening');
  assert.match(photo.gpu, /RTX 3060 Laptop GPU.*Direct3D11/);
  assert.equal(digest(path.join(baseline, v.name + '.png')), photo.hashes[2]);
}

if (phase === 'preflight') {
  console.log(JSON.stringify({ sources, baseline, verifiedPhotos: cameras.length, output: out }));
  process.exit(0);
}

const receipt = path.join(out, 'sources.json');
const setup = { sources, baselinePhotoDirectory: baseline, baselineReportSha256: digest(path.join(baseline, 'report.json')) };
if (fs.existsSync(receipt)) {
  assert.deepEqual(json(receipt), setup);
} else {
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(receipt, JSON.stringify(setup, null, 2) + '\n', { flag: 'wx' });
}

const state = path.join(out, 'running-state.json');
const runs = fs.existsSync(state) ? json(state) : [];
const recordState = () => fs.writeFileSync(state, JSON.stringify(runs, null, 2) + '\n');
function run(test, arm) {
  const fixture = fixtures[arm];
  const id = 'x51-next-' + arm + '-' + randomUUID().slice(0, 12);
  const photo = test === 'photos';
  const output = photo ? path.join(out, 'photos-after') : path.join(fixture, 'artifacts', id);
  if (!photo) fs.mkdirSync(path.dirname(output), { recursive: true });
  const script = photo ? 'ground-photos.cjs' : 'timing-eight.cjs';
  const args = photo ? [electron, output, 'on'] : [electron, id];
  const log = path.join(out, id + '.log');
  const fd = fs.openSync(log, 'wx');
  const row = { test, arm, id, source: sources[arm], fixture, output, log, started: new Date().toISOString() };
  runs.push(row);
  recordState();
  let proc;
  try {
    proc = spawnSync(process.execPath, [path.join(tools, script), ...args], {
      cwd: fixture,
      env: { ...process.env, WORLD_FIXTURE: fixture, AUDIT_FIXTURE: audit, TESTED_SOURCE: sources[arm] },
      windowsHide: true,
      stdio: ['ignore', fd, fd],
    });
  } finally {
    fs.closeSync(fd);
  }
  row.status = proc.status ?? 1;
  row.ended = new Date().toISOString();
  recordState();
  if (proc.error) throw proc.error;
  if (row.status !== 0) throw Error(test + ' ' + arm + ' failed. Read ' + log);
}

if (phase === 'timing') {
  for (const arm of ['before', 'after']) {
    if (!runs.some(r => r.test === 'timing' && r.arm === arm)) run('timing', arm);
  }
} else if (phase === 'candidate-photos') {
  assert(!runs.some(r => r.test === 'photos'), 'Use a fresh evidence directory for a new photo attempt.');
  run('photos', 'after');
} else {
  assert(runs.some(r => r.test === 'timing' && r.arm === phase), 'Run the base timing pair before requesting an extra arm.');
  assert(runs.filter(r => r.test === 'timing').length < 3, 'Three timing launches already recorded.');
  run('timing', phase);
}
console.log(JSON.stringify(runs.map(({ test, arm, id, status, output }) => ({ test, arm, id, status, output }))));
