const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {compare}=require('./check-crate-ab.cjs');
const root=path.resolve(__dirname,'..'),dir=path.join(root,'preview-output/crate-mask-ab');
const r=JSON.parse(fs.readFileSync(path.join(dir,'preview-report.json'))),[A,O,M,A2]=r.captures;
for(const record of [O,M,A2])for(const key of ['camera','lighting','transform','renderer'])assert.deepEqual(record[key],A[key]);
assert.deepEqual(A.materials,A2.materials);
const changed=Object.keys(O.materials[0]).filter(k=>JSON.stringify(O.materials[0][k])!==JSON.stringify(M.materials[0][k]));
assert.deepEqual(changed,['alphaTest','alphaMap','alphaMapFlipY','alphaMapColorSpace','alphaMapChannel']);
assert.equal(M.materials[0].alphaTest,.5);assert.equal(M.materials[0].alphaMapFlipY,false);
assert.equal(M.materials[0].alphaMapColorSpace,'');assert.equal(M.materials[0].alphaMapChannel,0);
assert.equal(M.materials[0].aoMap,false);assert.equal(M.materials[0].transparent,false);assert.equal(M.materials[0].depthWrite,true);
assert.equal(M.adaptation.unchangedOtherMapReferences,true);assert.equal(M.adaptation.sideUnchanged,true);
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const original=JSON.parse(fs.readFileSync(path.join(root,'download-receipt.json')));
for(const file of original.files)assert.equal(hash(fs.readFileSync(path.join(root,'downloads',file.path))),file.sha256);
const opacity=JSON.parse(fs.readFileSync(path.join(root,'supplemental/opacity-receipt.json')));
const bytes=fs.readFileSync(path.join(root,opacity.path));assert.equal(hash(bytes),opacity.sha256);
assert.equal(bytes.readUInt32BE(16),1024);assert.equal(bytes.readUInt32BE(20),1024);assert.equal(bytes[24],8);assert.equal(bytes[25],0);
const imageRecords=r.captures.map(c=>({path:c.png,bytes:fs.statSync(path.join(dir,c.png)).size,sha256:hash(fs.readFileSync(path.join(dir,c.png)))}));
const sources=['index.html','viewer.js','electron-main.cjs'].map(p=>({path:'preview/'+p,sha256:hash(fs.readFileSync(path.join(__dirname,p)))}));
const result={recordedCameraLightingTransformRendererIdentical:true,opaqueToMaskedRecordedMaterialChanges:changed,
  originalToRestored:compare(path.join(dir,A.png),path.join(dir,A2.png)),opaqueToMasked:compare(path.join(dir,O.png),path.join(dir,M.png)),
  original13FilesUnchanged:true,supplementalMaskUnchanged:true,mask:{path:'../../'+opacity.path,sha256:opacity.sha256,bytes:opacity.bytes,width:1024,height:1024,bitDepth:8,pngColorType:0,meaning:'grayscale'},
  nonAlphaMapReferencesIdentical:true,aoAdded:false,sideChanged:false,originalMaterialRestored:true,
  gpuErrors:r.captures.map(c=>c.renderer.error),contextLost:r.captures.some(c=>c.renderer.contextLost),exceptions:r.exceptions,failedRequests:r.failedRequests,exitCode:r.exitCode,
  pngFiles:imageRecords,viewerSourcesAtCapture:sources};
assert.equal(r.exitCode,0);assert.equal(r.exceptions.length,0);assert.equal(r.failedRequests.length,0);
fs.writeFileSync(path.join(dir,'comparison-check.json'),JSON.stringify(result,null,2)+'\n');
fs.writeFileSync(path.join(root,'preview-output/source-provenance.json'),JSON.stringify({original13:original,supplementalOpacity:opacity},null,2)+'\n');
console.log(JSON.stringify(result,null,2));
