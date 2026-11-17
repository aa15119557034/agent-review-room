const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),zlib=require('node:zlib'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),dir=path.join(root,'preview-output/crate-opaque-ab');
function decode(file){
  const b=fs.readFileSync(file),chunks=[];let p=8,w,h,type;
  while(p<b.length){const size=b.readUInt32BE(p),name=b.toString('ascii',p+4,p+8),data=b.subarray(p+8,p+8+size);p+=size+12;
    if(name==='IHDR'){w=data.readUInt32BE(0);h=data.readUInt32BE(4);assert.equal(data[8],8);type=data[9];assert.ok(type===2||type===6);assert.equal(data[12],0);}
    if(name==='IDAT')chunks.push(data);
  }
  const channels=type===6?4:3,stride=w*channels,raw=zlib.inflateSync(Buffer.concat(chunks)),pixels=Buffer.alloc(h*stride);
  const paeth=(a,b,c)=>{const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);return pa<=pb&&pa<=pc?a:pb<=pc?b:c;};
  for(let y=0;y<h;y++){const filter=raw[y*(stride+1)];for(let x=0;x<stride;x++){
    const a=x>=channels?pixels[y*stride+x-channels]:0,b=y?pixels[(y-1)*stride+x]:0,c=y&&x>=channels?pixels[(y-1)*stride+x-channels]:0;
    const predictor=filter===0?0:filter===1?a:filter===2?b:filter===3?Math.floor((a+b)/2):filter===4?paeth(a,b,c):NaN;
    assert.ok(Number.isFinite(predictor));pixels[y*stride+x]=(raw[y*(stride+1)+1+x]+predictor)&255;
  }}
  return {w,h,channels,pixels};
}
function compare(fa,fb){const a=decode(fa),b=decode(fb);assert.deepEqual([a.w,a.h,a.channels],[b.w,b.h,b.channels]);let changed=0,sum=0,max=0;
  for(let i=0;i<a.pixels.length;i++){const d=Math.abs(a.pixels[i]-b.pixels[i]);if(d)changed++;sum+=d;max=Math.max(max,d);}
  return{width:a.w,height:a.h,channels:a.channels,changedChannels:changed,maxChannelDifference:max,meanChannelDifference:sum/a.pixels.length};
}
module.exports={decode,compare};
if(require.main===module){
const r=JSON.parse(fs.readFileSync(path.join(dir,'preview-report.json'))),[A,B,A2]=r.captures;
for(const key of ['camera','lighting','transform','renderer']){assert.deepEqual(A[key],B[key]);assert.deepEqual(A[key],A2[key]);}
assert.deepEqual(A.materials,A2.materials);
const changes=Object.keys(A.materials[0]).filter(k=>JSON.stringify(A.materials[0][k])!==JSON.stringify(B.materials[0][k]));
assert.deepEqual(changes,['transparent','depthWrite']);
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const result={strictRecordedCameraLightingTransformRendererMatch:true,onlyRecordedMaterialChanges:changes,originalMaterialRestored:true,
  originalToRestored:compare(path.join(dir,A.png),path.join(dir,A2.png)),originalToOpaque:compare(path.join(dir,A.png),path.join(dir,B.png)),
  sourceFilesUnchanged:r.originalBytesUnchanged,gpuErrors:r.captures.map(x=>x.renderer.error),exceptions:r.exceptions,failedRequests:r.failedRequests,
  exitCode:r.exitCode,pngHashes:Object.fromEntries([A,B,A2].map(x=>[x.png,hash(path.join(dir,x.png))]))};
fs.writeFileSync(path.join(dir,'comparison-check.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result,null,2));
}
