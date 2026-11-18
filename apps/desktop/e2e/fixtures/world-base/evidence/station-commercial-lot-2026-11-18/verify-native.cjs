const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const read = file => fs.readFileSync(path.join(__dirname, file));
const json = file => JSON.parse(read(file));
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const photos = json('native/photos.json');
const pair = ['363034e', '2c876b3b'];
const receipts = pair.map(k => json('native/' + k + '/capture.json'));
for (const [key, row] of Object.entries(photos.photos)) {
  const file = (key === 'return-a' ? 'art-a-street' : key) + '.png';
  const [before, after] = receipts.map(r => r.photos[key]);
  for (const field of ['eye', 'quaternion', 'fov', 'canvas', 'time', 'islandTime', 'hidden']) {
    assert.deepEqual(before[field], after[field], key + ' ' + field);
  }
  assert.deepEqual(after.canvas, [1440, 900]);
  assert.equal(after.time, 14);
  for (const [index, input] of [before, after].entries()) {
    assert.equal(sha(read('native/' + pair[index] + '/' + file)), input.hashes[2]);
    assert.equal(input.glError, 0);
    assert.deepEqual(input.errors, []);
  }
  assert.equal(new Set(after.hashes).size, 1);
  assert.equal(row.candidateSHA256, after.hashes[2]);
  assert.equal(row.controlSHA256, before.hashes[2]);
  assert.equal(row.anyChange.pixels === 0, row.controlSHA256 === row.candidateSHA256);
}
const { runs } = json('performance/comparison.json');
assert.deepEqual(runs.map(r => r.role), ['candidate-first', 'control-repeat', 'candidate-repeat']);
for (const r of runs) {
  const prefix = 'performance/' + r.role;
  const sample = read(prefix + '.frames.json.gz'), native = json(prefix + '.report.json');
  assert.equal(sha(sample), native.samples.sha256);
  assert.equal(sha(sample), r.framesSha256);
  assert.equal(json(prefix + '.source.json').head, r.head);
  assert.equal(r.nativeExit, native.nativeExit);
  assert.equal(r.jsExceptions, 0);
  assert.equal(r.renderOk, true);
  const raw = JSON.parse(zlib.gunzipSync(sample));
  assert.equal(Object.keys(raw).length, 6);
  for (const [key, a] of Object.entries(raw)) {
    const v = r.routes[key], delta = a.map(x => x.ms);
    assert.equal(a.length, v.frames);
    assert.equal(sha(JSON.stringify(a)), native.segments[key].samplesSha256);
    assert.equal(1000 * a.length / delta.reduce((sum, ms) => sum + ms, 0), v.fps);
    assert.equal(delta.sort((x, y) => x - y)[Math.ceil(a.length * .95) - 1], v.p95Ms);
    assert.equal(v.pass, v.fps >= r.threshold.fps && v.p95Ms <= r.threshold.p95Ms);
  }
}
console.log('Verified original eight-camera pairs, repeat captures and all 18 measured segments.');
