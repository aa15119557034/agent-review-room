module.exports=async function probe(){
 const T=await import('three'),w=window.worldBase,s=w.station,i=w.island,extra=w.__probeCoast;
 const names=['art-a-street','art-b-konbini','art-c-alley','art-d-laundry','sample-e-harbour','sample-f-hillside','sample-g-rail','sample-h-north'];
 const ray=new T.Raycaster();ray.layers.enableAll();ray.near=0;ray.far=5.001;
 const getPath=o=>{const names=[];for(let p=o;p;p=p.parent)if(p.name)names.unshift(p.name);return names.join('/');};
 const all=[['station',s.root],['city',w.city.root]];
 const candidates=all.map(([role,root])=>{root.updateWorldMatrix(true,true);const visible=[];root.traverseVisible(o=>{if(o.isMesh&&o.geometry?.attributes?.position&&![].concat(o.material).every(m=>!m.visible||m.colorWrite===false||m.opacity===0))visible.push(o);});return {role,visible};});
 return names.map(name=>{
  w.setView(name);const p=w.camera.position,l=s.toLocal(p),inside=l.x>=s.bounds.x0&&l.x<=s.bounds.x1&&l.z>=s.bounds.z0&&l.z<=s.bounds.z1;
  ray.set(p.clone().add(new T.Vector3(0,.001,0)),new T.Vector3(0,-1,0));
  const intersections={};for(const {role,visible} of candidates){
   const result=[],seen=new Set();for(const hit of ray.intersectObjects(visible,false)){
    const o=hit.object,mat=[].concat(o.material)[hit.face.materialIndex||0],n=hit.face.normal.clone().applyNormalMatrix(new T.Matrix3().getNormalMatrix(o.matrixWorld));
    const id=o.id+'/'+Math.round(hit.point.y*100000);
    if(seen.has(id)||n.y<.45||!mat?.visible||mat.colorWrite===false||mat.opacity===0)continue;seen.add(id);
    result.push({floorY:hit.point.y,height:p.y-hit.point.y,upDot:n.y,meshPath:getPath(o),mesh:o.name,mat:mat.name||mat.type,alphaTest:mat.alphaTest,transparent:mat.transparent,opacity:mat.opacity,depthWrite:mat.depthWrite,instance:hit.instanceId??null});
    if(result.length>=5)break;
   }
   intersections[role]=result;
  }
  const stationFloor=s.physics.groundHeight(l.x,l.z,l.y)+s.root.position.y,coastFloor=extra.physics.groundHeight(l.x,l.z,l.y)+s.root.position.y,islandTerrain=i.heightAt(p.x,p.z),islandTown=i.town.heightAt(p.x,p.z);
  const relevant=[...intersections.station,...intersections.city].sort((a,b)=>b.floorY-a.floorY);
  const meshTop=relevant[0],surfaceY=Math.max(islandTerrain,islandTown,meshTop?.floorY??-Infinity);
  return {name,eye:p.toArray(),stationLocal:l.toArray(),insideAuthoredStationBounds:inside,visibleGeometry:intersections,topGround:{estimatedSurfaceY:surfaceY,height:p.y-surfaceY,source:meshTop&&meshTop.floorY>=surfaceY-1e-7?meshTop.meshPath:islandTown>islandTerrain?'island town heightAt':'terrain heightAt'},terrain:{bilinear:islandTerrain,petalwakeTown:islandTown},capsule:{selectedPhysics:inside?'station':'coast',stationFloorQuery:stationFloor,coastFloorQuery:coastFloor,selectedHeight:p.y-(inside?stationFloor:coastFloor),coastAllowsAtCameraXZ:extra.contains(l.x,l.z,.3)},method:'Downward 5m segment from fixed eye, upward triangle normal y >=0.45, scene-visible material in station/city. Terrain and Petalwake town use their own height queries. CPU geometry cannot evaluate per-fragment shader discard.'};
 });
};
