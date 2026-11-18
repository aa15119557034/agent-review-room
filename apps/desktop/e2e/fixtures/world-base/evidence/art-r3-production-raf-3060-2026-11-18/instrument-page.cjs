module.exports=function install(mode){
 const w=worldBase,gl=w.renderer.getContext(),rowsByRoute={},keys=[],archived=[],stats={queries:0,resolved:0,invalid:0,disjointEvents:0,skippedBusy:0,skippedCap:0,scheduled:0,productionMatches:0};
 const ctxEvents=new AbortController(),pending=[],saved=[],nativeRaf=window.requestAnimationFrame;
 const ext=mode==='sparse'?gl.getExtension('EXT_disjoint_timer_query_webgl2'):null;
 let route=null,production=null,active=null,previous=null,seenStamp=null,observerId=0,running=true;
 const now=()=>performance.now();
 function drain(){
  if(!ext||pending.length===0)return;
  if(gl.getParameter(ext.GPU_DISJOINT_EXT)){stats.disjointEvents++;for(const x of pending){x.row.gpu.state='disjoint';gl.deleteQuery(x.q);stats.invalid++;}pending.length=0;return;}
  while(pending.length){
   const x=pending[0];if(!gl.getQueryParameter(x.q,gl.QUERY_RESULT_AVAILABLE))break;
   x.row.gpu.ms=gl.getQueryParameter(x.q,gl.QUERY_RESULT)/1e6;x.row.gpu.state='valid';gl.deleteQuery(x.q);pending.shift();stats.resolved++;
  }
 }
 function startGpu(row){
  if(!ext){row.gpu={state:'extension-unavailable'};return null;}
  if(!row.wantGpu){row.gpu={state:'not-selected'};return null;}
  if(pending.length>=8){stats.skippedCap++;row.gpu={state:'queue-full'};return null;}
  if(gl.getQuery(ext.TIME_ELAPSED_EXT,gl.CURRENT_QUERY)){stats.skippedBusy++;row.gpu={state:'already-active'};return null;}
  const q=gl.createQuery();gl.beginQuery(ext.TIME_ELAPSED_EXT,q);row.gpu={state:'pending'};stats.queries++;return q;
 }
 function wrapMethod(target,name,key){const orig=target[name];saved.push(()=>{target[name]=orig;});target[name]=function(...args){
  const row=active;if(!row)return orig.apply(this,args);
  const query=key==='render'?startGpu(row):null,t=now();try{return orig.apply(this,args);}finally{row.stage[key]=now()-t;row.hits[key]++;if(query){gl.endQuery(ext.TIME_ELAPSED_EXT);pending.push({q:query,row});}}
 };}
 if(mode==='sparse'){
  wrapMethod(w.station,'update','station');wrapMethod(w.walker,'update','walker');wrapMethod(w.island,'update','island');wrapMethod(w.look,'render','render');
  function invoke(stamp){const start=now();
   if(previous){previous.next={stamp,entry:start};previous=null;}
   let row=null;
   if(route){const n=route.productionCount++,block=n>>2;const position=(block*3+(block>>2)+1)&3;
    if((n&3)===position){row={id:n,stamp,entry:start,wantGpu:(block&1)===0,stage:{},hits:{station:0,walker:0,island:0,render:0}};route.sampled.push(row);active=row;}}
   try{return production.call(this,stamp);}finally{if(row){row.exit=now();row.draws=w.renderer.info.render.calls;row.triangles=w.renderer.info.render.triangles;previous=row;active=null;}}
  }
  window.requestAnimationFrame=function(cb){
   if(!production){const s=Function.prototype.toString.call(cb);if(s.includes('station.update(dt, now / 1000, walker.worldPosition)')&&s.includes('look.render(scene, dt)')){production=cb;stats.productionMatches++;}}
   if(cb===production){stats.scheduled++;return nativeRaf.call(window,invoke);}return nativeRaf.call(window,cb);
  };
 }
 function observe(stamp){if(!running)return;const r=route,t=now();if(r){
  if(r.lastObserver!=null){r.frames.push({stamp,ms:stamp-r.lastObserver,observerEntry:t,stationStamp:w.station.ctx.time*1000,draws:w.renderer.info.render.calls,triangles:w.renderer.info.render.triangles});}
  r.lastObserver=stamp;if((r.frames.length&7)===1)drain();
 }else drain();seenStamp=stamp;observerId=nativeRaf.call(window,observe);}
 observerId=nativeRaf.call(window,observe);
 for(const kind of ['keyup','keydown'])addEventListener(kind,e=>{if(e.code==='KeyW')keys.push({kind,trusted:e.isTrusted,stamp:now()});},{signal:ctxEvents.signal});
 const state=()=>({view:w.currentView,eye:w.camera.position.toArray(),quaternion:w.camera.quaternion.toArray(),fov:w.camera.fov,feet:w.walker.worldPosition.toArray(),walker:w.walker.view,walkEnabled:w.walker.enabled,timeOfDay:w.island.timeOfDay,stationTime:w.station.ctx.time,islandTime:w.island.U.uTime.value,hidden:document.body.classList.contains('hide-ui'),style:w.styleState,canvas:[gl.drawingBufferWidth,gl.drawingBufferHeight],dpr:w.renderer.getPixelRatio(),visibility:document.visibilityState,focused:document.hasFocus(),sun:w.scene.children.filter(s=>s.isDirectionalLight&&s.castShadow).map(l=>({map:!!l.shadow.map,auto:l.shadow.autoUpdate})),bake:w.weatheringDecals.stats.source,fingerprint:w.weatheringDecals.plan.fingerprint});
 window.__prodRaf={start(id){if(route)throw Error('nested route');route={id,wallStart:Date.now(),start:state(),lastObserver:null,frames:[],sampled:[],productionCount:0};},stop(){if(!route)throw Error('no route');route.end=state();route.wallEnd=Date.now();archived.push(route);route=null;},state,done:async()=>{const until=now()+2000;while((pending.length||previous)&&now()<until){await new Promise(res=>nativeRaf.call(window,res));drain();}for(const x of pending){x.row.gpu.state='unavailable-before-end';gl.deleteQuery(x.q);}const remaining=pending.length;pending.length=0;running=false;cancelAnimationFrame(observerId);if(mode==='sparse'){window.requestAnimationFrame=nativeRaf;for(const undo of saved)undo();}ctxEvents.abort();return{mode,timeOrigin:performance.timeOrigin,gpuExtension:mode==='sparse'?!!ext:null,stats,remaining,keys,routes:archived};}};
 return {mode,gpuExtension:mode==='sparse'?!!ext:null,version:w.revision,gpu:gl.getParameter(gl.getExtension('WEBGL_debug_renderer_info').UNMASKED_RENDERER_WEBGL),state:state()};
};
