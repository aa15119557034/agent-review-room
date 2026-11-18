
const fs = require('node:fs'), path = require('node:path'), zlib=require('node:zlib');
const assert = require('node:assert/strict'), crypto = require('node:crypto');
const target=process.argv[2]||__dirname, yaml=JSON.parse(fs.readFileSync(path.join(target,'frame-times.json')));
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const manifest=JSON.parse(fs.readFileSync(path.join(target,'driver','x51-c28-ground28-manifest.json')));
assert.equal(yaml.source,'b4f1350397fc00b1ff7320f1844788dd1d16b86e'); assert.equal(manifest.head,yaml.source);
assert.equal(Object.keys(manifest.files).length,251);
const generators=Object.entries(manifest.upstreamRoomGenerators); assert.equal(generators.length,8);
for(const [name,entry] of generators){ assert.equal(entry.sha256,manifest.files[name]); assert.match(entry.gitBlob,/^[a-f0-9]{40}$/); }
const lots=["E1","E2","E3","E5","W1","W2","W4","W6"];
for(const run of Object.values(yaml.runs)){assert.equal(run.checkout,yaml.source); assert.equal(run.filesChecked,251); assert.deepEqual(run.roomGeneratorLotIds,lots); assert.deepEqual(run.tintedVolumeLotIds,lots);}
const toonNames=Object.keys(manifest.toonSources);assert.equal(toonNames.length,4);assert(toonNames.includes("src/toon.js")&&toonNames.includes("src/toon.json"));
for(const k of toonNames){assert.equal(manifest.toonSources[k].sha256,manifest.files[k]);assert.match(manifest.toonSources[k].gitBlob,/^[0-9a-f]{40}$/);}
function effectExpected(on){
  return {toon28:on,outline:Number(on),outlineGpu:Number(on),legacyToon:1,legacyToonGpu:1,lineParamsGpu:on?[2,1,50,150]:null,bands:on?[0,.45,1]:null,rimStrength:on?.3:null,
    skyFill:on?'c9cbe2':'b4bce8',groundBounce:'a08068',fillIntensity:1.6,groundGradeWeight:Number(on),gradeShader:true,materialHookStable:true,
    shadowTint:true,decals:true,weathering:1,timeOfDay:'evening',clouds:1,water:true,wetRoad:true};
}
function checkEffects(state,expected) {
  const {litGpu,...base}=state;
  assert.deepEqual(base,expected);assert.equal(litGpu.pairs,litGpu.enabled+litGpu.disabled+litGpu.mixed);
  if(expected.toon28)assert(litGpu.enabled>0,'No linked lit program has uTbK=1 and uTbRim=1');
  else assert.equal(litGpu.pairs+litGpu.onlyBand+litGpu.onlyRim,0,'Unexpected toon uniform in native off run');
}
function checkToggle(a,on){
  const s=a.toon.on.state.effects,t=a.toon.off.state.effects;
  assert.deepEqual([s.legacyToonGpu,t.legacyToonGpu],[1,0]);assert.deepEqual([s.outlineGpu,t.outlineGpu],[Number(on),Number(on)]);
  assert.deepEqual([s.skyFill,t.skyFill],[on?'c9cbe2':'b4bce8','b4bce8']);assert.deepEqual([s.groundGradeWeight,t.groundGradeWeight],[Number(on),0]);
  if(on){assert(s.litGpu.enabled>0);assert(t.litGpu.disabled>0);}
  else {assert.equal(s.litGpu.pairs,0);assert.equal(t.litGpu.pairs,0);}
}
for(const run of Object.values(yaml.runs)){const on=run.mode==="on";for(const s of Object.values(run.segments))checkEffects(s.effects,effectExpected(on));checkToggle({toon:{on:{state:{effects:run.runtimeCheckbox.on}},off:{state:{effects:run.runtimeCheckbox.off}}}},on);for(const a of Object.values(run.shaderChunks))assert.deepEqual(a,{litBands:on,coverage:on,shadowTint:true});}
const buf=fs.readFileSync(path.join(target,'frames.json.gz'));
assert.equal(sha(buf),yaml.framesSha256);
const archived=JSON.parse(zlib.gunzipSync(buf));
assert.deepEqual(Object.keys(archived),['ground-on','ground-off','ground-on-repeat']);
const checks=[];
for(const [key,segments] of Object.entries(archived)){
  const report=yaml.runs[key]; assert.equal(Object.keys(segments).length,10);
  const list=Object.entries(segments);
  let passes=0,frames=0;
  for(const [id,rows] of list){
    const metric=report.segments[id],town=['20','21','23','24','window','door'].includes(id);
    const original=town?JSON.stringify(rows,null,2)+'\n':JSON.stringify(rows);
    assert.equal(sha(original),metric.originalSha256,key+'/'+id+' raw data digest');
    const ms=rows.map(x=>x.ms);assert(rows.every(x=>x.ms>0&&x.calls>0&&x.triangles>0));
    const duration=ms.reduce((a,b)=>a+b,0),fps=1000*ms.length/duration;
    assert.equal(ms.length,metric.frames);assert.equal(duration,metric.ms);assert.equal(fps,metric.fps);
    ms.sort((a,b)=>a-b);const p95=ms[Math.ceil(ms.length*0.95)-1];
    assert.equal(p95,metric.p95);
    const pass=fps>=yaml.threshold.fps&&p95<=yaml.threshold.p95Ms;assert.equal(pass,metric.passed);
    frames+=ms.length;passes+=Number(pass);
  }
  assert.equal(frames,report.summary.total);assert.equal(passes,report.summary.passes);
  checks.push({trial:key,frames,passes});
}
console.log(JSON.stringify(checks));
