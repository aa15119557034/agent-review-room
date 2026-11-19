'use strict';
module.exports=async function installCellsProbe(){
  const T=await import('three'),w=worldBase,r=w.renderer,pl=w.look.pipeline,gl=r.getContext(),props=w.island.props,group=props.group;
  const clusters=group.children.filter(o=>o.isInstancedMesh),byMaterial=new Map();
  for(const obj of clusters){if(!obj.frustumCulled||!obj.boundingSphere)throw Error('Spatial batch missing a bound');
    if(!byMaterial.has(obj.material))byMaterial.set(obj.material,[]);byMaterial.get(obj.material).push(obj);}
  const placements=await (await fetch('/assets/terrain/props.json')).json(),classes=Object.keys(placements);
  if(byMaterial.size!==classes.length)throw Error('Geometry classes changed');
  const originals=[],labels=new Map(),names=new Map(),metadata={};
  let groupIndex=0;
  for(const [material,meshes] of byMaterial){
    const kind=classes[groupIndex++],byPosition=new Map();
    for(const [i,o] of meshes.entries()){labels.set(o,kind+'-'+i);names.set(o,kind);
      for(let j=0;j<o.count;j++){const m=new T.Matrix4();o.getMatrixAt(j,m);const key=m.elements[12]+'/'+m.elements[14];
        if(!byPosition.has(key))byPosition.set(key,[]);byPosition.get(key).push(m);}}
    const matrices=[];for(const [x,,z] of placements[kind]){const list=byPosition.get(Math.fround(x)+'/'+Math.fround(z));if(list?.length)matrices.push(list.shift());}
    if(matrices.length!==props.counts[kind]||[...byPosition.values()].some(a=>a.length))throw Error('Incorrect original order for '+kind);
    const o=new T.InstancedMesh(meshes[0].geometry,material,matrices.length);matrices.forEach((m,i)=>o.setMatrixAt(i,m));
    o.instanceMatrix.needsUpdate=true;o.frustumCulled=false;o.renderOrder=300;o.visible=false;group.add(o);originals.push(o);labels.set(o,kind+'-whole');names.set(o,kind);
    metadata[kind]={instances:o.count,cells:meshes.length,sharedGeometry:meshes.every(m=>m.geometry===o.geometry),sharedMaterial:meshes.every(m=>m.material===o.material),castsShadow:o.castShadow};
  }
  const set=cells=>{for(const mesh of originals)mesh.visible=!cells;for(const mesh of clusters)mesh.visible=cells;};
  const actualDraw=r.renderBufferDirect;let measured=null;
  r.renderBufferDirect=function(camera,scene,geom,mat,obj,range){
    const t=r.info.render.triangles,c=r.info.render.calls,v=actualDraw.apply(this,arguments);
    if(measured&&scene===w.scene&&labels.has(obj)){
      const key=camera===w.camera?'main':'mirror',info=measured[key],delta=r.info.render.triangles-t;
      info.calls+=r.info.render.calls-c;info.triangles+=delta;info.batches.push(labels.get(obj));
      const n=names.get(obj);info.byClass[n]=(info.byClass[n]||0)+delta;
    }return v;
  };
  const counts=()=>({main:{calls:0,triangles:0,batches:[],byClass:{}},mirror:{calls:0,triangles:0,batches:[],byClass:{}}});
  const digest=async b=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',b)),v=>v.toString(16).padStart(2,'0')).join('');
  const rgba=target=>{const q=new Uint16Array(target.width*target.height*4);r.readRenderTargetPixels(target,0,0,target.width,target.height,q);return q;};
  function delta(a,b){if(!a)return null;let pixels=0,alpha=0,maxAbs=0;
    for(let i=0;i<b.length;i+=4){let any=false;for(let c=0;c<4;c++)if(a[i+c]!==b[i+c]){any=true;if(c===3)alpha++;maxAbs=Math.max(maxAbs,Math.abs(T.DataUtils.fromHalfFloat(a[i+c])-T.DataUtils.fromHalfFloat(b[i+c])));}if(any)pixels++;}return {pixels,alpha,maxAbs};}
  function select(key){const btn=document.querySelector('button[data-view="'+key+'"]');if(!btn)throw Error(key);if(btn.closest('details'))btn.closest('details').open=true;btn.click();document.body.classList.add('hide-ui');}
  function update(){w.station.update(0,14,w.walker.worldPosition);w.island.update(0,14);w.island.U.uTime.value=14;pl.hasPrev=false;}
  async function view(key,yaw=0){
    window.__surfaceGate.freeze();select(key);w.setFlightEffects(false);set(true);update();w.look.render(w.scene,0);
    if(yaw){w.camera.quaternion.premultiply(new T.Quaternion().setFromAxisAngle(new T.Vector3(0,1,0),yaw*Math.PI/180));w.camera.updateMatrixWorld();update();}
    const trials={},pngs={};let reference=null;
    for(const arm of (yaw?['cells','original','restoreCells']:['original','cells','restoreOriginal'])){
      const enabled=arm==='cells'||arm==='restoreCells';set(enabled);pl.hasPrev=false;measured=counts();w.look.render(w.scene,0);const counter=measured;measured=null;
      const png=r.domElement.toDataURL('image/png').split(',')[1],hdr=rgba(pl.sceneRT);trials[arm]={worldHDR:await digest(hdr),delta:delta(reference,hdr),main:counter.main};
      if(!reference)reference=hdr;pngs[arm]=png;
    }
    set(true);if(gl.getError())throw Error('GL during ground view');return {key,yaw,time:w.island.U.uTime.value,eye:w.camera.position.toArray(),q:w.camera.quaternion.toArray(),fov:w.camera.fov,trials,pngs};
  }
  async function lake(){
    if(!w.island.inland)throw Error('Expected integrated inland water');const mirror=w.island.inland.reflection;
    const select=document.querySelector('#water-view');select.value='tarn';select.dispatchEvent(new Event('change'));
    const weather=document.querySelector('#weather-start');weather.value='48';weather.dispatchEvent(new Event('change'));
    const update=mirror.update,renderTarget=r.setRenderTarget;let args=null,rt=null;
    mirror.update=function(...a){if(a[3])args=a;return update.apply(this,a);};
    r.setRenderTarget=function(t,...rest){if(t?.texture===mirror.map.value)rt=t;return renderTarget.call(this,t,...rest);};
    const gate=window.__surfaceGate;gate.resume();
    try{for(let i=0;i<90&&(!args||!rt);i++)await new Promise(ok=>requestAnimationFrame(ok));gate.freeze();
      if(!args||!rt||rt.width!==640||rt.height!==400)throw Error('Missing actual lake reflection');
      const [renderer,scene,eye,body,omit,lastTime]=args;const mesh=w.island.inland.group.getObjectByName('tarn-water');
      const trials={},pngs={};let ref=null;const frameClock=w.island.U.uTime.value;
      for(const [i,arm] of ['original','cells','restoreOriginal'].entries()){
        set(arm==='cells');const oldCaptures=mirror.captures;measured=counts();update(renderer,scene,eye,body,omit,lastTime+2+i*2);
        if(mirror.captures!==oldCaptures+1||mesh.material.uniforms.uMirrorMap.value!==rt.texture||mesh.material.uniforms.uMirrorOn.value!==1)throw Error('Mirror did not render');
        pl.hasPrev=false;w.look.render(w.scene,0);const counter=measured;measured=null;
        pngs[arm]=r.domElement.toDataURL('image/png').split(',')[1];const bits=rgba(rt);let nonempty=0;
        for(let j=3;j<bits.length;j+=4)if(bits[j]!==0)nonempty++;if(!nonempty)throw Error('Mirror contains no geometry');
        trials[arm]={mirrorHDR:await digest(bits),delta:delta(ref,bits),draws:counter,nonempty,frameClock:w.island.U.uTime.value,actualCaptures:mirror.captures};if(!ref)ref=bits;
      }
      if(gl.getError()||Object.values(trials).some(t=>t.frameClock!==frameClock))throw Error('Unstable reflection');
      return {eye:eye.position.toArray(),q:eye.quaternion.toArray(),lake:[body.x,body.z],size:[rt.width,rt.height],trials,pngs};
    }finally{gate.freeze();mirror.update=update;r.setRenderTarget=renderTarget;set(true);measured=null;}
  }
  window.__propCells={view,lake,dispose(){set(true);r.renderBufferDirect=actualDraw;for(const o of originals){o.removeFromParent();o.dispose();}}};
  const inf=gl.getExtension('WEBGL_debug_renderer_info');
  return {classes:metadata,renderer:gl.getParameter(inf.UNMASKED_RENDERER_WEBGL),collisionCells:props.grid.size,collisionRecords:[...props.grid.values()].reduce((n,list)=>n+list.length,0)};
};
