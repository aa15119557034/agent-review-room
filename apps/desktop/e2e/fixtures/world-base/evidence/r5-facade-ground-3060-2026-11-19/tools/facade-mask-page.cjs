'use strict';
module.exports = async function facadeMask() {
  const T = await import('three');
  const w = window.worldBase;
  const renderer = w.renderer;
  const gl = renderer.getContext();
  const width = gl.drawingBufferWidth, height = gl.drawingBufferHeight;
  const ids = new Map([['apartment-pbr-plaster',32],['apartment-pbr-tile',96],['apartment-pbr-metal',160],['apartment-pbr-roof',224]]);
  const materials = new Set();
  w.scene.traverse(object => {
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      if (material) materials.add(material);
    }
  });
  const writes = new Map([...materials].map(m => [m,m.colorWrite]));
  const patches = new Map();
  const target = new T.WebGLRenderTarget(width,height,{ minFilter:T.NearestFilter,magFilter:T.NearestFilter,depthBuffer:true,samples:0 });
  const previousTarget = renderer.getRenderTarget(), previousColor = renderer.getClearColor(new T.Color());
  const previousAlpha = renderer.getClearAlpha(), previousAuto = renderer.autoClear;
  const shadows = renderer.shadowMap.autoUpdate, previousBackground = w.scene.background;
  try {
    renderer.setRenderTarget(target);
    renderer.autoClear = false;
    renderer.shadowMap.autoUpdate = false;
    w.scene.background = null;
    renderer.setClearColor(0,0);
    renderer.clear(true,true,true);
    for (const material of materials) material.colorWrite = false;
    renderer.render(w.scene,w.camera);
    for (const material of materials) {
      const id = ids.get(material.name);
      if (!id) continue;
      const compile = material.onBeforeCompile, key = material.customProgramCacheKey;
      patches.set(material,{compile,key});
      material.colorWrite = true;
      material.onBeforeCompile = function(shader, currentRenderer) {
        compile.call(this,shader,currentRenderer);
        let fragment = shader.fragmentShader;
        for (const mark of ['void main() {','#include <lights_fragment_end>','#include <dithering_fragment>'])
          if (!fragment.includes(mark)) throw Error('Facade probe could not find '+mark);
        fragment = fragment.replace('void main() {','void main() {\nfloat wbProbeSun=0.0; float wbProbeAlbedo=0.0;');
        fragment = fragment.replace('#include <lights_fragment_end>',`#include <lights_fragment_end>
          wbProbeAlbedo=dot(diffuseColor.rgb,vec3(0.2126,0.7152,0.0722));
          wbProbeSun=dot(reflectedLight.directDiffuse,vec3(0.2126,0.7152,0.0722))/max(wbProbeAlbedo,0.03);`);
        shader.fragmentShader = fragment.replace('#include <dithering_fragment>',`#include <dithering_fragment>
          gl_FragColor=vec4(${(id/255).toFixed(9)},clamp(wbProbeSun,0.0,1.0),clamp(wbProbeAlbedo,0.0,1.0),1.0);`);
      };
      material.customProgramCacheKey = () => 'facade-direct-light-mask-' + id;
      material.needsUpdate = true;
    }
    renderer.render(w.scene,w.camera);
    const bytes = new Uint8Array(width*height*4);
    renderer.readRenderTargetPixels(target,0,0,width,height,bytes);
    const canvas = document.createElement('canvas'); canvas.width=width;canvas.height=height;
    const ctx = canvas.getContext('2d'), display=ctx.createImageData(width,height);
    for (let y=0;y<height;y++) {
      const start=(height-1-y)*width*4;
      display.data.set(bytes.subarray(start,start+width*4),y*width*4);
    }
    ctx.putImageData(display,0,0);
    return canvas.toDataURL('image/png').split(',')[1];
  } finally {
    for (const [m,write] of writes) m.colorWrite=write;
    for (const [m,{compile,key}] of patches) {m.onBeforeCompile=compile;m.customProgramCacheKey=key;m.needsUpdate=true;}
    renderer.shadowMap.autoUpdate=shadows;
    w.scene.background=previousBackground;
    renderer.autoClear=previousAuto;
    renderer.setRenderTarget(previousTarget);renderer.setClearColor(previousColor,previousAlpha);target.dispose();
  }
};
