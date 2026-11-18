// Run from the fixture with the prepared assets. A baseline may use the camera
// poses recorded by a current build, even when the older scene has no lake views.
const fs=require('node:fs'), path=require('node:path'), cp=require('node:child_process');
const {createStaticServer,cleanEnvironment}=require('./baseline.cjs');
const landforms=process.argv.includes('--landforms');
const afternoon=process.argv.includes('--afternoon');
const [exe,dir,source,poses]=process.argv.slice(2).filter(v=>v!=='--landforms' && v!=='--afternoon');
const output=path.resolve(dir),root=path.resolve(source||path.join(__dirname,'..'));
if(!process.versions.electron){
  fs.mkdirSync(output,{recursive:true});
  const log=fs.openSync(path.join(output,'electron.log'),'w');
  const child=cp.spawnSync(exe,[__filename,exe,output,root,...(poses?[path.resolve(poses)]:[]),...(landforms?['--landforms']:[]),...(afternoon?['--afternoon']:[])],
    {cwd:root,env:cleanEnvironment(path.join(output,'runtime')),stdio:['ignore',log,log],timeout:320000,windowsHide:true});
  fs.closeSync(log);console.log(output,child.status,child.error?.message??'');process.exit(child.status??1);
}
const {app,BrowserWindow}=require('electron');
app.setPath('userData',path.join(output,'runtime','user-data'));
app.commandLine.appendSwitch('force-device-scale-factor','1');
const report={start:new Date(),errors:[],requests:[],shots:{},samples:[]};
let server;
const save=()=>fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));
const finish=error=>{if(error)report.errors.push(String(error.stack||error));report.end=new Date();save();app.exit(report.errors.length||report.requests.length?1:0);};
setTimeout(()=>finish(Error('GPU run timed out')),285000).unref();
const pause=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
  server=createStaticServer(root);await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const win=new BrowserWindow({width:1440,height:900,useContentSize:true,show:true,autoHideMenuBar:true,webPreferences:{backgroundThrottling:false,contextIsolation:true,sandbox:true}});
  const wc=win.webContents,ev=s=>wc.executeJavaScript(s);
  wc.on('console-message',e=>{if(e.level==='error')report.errors.push(e.message);if(e.level==='error'||e.message?.startsWith('[world-base]'))console.log(e.message);});
  wc.session.webRequest.onErrorOccurred(x=>report.requests.push({url:x.url,error:x.error}));
  const url=new URL('http://127.0.0.1:'+server.address().port);
  if(afternoon)url.searchParams.set('time','afternoon');
  if(landforms && !poses)url.searchParams.set('view','alpine');
  await win.loadURL(url.href);
  while(!await ev('worldBase.ready')){if(await ev('worldBase.errors.length'))throw Error(await ev('worldBase.errors.join("\\n")'));await pause(250);}
  if(landforms && !poses && await ev('worldBase.currentView')!=='alpine')throw Error('Direct mountain entry failed');
  await ev("document.body.classList.add('hide-ui')");
  report.gpu=await ev("(()=>{const gl=worldBase.renderer.getContext();return gl.getParameter(gl.getExtension('WEBGL_debug_renderer_info').UNMASKED_RENDERER_WEBGL)})()");
  async function shot(id){
    await pause(180);
    await ev('new Promise(done=>{requestAnimationFrame(()=>{worldBase.renderer.getContext().finish();requestAnimationFrame(()=>done(true));});})');
    const image=await wc.capturePage();
    fs.writeFileSync(path.join(output,id+'.jpg'),image.toJPEG(91));
    report.shots[id]=await ev('({position:worldBase.camera.position.toArray(),rotation:worldBase.camera.quaternion.toArray(),fov:worldBase.camera.fov,size:[innerWidth,innerHeight,devicePixelRatio],weather:{...worldBase.island.weather.state},feet:worldBase.walker.worldPosition.toArray()})');
    console.log('photo',id);save();
    return image;
  }
  const view=id=>ev('worldBase.setView('+JSON.stringify(id)+')');
  async function weather(sec){
    await ev(`(()=>{const s=document.querySelector('#weather-start');s.value='${sec}';s.dispatchEvent(new Event('change'));})()`);await pause(180);
  }
  async function sample(id,walk=false){
    await pause(1500);
    if(walk) wc.sendInputEvent({type:'keyDown',keyCode:'W'});
    try{
      const frames=await ev('new Promise(done=>{let start,prev;const times=[];requestAnimationFrame(function loop(t){start??=t;if(prev!==undefined)times.push(t-prev);prev=t;if(t-start>=6000)done(times);else requestAnimationFrame(loop);});})');
      const sorted=[...frames].sort((a,b)=>a-b);
      report.samples.push({id,fps:1000*frames.length/frames.reduce((a,b)=>a+b),p95:sorted[Math.ceil(sorted.length*.95)-1],frames});
      console.log('sample',id,report.samples.at(-1).fps);save();
    }finally{if(walk)wc.sendInputEvent({type:'keyUp',keyCode:'W'});}
  }
  if(landforms){
    await require('./capture-landforms.cjs')({ev,view,shot,sample,report,poses,wc});
    finish();return;
  }
  const locations=['tarn','terrace','oxbow','marsh'];
  if(poses){
    const previous=JSON.parse(fs.readFileSync(poses));
    for(const id of locations){
      const q=previous.shots['compare-'+id];await view('station-street');
      await ev(`(()=>{const c=worldBase.camera;c.position.fromArray(${JSON.stringify(q.position)});c.quaternion.fromArray(${JSON.stringify(q.rotation)});c.fov=${q.fov};c.updateProjectionMatrix();c.updateMatrixWorld();})()`);
      await shot('compare-'+id);
    }
    await view('station-street');await sample('street');finish();return;
  }
  report.basins=await ev('worldBase.island.stats.basins');
  report.shore=await ev(`(async()=>{const {basins,contour}=await import('./src/basins.js'),i=worldBase.island;
    return basins.map(b=>{const entry=worldBase.views.find(v=>v.name===b.id),[x,,z]=entry.feet;
      const dx=Math.sin(entry.yaw*Math.PI/180),dz=Math.cos(entry.yaw*Math.PI/180);
      let lo=-13,hi=13;
      for(let k=0;k<22;k++){const mid=(lo+hi)/2;if(i.heightAt(x+dx*mid,z+dz*mid)>b.level)hi=mid;else lo=mid;}
      const sx=x+dx*hi,sz=z+dz*hi,bed=i.heightAt(sx,sz),t=i.U.uTime.value;
      let low=Infinity,high=-Infinity;
      for(let k=0;k<300;k++){i.U.uTime.value=k/20;const y=i.inland.sampleSurface(b,sx,sz);low=Math.min(low,y-bed);high=Math.max(high,y-bed);}
      i.U.uTime.value=t;
      const profile=[-3,-1,0,1,3].map(r=>i.heightAt(sx+r*dx,sz+r*dz)-b.level);
      return {id:b.id,shore:[sx,bed,sz],profile,low,high,stones:i.inland.group.getObjectByName(b.id+'-shore-stones').userData.count};
    });})()`);
  if(!report.shore.every(s=>s.low< -0.012 && s.high>0.012 && s.profile[0]<0 && s.profile[4]>0 && s.stones>0))throw Error('Invalid sloped wet/dry margin');
  for(const id of locations){
    await view(id);await weather(0);await shot(id);
    // The comparison cameras stand on unmodified ground in both source trees.
    await ev(`(async()=>{const {basins,contour}=await import('./src/basins.js'),w=worldBase;
      const b=basins.find(b=>b.id===${JSON.stringify(id)}),dir={tarn:[0.64,0.77],terrace:[0.55,-0.84],oxbow:[-0.93,-0.37],marsh:[0.78,-0.63]}[b.id];
      let d=1.9*Math.max(b.rx,b.rz),x,z;
      do{x=b.x+d*dir[0];z=b.z+d*dir[1];d-=0.5;}while(d>0 && contour(b,x,z)>(b.id==='oxbow'?2.94:1.71));
      w.camera.position.set(x,w.island.heightAt(x,z)+2.1,z);w.camera.lookAt(b.x,b.level,b.z);w.camera.updateMatrixWorld();})()`);
    await shot('compare-'+id);
  }
  // Kneeling-height shoreline views look along the boundary, with both land and
  // water in the foreground. They use the ordinary scene materials and water clock.
  for(const id of locations){
    await view(id);
    await ev(`(async()=>{const {basins,contour}=await import('./src/basins.js'),w=worldBase,b=basins.find(b=>b.id===${JSON.stringify(id)});
      const view=w.views.find(v=>v.name===b.id),[fx,,fz]=view.feet;
      let gx=contour(b,fx+1,fz)-contour(b,fx-1,fz),gz=contour(b,fx,fz+1)-contour(b,fx,fz-1);
      const len=Math.hypot(gx,gz);gx/=len;gz/=len;
      const x=fx+1.1*gx,z=fz+1.1*gz;
      w.camera.position.set(x,w.island.heightAt(x,z)+1.12,z);
      w.camera.lookAt(x+7*gz-3.4*gx,b.level-0.12,z-7*gx-3.4*gz);w.camera.updateMatrixWorld();})()`);
    await shot(id+'-bank');
  }
  await view('stream');await shot('stream-bank');
  await view('coast');await shot('sea-bank');
  await view('marsh');
  await sample('marsh-clear');
  await view('tarn');await weather(48);await shot('tarn-rain');await sample('tarn-rain');
  await view('marsh');await weather(165);await shot('marsh-fog');
  await view('station-street');await weather(0);await shot('street-clear');await sample('street');
  await weather(48);await shot('street-rain');await sample('street-rain');
  await view('marsh');await weather(0);
  // Hold lighting and wind phase for pixel comparisons, let the contact solver advance normally.
  await ev(`(()=>{const i=worldBase.island,wu=i.weather.update,up=i.update,time=i.U.uTime.value;
    i.weather.update=()=>wu(0); i.update=dt=>up(dt,time);
    window.restoreTime=()=>{i.weather.update=wu;i.update=up;};})()`);
  const normal=await shot('reflection');
  await ev(`(()=>{const i=worldBase.island,u=i.inland.group.getObjectByName('marsh-water').material.uniforms;
    if(!u.uMirrorOn.value || i.inland.reflection.captures<1)throw Error('No lake reflection rendered');
    const live=u.uMirrorMap.value;
    // The normal sampler receives transparent black, so the actual water shader
    // composites only sky through the missing above-water geometry.
    u.uMirrorMap.value=i.U.uWakeTex.value; window.restoreReflection=()=>{u.uMirrorMap.value=live;};})()`);
  const noBank=await shot('reflection-sky-only');
  const diff=(a,b)=>{const l=a.toBitmap(),r=b.toBitmap();let count=0;for(let k=0;k<l.length;k+=4)if(Math.max(Math.abs(l[k]-r[k]),Math.abs(l[k+1]-r[k+1]),Math.abs(l[k+2]-r[k+2]))>5)count++;return count;};
  report.bankReflectionPixels=diff(normal,noBank);
  await ev('window.restoreReflection()');
  const point=await ev(`(async()=>{const {basins}=await import('./src/basins.js'),b=basins.find(b=>b.id==='marsh'),w=worldBase,c=w.camera;
    const view=w.views.find(v=>v.name===b.id),dx=Math.sin(view.yaw*Math.PI/180),dz=Math.cos(view.yaw*Math.PI/180);
    let [x,,z]=view.feet;
    for(let k=0;k<160 && w.island.inland.depthAt(b,x,z)<0.25;k++){x-=dx*0.25;z-=dz*0.25;}
    c.position.set(x+dx*3,b.level+1.32,z+dz*3);c.lookAt(x,b.level,z);c.updateMatrixWorld();
    return {x:Math.floor(innerWidth/2),y:Math.floor(innerHeight/2)};})()`);
  const before=await shot('contact-before');
  wc.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});wc.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point});
  await pause(190);
  const after=await shot('contact-after');
  report.contact=await ev(`(()=>{const p=worldBase.island.inland.ripples,h=p.texture.image.data;let distant=0,peak=0;
    for(let j=0;j<96;j++)for(let i=0;i<96;i++){const v=Math.abs(h[j*96+i]);peak=Math.max(peak,v);if(Math.hypot(i-47.5,j-47.5)>3.5)distant=Math.max(distant,v);}
    return {impacts:p.impacts,peak,distant};})()`);
  const crop={x:Math.max(0,point.x-110),y:Math.max(0,point.y-50),width:220,height:100};
  Object.assign(report.contact,{point,crop,changedPixels:diff(before.crop(crop),after.crop(crop))});
  await ev('window.restoreTime()');
  report.flotation=await ev(`new Promise(resolve=>{const w=worldBase,i=w.island,log=i.inland.group.getObjectByName('marsh-driftwood');
    const start=performance.now(),samples=[];function step(t){samples.push({t:t-start,y:log.position.y,pitch:log.rotation.z,roll:log.rotation.x});
      if(t-start>=2400)resolve(samples);else requestAnimationFrame(step);}requestAnimationFrame(step);})`);
  const heave=report.flotation.map(row=>row.y);
  if(Math.max(...heave)-Math.min(...heave)<0.008) throw Error('Floating branch did not respond to waves');
  await view('marsh');
  const shorePoint=report.shore.find(s=>s.id==='marsh').shore;
  await ev(`import('./scripts/validate-water.js').then(({strandlineProbe})=>{window.bankProbe=strandlineProbe(worldBase,${JSON.stringify(shorePoint)});})`);
  try{
    await ev('bankProbe.show(bankProbe.lowTime)');await shot('marsh-exposed');
    await ev('bankProbe.show(bankProbe.highTime)');await shot('marsh-inundated');
    report.runup=await ev('bankProbe.measure()');
    if(report.runup.gained<300 || report.runup.highWet<=report.runup.lowWet) throw Error('The rising wave did not wet additional bank pixels');
  }finally{await ev('bankProbe.restore()');}
  await view('marsh');
  await ev("worldBase.startWalking();worldBase.walker.setView('first');document.querySelector('#world').focus()");
  const start=await ev('worldBase.walker.worldPosition.toArray()');
  await sample('wading',true);
  await shot('wading');
  report.wade=await ev(`(()=>{const w=worldBase,p=w.walker.worldPosition;return {feet:p.toArray(),depth:10-p.y,groundError:p.y-w.island.heightAt(p.x,p.z),impacts:w.island.inland.ripples.impacts};})()`);
  report.wade.distance=Math.hypot(start[0]-report.wade.feet[0],start[2]-report.wade.feet[2]);
  report.regressions=await ev(`Promise.all([import('./src/station-validation.js'),import('./scripts/validate-environment.js')]).then(([s,e])=>({station:s.validateStation(worldBase),coast:e.validateEnvironment(worldBase)}))`);
  if(report.bankReflectionPixels<150 || report.contact.impacts!==1 || report.contact.distant<=0 || report.contact.changedPixels<30 || report.wade.impacts<=1 || report.wade.depth<=0.03 || report.wade.depth>0.83 || Math.abs(report.wade.groundError)>0.02 || !report.regressions.station.ok || !report.regressions.coast.ok)throw Error('Water/route regression; see report');
  finish();
}).catch(finish);
