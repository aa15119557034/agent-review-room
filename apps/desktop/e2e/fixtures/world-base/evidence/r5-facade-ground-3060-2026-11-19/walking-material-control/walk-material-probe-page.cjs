'use strict';
module.exports = function walkingMaterialProbe() {
  const w = window.worldBase, r = w.renderer, gl = r.getContext();
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  const timer = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  const gpu = info && gl.getParameter(info.UNMASKED_RENDERER_WEBGL);
  if (!/RTX 3060 Laptop/.test(gpu) || !timer) throw Error('Missing 3060 GPU/timer');
  const sources = new Map();
  w.scene.traverse(o => {
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (!m?.name?.startsWith('apartment-pbr-') || sources.has(m)) continue;
      if (m.aoMapIntensity !== .4) throw Error('Wrong refined AO');
      sources.set(m, { compile:m.onBeforeCompile, key:m.customProgramCacheKey, before:m.onBeforeRender, ao:m.aoMapIntensity });
    }
  });
  if (sources.size !== 4) throw Error('Expected four facade materials');
  const stripped = new Set();
  let active, prior, query, pending, mark = 0, previous = 0;
  const originalStation = w.station.update, originalLook = w.look.render;
  function flush(record) {
    if (gl.getParameter(timer.GPU_DISJOINT_EXT)) {
      record.disjoint++;
      while (pending.length) gl.deleteQuery(pending.shift());
      return;
    }
    while (pending.length && gl.getQueryParameter(pending[0],gl.QUERY_RESULT_AVAILABLE)) {
      const q = pending.shift();
      record.gpu.push(gl.getQueryParameter(q,gl.QUERY_RESULT)/1e6);
      gl.deleteQuery(q);
    }
  }
  for (const [m,s] of sources) {
    m.onBeforeRender = function(renderer,scene,camera,...args) {
      if (active) {
        active.facadeCalls[m.name]++;
        if (camera === w.camera) active.mainCalls++;
      }
      return s.before.call(this,renderer,scene,camera,...args);
    };
  }
  const variant = refined => {
    for (const [m,s] of sources) {
      m.aoMapIntensity = refined ? s.ao : .65;
      m.onBeforeCompile = refined ? s.compile : function(shader, renderer) {
        s.compile.call(this,shader,renderer);
        const regex = /\{ \/\/ wbFacadeBounce[\s\S]*?\n\}/g;
        if (shader.fragmentShader.match(regex)?.length !== 1) throw Error('Unexpected facade shader '+m.name);
        shader.fragmentShader = shader.fragmentShader.replace(regex,'');
        stripped.add(m.name);
      };
      m.customProgramCacheKey = refined ? s.key : () => s.key.call(m)+'|control-without-r5';
      m.needsUpdate = true;
    }
  };
  w.station.update = function(dt, time, ...rest) {
    if (active) {
      const stamp = time*1000;
      if (previous) active.raf.push(stamp-previous);
      previous = stamp;
      mark++;
      if (active.timed && mark%5 === 0) {
        flush(active);
        if (pending.length < 6) {
          query = gl.createQuery();
          gl.beginQuery(timer.TIME_ELAPSED_EXT,query);
        }
      }
    }
    return originalStation.call(this,dt,time,...rest);
  };
  w.look.render = function(...args) {
    try { return originalLook.apply(this,args); }
    finally {
      if (active) {
        active.frames++;
        if (query) {
          gl.endQuery(timer.TIME_ELAPSED_EXT);
          pending.push(query);
          query = null;
        }
      }
    }
  };
  const keys = [];
  for (const kind of ['keydown','keyup']) addEventListener(kind,e=>{
    if (e.code==='KeyW') keys.push({kind,trusted:e.isTrusted});
  });
  window.__walkProbe = {
    variant, gpu, names: [...sources.keys()].map(m=>m.name),
    start(timed) {
      if (active || query || pending?.length) throw Error('Timing phases overlap');
      previous = 0;mark = 0;pending = [];
      active = prior = { timed, frames:0, raf:[], gpu:[], disjoint:0, mainCalls:0,
        facadeCalls:Object.fromEntries([...sources.keys()].map(m=>[m.name,0])),
        start:w.walker.worldPosition.toArray(), eye:w.camera.position.toArray(),
        mode:w.walker.view, keysAtStart:keys.length };
    },
    async stop() {
      if (!active || query) throw Error('Unexpected stop inside frame');
      active.end = w.walker.worldPosition.toArray();
      active.keys = keys.slice(active.keysAtStart);
      active = null;
      for (let i=0;i<160 && pending.length;i++) {
        flush(prior);
        if (pending.length) await new Promise(r=>setTimeout(r,12));
      }
      if (pending.length) throw Error('Timing query remained in flight');
      return prior;
    },
    stripped(){return [...stripped];}
  };
  return {gpu,names:window.__walkProbe.names};
};
