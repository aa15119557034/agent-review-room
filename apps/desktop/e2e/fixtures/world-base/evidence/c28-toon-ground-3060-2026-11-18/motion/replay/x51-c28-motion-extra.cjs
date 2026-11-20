module.exports=async function extra(cameras){
  const THREE=await import('three'), w=window.worldBase,p=w.look.pipeline,r=w.renderer,cam=w.camera,gl=r.getContext();
  const width=p.sceneRT.width,height=p.sceneRT.height, lin=p.finalMat.uniforms.uLn.value, strength=lin.y;
  const set=(id,next)=>{const ui=document.getElementById(id);if(ui.checked!==next)ui.click();};
  set('effects',false);set('toon',true);
  function pose(spec,yaw=0) {
    cam.fov=spec.fov;cam.updateProjectionMatrix();cam.position.fromArray(spec.position);cam.quaternion.fromArray(spec.quaternion);
    cam.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),THREE.MathUtils.degToRad(yaw)));cam.updateMatrixWorld();
    w.station.update(0,14,w.walker.worldPosition);w.island.update(0,14);p.hasPrev=false;
  }
  const readFinal=()=>{const out=new Uint8Array(width*height*4);gl.readPixels(0,0,width,height,gl.RGBA,gl.UNSIGNED_BYTE,out);return out;};
  const render=()=>w.look.render(w.scene,1/60);
  const dims={dpr:window.devicePixelRatio,css:[innerWidth,innerHeight],canvas:[r.domElement.width,r.domElement.height],rendererPixelRatio:r.getPixelRatio(),GLantialias:gl.getContextAttributes().antialias,pipelineScale:p.scale,
    scene:[p.sceneRT.width,p.sceneRT.height,p.sceneRT.samples],comp:[p.compRT.width,p.compRT.height,p.compRT.samples],bloom:p.bloom.map(t=>[t.width,t.height]),bloomStrength:p.params.bloom,params:{...p.params},lineDistance:[lin.z,lin.w]};
  const mats=new Map();w.scene.traverse(o=>{for(const m of [].concat(o.material||[])){if(!mats.has(m))mats.set(m,[]);mats.get(m).push(o);}});
  const examples=(set,n)=>[...set].slice(0,n);
  const crowns=[];for(const [m,meshes] of mats){if(!/^sakura:(blob|cards)$/.test(m.name))continue;
    const programs=[...(r.properties.get(m).programs?.values()||[])];crowns.push({name:m.name,meshes:meshes.length,programs:programs.map(q=>{const fs=gl.getAttachedShaders(q.program)?.find(s=>gl.getShaderParameter(s,gl.SHADER_TYPE)===gl.FRAGMENT_SHADER);return {name:q.name,defined:fs&&/^#define TOON_NOLINE\s*$/m.test(gl.getShaderSource(fs))};})});}
  const flowers=w.island.meadow.shells.filter(s=>s.kind!=='grass').flatMap(s=>s.pool.slice(0,1).map(o=>({kind:s.kind,alphaToCoverage:o.material.alphaToCoverage,threshold:o.material.fragmentShader.includes('if (alpha < 0.5) discard;'),writesZero:o.material.fragmentShader.includes('vec4(col, 0.0)')})));
  const toonUi=[];
  for(const active of [true,false,true]){
    pose(cameras['station-street']);set('toon',active);
    const used=new Set(),orig=gl.useProgram;gl.useProgram=function(prog){if(prog)used.add(prog);return orig.call(this,prog);};
    try{render();}finally{gl.useProgram=orig;}
    const values={},post={};let tot=0;for(const prog of used){const loc=gl.getUniformLocation(prog,'uTbK'),ll=gl.getUniformLocation(prog,'uTbRim');
      if(loc!==null&&ll!==null){const k=gl.getUniform(prog,loc),rim=gl.getUniform(prog,ll);values[k+','+rim]=(values[k+','+rim]||0)+1;tot++;}
      const t=gl.getUniformLocation(prog,'uToon'),ln=gl.getUniformLocation(prog,'uLnOn');if(t!==null&&ln!==null){const key=gl.getUniform(prog,t)+','+gl.getUniform(prog,ln);post[key]=(post[key]||0)+1;}
    }
    const sky=[];w.scene.traverse(o=>{if(o.isHemisphereLight)sky.push({color:o.color.getHexString(),linear:o.color.toArray(),ground:o.groundColor.getHexString(),intensity:o.intensity});});
    toonUi.push({checked:document.getElementById('toon').checked,drawnProgramUniformPairs:values,programCount:tot,drawnPostUToonAndULnOn:post,sky});
  }
  const target=new THREE.WebGLRenderTarget(width,height,{type:THREE.UnsignedByteType,format:THREE.RGBAFormat,depthBuffer:false,samples:0});
  const src=new THREE.ShaderMaterial({glslVersion:THREE.GLSL3,depthTest:false,depthWrite:false,blending:THREE.NoBlending,uniforms:{tex:{value:null},mode:{value:0},near:{value:cam.near},far:{value:cam.far},rev:{value:p.reversed?1:0}},
     vertexShader:'void main(){gl_Position=vec4(position.xy,0.,1.);}',
     fragmentShader:'uniform sampler2D tex;uniform int mode;uniform float near,far;uniform int rev;out vec4 cc;void main(){vec4 v=texelFetch(tex,ivec2(gl_FragCoord.xy),0);if(mode==2){float z=near*far/mix(far+(near-far)*v.r,near+(far-near)*v.r,float(rev));cc=vec4(vec3(clamp(z/255.,0.,1.)),1.);return;}uint bits=mode==0?packHalf2x16(v.rg):packHalf2x16(v.ba);cc=vec4(vec4(uvec4(bits,bits>>8u,bits>>16u,bits>>24u)&uvec4(255u))/255.);}'});
  const sc=new THREE.Scene(),geo=new THREE.PlaneGeometry(2,2),mesh=new THREE.Mesh(geo,src);mesh.frustumCulled=false;sc.add(mesh);
  const pc=new THREE.OrthographicCamera(-1,1,1,-1,0,1);
  function readRegion(tex,mode,[x0,y0,x1,y1]){src.uniforms.tex.value=tex;src.uniforms.mode.value=mode;r.setRenderTarget(target);r.render(sc,pc);const out=new Uint8Array((x1-x0)*(y1-y0)*4);r.readRenderTargetPixels(target,x0,height-y1,x1-x0,y1-y0,out);r.setRenderTarget(null);return out;}
  function readHalfRegion(rect){const rg=readRegion(p.sceneRT.texture,0,rect),ba=readRegion(p.sceneRT.texture,1,rect);return [rg,ba];}
  function unpack(a,b){const h=a|(b<<8),sgn=(h>>15)?-1:1,exp=(h>>10)&31,frac=h&1023;return sgn*(exp?Math.pow(2,exp-15)*(1+frac/1024):Math.pow(2,-24)*frac);}
  const glass={},images={};const maskMats=[...mats.keys()].filter(m=>m.isShaderMaterial&&m.transparent&&m.depthWrite===false&&m.blendSrcAlpha===THREE.ZeroFactor&&m.blendDstAlpha===THREE.ZeroFactor&&m.blending===THREE.CustomBlending);
  const glassSheet=document.createElement('canvas');glassSheet.width=780;glassSheet.height=415;const gs=glassSheet.getContext('2d');gs.fillStyle='#141b22';gs.fillRect(0,0,780,415);gs.fillStyle='#ffffff';gs.font='16px sans-serif';
  for(const [i,label] of ['C28 original','Normal colour blend','Glass hidden'].entries())gs.fillText(label,10+260*i,24);
  for(const [view,rect,select] of [['shop-door-eye',[805,395,950,472],maskMats.filter(m=>m.name==='station-street-window')],['van-side',[520,268,590,390],[...mats.keys()].filter(m=>m.isShaderMaterial&&m.transparent&&m.depthWrite===false&&Math.abs((m.uniforms.uOpacity?.value??0)-.46)<.00001&&m.uniforms.uStreaks)]]) {
    const saved=select.map(m=>({m,bl:m.blending,visible:m.visible}));pose(cameras[view]);
    const sample=()=>{render();return readHalfRegion(rect)};
    let a,b,c,repeat;
    try{a=sample();for(const {m} of saved)m.blending=THREE.NormalBlending;b=sample();for(const {m} of saved)m.visible=false;c=sample();}
    finally{for(const {m,bl,visible} of saved){m.visible=visible;m.blending=bl;}}
    repeat=sample();
    const stats={view,rect,materials:select.map(m=>({name:m.name,normal:m.blending===THREE.NormalBlending,custom:m.blending===THREE.CustomBlending,meshes:mats.get(m).length})),pixelCount:(rect[2]-rect[0])*(rect[3]-rect[1]),normalVsFormalRGBChanged:0,normalVsFormalAlphaChanged:0,formalVsNoGlassRGBChanged:0,formalVsRepeatRGBChanged:0,eligibleThroughGlass:0,withGlassVisible:0,normalOrFormalA1:0};
    const same=(u,v,i)=>u[0].subarray(i,i+4).every((q,j)=>q===v[0][i+j])&&u[1][i]===v[1][i]&&u[1][i+1]===v[1][i+1];
    for(let i=0;i<a[0].length;i+=4){const normalDiff=!same(a,b,i),glassDiff=!same(a,c,i),repeatDiff=!same(a,repeat,i);
      stats.normalVsFormalRGBChanged+=normalDiff;stats.formalVsNoGlassRGBChanged+=glassDiff;stats.formalVsRepeatRGBChanged+=repeatDiff;
      stats.normalVsFormalAlphaChanged+=a[1][i+2]!==b[1][i+2]||a[1][i+3]!==b[1][i+3];
      const alpha=unpack(a[1][i+2],a[1][i+3]);if(glassDiff&&!repeatDiff){stats.withGlassVisible++;stats.eligibleThroughGlass+=alpha>=.95;stats.normalOrFormalA1+=alpha===1;}
    }
    glass[view]=stats;
    const ww=rect[2]-rect[0],hh=rect[3]-rect[1],row=view==='van-side'?1:0;
    for(const [j,packet] of [a,b,c].entries()){const slot=document.createElement('canvas');slot.width=ww;slot.height=hh;const cx=slot.getContext('2d'),im=cx.createImageData(ww,hh);for(let y=0;y<hh;y++)for(let x=0;x<ww;x++){const i=4*((hh-1-y)*ww+x),out=4*(y*ww+x);const v=[unpack(packet[0][i],packet[0][i+1]),unpack(packet[0][i+2],packet[0][i+3]),unpack(packet[1][i],packet[1][i+1])];for(let k=0;k<3;k++){const l=Math.max(0,Math.min(1,v[k]));im.data[out+k]=255*(l<=.0031308?l*12.92:1.055*Math.pow(l,1/2.4)-.055);}im.data[out+3]=255;}
      cx.putImageData(im,0,0);const scale=Math.min(245/ww,138/hh);gs.imageSmoothingEnabled=false;gs.drawImage(slot,10+260*j,45+180*row,ww*scale,hh*scale);}
    gs.fillText(view+'   ('+rect[0]+', '+rect[1]+')',10,200+180*row);
  }
  images['glass-hdr-crops.png']=glassSheet.toDataURL('image/png');
  // Identical world clocks; a pure camera rotation provides an analytic reprojection for every depth.
  const refs=cameras['station-street'], region=[505,283,852,452],rows=[];
  set('effects',false);set('toon',true);
  for(const deg of [-.18,-.09,0,.09,.18,0]){
    pose(refs,deg);lin.y=strength;render();const rgbA=readFinal(),depth=readRegion(p.uDepth.value,2,region);
    lin.y=0;render();const rgbB=readFinal();lin.y=strength;
    const amp=new Uint8Array(width*height);
    for(let y=region[1]-8;y<region[3]+8;y++)for(let x=region[0]-8;x<region[2]+8;x++){
      const j=(height-1-y)*width+x,i=j*4;amp[j]=Math.max(Math.abs(rgbA[i]-rgbB[i]),Math.abs(rgbA[i+1]-rgbB[i+1]),Math.abs(rgbA[i+2]-rgbB[i+2]));}
    rows.push({deg,amp,depth,vp:new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix,cam.matrixWorldInverse)});
  }
  const ref=rows[2],inv=ref.vp.clone().invert(),v=new THREE.Vector3();
  const bilinear=(a,x,y)=>{const x0=Math.floor(x),y0=Math.floor(y),tx=x-x0,ty=y-y0;const at=(i,j)=>a[(height-1-j)*width+i];return (at(x0,y0)*(1-tx)+at(x0+1,y0)*tx)*(1-ty)+(at(x0,y0+1)*(1-tx)+at(x0+1,y0+1)*tx)*ty;};
  const distant={rect:region,referenceDepthMetres:[35,150],minimumReferenceStrength:8,poses:rows.map(a=>a.deg),referencePixels:0,samePoseRepeatChanged:0,perPose:rows.map(q=>({yaw:q.deg,deltaSum:0,peakAbsolute:0,changedAbove8:0,belowFour:0})),description:'Per-pose outline-only max |RGB on-minus-no-line|; horizontal yaw homography to reference, bilinear screen resampling.'};
  const dW=region[2]-region[0];
  for(let y=region[1];y<region[3];y++)for(let x=region[0];x<region[2];x++){
    const idx=(height-1-y)*width+x,ii=((region[3]-1-y)*dW+x-region[0])*4,z=ref.depth[ii];
    if(z<35||z>=150||ref.amp[idx]<8)continue;
    distant.referencePixels++;distant.samePoseRepeatChanged+=ref.amp[idx]!==rows[5].amp[idx];
    v.set((x+.5)/width*2-1,1-(y+.5)/height*2,.5).applyMatrix4(inv);
    for(let j=0;j<rows.length;j++){const row=rows[j],q=v.clone().applyMatrix4(row.vp),sx=(q.x+1)*.5*width-.5,sy=(1-q.y)*.5*height-.5;const n=bilinear(row.amp,sx,sy),d=Math.abs(n-ref.amp[idx]),o=distant.perPose[j];o.deltaSum+=d;o.peakAbsolute=Math.max(o.peakAbsolute,d);o.changedAbove8+=d>8;o.belowFour+=n<4;}
  }
  for(const q of distant.perPose){q.meanAbsolute=+(q.deltaSum/Math.max(1,distant.referencePixels)).toFixed(3);q.peakAbsolute=+q.peakAbsolute.toFixed(2);delete q.deltaSum;}
  const err=gl.getError();src.dispose();geo.dispose();target.dispose();if(err!==gl.NO_ERROR)throw Error('Ground controls GL error '+err);
  return {dims,toonUi,crowns,flowers,glass,distant,glassFlagged:maskMats.map(m=>m.name),decals:{stats:w.weatheringDecals.stats,fingerprint:w.weatheringDecals.plan.fingerprint,visible:w.weatheringDecals.mesh.visible},images};
};
