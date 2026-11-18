'use strict';
const a = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const evidence = __dirname;
const read = name => fs.readFileSync(path.resolve(evidence, name));
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const r = JSON.parse(read('report.json'));
const comparison = JSON.parse(read('comparison.json'));
a(r.complete && r.engineExit === 0 && !r.exceptions.length);
a.equal(r.source, '21154f79fc8c1fb1bc27735b203a9fa0b6db3b1a');
for (const [name, photo] of Object.entries(r.photos)) {
  a.equal(sha(read(photo.file)), photo.captureSHA256, name);
  a.equal(photo.hashes[2], photo.captureSHA256);
  a.equal(photo.glError, 0);
  a.deepEqual(photo.errors, []);
  a.deepEqual(photo.canvas, [1440, 900]);
  a.equal(photo.hidden, true);
  a.equal(photo.buttonActive, true);
  a.deepEqual(photo.plan, {source:'baked',rays:0,fingerprint:'1061:2667664:298285.6:949273.1',items:26});
  a.equal(photo.streetReflection.cube.length, 6);
}
a.equal(r.photos['return-a'].captureSHA256, r.photos['art-a-street'].captureSHA256);
for (const name of ['sample-f-hillside','sample-h-north']) a.equal(comparison[name].changedPixels, 0);
a(r.photos['sample-e-harbour'].weather.rain < r.photos['storm-e'].weather.rain);
a.notDeepEqual(r.photos['sample-e-harbour'].cloudFlow,r.photos['storm-e'].cloudFlow);
const [start,end] = r.liveShore;
a.deepEqual(start.eye,end.eye);
a.deepEqual(start.quaternion,end.quaternion);
a(end.weather.seconds > start.weather.seconds && end.waterTime > start.waterTime);
a(end.lakeReflection.captures > start.lakeReflection.captures);
for (const s of r.liveShore) {
  a(s.lakeReflection.linked && s.lakeReflection.on === 1);
  a.deepEqual([s.lakeReflection.width,s.lakeReflection.height],[640,400]);
  a.equal(sha(read(s.file)),s.sha256);
}
a.notEqual(start.lakeSurface,end.lakeSurface);
a.notDeepEqual(start.cloudFlow,end.cloudFlow);
a.deepEqual(r.runtimeFiles.stationArt.filter(x=>x.path.endsWith('.glb')).map(x=>[x.path,x.bytes]).sort(),r.modelRequests.map(x=>[x.path.slice(1),x.decoded]).sort());
a.deepEqual(r.networkFailures.map(x=>x.canceled),[true,true,true]);
const frames=JSON.parse(zlib.gunzipSync(read('arrival-frames.json.gz')));
for (const [i,{view, frames:samples}] of frames.entries()) {
  const t=r.arrival[i];
  const times=samples.map(x=>x[1]);
  a.equal(view,t.view);
  a.equal(times.length,t.frameCount);
  a.equal(t.fps,1000*times.length/times.reduce((s,v)=>s+v,0));
  a.equal(t.p95Ms,times.sort((a,b)=>a-b)[Math.ceil(times.length*.95)-1]);
}
a(Math.hypot(...r.arrival[1].end.feet.map((v,i)=>v-r.arrival[1].start.feet[i])) > 9);
console.log('Verified 8 player-level cameras, A return, E weather, 2 live lake frames and '+frames.reduce((n,x)=>n+x.frames.length,0)+' RAF intervals.');
