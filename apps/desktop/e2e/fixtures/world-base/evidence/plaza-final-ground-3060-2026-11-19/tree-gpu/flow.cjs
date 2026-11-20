module.exports=async function run({ev,wc,report,stage,save,tag,p,fs,z,sha,out,a,sleep}){
 const view='art-a-street',click=v=>ev('document.querySelector('+JSON.stringify('button[data-view="'+v+'"]')+').click();document.body.classList.add("hide-ui");');
 for(const v of ['art-a-street','art-b-konbini','art-c-alley','art-d-laundry']){await click(v);await sleep(1300);}
 const key=type=>wc.debugger.sendCommand('Input.dispatchKeyEvent',{type,key:'w',code:'KeyW',windowsVirtualKeyCode:87,nativeVirtualKeyCode:87}),dist=(a,b)=>Math.hypot(...a.map((x,i)=>x-b[i]));
 const records=[];
 for(const [n,mode] of ['control','sparse'].entries()){
  await click(view);await sleep(1400);
  const data=await ev('('+require('./page.cjs').toString()+')('+JSON.stringify(mode)+','+(Number(tag.slice(0,2))%3)+')');a.deepEqual(data.state.canvas,[1440,900]);a.equal(data.state.planSource,'baked');a.match(data.state.fingerprint,tag.includes('v2')?/^1061:2670406:/:/^1061:2667664:/);
  const start=label=>ev('window.__plazaCost.start('+JSON.stringify(label)+')'),stop=()=>ev('window.__plazaCost.stop()');
  stage(mode+'-A');await start('A');await sleep(10000);await stop();
  await ev("worldBase.startWalking();worldBase.walker.setView('third');");
  await sleep(900);const spawn=await ev('worldBase.station.spawn.toArray()'),rest=await ev('new Promise(res=>{const x=[];function check(){x.push(__plazaCost.state());if(x.length===6)res(x);else requestAnimationFrame(check)}requestAnimationFrame(check)})');a(rest.every(x=>dist(x.feet,spawn)<.00001&&Math.abs(x.yaw-4*Math.PI/180)<1e-8&&Math.abs(x.pitch+8*Math.PI/180)<1e-8));stage(mode+'-third');await start('third');await key('rawKeyDown');try{await sleep(3100);}finally{await key('keyUp');}await stop();await sleep(650);
  const end=await ev('window.__plazaCost.finish()');a.match(end.gpu,/RTX 3060 Laptop/);a.deepEqual(end.keys.map(k=>[k.type,k.trusted]),[['keydown',true],['keyup',true]]);a(dist(end.trials[1].start.feet,end.trials[1].end.feet)>8);
  if(mode==='sparse'){a.equal(end.stats.productionMatches,1);a(end.trials.every(t=>t.samples.length>20));}
  records.push({spawn,rest,data:end});const bytes=z.gzipSync(JSON.stringify(records));fs.writeFileSync(p.join(out,'raw.json.gz'),bytes);report.rawSha256=sha(bytes);report.progress=records.map(v=>({mode:v.data.mode,meta:v.data.meta.map(x=>[x.parts.join('+'),x.sourceCount]),samples:v.data.trials.map(t=>[t.frames.length,t.samples.length])}));save();
 }
};
