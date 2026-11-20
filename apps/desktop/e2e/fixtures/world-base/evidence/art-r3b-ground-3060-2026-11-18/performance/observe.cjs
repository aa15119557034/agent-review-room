'use strict';
module.exports = function observeRoutes() {
  const w = worldBase, gl = w.renderer.getContext();
  const observed = [], keys = [], events = new AbortController();
  let current = null, id = 0;
  function tick(stamp) {
    if (current) {
      if (current.previous !== null) {
        current.frames.push({stamp, ms:stamp-current.previous, observerEntry:performance.now(), stationStamp:w.station.ctx.time*1000, draws:w.renderer.info.render.calls, triangles:w.renderer.info.render.triangles});
      }
      current.previous = stamp;
    }
    id = requestAnimationFrame(tick);
  }
  id = requestAnimationFrame(tick);
  for (const kind of ['keyup','keydown']) {
    addEventListener(kind,e=>{if(e.code==='KeyW')keys.push({kind,trusted:e.isTrusted,stamp:performance.now()});},{signal:events.signal});
  }
  const state = ()=>({view:w.currentView,eye:w.camera.position.toArray(),quaternion:w.camera.quaternion.toArray(),fov:w.camera.fov,feet:w.walker.worldPosition.toArray(),walker:w.walker.view,walkEnabled:w.walker.enabled,timeOfDay:w.island.timeOfDay,stationTime:w.station.ctx.time,islandTime:w.island.U.uTime.value,hidden:document.body.classList.contains('hide-ui'),style:w.styleState,canvas:[gl.drawingBufferWidth,gl.drawingBufferHeight],dpr:w.renderer.getPixelRatio(),visibility:document.visibilityState,focused:document.hasFocus(),sun:w.scene.children.filter(s=>s.isDirectionalLight&&s.castShadow).map(l=>({map:!!l.shadow.map,auto:l.shadow.autoUpdate})),bake:w.weatheringDecals.stats.source,fingerprint:w.weatheringDecals.plan.fingerprint});
  window.__prodRaf = {
    start(route) { if (current) throw Error('Nested route'); current={id:route,wallStart:Date.now(),start:state(),previous:null,frames:[],sampled:[]}; },
    stop() { if (!current) throw Error('No open route'); current.end=state();current.wallEnd=Date.now();observed.push(current);current=null; },
    done() { cancelAnimationFrame(id);events.abort();return {mode:'control',timeOrigin:performance.timeOrigin,stats:{},gpuExtension:null,keys,routes:observed}; }
  };
  return {mode:'control',gpuExtension:null,version:w.revision,gpu:gl.getParameter(gl.getExtension('WEBGL_debug_renderer_info').UNMASKED_RENDERER_WEBGL),state:state()};
};
