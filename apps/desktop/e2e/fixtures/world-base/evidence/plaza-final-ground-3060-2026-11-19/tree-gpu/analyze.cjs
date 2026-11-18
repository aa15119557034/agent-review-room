'use strict';
const fs=require('node:fs'),p=require('node:path'),z=require('node:zlib');
const base=process.argv[2]||__dirname;
const tags=['01-v2','02-final','03-final','04-v2'],nearest=(xs,q)=>xs.length?[...xs].sort((a,b)=>a-b)[Math.max(0,Math.ceil(xs.length*q)-1)]:null;
const round=x=>x==null?null:+x.toFixed(4),stat=xs=>({n:xs.length,median:round(nearest(xs,.5)),p95:round(nearest(xs,.95)),min:round(nearest(xs,0)),max:round(nearest(xs,1))});
const out={runs:[]};
for(const tag of tags){
 const dir=p.join(base,tag);if(!fs.existsSync(p.join(dir,'raw.json.gz')))continue;
 const raw=JSON.parse(z.gunzipSync(fs.readFileSync(p.join(dir,'raw.json.gz')))),report=JSON.parse(fs.readFileSync(p.join(dir,'report.json')));
 const sys=fs.readFileSync(p.join(dir,'system.jsonl'),'utf8').trim().split('\n').filter(Boolean).flatMap(s=>{try{return[JSON.parse(s)];}catch{return[];}});
 const nvs=fs.readFileSync(p.join(dir,'nvidia.csv'),'utf8').trim().split('\n').map(x=>x.split(',').map(y=>y.trim())).map(x=>({ms:Date.parse(x[0].replaceAll('/','-').replace(' ','T')+'+08:00'),state:x[2],clock:+x[3],mem:+x[4],gpu:+x[5]}));
 const r={tag,source:report.source,readyMs:report.readyMs,stage:report.stage,exceptions:report.exceptions,network:report.network,rawSha256:report.rawSha256,originals:raw[0].data.originals,meshes:raw[0].data.meta,trials:[]};out.runs.push(r);
 for(const x of raw){for(const u of x.data.trials){const delta=u.frames.map(f=>f[1]),dist=(a,b)=>Math.hypot(...a.map((n,i)=>n-b[i])),ns=nvs.filter(s=>s.ms>=u.utcStart&&s.ms<=u.utcEnd),ss=sys.filter(s=>s.wallMs>=u.utcStart&&s.wallMs<=u.utcEnd);
 const timer={},byPass={},targets=new Set(u.samples.flatMap(s=>s.draws.map(draw=>draw.pass+'|'+draw.parts.join('+'))));
 for(const s of u.samples){const a=(timer[s.target]??={values:[],states:{}});a.states[s.gpu.status]=(a.states[s.gpu.status]||0)+1;if(s.gpu.status==='valid')a.values.push(s.gpu.ms);}
 for(const k of targets){const contributions=u.samples.map(s=>s.draws.filter(draw=>draw.pass+'|'+draw.parts.join('+')===k));byPass[k]={draws:stat(contributions.map(row=>row.reduce((s,v)=>s+v.draws,0))),triangles:stat(contributions.map(row=>row.reduce((s,v)=>s+v.tri,0)))};}
 const result={mode:x.data.mode,label:u.label,start:u.start,end:u.end,travel:round(dist(u.start.feet,u.end.feet)),fps:round(1000*delta.length/delta.reduce((a,b)=>a+b,0)),frameMs:stat(delta),draws:stat(u.frames.map(f=>f[5])),triangles:stat(u.frames.map(f=>f[6])),sampleFrames:u.samples.length,timer:Object.fromEntries(Object.entries(timer).map(([k,o])=>[k,{...stat(o.values),statuses:o.states}])),byPass,stats:x.data.stats,sys:{n:ss.length,foregroundRun:ss.filter(s=>s.foregroundIsRunTree).length,cpuPct:stat(ss.map(s=>s.cpuPct)),gpuClockMHz:stat(ns.map(s=>s.clock)),gpuUtilPercent:stat(ns.map(s=>s.gpu)),pStates:[...new Set(ns.map(s=>s.state))]}};
 r.trials.push(result);}}
}
fs.writeFileSync(p.join(base,'summary.json'),JSON.stringify(out,null,2)+'\n');
for(const r of out.runs){console.log(r.tag,r.stage);for(const t of r.trials){const gpu=t.timer.full;console.log(t.mode,t.label,t.fps,t.frameMs.p95,'fullGPU',gpu?.median,'foreground',t.sys.foregroundRun+'/'+t.sys.n,'clock',t.sys.gpuClockMHz.median);if(t.mode==='sparse')console.log(Object.entries(t.timer).map(([k,v])=>[k,v.n,v.median]));}}
