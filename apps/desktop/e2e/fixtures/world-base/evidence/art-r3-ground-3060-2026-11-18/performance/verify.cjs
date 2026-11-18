'use strict';
const a=require('node:assert/strict'),fs=require('node:fs'),p=require('node:path'),z=require('node:zlib'),crypto=require('node:crypto');
const dir=__dirname,report=JSON.parse(fs.readFileSync(p.join(dir,'comparison.json'))),sha=b=>crypto.createHash('sha256').update(b).digest('hex');
a.equal(report.runs.length,4);a.deepEqual(report.runs.map(r=>r.run),report.order);
let total=0;
for(const r of report.runs){
 const bytes=fs.readFileSync(p.join(dir,r.file));a.equal(sha(bytes),r.sha256);const frames=JSON.parse(z.gunzipSync(bytes));a.equal(Object.keys(frames).length,6);
 for(const [route,rows] of Object.entries(frames)){
  const s=r.routes[route],n=rows.length;a.equal(n,s.frames);a.equal(sha(JSON.stringify(rows)),s.frameSha256);
  const series=rows.map(row=>row.ms).sort((a,b)=>a-b),sum=rows.reduce((x,row)=>x+row.ms,0);
  a.equal(1000*n/sum,s.fps);a.equal(series[Math.ceil(n*.95)-1],s.p95Ms);
  a.equal(s.fps>=r.threshold.fps&&s.p95Ms<=r.threshold.p95Ms,s.pass);
  if(s.walk){a(s.walk.distanceXZ>1);a(Math.abs(s.walk.distanceXZ-Math.hypot(s.walk.to[0]-s.walk.from[0],s.walk.to[2]-s.walk.from[2]))<1e-8);}
  total+=n;
 }
 console.log(r.run,r.source,Object.entries(r.routes).map(([route,s])=>route+' '+s.fps.toFixed(2)+' fps / p95 '+s.p95Ms.toFixed(1)+' ms').join(', '));
}
console.log('Verified',report.runs.length,'fresh native runs,',total,'RAF intervals.');
