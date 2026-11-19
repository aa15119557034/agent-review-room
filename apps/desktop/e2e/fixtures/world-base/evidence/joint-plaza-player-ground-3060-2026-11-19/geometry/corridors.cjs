const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const fixture=path.resolve(process.argv[2]),out=path.resolve(process.argv[3]||'.'),sha='21154f79fc8c1fb1bc27735b203a9fa0b6db3b1a';
const old='evidence/art-r3-ground-3060-2026-11-18/corridors-and-boards/';
const helper=fs.readFileSync(path.join(fixture,old,'geometry.mjs'),'utf8');
const prefix=helper.split('const decals=JSON.parse(')[0].replace("base='dce243c'","base='47a5c12'").replace('47a5c12eba910682ccbf8bc9138510bc01737bf3',sha);
if(!prefix.includes("const doc={sha")||!prefix.includes(sha))throw Error('R3 source adapter not found');
async function measure(){
 const fDoor=apt.match(/function recessedDoor\(H, F, o\) \{[\s\S]*?\n\}/)[0],makeDoor=new Function(fDoor+';return recessedDoor')();
 const rearHole=new Function('y',matches(apt,/const opening = \{ x: 0, y: y \+ \.16, w: 1\.03, h: 2\.08 \};/)[0]+'return opening;')(0);
 for(const site of sites.filter(s=>s.floors!==4)){
  const {name,w,depth}=site,origin=model.placements.find(s=>s.name===name).worldOrigin,rear=gb=>Frame.at(gb,...origin).sub(0,0,-depth,Math.PI);
  const H={M,A:{...A,rects:{...A.rects,door_steel:[0,0,1,1]}},apartmentSurfaces:{materials:{metal:M.metal}}};
  const group=objects.filter(o=>o.group===name),pipes=group.filter(o=>o.method==='cyl'||o.method==='box');
  const door=[];
  for(let bay=0;bay<3;bay++){
   const start=objects.length;makeDoor(H,frameRecorder(name+'-door',gb=>rear(gb).sub((bay-1)*w/3,0,0)),rearHole);
   door.push(...objects.slice(start));
  }
  const room={door,lamps:group.filter(o=>o.method==='lamp'),boxes:group.filter(o=>o.method==='boxB'),notice:group.filter(o=>o.method==='raw'),slab:group.filter(o=>o.method==='slab')};
  const outB=doc.buildings[name];outB.actualClearances={};
  for(const [key,obstacles] of Object.entries(room)){
    const pairs=pipes.flatMap(p=>obstacles.map(b=>({p,b})));
    function summary(rows){if(!rows.length)throw Error('No rows '+key);
      const gaps=rows.map(({p,b})=>key==='slab'?b.min[1]-p.max[1]:p.min[1]-b.max[1]);
      if(Math.min(...gaps)<=0)throw Error('No vertical clearance '+name+' '+key);
      return {pairs:rows.length,minY:Math.min(...gaps),overlapXZ:rows.filter(({p,b})=>[0,2].every(i=>p.max[i]>=b.min[i]&&b.max[i]>=p.min[i])).length};
    }
    outB.actualClearances[key]={pipes:summary(pairs.filter(({p})=>p.method==='cyl')),clips:summary(pairs.filter(({p})=>p.method==='box'))};
  }
 }
 const c=Object.fromEntries(objects.filter(o=>o.group==='town-apartment-4f'&&['lamp','cyl','box'].includes(o.method)).map(o=>[o.id,{method:o.method,bins:parts[o.id]}]));
 const oldC=JSON.parse(read('evidence/art-r3-ground-3060-2026-11-18/corridors-and-boards/C-bins.json'));
 doc.fourFloorComparedToR3={groups:Object.keys(c).length,sameIndicesAndVertexCoordinates:JSON.stringify(c)===JSON.stringify(oldC)};
 if(!doc.fourFloorComparedToR3.sameIndicesAndVertexCoordinates)throw Error('4F geometry differs');
 const r3path='apps/desktop/e2e/fixtures/world-base/src/art-r1-city.js';
 const oldModule=execFileSync('git',['show','47a5c12:'+r3path],{cwd:fixture,encoding:'utf8'});
 const previous=await import('data:text/javascript;base64,'+Buffer.from(oldModule).toString('base64'));
 const outlines={};
 for(const {name,w,depth,floors} of sites.filter(s=>s.floors!==4)){
   const origin=model.placements.find(s=>s.name===name).worldOrigin;
   const actual=gb=>Frame.at(gb,...origin).sub(0,0,-depth,Math.PI);
   previous.addRearCorridor(frameRecorder('R3-'+name,actual),M,A,sheet,{unit:w/3,w,floorY:floorOffset,rng:mulberry32('art-r3-rear-'+floors)});
   for(const [key,group] of [['R3-'+floors,'R3-'+name],['R3b-'+floors,name]]){
     outlines[key]=objects.filter(o=>o.group===group&&['box','cyl'].includes(o.method)).map(o=>({bins:parts[o.id]}));
   }
 }
 fs.writeFileSync(path.join(out,'background-bins.json'),JSON.stringify(outlines));
 fs.writeFileSync(path.join(out,'corridors.json'),JSON.stringify(doc,null,2)+'\n');
 console.log(JSON.stringify({source:sha,actual:sites.filter(s=>s.floors!==4).map(s=>[s.name,doc.buildings[s.name].actualClearances]),fourFloor:doc.fourFloorComparedToR3}));
}
const r=cp.spawnSync(process.execPath,['--input-type=module','-',fixture,out],{cwd:fixture,input:prefix+'\nawait ('+measure.toString()+')();',encoding:'utf8'});process.stdout.write(r.stdout);process.stderr.write(r.stderr);process.exit(r.status??1);
