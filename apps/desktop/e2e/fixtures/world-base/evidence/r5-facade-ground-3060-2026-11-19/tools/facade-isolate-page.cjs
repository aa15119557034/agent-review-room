'use strict';
module.exports = function compareTheSameWorldFrame() {
  const w=window.worldBase, r=w.renderer;
  const materials=new Set();
  w.scene.traverse(o=>{for(const m of Array.isArray(o.material)?o.material:[o.material])if(m?.name?.startsWith('apartment-pbr-'))materials.add(m);});
  if(materials.size!==4)throw Error('Expected all four authored facade materials.');
  const saved=new Map([...materials].map(m=>[m,{compile:m.onBeforeCompile,key:m.customProgramCacheKey,ao:m.aoMapIntensity}]));
  const disabled=new Set();
  function photo() {
    w.look.pipeline.hasPrev=false;
    w.look.render(w.scene,0);
    w.look.render(w.scene,0);
    return r.domElement.toDataURL('image/png').split(',')[1];
  }
  function restore() {
    for(const [m,prev] of saved){m.onBeforeCompile=prev.compile;m.customProgramCacheKey=prev.key;m.aoMapIntensity=prev.ao;m.needsUpdate=true;}
  }
  const refined=photo();
  try {
    for(const [m,prev] of saved){
      if(prev.ao!==0.4)throw Error('Expected the authored R5 occlusion setting.');
      m.aoMapIntensity=0.65;
      m.onBeforeCompile=function(shader,renderer){
        prev.compile.call(this,shader,renderer);
        const pattern=/\{ \/\/ wbFacadeBounce[\s\S]*?\n\}/g;
        const occurrences=shader.fragmentShader.match(pattern);
        if(occurrences?.length!==1)throw Error('Could not isolate the single R5 lighting block in '+m.name);
        shader.fragmentShader=shader.fragmentShader.replace(pattern,'');
        disabled.add(m.name);
      };
      m.customProgramCacheKey=()=>prev.key.call(m)+'|before-r5-facade';
      m.needsUpdate=true;
    }
    const baseline=photo();
    restore();
    const restored=photo();
    return {refined,baseline,restored,disabled:[...disabled],time:w.island.U.uTime.value,eye:w.camera.position.toArray()};
  } finally {restore();}
};
