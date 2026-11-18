'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const round = n => +n.toFixed(4);
function describe(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a,b) => a-b);
  const at = q => sorted[Math.ceil(sorted.length*q)-1];
  return {count:values.length,min:sorted[0],p50:at(.5),p95:at(.95),max:sorted.at(-1),mean:round(values.reduce((a,b)=>a+b,0)/values.length)};
}
function routeSummary(route) {
  const {frames, host, device, start, end, keys} = route;
  const field = (rows,key) => describe(rows.map(row => row[key]).filter(Number.isFinite));
  const times = frames.map(f=>f.ms), total = times.reduce((a,b)=>a+b,0);
  const fps = frames.length * 1000 / total, duration = describe(times);
  const step = Math.hypot(end.feet[0]-start.feet[0],end.feet[2]-start.feet[2]);
  const timeZero=frames[0].stamp-frames[0].ms;
  const slowFrameEndOffsetsMs=keys.length?frames.filter(f=>f.ms>20).map(f=>round(f.stamp-timeZero)):null;
  const held=keys.length?frames.filter(f=>f.stamp-f.ms>=keys[0].stamp&&f.stamp<=keys[1].stamp):[];
  return {
    id:route.id, frames:frames.length, sampleMs:round(total), fps:round(fps), rafMs:duration,
    over20Ms:times.filter(ms=>ms>20).length, withinBudget:fps>=60&&round(duration.p95)<=16.7,
    draws:field(frames,'draws'), triangles:field(frames,'triangles'), productionStampMatches:frames.filter(f=>Math.abs(f.stamp-f.stationStamp)<.01).length,
    routeDistanceXZ:round(step), keyHeldMs:keys.length?round(keys[1].stamp-keys[0].stamp):null,
    continuousKeyHold:held.length?{frames:held.length,fps:round(1000*held.length/held.reduce((n,f)=>n+f.ms,0)),rafMs:field(held,'ms'),slowFrameEndOffsetsMs}:null,
    foreground:{start:start.focused,end:end.focused,osRun:host.filter(r=>r.inForeground).length,osSamples:host.length},
    system:{cpuPct:field(host,'hostCpuPct'),busiestCorePct:field(host,'busiestCorePct'),runMax3dQueuePct:field(host,'runMax3dQueuePct'),otherMax3dQueuePct:field(host,'otherMax3dQueuePct'),
      gpuBusyPct:field(device,'busyPct'),gpuMHz:field(device,'graphicsMHz'),gpuMemMHz:field(device,'memoryMHz'),powerW:field(device,'powerW'),temperatureC:field(device,'temperatureC'),pStates:[...new Set(device.map(r=>r.pState))]}
  };
}
function analyze(doc,packed) {
  const runs=doc.runs.map(({routes,...rest})=>({...rest,routes:routes.map(routeSummary)}));
  const comparisons=[];
  for(const [baseId,newId] of [['01-original','02-r3b'],['04-original','03-r3b']]) {
    const base=runs.find(r=>r.id===baseId), changed=runs.find(r=>r.id===newId);
    if(!base||!changed) continue;
    const originalRaw=doc.runs.find(r=>r.id===baseId), changedRaw=doc.runs.find(r=>r.id===newId);
    const separation=(a,b)=>Math.hypot(...a.map((v,j)=>v-b[j]));
    const routes=changed.routes.map((c,i)=>{
      const o=base.routes[i];assert.equal(o.id,c.id);
      const oldStart=originalRaw.routes[i].start, newStart=changedRaw.routes[i].start;
      const eyeDelta=separation(oldStart.eye,newStart.eye), feetDelta=separation(oldStart.feet,newStart.feet);
      const cameraDot=Math.abs(oldStart.quaternion.reduce((sum,q,j)=>sum+q*newStart.quaternion[j],0));
      const angle=2*Math.acos(Math.min(1,cameraDot))*180/Math.PI;
      if(i<4){assert(eyeDelta<1e-6);assert(angle<1e-4);assert.equal(oldStart.fov,newStart.fov);}
      return {id:c.id,fps:round(c.fps-o.fps),p95Ms:round(c.rafMs.p95-o.rafMs.p95),drawsP50:c.draws.p50-o.draws.p50,
        trianglesP50:c.triangles.p50-o.triangles.p50,distanceXZ:round(c.routeDistanceXZ-o.routeDistanceXZ),
        cameraStartPositionDeltaM:round(eyeDelta),cameraStartAngleDeltaDegrees:round(angle),feetStartPositionDeltaM:round(feetDelta),fovDeltaDegrees:newStart.fov-oldStart.fov};
    });
    comparisons.push({base:baseId,changed:newId,deltaNewMinusOld:routes});
  }
  return {sourceFile:'frames.json.gz',sha256:crypto.createHash('sha256').update(packed).digest('hex'),
    threshold:{fpsMin:60,p95MsMax:16.7},order:doc.order,
    method:'One RTX 3060 Laptop GPU. Four new native app sessions. Default evening in 1440 x 900, DPR 1, no HUD. Each session uses the four deployed camera buttons in order and then a real W key held in each walking view. Production animation continues. FPS = 1000*n/sum(RAF intervals). Quantiles use nearest rank. Draws/triangles represent all render passes. Host/device samples were joined using the wall-clock interval of each route; outside 3D queues, clocks and foreground can vary.',
    runs,comparisons};
}
module.exports=analyze;
if(require.main===module) {
  const packed=fs.readFileSync(path.join(__dirname,'frames.json.gz'));
  const actual=analyze(JSON.parse(zlib.gunzipSync(packed)),packed);
  assert.deepEqual(actual,JSON.parse(fs.readFileSync(path.join(__dirname,'comparison.json'))));
  console.log('Verified '+actual.runs.length+' native sessions, '+actual.runs.flatMap(r=>r.routes).length+' routes and '+actual.runs.flatMap(r=>r.routes).reduce((n,r)=>n+r.frames,0)+' frame intervals.');
}
