// Read-only scene diagnosis. Lives outside the fixture; does not change its source.
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process'), crypto = require('node:crypto');
const referenceFixture = 'D:/codex/2026-11-16/world-implementation/world-base/apps/desktop/e2e/fixtures/world-base';
const fixture = process.versions.electron ? JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).fixture : path.resolve(process.argv[4] || referenceFixture);
const {createStaticServer, cleanEnvironment} = require(path.join(fixture, 'scripts/baseline.cjs'));
const {installGate} = require(path.join(fixture, 'scripts/diagnose-surface.cjs'));
const {sceneFiles} = require(path.join(fixture, 'scripts/diagnose-wet-road.cjs'));
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function prepare(referenceCameras){
 const THREE=await import('three'),w=window.worldBase,s=w.station,p=w.look.pipeline,gate=window.__surfaceGate;
 const ui=[...document.querySelectorAll('[data-view],#walk,#mode,#camera')];
 function state(){return{camera:{position:w.camera.position.toArray(),quaternion:w.camera.quaternion.toArray(),fov:w.camera.fov},view:w.currentView,walking:w.walker.enabled,time:w.island.U.uTime.value,stationTime:s.ctx.time,hidden:document.body.classList.contains('hide-ui'),params:{...p.params},ao:p.finalMat.uniforms.uAO.value,toon:p.finalMat.uniforms.uToon.value,ui:ui.map(e=>({text:e.textContent,className:e.className}))};}
 const saved=state(),savedCamera=w.camera.clone();gate.freeze();w.walker.setEnabled(false);document.body.classList.add('hide-ui');
 if(saved.ao!==.55||p.params.blur!==0||p.params.rays!==0)throw new Error('Expected default AO .55 with blur/rays off');
 let currentView;
 function lights(){const rows=[];w.scene.traverse(o=>{if(o.isLight)rows.push({type:o.type,name:o.name,color:o.color.toArray(),groundColor:o.groundColor?.toArray(),intensity:o.intensity,position:o.getWorldPosition(new THREE.Vector3()).toArray(),target:o.target?.getWorldPosition(new THREE.Vector3()).toArray(),castShadow:o.castShadow,shadow:o.shadow?{mapSize:o.shadow.mapSize.toArray(),bias:o.shadow.bias,normalBias:o.shadow.normalBias,camera:{near:o.shadow.camera.near,far:o.shadow.camera.far,left:o.shadow.camera.left,right:o.shadow.camera.right,top:o.shadow.camera.top,bottom:o.shadow.camera.bottom}}:null});});return rows;}
 function leafMaterials(){const map=new Map();w.city.root.traverse(o=>{if(o.isMesh)for(const m of Array.isArray(o.material)?o.material:[o.material])if(m.userData.townLeaf){if(!map.has(m))map.set(m,[]);map.get(m).push(o);}});return map;}
 function leafState(){return [...leafMaterials()].map(([m,objects])=>({uuid:m.uuid,name:m.name,type:m.type,value:m.userData.townLeaf.value.toArray(),meshCount:objects.length,triangles:objects.reduce((sum,o)=>sum+(o.geometry.index?o.geometry.index.count:o.geometry.attributes.position.count)/3*(o.isInstancedMesh?o.count:1),0),key:m.customProgramCacheKey(),hook:m.onBeforeCompile.toString()}));}
 const readDuskState=()=>{const u=w.island.U, sunDirection=u.uSunDir.value.clone().normalize();return {preset:w.island.timeOfDay, lightMapURL:w.island.terrain.lightTex.image.currentSrc||w.island.terrain.lightTex.image.src, dimensions:[w.island.terrain.lightTex.image.width,w.island.terrain.lightTex.image.height], sunDirection:sunDirection.toArray(),bloom:p.params.bloom,glow:w.eveningGlow, towns:w.island.town.towns.filter(t=>t.shadow).map(t=>{const cam=t.shadow.cam;const shadowToSun=cam.getWorldDirection(new THREE.Vector3()).negate();return {id:t.id,mapSize:[t.shadow.rt.width,t.shadow.rt.height],shadowToSun:shadowToSun.toArray(),dotWithEveningSun:shadowToSun.dot(sunDirection)};}),townShadowParams:u.uTownShP.value.toArray()};};
 const originalLeaf=leafState();
 window.__modernProbe={
 selectView(name){const c=referenceCameras[name];if(!c)throw new Error('Missing reference camera '+name);if(w.views.some(v=>v.name===name))w.setView(name);w.camera.position.fromArray(c.position);w.camera.quaternion.fromArray(c.quaternion);w.camera.fov=c.fov;w.camera.updateProjectionMatrix();w.camera.updateMatrixWorld();s.update(0,14,w.walker.worldPosition);w.island.update(0,14);w.island.U.uTime.value=14;p.hasPrev=false;currentView=name;},
 capture(){w.renderer.info.reset();w.look.render(w.scene,0);const gl=w.renderer.getContext(),ext=gl.getExtension('WEBGL_debug_renderer_info');return{png:w.renderer.domElement.toDataURL('image/png'),view:currentView,duskAudit:readDuskState(),camera:state().camera,time:w.island.U.uTime.value,stationTime:s.ctx.time,ao:p.finalMat.uniforms.uAO.value,toon:p.finalMat.uniforms.uToon.value,params:{...p.params},hudHidden:document.body.classList.contains('hide-ui'),lights:lights(),leaf:leafState(),render:{...w.renderer.info.render},renderCounterScope:'renderer.info last pass; not all-pass performance',renderer:{glError:gl.getError(),memory:{...w.renderer.info.memory},programs:w.renderer.info.programs.length},gpu:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),errors:[...w.errors]};},
 auditAerial(){
  const camera=w.camera, frustum=new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse));
  const focal=900/(2*Math.tan(THREE.MathUtils.degToRad(camera.fov/2))), rows=[];
  const roots=[['station',s.root],['city',w.city.root],['skyline',w.skyline?.root],['island',w.island.root]].filter(x=>x[1]);
  w.scene.traverseVisible(object=>{
   if(!object.isMesh||!object.geometry?.attributes.position)return;
   const geometry=object.geometry;if(!geometry.boundingSphere)geometry.computeBoundingSphere();
   const sphere=geometry.boundingSphere.clone().applyMatrix4(object.matrixWorld), viewCenter=sphere.center.clone().applyMatrix4(camera.matrixWorldInverse);
   let owner='other';for(const [name,root] of roots){let parent=object;while(parent&&parent!==root)parent=parent.parent;if(parent===root){owner=name;break;}}
   rows.push({owner,name:object.name,type:object.type,geometryType:geometry.type,materials:(Array.isArray(object.material)?object.material:[object.material]).map(m=>({name:m.name,type:m.type,visible:m.visible,transparent:m.transparent})),triangles:(geometry.index?.count??geometry.attributes.position.count)/3*(object.isInstancedMesh?object.count:1),instances:object.isInstancedMesh?object.count:1,castShadow:object.castShadow,frustumCulled:object.frustumCulled,intersectsFrustum:frustum.intersectsSphere(sphere),radius:sphere.radius,center:sphere.center.toArray(),viewDepth:-viewCenter.z,projectedDiameterPx:-viewCenter.z>0?2*focal*sphere.radius/(-viewCenter.z):null});
  });
  return{camera:state().camera,method:'Visible-parent traversal; geometry bounding spheres transformed to world, frustum sphere test and perspective diameter estimate. InstancedMesh geometry bounds omit per-instance distribution; these estimates are not exact raster footprint or measured GPU timing.',rows};
 },
 auditLeaf(){const gl=w.renderer.getContext();return [...leafMaterials()].map(([m])=>{const programs=[];for(const prog of w.renderer.properties.get(m).programs?.values()||[]){const active=gl.getProgramParameter(prog.program,gl.ACTIVE_UNIFORMS),uniforms={};for(let i=0;i<active;i++){const info=gl.getActiveUniform(prog.program,i);if(/uTownLeaf/.test(info.name)){const v=gl.getUniform(prog.program,gl.getUniformLocation(prog.program,info.name));uniforms[info.name]=ArrayBuffer.isView(v)?Array.from(v):v;}}programs.push({id:prog.id,linked:gl.getProgramParameter(prog.program,gl.LINK_STATUS),vertexCompiled:gl.getShaderParameter(prog.vertexShader,gl.COMPILE_STATUS),fragmentCompiled:gl.getShaderParameter(prog.fragmentShader,gl.COMPILE_STATUS),vertexShaderSource:gl.getShaderSource(prog.vertexShader),fragmentShaderSource:gl.getShaderSource(prog.fragmentShader),uploaded:uniforms});}return{material:leafState().find(x=>x.uuid===m.uuid),programs};});},
 restore(){w.setView(saved.view);w.walker.setEnabled(saved.walking);w.camera.copy(savedCamera);w.camera.updateMatrixWorld();s.update(0,saved.stationTime,w.walker.worldPosition);w.island.update(0,saved.time);w.island.U.uTime.value=saved.time;document.body.classList.toggle('hide-ui',saved.hidden);ui.forEach((e,i)=>{e.textContent=saved.ui[i].text;e.className=saved.ui[i].className;});p.hasPrev=false;gate.resume();return{state:state(),leafUnchanged:JSON.stringify(originalLeaf)===JSON.stringify(leafState()),frozen:gate.frozen};}
 };
 return{restoreTarget:saved,views:Object.keys(referenceCameras),lights:lights(),leaf:originalLeaf,cityStats:w.city.stats,streetscapeStats:s.streetscape.stats,method:'Seven saved C17 world cameras plus the original C18 aerial camera, fixed time14/default AO .55/HUD hidden, one warmup plus two fresh render PNGs per view. Read-only leaf shader audit. No performance probe, no material/light/quality toggle; historical C17 images provide hedge comparison. Runtime updates choose current camera LOD once before each sequence. No full-frame equality assumed across revisions.'};
}
function readHead() {
  let root=fixture;while(!fs.existsSync(path.join(root,'.git'))){const parent=path.dirname(root);if(parent===root)throw new Error('Missing worktree metadata');root=parent;}
  const dot=path.join(root,'.git'),dir=fs.statSync(dot).isDirectory()?dot:path.resolve(root,fs.readFileSync(dot,'utf8').trim().replace(/^gitdir: /,''));
  const value=fs.readFileSync(path.join(dir,'HEAD'),'utf8').trim();if(!value.startsWith('ref: '))return value;
  const ref=value.slice(5),common=fs.existsSync(path.join(dir,'commondir'))?path.resolve(dir,fs.readFileSync(path.join(dir,'commondir'),'utf8').trim()):dir;
  for(const base of [dir,common]){const p=path.join(base,ref);if(fs.existsSync(p))return fs.readFileSync(p,'utf8').trim();}
  const packed=fs.readFileSync(path.join(common,'packed-refs'),'utf8').split(/\r?\n/).find(l=>l.endsWith(' '+ref));if(!packed)throw new Error('Missing ref '+ref);return packed.split(' ')[0];
}

function launch(){
 const name=process.argv[2],expectedHead=process.argv[3];if(!/^gpu-modern-(before|after)-[a-z0-9-]+$/.test(name||'')||!/^[a-f0-9]{40}$/.test(expectedHead||''))throw new Error('Usage: node x51-modernization-capture-gpu.cjs gpu-modern-before|after-<label> <exactHEAD>');
 if(readHead()!==expectedHead)throw new Error('Exact source HEAD mismatch');
 const output=path.join(fixture,'artifacts',name);if(fs.existsSync(output))throw new Error('Output exists; preserve evidence');fs.mkdirSync(output,{recursive:true});
 const config={fixture,output,runtime:fs.mkdtempSync(path.join(output,'runtime-')),startedAt:new Date().toISOString(),timeoutMs:180000,expectedHead,responsibility:'Read-only capture: no runtime source, material, light, quality or geometry edits. Source author changes are identified by exact head+file manifest.'};
 const assets=require(path.join(fixture,'scripts/prepare-props.cjs')).verifyPreparedAssets(fixture);if(assets.files.length!==9)throw new Error('Expected nine actual pinned prop files');fs.writeFileSync(path.join(output,'prop-assets-manifest.json'),JSON.stringify(assets,null,2));
 const manifest={head:expectedHead,capturedAt:config.startedAt,files:sceneFiles()};manifest.srcFileCount=Object.keys(manifest.files).filter(x=>x.startsWith('src/')).length;fs.writeFileSync(path.join(output,'source-manifest.json'),JSON.stringify(manifest,null,2));
 const referencePath=path.join(referenceFixture,'artifacts/gpu-look-c17-v1/look-report.json'),r=JSON.parse(fs.readFileSync(referencePath));if(r.headAfter!=='0184c79d94094c7d76378302592572bf367be6c7'||r.stage!=='complete'||r.captures.length!==21)throw new Error('Expected frozen completed C17 reference');
 config.referenceCameras=Object.fromEntries(r.captures.filter(x=>x.pass==='capture-2').map(x=>[typeof x.view==='string'?x.view:x.view.name,x.camera]));if(Object.keys(config.referenceCameras).length!==7)throw new Error('Expected seven reference cameras');config.reference={path:referencePath,sha256:hash(fs.readFileSync(referencePath)),head:r.headAfter};
 config.referenceCameras['island-aerial']={"position":[2100,2350,2450],"quaternion":[-0.27043683246052963,0.3343071089193487,0.10076912073943207,0.8971890886987558],"fov":58};
 config.aerialReference={source:'C18 src/main.js fixed island-aerial view; quaternion calculated using pinned Three r187 lookAt',head:'56e4990b0218cfd6ce84d7bda9122a3802df5f92',position:[2100,2350,2450],target:[-150,70,-150],fov:58};
 if(process.argv[5] && process.argv[5]!=='aerial-only')throw new Error('Only optional selection is aerial-only');
 if(process.argv[5]==='aerial-only')config.referenceCameras={'island-aerial':config.referenceCameras['island-aerial']};
 fs.writeFileSync(path.join(output,'c17-reference.json'),JSON.stringify({reference:config.reference,cameras:config.referenceCameras},null,2));config.driverSha256=hash(fs.readFileSync(__filename));const file=path.join(config.runtime,'config.json');fs.writeFileSync(file,JSON.stringify(config,null,2));fs.writeFileSync(path.join(output,'run-config.json'),JSON.stringify(config,null,2));
 const log=fs.openSync(path.join(output,'electron.log'),'w');const child=cp.spawn('D:/codex/2026-11-16/world-implementation/runtime-path-probe/electron.exe',[__filename,file],{cwd:fixture,windowsHide:true,env:cleanEnvironment(config.runtime),stdio:['ignore',log,log]});fs.closeSync(log);child.on('spawn',()=>{fs.writeFileSync(path.join(output,'process.json'),JSON.stringify({pid:child.pid}));console.log('Capture PID '+child.pid+'; '+output);});child.on('error',e=>{console.error(e);process.exitCode=1;});child.on('exit',(code,signal)=>{fs.writeFileSync(path.join(output,'process-exit.json'),JSON.stringify({code,signal,completedAt:new Date().toISOString()}));console.log('Electron exited '+code);process.exitCode=code===0?0:1;});
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
    win=new BrowserWindow({width:1440,height:900,useContentSize:true,show:true,autoHideMenuBar:true,title:'Modernization fixed reference capture',webPreferences:{sandbox:true,nodeIntegration:false,contextIsolation:true,backgroundThrottling:false}});
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
    stage('freezing');report.pageClock=await evaluate('({timeOrigin:performance.timeOrigin,now:performance.now()})');report.initial=await evaluate('('+prepare.toString()+')('+JSON.stringify(config.referenceCameras)+')');report.restoreTargetSha256=hash(JSON.stringify(report.initial.restoreTarget));write();
    for(const view of report.initial.views){
      await evaluate('window.__modernProbe.selectView('+JSON.stringify(view)+')');
      for(const pass of ['warmup','capture-1','capture-2']){const name=view+'-ao-on-'+pass;stage(name);const shot=await evaluate('window.__modernProbe.capture()');const png=Buffer.from(shot.png.split(',')[1],'base64'),im=nativeImage.createFromBuffer(png);delete shot.png;
        if(im.isEmpty()||im.getSize().width!==1440||im.getSize().height!==900||shot.render.calls<=0||shot.time!==14||shot.ao!==.55||shot.renderer.glError!==0||!shot.hudHidden)throw new Error('Invalid frozen capture');fs.writeFileSync(path.join(config.output,name+'.png'),png);fs.writeFileSync(path.join(config.output,name+'.jpg'),im.resize({width:960}).toJPEG(88));report.captures.push({name,pass,...shot,pngSha256:hash(png)});write();}
    }
    if(report.initial.views.includes('island-aerial')){
      await evaluate('window.__modernProbe.selectView("island-aerial")');
      report.aerialAudit=await evaluate('window.__modernProbe.auditAerial()');
      fs.writeFileSync(path.join(config.output,'aerial-geometry-audit.json'),JSON.stringify(report.aerialAudit,null,2));
    }
    report.leafAudit=await evaluate('window.__modernProbe.auditLeaf()');fs.writeFileSync(path.join(config.output,'leaf-material-audit.json'),JSON.stringify(report.leafAudit,null,2));
    await pause(3000);report.renderOk=!report.exceptions.length&&report.captures.length===3*Object.keys(config.referenceCameras).length&&report.captures.every(c=>!c.errors.length);

  })(),deadline]); }catch(e){report.failure=e.stack||String(e);write();console.error(e);}
  finally {clearTimeout(timeout);if(win&&!win.isDestroyed()){try{report.restore=await Promise.race([win.webContents.executeJavaScript('window.__modernProbe?.restore()'),pause(3000).then(()=>{throw new Error('Restore timeout');})]);}catch(e){report.restoreFailure=String(e);}win.destroy();}server?.close();
    const original=JSON.parse(fs.readFileSync(path.join(config.output,'source-manifest.json'),'utf8')),current=sceneFiles();
    report.changedSourceFiles=[...new Set([...Object.keys(original.files),...Object.keys(current)])].filter(k=>original.files[k]!==current[k]);
    report.sourceUnchanged=!report.changedSourceFiles.length;report.driverUnchanged=hash(fs.readFileSync(__filename))===config.driverSha256;
    report.headAfter=readHead();
    const assetManifest=JSON.parse(fs.readFileSync(path.join(config.output,'prop-assets-manifest.json'),'utf8'));report.assetFiles=assetManifest.files.length;report.assetsUnchanged=assetManifest.files.every(f=>hash(fs.readFileSync(path.join(fixture,f.path)))===f.sha256);
    report.restoreStateSha256=report.restore?.state?hash(JSON.stringify(report.restore.state)):null;report.restoreUnchanged=report.restoreStateSha256===report.restoreTargetSha256;
    report.transportClean=!report.networkFailures.length&&!report.httpErrors.length;
    report.ok=report.restoreUnchanged&&report.restore?.leafUnchanged===true&&report.renderOk&&report.transportClean&&report.assetsUnchanged&&report.sourceUnchanged&&report.driverUnchanged&&report.headAfter===original.head&&!report.failure&&!report.restoreFailure;
    report.stage='complete';report.completedAt=new Date().toISOString();write();app.exit(report.ok?0:1);
  }
}
const direct=require.main===module||(process.versions.electron&&process.argv[1]&&path.resolve(process.argv[1])===__filename);
if(direct){if(process.versions.electron)host().catch(e=>{console.error(e);require('electron').app.exit(1);});else{try{launch();}catch(e){console.error(e);process.exitCode=1;}}}
