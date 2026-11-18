import fs from 'node:fs';import path from 'node:path';import {pathToFileURL} from 'node:url';import {registerHooks} from 'node:module';
const fixture=pathToFileURL(path.resolve(process.argv[2])+'/'),v=new URL('upstream/petalwake/vendor/three/build/three.module.js',fixture);
registerHooks({resolve(s,c,next){return s==='three'?{url:v.href,shortCircuit:true}:next(s,c)}});
const THREE=await import('three'),{GB,Frame}=await import(new URL('upstream/sakuragaoka/src/world/houses/gb.js',fixture));
const raw=JSON.parse(fs.readFileSync(new URL('evidence/look-c14-2026-11-17/cpu/x51-c14-city-result.json',fixture)));const origin=raw.placements.find(p=>p.name==='town-apartment-4f').worldOrigin;
const parts={};const mat=new THREE.MeshBasicMaterial();function emit(name,build){const gb=new GB({});build(gb);const bins=Array.from(gb.bins.values());parts[name]=bins.map(o=>({p:o.p,i:o.i}));}
const cFrame=gb=>Frame.at(gb,280,8,900),bFrame=gb=>Frame.at(gb,...origin),rear=gb=>bFrame(gb).sub(0,0,-9,Math.PI),base=4.78,front=-1.25;
for(let bay=0;bay<3;bay++){emit('lamp'+bay,gb=>rear(gb).box(mat,null,.24,.065,.08,(bay-1)*4+.75,2.42,.045));}
for(let [y,r] of [[2.34,.034],[2.5,.027]]){emit('pipe'+y,gb=>cFrame(gb).cyl(mat,null,r,6.2,-.8,base+y,-131.1,{rz:Math.PI/2,seg:8}));emit('clips'+y,gb=>{for(let x=-3.4;x<2.4;x+=1.4)cFrame(gb).box(mat,null,.05,.1,.05,x,base+y,-131.07)});}
emit('riser',gb=>cFrame(gb).cyl(mat,null,.04,2.5,-3.6,base+1.25,-131.1,{seg:8}));
// Proposed heights, keeping x/z, brackets, and original tube radii. These do not appear in the screenshots.
for (const [y,r] of [[2.58,.034],[2.72,.027]]) {
  emit('suggestedPipe'+y,gb=>cFrame(gb).cyl(mat,null,r,6.2,-.8,base+y,-131.1,{rz:Math.PI/2,seg:8}));
  emit('suggestedClips'+y,gb=>{for(let x=-3.4;x<2.4;x+=1.4)cFrame(gb).box(mat,null,.05,.1,.05,x,base+y,-131.07);});
}
emit('suggestedRiser',gb=>cFrame(gb).cyl(mat,null,.04,2.72,-3.6,base+1.36,-131.1,{seg:8}));
for(const [key,w,x] of [['old',4.6,.45],['new',5.3,.4]])emit(key+'Band',gb=>bFrame(gb).box(mat,null,w,.44,.025,x,2.55,front+1.062,{shadow:false}));
emit('panel',gb=>bFrame(gb).boxB(mat,null,.6,2.07,.08,3.5,.16,front+.04,{skip:'b'}));
emit('print',gb=>bFrame(gb).box(mat,null,4.56,.42,.000001,.45,2.55,front+1.0755,{skip:'rltdb'}));
emit('panelPrint',gb=>bFrame(gb).box(mat,null,.50,.78,.000001,3.5,1.47,front+.081,{skip:'rltdb'}));
console.log(JSON.stringify({origin,parts}));
