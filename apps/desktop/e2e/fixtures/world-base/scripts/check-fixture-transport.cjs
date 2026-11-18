// Rebuild the normal fixture and load its real resources in Electron without WebGL.
const fs=require('node:fs'), path=require('node:path'), os=require('node:os'), cp=require('node:child_process');
const assert=require('node:assert/strict');
const {createStaticServer, cleanEnvironment}=require('./baseline.cjs');
const {createTransportAudit}=require('./acceptance-transport.cjs');
const args=process.argv.slice(2);
const arg=name=>args.find(s=>s.startsWith('--'+name+'='))?.slice(name.length+3);
const fixture=path.resolve(arg('fixture') || path.join(__dirname,'..'));
const out=arg('output');
if(!out) throw Error('Pass --output=<new report JSON>');
if(!process.versions.electron){
  const electron=arg('electron');assert(electron,'Pass --electron=<existing executable>');
  const runtime=fs.mkdtempSync(path.join(os.tmpdir(),'fixture-transport-'));
  const result=cp.spawnSync(electron,[__filename,...args],{cwd:fixture,env:cleanEnvironment(runtime),stdio:'inherit',windowsHide:true});
  if(result.error)throw result.error;process.exit(result.status??1);
}
const {app,BrowserWindow}=require('electron');
app.disableHardwareAcceleration();app.commandLine.appendSwitch('disable-gpu');
app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'fixture-reader-profile-')));
function softwareScene(root){
  const constructor="new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' })";
  const renderer='({domElement:canvas,shadowMap:{},capabilities:{getMaxAnisotropy:()=>8,reversedDepthBuffer:false},info:{},setRenderTarget(){},setClearColor(){},clear(){},setScissorTest(){},setScissor(){},setViewport(){},render(){},getRenderTarget(){return null},getClearColor(c){return c.set(0)},getClearAlpha(){return 1},setSize(){},setPixelRatio(){},getPixelRatio(){return 1},getDrawingBufferSize(v){return v.set(1440,900)}})';
  const gate="const get=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(name,...args){if(/webgl/i.test(name))throw Error('unexpected WebGL context');return get.call(this,name,...args)};";
  let code=fs.readFileSync(path.join(root,'src/main.js'),'utf8');
  for(const [anchor,replacement] of [[constructor,renderer],['const canvas =',gate+'const canvas ='],["  stage('场景已就绪');","  stage('场景已就绪');window.__transportSceneBuilt=true;return;"]]){
    assert.equal(code.split(anchor).length,2,'CPU scene anchor: '+anchor);code=code.replace(anchor,()=>replacement);
  }
  return code;
}
(async()=>{
  assert(!fs.existsSync(out),'Choose a new output path');
  await app.whenReady();
  const audit=createTransportAudit(),server=createStaticServer(fixture,audit);
  const serve=server.listeners('request')[0],code=softwareScene(fixture);
  server.removeListener('request',serve);
  server.on('request',(req,res)=>{
    if(req.url!=='/src/main.js')return serve(req,res);
    audit.start(req,res);audit.generated(req,code);
    res.writeHead(200,{'Content-Type':'application/javascript','Content-Length':Buffer.byteLength(code),'Cache-Control':'no-store'}).end(code);
  });
  await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
  const origin='http://127.0.0.1:'+server.address().port;
  const win=new BrowserWindow({show:false,width:1440,height:900,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  const wc=win.webContents,failures=[],httpErrors=[],exceptions=[],urls=new Map();
  const timer=setTimeout(()=>{console.error('CPU scene timeout');app.exit(2);},180000);
  try{
    await wc.loadURL('about:blank');const dbg=wc.debugger;dbg.attach('1.3');
    dbg.on('message',(_e,method,v)=>{
      audit.cdp(method,v);
      if(method==='Network.requestWillBeSent')urls.set(v.requestId,v.request.url);
      if(method==='Network.loadingFailed')failures.push({...v,url:urls.get(v.requestId)});
      if(method==='Network.responseReceived'&&v.response.status>=400)httpErrors.push({requestId:v.requestId,url:v.response.url,status:v.response.status});
      if(method==='Runtime.exceptionThrown')exceptions.push(v.exceptionDetails?.exception?.description||v.exceptionDetails?.text);
    });
    for(const method of ['Page.enable','Runtime.enable','Network.enable'])await dbg.sendCommand(method);
    await dbg.sendCommand('Page.addScriptToEvaluateOnNewDocument',{source:audit.pageSource});
    await wc.loadURL(origin+'/');
    let state;
    do{
      await new Promise(ok=>setTimeout(ok,200));
      state=await wc.executeJavaScript('({ready:window.__transportSceneBuilt,errors:window.worldBase?.errors||[]})');
      if(state.errors.length||exceptions.length)break;
    }while(!state.ready);
    const transport=await audit.finish({origin,failures,httpErrors,readPage:s=>wc.executeJavaScript(s)});
    const result={fixtureSource:cp.execFileSync('git',['rev-parse','HEAD'],{cwd:fixture,encoding:'utf8'}).trim(),
      ready:!!state.ready,sceneErrors:state.errors,exceptions,
      networkFailures:failures.map(({requestId,url,type,errorText,canceled})=>({requestId,url,type,errorText,canceled})),
      httpErrors,transport,
      ok:!!state.ready&&!state.errors.length&&!exceptions.length&&transport.payloadIntegrityClean};
    fs.mkdirSync(path.dirname(path.resolve(out)),{recursive:true});
    fs.writeFileSync(out,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
    console.log(JSON.stringify({ready:result.ready,ok:result.ok,strictTransportClean:transport.strictTransportClean,
      requests:transport.requests.length,reads:transport.reads.length,proven:transport.verifiedCanceled.length,
      problems:transport.problems.slice(0,5),errors:[...state.errors,...exceptions].slice(0,2)}));
    if(!result.ok)process.exitCode=1;
  }finally{clearTimeout(timer);win.destroy();server.close();}
  app.exit(process.exitCode||0);
})().catch(e=>{console.error(e);app.exit(1)});
