(async function trace(){
 const w=window.worldBase,r=w.renderer,gl=r.getContext(),delay=ms=>new Promise(done=>setTimeout(done,ms));
 const res={frames:[],source:'WebGL actual draw methods incl WEBGL_multi_draw; getUniform before submission on current program'};
 const state=()=>({view:w.currentView,pos:w.camera.position.toArray(),quat:w.camera.quaternion.toArray(),ui:document.querySelector('#toon').checked});
 const wrappers=()=>new Map(r.info.programs.filter(p=>p.program).map(p=>[p.program,p]));
 const locs=new WeakMap(),getLoc=pg=>{if(!locs.has(pg))locs.set(pg,[gl.getUniformLocation(pg,'uTbK'),gl.getUniformLocation(pg,'uTbRim')]);return locs.get(pg);};
 const uniforms=pg=>{const [k,b]=getLoc(pg);return k&&b?[gl.getUniform(pg,k),gl.getUniform(pg,b)]:null;};
 const sums=list=>list.reduce((o,v)=>(o[v]=(o[v]||0)+1,o),{});
 const cache=()=>{const list=[];for(const [pg,p] of wrappers()){const val=uniforms(pg);if(val)list.push({id:p.id,name:p.name,pair:val.join(',')});}return {pairs:sums(list.map(l=>l.pair)),lit:list};};
 const name=o=>{const a=[];for(let n=o;n;n=n.parent)if(n.name)a.unshift(n.name);return a.join('/');};
 const describe=(m,o)=>({mat:m?.name||'',type:m?.type??'',uuid:m?.uuid||'',obj:o?.name||'',kind:o?.type||'',path:name(o)});
 const owners=(ids)=>{const out={};for(const id of ids)out[id]=[];const add=o=>{for(const m of [].concat(o.material||[])){for(const p of r.properties.get(m).programs?.values()||[]){if(out[p.id]&&out[p.id].length<30)out[p.id].push(describe(m,o));}}};w.scene.traverse(add);w.look.pipeline.overlay?.traverse(add);return out;};
 function capture(label,watch=[]){
   const wrappersByPg=wrappers(),drawn=new Map(),current=gl.getParameter(gl.CURRENT_PROGRAM),prevUse=gl.useProgram,prevBuffer=r.renderBufferDirect,restore=[];let pg=current,own=null,drawCalls=0,multi=0;
   gl.useProgram=function(p){pg=p;return prevUse.call(this,p);};
   r.renderBufferDirect=function(c,s,g,m,o,group){const old=own;own={m,o};try{return prevBuffer.call(this,c,s,g,m,o,group);}finally{own=old;}};
   const bind=(api,method)=>{const saved=api?.[method];if(typeof saved!=='function')return;const isMulti=method.startsWith('multiDraw');
     api[method]=function(...args){drawCalls++;if(isMulti)multi++;if(pg){let p=wrappersByPg.get(pg);if(!p)p=wrappers().get(pg);
       if(p&&(watch.includes(p.id)||!drawn.has(p.id))){const u=uniforms(pg);
         if(u){const hit=drawn.get(p.id)||{id:p.id,name:p.name,pair:u.join(','),first:describe(own?.m,own?.o),targetDrawPairs:{},watchExamples:[]};drawn.set(p.id,hit);
           if(watch.includes(p.id)){hit.targetDrawPairs[u.join(',')]=(hit.targetDrawPairs[u.join(',')]||0)+1;if(hit.watchExamples.length<4)hit.watchExamples.push(describe(own?.m,own?.o));}}
         else if(!drawn.has(p.id)) drawn.set(p.id,null);
       }}return saved.apply(this,args);};restore.push(()=>{api[method]=saved});};
   for(const method of ['drawArrays','drawElements','drawArraysInstanced','drawElementsInstanced','drawRangeElements'])bind(gl,method);
   const ext=gl.getExtension('WEBGL_multi_draw');for(const method of ['multiDrawArraysWEBGL','multiDrawElementsWEBGL','multiDrawArraysInstancedWEBGL','multiDrawElementsInstancedWEBGL'])bind(ext,method);
   try{w.look.render(w.scene,1/60);}finally{for(const cb of restore.reverse())cb();gl.useProgram=prevUse;r.renderBufferDirect=prevBuffer;}
   const lit=[...drawn.values()].filter(Boolean),post=cache();res.frames.push({label,...state(),cache:post.pairs,drawCalls,multi,drawnLit:sums(lit.map(l=>l.pair)),drawn:lit,remaining:post.lit.filter(l=>l.pair!=='0,0').map(v=>v.id)});
 }

 const now=cache(),ids=now.lit.filter(z=>z.pair==='1,1').map(z=>z.id);res.offBeforeTrace=now;res.remnantIds=ids;res.owners=owners(ids);
 capture('01-off',ids);
 for(const key of ['shop-interior','service-corner','laundry-details','station-street']){w.setView(key);capture(key+'-off-first',ids);}
 const left=cache().lit.filter(z=>z.pair==='1,1').map(z=>z.id);
 if(left.length){const list=[];w.scene.traverse(o=>{if(!o.material)return;if([].concat(o.material).some(m=>[...(r.properties.get(m).programs?.values()||[])].some(p=>left.includes(p.id))))list.push([o,o.frustumCulled]);});try{for(const [o] of list)o.frustumCulled=false;capture('01-off-force-submit-targets',ids);}finally{for(const [o,b] of list)o.frustumCulled=b;}res.forcedObjects=list.length;}
 w.setToon(true);capture('01-on-restored',ids);res.glError=gl.getError();res.sceneErrors=w.errors;return res;
})()
