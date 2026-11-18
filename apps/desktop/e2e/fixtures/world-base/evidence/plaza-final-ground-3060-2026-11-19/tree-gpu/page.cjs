module.exports=function install(mode,phase){
 const w=window.worldBase,r=w.renderer,gl=r.getContext(),pr=window.__plazaProvenance;
 const ext=mode==='sparse'?gl.getExtension('EXT_disjoint_timer_query_webgl2'):null;
 const nativeRAF=window.requestAnimationFrame,origDraw=r.renderBufferDirect,lights=[],timedKeys=new Set(),live=new Map(),events=new AbortController();
 w.scene.traverse(o=>{if(o.isLight&&o.shadow)lights.push(o);if(pr.byObject.has(o))live.set(o,pr.byObject.get(o));});
 const image=m=>{const tex=m?.map,img=tex?.source?.data;return tex?{id:tex.id,name:tex.name,size:[img?.width||img?.naturalWidth,img?.height||img?.naturalHeight]}:null;};
 const material=m=>({name:m.name,type:m.type,alphaTest:m.alphaTest,transparent:m.transparent,side:m.side,shadowSide:m.shadowSide,depthWrite:m.depthWrite,map:image(m)});
 const meta=[...live].map(([o,b])=>({id:o.id,parts:b.sources,sourceCount:b.totalSources,name:o.name,tri:(o.geometry.index?.count??o.geometry.attributes.position.count)/3,shadow:o.castShadow,receive:o.receiveShadow,layers:o.layers.mask,depth:o.customDepthMaterial?.type||null,material:material(o.material)}));
 const originals=pr.original.map(({part,mesh:o,mat})=>({part,live:live.has(o),tri:(o.geometry.index?.count??o.geometry.attributes.position.count)/3,material:material(mat)}));
 const accepted=['plaza/bark','plaza/blob','plaza/cards'];for(const part of accepted)if(meta.filter(o=>o.parts.includes(part)).length!==1)throw Error('Non-unique measured provenance: '+part);
 const state=()=>({feet:w.walker.worldPosition.toArray(),eye:w.camera.position.toArray(),yaw:w.walker.yaw,pitch:w.walker.pitch,orientation:w.camera.quaternion.toArray(),view:w.currentView,walking:w.walker.enabled,walkView:w.walker.view,hidden:document.body.classList.contains('hide-ui'),focus:document.hasFocus(),visibility:document.visibilityState,canvas:[gl.drawingBufferWidth,gl.drawingBufferHeight],clock:w.island.timeOfDay,style:{...w.styleState},fingerprint:w.weatheringDecals.plan.fingerprint,planSource:w.weatheringDecals.stats.source});
 const rows=[],pending=[],trials=[],keys=[],stats={timer:!!ext,disjoint:0,invalid:0,cap:0,busy:0,scheduled:0,productionMatches:0,maxPending:0};let route=null,active=null,production=null,observer,stopping=false;
 const drops=(reason)=>{for(const entry of pending){entry.sample.gpu={status:reason};gl.deleteQuery(entry.q);stats.invalid++;}pending.length=0;};
 function drain(){if(!ext)return;if(gl.getParameter(ext.GPU_DISJOINT_EXT)){stats.disjoint++;drops('disjoint');return;}while(pending.length&&gl.getQueryParameter(pending[0].q,gl.QUERY_RESULT_AVAILABLE)){const {q,sample}=pending.shift();sample.gpu={status:'valid',ms:gl.getQueryParameter(q,gl.QUERY_RESULT)/1e6};gl.deleteQuery(q);}}
 function begin(sample){if(!ext){sample.gpu={status:'no-extension'};return;}if(pending.length>=8){stats.cap++;sample.gpu={status:'pending-cap'};return;}if(gl.getQuery(ext.TIME_ELAPSED_EXT,gl.CURRENT_QUERY)){stats.busy++;sample.gpu={status:'busy'};return;}const q=gl.createQuery();gl.beginQuery(ext.TIME_ELAPSED_EXT,q);return q;}
 function end(q,sample){if(q){gl.endQuery(ext.TIME_ELAPSED_EXT);sample.gpu={status:'pending'};pending.push({q,sample});stats.maxPending=Math.max(stats.maxPending,pending.length);}}
 for(const t of ['keydown','keyup'])addEventListener(t,e=>{if(e.code==='KeyW')keys.push({type:t,trusted:e.isTrusted,ms:performance.now()});},{signal:events.signal});
 const passName=(cam,scene)=>{const li=lights.findIndex(l=>l.shadow.camera===cam);if(li>=0)return 'shadow'+li+(r.getRenderTarget()===lights[li].shadow.map?'/map':'/other');if(cam===w.camera&&scene===w.scene)return 'world';return 'other';};
 if(mode==='sparse'){
  r.renderBufferDirect=function(cam,scene,g,m,o,group){
   const profile=active,own=profile&&live.get(o);if(!own)return origDraw.apply(this,arguments);
   const pass=passName(cam,scene),key=pass+'|'+own.sources.join('+'),ordinal=profile.seen[key]||0;profile.seen[key]=ordinal+1;const unique=key+'#'+ordinal;
   if(own.sources.some(part=>part.startsWith('plaza/')))timedKeys.add(unique);
   const c=r.info.render.calls,t=r.info.render.triangles,q=profile.target===unique?begin(profile):null;
   try{return origDraw.apply(this,arguments);}finally{end(q,profile);profile.draws.push({pass,parts:own.sources,object:o.id,mat:m.type,group:group?.materialIndex??null,draws:r.info.render.calls-c,tri:r.info.render.triangles-t});}
  };
  function invoke(timestamp){
   if(!route)return production.call(this,timestamp);
   const n=route.calls++;if(n%3!==phase%3)return production.call(this,timestamp);
   const candidates=['full',...timedKeys];const target=candidates[Math.floor(n/3)%candidates.length];
   const sample={n,timestamp,target,feet:w.walker.worldPosition.toArray(),entry:performance.now(),seen:{},draws:[],gpu:{status:'target-absent'}};
   route.samples.push(sample);active=sample;const q=target==='full'?begin(sample):null;
   try{return production.call(this,timestamp);}finally{end(q,sample);sample.end=performance.now();active=null;}
  }
  window.requestAnimationFrame=function(cb){if(!production){const s=Function.prototype.toString.call(cb);if(s.includes('station.update(dt, now / 1000, walker.worldPosition)')&&s.includes('look.render(scene, dt)')){production=cb;stats.productionMatches++;}}if(cb===production){stats.scheduled++;return nativeRAF.call(window,invoke);}return nativeRAF.call(window,cb);};
 }
 function watch(t){if(stopping)return;if(route){if(route.prev!=null)route.frames.push([t,t-route.prev,...w.walker.worldPosition.toArray(),r.info.render.calls,r.info.render.triangles]);route.prev=t;}if(mode==='sparse'&&(!route||!route.frames.length||route.frames.length%8===2))drain();observer=nativeRAF.call(window,watch);}
 observer=nativeRAF.call(window,watch);
 window.__plazaCost={start(label){if(route)throw Error('overlap');route={label,start:state(),utcStart:Date.now(),frames:[],samples:[],calls:0,prev:null};timedKeys.clear();},stop(){route.end=state();route.utcEnd=Date.now();trials.push(route);route=null;},finish:async()=>{const until=performance.now()+2000;while(pending.length&&performance.now()<until){await new Promise(resolve=>nativeRAF.call(window,resolve));drain();}drops('undrained');stopping=true;cancelAnimationFrame(observer);events.abort();if(mode==='sparse'){window.requestAnimationFrame=nativeRAF;r.renderBufferDirect=origDraw;}return {mode,meta,originals,stats,trials,keys,gpu:gl.getParameter(gl.getExtension('WEBGL_debug_renderer_info').UNMASKED_RENDERER_WEBGL),lights:lights.map(l=>({name:l.name,type:l.type,allocated:!!l.shadow.map})),frameColumns:['rafMs','deltaMs','x','y','z','calls','triangles']};},state};
 return {state:state(),meta};
};
