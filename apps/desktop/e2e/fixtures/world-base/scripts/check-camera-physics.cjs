const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function main() {
  const root = path.resolve(__dirname, '..');
  const vendor = pathToFileURL(path.join(root, 'upstream/petalwake/vendor/three/build/three.module.js')).href;
  const source = fs.readFileSync(path.join(root, 'upstream/sakuragaoka/src/core/physics.js'), 'utf8')
    .replace("from 'three'", `from '${vendor}'`);
  const { Physics } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  const point = (x, y, z) => ({ x, y, z });
  const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} != ${expected}`);
  let checks = 0;
  const test = (name, run) => { run(); checks++; console.log('PASS', name); };
  test('thin wall blocks a full segment; camera above its top stays clear', () => {
    const p = new Physics(() => -100); p.addBox(0, 0, 8, 0.1, 0, 0, 2);
    close(p.sweepSphere(point(0, 1, 2), point(0, 1, -2), 0.25), (2 - 0.05 - 0.25) / 4);
    close(p.sweepSphere(point(0, 2.3, 2), point(0, 2.3, -2), 0.25), 1);
  });
  test('rotated and translated OBB gives the same physical clearance', () => {
    const p = new Physics(() => -100), angle = Math.PI / 4;
    p.addBox(30, -15, 8, 0.1, angle, 4, 6);
    const from = point(30 + 2 * Math.sin(angle), 5, -15 + 2 * Math.cos(angle));
    const to = point(30 - 2 * Math.sin(angle), 5, -15 - 2 * Math.cos(angle));
    close(p.sweepSphere(from, to, 0.25), (2 - 0.05 - 0.25) / 4);
  });
  test('cylinder sweep uses its radius and vertical interval', () => {
    const p = new Physics(() => -100); p.addCylinder(0, 0, 0.5, 1, 2);
    close(p.sweepSphere(point(2, 1.5, 0), point(-2, 1.5, 0), 0.25), (2 - 0.75) / 4);
    close(p.sweepSphere(point(2, 3, 0), point(-2, 3, 0), 0.25), 1);
    close(p.sweepSphere(point(0, 3, 0), point(0, 0, 0), 0.25), 0.25);
  });
  test('initial overlap returns zero rather than forcing a positive boom', () => {
    const p = new Physics(() => -100); p.addBox(0, 0, 1, 1, 0, 0, 3);
    close(p.sweepSphere(point(0, 1, 0), point(0, 1, 4), 0.25), 0);
  });
  test('walkable tops and sloped ramps have real height, not infinite walls', () => {
    const p = new Physics(() => -100); p.addWalkBox(0, 0, 3, 3, 0, 1, 0);
    close(p.sweepSphere(point(0, 3, 0), point(0, 0, 0), 0.25), 1.75 / 3);
    const ramp = new Physics(() => -100); ramp.addWalkRamp(0, 0, 3, 4, 0, 0, 2);
    close(ramp.sweepSphere(point(0, 3, 0), point(0, 0, 0), 0.25), (2 - 0.25 * Math.hypot(1, 0.5)) / 3);
  });
  test('dynamic door refresh removes its camera collision when open', () => {
    const p = new Physics(() => -100); let open = false;
    p.addDynamic(() => open ? [] : [{ cx: 0, cz: 0, w: 2, d: 0.1, y0: 0, y1: 3 }]);
    p.refreshDynamic(); assert.ok(p.sweepSphere(point(0, 1, 2), point(0, 1, -2), 0.25) < 1);
    open = true; p.refreshDynamic(); close(p.sweepSphere(point(0, 1, 2), point(0, 1, -2), 0.25), 1);
  });
  test('downward camera boom stops above terrain', () => {
    const p = new Physics(() => 0);
    assert.ok(Math.abs(p.sweepSphere(point(0, 2, 0), point(0, -2, 0), 0.25) - 1.75 / 4) < 1e-4);
  });
  test('distant districts do not enter the local collision query', () => {
    const p = new Physics(() => -100);
    for (let n = 0; n < 10000; n++) p.addBox(100 + n * 5, 100, 2, 2, 0, 0, 3);
    p.addBox(0, 0, 8, 0.1, 0, 0, 2);
    assert.equal(p._query(0, 0, 2.25).size, 1);
    const started = performance.now();
    for (let n = 0; n < 10000; n++) p.sweepSphere(point(0, 1, 2), point(0, 1, -2), 0.25);
    console.log('10,000 local camera sweeps, ms:', +(performance.now() - started).toFixed(2));
  });
  console.log(`${checks} camera physics checks passed`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
