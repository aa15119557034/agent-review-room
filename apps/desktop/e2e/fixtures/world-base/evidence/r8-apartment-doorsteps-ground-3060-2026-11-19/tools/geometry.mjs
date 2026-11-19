// node geometry.mjs <before-world-base> <after-world-base> <output.json>
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerHooks } from 'node:module';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
const [before, after, output] = process.argv.slice(2);
for(const [fixture,expected] of [[before,'eb000ad5f3bd976cfbb485fe3606442c82309ab5'],[after,'be8879045b4908695fa62342afc1a0b9ec05bb96']]){
  const repo=path.resolve(fixture,'../../../../..').split(path.sep).join('/');
  assert.equal(execFileSync('git',['-c','safe.directory='+repo,'-C',repo,'rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim(),expected);
}
const url = rel => pathToFileURL(path.join(after,rel)).href;
const read = (base,rel) => fs.readFileSync(path.join(base,rel),'utf8');
registerHooks({resolve(name,context,next){
  if(name==='three')return {url:url('upstream/petalwake/vendor/three/build/three.module.js'),shortCircuit:true};
  if(name.startsWith('three/addons/'))return {url:url('upstream/petalwake/vendor/three/examples/jsm/'+name.slice(13)),shortCircuit:true};
  return next(name,context);
}});
const THREE=await import('three');
const {GB,Frame}=await import(url('upstream/sakuragaoka/src/world/houses/gb.js'));
const {makeProps}=await import(url('upstream/sakuragaoka/src/world/houses/props.js'));
const {addDoorsteps}=await import(url('src/art-r1-city.js'));
const originalRng=read(after,'upstream/sakuragaoka/src/core/ctx.js').match(/export (function mulberry32[\s\S]*?\n})/)[1];
const mulberry32=Function('return ('+originalRng+')')();
const M=new Proxy({}, {get(obj,k){return obj[k]??=(new THREE.MeshBasicMaterial());}});
const P=makeProps({M,A:{},ctx:{},lod:2});
const records=[], floors=[];
const city=read(after,'src/city.js');
const apartment=read(after,'src/city-apartments.js');
assert(apartment.includes('const FH = 2.85;') && apartment.includes('unit = w / 3'));
assert(apartment.includes('art-r8-door-${floors}-${fl}')&&apartment.includes('[[unit / 2 - .5, unit / 2 + 1.0]]')&&apartment.includes('[[-5.5, -4.5]]'));
const sites=[...city.matchAll(/name: 'town-apartment-(\df)'.*?width: (\d+), depth: (\d+), floors: (\d+).*?shop: (true|false)/g)];
assert.equal(sites.length,3);
const parcels=[{center:[-5.15,.135,.37],size:[.46,.27,.36]}, {center:[-5.12,.36,.37],size:[.34,.18,.30]}];
assert(city.includes('rear.boxB(M.atlas, \'#ffffff\', .46, .27, .36, -5.15, 2.85, .37'));
assert(city.includes('rear.boxB(M.atlas, \'#eee2cf\', .34, .18, .30, -5.12, 3.12, .37'));
const vec=a=>new THREE.Vector3(...a);
const parcelBoxes=parcels.map(p=>new THREE.Box3().setFromCenterAndSize(vec(p.center),vec(p.size)));
function collect(kind,run,location,metadata) {
  const gb=new GB({}), frame=Frame.at(gb,0,0,0);
  run(frame);
  const box=new THREE.Box3();
  const hits=new Set();
  const parcelWitness={};
  let wallVertex=null;
  for(const b of gb.bins.values()){
    const vertex=i=>vec(b.p.slice(3*i,3*i+3));
    for(let i=0;i<b.p.length/3;i++){
      const pt=vertex(i);
      box.expandByPoint(pt);
      if(pt.z<0 && pt.z>-.26 && pt.y>.02 && (!wallVertex||pt.z<wallVertex[2]))wallVertex=pt.toArray();
    }
    if(location[0]==='4f'&&location[1]===2){
      for(let i=0;i<b.i.length;i+=3){
        const tri=new THREE.Triangle(...b.i.slice(i,i+3).map(vertex));
        parcelBoxes.forEach((p,k)=>{
          if(p.intersectsTriangle(tri))hits.add(k+1);
          if(parcelWitness[k+1])return;
          for(const pt of [tri.a,tri.b,tri.c]){
            const inside=[0,1,2].every(d=>pt.getComponent(d)>p.min.getComponent(d)+.001&&pt.getComponent(d)<p.max.getComponent(d)-.001);
            if(inside){parcelWitness[k+1]=pt.toArray();break;}
          }
        });
      }
    }
  }
  const record={site:location[0],floor:location[1],kind,...metadata,min:box.min.toArray(),max:box.max.toArray(),triangles:gb.tris,parcelBoxHits:[...hits],parcelInteriorVertex:parcelWitness,wallSpaceVertex:wallVertex};
  records.push(record);
}
for(const [,site,ww,,fc,shop] of sites) {
 const w=Number(ww),count=Number(fc),unit=w/3;
 for(let fl=0;fl<count;fl++){
   const loc=[site,fl+1],avoid=fl===0?(shop==='true'?[[-5.5,-4.5]]:[[unit/2-.5,unit/2+1]]):[];
   const wrapped={};
   for(const k of ['pot','bucket','wateringCan'])wrapped[k]=(ignored,x,y,z,...rest)=>collect(k,f=>P[k](f,x,y,z,...rest),loc,{anchor:[x,y,z]});
   const fakeFrame={cyl:(mat,color,radius,h,x,y,z,opts)=>collect(radius===.11?'stand':radius===.028?'folded':'standUmbrella',f=>f.cyl(mat,color,radius,h,x,y,z,opts),loc,{anchor:[x,y,z]})};
   const counts=addDoorsteps(fakeFrame,M,wrapped,{unit,ground:fl===0,floorY:0,rng:mulberry32('art-r8-door-'+count+'-'+fl),avoid});
   const onFloor=records.filter(r=>r.site===site&&r.floor===fl+1);
   for(const rec of onFloor) {
     rec.doorGap=Math.min(...[-unit,0,unit].map(x=>Math.max(rec.min[0]-(x+.515),(x-.515)-rec.max[0])));
     rec.avoidGap=avoid.length?Math.min(...avoid.map(([lo,hi])=>Math.max(rec.min[0]-hi,lo-rec.max[0]))):null;
     rec.edgeGap=w/2-Math.max(Math.abs(rec.min[0]),Math.abs(rec.max[0]));
   }
   floors.push({site,floor:fl+1,...counts,triangles:onFloor.reduce((s,r)=>s+r.triangles,0)});
 }
}
const maxZ=Math.max(...records.map(r=>r.max[2]));
const decals=[before,after].map(p=>JSON.parse(read(p,'src/weathering-decals.json')));
assert.deepEqual(decals[0].items,decals[1].items);assert.equal(decals[1].items.length,26);
const out={decals:{fingerprints:decals.map(d=>d.fingerprint),identicalItems:decals[0].items.length},
 counts:Object.fromEntries(['stands','pots','small','triangles'].map(k=>[k,floors.reduce((s,f)=>s+f[k],0)])),
 pieceCounts:Object.fromEntries([...new Set(records.map(v=>v.kind))].map(k=>[k,records.filter(v=>v.kind===k).length])),
 clearance:{maxZ,remainingToSlabEdge:1.05-maxZ,remainingToStairLanding:.925-maxZ,minDoorGap:Math.min(...records.map(r=>r.doorGap)),minAvoidSpanGap:Math.min(...records.filter(v=>v.avoidGap!==null).map(r=>r.avoidGap)),minSideEdgeGap:Math.min(...records.map(r=>r.edgeGap)),insideUpperParcel:records.filter(r=>r.parcelBoxHits.length)},floors,records};
fs.writeFileSync(output,JSON.stringify(out,null,2)+'\n');
console.log(JSON.stringify({counts:out.counts,details:out.pieceCounts,clearance:out.clearance}));
