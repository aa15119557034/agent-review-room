'use strict';
module.exports = async function shoot(name) {
  const T = await import('/upstream/petalwake/vendor/three/build/three.module.js');
  const w = window.worldBase, {camera, station, island, renderer, scene, doorGlow: glow, shopSpill: spill} = w;
  if (!glow || !spill || island.timeOfDay !== 'evening') throw Error('Expected both evening light effects');
  const start = document.querySelector('#go');
  if (start && !start.disabled) start.click();
  if (!window.__surfaceGate.frozen) window.__surfaceGate.freeze();
  w.walker.setEnabled(false);
  w.setFlightEffects(false);
  document.body.classList.add('hide-ui');
  const parent = w.city.root, world = v => parent.localToWorld(new T.Vector3(...v));
  parent.updateWorldMatrix(true,true);
  const originalViews = {'shop-b':'art-b-konbini','laundry-d':'art-d-laundry'};
  const isDoor = name === 'probe-84';
  const meshes = isDoor ? glow.group.children : [spill.mesh];
  const toggle = isDoor ? glow : spill;
  const fronts = spill.fronts;
  const pickKind = name.startsWith('shop-b') ? 'konbini' : name==='laundry-d' ? 'laundry' : null;
  const warm = fronts.find(f=>!['konbini','laundry'].includes(f.kind)&&(f.d1-f.d0)>.8) ?? fronts.find(f=>!['konbini','laundry'].includes(f.kind));
  const chosen = pickKind ? fronts.find(f=>f.kind===pickKind) : warm;
  if(!chosen) throw Error('Missing shop front for '+name);
  const shop = fronts.map((f,i)=>({...f,index:i})).filter(f=>f.name===chosen.name&&f.kind===chosen.kind);
  const n = new T.Vector3(...chosen.normal).normalize(), t = new T.Vector3(-n.z,0,n.x);
  const center = world(chosen.center).addScaledVector(t,-(chosen.x0+chosen.width/2-chosen.totalW/2));
  let view;
  if (originalViews[name]) {
    const key = originalViews[name];
    view = {...w.views.find(v=>v.name===key),name};
    document.querySelector('button[data-view='+key+']').click();
  } else if (isDoor) {
    view={name,position:[340.85510607536884,10.05,845.2591139946599],target:[339.2551060753688,9.350000000000001,839.7391139946599],fov:49};
  } else {
    const edge = name==='shop-b-edge';
    const p = center.clone().addScaledVector(t, edge ? chosen.totalW/2 - .45 : .95).addScaledVector(n, edge ? 3.8 : 5.9);
    p.y=world([0,chosen.floor,0]).y+(edge?2.15:1.9);
    const aim=center.clone().addScaledVector(t,edge?chosen.totalW/2-.45:0).addScaledVector(n,edge?.7:.42);
    aim.y=world([0,chosen.floor,0]).y+(edge?.36:.9);
    view={name,position:p.toArray(),target:aim.toArray(),fov:edge?50:56};
  }
  if (!originalViews[name]) {
    camera.position.fromArray(view.position);
    camera.lookAt(...view.target);
    camera.fov=view.fov;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
  }
  station.update(0,14,w.walker.worldPosition);
  island.update(0,14);
  island.U.uTime.value=14;
  const gl=renderer.getContext(),ext=gl.getExtension('WEBGL_debug_renderer_info');
  const frames=[],drawStats={};
  for (const [label,on] of [['off',false],['on',true],['repeat-on',true]]) {
    const submissions=Object.fromEntries(meshes.map(m=>[m.name,0]));
    const originals=meshes.map(m=>m.onAfterRender);
    meshes.forEach((m,i)=>{m.onAfterRender=function(...args){submissions[m.name]++;return originals[i].apply(this,args);};});
    try {
      toggle.setEnabled(on);
      w.look.pipeline.hasPrev=false;
      renderer.info.reset();
      w.look.render(scene,0);
      drawStats[label]={visible:isDoor?glow.group.visible:spill.mesh.visible,submissions,render:{...renderer.info.render}};
      frames.push(renderer.domElement.toDataURL('image/png').split(',')[1]);
    } finally { meshes.forEach((m,i)=>{m.onAfterRender=originals[i];}); }
  }
  const sceneMeshes=[];
  scene.traverseVisible(o=>{
    if(!o.isMesh||o.userData.wbDoorGlow||!o.geometry?.attributes?.position)return;
    if(!(Array.isArray(o.material)?o.material:[o.material]).some(m=>m?.visible&&m.depthWrite&&!m.transparent))return;
    sceneMeshes.push(o);
  });
  const ray=new T.Raycaster();
  const hitFloor=(point)=>{
    ray.set(point.clone().add(new T.Vector3(0,.4,0)),new T.Vector3(0,-1,0));
    ray.near=.0001;ray.far=2.5;
    const hit=ray.intersectObjects(sceneMeshes,false).find(h=>{
      const m=Array.isArray(h.object.material)?h.object.material[h.face?.materialIndex??0]:h.object.material;
      return m?.visible&&m.depthWrite&&!m.transparent;
    });
    if(!hit)return {point:point.toArray(),hit:null};
    const obj=hit.object, path=[];
    for(let p=obj;p;p=p.parent) if(p.name)path.unshift(p.name);
    const matrix=obj.matrixWorld.clone();
    if(hit.instanceId!=null){const m=new T.Matrix4();obj.getMatrixAt(hit.instanceId,m);matrix.multiply(m);}
    const normal=hit.face?.normal.clone().applyNormalMatrix(new T.Matrix3().getNormalMatrix(matrix)).toArray();
    return {point:point.toArray(),hit:{point:hit.point.toArray(),normal,distance:hit.distance,heightDelta:point.y-hit.point.y,path}};
  };
  const smooth=(a,b,x)=>{const t=Math.min(1,Math.max(0,(x-a)/(b-a)));return t*t*(3-2*t);};
  const groups=meshes.map(m=>({name:m.name,count:m.count,depthTest:m.material.depthTest,depthWrite:m.material.depthWrite,
    castShadow:m.castShadow,receiveShadow:m.receiveShadow,strength:m.material.uniforms.uStrength.value}));
  const special={drawStats,groups,groupCount:groups.length,reportedDrawCalls:toggle.drawCalls,params:toggle.params,
    otherVisible:isDoor?spill.mesh.visible:glow.group.visible};
  if(isDoor){
    const lamp=glow.lamps[84], floor=glow.group.children.find(m=>m.name==='door-glow-floor');
    if(lamp.lamp[0]!==59.25510607536883||!lamp.slabSide||!lamp.tangent)throw Error('Unexpected R9 lamp #84');
    const attr=floor.geometry.attributes, edge=[attr.aEdge.getX(84),attr.aEdge.getY(84)],size=[attr.aSize.getX(84),attr.aSize.getY(84)];
    const m=new T.Matrix4();floor.getMatrixAt(84,m);m.premultiply(floor.matrixWorld);
    const inv=m.clone().invert(), shader=floor.material.fragmentShader;
    if(!shader.includes('smoothstep( 0.0, 0.15, xm - vEdge.x )')||!shader.includes('k *= edge;'))throw Error('Unrecognized R9c edge shader');
    special.door={lamp,instanceIndex:84,edge,size,matrix:m.toArray(),shader,
      samples:[0,.15,.23,.4,-.4].map(side=>{
        const p=world([lamp.lamp[0],lamp.floor+.012,lamp.lamp[2]])
          .addScaledVector(new T.Vector3(...lamp.tangent),side).addScaledVector(new T.Vector3(...lamp.normal),.4);
        const local=p.clone().applyMatrix4(inv), xm=local.x*size[0], v=local.y+.5;
        const edgeWeight=smooth(0,.15,xm-edge[0])*smooth(0,.15,edge[1]-xm);
        const u=floor.material.uniforms;
        const radial=Math.hypot(xm/u.uRad.value.x,((v*size[1])-u.uFloorOut.value)/u.uRad.value.y);
        const weight=Math.pow(1-smooth(0,1,radial),u.uPow.value)*(1-smooth(u.uFade.value.x,u.uFade.value.y,v))*edgeWeight;
        const ndc=p.clone().project(camera);
        return {side,outward:.4,xm,uv:[local.x+.5,v],edgeWeight,weight,pixel:[(ndc.x+1)*720,(1-ndc.y)*450],floor:hitFloor(p)};
      })};
  }else{
    const attrib=spill.mesh.geometry.attributes, attrs=(k,i)=>{const x=attrib[k];return Array.from(x.array.slice(i*x.itemSize,(i+1)*x.itemSize));};
    const indices=[0,Math.floor(shop.length/2),shop.length-1];
    const picked=[...new Set(indices)].map(i=>shop[i]);
    special.shop={buildMs:spill.buildMs,totalInstances:spill.count,registry:Array.from(new Set(fronts.map(f=>f.name))),
      selected:{name:chosen.name,kind:chosen.kind,width:chosen.totalW,center:center.toArray(),normal:n.toArray(),tangent:t.toArray()},
      segments:shop.map(f=>({...f,attributes:Object.fromEntries(['aSize','aRange','aSpan','aColor'].map(k=>[k,attrs(k,f.index)]))})),
      support:picked.flatMap(f=>[.2,.5,.8].map(frac=>{
        const p=world([f.center[0],f.floor+.012,f.center[2]]).addScaledVector(n,f.d0+frac*(f.d1-f.d0));
        const ndc=p.clone().project(camera);return {index:f.index,fraction:frac,pixel:[(ndc.x+1)*720,(1-ndc.y)*450],floor:hitFloor(p)};
      }))};
  }
  return {frames,view,current:name,special,eye:camera.position.toArray(),quaternion:camera.quaternion.toArray(),fov:camera.fov,
    time:station.ctx.time,islandTime:island.U.uTime.value,timeOfDay:island.timeOfDay,
    hidden:['#panel','#help','#loading'].every(sel=>getComputedStyle(document.querySelector(sel)).display==='none'),
    canvas:[gl.drawingBufferWidth,gl.drawingBufferHeight],gpu:ext&&gl.getParameter(ext.UNMASKED_RENDERER_WEBGL),glError:gl.getError(),errors:w.errors.slice()};
};
