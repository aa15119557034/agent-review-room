'use strict';
// node reproduce.cjs verify
// node reproduce.cjs photos|timing <installed Electron executable> <new artifacts folder>
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { gunzipSync } = require('node:zlib');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const read = name => fs.readFileSync(path.join(__dirname, name));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function verifyRun(timing, pictures) {
  const packed = read(timing.samples.file);
  assert.equal(sha256(packed), timing.samples.sha256);
  const raw = JSON.parse(gunzipSync(packed));
  assert.deepEqual(Object.keys(raw), Object.keys(timing.segments));
  assert.equal(Object.keys(raw).length, 6);
  let total = 0;
  for (const [name, rows] of Object.entries(raw)) {
    const t = timing.segments[name];
    assert.equal(sha256(JSON.stringify(rows)), t.samplesSha256);
    assert.equal(rows.length, t.frames);
    assert(rows.every(row => row.ms > 0 && row.calls > 0 && row.triangles > 0));
    const sorted = rows.map(row => row.ms).sort((a, b) => a - b);
    const elapsed = rows.reduce((sum, row) => sum + row.ms, 0);
    assert.equal(elapsed, t.durationMs);
    assert.equal(1000 * rows.length / elapsed, t.fps);
    assert.equal(sorted[Math.ceil(rows.length * 0.95) - 1], t.p95Ms);
    assert.equal(sorted[Math.ceil(rows.length * 0.99) - 1], t.p99Ms);
    assert.equal(sorted.at(-1), t.maxMs);
    assert.equal(t.pass, t.fps >= timing.threshold.fps && t.p95Ms <= timing.threshold.p95Ms);
    if (t.walk) assert(t.walk.distanceXZ > 1);
    total += rows.length;
  }
  for (const image of Object.values(pictures)) {
    const cam = timing.segments[image.observed].camera;
    assert.deepEqual(cam.position, image.eye);
    assert.deepEqual(cam.quaternion, image.quat);
    assert.deepEqual(cam.target, image.view.target);
    assert.equal(cam.fov, image.fov);
  }
  const plan = timing.readiness.plan;
  assert.equal(plan.observed.fingerprint, plan.observedFingerprint);
  assert.equal(plan.observed.items.length, plan.itemCount);
  if (plan.source === 'baked') {
    assert(plan.matchesCheckedInPlan);
    assert.equal(plan.runtimePlanningRayCount, 0);
    assert.equal(plan.observedFingerprint, plan.bakedFingerprint);
  }
  return total;
}

const [mode, ...args] = process.argv.slice(2);
if (mode === 'verify') {
  const report = JSON.parse(read('report.json'));
  const pictures = report.photos.pictures;
  assert.equal(Object.keys(pictures).length, 4);
  for (const image of Object.values(pictures)) {
    assert.equal(sha256(read(image.file)), image.hashes.at(-1));
    assert.deepEqual(image.dimensions, [1440, 900]);
    assert.equal(image.hidden, true);
    assert.equal(image.stationTime, 14);
    assert.equal(image.islandTime, 14);
  }
  for (const key of ['timing', 'confirmation']) {
    if (report[key]) console.log(key + ': verified 4 images, 6 routes, ' + verifyRun(report[key], pictures) + ' RAF samples.');
  }
} else {
  assert(['photos', 'timing'].includes(mode) && args.length === 2);
  const driver = path.resolve(__dirname, '../reproduce.cjs');
  const run = spawnSync(process.execPath, [driver, mode, ...args], { stdio: 'inherit', windowsHide: true });
  if (run.error) throw run.error;
  process.exitCode = run.status ?? 1;
}
