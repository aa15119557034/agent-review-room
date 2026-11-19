'use strict';
module.exports = async function installReplay(referenceURL) {
  const THREE = await import('three');
  const { Pipeline: Reference } = await import(referenceURL);
  const w = window.worldBase, p = w.look.pipeline, r = w.renderer, gl = r.getContext();
  const candidateRender = p.render, originalDraw = r.render;
  const rendererInfo = gl.getExtension('WEBGL_debug_renderer_info');
  const gpu = gl.getParameter(rendererInfo.UNMASKED_RENDERER_WEBGL);
  if (!/RTX 3060 Laptop/.test(gpu)) throw Error(gpu);
  if (p.overlay.children.length !== 1 || p.overlay.children[0] !== p.blurQuad) throw Error('Unexpected sharp layer');
  window.__surfaceGate.freeze();
  const width = p.sceneRT.width, height = p.sceneRT.height;
  const depthRT = new THREE.WebGLRenderTarget(width, height, {depthBuffer:false, type:THREE.UnsignedByteType,
    minFilter:THREE.NearestFilter, magFilter:THREE.NearestFilter});
  const depthMat = new THREE.RawShaderMaterial({glslVersion:THREE.GLSL3, depthTest:false,depthWrite:false,
    uniforms:{tDepth:p.uDepth}, vertexShader:'in vec3 position; void main(){gl_Position=vec4(position.xy,0.0,1.0);}',
    fragmentShader:'precision highp float; precision highp int; uniform highp sampler2D tDepth; out vec4 result; void main(){uint b=floatBitsToUint(texelFetch(tDepth,ivec2(gl_FragCoord.xy),0).r);result=vec4(uvec4(b,b>>8,b>>16,b>>24)&uvec4(255u))/255.0;}'});
  function ensure(value,message) { if (!value) throw Error(message); }
  const hash = async x => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',x)), b=>b.toString(16).padStart(2,'0')).join('');
  function select(name) {
    const button=document.querySelector('button[data-view="'+name+'"]');ensure(button,name);
    if(button.closest('details')) button.closest('details').open=true;
    button.click();document.body.classList.add('hide-ui');ensure(w.currentView===name,'Camera '+name);
  }
  function state(rt) {
    const prev=r.getRenderTarget();r.setRenderTarget(rt);
    const v={samples:gl.getParameter(gl.SAMPLES),depthBits:gl.getParameter(gl.DEPTH_BITS),width:rt.width,height:rt.height};
    r.setRenderTarget(prev);return v;
  }
  function color(rt) {
    const bits=new Uint16Array(rt.width*rt.height*4);r.readRenderTargetPixels(rt,0,0,rt.width,rt.height,bits);return bits;
  }
  function depth() {
    const prev=r.getRenderTarget(),mat=p.quad.material,bytes=new Uint8Array(depthRT.width*depthRT.height*4);
    p._blit(depthMat,depthRT);r.readRenderTargetPixels(depthRT,0,0,depthRT.width,depthRT.height,bytes);
    p.quad.material=mat;r.setRenderTarget(prev);return bytes;
  }
  function difference(a,b) {
    ensure(a.length===b.length,'HDR dimensions');
    const channels=[0,0,0,0],maxAbs=[0,0,0,0];let pixels=0;
    for(let i=0;i<a.length;i+=4){let changed=false;for(let j=0;j<4;j++){
      if(a[i+j]===b[i+j])continue;
      channels[j]++;changed=true;maxAbs[j]=Math.max(maxAbs[j],
        Math.abs(THREE.DataUtils.fromHalfFloat(a[i+j])-THREE.DataUtils.fromHalfFloat(b[i+j])));
    }if(changed)pixels++;}
    return {pixels,channels,maxAbs};
  }
  function oldTarget() {
    if(p.compRT.samples===4&&p.compRT.depthBuffer)return;
    p.compRT.dispose();p.compRT.samples=4;p.compRT.depthBuffer=true;
  }
  function prepare(name,motion) {
    select(name);w.station.update(0,14,w.walker.worldPosition);w.island.update(0,14);w.island.U.uTime.value=14;
    w.setFlightEffects(motion);p.render=candidateRender;p.hasPrev=false;w.look.render(w.scene,1/60);
    const prev=p.prevViewProj.clone();
    if(motion){w.camera.position.x+=0.30;w.camera.updateMatrixWorld();}
    w.look.render(w.scene,1/60);return prev;
  }
  let worldSkips=0;
  function holdWorld() {
    r.render=function(scene,...args){if(scene===w.scene){worldSkips++;return;}return originalDraw.call(this,scene,...args);};
  }
  async function snapshot(name,motion) {
    const prev=prepare(name,motion);
    const trials=[], pngs={};let reference=null;worldSkips=0;holdWorld();
    try {
      for(const arm of ['before','after','restore']){
        if(arm==='after')p.render=candidateRender;else{oldTarget();p.render=Reference.prototype.render;}
        p.prevViewProj.copy(prev);p.hasPrev=true;w.look.render(w.scene,1/60);
        const png=r.domElement.toDataURL('image/png').split(',')[1];
        const hdr=color(p.compRT);const source=color(p.sceneRT);const z=depth();
        const comp=state(p.compRT),scene=state(p.sceneRT);
        ensure(scene.samples===4&&scene.depthBits>0,'World attachments');
        ensure(comp.samples===(arm==='after'?0:4) && (comp.depthBits===0)===(arm==='after'),'Composition attachments');
        ensure(!gl.getError(),'GL readback failed');
        let nonOpaque=0;for(let i=3;i<hdr.length;i+=4)if(hdr[i]!==0x3c00)nonOpaque++;
        let depthHasScene=false;const depths=new Float32Array(z.buffer);for(let i=0;i<depths.length;i+=79)if(depths[i]>0&&depths[i]<1){depthHasScene=true;break;}
        ensure(depthHasScene,'Depth image has no interior scene data');
        const delta=reference?difference(reference,hdr):null;
        reference??=hdr;
        trials.push({arm,colorSHA:await hash(source),depthSHA:await hash(z),hdrSHA:await hash(hdr),delta,nonOpaque,comp,scene,
          blur:p.blurMat.uniforms.uStrength.value,glError:gl.getError()});
        pngs[arm]=png;
      }
    } finally {r.render=originalDraw;p.render=candidateRender;}
    ensure(worldSkips===3,'Expected exactly three world draw calls to be held');
    return {name,motion,clock:w.island.U.uTime.value,lighting:w.island.timeOfDay,position:w.camera.position.toArray(),
      quaternion:w.camera.quaternion.toArray(),fov:w.camera.fov,previousMatrix:prev.toArray(),worldSkips,trials,pngs};
  }
  function fallback(){
    const prev=prepare('art-a-street',false);const z=depth(),depths=new Float32Array(z.buffer);
    let x,y,found=false;
    for(let j=Math.floor(height*.35);j<height*.65&&!found;j+=17)for(let i=Math.floor(width*.35);i<width*.65;i+=17){
      const v=depths[j*width+i];if(v>0 && v<1){x=i;y=j;found=true;break;}}
    ensure(found,'No opaque ground/building in middle of street view');
    const mat=new THREE.ShaderMaterial({toneMapped:false,depthTest:true,depthWrite:true,uniforms:{
      where:{value:new THREE.Vector2((x+.5)*2/width-1,(y+.5)*2/height-1)},markerDepth:{value:0}},
      vertexShader:'uniform vec2 where; void main(){gl_Position=vec4(where+position.xy*0.06,0.0,1.0);}',
      fragmentShader:'uniform float markerDepth; void main(){gl_FragColor=vec4(4.0,0.0,4.0,1.0);gl_FragDepth=markerDepth;}'});
    const marker=new THREE.Mesh(p.blurQuad.geometry,mat);marker.frustumCulled=false;marker.renderOrder=10;
    const spot=()=>{const b=new Uint16Array(4);r.readRenderTargetPixels(p.compRT,x,y,1,1,b);return [...b];};
    const draw=()=>{p.prevViewProj.copy(prev);p.hasPrev=true;w.look.render(w.scene,1/60);return {comp:state(p.compRT),value:spot()};};
    const resize=[];
    try {
      holdWorld();const empty=draw();p.overlay.add(marker);
      mat.uniforms.markerDepth.value=p.reversed?0:1;const behind=draw();
      mat.uniforms.markerDepth.value=p.reversed?1:0;const front=draw();
      marker.removeFromParent();p.blurQuad.add(marker);const nested=draw();
      marker.removeFromParent();const removed=draw();
      const eq=(a,b)=>a.every((v,i)=>v===b[i]);
      ensure(empty.comp.samples===0&&empty.comp.depthBits===0,'initial sole quad');
      ensure(behind.comp.samples===4&&behind.comp.depthBits>0&&eq(empty.value,behind.value),'far marker must be occluded by world');
      ensure(eq(front.value,[0x4400,0,0x4400,0x3c00])&&front.comp.samples===4,'front marker must be visible');
      ensure(eq(nested.value,front.value)&&nested.comp.samples===4&&nested.comp.depthBits>0,'nested marker');
      ensure(removed.comp.samples===0&&removed.comp.depthBits===0&&eq(empty.value,removed.value),'removed marker');
      r.render=originalDraw;
      for(const [rw,rh,withMarker] of [[960,600,false],[960,600,true],[1440,900,true],[1440,900,false]]){
        if(withMarker)p.overlay.add(marker);else marker.removeFromParent();w.look.setSize(rw,rh,1);w.look.render(w.scene,1/60);
        const comp=state(p.compRT),scene=state(p.sceneRT);ensure(scene.samples===4&&scene.depthBits>0&&scene.width===rw&&scene.height===rh,'scene resize');
        ensure(comp.samples===(withMarker?4:0)&&(comp.depthBits>0)===withMarker&&comp.width===rw&&comp.height===rh,'resize composition');
        resize.push({rw,rh,withMarker,comp,scene});
      }
      ensure(!gl.getError(),'foreground readback failed');return {x,y,depth:depths[y*width+x],reversed:p.reversed,empty,behind,front,nested,removed,resize};
    } finally{r.render=originalDraw;marker.removeFromParent();mat.dispose();}
  }
  window.__compositeReplay={snapshot,fallback,restore(){r.render=originalDraw;p.render=candidateRender;depthRT.dispose();depthMat.dispose();}};
  return {gpu,width,height};
};
