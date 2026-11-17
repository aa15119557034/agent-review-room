'use strict';
// Read-only reproduction of the numeric C12 analysis; stdout only, no Electron/GPU.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fixture = 'D:/codex/2026-11-16/world-implementation/world-base/apps/desktop/e2e/fixtures/world-base';
const dir = process.argv[2] || path.join(fixture, 'artifacts/gpu-look-c12-v1');
const ffmpeg = process.argv[3] || 'E:/AI/ComfyUI-aki-v3.2-core037/python/Lib/site-packages/imageio_ffmpeg/binaries/ffmpeg-win-x86_64-v7.1.exe';
const read = name => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
const report = read('look-report.json');
const old = read('legacy-c8-reference.json');
const capture = name => {
  const found = report.captures.find(c => c.name === name);
  if (!found) throw new Error(`Missing capture: ${name}`);
  return found;
};
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const pixels = (name, folder=dir) => {
  const data = execFileSync(ffmpeg, ['-v', 'error', '-i', path.join(folder, name + '.png'), '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'], { windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
  if (data.length !== 1440 * 900 * 4) throw new Error('Unexpected image size');
  return data;
};
const on = capture('service-corner-legacy-c8-ao-on-capture-2');
const off = capture('service-corner-legacy-c8-ao-off-capture-2');
const points = [[763, 369], [762, 459]].map(([x, y], r) => {
  const roi = on.linearPixels[r].roi;
  const fi = ((y - roi.y) * roi.width + x - roi.x) * 4;
  const li = ((roi.height - 1 - (y - roi.y)) * roi.width + x - roi.x) * 4;
  const value = c => ({ comp: c.linearPixels[r].comp.decodedRGBA.slice(li, li + 3), final: c.finalPixels[r].rawRGBA.slice(fi, fi + 3) });
  return { x, y, c8: value(old), c12on: value(on), c12off: value(off) };
});
const repeats = report.captures.filter(c => c.pass === 'capture-1').map(a => {
  const b = capture(a.name.replace('capture-1', 'capture-2'));
  return { name: a.name.replace('-capture-1', ''), pngEqual: a.pngSha256 === b.pngSha256, cameraEqual: equal(a.camera, b.camera), timeEqual: a.time === b.time, paramsEqual: equal(a.params, b.params), materialsUnchanged: a.materialsUnchanged && b.materialsUnchanged };
});
const shopOn = pixels('shop-interior-ao-on-capture-2');
const shopOff = pixels('shop-interior-ao-off-capture-2');
const rows = [];
for (let y = 280; y < 330; y++) {
  const a = [0, 0, 0], b = [0, 0, 0];
  let maxAbsRGB = 0;
  for (let x = 270; x < 430; x++) for (let k = 0; k < 3; k++) {
    const i = (y * 1440 + x) * 4 + k;
    a[k] += shopOn[i] / 160; b[k] += shopOff[i] / 160;
    maxAbsRGB = Math.max(maxAbsRGB, Math.abs(shopOn[i] - shopOff[i]));
  }
  rows.push({ y, on: a, off: b, delta: a.map((v, k) => v - b[k]), maxAbsRGB });
}
const la = pixels('laundry-details-ao-on-capture-1'), lb = pixels('laundry-details-ao-on-capture-2');
const laundry = { changedPixels: 0, changedChannels: 0, maxAbsRGB: 0, sumAbsRGB: 0 };
for (let i = 0; i < la.length; i += 4) {
  let changed = false;
  for (let k = 0; k < 3; k++) {
    const d = Math.abs(la[i + k] - lb[i + k]);
    if (d) { changed = true; laundry.changedChannels++; }
    laundry.maxAbsRGB = Math.max(laundry.maxAbsRGB, d); laundry.sumAbsRGB += d;
  }
  if (changed) laundry.changedPixels++;
}
laundry.meanAbsRGB = laundry.sumAbsRGB / (1440 * 900 * 3);
const hdr = on.linearPixels.map((q, r) => ({ roi: q.roi, sceneC8C12: equal(q.scene.rawHalfWords, old.linearPixels[r].scene.rawHalfWords), compC8C12: equal(q.comp.rawHalfWords, old.linearPixels[r].comp.rawHalfWords), sceneOnOff: equal(q.scene.rawHalfWords, off.linearPixels[r].scene.rawHalfWords), compOnOff: equal(q.comp.rawHalfWords, off.linearPixels[r].comp.rawHalfWords) }));

function pixelDiff(a,b){let changedPixels=0,sum=0,maxAbsRGB=0;const bounds={gt0:[1440,900,-1,-1],gt1:[1440,900,-1,-1],gt4:[1440,900,-1,-1]};for(let p=0;p<a.length;p+=4){let dmax=0;for(let k=0;k<3;k++){const d=Math.abs(a[p+k]-b[p+k]);sum+=d;maxAbsRGB=Math.max(maxAbsRGB,d);dmax=Math.max(dmax,d);}if(dmax){changedPixels++;const x=p/4%1440,y=Math.floor(p/4/1440);for(const [key,t]of [['gt0',0],['gt1',1],['gt4',4]])if(dmax>t){const b=bounds[key];b[0]=Math.min(b[0],x);b[1]=Math.min(b[1],y);b[2]=Math.max(b[2],x);b[3]=Math.max(b[3],y);}}}return{changedPixels,meanAbsRGB:sum/(1440*900*3),maxAbsRGB,bounds:Object.fromEntries(Object.entries(bounds).map(([k,b])=>[k,b[2]<0?null:{minX:b[0],minY:b[1],maxX:b[2],maxY:b[3]}]))};}

const c11dir=path.join(fixture,'artifacts/gpu-look-c11-v1'),c11report=JSON.parse(fs.readFileSync(path.join(c11dir,'look-report.json'),'utf8'));
const c11Comparisons=report.captures.filter(c=>c.pass==='capture-2').map(a=>{const b=c11report.captures.find(c=>c.name===a.name);if(!b)throw new Error('Missing C11 capture '+a.name);return{name:a.name,cameraEqual:equal(a.camera,b.camera),timeEqual:a.time===b.time,lookParamsEqual:equal(a.params,b.params),aoEqual:a.ao===b.ao,c11PngSha256:b.pngSha256,c12PngSha256:a.pngSha256,pixels:pixelDiff(pixels(a.name),pixels(a.name,c11dir))};});
const manifest=read('source-manifest.json'),previousManifest=JSON.parse(fs.readFileSync(path.join(c11dir,'source-manifest.json'),'utf8'));
const changedSourceFiles=[...new Set([...Object.keys(manifest.files),...Object.keys(previousManifest.files)])].filter(k=>manifest.files[k]!==previousManifest.files[k]);
const c11Shop=c11report.lightPixelComparisons.find(q=>q.view==='shop-interior');

const materialROIs=[{name:'laundry-pavement',view:'laundry-details',x:590,y:780,width:70,height:40,limit:'Small visible paving patch; no semantic segmentation.'},{name:'laundry-plaster',view:'laundry-details',x:1000,y:350,width:80,height:80,limit:'Wall texture patch, not a material albedo measurement.'},{name:'shop-teal-behind-glass',view:'21-front-eye',x:440,y:460,width:40,height:14,limit:'Composite through glass; not isolated wall colour or glass transmittance.'}].map(roi=>{const name=roi.view+'-ao-on-capture-2',a=pixels(name,c11dir),b=pixels(name);const meanA=[0,0,0],meanB=[0,0,0];let changedPixels=0,maxAbsRGB=0,sum=0;for(let y=roi.y;y<roi.y+roi.height;y++)for(let x=roi.x;x<roi.x+roi.width;x++){let change=false;for(let k=0;k<3;k++){const i=(y*1440+x)*4+k,d=Math.abs(a[i]-b[i]);meanA[k]+=a[i]/(roi.width*roi.height);meanB[k]+=b[i]/(roi.width*roi.height);sum+=d;maxAbsRGB=Math.max(maxAbsRGB,d);change ||= d>0;}if(change)changedPixels++;}return{roi,c11:meanA,c12:meanB,changedPixels,maxAbsRGB,meanAbsRGB:sum/(roi.width*roi.height*3)};});

console.log(JSON.stringify({materialROIs,artifactDirectory:dir,sourceHead:manifest.head,reportSha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(dir,'look-report.json'))).digest('hex'),status:{stage:report.stage,ok:report.ok,renderOk:report.renderOk,transportClean:report.transportClean,sourceUnchanged:report.sourceUnchanged,driverUnchanged:report.driverUnchanged,assetsUnchanged:report.assetsUnchanged,networkFailures:report.networkFailures,httpErrors:report.httpErrors,exceptions:report.exceptions,restore:report.restore},c11Reference:read('c11-reference.json'),changedSourceFiles,c11Comparisons,cityMaterialAudit:report.cityShadowAudit,surfaceRays:report.captures.filter(c=>c.pass==='capture-2'&&c.ao===.55).map(c=>({view:c.view,rays:c.lightEvidence.surfaceRays})),lightMaterials:report.initial.lightMaterials,lightPixelComparisons:report.lightPixelComparisons,shopGeometryRays:capture('shop-interior-ao-on-capture-2').lightEvidence.geometryRays,cameraExact:equal(old.camera,on.camera),hdr,points,repeats,laundryRepeat:laundry,shopROI:{x:270,y:280,width:160,height:50},rows,c11Shop,units:'Final encoded RGB bytes, not linear luminance. Cross-revision differences are measured, not required to be zero; paired camera/time/look equality is reported. CPU PNG decoding only, no image edits. Raw geometry UV metric must be combined with texture repeat; ray hit is not fragment identity.'},null,2));
