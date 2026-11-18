import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
const fixture=path.resolve(process.argv[2]);
const root=pathToFileURL(fixture+'/'), out=process.argv[3] || '.', base='dce243c', sha='47a5c12eba910682ccbf8bc9138510bc01737bf3';
const checkedSources=['src/art-r1.js','src/art-r1-city.js','src/city.js','src/city-apartments.js','src/weathering-decals.json','upstream/sakuragaoka/src/core/geo.js','upstream/sakuragaoka/src/core/ctx.js','upstream/sakuragaoka/src/world/houses/gb.js','upstream/sakuragaoka/src/world/layout.js'];
execFileSync('git',['diff','--quiet',sha,'--',...checkedSources],{cwd:fixture});
const url=p=>new URL(p,root), read=p=>fs.readFileSync(url(p),'utf8'), imp=p=>import(url(p));
registerHooks({resolve(s,c,next){if(s==='three')return {url:url('upstream/petalwake/vendor/three/build/three.module.js').href,shortCircuit:true};if(s.startsWith('three/addons/'))return {url:url('upstream/petalwake/vendor/three/examples/jsm/'+s.slice(13)).href,shortCircuit:true};return next(s,c)}});
const T=await import('three'),{GB,Frame}=await imp('upstream/sakuragaoka/src/world/houses/gb.js'),{addRearCorridor,addBackAlley}=await imp('src/art-r1-city.js');
const {makeKit}=await imp('upstream/sakuragaoka/src/core/geo.js'),{mulberry32}=await imp('upstream/sakuragaoka/src/core/ctx.js'),L=await imp('upstream/sakuragaoka/src/world/layout.js');
const model=JSON.parse(read('evidence/look-c14-2026-11-17/cpu/x51-c14-city-result.json')),apt=read('src/city-apartments.js'),art=read('src/art-r1.js');
const ctx2d=new Proxy({},{get:()=>()=>{}});globalThis.document={createElement:()=>({getContext:()=>ctx2d})};
const mat=()=>new T.MeshBasicMaterial({side:T.DoubleSide}), M={metal:mat(),atlas:mat(),lamp:mat()},A={white:[0,0],rects:{cardboard:[0,0,1,1]}}, sheet={material:mat()};
const stationOffset=[280,8,900],lamps=[],objects=[],parts={}, stats={};
const matches=(src,pattern)=>{const r=src.match(pattern);if(!r)throw Error('Absent source anchor '+pattern);return r;};
const floorHeight=Number(matches(apt,/const FH = ([\d.]+);/)[1]);
const lampLine=matches(apt,/rear\.box\(M\.lamp[^\n]+;/)[0];
const lamp=new Function('rear','M','x','y',lampLine);
const slabLine=matches(apt,/F\.boxB\(plaster, trim, w, \.14, 1\.05[^\n]+;/)[0];
const slab=new Function('F','plaster','trim','w','y','back',slabLine);
const floorOffset=Number(matches(apt,/floorY: y \+ ([.\d]+)/)[1]);
const sites=read('src/city.js').split('\n').filter(l=>l.includes("name: 'town-apartment-")&&l.includes('width:')).map(l=>({name:matches(l,/name: '([^']+)'/)[1],w:+matches(l,/width: (\d+)/)[1],depth:+matches(l,/depth: (\d+)/)[1],floors:+matches(l,/floors: (\d+)/)[1]}));
function capture(group,method,frameFn,call,name) {
  const gb=new GB({});call(frameFn(gb));const bins=[...gb.bins.values()].map(b=>({p:b.p,i:b.i}));
  const box=new T.Box3();for(const bin of bins)for(let v=0;v<bin.p.length;v+=3)box.expandByPoint(new T.Vector3(...bin.p.slice(v,v+3)));
  const id=name||group+'-'+method+'-'+objects.length;parts[id]=bins;
  const rec={id,group,method,min:box.min.toArray(),max:box.max.toArray(),tris:gb.tris};
  objects.push(rec);return rec;
}
function frameRecorder(group,frameFn){
  return Object.fromEntries(['cyl','box','boxB','raw'].map(method=>[method,(...args)=>capture(group,method,frameFn,f=>f[method](...args))]));
}
const doc={sha,baseline:base,sourceMethods:{lampLine,slabLine,floorHeight,floorOffset},buildings:{}};
for(const site of sites){
 const {name,w,depth,floors}=site,p=model.placements.find(p=>p.name===name),origin=p.worldOrigin,frame=gb=>Frame.at(gb,...origin),rear=gb=>frame(gb).sub(0,0,-depth,Math.PI);
 const lampGroup=[];
 for(let b=0;b<3;b++)lampGroup.push(capture(name,'lamp',rear,r=>lamp(r,M,(b-1)*w/3,0),name+'-lamp'+b));
 const corridor=capture(name,'slab',frame,f=>slab(f,mat(),null,w,floorHeight,-depth));
 if(floors!==4)stats[name]=addRearCorridor(frameRecorder(name,rear),M,A,sheet,{unit:w/3,w,floorY:floorOffset,rng:mulberry32('art-r3-rear-'+floors)});
 else stats[name]=addBackAlley({root:new T.Group(),ctx:{mat:{toon:mat},noOutline(){}},own:x=>x,ownTexture(){},frame:frameRecorder(name,gb=>Frame.at(gb,...stationOffset)),M,A,sheet});
 const pieces=objects.filter(o=>o.group===name), pipes=pieces.filter(p=>p.method==='cyl'&&p.max[0]-p.min[0]>1), clips=pieces.filter(p=>p.method==='box');
 const doorTop=origin[1]+2.24,lampTop=lampGroup[0].max[1],floor=origin[1]+.14;
 const cards=pieces.filter(o=>o.method==='boxB'),notice=pieces.find(o=>o.method==='raw');
 const doorXs=Array.from({length:3},(_,i)=>origin[0]-(i-1)*w/3);
 const gapX=(xmin,xmax,centers,half)=>Math.min(...centers.map(x=>Math.max(0,xmin-x-half,x-xmax-half)));
 doc.buildings[name]={origin,width:w,depth,stats:stats[name],doorTop,lampTop,finishFloor:floor,slabUnderside:corridor.min[1],slabWorldBounds:[corridor.min,corridor.max],horizontalPipes:pipes.map(q=>({id:q.id,min:q.min,max:q.max,lampGap:q.min[1]-lampTop,doorGap:q.min[1]-doorTop,slabGap:corridor.min[1]-q.max[1],overlapsSlabXZ:[0,2].every(i=>q.min[i]<corridor.max[i]&&corridor.min[i]<q.max[i])})),clips:{count:clips.length,minLampGap:Math.min(...clips.map(q=>q.min[1]-lampTop)),minSlabGap:Math.min(...clips.map(q=>corridor.min[1]-q.max[1])),embedded:clips.filter(q=>q.max[1]>corridor.min[1]&&[0,2].every(i=>q.min[i]<corridor.max[i]&&corridor.min[i]<q.max[i])).length},cardboardMinDoorHorizontalGap:Math.min(...cards.map(o=>gapX(o.min[0],o.max[0],doorXs,.515))),noticeMinDoorHorizontalGap:notice?gapX(notice.min[0],notice.max[0],doorXs,.515):null};
}
const decals=JSON.parse(read('src/weathering-decals.json')),before=JSON.parse(execFileSync('git',['show',base+':apps/desktop/e2e/fixtures/world-base/src/weathering-decals.json'],{cwd:fixture,encoding:'utf8'}));doc.decals={allItemsUnchanged:JSON.stringify(before.items)===JSON.stringify(decals.items),total:decals.items.length,hitByDecoration:[]};
const decorated=objects.filter(o=>['cyl','box','boxB','raw'].includes(o.method)).flatMap(o=>parts[o.id].map(bin=>{const g=new T.BufferGeometry();g.setAttribute('position',new T.Float32BufferAttribute(bin.p,3));g.setIndex(bin.i);const m=new T.Mesh(g,mat());m.name=o.id;return m}));
const ray=new T.Raycaster();
for(const [idx,it] of decals.items.entries()){
 const n=new T.Vector3(...it.normal).normalize(),right=new T.Vector3(...it.right),up=n.clone().cross(right).normalize(),center=new T.Vector3(...it.pos).add(new T.Vector3(...stationOffset));const hits=[];
 for(const u of [-.5,0,.5])for(const v of [-.5,0,.5]){
  const point=center.clone().addScaledVector(right,u*it.w).addScaledVector(up,v*it.h);
  ray.set(point.clone().addScaledVector(n,.7),n.clone().negate());ray.near=0;ray.far=.7-.002;const h=ray.intersectObjects(decorated,false)[0];if(h)hits.push({u,v,piece:h.object.name,distance:h.distance});
 }
 if(hits.length)doc.decals.hitByDecoration.push({idx,hits});
}
// Use the untouched board, flags, lot-selection and statistics bodies from this SHA.
// Texture callbacks draw into a no-op CPU canvas. Actual kit and BufferGeometry supply every vertex/index.
const head=art.slice(art.indexOf('const C = ctx.services'),art.indexOf('// ---------------------------------------------------------------- A: parked'));
const board=art.slice(art.indexOf('const board ='),art.indexOf('// ---------------------------------------------------------------- B: W1'));
const lotBlock=art.slice(art.indexOf('// ---------------------------------------------------------------- round 3: a folding'),art.indexOf('return { stats };'));
if(!head||!board||!lotBlock.includes('noboriTris'))throw Error('Cannot isolate actual fixture excerpts.');
const groups=[], C={M:{t:mat},space(id){const g=new T.Group(),lot=L.lotById(id),f=L.lotFrame(lot);g.name=id;g.position.set(f.x,f.y,f.z);g.rotation.y=f.rotY;groups.push(g);return {g,k:makeKit(g),toW:(x,z)=>L.lotToWorld(lot,x,z),f}}};
const sctx={services:{shopsA:{buildContext:C}},L,rng:mulberry32,physics:{groundHeight:L.heightAt},kit:makeKit,tex:{draw:(w,h,draw)=>{draw(ctx2d,w,h);return new T.Texture()},fitText(){},FONTS:{sans:'sans-serif'}},mat:{toon:(_,opts)=>{const m=mat();m.name=opts.name;return m}},addStatic:g=>groups.push(g),noOutline(){}};
const stationStats=new Function('THREE','ctx',head+board+lotBlock+'return stats;')(T,sctx);
const shape=g=>{let triangles=0,zeroArea=0,meshes=0;const a=new T.Vector3(),b=new T.Vector3(),c=new T.Vector3();g.updateMatrixWorld(true);g.traverse(o=>{if(!o.isMesh)return;meshes++;const geo=o.geometry,p=geo.attributes.position,idx=geo.index;for(let j=0;j<(idx?.count??p.count);j+=3){const at=k=>idx?idx.getX(j+k):j+k;a.fromBufferAttribute(p,at(0)).applyMatrix4(o.matrixWorld);b.fromBufferAttribute(p,at(1)).applyMatrix4(o.matrixWorld);c.fromBufferAttribute(p,at(2)).applyMatrix4(o.matrixWorld);if(b.sub(a).cross(c.sub(a)).lengthSq()<1e-20)zeroArea++;triangles++;}});return {meshes,triangles,zeroArea};};
doc.station={stats:stationStats.nobori,flags:shape(groups.find(g=>g.name==='art-r1-nobori')),boards:groups.filter(g=>g.name!=='art-r1-nobori').map(g=>({lot:g.name,...shape(g),face:g.children[0].children[0].children.find(m=>m.material?.name?.includes('board'))?.material.name,rootLotXZ:g.children[0].position.toArray().filter((_,i)=>i!==1)})),CPUOnly:true};
fs.writeFileSync(path.join(out,'geometry.json'),JSON.stringify(doc,null,2)+'\n');
const CParts=Object.fromEntries(objects.filter(o=>o.group==='town-apartment-4f'&&['lamp','cyl','box'].includes(o.method)).map(o=>[o.id,{method:o.method,bins:parts[o.id]}]));
fs.writeFileSync(path.join(out,'C-bins.json'),JSON.stringify(CParts));
console.log(JSON.stringify({buildings:doc.buildings,decals:doc.decals,station:doc.station}));
