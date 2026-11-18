// Imported as a function string into this diagnostic's isolated Electron renderer.
module.exports = async function diagnose(cameraSpec) {
  const THREE=await import('three');
  const w=window.worldBase, p=w.look.pipeline, r=w.renderer, camera=w.camera;
  const width=p.sceneRT.width, height=p.sceneRT.height, clock=14, step=1/60;
  if(width!==1440||height!==900)throw Error('Unexpected framebuffer '+width+'x'+height);
  const gate=window.__surfaceGate;gate.freeze();
  const effects=document.getElementById('effects'),toon=document.getElementById('toon');
  if(effects.checked||!toon.checked||p.params.blur!==0)throw Error('Unexpected initial controls');
  const gl=r.getContext(),gpuExt=gl.getExtension('WEBGL_debug_renderer_info');
  const gpu=gpuExt?gl.getParameter(gpuExt.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER);
  if(!/RTX 3060/i.test(gpu))throw Error('Expected 3060, observed '+gpu);
  w.walker.setEnabled(false);document.body.classList.add('hide-ui');
  function setControl(control,desired){if(control.checked!==desired)control.click();if(control.checked!==desired)throw Error('Checkbox failed');}
  const savedStrength=p.finalMat.uniforms.uLn.value.y;
  const current=new THREE.Quaternion().fromArray(cameraSpec.quaternion);
  const earlier=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),THREE.MathUtils.degToRad(.9)).multiply(current);
  const zones={full:[0,0,width,height],grass:[230,755,355,830],flower:[487,710,520,743],lamp:[1110,409,1142,428],facade:[1000,410,1150,545]};
  const mat=new THREE.ShaderMaterial({glslVersion:THREE.GLSL3,uniforms:{inputImage:{value:null}},depthTest:false,depthWrite:false,blending:THREE.NoBlending,
    vertexShader:'void main(){gl_Position=vec4(position.xy,0.,1.);}',
    fragmentShader:'uniform sampler2D inputImage;out vec4 outputColor;void main(){float a=texelFetch(inputImage,ivec2(gl_FragCoord.xy),0).a;outputColor=vec4(a,step(0.95,a),0.,1.);}'});
  const quad=new THREE.Scene(),geometry=new THREE.PlaneGeometry(2,2),mesh=new THREE.Mesh(geometry,mat);
  mesh.frustumCulled=false;quad.add(mesh);
  const captureCamera=new THREE.OrthographicCamera(-1,1,1,-1,0,1);
  const target=new THREE.WebGLRenderTarget(width,height,{type:THREE.UnsignedByteType,format:THREE.RGBAFormat,depthBuffer:false,samples:0});
  function readMask(source){
    mat.uniforms.inputImage.value=source.texture;r.setRenderTarget(target);r.render(quad,captureCamera);
    const rgba=new Uint8Array(width*height*4),mask=new Uint8Array(width*height);
    r.readRenderTargetPixels(target,0,0,width,height,rgba);r.setRenderTarget(null);
    for(let i=0;i<mask.length;i++)mask[i]=rgba[4*i];
    mask.gate=new Uint8Array(mask.length);for(let i=0;i<mask.length;i++)mask.gate[i]=rgba[4*i+1];
    return mask;
  }
  function pose(q){
    camera.fov=cameraSpec.fov;camera.updateProjectionMatrix();camera.position.fromArray(cameraSpec.position);camera.quaternion.copy(q);camera.updateMatrixWorld();
    w.station.update(0,clock,w.walker.worldPosition);w.island.update(0,clock);
  }
  function capture(name,active,lines){
    setControl(effects,active);
    p.finalMat.uniforms.uLn.value.y=lines?savedStrength:0;p.hasPrev=false;
    pose(earlier);w.look.render(w.scene,step);const prev=p.prevViewProj.toArray();
    pose(current);w.look.render(w.scene,step);
    const rgb=new Uint8Array(width*height*4);gl.readPixels(0,0,width,height,gl.RGBA,gl.UNSIGNED_BYTE,rgb);
    const scene=readMask(p.sceneRT),comp=readMask(p.compRT);
    const glError=gl.getError();if(glError!==gl.NO_ERROR)throw Error(name+' GL error '+glError);
    return {name,rgb,scene,comp,meta:{prev,current:p.viewProj.toArray(),strength:p.blurMat.uniforms.uStrength.value,effectsChecked:effects.checked,blur:p.params.blur,rays:p.params.rays,lines:p.finalMat.uniforms.uLn.value.y,time:w.station.ctx.time}};
  }
  function drawCanvas(data,isMask){
    const c=document.createElement('canvas');c.width=width;c.height=height;
    const ctx=c.getContext('2d');const pixels=ctx.createImageData(width,height);const a=pixels.data;
    for(let y=0;y<height;y++)for(let x=0;x<width;x++){
      const i=(height-1-y)*width+x,j=(y*width+x)*4;
      a[j]=isMask?data[i]:data[4*i];a[j+1]=isMask?data[i]:data[4*i+1];a[j+2]=isMask?data[i]:data[4*i+2];a[j+3]=255;
    }
    ctx.putImageData(pixels,0,0);return c;
  }
  try {
    const off=capture('off',false,true),on=capture('on',true,true),noLine=capture('on-no-line',true,false),repeat=capture('on-repeat',true,true);
    const cases=[off,on,noLine,repeat];for(const c of cases) {
      if(JSON.stringify(c.meta.prev)!==JSON.stringify(off.meta.prev)||JSON.stringify(c.meta.current)!==JSON.stringify(off.meta.current))throw Error('Camera mismatch '+c.name);
    }
    const metrics={};
    for(const [region,[x0,y0,x1,y1]] of Object.entries(zones)){
      const row={offGate95Mismatches:0,gate95Mismatches:0,sceneEligible95:0,compEligible95:0,newlyEligible95:0,newlyIneligible95:0,gate95NewRGBAbove8:0,pixels:0,offSceneVsCompChanged:0,onSceneVsCompChanged:0,offOnSceneChanged:0,onRepeatSceneOrCompChanged:0,onNoLineSceneOrCompChanged:0,newlyEligible:0,zeroTo255:0,repeatRgbChanged:0,stableNewLineChangedAbove1:0,stableNewLineChangedAbove8:0,maxStableNewLineDelta:0};
      for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++){
        const i=(height-1-y)*width+x,j=4*i,a=on.scene[i],b=on.comp[i];row.pixels++;
        row.offSceneVsCompChanged+=off.scene[i]!==off.comp[i];row.onSceneVsCompChanged+=a!==b;row.offOnSceneChanged+=a!==off.scene[i];
        row.onRepeatSceneOrCompChanged+=(a!==repeat.scene[i]||b!==repeat.comp[i]);row.onNoLineSceneOrCompChanged+=(a!==noLine.scene[i]||b!==noLine.comp[i]);
        const stable=on.rgb[j]===repeat.rgb[j]&&on.rgb[j+1]===repeat.rgb[j+1]&&on.rgb[j+2]===repeat.rgb[j+2];
        row.repeatRgbChanged+=!stable;
        const s95=on.scene.gate[i]>0,c95=on.comp.gate[i]>0;
        row.offGate95Mismatches+=off.scene.gate[i]!==off.comp.gate[i];row.gate95Mismatches+=s95!==c95;row.sceneEligible95+=s95;row.compEligible95+=c95;
        row.newlyEligible95+=!s95&&c95;row.newlyIneligible95+=s95&&!c95;
        if(!s95&&c95&&stable){const d=Math.max(...[0,1,2].map(k=>Math.abs(on.rgb[j+k]-noLine.rgb[j+k])));row.gate95NewRGBAbove8+=d>8;}
        if(a>=128||b<128)continue;
        row.newlyEligible++;row.zeroTo255+=a===0&&b===255;
        if(!stable||a!==noLine.scene[i]||b!==noLine.comp[i])continue;
        const d=Math.max(...[0,1,2].map(k=>Math.abs(on.rgb[j+k]-noLine.rgb[j+k])));
        row.stableNewLineChangedAbove1+=d>1;row.stableNewLineChangedAbove8+=d>8;row.maxStableNewLineDelta=Math.max(row.maxStableNewLineDelta,d);
      }
      metrics[region]=row;
    }
    const activeShaders=[];
    for(const info of r.info.programs){
      const shaders=gl.getAttachedShaders(info.program)||[];
      for(const shader of shaders){if(gl.getShaderParameter(shader,gl.SHADER_TYPE)!==gl.FRAGMENT_SHADER)continue;
        const s=gl.getShaderSource(shader);if(!s||!s.includes('wbToonBands')||!/#define RE_IndirectDiffuse\s+RE_IndirectDiffuse_/.test(s))continue;
        activeShaders.push({name:info.name,containsBandUniform:s.includes('uTbK'),containsRimUniform:s.includes('uTbRim')});break;}
    }
    setControl(toon,false);const cancelled={checked:toon.checked,uToon:p.finalMat.uniforms.uToon.value,uLnOn:p.finalMat.uniforms.uLnOn.value,observedCompiledSources:activeShaders.length,examples:activeShaders.slice(0,3),installedBandChunk:THREE.ShaderChunk.lights_fragment_end.includes('wbToonBands')};setControl(toon,true);
    const outputs={};
    const maskScene=drawCanvas(on.scene,true),maskCompOff=drawCanvas(off.comp,true),maskCompOn=drawCanvas(on.comp,true);
    for(const [key,c] of Object.entries({'scene-mask.png':maskScene,'effects-off-mask.png':maskCompOff,'effects-on-mask.png':maskCompOn}))outputs[key]=c.toDataURL('image/png');
    const visual=drawCanvas(on.rgb,false);outputs['ground-jog.jpg']=visual.toDataURL('image/jpeg',.88);
    const sheet=document.createElement('canvas');sheet.width=840;sheet.height=3*135+42;const c=sheet.getContext('2d');c.fillStyle='#151922';c.fillRect(0,0,sheet.width,sheet.height);c.fillStyle='white';c.font='16px sans-serif';
    ['Ground view','Scene alpha','Blur off alpha','Blur on alpha'].forEach((s,i)=>c.fillText(s,12+i*210,25));
    for(const [row,name] of ['grass','flower','lamp'].entries()){
      const [x,y,r,b]=zones[name],ww=r-x,hh=b-y;
      for(const [col,source] of [visual,maskScene,maskCompOff,maskCompOn].entries()){const scale=Math.min(198/ww,100/hh);c.imageSmoothingEnabled=false;c.drawImage(source,x,y,ww,hh,10+col*210,42+row*135,ww*scale,hh*scale);}
      c.fillText(name+'  ('+x+', '+y+')',12,160+row*135);
    }
    outputs['ground-mask-crops.png']=sheet.toDataURL('image/png');
    return {gpu,width,height,camera:cameraSpec,previousWorldYawDegrees:.9,step,clock,maskReadout:'Resolved scene/comp texture alpha -> raw texelFetch -> unblended RGBA8, red byte. Screen origin top-left.',zones,meta:Object.fromEntries(cases.map(v=>[v.name,v.meta])),metrics,cancelled,errors:w.errors,outputs};
  } finally {p.finalMat.uniforms.uLn.value.y=savedStrength;setControl(effects,false);setControl(toon,true);target.dispose();geometry.dispose();mat.dispose();}
};
