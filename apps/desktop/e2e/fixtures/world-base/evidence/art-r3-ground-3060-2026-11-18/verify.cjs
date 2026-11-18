'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const read = (...parts) => JSON.parse(fs.readFileSync(path.join(__dirname, ...parts), 'utf8'));
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const previousPhotos = read('../art-r2-ground-3060-2026-11-18/photos.json').photos;
const on = read('photos.json');
const off = read('ground-off', 'photos.json');
const comparisons = read('image-comparison.json');
assert(on.complete && off.complete);
assert.equal(on.source, off.source);
assert.equal(on.photos['art-a-street'].special.enabled, true);
assert.equal(off.photos['art-a-street'].special.enabled, false);
const names = Object.keys(comparisons);
assert.equal(names.length, 8);
for (const name of names) {
  const previous = previousPhotos[name];
  for (const [capture, directory] of [[on, ''], [off, 'ground-off']]) {
    const image = capture.photos[name];
    assert.equal(image.hashes[2], digest(path.join(__dirname, directory, image.file)));
    assert.equal(image.current, name);
    assert.deepEqual(image.eye, previous.eye);
    assert.deepEqual(image.quaternion, previous.quaternion ?? previous.quat);
    assert.deepEqual(image.view.target, previous.view.target);
    assert.equal(image.fov, previous.fov);
    assert.equal(image.time, 14);
    assert.equal(image.islandTime, 14);
    assert.equal(image.timeOfDay, 'evening');
    assert.equal(image.glError, 0);
    assert.deepEqual(image.errors, []);
    assert(image.hidden && image.buttonActive);
    assert.deepEqual(image.canvas, [1440, 900]);
    assert.match(image.gpu, /RTX 3060 Laptop/);
  }
}
assert.equal(on.source, '47a5c12eba910682ccbf8bc9138510bc01737bf3');
const special = on.photos['art-a-street'].special;
assert.equal(special.plan.source, 'baked');
assert.equal(special.plan.rays, 0);
assert.deepEqual(special.artStation.nobori, {flags: 14, triangles: 1512, clothTriangles: 336});
assert.deepEqual(special.artStation.shopBoards, ['W2', 'W4', 'W6', 'E3', 'E5']);
assert(comparisons['art-b-konbini'].previousToCurrent.changedGt8 > 0);
for (const name of ['art-d-laundry','sample-g-rail','sample-h-north']) {
  assert.equal(on.photos[name].hashes[2], previousPhotos[name].hashes[2]);
}
const plan = read('retained-decals.json');
const originals = read('../art-r1-ground-3060-2026-11-18/decal-repair/runtime-weathering-plan.json');
assert.deepEqual(plan.plan.items, originals.items);
assert.equal(plan.rows.length, 26);
assert.equal(plan.rows.filter(r => r.curvedException).length, 4);
for (const row of plan.rows) {
  assert.equal(row.identicalInRuntimeIndex, row.index);
  assert.equal(row.extraGeometryInFront, 0);
  if (row.curvedException) {
    assert(row.curvedSnap.atOldCenter.pass && row.curvedSnap.atSourceDirective.pass);
  } else {
    assert(row.ninePass);
    assert.equal(row.passed, 9);
  }
}
console.log('Verified 16 native PNGs, eight matching poses, ground on/off and 26 retained decal supports.');
