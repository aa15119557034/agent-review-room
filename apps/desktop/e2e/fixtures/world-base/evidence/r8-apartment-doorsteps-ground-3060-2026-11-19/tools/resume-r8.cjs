'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync, execFileSync } = require('node:child_process');

const [runtime, tag = 'r8-retry-1119a'] = process.argv.slice(2);
assert(runtime && /^[A-Za-z0-9_-]+$/.test(tag));
const dir = __dirname;
const root = path.dirname(dir);
const fixturePath = 'apps/desktop/e2e/fixtures/world-base';
const audit = path.join('D:/codex/2026-11-16/world-implementation/world-request-audit', fixturePath);
const sources = JSON.parse(fs.readFileSync(path.join(dir, 'sources.json'), 'utf8'));
const stateFile = path.join(dir, 'running-state.json');
const previous = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const sequence = [
  ['photos', 'before'], ['photos', 'after'],
  ['timing', 'before'], ['timing', 'after'], ['timing', 'after'], ['timing', 'before'],
  ['legacy', 'before'], ['legacy', 'after'],
];
const failedIndex = previous.findIndex(s => s.status !== 0);
assert(failedIndex === -1 || failedIndex === previous.length - 1);
const records = previous.slice(0, failedIndex === -1 ? previous.length : failedIndex);
assert(records.length < sequence.length);
for (const [i, entry] of records.entries()) {
  const [test, arm] = sequence[i];
  assert.deepEqual([entry.i, entry.test, entry.arm, entry.status, entry.sha],
    [i, test, arm, 0, arm === 'before' ? sources.base : sources.after]);
}
fs.writeFileSync(path.join(dir, tag + '-prior-state.json'), JSON.stringify(previous, null, 2) + '\n', {flag:'wx'});

if (failedIndex >= 0) {
  const failed = previous[failedIndex];
  assert.deepEqual([failed.test, failed.arm], sequence[failedIndex]);
  if (failed.test !== 'timing') {
    const fixed = failed.test + '-' + failed.arm;
    const oldOutput = path.join(dir, fixed);
    if (fs.existsSync(oldOutput)) fs.renameSync(oldOutput, path.join(dir, tag + '-prior-' + fixed));
  }
}

for (let i = records.length; i < sequence.length; i += 1) {
  const [test, arm] = sequence[i];
  const worktree = path.join(root, arm === 'before' ? 'x51-r7-after' : 'x51-r8-after');
  const fixture = path.join(worktree, fixturePath);
  const sha = arm === 'before' ? sources.base : sources.after;
  const repo = worktree.split(path.sep).join('/');
  const head = execFileSync('git', ['-c', 'safe.directory=' + repo, 'rev-parse', 'HEAD'],
    { cwd: fixture, encoding:'utf8', windowsHide:true }).trim();
  assert.equal(head, sha);
  const id = tag + '-' + i + '-' + arm;
  const args = test === 'timing'
    ? [path.join(dir,'timing-eight.cjs'), path.resolve(runtime), id]
    : test === 'photos'
      ? [path.join(dir,'ground-photos.cjs'), path.resolve(runtime), path.join(dir,'photos-' + arm), 'on']
      : [path.join(dir,'legacy-sixth.cjs'), path.resolve(runtime), fixture, audit, sha, path.join(dir,'legacy-' + arm)];
  const log = path.join(dir,id + '.log');
  const fd = fs.openSync(log,'wx');
  const record = {i,test,arm,fixture,sha,id,started:new Date().toISOString()};
  records.push(record);
  const save = () => fs.writeFileSync(stateFile, JSON.stringify(records,null,2) + '\n');
  save();
  let result;
  try {
    result = spawnSync(process.execPath,args,{
      cwd:fixture,env:{...process.env,WORLD_FIXTURE:fixture,AUDIT_FIXTURE:audit,TESTED_SOURCE:sha},
      windowsHide:true,stdio:['ignore',fd,fd],
    });
  } finally {
    fs.closeSync(fd);
  }
  record.status = result.status ?? 1;
  record.ended = new Date().toISOString();
  save();
  if (result.error || result.status !== 0) {
    throw Error(test + ' ' + arm + ' ' + fs.readFileSync(log,'utf8').slice(-1500));
  }
}
console.log(records.map(r=>[r.test,r.arm,r.status]));
