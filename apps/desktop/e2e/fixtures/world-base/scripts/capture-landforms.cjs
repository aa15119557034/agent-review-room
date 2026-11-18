const fs=require('node:fs');

// Called by capture-inland.cjs so both suites use the same native GPU, window and request checks.
module.exports=async function captureLandforms({ev,view,shot,sample,report,poses,wc}){
  const prior=poses?JSON.parse(fs.readFileSync(poses,'utf8')):null;
  await ev(`(()=>{const i=worldBase.island,update=i.update,weather=i.weather.update;
    i.update=dt=>update(dt,32);i.weather.update=()=>weather(0);document.body.classList.add('hide-ui');})()`);
  const views=['larkhaven','cairnwick','fields','alpine','couloir','woodland','meadow','treeline','sea-arch','caldera','gorge','cascade','cape','ravines','dunes','ocean','tarn-blue','ocean-column','lake-column'];
  const fixed={
    ocean:[[269,19,1156],[313,0,1235]],
    'tarn-blue':[[805,172,-743],[735,138,-824]],
    'ocean-column':[[330,20,1450],[330,0,1449.75]],
    'lake-column':[[735,164,-824],[735,138,-824.25]],
  };
  for(const id of views){
    if(prior){
      const q=prior.shots[id];if(!q)continue;
      await view('station-street');
      await ev(`(()=>{const c=worldBase.camera;c.position.fromArray(${JSON.stringify(q.position)});c.quaternion.fromArray(${JSON.stringify(q.rotation)});c.fov=${q.fov};c.updateProjectionMatrix();c.updateMatrixWorld();})()`);
    }else if(fixed[id]){
      await view('station-street');
      await ev(`(()=>{const c=worldBase.camera;c.position.fromArray(${JSON.stringify(fixed[id][0])});c.lookAt(...${JSON.stringify(fixed[id][1])});c.updateMatrixWorld();})()`);
    }else{
      await ev(`(()=>{const menu=document.querySelector('#water-view');menu.value='${id}';menu.dispatchEvent(new Event('change'));if(worldBase.currentView!=='${id}')throw Error('View selector failed');})()`);
    }
    await shot(id);
  }
  if(prior)return;
  await ev("document.querySelector('#open-map').click()");
  await shot('island-map');
  await ev("(()=>{const map=document.querySelector('#island-map');if(!map.open || map.querySelectorAll('[data-place]').length!==12)throw Error('Island chart failed');map.querySelector('[data-place=sea-arch]').click();if(map.open || worldBase.currentView!=='sea-arch')throw Error('Map selection failed');})()");
  report.baseContent=await ev(`(async()=>{const w=worldBase,i=w.island;
    const original=await (await fetch('/assets/terrain/props.json')).json(),index=await (await fetch('/assets/town/index.json')).json();
    const towns=await Promise.all(index.towns.map(async t=>{
      const meta=await (await fetch('/assets/town/'+t.id+'.json')).json();
      const live=i.town.towns.find(k=>k.id===t.id);
      return {id:t.id,name:t.name,originalFeatures:meta.buildings.length,loadedFeatures:i.town.buildings.filter(b=>b.town===t.id).length,
        originalChunks:meta.chunks.length,loadedChunks:live.casters.length,attached:live.group.parent===i.town.group};
    }));
    return {towns,originalProps:Object.fromEntries(Object.entries(original).map(([k,v])=>[k,v.length])),loadedProps:i.props.counts,
      boats:i.town.floaters.length,spinners:i.town.spinners.length,lamps:i.town.lamps.length,stationStages:w.stages,backgroundBuildings:w.city.stats.buildings};
  })()`);
  if(report.baseContent.towns.some(t=>!t.attached||t.loadedChunks!==t.originalChunks||t.loadedFeatures!==t.originalFeatures))throw Error('Original settlement missing');
  report.vegetation=await ev(`(()=>{const i=worldBase.island,trees=i.woodland.trees;
    const bySpecies=i.stats.woodland,variants=new Set(trees.map(t=>t.variant)).size;
    const roots=Math.max(...trees.map(t=>Math.abs(t.y+0.10-i.heightAt(t.x,t.z))));
    const wet=trees.filter(t=>i.streamLevelAt(t.x,t.z)>t.y).length;
    const high=trees.filter(t=>t.y>220),low=trees.filter(t=>t.y<110);
    const pines=a=>a.filter(t=>(t.variant>>1)===2).length/Math.max(1,a.length);
    return {bySpecies,trees:trees.length,variants,rootError:roots,wet,pineFractionHigh:pines(high),pineFractionLow:pines(low)};
  })()`);
  const v=report.vegetation;
  if(v.variants!==8 || v.rootError>0.001 || v.wet || v.pineFractionHigh<=v.pineFractionLow || Math.min(...Object.values(v.bySpecies))<10)throw Error('Woodland placement failed: '+JSON.stringify(v));
  report.forms=await ev(`(()=>{const w=worldBase,i=w.island,h=i.heightAt;
    const rivers=i.branches.map(b=>({length:b.rows.at(-1).s, rise:Math.max(...b.rows.slice(1).map((r,j)=>r.y-b.rows[j].y)),
      wet:b.rows.filter(r=>r.y>h(r.x,r.z)).length,rows:b.rows.length,first:b.rows[0],last:b.rows.at(-1)}));
    const atlas=i.terrain.material.uniforms.uInlandBank.value.image;
    const weights=(x,z)=>{const n=atlas.width,k=4*((n+Math.floor((z+3072)/6144*n))*n+Math.floor((x+3072)/6144*n));return Array.from(atlas.data.slice(k,k+4));};
    const rim=Array.from({length:72},(_,k)=>{const a=k*Math.PI/36;return h(951+145*Math.cos(a),-80+120*Math.sin(a));});
    const b=i.branches[0],f=b.fall,main=i.river.rows,nearest=(rows,r)=>rows.reduce((a,j)=>Math.hypot(j.x-r.x,j.z-r.z)<Math.hypot(a.x-r.x,a.z-r.z)?j:a);
    const end=rivers[1].last,fork=rivers[2].last;
    const joins=[Math.abs(nearest(main,end).y-end.y),Math.abs(nearest(b.rows,fork).y-fork.y)];
    const districts=[[951,-80],[-1740,-523],[1480,267],[-1464,377]].map(([x,z])=>weights(x,z));
    return {rivers,joins,fallHeight:f.height,fallTop:f.top.toArray(),fallBase:f.base.toArray(),pool:i.streamLevelAt(f.base.x,f.base.z),craterFloor:h(951,-80),rimRange:[Math.min(...rim),Math.max(...rim)],districts};
  })()`);
  const f=report.forms;
  if(f.rivers.some(r=>r.rise>0.002 || r.wet!==r.rows) || Math.max(...f.joins)>0.1 || f.fallHeight<12 || !Number.isFinite(f.pool) || Math.abs(f.fallBase[1]-f.pool)>0.3 || f.rimRange[1]-f.craterFloor<80 || f.districts.some((w,k)=>w[k]<128))throw Error('Landform geometry or connected-water check failed: '+JSON.stringify(f));
  for(const id of ['alpine','woodland','meadow','caldera','cascade','dunes']){await view(id);await sample(id);}
  report.walks={};
  for(const id of ['alpine','couloir','woodland','meadow','treeline','caldera','gorge','cascade','cape','ravines','dunes']){
    await view(id);
    const start=await ev("(()=>{document.querySelector('#walk').click();document.querySelector('#world').focus();return worldBase.walker.worldPosition.toArray();})()");
    wc.sendInputEvent({type:'keyDown',keyCode:'W'});
    try{await new Promise(done=>setTimeout(done,780));}finally{wc.sendInputEvent({type:'keyUp',keyCode:'W'});}
    const end=await ev('worldBase.walker.worldPosition.toArray()');
    const distance=Math.hypot(end[0]-start[0],end[2]-start[2]);
    report.walks[id]=distance;
    if(distance<0.6)throw Error('Walking entry obstructed at '+id);
  }
  await view('sea-arch');
  await ev("worldBase.startWalking();worldBase.walker.setView('first');document.querySelector('#world').focus()");
  const start=await ev('worldBase.walker.worldPosition.toArray()');
  wc.sendInputEvent({type:'keyDown',keyCode:'W'});
  try{await new Promise(done=>setTimeout(done,9000));}finally{wc.sendInputEvent({type:'keyUp',keyCode:'W'});}
  const end=await ev('worldBase.walker.worldPosition.toArray()');
  report.archCrossing={start,end,along:(end[0]+1888)*0.620-(end[2]+508)*0.785};
  if(report.archCrossing.along<5)throw Error('Arch opening obstructed: '+JSON.stringify(report.archCrossing));
  report.route=await ev(`(async()=>{const w=worldBase;const station=(await import('./src/station-validation.js')).validateStation(w);
    const coast=(await import('./scripts/validate-environment.js')).validateEnvironment(w);
    return {station:station.ok,coast:coast.ok};})()`);
  if(!report.route.station || !report.route.coast)throw Error('Existing route failed');
};
