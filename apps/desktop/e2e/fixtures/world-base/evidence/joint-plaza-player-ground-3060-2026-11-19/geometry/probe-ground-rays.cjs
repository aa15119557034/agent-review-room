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
app.disableHardwareAcceleration();app.commandLine.appendSwitch('disable-gpu');app.commandLine.appendSwitch('disable-webgl');
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
      src=src.replace(ready,ready+' window.__stationAuditReady=true; return;');const coast='station.createWalker(canvas, coastWalking(station, island))';assert.equal(src.split(coast).length,2);src=src.replace(coast,'station.createWalker(canvas, worldBase.__probeCoast=coastWalking(station, island))');
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
    const result=await wc.executeJavaScript('('+require('./ground-rays.cjs').toString()+')()');fs.writeFileSync(out,JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(result.map(v=>[v.name,v.topGround,v.capsule]));
  }finally{clearTimeout(timer);win.destroy();server.close();}
  app.exit(0);
})().catch(error=>{console.error(error);app.exit(1);});
