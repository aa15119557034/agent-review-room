// Read-only scene diagnosis. Lives outside the fixture; does not change its source.
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process'), crypto = require('node:crypto');
const fixture = 'D:/codex/2026-11-16/world-implementation/world-base/apps/desktop/e2e/fixtures/world-base';
const {createStaticServer, cleanEnvironment} = require(path.join(fixture, 'scripts/baseline.cjs'));
const {installGate} = require(path.join(fixture, 'scripts/diagnose-surface.cjs'));
const {sceneFiles} = require(path.join(fixture, 'scripts/diagnose-wet-road.cjs'));
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function prepare() {
  const w = window.worldBase, gate = window.__surfaceGate, pipe = w.look.pipeline;
  gate.freeze();
  const saved = { camera:w.camera.clone(), view:w.currentView, walking:w.walker.enabled, hidden:document.body.classList.contains('hide-ui'),
    time:w.island.U.uTime.value, stationTime:w.station.ctx.time, blur:pipe.params.blur, rays:pipe.params.rays };
  w.walker.setEnabled(false); document.body.classList.add('hide-ui');
  // Match the default disabled temporal effects; keep all other lighting and look parameters.
  pipe.params.blur = 0; pipe.params.rays = 0;
  const p = w.city.placements.find(p => p.type === 'apartment' && p.model.features.shop);
  if (!p) throw new Error('Missing 4F shop placement');
  const [x,z] = p.frontage, y=p.baseY;
  const ground = (x,z) => w.island.heightAt(x+w.station.root.position.x,z+w.station.root.position.z)-w.station.root.position.y;
  const views = [
    {name:'19-rear-reference',position:[x-15,y+10,z-25],target:[x,y+6,z-10]},
    {name:'20-rear-eye',position:[x-9,ground(x-9,z-20)+1.6,z-20],target:[x+2,y+2.0,z-10],eyeHeight:1.6},
    {name:'21-front-eye',position:[x-8,ground(x-8,-117)+1.66,-117],target:[x+2,y+2.1,z-.4],eyeHeightAboveLane:1.6},
    {name:'22-low-house-entry',position:[-41,ground(-41,-118)+1.6,-118],target:[-37,ground(-37,-121)+.9,-122],eyeHeight:1.6},
  ];
  const sample = () => {
    const t=w.island.terrain, m=w.island.meadow, S=t.splatN, world=6144, half=world/2, cell=world/S;
    const smooth=(a,b,v)=>{const k=Math.max(0,Math.min(1,(v-a)/(b-a)));return k*k*(3-2*k);};
    const rows=[];
    // The wall back is 9m behind this building's frontage. Sample 20m outward every .5m.
    for(let i=0;i<=40;i++) {
      const localZ=z-9-i*.5, wx=x+w.station.root.position.x, wz=localZ+w.station.root.position.z;
      const fx=(wx+half)/cell-.5, fz=(wz+half)/cell-.5, ix=Math.floor(fx),iz=Math.floor(fz),tx=fx-ix,tz=fz-iz;
      const contributors=[]; let A=0,R=0;
      for(let dz=0;dz<2;dz++) for(let dx=0;dx<2;dx++) {
        const xx=Math.max(0,Math.min(S-1,ix+dx)),zz=Math.max(0,Math.min(S-1,iz+dz));
        const at=(zz*S+xx)*4,weight=(dx?tx:1-tx)*(dz?tz:1-tz);
        A+=t.splat[at+3]/255*weight; R+=t.splat[at]/255*weight;
        contributors.push({ix:xx,iz:zz,weight,R:t.splat[at],A:t.splat[at+3]});
      }
      const root=w.camera.position.clone().set(wx,t.heightAt(wx,wz),wz), distance=root.distanceTo(w.camera.position), ndc=root.clone().project(w.camera);
      const shells=m.shells.filter(sh=>sh.kind==='grass').map(sh=>{
        const size=sh.def.cell,xx=Math.floor(wx/size)*size,zz=Math.floor(wz/size)*size, fade=sh.def.fade;
        const active=sh.pool.slice(0,sh.active).some(mesh=>{const c=mesh.material.uniforms.uCell.value;return mesh.visible&&Math.abs(c.x-xx)<1e-6&&Math.abs(c.y-zz)<1e-6;});
        return {cell:size,covered:m._covered(m.coverGrass,xx,zz,size),active,fade:smooth(fade[0],fade[1],distance)*(1-smooth(fade[2],fade[3],distance))};
      });
      rows.push({fromRearWallM:i*.5,local:[x,localZ],world:root.toArray(),A,R,contributors,distance,
        expectedGrassKeepScale:smooth(.02,.5,A),candidateFraction:Math.min(1,A*1.25),shells,
        projectedPixel:[(ndc.x*.5+.5)*1440,(.5-ndc.y*.5)*900],ndcZ:ndc.z});
    }
    return rows;
  };
  window.__meadowProbe={
    select(view) { w.camera.position.fromArray(view.position);w.station.toWorld(w.camera.position,w.camera.position);
      const target=w.station.toWorld(w.camera.position.clone().fromArray(view.target));w.camera.lookAt(target);w.camera.updateMatrixWorld();
      w.station.update(0,14,w.walker.worldPosition);w.island.update(0,14);w.island.U.uTime.value=14;pipe.hasPrev=false;
    },
    capture() { w.renderer.info.reset();w.look.render(w.scene,0);
      const gl=w.renderer.getContext(), ext=gl.getExtension('WEBGL_debug_renderer_info');
      return {png:w.renderer.domElement.toDataURL('image/png'), camera:{position:w.camera.position.toArray(),quaternion:w.camera.quaternion.toArray(),fov:w.camera.fov,aspect:w.camera.aspect},
        gpu:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),
        time:w.island.U.uTime.value,quality:w.island.meadow.quality,hide:w.island.meadow.hide||null,
        cpuTextureShared:w.island.terrain.splatTex.image.data===w.island.terrain.splat,
        maskRects:[w.island.U.uTownRect0.value.toArray(),w.island.U.uTownRect1.value.toArray()],
        terrainNodes:w.island.terrain.mainView.count,meadowStats:{...w.island.meadow.stats},render:{...w.renderer.info.render},
        shells:w.island.meadow.shells.map(sh=>({kind:sh.kind,definition:sh.def,n:sh.n,active:sh.active})),
        samples:sample(),errors:[...w.errors],clock:{timeOrigin:performance.timeOrigin,now:performance.now()}};
    },
    restore(){pipe.params.blur=saved.blur;pipe.params.rays=saved.rays;w.setView(saved.view);w.camera.copy(saved.camera);w.camera.updateMatrixWorld();
      w.station.update(0,saved.stationTime,w.walker.worldPosition);w.island.update(0,saved.time);w.walker.setEnabled(saved.walking);
      document.body.classList.toggle('hide-ui',saved.hidden);pipe.hasPrev=false;gate.resume();return {view:w.currentView,frozen:gate.frozen,walking:w.walker.enabled};}
  };
  return {views,footprint:p.footprint,frontage:p.frontage,baseY:p.baseY,method:'Fixed time 14. One camera update followed by two recorded renders per view; second is presentation, both retained. No quality, visibility, splat, shader or material changes. CPU bilinear splat and shell diagnostics do not prove pixel visibility.'};
}

function launch() {
  const name=process.argv[2]||'gpu-meadow-c7';
  if(!/^gpu-meadow-c7(?:-[a-z0-9]+)*$/.test(name))throw new Error('Expected a new meadow diagnostic directory name');
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
  child.on('spawn',()=>{fs.writeFileSync(path.join(output,'process.json'),JSON.stringify({pid:child.pid}));console.log('Meadow diagnosis PID '+child.pid+'; '+output);});
  child.on('error',e=>{console.error(e);process.exitCode=1;});child.on('exit',code=>{console.log('Electron exited '+code);process.exitCode=code===0?0:1;});
}
async function host() {
  const {app,BrowserWindow,nativeImage}=require('electron'),config=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
  app.setPath('userData',path.join(config.runtime,'user-data'));app.commandLine.appendSwitch('force-device-scale-factor','1');
  const report={config,ok:false,renderOk:false,transportClean:false,captures:[],exceptions:[],networkFailures:[],httpErrors:[],versions:process.versions};
  const write=()=>fs.writeFileSync(path.join(config.output,'meadow-report.json'),JSON.stringify(report,null,2));
  const stage=s=>{report.stage=s;write();};let win,server,timeout,timedOut=false;
  const deadline=new Promise((_,reject)=>{timeout=setTimeout(()=>{timedOut=true;reject(new Error('Timeout at '+report.stage));},config.timeoutMs);});
  let evaluate;
  try { await Promise.race([(async()=>{
    await app.whenReady();server=createStaticServer(fixture);await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    win=new BrowserWindow({width:1440,height:900,useContentSize:true,show:true,autoHideMenuBar:true,title:'Meadow source diagnosis',webPreferences:{sandbox:true,nodeIntegration:false,contextIsolation:true,backgroundThrottling:false}});
    await win.loadURL('about:blank');win.webContents.debugger.attach('1.3');
    const cdp=(method,args)=>win.webContents.debugger.sendCommand(method,args);
    evaluate=code=>{if(timedOut)throw new Error('Deadline elapsed');return win.webContents.executeJavaScript(code,true);};
    const urls=new Map();win.webContents.debugger.on('message',(_e,method,p)=>{
      if(method==='Runtime.exceptionThrown')report.exceptions.push({stage:report.stage,...p});
      if(method==='Network.requestWillBeSent')urls.set(p.requestId,p.request.url);
      if(method==='Network.loadingFailed')report.networkFailures.push({stage:report.stage,url:urls.get(p.requestId),...p});
      if(method==='Network.responseReceived'&&p.response.status>=400)report.httpErrors.push({url:p.response.url,status:p.response.status});
    });
    await cdp('Page.enable');await cdp('Runtime.enable');await cdp('Network.enable');
    await cdp('Page.addScriptToEvaluateOnNewDocument',{source:'('+installGate.toString()+')()'});
    stage('loading');await win.loadURL('http://127.0.0.1:'+server.address().port+'/');
    while(!await evaluate('window.worldBase?.ready===true')){const errors=await evaluate('window.worldBase?.errors||[]');if(errors.length)throw new Error(errors.join('\n'));await pause(100);}
    stage('freezing');report.initial=await evaluate('('+prepare.toString()+')()');write();
    for(const view of report.initial.views){await evaluate('window.__meadowProbe.select('+JSON.stringify(view)+')');
      for(const pass of ['warmup','capture']){const name=view.name+'-'+pass;stage(name);const shot=await evaluate('window.__meadowProbe.capture()');
        const png=Buffer.from(shot.png.split(',')[1],'base64'),im=nativeImage.createFromBuffer(png);delete shot.png;
        if(im.isEmpty()||im.getSize().width!==1440||im.getSize().height!==900||shot.render.calls<=0)throw new Error('Invalid render');
        fs.writeFileSync(path.join(config.output,name+'.png'),png);fs.writeFileSync(path.join(config.output,name+'.jpg'),im.resize({width:960}).toJPEG(88));
        report.captures.push({name,view,...shot,pngSha256:hash(png)});write();}
    }
    await pause(100);report.renderOk=!report.exceptions.length&&report.captures.length===8&&report.captures.every(c=>!c.errors.length);
  })(),deadline]); }catch(e){report.failure=e.stack||String(e);write();console.error(e);}
  finally {clearTimeout(timeout);if(win&&!win.isDestroyed()){try{report.restore=await Promise.race([win.webContents.executeJavaScript('window.__meadowProbe?.restore()'),pause(3000).then(()=>{throw new Error('Restore timeout');})]);}catch(e){report.restoreFailure=String(e);}win.destroy();}server?.close();
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
