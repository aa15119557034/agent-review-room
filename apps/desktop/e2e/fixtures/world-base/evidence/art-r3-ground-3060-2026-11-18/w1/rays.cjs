function auditW1(T,root,ctx) {
  const boxes=root.getObjectByName('w1-zones-boxes'), bottles=root.getObjectByName('w1-zones-bottles');
  if(!boxes||!bottles) throw Error('R3 stock instances missing');
  const lotFrame=boxes.parent, inv=lotFrame.matrixWorld.clone().invert();
  const region=new T.Box3(new T.Vector3(-3.25,-1,-4.36), new T.Vector3(2.89,1.02,-3.52));
  const items=[], surfaces=[], meshPaths=new Set(), positions=new T.Vector3(), matrix=new T.Matrix4(), combined=new T.Matrix4(), bounds=new T.Box3();
  const vertices=[new T.Vector3(),new T.Vector3(),new T.Vector3()];
  function nodePath(o){const parents=[];for(let p=o;p;p=p.parent)if(p.name)parents.unshift(p.name);return parents.join('/');}
  root.traverseVisible(o=>{
    if(!o.isMesh||!o.geometry?.attributes.position)return;
    const g=o.geometry, pos=g.attributes.position,idx=g.index;
    if(!g.boundingBox)g.computeBoundingBox();
    const base=inv.clone().multiply(o.matrixWorld), materials=[].concat(o.material);
    const path=nodePath(o), stock=o===boxes||o===bottles;
    for(let inst=0;inst<(o.isInstancedMesh?o.count:1);inst++){
      if(o.isInstancedMesh){o.getMatrixAt(inst,matrix);combined.multiplyMatrices(base,matrix);}
      else combined.copy(base);
      bounds.copy(g.boundingBox).applyMatrix4(combined);
      if(!region.intersectsBox(bounds))continue;
      const key=o.uuid+':'+inst;
      if(stock) {
        const centre=new T.Vector3(0,0,0).applyMatrix4(combined);
        items.push({key,kind:o===boxes?'box':'bottle',index:inst,center:centre.toArray(),matrix:combined.clone(),bounds:[bounds.min.toArray(),bounds.max.toArray()]});
      }
      for(let j=0;j<(idx?.count??pos.count);j+=3) {
        for(let k=0;k<3;k++) vertices[k].fromBufferAttribute(pos,idx?idx.getX(j+k):j+k).applyMatrix4(combined);
        const [a,b,c]=vertices;
        const minX=Math.min(a.x,b.x,c.x),maxX=Math.max(a.x,b.x,c.x),minZ=Math.min(a.z,b.z,c.z),maxZ=Math.max(a.z,b.z,c.z);
        if(minX>region.max.x||maxX<region.min.x||minZ>region.max.z||maxZ<region.min.z)continue;
        const bx=b.x-a.x,bz=b.z-a.z,cx=c.x-a.x,cz=c.z-a.z,det=bz*cx-bx*cz;
        if(det<=1e-10)continue;
        const group=Array.isArray(o.material)?g.groups.find(n=>n.start<=j&&j<n.start+n.count):null;
        const mat=materials[group?.materialIndex??0];
        if(mat.visible===false)continue;
        surfaces.push({minX,maxX,minZ,maxZ, ax:a.x,az:a.z,ay:a.y,bx,bz,cx,cz,by:b.y-a.y,cy:c.y-a.y,det,id:key,
          label:[path,mat.name||mat.type].join(' / '),kind:stock?'stock':'scene'});meshPaths.add(path);
      }
    }
  });
  const rows=[];
  for(const item of items){
    const [x,y,z]=item.center;
    const possible=surfaces.filter(t=>t.id!==item.key&&t.maxX>item.bounds[0][0]-.001&&t.minX<item.bounds[1][0]+.001&&t.maxZ>item.bounds[0][2]-.001&&t.minZ<item.bounds[1][2]+.001);
    function probe(dx,dz) {
      positions.set(dx,0,dz).applyMatrix4(item.matrix);
      let highest=-Infinity,owner=null;
      for(const t of possible) {
        if(positions.x<t.minX-.000001||positions.x>t.maxX+.000001||positions.z<t.minZ-.000001||positions.z>t.maxZ+.000001)continue;
        const a=positions.x-t.ax,b=positions.z-t.az,u=(b*t.cx-a*t.cz)/t.det,v=(a*t.bz-b*t.bx)/t.det;
        if(u<-.000001||v<-.000001||u+v>1.000001)continue;
        const h=t.ay+u*t.by+v*t.cy;
        if(h>highest&&h<=positions.y+.001){highest=h;owner=t;}
      }
      return {gap:y-highest,surface:owner?.label,kind:owner?.kind};
    }
    const centre=probe(0,0),samples=[];let contacts=0;
    for(let a=0;a<31;a++)for(let b=0;b<31;b++){
      const dx=(a+.5)/31-.5,dz=(b+.5)/31-.5;
      // Exact convex octagon bottom of Three CylinderGeometry(8), with vertices at cardinal and 45° axes.
      if(item.kind==='bottle'&&(Math.max(Math.abs(dx),Math.abs(dz))+(Math.SQRT2-1)*Math.min(Math.abs(dx),Math.abs(dz))>.5))continue;
      const q=probe(dx,dz);if(q.gap<=.002)contacts++;samples.push(q.gap);
    }
    rows.push({kind:item.kind,index:item.index,center:item.center,base:item.bounds,zone:x< -1.4?'SNACK':x<1.1?'BAKERY':'DRINK',tier:Math.round((y-.42)/.13)+1,
      centerGap:centre.gap,centerHit:centre.surface,sampled: samples.length,contactCount:contacts,contactFraction:contacts/samples.length,minGap:Math.min(...samples),maxGap:Math.max(...samples)});
  }
  const solids=ctx.physics.items.filter(o=>o.type==='box' && Math.abs(o.hw-.4)<1e-5&&Math.abs(o.hd-.22)<1e-5).map(o=>({ix:o.cx,iz:o.cz,hw:o.hw,hd:o.hd,angle:o.rotY,y0:o.y0,y1:o.y1}));
  const summary=[];
  for(const zone of ['SNACK','BAKERY','DRINK'])for(const tier of [1,2,3]) {
    const r=rows.filter(i=>i.zone===zone&&i.tier===tier);
    summary.push({zone,tier,n:r.length,fullyUnsupported:r.filter(i=>!i.contactCount).length,centerUnsupported:r.filter(i=>i.centerGap>.002).length,
      centreGap:r.length?[Math.min(...r.map(i=>i.centerGap)),Math.max(...r.map(i=>i.centerGap))]:null,footprintFraction:r.length?[Math.min(...r.map(i=>i.contactFraction)),Math.max(...r.map(i=>i.contactFraction))]:null});
  }
  return {summary,solids,rows,meshPaths:[...meshPaths],triangles:surfaces.length,frame:lotFrame.matrixWorld.toArray()};
}
