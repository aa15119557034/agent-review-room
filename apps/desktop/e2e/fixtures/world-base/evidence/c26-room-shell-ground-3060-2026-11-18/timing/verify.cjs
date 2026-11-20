
const fs = require('node:fs'), path = require('node:path'), zlib=require('node:zlib');
const assert = require('node:assert/strict'), crypto = require('node:crypto');
const target=process.argv[2]||__dirname, yaml=JSON.parse(fs.readFileSync(path.join(target,'frame-times.json')));
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const manifest=JSON.parse(fs.readFileSync(path.join(target,'driver','x51-c26-ground26-manifest.json')));
assert.equal(yaml.source,'a281e7a8acb8557a6d8fe399a7c57eff195f5879'); assert.equal(manifest.head,yaml.source);
assert.equal(Object.keys(manifest.files).length,249);
const generators=Object.entries(manifest.upstreamRoomGenerators); assert.equal(generators.length,8);
for(const [name,entry] of generators){ assert.equal(entry.sha256,manifest.files[name]); assert.match(entry.gitBlob,/^[a-f0-9]{40}$/); }
const lots=["E1","E2","E3","E5","W1","W2","W4","W6"];
for(const run of Object.values(yaml.runs)){assert.equal(run.checkout,yaml.source); assert.equal(run.filesChecked,249); assert.deepEqual(run.roomGeneratorLotIds,lots); assert.deepEqual(run.tintedVolumeLotIds,run.mode==='on'?lots:[]);}
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
