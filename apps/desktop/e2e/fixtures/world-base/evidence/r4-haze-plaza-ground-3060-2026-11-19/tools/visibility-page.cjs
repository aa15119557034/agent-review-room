'use strict';
module.exports=async function visibilityFrame(){
  const T=await import('three'),w=window.worldBase,r=w.renderer,cam=w.camera;
  window.__surfaceGate.freeze();
  const original=r.renderBufferDirect,ref=new Map(),passes=new Map();
  r.renderBufferDirect=function(camera,scene,geom,material,obj,group){
    const before=r.info.render.triangles, calls=r.info.render.calls;
    const ret=original.apply(this,arguments),tri=r.info.render.triangles-before,draws=r.info.render.calls-calls;
    const kind=camera===cam&&scene===w.scene?'main color':material?.isMeshDepthMaterial||material?.isMeshDistanceMaterial?'shadow':
      camera===cam?'other player-camera passes':'other cameras or fullscreen';
    const total=passes.get(kind)||{draws:0,triangles:0};total.draws+=draws;total.triangles+=tri;passes.set(kind,total);
    if(kind==='main color'&&tri>0){
      const previous=ref.get(obj)||{triangles:0,draws:0};previous.triangles+=tri;previous.draws+=draws;ref.set(obj,previous);
    }return ret;
  };
  try {w.look.render(w.scene,1/60);} finally{r.renderBufferDirect=original;}
  const matrix=new T.Matrix4().multiplyMatrices(cam.projectionMatrix,cam.matrixWorldInverse);
  const frustum=new T.Frustum().setFromProjectionMatrix(matrix,r.coordinateSystem,r.capabilities.reversedDepthBuffer===true);
  const inst=new T.Matrix4(),world=new T.Matrix4(),sphere=new T.Sphere(),box=new T.Box3();
  function scale(m){const e=m.elements,abs=Math.abs,one=Math.max(abs(e[0])+abs(e[1])+abs(e[2]),abs(e[4])+abs(e[5])+abs(e[6]),abs(e[8])+abs(e[9])+abs(e[10]));
    const inf=Math.max(abs(e[0])+abs(e[4])+abs(e[8]),abs(e[1])+abs(e[5])+abs(e[9]),abs(e[2])+abs(e[6])+abs(e[10]));return Math.sqrt(one*inf);}
  const rows=[];let totalInstances=0,outInstances=0,estimatedTris=0;
  for(const [obj,counts] of ref){
    let a=obj,route=[];while(a&&a!==w.scene){if(a.name)route.unshift(a.name);a=a.parent;}
    const geom=obj.geometry,material=Array.isArray(obj.material)?obj.material.map(m=>m.type).join('/'):obj.material.type;
    const row={label:route.slice(-4).join('/')||obj.type,type:obj.type,geometryType:geom.type,material,frustumCulled:obj.frustumCulled,...counts};
    if(obj.isInstancedMesh&&obj.count>0&&geom.attributes.position){
      if(!geom.boundingSphere)geom.computeBoundingSphere();const local=geom.boundingSphere,perCell=new Map();
      let off=0;const cellSize=64;
      for(let i=0;i<obj.count;i++){
        obj.getMatrixAt(i,inst);world.multiplyMatrices(obj.matrixWorld,inst);
        sphere.center.copy(local.center).applyMatrix4(world);sphere.radius=local.radius*scale(world)+3;
        if(!frustum.intersectsSphere(sphere))off++;
        const key=Math.floor(sphere.center.x/cellSize)+','+Math.floor(sphere.center.z/cellSize);
        const cell=perCell.get(key)||{n:0,box:new T.Box3()};cell.n++;
        const min=sphere.center;const rad=sphere.radius;cell.box.min.x=Math.min(cell.box.min.x,min.x-rad);cell.box.min.y=Math.min(cell.box.min.y,min.y-rad);cell.box.min.z=Math.min(cell.box.min.z,min.z-rad);
        cell.box.max.x=Math.max(cell.box.max.x,min.x+rad);cell.box.max.y=Math.max(cell.box.max.y,min.y+rad);cell.box.max.z=Math.max(cell.box.max.z,min.z+rad);perCell.set(key,cell);
      }
      let visibleCells=0,absent=0;for(const c of perCell.values()){if(frustum.intersectsBox(c.box))visibleCells++;else absent+=c.n;}
      row.instances=obj.count;row.outsideExpandedSphere=off;row.potentialInstanceTriangles=counts.triangles*off/obj.count;
      row.cells64m=perCell.size;row.visibleCells64m=visibleCells;row.offscreenInstances64m=absent;
      row.potentialCellTriangles=counts.triangles*absent/obj.count;
      totalInstances+=obj.count;outInstances+=off;estimatedTris+=row.potentialInstanceTriangles;
    }else if(geom.isInstancedBufferGeometry){row.shaderInstances=Number.isFinite(geom.instanceCount)?geom.instanceCount:null;row.instanceAttributes=Object.keys(geom.attributes).filter(k=>geom.attributes[k].isInstancedBufferAttribute);}
    rows.push(row);
  }
  rows.sort((a,b)=>b.triangles-a.triangles);
  if(!passes.get('main color')?.triangles)throw Error('Missing actual main-camera draws');
  return {camera:{eye:cam.position.toArray(),quaternion:cam.quaternion.toArray(),fov:cam.fov,walker:w.walker.view},passes:Object.fromEntries(passes),
    mainMeshes:rows.length,instancedMeshes:rows.filter(v=>v.instances).length,totalInstances,outsideExpandedSphere:outInstances,
    estimatedInstanceTriangles:Math.round(estimatedTris),cell64m:{estimatedTriangles:Math.round(rows.reduce((s,v)=>s+(v.potentialCellTriangles||0),0)),currentDraws:rows.filter(v=>v.instances).reduce((s,v)=>s+v.draws,0),
      hypotheticalDraws:rows.filter(v=>v.instances).reduce((s,v)=>s+v.draws*v.visibleCells64m,0)},rows};
};
