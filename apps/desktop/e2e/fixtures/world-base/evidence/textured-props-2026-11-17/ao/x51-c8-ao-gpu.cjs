// Read-only scene diagnosis. Lives outside the fixture; does not change its source.
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process'), crypto = require('node:crypto');
const fixture = 'D:/codex/2026-11-16/world-implementation/world-base/apps/desktop/e2e/fixtures/world-base';
const {createStaticServer, cleanEnvironment} = require(path.join(fixture, 'scripts/baseline.cjs'));
const {installGate} = require(path.join(fixture, 'scripts/diagnose-surface.cjs'));
const {sceneFiles} = require(path.join(fixture, 'scripts/diagnose-wet-road.cjs'));
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function prepare() {
  const w=window.worldBase,gate=window.__surfaceGate,pipe=w.look.pipeline;
  gate.freeze();
  const saved={camera:w.camera.clone(),view:w.currentView,walking:w.walker.enabled,hidden:document.body.classList.contains('hide-ui'),time:w.island.U.uTime.value,stationTime:w.station.ctx.time,blur:pipe.params.blur,rays:pipe.params.rays,ao:pipe.finalMat.uniforms.uAO.value};
  w.walker.setEnabled(false);document.body.classList.add('hide-ui');
  if(saved.blur!==0||saved.rays!==0||saved.ao!==.55)throw new Error('Expected default blur=0/rays=0/AO=.55');
  const p=w.city.placements.find(p=>p.type==='apartment'&&p.model.features.shop);
  if(!p)throw new Error('Missing 4F shop placement');
  const [x,z]=p.frontage,y=p.baseY;
  const ground=(x,z)=>w.island.heightAt(x+w.station.root.position.x,z+w.station.root.position.z)-w.station.root.position.y;
  const street=w.views.find(v=>v.name==='station-street');if(!street)throw new Error('Missing street view');
  const views=[
    {name:'20-rear-eye',space:'station-local',position:[x-9,ground(x-9,z-20)+1.6,z-20],target:[x+2,y+2,z-10]},
    {name:'21-front-eye',space:'station-local',position:[x-8,ground(x-8,-117)+1.66,-117],target:[x+2,y+2.1,z-.4]},
    {name:'station-street',space:'world',position:[...street.position],target:[...street.target]}
  ];
  const texture=t=>t?{class:t.constructor.name,isDepthTexture:t.isDepthTexture===true,type:t.type,format:t.format,internalFormat:t.internalFormat,minFilter:t.minFilter,magFilter:t.magFilter,wrapS:t.wrapS,wrapT:t.wrapT,width:t.image?.width,height:t.image?.height}:null;
  function state(){
    const c=w.camera,rt=pipe.sceneRT,gl=w.renderer.getContext(),ext=gl.getExtension('WEBGL_debug_renderer_info'),lights=[];
    w.scene.traverse(o=>{if(o.isLight)lights.push({class:o.constructor.name,name:o.name,type:o.type,position:o.position.toArray(),worldPosition:o.getWorldPosition(c.position.clone()).toArray(),color:o.color.toArray(),intensity:o.intensity,castShadow:o.castShadow,target:o.target?.position.toArray(),shadow:o.shadow?{mapSize:o.shadow.mapSize.toArray(),bias:o.shadow.bias,normalBias:o.shadow.normalBias,camera:{near:o.shadow.camera.near,far:o.shadow.camera.far,left:o.shadow.camera.left,right:o.shadow.camera.right,top:o.shadow.camera.top,bottom:o.shadow.camera.bottom},depth:texture(o.shadow.map?.depthTexture)}:null});});
    return {camera:{position:c.position.toArray(),quaternion:c.quaternion.toArray(),fov:c.fov,aspect:c.aspect,near:c.near,far:c.far,zoom:c.zoom,projectionMatrix:c.projectionMatrix.toArray()},lights,
      ao:pipe.finalMat.uniforms.uAO.value,toon:pipe.finalMat.uniforms.uToon.value,time:w.island.U.uTime.value,stationTime:w.station.ctx.time,params:{...pipe.params},quality:w.island.meadow.quality,
      depth:{texture:texture(rt.depthTexture),sceneTarget:{class:rt.constructor.name,width:rt.width,height:rt.height,samples:rt.samples,depthBuffer:rt.depthBuffer},boundToSceneDepth:pipe.finalMat.uniforms.tWorldDepth.value===rt.depthTexture,near:pipe.finalMat.uniforms.uNear.value,far:pipe.finalMat.uniforms.uFar.value,reversed:pipe.finalMat.uniforms.uReversed.value,projectionScale:pipe.finalMat.uniforms.uProjScale.value},
      gpu:{renderer:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),vendor:ext?gl.getParameter(ext.UNMASKED_VENDOR_WEBGL):gl.getParameter(gl.VENDOR),version:gl.getParameter(gl.VERSION),shadingLanguageVersion:gl.getParameter(gl.SHADING_LANGUAGE_VERSION),precision:w.renderer.capabilities.precision,maxTextureSize:w.renderer.capabilities.maxTextureSize},
      dimensions:{width:w.renderer.domElement.width,height:w.renderer.domElement.height,pixelRatio:w.renderer.getPixelRatio()},render:{...w.renderer.info.render},memory:{...w.renderer.info.memory},errors:[...w.errors],clock:{timeOrigin:performance.timeOrigin,now:performance.now()}};
  }
  window.__aoProbe={
    select(view){w.camera.position.fromArray(view.position);const target=w.camera.position.clone().fromArray(view.target);if(view.space==='station-local'){w.station.toWorld(w.camera.position,w.camera.position);w.station.toWorld(target,target);}w.camera.lookAt(target);w.camera.updateMatrixWorld();w.station.update(0,14,w.walker.worldPosition);w.island.update(0,14);w.island.U.uTime.value=14;pipe.hasPrev=false;},
    setAO(value){w.look.setAO(value);pipe.hasPrev=false;},
    capture(){w.renderer.info.reset();w.look.render(w.scene,0);return {png:w.renderer.domElement.toDataURL('image/png'),...state()};},
    restore(){w.look.setAO(saved.ao);pipe.params.blur=saved.blur;pipe.params.rays=saved.rays;w.camera.copy(saved.camera);w.camera.updateMatrixWorld();w.currentView=saved.view;w.station.update(0,saved.stationTime,w.walker.worldPosition);w.island.update(0,saved.time);w.island.U.uTime.value=saved.time;w.walker.setEnabled(saved.walking);document.body.classList.toggle('hide-ui',saved.hidden);pipe.hasPrev=false;gate.resume();return{ao:pipe.finalMat.uniforms.uAO.value,blur:pipe.params.blur,rays:pipe.params.rays,time:w.island.U.uTime.value,view:w.currentView,walking:w.walker.enabled,frozen:gate.frozen};}
  };
  return {views,saved:{ao:saved.ao,blur:saved.blur,rays:saved.rays,time:saved.time},method:'Exact C7 20/21 camera formulas plus existing station-street. Freeze RAF/time14. For each view: AO=.55 then AO=0; each has one retained warmup and two fresh same-task render+PNG captures. Only AO changes within view. No shadow/exposure/quality/shader edits. Typed depth metadata describes actual Three objects; no claim of queried driver internal attachment format. No performance claims.'};
}

function launch() {
  const name=process.argv[2]||'gpu-ao-c8';
  if(!/^gpu-ao-c8(?:-[a-z0-9]+)*$/.test(name))throw new Error('Expected a new AO diagnostic directory name');
  const output=path.join(fixture,'artifacts',name);
  if(fs.existsSync(output))throw new Error('Output exists; preserve evidence');
  fs.mkdirSync(output,{recursive:true});
  const config={fixture,output,runtime:fs.mkdtempSync(path.join(output,'runtime-')),startedAt:new Date().toISOString(),timeoutMs:180000};
  const head=cp.execFileSync('git',['rev-parse','HEAD'],{cwd:fixture,encoding:'utf8',windowsHide:true}).trim();
  const manifest={head,capturedAt:config.startedAt,files:sceneFiles()};
  fs.writeFileSync(path.join(output,'source-manifest.json'),JSON.stringify(manifest,null,2));
  config.driverSha256=hash(fs.readFileSync(__filename));
  const file=path.join(config.runtime,'config.json');fs.writeFileSync(file,JSON.stringify(config,null,2));
  fs.writeFileSync(path.join(output,'run-config.json'),JSON.stringify(config,null,2));
  const log=fs.openSync(path.join(output,'electron.log'),'w');
  const child=cp.spawn('D:/codex/2026-11-16/world-implementation/runtime-path-probe/electron.exe',[__filename,file],{cwd:fixture,windowsHide:true,env:cleanEnvironment(config.runtime),stdio:['ignore',log,log]});fs.closeSync(log);
  child.on('spawn',()=>{fs.writeFileSync(path.join(output,'process.json'),JSON.stringify({pid:child.pid}));console.log('AO diagnosis PID '+child.pid+'; '+output);});
  child.on('error',e=>{console.error(e);process.exitCode=1;});child.on('exit',code=>{console.log('Electron exited '+code);process.exitCode=code===0?0:1;});
}
async function host() {
  const {app,BrowserWindow,nativeImage}=require('electron'),config=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
  app.setPath('userData',path.join(config.runtime,'user-data'));app.commandLine.appendSwitch('force-device-scale-factor','1');
  const report={config,ok:false,renderOk:false,transportClean:false,captures:[],exceptions:[],console:[],networkRequests:[],networkFailures:[],httpErrors:[],stageHistory:[],versions:process.versions};
  const write=()=>fs.writeFileSync(path.join(config.output,'ao-report.json'),JSON.stringify(report,null,2));
  const stage=s=>{report.stage=s;report.stageHistory.push({stage:s,wallTimeMs:Date.now()});write();};let win,server,timeout,timedOut=false;
  const deadline=new Promise((_,reject)=>{timeout=setTimeout(()=>{timedOut=true;reject(new Error('Timeout at '+report.stage));},config.timeoutMs);});
  let evaluate;
  try { await Promise.race([(async()=>{
    stage('bootstrap');await app.whenReady();stage('app-ready');server=createStaticServer(fixture);await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    win=new BrowserWindow({width:1440,height:900,useContentSize:true,show:true,autoHideMenuBar:true,title:'AO source diagnosis',webPreferences:{sandbox:true,nodeIntegration:false,contextIsolation:true,backgroundThrottling:false}});
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
    for(const view of report.initial.views){
      await evaluate('window.__aoProbe.select('+JSON.stringify(view)+')');
      for(const ao of [report.initial.saved.ao,0]){
        await evaluate('window.__aoProbe.setAO('+JSON.stringify(ao)+')');
        for(const pass of ['warmup','capture-1','capture-2']){
          const name=view.name+'-ao-'+(ao===0?'off':'on')+'-'+pass;stage(name);
          const shot=await evaluate('window.__aoProbe.capture()');
          const png=Buffer.from(shot.png.split(',')[1],'base64'),im=nativeImage.createFromBuffer(png);delete shot.png;
          if(im.isEmpty()||im.getSize().width!==1440||im.getSize().height!==900||shot.render.calls<=0||shot.dimensions.pixelRatio!==1||shot.time!==14||shot.ao!==ao||!shot.depth.boundToSceneDepth)throw new Error('Invalid frozen render');
          fs.writeFileSync(path.join(config.output,name+'.png'),png);
          fs.writeFileSync(path.join(config.output,name+'.jpg'),im.resize({width:960}).toJPEG(88));
          report.captures.push({name,view,pass,...shot,pngSha256:hash(png)});write();
        }
      }
      await evaluate('window.__aoProbe.setAO('+JSON.stringify(report.initial.saved.ao)+')');
    }
    await pause(3000);
    report.renderOk=!report.exceptions.length&&report.captures.length===18&&report.captures.every(c=>!c.errors.length);

  })(),deadline]); }catch(e){report.failure=e.stack||String(e);write();console.error(e);}
  finally {clearTimeout(timeout);if(win&&!win.isDestroyed()){try{report.restore=await Promise.race([win.webContents.executeJavaScript('window.__aoProbe?.restore()'),pause(3000).then(()=>{throw new Error('Restore timeout');})]);}catch(e){report.restoreFailure=String(e);}win.destroy();}server?.close();
    const original=JSON.parse(fs.readFileSync(path.join(config.output,'source-manifest.json'),'utf8')),current=sceneFiles();
    report.changedSourceFiles=[...new Set([...Object.keys(original.files),...Object.keys(current)])].filter(k=>original.files[k]!==current[k]);
    report.sourceUnchanged=!report.changedSourceFiles.length;report.driverUnchanged=hash(fs.readFileSync(__filename))===config.driverSha256;
    report.headAfter=cp.execFileSync('git',['rev-parse','HEAD'],{cwd:fixture,encoding:'utf8',windowsHide:true}).trim();
    report.transportClean=!report.networkFailures.length&&!report.httpErrors.length;
    report.ok=report.renderOk&&report.transportClean&&report.sourceUnchanged&&report.driverUnchanged&&report.headAfter===original.head&&!report.failure&&!report.restoreFailure;
    report.stage='complete';report.completedAt=new Date().toISOString();write();app.exit(report.ok?0:1);
  }
}
const direct=require.main===module||(process.versions.electron&&process.argv[1]&&path.resolve(process.argv[1])===__filename);
if(direct){if(process.versions.electron)host().catch(e=>{console.error(e);require('electron').app.exit(1);});else{try{launch();}catch(e){console.error(e);process.exitCode=1;}}}
