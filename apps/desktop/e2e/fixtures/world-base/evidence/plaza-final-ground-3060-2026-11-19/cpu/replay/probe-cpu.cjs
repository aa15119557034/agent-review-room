// Run this script from Node with an installed Electron executable and a new output file.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const cp = require('node:child_process'), assert = require('node:assert/strict');
const fixture = path.resolve(process.env.WORLD_FIXTURE || path.join(__dirname, '../..'));
const {cleanEnvironment, createStaticServer} = require(path.join(fixture, 'scripts/baseline.cjs'));
if (!process.versions.electron) {
  const [exe, output] = process.argv.slice(2);
  assert(exe && output, 'node probe-cpu.cjs <Electron executable> <new JSON output file>');
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(),'station-art-geometry-'));
  const result = cp.spawnSync(exe,[__filename, path.resolve(output)],{cwd: fixture, env: {...cleanEnvironment(runtime), WORLD_FIXTURE: fixture}, stdio:'inherit', windowsHide:true});
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}
const {app,BrowserWindow}=require('electron');
app.disableHardwareAcceleration();app.commandLine.appendSwitch('disable-gpu');
app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'station-art-profile-')));
function diagnosticServer() {
  const server=createStaticServer(fixture), original=server.listeners('request')[0];
  server.removeListener('request',original);
  server.on('request',(req,res)=>{
    if(req.url!=='/src/main.js' && req.url!=='/src/weathering-decals.js')return original(req,res);
    let src=fs.readFileSync(path.join(fixture,req.url.slice(1)),'utf8');
    if(req.url==='/src/weathering-decals.js')src=src.replace("else source = 'planned (scene changed)'", "else throw Error('JOINT_REFERENCE_KEY:' + fingerprint(collectTargets(roots)))");
    if(req.url==='/src/weathering-decals.js')src+='\nexport {collectTargets,fingerprint};';
    else {
      const constructor="new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' })";
      const replacement="({domElement:canvas,shadowMap:{},capabilities:{getMaxAnisotropy:()=>8,reversedDepthBuffer:false},info:{},setRenderTarget(){},setClearColor(){},clear(){},setScissorTest(){},setScissor(){},setViewport(){},render(){},getRenderTarget(){return null},getClearColor(c){return c.set(0)},getClearAlpha(){return 1},setSize(){},setPixelRatio(){},getPixelRatio(){return 1},getDrawingBufferSize(v){return v.set(1440,900)}})";
      assert(src.includes(constructor));src=src.replace(constructor,replacement);
      src=src.replace('const canvas =',"const originalGetContext=HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext=function(t,...args){if(/webgl/i.test(t))throw Error('Unexpected WebGL context request');return originalGetContext.call(this,t,...args)};const canvas =");
      const ready="  stage('场景已就绪');";assert(src.includes(ready));
      src=src.replace(ready,ready+' window.__stationAuditReady=true; return;');
    }
    res.writeHead(200,{'Content-Type':'application/javascript','Cache-Control':'no-store'}).end(src);
  });
  return server;
}
(async()=>{
  const out=process.argv[2];assert(!fs.existsSync(out),'Choose a new results file');
  await app.whenReady();
  const server=diagnosticServer();await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
  const win=new BrowserWindow({show:false,width:1440,height:900,webPreferences:{sandbox:true,nodeIntegration:false,contextIsolation:true,backgroundThrottling:false}});
  const timer=setTimeout(()=>app.exit(1),200000);
  try{
    const wc=win.webContents;await wc.loadURL('http://127.0.0.1:'+server.address().port+'/');
    for(;;){const x=await wc.executeJavaScript('({ready:window.__stationAuditReady,errors:window.worldBase?.errors||[]})');assert.deepEqual(x.errors,[]);if(x.ready)break;await new Promise(ok=>setTimeout(ok,300));}
    const observed=await wc.executeJavaScript(`(async()=>{const w=window.worldBase,{collectTargets,fingerprint}=await import('./src/weathering-decals.js');const roots=[w.station.root,w.city.root,w.skyline.root];roots.forEach(r=>r.updateMatrixWorld(true));w.cpuFingerprint=fingerprint(collectTargets(roots));window.__surfaceGate={freeze(){}};return {source:w.weatheringDecals.stats.source,rays:w.weatheringDecals.stats.rays,items:w.weatheringDecals.plan.items,fingerprint:w.cpuFingerprint};})()`);
    const repo='apps/desktop/e2e/fixtures/world-base/';
    const original=JSON.parse(cp.execFileSync('git',['show','47a5c12:'+repo+'src/weathering-decals.json'],{cwd:fixture,encoding:'utf8'}));
    const parameters=JSON.parse(fs.readFileSync(path.join(fixture,'src/weathering.json'),'utf8'));
    assert.deepEqual(observed.items,original.items);assert.equal(observed.source,'baked');assert.equal(observed.rays,0);
    const checker=require(path.join(fixture,'evidence/art-r2-ground-3060-2026-11-18/validate-decals.cjs'));
    const samples=await wc.executeJavaScript('('+checker.toString()+')('+JSON.stringify(original)+','+JSON.stringify(parameters.decals.explicit)+')');
    const state=await wc.executeJavaScript('('+require(path.join(__dirname,'geometry.cjs')).toString()+')()');
    assert.equal(samples.rows.length,26);
    assert.equal(samples.rows.filter(r=>r.ninePass).length,22);
    assert.equal(samples.rows.filter(r=>r.curvedException&&r.curvedSnap.atSourceDirective.pass).length,4);
    assert(samples.rows.every(r=>r.extraGeometryInFront===0));
    fs.writeFileSync(out,JSON.stringify({observed,state,samples},null,2)+'\n',{flag:'wx'});
    console.log(observed.fingerprint,observed.source,observed.rays,'22 planar and 4 original curved decal supports');
  }finally{clearTimeout(timer);win.destroy();server.close();}
  app.exit(0);
})().catch(error=>{console.error(error);app.exit(1);});
