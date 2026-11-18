'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const manifest = require('./manifest.json');
const summary = require('./phase-summary.json');
const historicalFiles = require('./existing/manifest.json');
const historical = require('./existing-intervals.json');

// JSON normalizes negative zero when the timing residual is rounded.
const rounded = number => 0 + Number(number.toFixed(3));

function readCompressed(file, expectedHash) {
  const bytes = fs.readFileSync(path.join(__dirname, file));
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), expectedHash, file);
  return JSON.parse(zlib.gunzipSync(bytes));
}

function quantile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * p) - 1];
}

function checkDistribution(rows, valueOf, report) {
  const values = rows.map(valueOf).filter(Number.isFinite);
  if (!values.length) {
    assert.equal(report, null);
    return;
  }
  assert.equal(report.n, values.length);
  assert.equal(report.min, rounded(Math.min(...values)));
  assert.equal(report.max, rounded(Math.max(...values)));
  assert.equal(report.p50, rounded(quantile(values, 0.5)));
  assert.equal(report.p95, rounded(quantile(values, 0.95)));
  assert.equal(report.mean, rounded(values.reduce((a, b) => a + b, 0) / values.length));
}

function checkProductionRows(rows, block) {
  assert.equal(block.frames, rows.length);
  checkDistribution(rows, x => x.next.stamp - x.stamp, block.raf);
  checkDistribution(rows, x => x.next.entry - x.entry, block.entryToNextEntry);
  checkDistribution(rows, x => x.exit - x.entry, block.callbackWall);
  checkDistribution(rows, x => x.stage.station, block.station);
  checkDistribution(rows, x => x.stage.walker, block.walker);
  checkDistribution(rows, x => x.stage.island, block.island);
  checkDistribution(rows, x => x.stage.render, block.renderSubmit);
  checkDistribution(rows, x => x.next.entry - x.exit, block.outsideCallback);
  checkDistribution(rows, x => x.entry - x.stamp, block.callbackStartLag);
  checkDistribution(rows, x => x.next.entry - x.next.stamp, block.nextCallbackStartLag);
  checkDistribution(rows, x => x.gpu?.ms, block.gpuElapsed);
  assert.equal(block.callbackOver16_7, rows.filter(x => x.exit - x.entry > 16.7).length);
  assert.equal(block.gapOver16_7, rows.filter(x => x.next.entry - x.exit > 16.7).length);
  for (const x of rows) {
    assert(x.exit >= x.entry && x.next.entry >= x.exit - 0.01);
    assert(Object.values(x.hits).every(n => n === 1));
    assert(Math.abs((x.next.entry - x.entry) - ((x.exit - x.entry) + (x.next.entry - x.exit))) < 0.001);
  }
}

let observed = 0;
let sampled = 0;
let gpuValid = 0;
for (const file of manifest.files) {
  const raw = readCompressed(file.file, file.sha256);
  const run = summary.runs.find(v => v.mode === file.mode);
  assert.equal(run.source, file.source);
  assert.equal(run.mainSha256, file.sourceMainSha256);
  assert.equal(run.native.code, 0);
  assert.equal(raw.mode, file.mode);
  assert.equal(raw.routes.length, 6);
  const runValid = raw.routes.flatMap(t => t.sampled).filter(x => x.gpu?.state === 'valid').length;
  assert.equal(runValid, raw.stats.resolved);
  assert.equal(raw.stats.resolved, raw.stats.queries);
  assert.equal(raw.stats.disjointEvents, 0);
  gpuValid += runValid;
  for (const route of raw.routes) {
    const data = run.segments[route.id];
    const intervals = route.frames.map(x => x.ms);
    assert.equal(data.frames, intervals.length);
    assert.equal(data.fps, rounded(1000 * intervals.length / intervals.reduce((a, b) => a + b, 0)));
    assert.equal(data.p95, rounded(quantile(intervals, 0.95)));
    assert.equal(data.over20, intervals.filter(t => t > 20).length);
    assert.equal(data.observerSeesSameStamp, route.frames.filter(x => Math.abs(x.stamp - x.stationStamp) < 0.015).length);
    const measured = route.sampled.filter(x => x.exit && x.next);
    checkProductionRows(measured, data.all);
    checkProductionRows(measured.filter(x => x.next.stamp - x.stamp > 20), data.long);
    checkProductionRows(measured.filter(x => x.next.stamp - x.stamp <= 20), data.normal);
    observed += intervals.length;
    sampled += measured.length;
  }
}

let oldCount = 0;
for (const file of historicalFiles) {
  const raw = readCompressed(path.join('existing', file.file), file.sha256);
  const run = historical.runs.find(x => x.run === file.id);
  assert.equal(run.source, file.source);
  for (const [id, frames] of Object.entries(raw)) {
    const data = run.segments[id];
    const intervals = frames.map(x => x.ms);
    const total = intervals.reduce((a, b) => a + b, 0);
    const long = frames.filter(x => x.ms > 20);
    const fast = frames.filter(x => x.ms <= 20);
    assert.equal(frames.length, data.intervals);
    assert.equal(rounded(total), data.totalMs);
    assert.equal(rounded(1000 * frames.length / total), data.fps);
    assert.equal(rounded(quantile(intervals, 0.95)), data.p95);
    assert.equal(long.length, data.excess20);
    assert.equal(intervals.filter(t => t >= 29 && t <= 32).length, data.twoTicks);
    assert.equal(intervals.filter(t => t > 42).length, data.threeOrMoreTicks);
    let streak = 0, longest = 0, groups = 0, elapsed = 0;
    const longPerSecond = [];
    for (const t of intervals) {
      const bucket = Math.floor(elapsed / 1000);
      longPerSecond[bucket] ??= 0;
      if (t > 20) {
        if (!streak) groups++;
        longPerSecond[bucket]++;
        longest = Math.max(longest, ++streak);
      } else streak = 0;
      elapsed += t;
    }
    assert.equal(longest, data.maxConsecutive);
    assert.equal(groups, data.longPools);
    assert.deepEqual(longPerSecond, data.oneSecondBins.map(b => b.long));
    for (const [suffix, list] of [['Fast', fast], ['Slow', long]]) {
      assert.equal(list.length ? quantile(list.map(x => x.calls), 0.5) : null, data['drawMedian' + suffix]);
      assert.equal(list.length ? quantile(list.map(x => x.triangles), 0.5) : null, data['triMedian' + suffix]);
    }
    oldCount += frames.length;
  }
}
assert.equal(oldCount, historical.intervals);
assert.equal(oldCount, 11602);
console.log(`Verified ${oldCount} existing intervals, ${observed} new RAF intervals, ${sampled} production frame samples and ${gpuValid} GPU timer results.`);
