const fs=require('node:fs'),path=require('node:path');
const artifact=process.argv[2];if(!/^gpu-[a-z0-9-]+$/.test(artifact||''))throw new Error('Expected artifact basename');
const root=path.resolve(__dirname,'../world-base/apps/desktop/e2e/fixtures/world-base/artifacts',artifact);
const result=[];
for(const file of fs.readdirSync(root).filter(f=>/^frame-samples.*\.json$/.test(f))){
 const x=JSON.parse(fs.readFileSync(path.join(root,file),'utf8')),a=Array.isArray(x)?x:x.samples||x.frames;
 if(!a)throw new Error('Unknown frame shape: '+file);
 const d=a.map(s=>typeof s==='number'?s:s.dtMs??s.frameMs??s.dt??s.ms);
 if(d.some(v=>!Number.isFinite(v)))throw new Error('Unknown sample format: '+file);
 result.push({file,count:d.length,over20ms:d.filter(v=>v>20).length,maxMs:Math.max(...d)});
}
console.log(JSON.stringify({artifact,result},null,2));
