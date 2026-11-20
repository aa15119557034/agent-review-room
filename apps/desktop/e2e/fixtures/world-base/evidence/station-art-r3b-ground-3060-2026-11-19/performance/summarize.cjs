// node summarize.cjs <R3b comparison.json> <monitored-final-1 directory> [monitored-final-2 directory]
const fs=require('node:fs'),path=require('node:path'),z=require('node:zlib'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const [baseline,...folders]=process.argv.slice(2),out=__dirname,read=file=>JSON.parse(fs.readFileSync(file));
const digest=b=>crypto.createHash('sha256').update(b).digest('hex');
function stats(a){const b=[...a].sort((x,y)=>x-y);return {n:a.length,min:b[0],p50:b[Math.ceil(b.length*.5)-1],p95:b[Math.ceil(b.length*.95)-1],max:b.at(-1),mean:a.reduce((s,x)=>s+x,0)/a.length}}
const standalone=read(baseline).runs.filter(r=>r.id==='02-r3b'||r.id==='03-r3b').map(r=>({id:r.id,source:r.source,routes:r.routes.map(t=>({id:t.id,frames:t.frames,fps:t.fps,rafMs:t.rafMs,over20:t.over20Ms,distanceXZ:t.routeDistanceXZ,draw:t.draws,triangles:t.triangles,focus:t.foreground,device:t.device}))}));
const runs=[];
for(const [i,folder] of folders.entries()){
  const file=p=>path.join(folder,p),native=read(file('render-report.json')),summary=read(file('frame-times.json')),outer=read(file('outside-run.json'));
  const data=fs.readFileSync(file('frames.json.gz')),rows=JSON.parse(z.gunzipSync(data));assert.equal(digest(data),summary.samples.sha256);
  const id='final-'+(i+1);fs.writeFileSync(path.join(out,id+'.frames.json.gz'),data);
  const host=fs.readFileSync(file('system.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  const device=fs.readFileSync(file('nvidia.csv'),'utf8').trim().split('\n').map(l=>{let [t,gpu,state,clock,mem,load,vm,power,temp]=l.split(',').map(v=>v.trim());return {utcMs:Date.parse(t.replaceAll('/','-').replace(' ','T')+'+08:00'),clock:+clock,load:+load,memoryClock:+mem,powerW:+power,tempC:+temp,state};});
  const routes=[];
  for(const [key,frames] of Object.entries(rows)){
    const walk=key.startsWith('walk-'),sample=walk?'frame-samples-walking-'+key.slice(5)+'.json':'frame-samples-'+key+'.json';
    const time=native.quietWindows.find(v=>v.filename===sample),low=time.start.wallMs,high=time.end.wallMs;
    const system=host.filter(v=>v.wallMs>=low&&v.wallMs<=high).map(v=>({utcMs:v.wallMs,measuredWindow:v.foregroundIsRunTree,cpuPct:v.cpuPct}));
    const hw=device.filter(v=>v.utcMs>=low&&v.utcMs<=high);assert(system.length&&hw.length);
    const timings=frames.map(x=>x.ms),raf=stats(timings),fps=1000/raf.mean;
    assert.equal(timings.length,summary.segments[key].frames);assert.equal(raf.p95,summary.segments[key].p95Ms);
    assert.equal(digest(JSON.stringify(frames)),summary.segments[key].samplesSha256);
    const motion=walk?native.walkingValidation.segments.find(x=>x.mode===key.slice(5)):null;
    routes.push({id:key,frames:timings.length,fps,rafMs:raf,over20:timings.filter(x=>x>20).length,over33:timings.filter(x=>x>33).length,
      draw:stats(frames.map(t=>t.calls)),triangles:stats(frames.map(t=>t.triangles)),walk:motion?{before:motion.before.feet,after:motion.after.feet,distance:motion.distance,distanceXZ:motion.horizontalDistance}:null,
      camera:summary.segments[key].camera,focus:{start:time.start,end:time.end,osRun:system.filter(s=>s.measuredWindow).length,osSamples:system.length},
      host:system,device:hw,graphicsMHz:stats(hw.map(x=>x.clock)),gpuLoadPct:stats(hw.map(x=>x.load))});
  }
  runs.push({id,source:summary.source,gpu:summary.gpu,canvas:summary.canvas,dpr:summary.dpr,rawFile:id+'.frames.json.gz',sha256:digest(data),
    sourceManifestSHA256:digest(fs.readFileSync(file('source-manifest.json'))),canonicalHostSHA256:summary.canonicalHostSha256,instrumentedHostSHA256:summary.measuredHostSha256,
    outsideExit:outer.driverExit,nativeExit:summary.nativeExit,renderOk:native.renderOk,transportClean:native.transportClean,exceptionCount:native.exceptions.length,
    canceled:native.networkFailures.map(f=>({path:f.url?new URL(f.url).pathname:null,error:f.errorText,canceled:f.canceled})),routes});
  if(native.finalInstalledCube)fs.writeFileSync(path.join(out,'../reflections/timing-repeat-upload-evening.json'),JSON.stringify({source:summary.source,...native.finalInstalledCube},null,2)+'\n');
}
const result={sourceOfReference:'art-r3b-ground-3060-2026-11-18/performance/comparison.json',referenceSHA256:digest(fs.readFileSync(baseline)),reference:standalone,runs};
fs.writeFileSync(path.join(out,'comparison.json'),JSON.stringify(result,null,2)+'\n');
console.log(runs.map(r=>[r.id,r.routes.map(s=>[s.id,s.fps.toFixed(2),s.rafMs.p95.toFixed(1),s.over20,s.focus.osRun,s.focus.osSamples])]));
