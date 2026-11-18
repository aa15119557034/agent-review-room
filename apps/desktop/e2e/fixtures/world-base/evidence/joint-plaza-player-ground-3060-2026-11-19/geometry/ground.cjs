module.exports=async function assessLandings(){
 const T=await import('three'),w=window.worldBase,s=w.station,i=w.island,walker=w.walker;
 const {basins}=await import('/src/basins.js'),xyz=v=>v.toArray(),dist=(a,b)=>Math.hypot(...a.map((x,k)=>x-b[k]));
 const stationNames=new Set(['art-a-street','art-b-konbini','art-c-alley','art-d-laundry','sample-g-rail']);
 const namedView=w.views.filter(v=>/^(art-[abcd]-|sample-[efgh]-)/.test(v.name));
 const heights=namedView.map(v=>{
  w.setView(v.name);const actual=xyz(w.camera.position),local=s.toLocal(w.camera.position);
  const islandTerrain=i.heightAt(actual[0],actual[2]),town=i.town.heightAt(actual[0],actual[2]);
  const stationGround=s.toWorld(new T.Vector3(local.x,s.physics.groundHeight(local.x,local.z,local.y),local.z)).y;
  const ground=stationNames.has(v.name)?stationGround:Math.max(islandTerrain,town);
  return {view:v.name,position:actual,reference:v.position,ground,eyeHeight:actual[1]-ground,stationGround,islandTerrain,townGround:Number.isFinite(town)?town:null,groundRule:stationNames.has(v.name)?'station physics highest walkable':'max island terrain and town mesh'};
 });
 const routes=[];
 for(const id of ['art-a-street',...basins.map(b=>b.id)]){
  w.setView(id);
  const eye=xyz(w.camera.position);const v=w.views.find(v=>v.name===id),start=v.feet||xyz(s.spawn);
  w.startWalking();walker.setView('first');
  const from=xyz(walker.worldPosition),eyeBegin=xyz(w.camera.position);
  const physicsFloor=()=>{const l=walker.position;return id==='art-a-street'?s.toWorld(new T.Vector3(l.x,s.physics.groundHeight(l.x,l.z,l.y),l.z)).y:i.heightAt(walker.worldPosition.x,walker.worldPosition.z);};
  const pos=()=>{const feet=xyz(walker.worldPosition),eye=xyz(w.camera.position),floor=physicsFloor();return {feet,eye,residual:feet[1]-floor,eyeHeight:eye[1]-feet[1]};};
  const event=type=>window.dispatchEvent(new KeyboardEvent(type,{key:'w',code:'KeyW',bubbles:true}));const raw=[];event('keydown');
  try{for(let n=0;n<(id==='art-a-street'?90:900);n++){walker.update(1/60);if(n%15===14)raw.push(pos());}}
  finally{event('keyup');}
  const end=pos(),b=basins.find(b=>b.id===id),maxDepth=b?Math.max(...raw.map(node=>b.level-i.heightAt(node.feet[0],node.feet[2]))):null;
  const blocked=b?Math.hypot(...end.feet.map((v,j)=>v-raw.at(-5).feet[j])):null;
  routes.push({id,fixedEye:eye,fixedViewHeight:id==='art-a-street'?heights.find(v=>v.view===id).eyeHeight:eye[1]-i.heightAt(eye[0],eye[2]),start,from,spawnResidual:dist(start,from),eyeBegin,firstPersonEye:eyeBegin[1]-from[1],after:end,travel:dist(from,end.feet),maxAbsFloorResidual:Math.max(...raw.map(s=>Math.abs(s.residual))),maxEyeHeightError:Math.max(...raw.map(s=>Math.abs(s.eyeHeight-1.52))),maxWadingDepth:maxDepth,lastOneSecondDisplacement:blocked,samples:raw});
 }
 const coast=s.root.position, lake=i.inland.group.getObjectByName('tarn-water'),refl=i.inland.reflection;
 return {heights,routes,geometry:{stationOrigin:xyz(coast),stationBounds:s.bounds,stationPhysics:s.physics.items.length,shoreUniformSharesReflectionMap:lake.material.uniforms.uMirrorMap===refl.map,shoreUniformSharesReflectionMatrix:lake.material.uniforms.uMirrorVP===refl.matrix},caveat:'Synchronous CPU stepping through actual walker with test keyboard events; source is the real ground collision/capsule and pose path. GPU/OS input evidence is collected independently.'};
};
