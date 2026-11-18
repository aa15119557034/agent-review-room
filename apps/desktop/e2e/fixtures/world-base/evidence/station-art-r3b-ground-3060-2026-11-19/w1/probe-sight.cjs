function probeSight(T,root,ref) {
  const origin=ref.uniforms.uStreetOrigin.value.clone(), nodes=[], cards=[];
  root.traverseVisible(o=>{
    if (!o.isMesh || o.name==='crossing-halo') return;
    const materials=[].concat(o.material);
    if (materials.every(m=>!m.visible || m.name==='station-street-window')) return;
    if (o.isInstancedMesh) { if (!o.boundingBox) o.computeBoundingBox(); }
    else if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
    const bounds=(o.isInstancedMesh?o.boundingBox:o.geometry.boundingBox).clone().applyMatrix4(o.matrixWorld);
    nodes.push({o,bounds});
    if (materials.some(m=>/^art-r3-(w1-zone-|board-)/.test(m.name))) cards.push(o);
  });
  const path=o=>{const a=[];for(let t=o;t;t=t.parent)if(t.name)a.unshift(t.name);return a.join('/')};
  const rc=new T.Raycaster();rc.layers.enableAll();
  return cards.map(card=>{
    const b=card.geometry.boundingBox, witnesses=[], corners=[];
    const position=(u,v)=>new T.Vector3(b.min.x+u*(b.max.x-b.min.x),b.min.y+v*(b.max.y-b.min.y),b.max.z).applyMatrix4(card.matrixWorld);
    for(const u of [0,1])for(const v of [0,1])corners.push(position(u,v).toArray());
    for (const u of [.1,.5,.9]) for(const v of [.1,.5,.9]) {
      const target=position(u,v),direction=target.clone().sub(origin),dist=direction.length();
      rc.set(origin,direction.normalize());rc.far=dist+0.005;
      const hits=[];for(const {o,bounds} of nodes)if(rc.ray.intersectsBox(bounds))rc.intersectObject(o,false,hits);
      hits.sort((a,b)=>a.distance-b.distance);
      const before=hits.filter(x=>x.distance<dist-.002 && x.object!==card);
      const material=h=>Array.isArray(h.object.material)?h.object.material[h.face.materialIndex]:h.object.material;
      const opaque=before.find(h=>{const m=material(h);return m.visible&&!m.transparent&&!m.alphaTest&&m.name!=='station-street-window'});
      const possible=before.find(h=>{const m=material(h);return m.visible&&m.name!=='station-street-window'});
      witnesses.push({uv:[u,v],point:target.toArray(),targetHit:hits.some(h=>h.object===card),distance:dist,
        opaque:opaque?{path:path(opaque.object),material:material(opaque).name||material(opaque).type,distance:opaque.distance}:null,
        anyVisibleObstacle:!!possible});
    }
    return {name:card.material.name,corners,witnesses};
  });
}
