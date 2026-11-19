'use strict';
module.exports = async function shoot(name) {
  const T = await import('/upstream/petalwake/vendor/three/build/three.module.js');
  const w = window.worldBase, { camera, station, island, renderer, scene, doorGlow: glow } = w;
  if (!glow || island.timeOfDay !== 'evening') throw Error('Evening door glow is absent');
  const start = document.querySelector('#go');
  if (start && !start.disabled) start.click();
  if (!window.__surfaceGate.frozen) window.__surfaceGate.freeze();
  w.walker.setEnabled(false);
  w.setFlightEffects(false);
  document.body.classList.add('hide-ui');
  const parent = w.city.root;
  parent.updateWorldMatrix(true, true);
  const toWorld = (v) => parent.localToWorld(new T.Vector3(...v));
  const transformNormal = (v) => new T.Vector3(...v).transformDirection(parent.matrixWorld);
  const entries = station.ctx.services.doorLamps ?? [];
  const rawHouses = entries.filter(e => !e.object && e.floor != null);
  const key = (v) => v.map(x => Math.round(x * 50)).join(',');
  const houseKeys = new Set(rawHouses.map(e => key(e.lamp)));
  const far = glow.lamps.map((l, index) => ({...l,index}))
    .filter(l => houseKeys.has(key(l.lamp)) && l.lamp[2] >= -75 && l.lamp[2] <= -70)
    .sort((a,b) => a.lamp[0] - b.lamp[0] || a.lamp[2] - b.lamp[2]);
  if (far.length < 3) throw Error('Expected at least three far residential lamps, got ' + far.length);
  const selected = [.15,.5,.85].map(fract => far[Math.round(fract * (far.length - 1))]);
  const refs = {'far-west': selected[0], 'far-middle': selected[1], 'far-east': selected[2]};
  let view;
  const lockedView = {'corridor-c':'art-c-alley', 'street-a':'art-a-street', 'shop-b':'art-b-konbini', 'rail-g':'sample-g-rail'}[name];
  if (lockedView) {
    const target = w.views.find(v => v.name === lockedView);
    document.querySelector('button[data-view='+lockedView+']').click();

    view = {...target,name};
  } else {
    const ref = refs[name];
    const lamp = toWorld(ref.lamp), n = transformNormal(ref.normal);
    const tangent = new T.Vector3(n.z, 0, -n.x);
    const floor = toWorld([ref.lamp[0],ref.floor,ref.lamp[2]]).y;
    const position = lamp.clone().addScaledVector(n, 3.85).addScaledVector(tangent, .95);
    position.y = floor + 1.85;
    const target = lamp.clone().addScaledVector(n,.28);
    target.y = floor + 1.04;
    view = {name,position:position.toArray(),target:target.toArray(),fov:55};
    camera.position.copy(position);
    camera.lookAt(target);
    camera.fov = view.fov;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
  }
  station.update(0,14,w.walker.worldPosition);
  island.update(0,14);
  island.U.uTime.value = 14;
  const gl = renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
  const meshes = glow.group.children;
  const groups = meshes.map(mesh => ({
    name:mesh.name,count:mesh.count,depthTest:mesh.material.depthTest,depthWrite:mesh.material.depthWrite,
    castShadow:mesh.castShadow,receiveShadow:mesh.receiveShadow,uniformStrength:mesh.material.uniforms.uStrength.value,
  }));
  const frame = [];
  const stats = {};
  for (const [label,on] of [['off',false],['on',true],['repeat-on',true]]) {
    const submissions = Object.fromEntries(meshes.map(m=>[m.name,0]));
    const originals = meshes.map(m=>m.onAfterRender);
    meshes.forEach((m,i)=>{m.onAfterRender=function(...args){submissions[m.name]++;return originals[i].apply(this,args);};});
    try {
      glow.setEnabled(on);
      w.look.pipeline.hasPrev = false;
      renderer.info.reset();
      w.look.render(scene,0);
      stats[label] = {visible:glow.group.visible,submissions,render:{...renderer.info.render}};
      frame.push(renderer.domElement.toDataURL('image/png').split(',')[1]);
    } finally {
      meshes.forEach((m,i)=>{m.onAfterRender=originals[i];});
    }
  }
  const special = {
    groupCount:meshes.length,reportedDrawCalls:glow.drawCalls,count:glow.count,params:glow.params,groups,
    selectedLamp:refs[name] ?? null,drawStats:stats,
  };
  if (name === 'far-west') {
    const meshList = [];
    scene.updateMatrixWorld(true);
    scene.traverseVisible(o=>{
      if (!o.isMesh || o.userData.wbDoorGlow || !o.geometry?.attributes?.position) return;
      if (!(Array.isArray(o.material)?o.material:[o.material]).some(m=>m?.visible && m.depthWrite && !m.transparent)) return;
      meshList.push(o);
    });
    const ray = new T.Raycaster();
    const normalMatrix = new T.Matrix3();
    const instanceMatrix = new T.Matrix4();
    const shootRay = (point, direction, startDistance, farDistance) => {
      const from = point.clone().addScaledVector(direction,-startDistance);
      ray.set(from,direction);
      ray.near = .0001;
      ray.far = farDistance;
      const hit = ray.intersectObjects(meshList,false).find(h=>{
        const mat = Array.isArray(h.object.material)?h.object.material[h.face?.materialIndex ?? 0]:h.object.material;
        return mat?.visible && mat.depthWrite && !mat.transparent;
      });
      if (!hit) return {from:from.toArray(),intended:point.toArray(),hit:null};
      const matrix = hit.object.matrixWorld.clone();
      if (hit.instanceId != null) {
        hit.object.getMatrixAt(hit.instanceId,instanceMatrix);
        matrix.multiply(instanceMatrix);
      }
      const n = hit.face?.normal.clone().applyNormalMatrix(normalMatrix.getNormalMatrix(matrix)).toArray();
      const path = [];
      for (let o=hit.object;o;o=o.parent) if(o.name) path.unshift(o.name);
      return {from:from.toArray(),intended:point.toArray(),hit:{point:hit.point.toArray(),normal:n,distance:hit.distance,
        error:hit.distance-startDistance,object:hit.object.name,type:hit.object.type,path,instanceId:hit.instanceId ?? null}};
    };
    const support = selected.map(l => {
      const pos = toWorld(l.lamp), n = transformNormal(l.normal), tangent = new T.Vector3(n.z,0,-n.x);
      const floor = toWorld([l.lamp[0],l.floor,l.lamp[2]]).y;
      const sampleOffsets = [0,-.4,.4,-.65,.65];
      return {lamp:l,world:pos.toArray(),floor,samples:sampleOffsets.map(side => {
        const wall = pos.clone().addScaledVector(tangent,side); wall.y -= glow.params.wallDrop;
        const ground = pos.clone().addScaledVector(tangent,side).addScaledVector(n,glow.params.floorOut); ground.y = floor;
        return {side,wall:shootRay(wall,n.clone().negate(),.65,1.3),floor:shootRay(ground,new T.Vector3(0,-1,0),.35,2.5)};
      })};
    });
    special.registry = {
      beforeDedup:{apartment:w.city.placements.filter(p=>p.type==='apartment').reduce((s,p)=>s+(p.model.lamps?.length ?? 0),0),
        houses:rawHouses.length,shops:entries.filter(e=>e.object&&e.floor!=null).length,station:entries.filter(e=>e.object&&e.floor==null).length},
      rawTotal:entries.length,resolvedTotal:glow.count,wallOnly:glow.lamps.filter(l=>l.floor==null).length,
      farHouseCount:far.length,meshCandidates:meshList.length,farHouseLamps:far,support,
    };
  }
  return {
    frames:frame, view, current:name, special,
    eye:camera.position.toArray(), quaternion:camera.quaternion.toArray(), fov:camera.fov,
    time:station.ctx.time,islandTime:island.U.uTime.value,timeOfDay:island.timeOfDay,
    hidden:['#panel','#help','#loading'].every(sel=>getComputedStyle(document.querySelector(sel)).display==='none'),
    canvas:[gl.drawingBufferWidth,gl.drawingBufferHeight],gpu:ext && gl.getParameter(ext.UNMASKED_RENDERER_WEBGL),
    glError:gl.getError(),errors:w.errors.slice(),
  };
};
