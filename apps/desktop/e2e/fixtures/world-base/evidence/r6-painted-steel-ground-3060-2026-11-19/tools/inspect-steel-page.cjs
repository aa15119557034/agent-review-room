'use strict';

module.exports = async function inspectSteel(view) {
  const THREE = await import('three');
  const w = window.worldBase, r = w.renderer, camera = w.camera;
  const portal = w.city.laundryPortal;
  if (portal?.name !== 'Portal_wings') throw Error('Laundry portal could not be identified');
  window.__surfaceGate.freeze();
  const button = document.querySelector('button[data-view="'+view+'"]');
  if (button.closest('details')) button.closest('details').open = true;
  button.click();
  document.body.classList.add('hide-ui');
  w.station.update(0,14,w.walker.worldPosition);
  w.island.update(0,14);
  w.island.U.uTime.value = 14;
  const materials = new Map(), cityMeshes = [];
  w.city.root.traverseVisible(o => {
    if (!o.isMesh) return;
    cityMeshes.push(o);
    for (const m of [].concat(o.material)) {
      if (m.name.startsWith('apartment-pbr-') || ['art-r1-chainlink','art-r1-fence-steel','art-r1-shade-net'].includes(m.name)) materials.set(m.name,m);
    }
  });
  const metal = materials.get('apartment-pbr-metal');
  const roof = materials.get('apartment-pbr-roof');
  if (!metal || !roof || !portal.visible || !metal.visible) throw Error('Unexpected visibility or missing metal');
  const gl = r.getContext();
  const gpu = gl.getParameter(gl.getExtension('WEBGL_debug_renderer_info').UNMASKED_RENDERER_WEBGL);
  function render() {
    w.look.pipeline.hasPrev = false;
    w.look.render(w.scene,0);
    r.info.reset();
    w.look.render(w.scene,0);
    return r.domElement.toDataURL('image/png').split(',')[1];
  }
  const shots = {authored:render()};
  const renderCounts = {calls:r.info.render.calls,triangles:r.info.render.triangles};
  if (view==='sample-e-harbour') {
    const city=w.city.root;
    if(!city.visible) throw Error('City was already hidden');
    try {city.visible=false;shots.cityHidden=render();}finally{city.visible=true;}
    shots.restored=render();
    return {gpu,view,eye:camera.position.toArray(),quaternion:camera.quaternion.toArray(),size:[gl.drawingBufferWidth,gl.drawingBufferHeight],time:w.island.U.uTime.value,renderCounts,shots,glError:gl.getError()};
  }
  const record = m => ({type:m.type,color:m.color.getHexString(),roughness:m.roughness,metalness:m.metalness,
    normalScale:m.normalScale?.toArray(),ao:m.aoMapIntensity,normal:m.normalMap?.name||null,
    diffuse:m.map?.name||null,hasDiffuse:!!m.map,rough:m.roughnessMap?.name||null,metalnessMap:m.metalnessMap?.name||null,
    aoMap:m.aoMap?.name||null,alphaTest:m.alphaTest,opacity:m.opacity,markedPainted:m.userData.paintedSteel===true});
  const materialEvidence = Object.fromEntries([...materials].map(([key,m])=>[key,record(m)]));
  const ray = new THREE.Raycaster(), wpx=gl.drawingBufferWidth, hpx=gl.drawingBufferHeight;
  ray.near=camera.near;ray.far=80;
  const pts = view==='art-d-laundry'
    ? [[600,130],[628,130],[656,130],[684,130],[712,130],[740,130],[769,130],[798,130],[1047,130],[1079,130],[1112,130],[1145,130],[1177,130],[1211,130],[1244,130],[1279,130],[1313,130],
       [600,150],[627,150],[655,150],[683,150],[712,150],[740,150],[769,150],[799,150],[1049,150],[1081,150],[1114,150],[1147,150],[1180,150],[1213,150],[1247,150],[1282,150],[1317,150],
       [254,578],[1208,587]]
    : [[990,149],[990,213],[990,271],[990,322],[990,368],[990,409],[990,448],[990,482],[990,516],[990,547],[990,574],[990,600],[990,625],[990,645],[1234,300],[1234,430],[1234,633],[1158,377],[1166,510]];
  const parentPath = o => {
    const names=[];for(let obj=o;obj;obj=obj.parent)names.unshift(obj.name||obj.type);
    return names.join('/');
  };
  const rays = pts.map(([x,y]) => {
    ray.setFromCamera(new THREE.Vector2((x+.5)/wpx*2-1,1-(y+.5)/hpx*2),camera);
    const hits = ray.intersectObjects(cityMeshes,false).slice(0,3).map(hit => {
      const mesh=hit.object, m=Array.isArray(mesh.material)?mesh.material[hit.face.materialIndex]:mesh.material;
      return {object:parentPath(mesh),material:m.name,materialType:m.type,portal:!!(portal===mesh||portal.getObjectById(mesh.id)),distance:Math.round(hit.distance*1e4)/1e4,vertexColors:m.vertexColors,alphaTest:m.alphaTest,transparent:m.transparent};
    });
    return {x,y,hits};
  });
  try {
    if (view==='art-d-laundry') {
      portal.visible=false;
      shots.portalHidden=render();
      portal.visible=true;
    }
    metal.visible=false;
    shots.apartmentMetalHidden=render();
    metal.visible=true;
    shots.restored=render();
  } finally {portal.visible=true;metal.visible=true;}
  return {gpu,view,eye:camera.position.toArray(),quaternion:camera.quaternion.toArray(),
    time:w.island.U.uTime.value,size:[wpx,hpx],materialEvidence,rays,renderCounts,shots,glError:gl.getError(),
    portal:parentPath(portal),portalMeshes:cityMeshes.filter(mesh=>portal.getObjectById(mesh.id)).map(mesh=>mesh.name)};
};
