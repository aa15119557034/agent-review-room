const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../world-base/apps/desktop/e2e/fixtures/world-base/artifacts/gpu-town-c10');
const result=[];
for(const f of fs.readdirSync(root).filter(f=>/^frame-samples.*\.json$/.test(f))){
 const x=JSON.parse(fs.readFileSync(path.join(root,f),'utf8'));
 const a=Array.isArray(x)?x:x.samples||x.frames;
 if(!a){result.push({file:f,keys:Object.keys(x)});continue;}
 const ds=a.map(s=>typeof s==='number'?s:s.dtMs??s.frameMs??s.dt??s.ms).filter(Number.isFinite);
 if(ds.length!==a.length)result.push({file:f,count:a.length,first:a[0]});
 else result.push({file:f,count:ds.length,over20:ds.filter(v=>v>20).length,max:Math.max(...ds)});
}
console.log(JSON.stringify(result,null,2));
