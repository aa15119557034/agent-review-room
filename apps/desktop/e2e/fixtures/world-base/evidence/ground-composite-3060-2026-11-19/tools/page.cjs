'use strict';
module.exports = function installCompositeProbe() {
  const w = window.worldBase, p = w.look.pipeline, r = w.renderer, gl = r.getContext();
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  if (!ext || !info || !/RTX 3060 Laptop/.test(gl.getParameter(info.UNMASKED_RENDERER_WEBGL))) throw Error('Expected 3060 with timer queries');
  if (p.overlay.children.length !== 1 || p.overlay.children[0] !== p.blurQuad) throw Error('Foreground layer contains geometry');
  const rgbaHash = async bits => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bits)), x => x.toString(16).padStart(2, '0')).join('');
  function setMode(single) {
    if (r.getRenderTarget()) throw Error('Expected completed composite');
    const expected = single ? 0 : 4;
    if (p.compRT.samples === expected && p.compRT.depthBuffer === !single) return;
    p.compRT.dispose();
    p.compRT.samples = expected;
    p.compRT.depthBuffer = !single;
  }
  function attachment(target) {
    const save = r.getRenderTarget(); r.setRenderTarget(target);
    const state = { samples: gl.getParameter(gl.SAMPLES), depth: gl.getParameter(gl.DEPTH_BITS), width: target.width, height: target.height };
    r.setRenderTarget(save); return state;
  }
  function select(name) {
    const button = document.querySelector('button[data-view="' + name + '"]');
    if (!button) throw Error(name); if (button.closest('details')) button.closest('details').open = true;
    button.click(); document.body.classList.add('hide-ui');
    if (w.currentView !== name) throw Error('view mismatch ' + w.currentView);
  }
  const snap = async (name, single, motion) => {
    window.__surfaceGate.freeze();
    select(name);
    w.station.update(0, 14, w.walker.worldPosition); w.island.update(0,14); w.island.U.uTime.value=14;
    setMode(single); w.setFlightEffects(!!motion); p.hasPrev=false;
    w.look.render(w.scene,1/60); w.look.render(w.scene,1/60);
    if(motion){ w.camera.position.x += 0.30; w.camera.updateMatrixWorld(); }
    w.look.render(w.scene,1/60);
    const png=r.domElement.toDataURL('image/png').split(',')[1];
    const color = new Uint16Array(p.compRT.width*p.compRT.height*4);
    r.readRenderTargetPixels(p.compRT,0,0,p.compRT.width,p.compRT.height,color);
    const colorSHA=await rgbaHash(color);
    let masked=0;for(let i=3;i<color.length;i+=4)if(color[i]!==0x3c00)masked++;
    const saved={png,colorSHA,masked,scene:attachment(p.sceneRT),comp:attachment(p.compRT),overlayCount:p.overlay.children.length,
      blur:p.blurMat.uniforms.uStrength.value,eye:w.camera.position.toArray(),quat:w.camera.quaternion.toArray(),fov:w.camera.fov,
      fingerprint:w.weatheringDecals.plan?.fingerprint,time:w.island.U.uTime.value,glError:gl.getError()};
    return saved;
  };
  let active=null, mark=null, number=0, previousStamp=0;
  const queued=[], originalLook=w.look.render, originalRender=r.render, originalStation=w.station.update;
  const drain=()=>{
    if(!queued.length)return;
    if(gl.getParameter(ext.GPU_DISJOINT_EXT)){
      for(const a of queued){a.record.disjoint++;gl.deleteQuery(a.query);} queued.length=0;return;
    }
    while(queued.length && gl.getQueryParameter(queued[0].query,gl.QUERY_RESULT_AVAILABLE)){
      const {query,kind,record}=queued.shift();
      record[kind].push(gl.getQueryParameter(query,gl.QUERY_RESULT)/1e6);
      gl.deleteQuery(query);
    }
  };
  const measure=(kind,fn)=>{
    if(mark!==kind||!active||queued.length>=8)return fn();
    const record=active, query=gl.createQuery(); gl.beginQuery(ext.TIME_ELAPSED_EXT,query);
    try {return fn();} finally {gl.endQuery(ext.TIME_ELAPSED_EXT);queued.push({query,kind,record});}
  };
  w.station.update=function(...args){
    if(active){const stamp=args[1]*1000;if(previousStamp)active.raf.push(stamp-previousStamp);previousStamp=stamp;}
    return originalStation.apply(this,args);
  };
  w.look.render=function(...args){
    if(!active)return originalLook.apply(this,args);
    number++;if(number%8===0)drain();
    mark=active.instrumented?['frame',null,'copy',null][number%4]:null;
    try{return measure('frame',()=>originalLook.apply(this,args));}finally{mark=null;}
  };
  r.render=function(scene,...args){
    if(scene===p.overlay && active){active.overlays++;return measure('copy',()=>originalRender.call(this,scene,...args));}
    return originalRender.call(this,scene,...args);
  };
  let last=null;
  window.__compProbe = {snap,setMode,select,ready(){
    select('art-a-street');w.setFlightEffects(false);p.hasPrev=false;window.__surfaceGate.resume();
  },start(instrumented){if(active)throw Error('already active');drain();previousStamp=0;number=0;
    active={raf:[],copy:[],frame:[],disjoint:0,overlays:0,instrumented};last=active;
  },stop(){active=null;mark=null;previousStamp=0;},async take(){
    for(let i=0;i<60&&queued.length;i++){drain();if(queued.length)await new Promise(resolve=>setTimeout(resolve,15));}
    if(queued.length)throw Error('unreturned timer queries');
    return last;
  },restore(){active=null;setMode(false);w.look.render=originalLook;r.render=originalRender;w.station.update=originalStation;},
  };
  return {gpu:gl.getParameter(info.UNMASKED_RENDERER_WEBGL),target:p.compRT.samples,scene:p.sceneRT.samples,overlay:p.overlay.children.length};
};
