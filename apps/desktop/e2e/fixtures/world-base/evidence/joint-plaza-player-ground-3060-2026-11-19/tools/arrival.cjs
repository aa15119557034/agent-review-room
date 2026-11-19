module.exports=async function arrive(wc) {
 const ev=s=>wc.executeJavaScript(s),sleep=ms=>new Promise(r=>setTimeout(r,ms)),key=t=>wc.debugger.sendCommand('Input.dispatchKeyEvent',{type:t,code:'KeyW',key:'w',windowsVirtualKeyCode:87,nativeVirtualKeyCode:87});
 await ev(`(()=>{const w=worldBase;w.setView('art-a-street');document.body.classList.add('hide-ui');const weather=document.querySelector('#weather-start');weather.value='0';weather.dispatchEvent(new Event('change'));__surfaceGate.resume();window.__arrive={};})()`);
 const snapshot=()=>ev(`(()=>{const w=worldBase;return {view:w.currentView,feet:w.walker.worldPosition.toArray(),eye:w.camera.position.toArray(),clock:w.island.weather.state.seconds,focus:document.hasFocus(),worldClock:w.island.timeOfDay,terrain:w.island.heightAt(w.walker.worldPosition.x,w.walker.worldPosition.z),glError:w.renderer.getContext().getError()};})()`);
 const start=()=>ev(`(()=>{let last=null;const a=window.__arrive={frames:[],running:true};function collect(t){if(!a.running)return;const w=worldBase;if(last!==null)a.frames.push([t,t-last,...w.walker.worldPosition.toArray(),w.renderer.info.render.calls,w.renderer.info.render.triangles]);last=t;requestAnimationFrame(collect);}requestAnimationFrame(collect);})()`);
 const stop=()=>ev('(()=>{__arrive.running=false;return __arrive.frames;})()');
 const rows=[];for(const view of ['art-a-street','third']){if(view==='third')await ev("worldBase.startWalking();worldBase.walker.setView('third');");await sleep(800);const first=await snapshot();await start();if(view==='third')await key('rawKeyDown');
 try{await sleep(view==='third'?3100:3500);}finally{if(view==='third')await key('keyUp');}
 const frames=await stop(),last=await snapshot(),delta=frames.map(v=>v[1]);const sorted=[...delta].sort((a,b)=>a-b);rows.push({view,start:first,end:last,frames,fps:delta.length*1000/delta.reduce((a,b)=>a+b),p95Ms:sorted[Math.ceil(.95*sorted.length)-1]});}
 return rows;
};
