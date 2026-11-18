'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const fixture = path.resolve(__dirname,'../..'), comparison = path.join(__dirname,'comparison.json');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const source='b3e27d29b963ee02caa07c3057632e8f9c6a6461';
const v=['sample-e-harbour','sample-f-hillside','sample-g-rail','sample-h-north','sample-f-absolute-254','return-e'];
const reports={};
for(const mode of ['on','off']){
  const dir=path.join(__dirname,mode),r=read(path.join(dir,'report.json'));reports[mode]=r;
  assert.equal(r.source,source);assert.equal(r.ground,mode);assert(r.complete);assert.deepEqual(r.exceptions,[]);
  assert.deepEqual(Object.keys(r.photos),mode==='on'?[...v,'storm-e']:v);
  for(const [key,p] of Object.entries(r.photos)){
    assert.equal(hash(path.join(dir,p.file)),p.hashes[2]);assert.equal(p.hashes[0],p.hashes[2]);
    if(new Set(p.hashes).size!==1) console.log('Frozen middle frame differed:',mode,key);
    assert.equal(p.weather.seconds,key==='storm-e'?54:14);assert.equal(p.time,p.weather.seconds);assert.equal(p.islandTime,p.weather.seconds);
    assert.equal(p.water.seconds,p.weather.seconds);assert.equal(p.water.sea,p.weather.sea);assert.equal(p.water.surge,p.weather.surge);assert.equal(Boolean(p.groundArt),mode==='on');
    assert.equal(p.wetRoad,p.weather.wetness);assert.equal(p.groundFog,p.weather.fog);assert.match(p.gpu,/RTX 3060 Laptop/);assert.equal(p.glError,0);assert.deepEqual(p.errors,[]);
    assert.deepEqual(p.canvas,[1440,900]);
  }
  assert.deepEqual(r.photos['return-e'].hashes,r.photos[v[0]].hashes);
}
assert.deepEqual(reports.on.sourceFiles,reports.off.sourceFiles);
const live=reports.off.liveShore;
assert(live[1].weather.seconds>live[0].weather.seconds && live[1].waterTime>live[0].waterTime);
for(const p of live){assert.equal(hash(path.join(__dirname,'off',p.file)),p.sha256);assert.equal(p.weather.phase,'锋面阵雨');assert.equal(p.lakeRain,p.weather.rain);assert.equal(p.view,'tarn');}
assert.notDeepEqual(live[0].cloudFlow,live[1].cloudFlow);assert.notEqual(live[0].lakeSurface,live[1].lakeSurface);assert.deepEqual(live[0].eye,live[1].eye);
for(const name of v.slice(0,5))assert(read(comparison)[name].offVsOn.rgbDeltaAbove8>0);
console.log('Verified joint E–H, F registration, both ground settings, all frozen native frame hashes and free-running lake/sky/weather fields.');
