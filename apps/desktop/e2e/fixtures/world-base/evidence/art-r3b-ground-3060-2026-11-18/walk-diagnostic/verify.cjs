'use strict';
const fs=require('node:fs'),p=require('node:path'),z=require('node:zlib'),hash=b=>require('node:crypto').createHash('sha256').update(b).digest('hex'),assert=require('node:assert/strict');
const dir=process.argv[2]||__dirname,doc=JSON.parse(fs.readFileSync(p.join(dir,'comparison.json'))),ground=(a,b)=>Math.hypot(a[0]-b[0],a[2]-b[2]);
let n=0,q=0,totalRows=0;const trials=[];
for(const run of doc.runs){
 const b=fs.readFileSync(p.join(dir,run.tag+'.browser.json.gz'));assert.equal(hash(b),run.rawSha256);
 const raw=JSON.parse(z.gunzipSync(b));assert.equal(raw.length,3);assert.deepEqual(raw.map(t=>t.mode),run.modeOrder);
 for(const t of raw){
  assert(t.spawned.every(s=>ground(s.feet,t.spawn)<1e-5&&Math.abs(s.yaw-4*Math.PI/180)<1e-8&&Math.abs(s.pitch+8*Math.PI/180)<1e-8));
  assert(t.tail<.0001);assert.deepEqual(t.transitions[0].before,t.transitions[0].after);
  assert.deepEqual(t.data.keys.map(k=>[k.kind,k.trusted]),[['keydown',true],['keyup',true],['keydown',true],['keyup',true]]);
  for(const r of t.data.routes){
   const frames=r.frames,reported=doc.byView[r.id].perTrial.find(row=>row.run===run.tag&&row.trial===t.trial);
   assert.equal(reported.n,frames.length);assert(Math.abs(1000*frames.length/frames.reduce((a,f)=>a+f.ms,0)-reported.fps)<.0001);
   assert.equal(reported.over20,frames.filter(f=>f.ms>20).length);assert.equal(reported.p95,+frames.map(f=>f.ms).sort((a,b)=>a-b)[Math.ceil(.95*frames.length)-1].toFixed(4));
   if(t.mode==='control')assert.equal(r.sampled.length,0);
   for(const s of r.sampled){totalRows++;assert(s.entry<=s.bodyEntry&&s.bodyEntry<=s.bodyExit&&s.bodyExit<=s.exit&&s.exit<=s.next.entry);
    for(const [key,[start,end]] of Object.entries(s.bounds)){assert(start>=s.bodyEntry&&end<=s.bodyExit&&Math.abs(s.stage[key]-(end-start))<1e-6);}
    if(s.gpu.state==='valid'){q++;assert(s.gpu.ms>=0);}}
   trials.push({run:run.tag,trial:t.trial,mode:t.mode,view:r.id,frames:r.frames,sampled:r.sampled});n+=frames.length;
  }
 }
}
for(const t of trials.filter(t=>t.mode==='sparse')){
 const peers=trials.filter(o=>o!==t&&o.view===t.view);
 const sampled=t.sampled.filter(s=>t.frames.some(f=>Math.abs(f.stamp-s.next.stamp)<.005)&&peers.every(o=>o.frames.some(f=>+ground(f.feet,s.feetAfter).toFixed(4)<=.12)));
 const reported=doc.byView[t.view].perTrial.find(r=>r.run===t.run&&r.trial===t.trial);
 assert.equal(sampled.length,reported.matched);
 assert.equal(sampled.filter(s=>s.next.stamp-s.stamp>20).length,reported.slowSample);
}
console.log('Verified '+trials.length+' routes, '+n+' RAF intervals, '+totalRows+' sampled callbacks and '+q+' valid GPU queries.');
const systemFile = fs.readFileSync(p.join(dir,doc.systemSamples.file));
assert.equal(hash(systemFile),doc.systemSamples.sha256);
const fromRaw = require('./analyze.cjs')(dir);
assert.deepEqual(fromRaw.byView,doc.byView);
for (const window of fromRaw.hostWindows) {
  const run = doc.runs.find(r=>r.tag===window.tag);
  const expected = run.windows.find(w=>w.trial===window.trial && w.id===window.view);
  assert.deepEqual(window.host,expected.host);
  assert.deepEqual(window.device,expected.device);
}
assert.equal(fromRaw.foreground.observations,doc.systemSamples.hostRows);
const first = fromRaw.byView['walk-first'];
console.log('Recomputed matched first-person callbacks: '+(first.slowNext.n+first.normalNext.n)+', slow '+first.slowNext.n+', normal '+first.normalNext.n+'.');
console.log('Recomputed OS foreground: '+fromRaw.foreground.matched+'/'+fromRaw.foreground.observations+' in test process tree.');
