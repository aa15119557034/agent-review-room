// Usage: node town-frame-times.cjs <fixture> <electron> <cameras.json> <source-manifest.json> <new-output-dir>
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, obj) => fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function verify(config) {
  const manifest = read(config.manifest);
  const head = cp.execFileSync('git', ['rev-parse','HEAD'], {cwd:config.fixture, encoding:'utf8', windowsHide:true}).trim();
  const changed = Object.entries(manifest.files).filter(([file, sha]) => hash(fs.readFileSync(path.join(config.fixture, file))) !== sha);
  if (head !== manifest.head || changed.length) throw Error('Source mismatch: ' + head + ' ' + changed.map(([name]) => name).join(', '));
  return {head, files: Object.keys(manifest.files).length, manifestSha256:hash(fs.readFileSync(config.manifest))};
}
function launch() {
  if (process.argv.length !== 7) throw Error('Expected fixture, Electron executable, camera JSON, source manifest and new output directory');
  const [fixture, executable, cameraFile, manifest, output] = process.argv.slice(2).map(p => path.resolve(p));
  const config = {fixture, executable, cameraFile, manifest, output, runtime:path.join(output,'runtime'), durationMs:10000, settleMs:1500, warmupMs:5000, startedAt:new Date().toISOString()};
  config.source = verify(config);
  config.cameras = read(cameraFile).cameras;
  config.driverSha256 = hash(fs.readFileSync(__filename));
  fs.mkdirSync(output);
  fs.mkdirSync(config.runtime);
  const configPath = path.join(output, 'run-config.json');
  write(configPath, config);
  const {cleanEnvironment} = require(path.join(fixture, 'scripts/baseline.cjs'));
  const log = fs.openSync(path.join(output,'electron.log'),'wx');
  const run = cp.spawnSync(executable, [__filename, configPath], {cwd:fixture, windowsHide:true, env:cleanEnvironment(config.runtime), stdio:['ignore',log,log]});
  fs.closeSync(log);
  write(path.join(output,'process-exit.json'), {code:run.status, signal:run.signal, error:run.error?.message, pid:run.pid, completedAt:new Date().toISOString(), sourceAfter:verify(config)});
  console.log(JSON.stringify({code:run.status, output}));
  process.exitCode = run.status ?? 1;
}
function pageState() {
  const w = window.worldBase, p = w.look.pipeline, gl = w.renderer.getContext();
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  return {camera:{position:w.camera.position.toArray(), quaternion:w.camera.quaternion.toArray(), fov:w.camera.fov},
    stationTime:w.station.ctx.time, islandTime:w.island.U.uTime.value, width:w.renderer.domElement.width, height:w.renderer.domElement.height, dpr:w.renderer.getPixelRatio(),
    gpu:ext && gl.getParameter(ext.UNMASKED_RENDERER_WEBGL), walking:w.walker.enabled, ao:p.finalMat.uniforms.uAO.value,
    params:{...p.params}, hidden:document.body.classList.contains('hide-ui'), errors:[...w.errors]};
}
async function host() {
  const {app,BrowserWindow} = require('electron');
  const config = read(process.argv[2]);
  const {createStaticServer} = require(path.join(config.fixture,'scripts/baseline.cjs'));
  app.setPath('userData', path.join(config.runtime,'user-data'));
  app.commandLine.appendSwitch('force-device-scale-factor','1');
  const report = {source:config.source, driverSha256:config.driverSha256, durationMs:config.durationMs, settleMs:config.settleMs, warmupMs:config.warmupMs, startedAt:config.startedAt, exceptions:[], networkFailures:[], segments:[], stage:'bootstrap'};
  const save = () => write(path.join(config.output,'timing-report.json'),report);
  const timeout = setTimeout(() => {report.failure='Timed out at '+report.stage; save(); app.exit(1);},180000);
  let server, win;
  try {
    await app.whenReady();
    server = createStaticServer(config.fixture);
    await new Promise((resolve,reject) => {server.once('error',reject); server.listen(0,'127.0.0.1',resolve);});
    win = new BrowserWindow({width:1440,height:900,useContentSize:true,show:true,autoHideMenuBar:true,webPreferences:{nodeIntegration:false,sandbox:true,contextIsolation:true,backgroundThrottling:false}});
    await win.loadURL('about:blank');
    const wc=win.webContents, dbg=wc.debugger, urls=new Map();
    dbg.attach('1.3');
    dbg.on('message',(_e,method,p) => {
      if(method==='Network.requestWillBeSent') urls.set(p.requestId,p.request.url);
      if(method==='Network.loadingFailed') report.networkFailures.push({url:urls.get(p.requestId),stage:report.stage,...p});
      if(method==='Network.responseReceived' && p.response.status>=400) report.networkFailures.push({url:p.response.url,status:p.response.status,stage:report.stage});
      if(method==='Runtime.exceptionThrown') report.exceptions.push(p.exceptionDetails);
    });
    const preview = fs.readFileSync(path.join(config.fixture,'scripts/preview-host.cjs'),'utf8');
    const start=preview.indexOf('function instrumentPage() {'), end=preview.indexOf('const CORE_VIEWS',start);
    if(start<0 || end<=start) throw Error('Missing project frame instrumentation');
    const instrument=preview.slice(start,end).trim();
    report.previewHostSha256=hash(preview);
    await dbg.sendCommand('Runtime.enable'); await dbg.sendCommand('Network.enable'); await dbg.sendCommand('Page.enable');
    await dbg.sendCommand('Page.addScriptToEvaluateOnNewDocument',{source:'('+instrument+')()'});
    const evaluate = expr => wc.executeJavaScript(expr,true);
    const state = () => evaluate('('+pageState.toString()+')()');
    report.stage='loading'; save();
    await win.loadURL('http://127.0.0.1:'+server.address().port+'/');
    while (!await evaluate('window.__worldCapture?.firstReadyFrameMs != null')) await delay(100);
    await evaluate("document.getElementById('go')?.click(); document.body.classList.add('hide-ui')");
    await delay(config.warmupMs);
    for (const [id, name] of [['20','20-rear-eye'],['21','21-front-eye'],['23','service-corner'],['24','laundry-details']]) {
      report.stage=id; save();
      const camera=config.cameras[name];
      await evaluate('('+function select(c) {
        const w=window.worldBase;
        w.walker.setEnabled(false);
        w.camera.position.fromArray(c.position); w.camera.quaternion.fromArray(c.quaternion); w.camera.fov=c.fov;
        w.camera.updateProjectionMatrix(); w.camera.updateMatrixWorld(); w.look.pipeline.hasPrev=false;
      }.toString()+')('+JSON.stringify(camera)+')');
      await delay(config.settleMs);
      const before=await state();
      await evaluate('window.__worldCapture.frames=[]; window.__worldCapture.collecting=true');
      await delay(config.durationMs+100);
      const rows=await evaluate('window.__worldCapture.collecting=false; window.__worldCapture.frames');
      const after=await state();
      const samplesFile='frames-'+id+'.json';
      write(path.join(config.output,samplesFile),rows);
      const sorted=rows.map(f=>f.ms).sort((a,b)=>a-b);
      const ms=sorted.reduce((s,x)=>s+x,0);
      const valid=[before,after].every(s=>JSON.stringify(s.camera)===JSON.stringify(camera) && s.width===1440 && s.height===900 && s.dpr===1 && /RTX 3060 Laptop/.test(s.gpu) && !s.errors.length && !s.walking && s.ao===.55 && s.hidden) &&
        after.stationTime>before.stationTime && after.islandTime>before.islandTime && rows.length>1 && ms>=config.durationMs && rows.every(f=>f.ms>0 && f.calls>0 && f.triangles>0);
      const fps=1000*rows.length/ms,p95=sorted[Math.ceil(.95*rows.length)-1];
      report.segments.push({id,name,before,after,samplesFile,samplesSha256:hash(fs.readFileSync(path.join(config.output,samplesFile))),frameCount:rows.length,sampleMs:ms,fps,p95Ms:p95,maxMs:sorted.at(-1),over20ms:rows.filter(f=>f.ms>20).length,valid,meetsBudget:valid && fps>=60 && p95<=16.7}); save();
      if(!valid) throw Error('Invalid live measurement '+id);
    }
    report.stage='complete';
  } catch(e) {report.failure=e.stack||String(e);}
  finally {
    clearTimeout(timeout);
    report.transportClean=report.networkFailures.length===0;
    report.renderOk=!report.failure && report.segments.length===4 && report.segments.every(s=>s.valid) && report.exceptions.length===0;
    report.completedAt=new Date().toISOString();
    save(); server?.close(); win?.destroy();
    app.exit(report.renderOk && report.transportClean && report.segments.every(s=>s.meetsBudget) ? 0 : 1);
  }
}
if(process.versions.electron) host().catch(error=>{console.error(error); require('electron').app.exit(1);}); else launch();
