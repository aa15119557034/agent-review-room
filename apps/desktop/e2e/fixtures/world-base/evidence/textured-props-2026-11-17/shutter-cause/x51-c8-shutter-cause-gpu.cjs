// Read-only scene diagnosis. Lives outside the fixture; does not change its source.
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process'), crypto = require('node:crypto');
const fixture = 'D:/codex/2026-11-16/world-implementation/world-base/apps/desktop/e2e/fixtures/world-base';
const {createStaticServer, cleanEnvironment} = require(path.join(fixture, 'scripts/baseline.cjs'));
const {installGate} = require(path.join(fixture, 'scripts/diagnose-surface.cjs'));
const {sceneFiles} = require(path.join(fixture, 'scripts/diagnose-wet-road.cjs'));
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function prepare(){
 const THREE=await import('three'),w=window.worldBase,s=w.station,gate=window.__surfaceGate,pipe=w.look.pipeline;
 const saved={camera:w.camera.clone(),view:w.currentView,walking:w.walker.enabled,time:w.island.U.uTime.value,stationTime:s.ctx.time,hidden:document.body.classList.contains('hide-ui'),ui:[...document.querySelectorAll('[data-view],#walk,#mode,#camera')].map(e=>({e,text:e.textContent,className:e.className}))};
 gate.freeze();w.walker.setEnabled(false);document.body.classList.add('hide-ui');
 const meshes=[];s.root.traverse(o=>{if(o.isMesh&&!Array.isArray(o.material)&&o.material.name==='tool-shed-worn-shutter')meshes.push(o)});if(!meshes.length)throw new Error('Missing live shutter');
 const originals=meshes.map(mesh=>({mesh,material:mesh.material,receiveShadow:mesh.receiveShadow,after:mesh.onAfterRender})),materials=[...new Set(originals.map(o=>o.material))],normalMaps=new Map(materials.map(m=>[m,m.normalMap])),temporary=[];
 const restoreMaterials=()=>{for(const o of originals){o.mesh.material=o.material;o.mesh.receiveShadow=o.receiveShadow;}for(const [m,map]of normalMaps)if(m.normalMap!==map){m.normalMap=map;m.needsUpdate=true;}};
 let gpuDraws=[];
 const vec=v=>ArrayBuffer.isView(v)?Array.from(v):v;
 for(const o of originals)o.mesh.onAfterRender=function(...args){o.after.apply(this,args);const gl=w.renderer.getContext(),program=gl.getParameter(gl.CURRENT_PROGRAM),names=['diffuse','opacity','normalScale','normalMatrix','modelMatrix','modelViewMatrix','viewMatrix','ambientLightColor','receiveShadow','directionalLights[0].direction','directionalLights[0].color','hemisphereLights[0].direction','hemisphereLights[0].skyColor','hemisphereLights[0].groundColor'];const uniforms={};for(const key of names){const location=gl.getUniformLocation(program,key);uniforms[key]=location===null?null:vec(gl.getUniform(program,location));}gpuDraws.push({mesh:this.uuid,material:this.material.uuid,type:this.material.type,uniforms});};
 const mapInfo=t=>t?{uuid:t.uuid,channel:t.channel,colorSpace:t.colorSpace,repeat:t.repeat.toArray(),flipY:t.flipY,url:t.image?.currentSrc||t.image?.src||null}:null;
 const material=m=>({uuid:m.uuid,type:m.type,name:m.name,colorRGB:m.color.toArray(),vertexColors:m.vertexColors,side:m.side,opacity:m.opacity,transparent:m.transparent,metalness:m.metalness,roughness:m.roughness,normalScale:m.normalScale?.toArray(),aoMapIntensity:m.aoMapIntensity,map:mapInfo(m.map),normalMap:mapInfo(m.normalMap),aoMap:mapInfo(m.aoMap),metalnessMap:mapInfo(m.metalnessMap),clippingPlanes:m.clippingPlanes?.map(p=>({normal:p.normal.toArray(),constant:p.constant})),envMap:!!m.envMap});
 const lights=()=>{const list=[];w.scene.traverse(o=>{if(o.isLight){const position=o.getWorldPosition(new THREE.Vector3()),target=o.target?.getWorldPosition(new THREE.Vector3());list.push({type:o.type,color:o.color.toArray(),groundColor:o.groundColor?.toArray(),intensity:o.intensity,position:position.toArray(),target:target?.toArray(),targetToLight:target?position.clone().sub(target).normalize().toArray():null,shadowSize:o.shadow?.mapSize.toArray()});}});return list;};
 const bounds=o=>{const b=new THREE.Box3().setFromObject(o);return{min:b.min.toArray(),max:b.max.toArray(),size:b.getSize(new THREE.Vector3()).toArray()}};
 const geometry=mesh=>{const g=mesh.geometry,n=g.attributes.normal,uv=g.attributes.uv;const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity],unique=new Set();for(let i=0;i<n.count;i++){const v=[n.getX(i),n.getY(i),n.getZ(i)];unique.add(v.map(x=>Math.round(x*1e6)/1e6).join(','));for(let k=0;k<3;k++){min[k]=Math.min(min[k],v[k]);max[k]=Math.max(max[k],v[k]);}}return{geometry:g.uuid,vertices:g.attributes.position.count,triangles:(g.index?.count||g.attributes.position.count)/3,normal:{count:n.count,min,max,unique:[...unique]},uvCount:uv?.count,bounds:bounds(mesh),matrixWorld:mesh.matrixWorld.toArray()};};
 const setCamera=(position,target)=>{w.camera.fov=55;w.camera.updateProjectionMatrix();w.camera.position.copy(s.toWorld(new THREE.Vector3(...position)));w.camera.lookAt(s.toWorld(new THREE.Vector3(...target)));w.camera.updateMatrixWorld();};
 const originalView=w.views.find(v=>v.name==='service-corner');
 const shop=w.city.placements.find(p=>p.name==='town-apartment-4f'),supportY=shop.baseY+.02;
 const cases=[{name:'00-original',kind:'original'},{name:'01-normal-off',kind:'normal-off'},{name:'02-restored-normal',kind:'original'},{name:'03-shadow-off',kind:'shadow-off'},{name:'04-restored-shadow',kind:'original'},{name:'05-basic-map-only',kind:'basic'},{name:'06-restored-basic',kind:'original'},
  {name:'07-service-candidate',kind:'original',candidate:true,position:[28.4,s.ctx.L.heightAt(28.4,-27.1)+.012+1.6,-27.1],target:[25,.85,-28.7]},
  {name:'08-laundry-candidate',kind:'original',candidate:true,position:[8,supportY+1.6,-122.1],target:[5.15,supportY+.36,-122.7]}];
 const api=window.__shutterProbe={
  select(c){restoreMaterials();w.setView('service-corner');if(c.candidate)setCamera(c.position,c.target);if(c.kind==='normal-off')for(const m of materials){m.normalMap=null;m.needsUpdate=true;}if(c.kind==='shadow-off')for(const o of originals)o.mesh.receiveShadow=false;if(c.kind==='basic'){const clones=new Map();for(const o of originals){let m=clones.get(o.material);if(!m){m=new THREE.MeshBasicMaterial({name:'DIAGNOSTIC-map-only',map:o.material.map,color:o.material.color.clone(),side:o.material.side,opacity:o.material.opacity,transparent:o.material.transparent,clippingPlanes:o.material.clippingPlanes,clipShadows:o.material.clipShadows});clones.set(o.material,m);temporary.push(m);}o.mesh.material=m;}}
    s.update(0,14,w.walker.worldPosition);w.island.update(0,14);w.island.U.uTime.value=14;pipe.hasPrev=false;},
  capture(){gpuDraws=[];w.renderer.info.reset();w.look.render(w.scene,0);const gl=w.renderer.getContext(),ext=gl.getExtension('WEBGL_debug_renderer_info');return{png:w.renderer.domElement.toDataURL('image/png'),camera:{position:w.camera.position.toArray(),quaternion:w.camera.quaternion.toArray(),fov:w.camera.fov,near:w.camera.near,far:w.camera.far},time:w.island.U.uTime.value,lookParams:{...pipe.params},ao:pipe.finalMat.uniforms.uAO.value,toon:pipe.finalMat.uniforms.uToon.value,lights:lights(),shutters:originals.map(o=>({geometry:geometry(o.mesh),material:material(o.mesh.material),receiveShadow:o.mesh.receiveShadow})),gpuUniformsAfterDraw:gpuDraws,render:{...w.renderer.info.render},renderer:{name:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),glError:gl.getError()},errors:[...w.errors]};},
  restore(){restoreMaterials();for(const o of originals)o.mesh.onAfterRender=o.after;for(const m of temporary)m.dispose();w.setView(saved.view);w.walker.setEnabled(saved.walking);w.camera.copy(saved.camera);w.camera.updateMatrixWorld();s.update(0,saved.stationTime,w.walker.worldPosition);w.island.update(0,saved.time);w.island.U.uTime.value=saved.time;document.body.classList.toggle('hide-ui',saved.hidden);for(const e of saved.ui){e.e.className=e.className;e.e.textContent=e.text;}pipe.hasPrev=false;gate.resume();return{restored:true,materials:originals.every(o=>o.mesh.material===o.material&&o.mesh.receiveShadow===o.receiveShadow&&o.mesh.onAfterRender===o.after),normalMaps:materials.every(m=>m.normalMap===normalMaps.get(m)),temporaryMaterialsDisposed:temporary.length,view:w.currentView,fov:w.camera.fov,time:w.island.U.uTime.value,frozen:gate.frozen};}
 };
 return{cases,originalView,originalMaterials:materials.map(material),originalLights:lights(),originalGeometry:meshes.map(geometry),method:'One cause sequence at service-corner/time14, same lights/post/quality. Each state warmup+two retained renders, explicit original restores. Basic material diagnostic only, original color/map/side/clipping/opacity retained. Two runtime-only camera candidates; source presets unchanged. Actual GL uniforms queried in shutter onAfterRender; null means absent/optimized, no inferred value.'};
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
  const name=process.argv[2]||'gpu-shutter-c8-cause';
  if(!/^gpu-shutter-c8-cause(?:-[a-z0-9]+)*$/.test(name))throw new Error('Expected a new props integration directory name');
  const output=path.join(fixture,'artifacts',name);
  if(fs.existsSync(output))throw new Error('Output exists; preserve evidence');
  fs.mkdirSync(output,{recursive:true});
  const config={fixture,output,runtime:fs.mkdtempSync(path.join(output,'runtime-')),startedAt:new Date().toISOString(),timeoutMs:120000};
  const head=readHead();
  const assets=require(path.join(fixture,'scripts/prepare-props.cjs')).verifyPreparedAssets(fixture);if(assets.files.length!==9)throw new Error('Expected the nine pinned prop files');
  fs.writeFileSync(path.join(output,'prop-assets-manifest.json'),JSON.stringify(assets,null,2));
  const manifest={head,capturedAt:config.startedAt,files:sceneFiles()};
  fs.writeFileSync(path.join(output,'source-manifest.json'),JSON.stringify(manifest,null,2));
  config.driverSha256=hash(fs.readFileSync(__filename));
  const file=path.join(config.runtime,'config.json');fs.writeFileSync(file,JSON.stringify(config,null,2));
  fs.writeFileSync(path.join(output,'run-config.json'),JSON.stringify(config,null,2));
  const log=fs.openSync(path.join(output,'electron.log'),'w');
  const child=cp.spawn('D:/codex/2026-11-16/world-implementation/runtime-path-probe/electron.exe',[__filename,file],{cwd:fixture,windowsHide:true,env:cleanEnvironment(config.runtime),stdio:['ignore',log,log]});fs.closeSync(log);
  child.on('spawn',()=>{fs.writeFileSync(path.join(output,'process.json'),JSON.stringify({pid:child.pid}));console.log('Shutter cause PID '+child.pid+'; '+output);});
  child.on('error',e=>{console.error(e);process.exitCode=1;});child.on('exit',code=>{console.log('Electron exited '+code);process.exitCode=code===0?0:1;});
}
async function host() {
  const {app,BrowserWindow,nativeImage}=require('electron'),config=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
  app.setPath('userData',path.join(config.runtime,'user-data'));app.commandLine.appendSwitch('force-device-scale-factor','1');
  const report={config,ok:false,renderOk:false,transportClean:false,captures:[],exceptions:[],console:[],networkRequests:[],networkFailures:[],httpErrors:[],stageHistory:[],versions:process.versions};
  const write=()=>fs.writeFileSync(path.join(config.output,'shutter-report.json'),JSON.stringify(report,null,2));
  const stage=s=>{report.stage=s;report.stageHistory.push({stage:s,wallTimeMs:Date.now()});write();};let win,server,timeout,timedOut=false;
  const deadline=new Promise((_,reject)=>{timeout=setTimeout(()=>{timedOut=true;reject(new Error('Timeout at '+report.stage));},config.timeoutMs);});
  let evaluate;
  try { await Promise.race([(async()=>{
    stage('bootstrap');await app.whenReady();stage('app-ready');server=createStaticServer(fixture);await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    win=new BrowserWindow({width:1440,height:900,useContentSize:true,show:true,autoHideMenuBar:true,title:'Shutter cause diagnosis',webPreferences:{sandbox:true,nodeIntegration:false,contextIsolation:true,backgroundThrottling:false}});
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
    stage('freezing');report.pageClock=await evaluate('({timeOrigin:performance.timeOrigin,now:performance.now()})');report.initial=await evaluate('('+prepare.toString()+')()');write();
    for(const item of report.initial.cases){
      await evaluate('window.__shutterProbe.select('+JSON.stringify(item)+')');
      for(const pass of ['warmup','capture-1','capture-2']){
        const name=item.name+'-'+pass;stage(name);const shot=await evaluate('window.__shutterProbe.capture()');const png=Buffer.from(shot.png.split(',')[1],'base64'),im=nativeImage.createFromBuffer(png);delete shot.png;
        if(im.isEmpty()||im.getSize().width!==1440||im.getSize().height!==900||shot.render.calls<=0||shot.time!==14||shot.renderer.glError!==0)throw new Error('Invalid cause render');
        fs.writeFileSync(path.join(config.output,name+'.png'),png);fs.writeFileSync(path.join(config.output,name+'.jpg'),im.resize({width:960}).toJPEG(88));report.captures.push({name,case:item,pass,...shot,pngSha256:hash(png)});write();
      }
    }
    await pause(3000);report.renderOk=!report.exceptions.length&&report.captures.length===27&&report.captures.every(c=>!c.errors.length);

  })(),deadline]); }catch(e){report.failure=e.stack||String(e);write();console.error(e);}
  finally {clearTimeout(timeout);if(win&&!win.isDestroyed()){try{report.restore=await Promise.race([win.webContents.executeJavaScript('window.__shutterProbe?.restore()'),pause(3000).then(()=>{throw new Error('Restore timeout');})]);}catch(e){report.restoreFailure=String(e);}win.destroy();}server?.close();
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
