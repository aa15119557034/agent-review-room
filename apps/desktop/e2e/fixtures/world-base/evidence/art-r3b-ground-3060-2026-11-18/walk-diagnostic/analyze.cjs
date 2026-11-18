'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const assert = require('node:assert/strict');

function readGzipJson(dir, name) {
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dir,name))));
}

// All browser statistics are derived from the frame streams in these two files.
// The independent OS/device stream is only needed for the foreground association.
function analyze(dir, browserOnly=false) {
  const telemetry=browserOnly?[]:readGzipJson(dir,'system-samples.json.gz').runs;
  const runs=['01-r3b','02-r3b'].map(id=>{
    const source=telemetry.find(r=>r.tag===id);
    if (!browserOnly) assert(source,'missing system samples for '+id);
    return {id,trials:readGzipJson(dir,id+'.browser.json.gz'),obs:source?.host||[],device:source?.device||[]};
  });
const round=n=>+n.toFixed(4);
function describe(ns){
 ns=ns.filter(Number.isFinite).sort((a,b)=>a-b);if(!ns.length)return null;
 const q=p=>round(ns[Math.ceil(ns.length*p)-1]);return {n:ns.length,min:round(ns[0]),p50:q(.5),p95:q(.95),max:round(ns.at(-1))};
}
const dist=(a,b)=>Math.hypot(a[0]-b[0],a[2]-b[2]);
const routes=[];
for(const run of runs)for(const t of run.trials)for(const r of t.data.routes){
 const keyStart=t.data.keys[r.id==='walk-third'?0:2].stamp;
 const trail=r.frames.map(f=>({feet:f.feet,stamp:f.stamp,ms:f.ms}));
 const host=run.obs.filter(x=>x.wallMs>=r.wallStart&&x.wallMs<=r.wallEnd).map(x=>({offsetMs:round(x.wallMs-r.wallStart),fg:x.foregroundIsRunTree,hostCpu:x.cpuPct,coreCpu:x.busiestCorePct}));
 const device=run.device.filter(x=>x.wallMs>=r.wallStart&&x.wallMs<=r.wallEnd).map(({wallMs,...counts})=>({offsetMs:round(wallMs-r.wallStart),...counts}));
 const makeSample=s=>{
  assert(s.next&&s.bodyExit>=s.bodyEntry);const later=r.frames.find(f=>Math.abs(f.stamp-s.next.stamp)<.005);
  const at=r.frames.find(f=>Math.abs(f.stamp-s.stamp)<.005);const stages=s.stage;
  return {seq:s.id,stamp:s.stamp,feet:s.feetAfter,xzFromSpawn:round(dist(t.spawn,s.feetAfter)),nextMs:round(s.next.stamp-s.stamp),nextRecorded:!!later,
   bodyMs:round(s.bodyExit-s.bodyEntry),entryToNextMs:round(s.next.entry-s.entry),afterExitToNextEntryMs:round(s.next.entry-s.exit),
   callbackOverheadMs:round((s.exit-s.entry)-(s.bodyExit-s.bodyEntry)),otherBodyMs:round(s.bodyExit-s.bodyEntry-Object.values(stages).reduce((a,b)=>a+b,0)),
   stage:Object.fromEntries(Object.entries(stages).map(([k,v])=>[k,round(v)])),gpuStatus:s.gpu.state,gpuMs:s.gpu.state==='valid'?s.gpu.ms:null,
   draws:s.draws,triangles:s.triangles,beginFromKeyMs:round(s.stamp-keyStart),endFromKeyMs:round(s.next.stamp-keyStart),observerSamePose:at?dist(at.feet,s.feetAfter)<.00001:null};
 };
 const seconds=r.frames.reduce((s,f)=>s+f.ms,0)/1000;
 routes.push({run:run.id,trial:t.trial,mode:t.mode,id:r.id,spawn:t.spawn,standingResidual:round(t.tail),start:r.start,end:r.end,keys:t.data.keys.slice(r.id==='walk-third'?0:2,r.id==='walk-third'?2:4),host,device,trail,
  samples:r.sampled.map(makeSample).filter(s=>s.nextRecorded),fps:round(r.frames.length/seconds),p95:describe(r.frames.map(f=>f.ms)).p95,
  stamps:r.frames.filter(f=>Math.abs(f.stamp-f.stationStamp)<.01).length,extension:t.data.gpuExtension,queryStats:t.data.stats});
}
for(const route of routes){
 const peers=routes.filter(r=>r!==route&&r.id===route.id);
 for(const s of route.samples){s.maxPeerNearestM=round(Math.max(0,...peers.map(q=>Math.min(...q.trail.map(f=>dist(f.feet,s.feet))))));s.positionMatched=s.maxPeerNearestM<=.12;}
}
const timed=routes.flatMap(r=>r.samples.filter(s=>s.positionMatched).map(s=>({...s,id:r.id,run:r.run,trial:r.trial})));
function summary(samples){
 const field=k=>describe(samples.map(s=>s[k]));return {n:samples.length,bodyMs:field('bodyMs'),entryToNextMs:field('entryToNextMs'),afterExitToNextEntryMs:field('afterExitToNextEntryMs'),otherBodyMs:field('otherBodyMs'),callbackOverheadMs:field('callbackOverheadMs'),
  stationMs:describe(samples.map(s=>s.stage.station)),walkerMs:describe(samples.map(s=>s.stage.walker)),islandMs:describe(samples.map(s=>s.stage.island)),renderMs:describe(samples.map(s=>s.stage.render)),gpuMs:field('gpuMs'),draws:field('draws'),triangles:field('triangles'),
  wallAtLeast15_4:samples.filter(s=>s.bodyMs>=15.4).length,renderWallAtLeast15_4:samples.filter(s=>s.stage.render>=15.4).length,
  gpuAtLeast15_4:samples.filter(s=>s.gpuMs!==null&&s.gpuMs>=15.4).length,gpuResolved:samples.filter(s=>s.gpuMs!==null).length,
  outsideGapAtLeast15_4:samples.filter(s=>s.afterExitToNextEntryMs>=15.4).length,
  maxPeerNearestM:field('maxPeerNearestM'),xzFromSpawn:field('xzFromSpawn')};
}
const byView={};for(const id of ['walk-third','walk-first']){
 const same=timed.filter(s=>s.id===id);
 const sparsePairs=routes.filter(r=>r.id===id&&r.mode==='sparse').map(r=>{
  const group=same.filter(s=>s.run===r.run&&s.trial===r.trial);
  return {run:r.run,trial:r.trial,slowNext:summary(group.filter(s=>s.nextMs>20)),normalNext:summary(group.filter(s=>s.nextMs<=20))};
 });
 const spatial={};
 for(const r of routes.filter(r=>r.id===id)){
  const peers=routes.filter(p=>p!==r&&p.id===id);
  for(let i=0;i<r.trail.length-1;i++){
   const f=r.trail[i],next=r.trail[i+1];
   if(!peers.every(p=>p.trail.some(g=>dist(g.feet,f.feet)<=.12)))continue;
   const key=Math.floor(dist(r.spawn,f.feet));const bin=spatial[key]??={control:[0,0],sparse:[0,0]};bin[r.mode][0]++;if(next.ms>20)bin[r.mode][1]++;
  }
 }
 byView[id]={slowNext:summary(same.filter(s=>s.nextMs>20)),normalNext:summary(same.filter(s=>s.nextMs<=20)),sparsePairs,spatialFramesThenSlowNextByMetreFromSpawn:spatial,perTrial:routes.filter(r=>r.id===id).map(r=>({run:r.run,trial:r.trial,mode:r.mode,n:r.trail.length,fps:r.fps,p95:r.p95,over20:r.trail.filter(f=>f.ms>20).length,sampled:r.samples.length,matched:r.samples.filter(s=>s.positionMatched).length,slowSample:r.samples.filter(s=>s.positionMatched&&s.nextMs>20).length,focus:[r.start.focused,r.end.focused],os:[r.host.filter(x=>x.fg).length,r.host.length],pose:[r.start.feet,r.end.feet]}))};
}

 const allHost=routes.flatMap(r=>r.host);
 const foreground=browserOnly?null:{observations:allHost.length,matched:allHost.filter(r=>r.fg).length,
   withKnownWindow:telemetry.flatMap(r=>r.host).filter(r=>r.foregroundWasIdentified).length};
 const hostWindows=runs.flatMap(run=>routes.filter(r=>r.run===run.id).map(r=>({tag:r.run,trial:r.trial,view:r.id,host:r.host,device:r.device})));
 return {byView,foreground,hostWindows};
}

module.exports=analyze;
if (require.main===module) {
 const result=analyze(__dirname,process.argv.includes('--browser-only'));
 if (process.argv.includes('--json')) {
   console.log(JSON.stringify(result,null,2));
 } else {
   for (const [view,v] of Object.entries(result.byView)) {
     const slow=v.slowNext,normal=v.normalNext;
     console.log(view+': matched '+(slow.n+normal.n)+', next >20 ms '+slow.n+', next <=20 ms '+normal.n);
     for(const [label,r] of [['slow',slow],['normal',normal]]) {
       console.log('  '+label+' medians (ms): callback '+r.bodyMs.p50+', render '+r.renderMs.p50+', GPU '+r.gpuMs.p50+', exit to next entry '+r.afterExitToNextEntryMs.p50);
       console.log('  '+label+' at or above 15.4 ms: host render '+r.renderWallAtLeast15_4+'/'+r.n+', GPU '+r.gpuAtLeast15_4+'/'+r.gpuResolved);
     }
     console.log('  control FPS/P95 (ms): '+v.perTrial.filter(r=>r.mode==='control').map(r=>r.fps+'/'+r.p95).join(', '));
   }
   if(result.foreground)console.log('OS foreground: '+result.foreground.matched+'/'+result.foreground.observations+' in test process tree, '+result.foreground.withKnownWindow+' identified owners.');
 }
}
