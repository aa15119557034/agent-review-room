module.exports=async function compareDecals(old,explicit) {
 const THREE=await import('three'),w=window.worldBase;window.__surfaceGate.freeze();
 const vehicleBoxes=w.weathering.vehicleBoxes;const roots=[w.station.root,w.city.root,w.skyline.root],walls=w.weathering.wallMaterials,up=new THREE.Vector3(0,1,0),targets=[],extra=[],boxes=new Map();
 const path=o=>{const s=[];for(let p=o;p;p=p.parent)if(p.name)s.unshift(p.name);return s.join('/');};
 for(const root of roots){root.updateMatrixWorld(true);root.traverse(m=>{if(!m.isMesh)return;let skipped=m.isInstancedMesh,visible=true;for(let p=m;p;p=p.parent){skipped ||= Boolean(p.userData?.noDecal);visible&&=p.visible!==false;}
   if(!skipped)targets.push(m);else if(visible)extra.push(m);else return;
   if(m.isInstancedMesh){if(!m.boundingBox)m.computeBoundingBox();boxes.set(m,m.boundingBox.clone().applyMatrix4(m.matrixWorld));}
   else{if(!m.geometry.boundingBox)m.geometry.computeBoundingBox();boxes.set(m,m.geometry.boundingBox.clone().applyMatrix4(m.matrixWorld));}
 });}
 const ray=new THREE.Raycaster(),seg=new THREE.Box3(),end=new THREE.Vector3();const round=n=>+n.toFixed(5);
 const nearHit=(origin,n,arr,far=.9)=>{const dir=n.clone().negate();ray.set(origin,dir);ray.far=far;seg.setFromPoints([origin,end.copy(origin).addScaledVector(dir,far)]).expandByScalar(.05);
   const nearby=arr.filter(m=>boxes.get(m).intersectsBox(seg)&&ray.ray.intersectsBox(boxes.get(m)));return ray.intersectObjects(nearby,false)[0];};
 const details=(hit,n,reference)=>{if(!hit?.face)return {pass:false,why:'no hit'};const o=hit.object,mats=[].concat(o.material),m=mats[hit.face.materialIndex??0]??mats[0];
   const norm=hit.face.normal.clone().transformDirection(o.matrixWorld),isWall=walls.has(m),dot=norm.dot(n),err=hit.distance-.7;
   const vehicle=vehicleBoxes.map((box,i)=>box.containsPoint(hit.point)?i:-1).filter(i=>i>=0);return {pass:!vehicle.length&&isWall&&Math.abs(err)<=.012&&dot>=.995,vehicle,why:vehicle.length?'inside excluded vehicle box':!isWall?'nearest material is not a wall':Math.abs(err)>.012?'off original plane':dot<.995?'face normal changed':'pass',
     path:path(o),material:m?.name||m?.type,wall:isWall,distance:round(hit.distance),depthError:round(err),dot:round(dot),instance:hit.instanceId??null,worldHit:hit.point.toArray().map(round)};};
 const rows=[];const stationOrigin=w.station.root.position;
 for(const [index,it] of old.items.entries()){const center=new THREE.Vector3().fromArray(it.pos).add(stationOrigin),n=new THREE.Vector3().fromArray(it.normal).normalize(),right=new THREE.Vector3().crossVectors(up,n).normalize(),samples=[];
   for(const u of [-.5,0,.5])for(const v of [-.5,0,.5]){const origin=center.clone().addScaledVector(n,.7).addScaledVector(right,u*(it.w+.06)).addScaledVector(up,v*(it.h+.06));const hit=nearHit(origin,n,targets),extraHit=nearHit(origin,n,extra);const std=details(hit,n,center);
     const extraCandidate=extraHit&&extraHit.distance<.688&&(!hit||extraHit.distance<hit.distance-.001)?details(extraHit,n,center):null;samples.push({u,v,standard:std,excludedGeometryInFront:extraCandidate});}
   const same=w.weatheringDecals.plan.items.findIndex(a=>JSON.stringify(a)===JSON.stringify(it));
   const curved=explicit.find(e=>e.curved&&e.area===it.area&&e.cell===it.cell);
   function snap(p,dir){const h=nearHit(p.clone().addScaledVector(dir,.5),dir,targets,1.75);if(!h?.face)return {pass:false,reason:'no hit'};const info=details(h,dir,center);return {pass:info.wall&&!info.vehicle.length&&h.distance<1.2,distance:round(h.distance),worldHit:info.worldHit,wall:info.wall,material:info.material,path:info.path,distanceFromOldBakedCenter:round(h.point.distanceTo(center)),normalDotOld:round(h.face.normal.clone().transformDirection(h.object.matrixWorld).dot(n))};}
   const curvedSnap=curved?{atOldCenter:snap(center,n),atSourceDirective:snap(new THREE.Vector3(...curved.pos).add(stationOrigin),new THREE.Vector3(...curved.normal).normalize())}:null;
   rows.push({index,area:it.area,cell:it.cell,kind:it.kind,curvedException:!!curved,curvedSnap,identicalInRuntimeIndex:same,centerPass:samples[4].standard.pass,ninePass:samples.every(r=>r.standard.pass),passed:samples.filter(r=>r.standard.pass).length,extraGeometryInFront:samples.filter(r=>r.excludedGeometryInFront).length,samples});}
 const plan=w.weatheringDecals.plan;return {plan:{version:plan.version,fingerprint:plan.fingerprint,items:plan.items},stats:w.weatheringDecals.stats,oldFingerprint:old.fingerprint,stationOrigin:stationOrigin.toArray(),vehicleBoxes:vehicleBoxes.map(b=>[b.min.toArray(),b.max.toArray()]),targets:targets.length,excludedCandidateMeshes:extra.length,rows,sceneErrors:w.errors};
};
