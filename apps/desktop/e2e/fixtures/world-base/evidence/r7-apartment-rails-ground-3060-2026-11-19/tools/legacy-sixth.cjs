'use strict';
const fs=require('node:fs'),p=require('node:path'),cp=require('node:child_process'),z=require('node:zlib'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const [exe,fixture,auditFixture,source,out,doVisibility]=process.argv.slice(2);
const rt=p.join(out,'runtime'),git=(...a)=>cp.execFileSync('git',['-c','safe.directory='+p.resolve(fixture,'../../../../..').split(p.sep).join('/'),...a],{cwd:fixture,windowsHide:true}),sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const {createStaticServer,cleanEnvironment}=require(p.join(auditFixture,'scripts/baseline.cjs'));
if(!process.versions.electron){assert.equal(git('rev-parse','HEAD').toString().trim(),source);fs.mkdirSync(out);fs.mkdirSync(rt);
  const a=cp.spawnSync(exe,[__filename,...process.argv.slice(2)],{env:cleanEnvironment(rt),cwd:fixture,windowsHide:true,stdio:'inherit'});if(a.error)throw a.error;process.exit(a.status??1);}
const {app,BrowserWindow}=require('electron'),{installGate}=require(p.join(fixture,'scripts/diagnose-surface.cjs')),{createTransportAudit}=require(p.join(auditFixture,'scripts/acceptance-transport.cjs'));
const originFile='apps/desktop/e2e/fixtures/world-base/evidence/c28-toon-ground-3060-2026-11-18/timing/driver/x51-c28-ground28-cameras.json';
const camData=git('cat-file','blob','858e68285325786ee6f3b6f9f53a97044ef96601:'+originFile),basis=JSON.parse(camData).cameras;
const views={'01-station-street':'station-street','20-rear-eye':'20-rear-eye','21-front-eye':'21-front-eye','23-service-corner':'service-corner','24-laundry-details':'laundry-details'};
const report={source,cameraSource:originFile,cameraSourceSha256:sha(camData),start:new Date().toISOString(),views:{},exceptions:[]};
let win,server;const pause=ms=>new Promise(r=>setTimeout(r,ms));const save=s=>{report.stage=s;fs.writeFileSync(p.join(out,'legacy.json'),JSON.stringify(report,null,2)+'\n');};
const deadline=setTimeout(()=>{report.fail='Timeout at '+report.stage;save('timeout');app.exit(1);},420000);
function photo(ref){
  const w=window.worldBase,c=w.camera;window.__surfaceGate.freeze();
  w.walker.setEnabled(false);w.setFlightEffects(false);document.body.classList.add('hide-ui');
  c.position.fromArray(ref.position);c.quaternion.fromArray(ref.quaternion);c.fov=ref.fov;c.updateProjectionMatrix();c.updateMatrixWorld();
  w.station.update(0,14,w.walker.worldPosition);w.island.update(0,14);w.island.U.uTime.value=14;w.look.pipeline.hasPrev=false;
  for(let i=0;i<3;i++)w.look.render(w.scene,0);
  const gl=w.renderer.getContext(),ext=gl.getExtension('WEBGL_debug_renderer_info');
  return {camera:{position:c.position.toArray(),quaternion:c.quaternion.toArray(),fov:c.fov},gpu:gl.getParameter(ext.UNMASKED_RENDERER_WEBGL),time:w.island.U.uTime.value,
    preset:w.island.timeOfDay,size:[gl.drawingBufferWidth,gl.drawingBufferHeight],glError:gl.getError(),png:w.renderer.domElement.toDataURL('image/png').split(',')[1]};
}
function installMeter(){
  const w=window.worldBase,saveStation=w.station.update,saveLook=w.look.render;let last=null,now=0,rows=null;
  w.station.update=function(dt,time,...args){now=time*1000;return saveStation.call(this,dt,time,...args);};
  w.look.render=function(...args){const v=saveLook.apply(this,args);if(rows&&now!==last){if(last!==null){const x=w.renderer.info.render;rows.push({ms:now-last,draws:x.calls,triangles:x.triangles});}last=now;}return v;};
  window.__legacyMeter={start(){rows=[];last=null;},duration(){return rows.reduce((s,r)=>s+r.ms,0);},end(){const a=rows;rows=null;return a;},restore(){w.station.update=saveStation;w.look.render=saveLook;}};
}
async function main(){
  app.setPath('userData',p.join(rt,'user'));app.commandLine.appendSwitch('force-device-scale-factor','1');app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');app.commandLine.appendSwitch('disable-renderer-backgrounding');app.commandLine.appendSwitch('disable-background-timer-throttling');app.commandLine.appendSwitch('disable-features','CalculateNativeWinOcclusion');await app.whenReady();
  const audit=createTransportAudit();server=createStaticServer(fixture,audit);await new Promise((r,j)=>{server.once('error',j);server.listen(0,'127.0.0.1',r);});
  const origin='http://127.0.0.1:'+server.address().port;win=new BrowserWindow({width:1440,height:900,useContentSize:true,show:false,autoHideMenuBar:true,
    webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});win.showInactive();
  const wc=win.webContents,ev=s=>wc.executeJavaScript(s),cdp=(m,x)=>wc.debugger.sendCommand(m,x);
  await wc.loadURL('about:blank');wc.debugger.attach('1.3');const urls=new Map(),failed=[],httpErrors=[];
  wc.debugger.on('message',(_,m,x)=>{audit.cdp(m,x);if(m==='Network.requestWillBeSent')urls.set(x.requestId,x.request.url);
    if(m==='Network.loadingFailed')failed.push({...x,url:urls.get(x.requestId)});if(m==='Network.responseReceived'&&x.response.status>=400)httpErrors.push({url:x.response.url,status:x.response.status,requestId:x.requestId});
    if(m==='Runtime.exceptionThrown')report.exceptions.push(x.exceptionDetails);});
  for(const m of ['Page.enable','Network.enable','Runtime.enable'])await cdp(m);
  await cdp('Page.addScriptToEvaluateOnNewDocument',{source:'('+installGate.toString()+')()'});await cdp('Page.addScriptToEvaluateOnNewDocument',{source:audit.pageSource});
  save('loading');await wc.loadURL(origin+'/');while(!await ev('window.worldBase?.ready===true')){assert.deepEqual(await ev('window.worldBase?.errors||[]'),[]);await pause(200);}
  await ev('(()=>{const b=document.getElementById("go");if(b&&!b.disabled)b.click();document.body.classList.add("hide-ui");})()');
  await ev('('+installMeter.toString()+')()');const all={};
  for(const [id,name] of Object.entries(views)){
    save('legacy '+id);const ref=basis[name],im=await ev('('+photo.toString()+')('+JSON.stringify(ref)+')');
    assert.deepEqual(im.camera,ref);assert.deepEqual(im.size,[1440,900]);assert.match(im.gpu,/RTX 3060 Laptop/);assert.equal(im.time,14);assert.equal(im.preset,'evening');assert.equal(im.glError,0);
    const png=Buffer.from(im.png,'base64');delete im.png;fs.writeFileSync(p.join(out,id+'.png'),png);im.pngSHA256=sha(png);
    await ev('window.__surfaceGate.resume()');await pause(1000);await ev('__legacyMeter.start()');await pause(6500);
    while(await ev('__legacyMeter.duration()')<6500)await pause(90);
    const rows=await ev('__legacyMeter.end()'),end=await ev('({position:worldBase.camera.position.toArray(),quaternion:worldBase.camera.quaternion.toArray(),fov:worldBase.camera.fov})');
    assert.deepEqual(end,ref);assert(rows.every(x=>x.ms>0&&x.draws>0&&x.triangles>0));const times=rows.map(x=>x.ms).sort((a,b)=>a-b),ms=times.reduce((a,b)=>a+b,0);
    all[id]=rows;report.views[id]={...im,n:rows.length,durationMs:ms,fps:1000*rows.length/ms,p95Ms:times[Math.ceil(.95*rows.length)-1],p99Ms:times[Math.ceil(.99*rows.length)-1]};
  }
  await ev('__legacyMeter.restore()');fs.writeFileSync(p.join(out,'legacy-frames.json.gz'),z.gzipSync(JSON.stringify(all)));
  if(doVisibility==='visibility'){
    save('counting submitted geometry');const vis={};const script='('+require('./visibility-page.cjs').toString()+')()';
    await ev('(()=>{const b=document.querySelector("button[data-view=art-a-street]");b.click();if(worldBase.currentView!=="art-a-street")throw Error("Street A");})()');
    await pause(900);vis.street=await ev(script);
    await ev('(()=>{const w=worldBase;w.startWalking();w.walker.setView("first");window.__surfaceGate.resume();})()');
    const start=await ev('worldBase.walker.worldPosition.toArray()');
    const key=type=>cdp('Input.dispatchKeyEvent',{type,key:'w',code:'KeyW',windowsVirtualKeyCode:87,nativeVirtualKeyCode:87});
    await key('keyDown');try{await pause(1100);}finally{await key('keyUp');}
    const end=await ev('worldBase.walker.worldPosition.toArray()');vis.first=await ev(script);assert.equal(vis.first.camera.walker,'first');
    vis.walk={start,end,distance:Math.hypot(end[0]-start[0],end[2]-start[2])};assert(vis.walk.distance>1);
    fs.writeFileSync(p.join(out,'visibility.json.gz'),z.gzipSync(JSON.stringify(vis)));
    report.visibility=Object.fromEntries(['street','first'].map(k=>[k,Object.fromEntries(Object.entries(vis[k]).filter(([id])=>id!=='rows'))]));
  }
  const net=await audit.finish({origin,failures:failed,httpErrors,readPage:ev});fs.writeFileSync(p.join(out,'legacy-network.json.gz'),z.gzipSync(JSON.stringify(net)));
  report.network={coverage:net.coverage,clean:net.payloadIntegrityClean,verifiedCanceled:net.verifiedCanceled.length,problems:net.problems};assert(net.payloadIntegrityClean);assert.deepEqual(report.exceptions,[]);
  assert.equal(git('rev-parse','HEAD').toString().trim(),source);report.ok=true;save('complete');
}
main().catch(e=>{report.fail=e.stack||String(e);save('failed');}).finally(()=>{clearTimeout(deadline);win?.destroy();server?.close();app.exit(report.ok?0:1);});

