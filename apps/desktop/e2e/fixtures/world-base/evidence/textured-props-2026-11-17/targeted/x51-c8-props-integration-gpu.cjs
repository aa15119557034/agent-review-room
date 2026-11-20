// Read-only scene diagnosis. Lives outside the fixture; does not change its source.
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process'), crypto = require('node:crypto');
const fixture = 'D:/codex/2026-11-16/world-implementation/world-base/apps/desktop/e2e/fixtures/world-base';
const {createStaticServer, cleanEnvironment} = require(path.join(fixture, 'scripts/baseline.cjs'));
const {installGate} = require(path.join(fixture, 'scripts/diagnose-surface.cjs'));
const {sceneFiles} = require(path.join(fixture, 'scripts/diagnose-wet-road.cjs'));
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function prepare() {
  const THREE=await import('three'),w=window.worldBase,s=w.station,gate=window.__surfaceGate,pipe=w.look.pipeline;
  const saved={camera:w.camera.clone(),view:w.currentView,cameraMode:w.cameraMode,walkerView:w.walker.view,feet:w.walker.worldPosition.clone(),yaw:w.walker.yaw*180/Math.PI,pitch:w.walker.pitch*180/Math.PI,walking:w.walker.enabled,player:s.ctx.player.position.clone(),time:w.island.U.uTime.value,stationTime:s.ctx.time,hidden:document.body.classList.contains('hide-ui'),focus:document.activeElement,
    ui:[...document.querySelectorAll('[data-view],#walk,#mode,#camera')].map(e=>({e,className:e.className,text:e.textContent}))};
  const hooks=[],draws={},materialRestores=[];const originalAO=pipe.finalMat.uniforms.uAO.value;let stopped=false;gate.freeze();w.walker.setEnabled(false);document.body.classList.add('hide-ui');
  const api=window.__integrationProbe={restore(){stopped=true;for(const fn of materialRestores)fn();w.look.setAO(originalAO);delete window.__integrationNativeRAF;for(const [mesh,fn]of hooks)mesh.onBeforeRender=fn;w.walker.setEnabled(false);w.walker.setPose(saved.feet,saved.yaw,saved.pitch);w.walker.setView(saved.walkerView);w.walker.setEnabled(saved.walking);w.camera.copy(saved.camera);w.camera.updateMatrixWorld();w.currentView=saved.view;w.cameraMode=saved.cameraMode;s.update(0,saved.stationTime,s.toWorld(saved.player));w.island.update(0,saved.time);w.island.U.uTime.value=saved.time;document.body.classList.toggle('hide-ui',saved.hidden);for(const item of saved.ui){item.e.className=item.className;item.e.textContent=item.text;}saved.focus?.focus();pipe.hasPrev=false;gate.resume();return{hookCountRestored:hooks.length,view:w.currentView,fov:w.camera.fov,walking:w.walker.enabled,feet:w.walker.worldPosition.toArray(),time:w.island.U.uTime.value,frozen:gate.frozen};}};
  const checks=[];const check=(name,pass,evidence)=>{checks.push({name,passed:!!pass,evidence});};
  const source=s.root.getObjectByName('station-textured-service-props'),city=w.city.root.getObjectByName('city-textured-crate');
  if(!source||!city)throw new Error('Missing actual station/city crate groups');
  const meshes=root=>{const list=[];root.traverse(o=>{if(o.isMesh)list.push(o)});return list;};
  const sourceMeshes=meshes(source),cityMeshes=meshes(city);
  const textures=m=>Object.fromEntries(['map','alphaMap','normalMap','roughnessMap','metalnessMap','aoMap'].map(k=>{const t=m[k];return[k,t?{uuid:t.uuid,type:t.type,colorSpace:t.colorSpace,flipY:t.flipY,channel:t.channel,image:{width:t.image?.width,height:t.image?.height},repeat:t.repeat.toArray(),url:t.image?.currentSrc||t.image?.src||null}:null]}));
  const material=m=>({uuid:m.uuid,name:m.name,type:m.type,vertexColors:m.vertexColors,metalness:m.metalness,roughness:m.roughness,aoMapIntensity:m.aoMapIntensity,envMap:!!m.envMap,sceneEnvironment:!!w.scene.environment,alphaTest:m.alphaTest,transparent:m.transparent,depthWrite:m.depthWrite,normalScale:m.normalScale?.toArray(),clippingPlanes:m.clippingPlanes?.length||0,maps:textures(m)});
  const bounds=root=>{root.updateWorldMatrix(true,true);const box=new THREE.Box3().setFromObject(root);return{worldMin:box.min.toArray(),worldMax:box.max.toArray(),size:box.getSize(new THREE.Vector3()).toArray(),position:root.position.toArray(),quaternion:root.quaternion.toArray(),scale:root.scale.toArray(),matrixWorld:root.matrixWorld.toArray()};};
  const uvInfo=g=>{const a=g.attributes.uv;if(!a)return null;let min=[Infinity,Infinity],max=[-Infinity,-Infinity];for(let i=0;i<a.count;i++){const p=[a.getX(i),a.getY(i)];for(let k=0;k<2;k++){min[k]=Math.min(min[k],p[k]);max[k]=Math.max(max[k],p[k]);}}return{count:a.count,min,max,uv1:!!g.attributes.uv1,uv2:!!g.attributes.uv2};};
  const projected=root=>{const box=new THREE.Box3().setFromObject(root),points=[];for(const x of [box.min.x,box.max.x])for(const y of [box.min.y,box.max.y])for(const z of [box.min.z,box.max.z]){const p=new THREE.Vector3(x,y,z).project(w.camera);points.push([(p.x*.5+.5)*1440,(.5-p.y*.5)*900,p.z]);}return{corners:points,pixelBounds:{minX:Math.min(...points.map(p=>p[0])),maxX:Math.max(...points.map(p=>p[0])),minY:Math.min(...points.map(p=>p[1])),maxY:Math.max(...points.map(p=>p[1]))},scope:'Projected world AABB corners, not visible-pixel segmentation'};};
  const snapshotCrate=root=>({name:root.name,bounds:bounds(root),meshes:meshes(root).map(m=>({uuid:m.uuid,geometry:m.geometry.uuid,triangles:(m.geometry.index?.count||m.geometry.attributes.position.count)/3,material:material(m.material),uv:uvInfo(m.geometry),castShadow:m.castShadow,receiveShadow:m.receiveShadow}))});
  const shutters=meshes(s.root).filter(m=>!Array.isArray(m.material)&&m.material.name==='tool-shed-worn-shutter');
  const imageStatsCache=new Map();
  const imageStats=t=>{if(!t?.image)return null;if(imageStatsCache.has(t.uuid))return imageStatsCache.get(t.uuid);const canvas=document.createElement('canvas');canvas.width=t.image.width;canvas.height=t.image.height;const c=canvas.getContext('2d');c.drawImage(t.image,0,0);const pixels=c.getImageData(0,0,canvas.width,canvas.height).data,channels=[0,1,2].map(channel=>{let min=255,max=0,sum=0;for(let i=channel;i<pixels.length;i+=4){const v=pixels[i];min=Math.min(min,v);max=Math.max(max,v);sum+=v;}return{min,max,mean:sum/(pixels.length/4)};});const result={uuid:t.uuid,width:canvas.width,height:canvas.height,channelsRGB:channels,method:'Canvas2D image byte sample; no texture or asset mutation'};imageStatsCache.set(t.uuid,result);return result;};
  const specs=[{center:[23.65,1.025,-28.688],size:[1.12,1.65,.02]},{center:[24.7,1.025,-28.67],size:[1.12,1.65,.02]}];
  const inverse=s.root.matrixWorld.clone().invert();
  const panels=specs.map(spec=>{let triangles=0;for(const mesh of shutters){const attr=mesh.geometry.attributes.position,index=mesh.geometry.index,count=index?.count||attr.count,transform=inverse.clone().multiply(mesh.matrixWorld);for(let i=0;i<count;i+=3){const points=[0,1,2].map(k=>new THREE.Vector3().fromBufferAttribute(attr,index?index.getX(i+k):i+k).applyMatrix4(transform));if(points.every(p=>p.toArray().every((v,k)=>Math.abs(v-spec.center[k])<=spec.size[k]/2+1e-4)))triangles++;}}return{...spec,triangles};});
  check('two original shed panel surfaces retain replacement material after batching',panels.every(p=>p.triangles===12)&&shutters.length>0,{panels,renderMeshes:shutters.length});
  check('replacement shutter has loaded diffuse/normal/ARM maps',shutters.every(o=>o.material.isMeshStandardMaterial&&['map','normalMap','aoMap','roughnessMap','metalnessMap'].every(k=>o.material[k]?.image?.width>0)&&o.material.aoMap===o.material.roughnessMap&&o.material.aoMap===o.material.metalnessMap),shutters.map(o=>material(o.material)));
  check('station crate retains source dimensions and cutout material',sourceMeshes.length===1&&new THREE.Box3().setFromObject(source).getSize(new THREE.Vector3()).distanceTo(new THREE.Vector3(...s.texturedProps.bounds.size))<1e-5&&sourceMeshes.every(o=>o.material.isMeshStandardMaterial&&o.material.alphaMap?.image?.width>0&&o.material.alphaTest===.5&&!o.material.transparent&&o.material.depthWrite&&o.material.normalMap&&o.material.roughnessMap===o.material.metalnessMap),snapshotCrate(source));
  const ownership=cityMeshes.map((m,i)=>{const p=sourceMeshes[i];return {geometryIndependent:!!p&&m.geometry!==p.geometry,materialIndependent:!!p&&m.material!==p.material,mapsBorrowed:!!p&&['map','alphaMap','normalMap','roughnessMap','metalnessMap','aoMap'].every(k=>m.material[k]===p.material[k]),normalScalePreserved:!!p&&m.material.normalScale.equals(p.material.normalScale),noStationClip:!m.material.clippingPlanes?.length,triangles:(m.geometry.index?.count||m.geometry.attributes.position.count)/3};});
  check('city clone owns geometry/material while borrowing source textures without station clip',cityMeshes.length===sourceMeshes.length&&ownership.every(row=>Object.entries(row).filter(([k])=>k!=='triangles').every(([,v])=>v)),{relations:ownership,city:snapshotCrate(city),walkable:w.city.stats.texturedProps.walkable,limitation:'Identity/lifetime contract inspection only; city.dispose is not invoked in a restorable live scene.'});
  check('town detail remains background-only',w.city.stats.texturedProps.walkable===false&&w.city.stats.connections.walkable===false,{townWalkable:w.city.stats.texturedProps.walkable,connectionsWalkable:w.city.stats.connections.walkable,stationBounds:s.bounds});
  for(const [kind,list]of [['stationCrate',sourceMeshes],['cityCrate',cityMeshes],['shutters',shutters]])for(const mesh of list){const old=mesh.onBeforeRender;hooks.push([mesh,old]);mesh.onBeforeRender=function(...args){draws[kind]=(draws[kind]||0)+1;return old.apply(this,args)};}
  const collision=s.texturedProps.stats.collision;
  const matches=s.physics.items.filter(o=>o.type==='box'&&Math.abs(o.cx-collision.x)<1e-6&&Math.abs(o.cz-collision.z)<1e-6&&Math.abs(o.hw*2-collision.width)<1e-6&&Math.abs(o.hd*2-collision.depth)<1e-6&&Math.abs(o.y0-collision.y0)<1e-6&&Math.abs(o.y1-collision.y1)<1e-6);
  const feet=s.ctx.L.heightAt(collision.x,collision.z),resolve=(x,z,y=feet)=>{const p={x,z};s.physics.resolve(p,.3,y,1.7);return{input:[x,z,y],output:[p.x,p.z],correction:Math.hypot(p.x-x,p.z-z)}};
  const center=resolve(collision.x,collision.z),front=resolve(collision.x,collision.z+1.2);
  let p={x:collision.x,z:collision.z+1.2};const path=[];for(let i=0;i<40;i++){const request={x:p.x,z:p.z-.05};s.physics.resolve(request,.3,feet,1.7);p=request;path.push([p.x,p.z]);}
  const edge=collision.z+collision.depth/2+.3;
  check('real service stack collider blocks capsule approach while front point is clear',matches.length===1&&center.correction>.2&&front.correction<1e-6&&p.z>=edge-1e-5&&p.z<front.output[1]-.2,{collision,matchingColliders:matches.length,center,front,resolvedSteps:path,expectedFrontCapsuleBoundary:edge,scope:'Programmatic calls to production station.physics.resolve, not a keyboard walk, no town walkability assertion.'});
  const views=['service-corner','laundry-details'].map(name=>{const v=w.views.find(v=>v.name===name);if(!v)throw new Error('Missing view '+name);return JSON.parse(JSON.stringify(v));});
  api.select=view=>{const button=document.querySelector('[data-view="'+view.name+'"]');if(!button)throw new Error('Missing detail UI button');button.click();check(view.name+' UI applies configured FOV and camera',w.currentView===view.name&&w.camera.fov===55&&w.camera.position.distanceTo(new THREE.Vector3(...view.position))<1e-7&&!w.walker.enabled,{camera:w.camera.position.toArray(),fov:w.camera.fov,configured:view,buttonActive:button.classList.contains('active')});s.update(0,14,w.walker.worldPosition);w.island.update(0,14);w.island.U.uTime.value=14;pipe.hasPrev=false;};
  api.capture=()=>{for(const k of Object.keys(draws))draws[k]=0;w.renderer.info.reset();w.look.render(w.scene,0);const gl=w.renderer.getContext(),ext=gl.getExtension('WEBGL_debug_renderer_info');return{png:w.renderer.domElement.toDataURL('image/png'),camera:{position:w.camera.position.toArray(),quaternion:w.camera.quaternion.toArray(),fov:w.camera.fov,near:w.camera.near,far:w.camera.far},draws:{...draws},diagnostic:{worldAO:pipe.finalMat.uniforms.uAO.value,shutterAOMaps:shutters.map(o=>o.material.aoMap?.uuid||null)},projectedSubjects:{stationCrate:projected(source),stationCarton:projected(s.root.getObjectByName('station-service-carton')),cityCrate:projected(city)},time:w.island.U.uTime.value,params:{...pipe.params},renderer:{name:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),precision:w.renderer.capabilities.precision,pixelRatio:w.renderer.getPixelRatio(),glError:gl.getError()},render:{...w.renderer.info.render},errors:[...w.errors],clock:{timeOrigin:performance.timeOrigin,now:performance.now()}};};
  api.walkTransition=()=>{const from=w.currentView;document.querySelector('#walk').click();const result={from,to:w.currentView,fov:w.camera.fov,enabled:w.walker.enabled,feet:w.walker.worldPosition.toArray(),spawn:s.spawn.toArray()};check(from+' UI walk resets FOV58 and station spawn',w.currentView==='walking'&&w.camera.fov===58&&w.walker.enabled&&w.walker.worldPosition.distanceTo(s.spawn)<1e-7,result);w.walker.setEnabled(false);return result;};

  const shutterMaterials=[...new Set(shutters.map(o=>o.material))],originalAOMaps=new Map(shutterMaterials.map(m=>[m,m.aoMap]));
  const restoreShutter=()=>{for(const [m,map]of originalAOMaps){if(m.aoMap!==map){m.aoMap=map;m.needsUpdate=true;}}};materialRestores.push(restoreShutter);
  api.diagnostic=kind=>{restoreShutter();w.look.setAO(originalAO);if(kind==='shutter-ao-off'){for(const m of shutterMaterials){m.aoMap=null;m.needsUpdate=true;}}else if(kind==='world-ao-off')w.look.setAO(0);else if(kind!=='original')throw new Error('Unknown diagnostic');};
  api.performance=async(name,ao)=>{
    w.setView(name);s.update(0,14,w.walker.worldPosition);w.island.update(0,14);w.island.U.uTime.value=14;w.look.setAO(ao);pipe.hasPrev=false;
    const gl=w.renderer.getContext(),originalMethods=[],counts={calls:0,triangles:0},frames=[];
    for(const [method,countIndex,instanceIndex]of [['drawArrays',2,-1],['drawElements',1,-1],['drawArraysInstanced',2,3],['drawElementsInstanced',1,4]]){const original=gl[method];if(typeof original!=='function')continue;originalMethods.push([method,original]);gl[method]=function(...args){const n=args[countIndex],instances=instanceIndex<0?1:args[instanceIndex];counts.calls++;counts.triangles+=(args[0]===4?n/3:(args[0]===5||args[0]===6)?Math.max(0,n-2):0)*instances;return original.apply(this,args);};}
    const cleanup=()=>{for(const [key,fn]of originalMethods)gl[key]=fn;};materialRestores.push(cleanup);
    const frozen={camera:w.camera.position.toArray(),quaternion:w.camera.quaternion.toArray(),fov:w.camera.fov,time:w.island.U.uTime.value,quality:w.island.meadow.quality,terrainNodes:w.island.terrain.mainView.count,shells:w.island.meadow.shells.map(sh=>({kind:sh.kind,active:sh.active}))};
    try{return await new Promise((resolve,reject)=>{let begin,last,sampleStart;function frame(now){try{if(stopped)throw new Error('Probe restoring');if(begin===undefined)begin=now;counts.calls=0;counts.triangles=0;w.renderer.info.reset();const cpu=performance.now();w.look.render(w.scene,0);const cpuRenderMs=performance.now()-cpu;
      if(now-begin>=2000){if(sampleStart===undefined){sampleStart=now;last=now;}else{frames.push({timestampMs:now,dtMs:now-last,calls:counts.calls,triangles:counts.triangles,cpuRenderMs,rendererInfo:{...w.renderer.info.render}});last=now;}if(now-sampleStart>=5000){const elapsed=now-sampleStart;resolve({view:name,ao,warmupMs:sampleStart-begin,sampleMs:elapsed,frameCount:frames.length,fps:1000*frames.length/elapsed,frames,frozen,timeAfter:w.island.U.uTime.value,method:'Native RAF manual renders with main RAF frozen, dt0/time14, WebGL draw-call wrappers across all passes; wrapper and diagnostic overhead included; no station/walker/island per-frame updates. Tests AO contribution only; shadows4096 and props unchanged. Unsupported extension draw paths: ANGLE_instanced_arrays/WEBGL_multi_draw.'});return;}}
      window.__integrationNativeRAF(frame);
    }catch(error){reject(error)}}window.__integrationNativeRAF(frame);});}finally{cleanup();w.look.setAO(originalAO);}
  };

  api.results=()=>({checks,passed:checks.every(c=>c.passed)});
  return{views,checks,stationStats:s.texturedProps.stats,cityStats:w.city.stats.texturedProps,sourceCrate:snapshotCrate(source),cityCrate:snapshotCrate(city),shutters:shutters.map(m=>({bounds:bounds(m),material:material(m.material),uv:uvInfo(m.geometry),imageBytes:{diffuse:imageStats(m.material.map),arm:imageStats(m.material.aoMap)},compiledUV:(()=>{const p=w.renderer.properties.get(m.material).currentProgram;return p?.vertexShader?w.renderer.getContext().getShaderSource(p.vertexShader).split("\n").filter(l=>/AOMAP|aoMap|UV_CHANNEL|vUv|vAoMapUv/.test(l)):null})()})),method:'Fixed time14; real UI detail selection at configured eye1.6/FOV55; one warmup + two retained fresh PNG frames each. Real scene material/geometry/texture identity, renderer submission hooks and station capsule solver probes. No city walkability claim, no destructive disposal check, no quality/shadow/look modification.'};
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
  const name=process.argv[2]||'gpu-props-c8';
  if(!/^gpu-props-c8(?:-[a-z0-9]+)*$/.test(name))throw new Error('Expected a new props integration directory name');
  const output=path.join(fixture,'artifacts',name);
  if(fs.existsSync(output))throw new Error('Output exists; preserve evidence');
  fs.mkdirSync(output,{recursive:true});
  const config={fixture,output,runtime:fs.mkdtempSync(path.join(output,'runtime-')),startedAt:new Date().toISOString(),timeoutMs:240000};
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
  child.on('spawn',()=>{fs.writeFileSync(path.join(output,'process.json'),JSON.stringify({pid:child.pid}));console.log('Props integration PID '+child.pid+'; '+output);});
  child.on('error',e=>{console.error(e);process.exitCode=1;});child.on('exit',code=>{console.log('Electron exited '+code);process.exitCode=code===0?0:1;});
}
async function host() {
  const {app,BrowserWindow,nativeImage}=require('electron'),config=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
  app.setPath('userData',path.join(config.runtime,'user-data'));app.commandLine.appendSwitch('force-device-scale-factor','1');
  const report={config,ok:false,renderOk:false,transportClean:false,captures:[],exceptions:[],console:[],networkRequests:[],networkFailures:[],httpErrors:[],stageHistory:[],versions:process.versions};
  const write=()=>fs.writeFileSync(path.join(config.output,'integration-report.json'),JSON.stringify(report,null,2));
  const stage=s=>{report.stage=s;report.stageHistory.push({stage:s,wallTimeMs:Date.now()});write();};let win,server,timeout,timedOut=false;
  const deadline=new Promise((_,reject)=>{timeout=setTimeout(()=>{timedOut=true;reject(new Error('Timeout at '+report.stage));},config.timeoutMs);});
  let evaluate;
  try { await Promise.race([(async()=>{
    stage('bootstrap');await app.whenReady();stage('app-ready');server=createStaticServer(fixture);await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    win=new BrowserWindow({width:1440,height:900,useContentSize:true,show:true,autoHideMenuBar:true,title:'Props integration diagnosis',webPreferences:{sandbox:true,nodeIntegration:false,contextIsolation:true,backgroundThrottling:false}});
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
    await cdp('Page.addScriptToEvaluateOnNewDocument',{source:'window.__integrationNativeRAF=window.requestAnimationFrame.bind(window);('+installGate.toString()+')()'});
    stage('loading');await win.loadURL('http://127.0.0.1:'+server.address().port+'/');
    while(!await evaluate('window.worldBase?.ready===true')){const errors=await evaluate('window.worldBase?.errors||[]');if(errors.length)throw new Error(errors.join('\n'));await pause(100);}
    stage('freezing');report.pageClock=await evaluate('({timeOrigin:performance.timeOrigin,now:performance.now()})');report.initial=await evaluate('('+prepare.toString()+')()');write();
    report.walkTransitions=[];
    for(const view of report.initial.views){
      await evaluate('window.__integrationProbe.select('+JSON.stringify(view)+')');
      const diagnostic=view.name==='service-corner'?'shutter-ao-off':'world-ao-off';
      for(const variant of ['original',diagnostic]){
        await evaluate('window.__integrationProbe.diagnostic('+JSON.stringify(variant)+')');
      for(const pass of ['warmup','capture-1','capture-2']){
        const name=view.name+(variant==='original'?'':'-'+variant)+'-'+pass;stage(name);const shot=await evaluate('window.__integrationProbe.capture()');
        const png=Buffer.from(shot.png.split(',')[1],'base64'),im=nativeImage.createFromBuffer(png);delete shot.png;
        if(im.isEmpty()||im.getSize().width!==1440||im.getSize().height!==900||shot.render.calls<=0||shot.renderer.pixelRatio!==1||shot.time!==14||shot.camera.fov!==55||shot.renderer.glError!==0)throw new Error('Invalid detail render');
        fs.writeFileSync(path.join(config.output,name+'.png'),png);fs.writeFileSync(path.join(config.output,name+'.jpg'),im.resize({width:960}).toJPEG(88));
        report.captures.push({name,view,pass,variant,...shot,pngSha256:hash(png)});write();
      }
      }
      await evaluate('window.__integrationProbe.diagnostic("original")');
      report.walkTransitions.push(await evaluate('window.__integrationProbe.walkTransition()'));write();
    }
    report.integration=await evaluate('window.__integrationProbe.results()');
    report.renderedSubjects=report.captures.filter(c=>c.pass==='capture-2'&&c.variant==='original').map(c=>({view:c.view.name,draws:c.draws,passed:c.view.name==='service-corner'?c.draws.stationCrate>0&&c.draws.shutters>0:c.draws.cityCrate>0}));
    report.performance=[];
    for(const view of ['station-street','island-aerial'])for(const [phase,ao]of [['A1',.55],['B',0],['A2',.55]]){stage('performance-'+view+'-'+phase);const result=await evaluate('window.__integrationProbe.performance('+JSON.stringify(view)+','+ao+')');const file='frames-'+view+'-'+phase+'.json';fs.writeFileSync(path.join(config.output,file),JSON.stringify(result.frames));delete result.frames;report.performance.push({phase,...result,framesFile:file});write();}
    await pause(3000);
    report.renderOk=!report.exceptions.length&&report.captures.length===12&&report.performance.length===6&&report.captures.every(c=>!c.errors.length)&&report.integration.passed&&report.renderedSubjects.every(c=>c.passed);

  })(),deadline]); }catch(e){report.failure=e.stack||String(e);write();console.error(e);}
  finally {clearTimeout(timeout);if(win&&!win.isDestroyed()){try{report.restore=await Promise.race([win.webContents.executeJavaScript('window.__integrationProbe?.restore()'),pause(3000).then(()=>{throw new Error('Restore timeout');})]);}catch(e){report.restoreFailure=String(e);}win.destroy();}server?.close();
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
