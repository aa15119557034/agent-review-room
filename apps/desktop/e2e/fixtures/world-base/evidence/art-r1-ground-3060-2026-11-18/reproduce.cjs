
'use strict';

// node reproduce.cjs verify
// node reproduce.cjs photos <existing Electron executable> <new artifacts subdirectory>
// node reproduce.cjs timing <existing Electron executable> <new artifacts subdirectory>
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { gunzipSync } = require('node:zlib');

const read = name => fs.readFileSync(path.join(__dirname, name));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const [mode, ...args] = process.argv.slice(2);

function verify() {
  const report = JSON.parse(read('report.json'));
  const packed = read(report.timing.samples.file);
  assert.equal(sha256(packed), report.timing.samples.sha256);
  const raw = JSON.parse(gunzipSync(packed));
  assert.deepEqual(Object.keys(raw), Object.keys(report.timing.segments));
  assert.equal(Object.keys(raw).length, 6);
  let total = 0;
  for (const [id, rows] of Object.entries(raw)) {
    const measured = report.timing.segments[id];
    assert.equal(sha256(JSON.stringify(rows)), measured.samplesSha256);
    assert.equal(rows.length, measured.frames);
    assert(rows.every(r => Number.isFinite(r.ms) && r.ms > 0 && r.calls > 0 && r.triangles > 0));
    const elapsed = rows.reduce((sum, frame) => sum + frame.ms, 0);
    const sorted = rows.map(r => r.ms).sort((a, b) => a - b);
    assert.equal(elapsed, measured.durationMs);
    assert.equal(1000 * rows.length / elapsed, measured.fps);
    assert.equal(sorted[Math.ceil(rows.length * .95) - 1], measured.p95Ms);
    assert.equal(sorted[Math.ceil(rows.length * .99) - 1], measured.p99Ms);
    assert.equal(sorted.at(-1), measured.maxMs);
    total += rows.length;
  }
  const pictures = Object.values(report.photos.pictures);
  assert.equal(pictures.length, 4);
  for (const photo of pictures) {
    const sampled = report.timing.segments[photo.view.name];
    assert.equal(sha256(read(photo.file)), photo.hashes.at(-1));
    assert.deepEqual(sampled.camera.position, photo.eye);
    assert.deepEqual(sampled.camera.quaternion, photo.quat);
    assert.equal(sampled.camera.fov, photo.fov);
  }
  console.log('Verified 4 native PNGs, 6 ground routes and ' + total + ' RAF intervals.');
}


// Keep the same fixed-camera and walking driver as the baseline. Take the optional
// diagnostic snapshot before its first warm-up without changing the live scene.
function makeTimingReplay(driver) {
  const fixture = path.resolve(__dirname, '../..');
  let source = fs.readFileSync(driver, 'utf8').replace(/\r\n/g, '\n');
  function patch(before, after) {
    assert.equal(source.split(before).length, 2, 'Expected one marker: ' + before);
    source = source.replace(before, () => after);
  }
  function readyAudit(){const w=window.worldBase;return {stages:w.stages,weatheringMs:w.weatheringMs,decals:w.weatheringDecals.stats,plan:w.weatheringDecals.plan,stationTimings:w.station.timings,moduleStats:w.station.moduleStats,stationArt:w.station.artR1?.stats??null,cityArt:w.city.stats?.artR1??null};}
  patch("p.resolve(__dirname, '../..')", JSON.stringify(fixture));
  patch("const reference=r(p.join(__dirname,'report.json'));", "const reference=r(" + JSON.stringify(path.join(path.dirname(driver), 'report.json')) + ");");
  const expression = '(' + readyAudit.toString() + ')()';
  const injected = [
    '  report.artReadiness=await evaluate(' + JSON.stringify(expression) + ');',
    "  fs.writeFileSync(path.join(config.output,'weathering-plan-observed.json'),JSON.stringify(report.artReadiness.plan,null,2)+'\\n');",
    '  delete report.artReadiness.plan;',
    "  stage('scene-ready');"
  ].join('\n');
  const flush = "write('source-manifest.json',source);";
  patch(flush, 'once("  stage(\'scene-ready\');",' + JSON.stringify(injected) + ');\n' + flush);
  patch('timeoutMs:400000', 'timeoutMs:1200000');
  const gpuCheck = "assert(/RTX 3060 Laptop/.test(summary.gpu));";
  patch(gpuCheck, 'summary.readiness={firstReadyFrameMs:report.firstReady.timing.firstReadyFrameMs,sceneReadyMs:report.firstReady.timing.sceneReadyMs,stageHistory:report.stageHistory,art:report.artReadiness};\n' + gpuCheck);
  const folder = fs.mkdtempSync(path.join(fixture, 'artifacts', 'r1-timing-driver-'));
  const runnable = path.join(folder, 'reproduce.cjs');
  fs.writeFileSync(runnable, source);
  return runnable;
}

if (mode === 'verify') {
  verify();
} else {
  assert(['photos', 'timing'].includes(mode), 'Use verify, photos or timing');
  assert.equal(args.length, 2, 'Pass an Electron executable and a new artifacts subdirectory');
  const driver = path.resolve(__dirname, '../art-baseline-2026-11-18/reproduce.cjs');
  const run = spawnSync(process.execPath, [mode === 'timing' ? makeTimingReplay(driver) : driver, mode, ...args], { stdio: 'inherit', windowsHide: true });
  if (run.error) throw run.error;
  process.exitCode = run.status ?? 1;
}
