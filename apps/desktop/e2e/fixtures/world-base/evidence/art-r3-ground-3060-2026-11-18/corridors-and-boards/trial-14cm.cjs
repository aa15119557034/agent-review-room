const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const fixture=path.resolve(process.argv[2] || '../../..');
const directory=process.argv[3] ? path.resolve(process.argv[3]) : fs.mkdtempSync(path.join(require('node:os').tmpdir(),'x51-r3-corridor-'));
fs.mkdirSync(directory,{recursive:true});
const original=fs.readFileSync(path.join(fixture,'evidence/art-r3-ground-3060-2026-11-18/corridors-and-boards/geometry.mjs'),'utf8');
const trial=`
const realDoor=apt.match(/function recessedDoor\\(H, F, o\\) \\{[\\s\\S]*?\\n\\}/)[0];
const addDoor=new Function(realDoor+'; return recessedDoor')();
const openLine=matches(apt,/const opening = \\{ x: 0, y: y \\+ \\.16, w: 1\\.03, h: 2\\.08 \\};/)[0];
const rearOpening=new Function('y',openLine+'return opening;')(0);
const result={source:sha,stationOffset,dy:-.14,method:'Source-mesh bounds, per primitive. Guaranteed vertical gap above obstacles / below slab across every pair, plus count of pairs whose X and Z extents intersect. Door assemblies include slab, printed face, jambs and threshold.'};
function separation(p,b){return Math.max(0,...[0,1,2].map(i=>Math.max(p.min[i]-b.max[i],b.min[i]-p.max[i])));}
for(const site of sites.filter(s=>s.floors!==4)){
 const {name,w,depth}=site,p=model.placements.find(p=>p.name===name),origin=p.worldOrigin;
 const rear=gb=>Frame.at(gb,...origin).sub(0,0,-depth,Math.PI);
 const H={M,A:{...A,rects:{...A.rects,door_steel:[0,0,1,1]}},apartmentSurfaces:{materials:{metal:M.metal}}};
 const group=objects.filter(o=>o.group===name);
 const doorParts=[];
 for(let bay=0;bay<3;bay++){
   const ff=gb=>rear(gb).sub((bay-1)*w/3,0,0);
   const segment=frameRecorder(name+'-doors',ff);const start=objects.length;
   addDoor(H,segment,rearOpening);doorParts.push(...objects.slice(start));
 }
 const pipes=group.filter(o=>o.method==='cyl'||o.method==='box').map(o=>{
   const gbounds=new T.Box3();
   for(const bin of parts[o.id]) for(let k=0;k<bin.p.length;k+=3){
     const v=new T.Vector3(...bin.p.slice(k,k+3));v.y-=.14;gbounds.expandByPoint(v);
   }
   return {...o,min:gbounds.min.toArray(),max:gbounds.max.toArray()};
 });
 const categories={doors:doorParts,lamps:group.filter(o=>o.method==='lamp'),boxes:group.filter(o=>o.method==='boxB'),notice:group.filter(o=>o.method==='raw'),slab:group.filter(o=>o.method==='slab')};
 const r={count:pipes.length};
 for(const [target,bodies] of Object.entries(categories)){
   const pairs=pipes.flatMap(p=>bodies.map(b=>({p,b})));
   if(!pairs.length)throw Error('No bodies for '+target);
   const overlapsXZ=({p,b})=>[0,2].every(i=>Math.min(p.max[i],b.max[i])>=Math.max(p.min[i],b.min[i]));
   const vertical=({p,b})=>target==='slab'?b.min[1]-p.max[1]:p.min[1]-b.max[1];
   const stats=ps=>({pairs:ps.length,overlapXZ:ps.filter(overlapsXZ).length,minVerticalGap:Math.min(...ps.map(vertical)),boundIntersections:ps.filter(({p,b})=>separation(p,b)===0).length});
   r[target]={all:stats(pairs),pipes:stats(pairs.filter(({p})=>p.method==='cyl')),clips:stats(pairs.filter(({p})=>p.method==='box'))};
   if(r[target].all.minVerticalGap<=0||r[target].all.boundIntersections!==0)throw Error(target+' overlap at '+name);
 }
 result[name]=r;
}
fs.writeFileSync(path.join(out,'trial-result.json'),JSON.stringify(result,null,2)+'\\n');console.log(JSON.stringify(result));process.exit(0);
`;
const marker='const decals=JSON.parse(';
if(!original.includes(marker))throw Error('No instrumentation anchor');
const dest=path.join(directory,'trial.mjs');fs.writeFileSync(dest,original.replace(marker,trial+'\n'+marker));
const child=spawnSync(process.execPath,[dest,fixture,directory],{stdio:'inherit'});process.exit(child.status??1);
