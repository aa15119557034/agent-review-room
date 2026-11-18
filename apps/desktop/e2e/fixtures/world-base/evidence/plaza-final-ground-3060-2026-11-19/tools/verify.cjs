'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path'),z=require('node:zlib');
const root=path.resolve(__dirname,'..'),read=(...parts)=>fs.readFileSync(path.join(root,...parts)),json=(...parts)=>JSON.parse(read(...parts)),gz=(...parts)=>JSON.parse(z.gunzipSync(read(...parts)));
const sha=b=>crypto.createHash('sha256').update(b).digest('hex'),pictures=json('photos.json'),runs=json('runs.json'),performance=json('performance','comparison.json');
assert.equal(runs.source,pictures.final);
assert.equal(gz('source-files.json.gz').source,runs.source);
assert(runs.visual.every(s=>s.exit===0) && runs.timings.length===2 && runs.timings.every(s=>s.exit===0));
assert.equal(runs.photoReceiptRun.exit,0);assert.equal(runs.diagnosticPhoto.exit,1);
assert.equal(Object.keys(pictures.photos).length,8);
for(const [name,photo] of Object.entries(pictures.photos)){
    assert.equal(photo.glError,0);assert.equal(photo.clock,14);assert.deepEqual(photo.canvas,[1440,900]);
    const source=name+'.png',img=read(source);
    assert.equal(img.readUInt32BE(16),1440);assert.equal(img.readUInt32BE(20),900);
    assert.equal(photo.afterHashes.at(-1),sha(img));
    const dual=runs.pixelRepeat.audited[source],audit=dual.changed?read(dual.alternateFile):img;
    assert.equal(sha(audit),runs.auditedPhotos[name].hashes.at(-1));
}
assert.equal(pictures.returnA.changed,0);
assert.deepEqual(pictures.photos['art-a-street'].gateText.maxRGB,[2,1,1]);
for(const name of ['bake-afternoon','bake-evening','timing-1','timing-2','photos']){
   const {audit,summary}=gz('transport',name+'.json.gz');
   assert(audit.payloadIntegrityClean && !audit.strictTransportClean && !audit.problems.length);
   const s=new Map(audit.served.map(r=>[r.receipt,r])),ids=new Map(audit.requests.map(r=>[r.requestId,r]));
   assert.equal(s.size,summary.originHTTP);assert.equal(ids.size,audit.requests.length);
   const collected=new Set();
   for(const req of audit.requests.filter(r=>r.url!=='blob:fixture')){
       assert(!collected.has(req.receipt));collected.add(req.receipt);
       const srv=s.get(req.receipt);assert.equal(srv.path,req.url);assert.equal(srv.status,req.status);
       assert.equal(srv.method,req.method);assert(srv.finished && srv.sha256===srv.wireSHA256 && srv.fileBytes===srv.wireBytes);
   }
   assert.equal(collected.size,s.size);
   for(const r of audit.reads){const server=s.get(r.receipt);assert(r.done && !r.aborted && !r.readError && r.received===server.fileBytes && r.sha256===server.sha256);}
   for(const r of audit.verifiedCanceled){assert.equal(r.receipt,ids.get(r.requestId).receipt);assert.equal(audit.reads.find(a=>a.receipt===r.receipt).sha256,r.sha256);}
}
for(const r of performance.runs){
    const b=read('performance',r.rawFile),frames=JSON.parse(z.gunzipSync(b));
    assert.equal(sha(b),r.sha256);assert.equal(r.source,runs.source);assert.equal(r.nativeExit,0);assert.equal(r.outsideExit,0);
    assert(r.renderOk && r.payloadIntegrityClean && !r.transportClean);
    assert.equal(r.routes.length,6);
    for(const s of r.routes){const x=frames[s.id].map(f=>f.ms).sort((a,b)=>a-b);assert.equal(x.length,s.frames);assert.equal(x[Math.ceil(.95*x.length)-1],s.rafMs.p95);assert.equal(x.filter(t=>t>20).length,s.over20);assert(s.host.length&&s.device.length);}
}
console.log('8 final native PNGs and independent rerun, 5 same-request audits and 12 frame series validated.');
