// Read-only scene diagnosis. Lives outside the fixture; does not change its source.
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process'), crypto = require('node:crypto');
const fixture = 'D:/codex/2026-11-16/world-implementation/world-base/apps/desktop/e2e/fixtures/world-base';
const {createStaticServer, cleanEnvironment} = require(path.join(fixture, 'scripts/baseline.cjs'));
const {installGate} = require(path.join(fixture, 'scripts/diagnose-surface.cjs'));
const {sceneFiles} = require(path.join(fixture, 'scripts/diagnose-wet-road.cjs'));
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function prepare(legacyCamera){
 const THREE=await import('three'),w=window.worldBase,s=w.station,gate=window.__surfaceGate,pipe=w.look.pipeline;
 const saved={camera:w.camera.clone(),view:w.currentView,walking:w.walker.enabled,time:w.island.U.uTime.value,stationTime:s.ctx.time,contrast:pipe.params.contrast,ao:pipe.finalMat.uniforms.uAO.value,hidden:document.body.classList.contains('hide-ui'),ui:[...document.querySelectorAll('[data-view],#walk,#mode,#camera')].map(e=>({e,text:e.textContent,className:e.className}))};
 gate.freeze();w.walker.setEnabled(false);document.body.classList.add('hide-ui');
 const shutters=[];s.root.traverse(o=>{if(o.isMesh&&!Array.isArray(o.material)&&o.material.name==='tool-shed-worn-shutter')shutters.push(o)});
 const originals=shutters.map(o=>({mesh:o,material:o.material,normalMap:o.material.normalMap,aoMap:o.material.aoMap,receiveShadow:o.receiveShadow}));
 let currentView=null;
 const roi=[{name:'door-interior-upper',x:759,y:360,width:12,height:18},{name:'door-interior-lower',x:759,y:450,width:12,height:18}];
 const stats=(raw,channels)=>Array.from({length:3},(_,c)=>{let min=Infinity,max=-Infinity,sum=0,zero=0;for(let i=c;i<raw.length;i+=channels){const v=raw[i];min=Math.min(min,v);max=Math.max(max,v);sum+=v;if(v===0)zero++;}return{min,max,mean:sum/(raw.length/channels),zeroCount:zero};});
 function linear(rt,region){const result={targetType:rt.texture.type,format:rt.texture.format,colorSpace:rt.texture.colorSpace,width:rt.width,height:rt.height,roi:region,method:'Three readRenderTargetPixels HalfFloatType into Uint16Array; decode with pinned THREE.DataUtils.fromHalfFloat; framebuffer y is flipped from top-origin ROI.'};if(rt.texture.type!==THREE.HalfFloatType||rt.texture.format!==THREE.RGBAFormat)return{...result,available:false,reason:'Unsupported target format'};const gl=w.renderer.getContext(),data=new Uint16Array(region.width*region.height*4);data.fill(0x7e00);w.renderer.readRenderTargetPixels(rt,region.x,rt.height-region.y-region.height,region.width,region.height,data);const error=gl.getError(),decoded=Array.from(data,v=>THREE.DataUtils.fromHalfFloat(v));if(error!==0||decoded.some(v=>!Number.isFinite(v)))return{...result,available:false,glError:error,reason:'Read failed or retained NaN sentinel'};return{...result,available:true,glError:error,rawHalfWords:Array.from(data),decodedRGBA:decoded,channelsRGB:stats(decoded,4)};}
 window.__c9Probe={
  selectView(view){
    if(view.space==='preset')w.setView(view.name);
    else if(view.space==='legacy-world'){w.camera.position.fromArray(view.position);w.camera.quaternion.fromArray(view.quaternion);w.camera.fov=view.fov;w.camera.updateProjectionMatrix();w.camera.updateMatrixWorld();}
    else{w.camera.position.copy(s.toWorld(new THREE.Vector3(...view.position)));w.camera.lookAt(s.toWorld(new THREE.Vector3(...view.target)));w.camera.fov=view.fov;w.camera.updateProjectionMatrix();w.camera.updateMatrixWorld();}
    s.update(0,14,w.walker.worldPosition);w.island.update(0,14);w.island.U.uTime.value=14;pipe.hasPrev=false;currentView=view.name;
  },
  setAO(value){w.look.setAO(value);pipe.hasPrev=false;},
  capture(){w.renderer.info.reset();w.look.render(w.scene,0);const png=w.renderer.domElement.toDataURL('image/png');const finalPixels=(currentView==='service-corner-legacy-c8'?roi:[]).map(r=>{const c=document.createElement('canvas');c.width=r.width;c.height=r.height;const ctx=c.getContext('2d');ctx.drawImage(w.renderer.domElement,r.x,r.y,r.width,r.height,0,0,r.width,r.height);const raw=Array.from(ctx.getImageData(0,0,r.width,r.height).data);return{roi:r,rawRGBA:raw,channelsRGB:stats(raw,4)};});const hdr=(currentView==='service-corner-legacy-c8'?roi:[]).map(r=>({roi:r,scene:linear(pipe.sceneRT,r),comp:linear(pipe.compRT,r)}));const gl=w.renderer.getContext(),ext=gl.getExtension('WEBGL_debug_renderer_info');return{png,camera:{position:w.camera.position.toArray(),quaternion:w.camera.quaternion.toArray(),fov:w.camera.fov},time:w.island.U.uTime.value,view:currentView,contrast:pipe.params.contrast,uploadedAO:pipe.finalMat.uniforms.uAO.value,uploadedContrast:pipe.finalMat.uniforms.uContrast.value,params:{...pipe.params},ao:pipe.finalMat.uniforms.uAO.value,toon:pipe.finalMat.uniforms.uToon.value,materialsUnchanged:originals.every(o=>o.mesh.material===o.material&&o.material.normalMap===o.normalMap&&o.material.aoMap===o.aoMap&&o.mesh.receiveShadow===o.receiveShadow),shutters:shutters.map(o=>({material:o.material.uuid,color:o.material.color.toArray(),normalScale:o.material.normalScale.toArray()})),finalPixels,linearPixels:hdr,render:{...w.renderer.info.render},renderer:{glError:gl.getError()},gpu:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),errors:[...w.errors]};},
  restore(){w.look.setAO(saved.ao);pipe.params.contrast=saved.contrast;pipe.finalMat.uniforms.uContrast.value=saved.contrast;w.setView(saved.view);w.walker.setEnabled(saved.walking);w.camera.copy(saved.camera);w.camera.updateMatrixWorld();s.update(0,saved.stationTime,w.walker.worldPosition);w.island.update(0,saved.time);w.island.U.uTime.value=saved.time;document.body.classList.toggle('hide-ui',saved.hidden);for(const e of saved.ui){e.e.className=e.className;e.e.textContent=e.text;}pipe.hasPrev=false;gate.resume();return{ao:pipe.finalMat.uniforms.uAO.value,contrast:pipe.params.contrast,uploadedContrast:pipe.finalMat.uniforms.uContrast.value,materialsUnchanged:originals.every(o=>o.mesh.material===o.material&&o.material.normalMap===o.normalMap&&o.material.aoMap===o.aoMap&&o.mesh.receiveShadow===o.receiveShadow),view:w.currentView,fov:w.camera.fov,time:w.island.U.uTime.value,frozen:gate.frozen};}
 };
 if(saved.contrast!==1.05||saved.ao!==.55||pipe.params.blur!==0||pipe.params.rays!==0)throw new Error('Expected unchanged default look configuration');
 const p=w.city.placements.find(p=>p.type==='apartment'&&p.model.features.shop);if(!p)throw new Error('Missing real 4F shop');const [x,z]=p.frontage,y=p.baseY;
 const ground=(x,z)=>w.island.heightAt(x+s.root.position.x,z+s.root.position.z)-s.root.position.y;
 const views=[
   ...['service-corner','laundry-details','shop-interior'].map(name=>{const view=w.views.find(v=>v.name===name);if(!view)throw new Error('Missing preset '+name);return{...JSON.parse(JSON.stringify(view)),space:'preset'};}),
   {name:'20-rear-eye',space:'station-local',fov:58,position:[x-9,ground(x-9,z-20)+1.6,z-20],target:[x+2,y+2,z-10]},
   {name:'21-front-eye',space:'station-local',fov:58,position:[x-8,ground(x-8,-117)+1.66,-117],target:[x+2,y+2.1,z-.4]},
   {...JSON.parse(JSON.stringify(w.views.find(v=>v.name==='station-street'))),space:'preset'},
   {name:'service-corner-legacy-c8',space:'legacy-world',...legacyCamera}
 ];
 return{views,roi,defaultAO:saved.ao,legacyCamera,method:'Actual C9 scene and pinned nine assets. Main RAF frozen/time14; per view select once, AO .55 then0 only. Each state retains one warmup plus two fresh render captures. Current default service preset plus exact saved C8 legacy service world camera for identical HDR ROI comparison. 20/21 formulas and FOV58 match C8 AO experiment. No contrast ABA, UI/physics test, performance claim, source/material/quality/light replacement.'};
}

function readHead() {
  let root=fixture;while(!fs.existsSync(path.join(root,'.git'))){const parent=path.dirname(root);if(parent===root)throw new Error('Missing worktree metadata');root=parent;}
  const dot=path.join(root,'.git'),dir=fs.statSync(dot).isDirectory()?dot:path.resolve(root,fs.readFileSync(dot,'utf8').trim().replace(/^gitdir: /,''));
  const value=fs.readFileSync(path.join(dir,'HEAD'),'utf8').trim();if(!value.startsWith('ref: '))return value;
  const ref=value.slice(5),common=fs.existsSync(path.join(dir,'commondir'))?path.resolve(dir,fs.readFileSync(path.join(dir,'commondir'),'utf8').trim()):dir;
  for(const base of [dir,common]){const p=path.join(base,ref);if(fs.existsSync(p))return fs.readFileSync(p,'utf8').trim();}
  const packed=fs.readFileSync(path.join(common,'packed-refs'),'utf8').split(/\r?\n/).find(l=>l.endsWith(' '+ref));if(!packed)throw new Error('Missing ref '+ref);return packed.split(' ')[0];
}

function launch() {
  const name=process.argv[2]||'gpu-look-c9';
  if(!/^gpu-look-c9(?:-[a-z0-9]+)*$/.test(name))throw new Error('Expected a new props integration directory name');
  const output=path.join(fixture,'artifacts',name);
  if(fs.existsSync(output))throw new Error('Output exists; preserve evidence');
  fs.mkdirSync(output,{recursive:true});
  const config={fixture,output,runtime:fs.mkdtempSync(path.join(output,'runtime-')),startedAt:new Date().toISOString(),timeoutMs:180000};
  const head=readHead();
  const assets=require(path.join(fixture,'scripts/prepare-props.cjs')).verifyPreparedAssets(fixture);if(assets.files.length!==9)throw new Error('Expected the nine pinned prop files');
  fs.writeFileSync(path.join(output,'prop-assets-manifest.json'),JSON.stringify(assets,null,2));
  const manifest={head,capturedAt:config.startedAt,files:sceneFiles()};
  fs.writeFileSync(path.join(output,'source-manifest.json'),JSON.stringify(manifest,null,2));
  const previousPath='D:/codex/2026-11-16/world-implementation/world-base/apps/desktop/e2e/fixtures/world-base/artifacts/gpu-shutter-c8-grade-v2/grade-report.json';
  const previous=JSON.parse(fs.readFileSync(previousPath,'utf8')),reference=previous.captures.find(c=>c.name==='00-contrast-original-capture-2');
  if(!reference)throw new Error('Missing original C8 camera evidence');
  config.legacyCamera=reference.camera;config.legacyReference={file:previousPath,sha256:hash(fs.readFileSync(previousPath)),capture:reference.name,sourceHead:previous.headAfter};
  fs.writeFileSync(path.join(output,'legacy-c8-reference.json'),JSON.stringify({reference:config.legacyReference,camera:reference.camera,finalPixels:reference.finalPixels,linearPixels:reference.linearPixels},null,2));
  config.driverSha256=hash(fs.readFileSync(__filename));
  const file=path.join(config.runtime,'config.json');fs.writeFileSync(file,JSON.stringify(config,null,2));
  fs.writeFileSync(path.join(output,'run-config.json'),JSON.stringify(config,null,2));
  const log=fs.openSync(path.join(output,'electron.log'),'w');
  const child=cp.spawn('D:/codex/2026-11-16/world-implementation/runtime-path-probe/electron.exe',[__filename,file],{cwd:fixture,windowsHide:true,env:cleanEnvironment(config.runtime),stdio:['ignore',log,log]});fs.closeSync(log);
  child.on('spawn',()=>{fs.writeFileSync(path.join(output,'process.json'),JSON.stringify({pid:child.pid}));console.log('C9 look diagnosis PID '+child.pid+'; '+output);});
  child.on('error',e=>{console.error(e);process.exitCode=1;});child.on('exit',code=>{console.log('Electron exited '+code);process.exitCode=code===0?0:1;});
}
async function host() {
  const {app,BrowserWindow,nativeImage}=require('electron'),config=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
  app.setPath('userData',path.join(config.runtime,'user-data'));app.commandLine.appendSwitch('force-device-scale-factor','1');
  const report={config,ok:false,renderOk:false,transportClean:false,captures:[],exceptions:[],console:[],networkRequests:[],networkFailures:[],httpErrors:[],stageHistory:[],versions:process.versions};
  const write=()=>fs.writeFileSync(path.join(config.output,'look-report.json'),JSON.stringify(report,null,2));
  const stage=s=>{report.stage=s;report.stageHistory.push({stage:s,wallTimeMs:Date.now()});write();};let win,server,timeout,timedOut=false;
  const deadline=new Promise((_,reject)=>{timeout=setTimeout(()=>{timedOut=true;reject(new Error('Timeout at '+report.stage));},config.timeoutMs);});
  let evaluate;
  try { await Promise.race([(async()=>{
    stage('bootstrap');await app.whenReady();stage('app-ready');server=createStaticServer(fixture);await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    win=new BrowserWindow({width:1440,height:900,useContentSize:true,show:true,autoHideMenuBar:true,title:'C9 look diagnosis diagnosis',webPreferences:{sandbox:true,nodeIntegration:false,contextIsolation:true,backgroundThrottling:false}});
    await win.loadURL('about:blank');win.webContents.debugger.attach('1.3');
    const cdp=(method,args)=>win.webContents.debugger.sendCommand(method,args);
    evaluate=code=>{if(timedOut)throw new Error('Deadline elapsed');return win.webContents.executeJavaScript(code,true);};
    const requests=new Map();win.webContents.on('console-message',(_e,level,message,line,sourceId)=>{if(level>=2)report.console.push({stage:report.stage,level,message,line,sourceId});});
    win.webContents.debugger.on('message',(_e,method,p)=>{
      if(method==='Runtime.exceptionThrown')report.exceptions.push({stage:report.stage,...p});
      if(method==='Network.requestWillBeSent'){
        const row={requestId:p.requestId,url:p.request.url,type:p.type,loaderId:p.loaderId,request:{stage:report.stage,timestamp:p.timestamp,wallTime:p.wallTime,initiator:p.initiator},events:[]};requests.set(p.requestId,row);report.networkRequests.push(row);
        if(p.type==='Document')report.documentClockAnchor={requestId:p.requestId,timestamp:p.timestamp,wallTime:p.wallTime,url:p.request.url};
      }
      const row=requests.get(p.requestId);
      if(method==='Network.responseReceived'){
        if(row)row.response={stage:report.stage,timestamp:p.timestamp,status:p.response.status,mimeType:p.response.mimeType,fromDiskCache:p.response.fromDiskCache};
        if(p.response.status>=400)report.httpErrors.push({requestId:p.requestId,stage:report.stage,url:p.response.url,status:p.response.status});
      }
      if(method==='Network.loadingFinished'&&row)row.events.push({kind:'finished',stage:report.stage,...p});
      if(method==='Network.loadingFailed'){if(row)row.events.push({kind:'failed',stage:report.stage,...p});report.networkFailures.push({stage:report.stage,url:row?.url,...p});}
    });
    await cdp('Page.enable');await cdp('Runtime.enable');await cdp('Network.enable');
    await cdp('Page.addScriptToEvaluateOnNewDocument',{source:'('+installGate.toString()+')()'});
    stage('loading');await win.loadURL('http://127.0.0.1:'+server.address().port+'/');
    while(!await evaluate('window.worldBase?.ready===true')){const errors=await evaluate('window.worldBase?.errors||[]');if(errors.length)throw new Error(errors.join('\n'));await pause(100);}
    stage('freezing');report.pageClock=await evaluate('({timeOrigin:performance.timeOrigin,now:performance.now()})');report.initial=await evaluate('('+prepare.toString()+')('+JSON.stringify(config.legacyCamera)+')');write();
    for(const view of report.initial.views){
      await evaluate('window.__c9Probe.selectView('+JSON.stringify(view)+')');
      for(const ao of [.55,0]){await evaluate('window.__c9Probe.setAO('+ao+')');
        for(const pass of ['warmup','capture-1','capture-2']){
          const name=view.name+'-ao-'+(ao===0?'off':'on')+'-'+pass;stage(name);const shot=await evaluate('window.__c9Probe.capture()');const png=Buffer.from(shot.png.split(',')[1],'base64'),im=nativeImage.createFromBuffer(png);delete shot.png;
          if(im.isEmpty()||im.getSize().width!==1440||im.getSize().height!==900||shot.render.calls<=0||shot.time!==14||shot.renderer.glError!==0||shot.uploadedAO!==ao||!shot.materialsUnchanged)throw new Error('Invalid C9 frozen render');
          fs.writeFileSync(path.join(config.output,name+'.png'),png);fs.writeFileSync(path.join(config.output,name+'.jpg'),im.resize({width:960}).toJPEG(88));report.captures.push({name,view,pass,...shot,pngSha256:hash(png)});write();
        }
      }
      await evaluate('window.__c9Probe.setAO(.55)');
    }
    await pause(3000);report.renderOk=!report.exceptions.length&&report.captures.length===42&&report.captures.every(c=>!c.errors.length);

  })(),deadline]); }catch(e){report.failure=e.stack||String(e);write();console.error(e);}
  finally {clearTimeout(timeout);if(win&&!win.isDestroyed()){try{report.restore=await Promise.race([win.webContents.executeJavaScript('window.__c9Probe?.restore()'),pause(3000).then(()=>{throw new Error('Restore timeout');})]);}catch(e){report.restoreFailure=String(e);}win.destroy();}server?.close();
    const original=JSON.parse(fs.readFileSync(path.join(config.output,'source-manifest.json'),'utf8')),current=sceneFiles();
    report.changedSourceFiles=[...new Set([...Object.keys(original.files),...Object.keys(current)])].filter(k=>original.files[k]!==current[k]);
    report.sourceUnchanged=!report.changedSourceFiles.length;report.driverUnchanged=hash(fs.readFileSync(__filename))===config.driverSha256;
    report.headAfter=readHead();
    const assetManifest=JSON.parse(fs.readFileSync(path.join(config.output,'prop-assets-manifest.json'),'utf8'));report.assetFiles=assetManifest.files.length;report.assetsUnchanged=assetManifest.files.every(f=>hash(fs.readFileSync(path.join(fixture,f.path)))===f.sha256);
    report.transportClean=!report.networkFailures.length&&!report.httpErrors.length;
    report.ok=report.renderOk&&report.transportClean&&report.assetsUnchanged&&report.sourceUnchanged&&report.driverUnchanged&&report.headAfter===original.head&&!report.failure&&!report.restoreFailure;
    report.stage='complete';report.completedAt=new Date().toISOString();write();app.exit(report.ok?0:1);
  }
}
const direct=require.main===module||(process.versions.electron&&process.argv[1]&&path.resolve(process.argv[1])===__filename);
if(direct){if(process.versions.electron)host().catch(e=>{console.error(e);require('electron').app.exit(1);});else{try{launch();}catch(e){console.error(e);process.exitCode=1;}}}
