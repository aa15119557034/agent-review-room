const cp=require('node:child_process'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const fixture=path.resolve(__dirname,'../../../..'),root=process.env.WORLD_AUDIT_OUTPUT?path.resolve(process.env.WORLD_AUDIT_OUTPUT):null;
const expected=process.env.WORLD_AUDIT_HEAD||'b4f1350397fc00b1ff7320f1844788dd1d16b86e';
const {createStaticServer,cleanEnvironment}=require(path.join(fixture,'scripts/baseline.cjs'));
const {installGate}=require(path.join(fixture,'scripts/diagnose-surface.cjs'));
const diagnose=require('./x51-c28-motion-renderer.cjs');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const head=()=>cp.execFileSync('git',['rev-parse','HEAD'],{cwd:fixture,encoding:'utf8',windowsHide:true}).trim();
const save=(p,o)=>fs.writeFileSync(p,JSON.stringify(o,null,2)+'\n');
const sleep=ms=>new Promise(done=>setTimeout(done,ms));
const cameras=JSON.parse(fs.readFileSync(path.join(fixture,'evidence/c26-room-shell-ground-3060-2026-11-18/photos/measurements.json')));
const camera=cameras.pairs.evening.find(r=>r.view==='20-rear-eye').camera;
const versioned=['src/main.js','src/look.js','src/toon.js','src/toon.json','upstream/petalwake/src/core/pipeline.js'];
function sourceChecks(){return Object.fromEntries(versioned.map(name=>{const data=fs.readFileSync(path.join(fixture,name)),git=cp.execFileSync('git',['show',expected+':apps/desktop/e2e/fixtures/world-base/'+name],{cwd:fixture,windowsHide:true});return [name,{disk:hash(data),git:hash(git)}];}));}
function launch(){
  const audit=sourceChecks();if(Object.values(audit).some(s=>s.disk!==s.git)||head()!==expected)throw Error('Source mismatch');
  if(process.argv[2]==='--check'){console.log(JSON.stringify({cpuReady:true,source:expected,camera,files:Object.keys(audit).length}));return;}
  if(process.argv[2]!=='--capture')throw Error('Use --check or --capture');
  const scratch=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'c28-motion-run-')),runtime=path.join(scratch,'runtime'),log=fs.openSync(path.join(scratch,'electron.log'),'w');
  const executable=process.env.WORLD_ELECTRON; if(!executable||!fs.existsSync(executable))throw Error('Set WORLD_ELECTRON to an existing native Electron executable');
  const result=cp.spawnSync(executable,[__filename,scratch],{cwd:fixture,windowsHide:true,env:{...cleanEnvironment(runtime),WORLD_AUDIT_HEAD:expected},stdio:['ignore',log,log],timeout:300000});
  fs.closeSync(log);
  const evidencePath=path.join(scratch,'result.json');const evidence=fs.existsSync(evidencePath)?JSON.parse(fs.readFileSync(evidencePath)):{stage:'process terminated before report'};
  Object.assign(evidence,{processExit:result.status,processSignal:result.signal,processError:result.error?String(result.error):null,sourceBefore:audit,sourceAfter:sourceChecks(),sourceHeadAfter:head()});save(evidencePath,evidence);
  const good=result.status===0&&evidence.stage==='complete'&&evidence.gpu&&evidence.sourceHeadAfter===expected;
  if(good&&root){
    if(fs.existsSync(root))throw Error('Refusing to overwrite motion evidence');
    fs.mkdirSync(root,{recursive:true});
    for(const file of ['result.json',...Object.keys(evidence.assets)])fs.copyFileSync(path.join(scratch,file),path.join(root,file));
  }
  console.log(JSON.stringify({scratch,exit:result.status,stage:evidence.stage,good,output:good?(root||scratch):null,failure:evidence.failure,networkFailures:evidence.networkFailures?.length}));
  if(!good)process.exitCode=1;
}
async function host(){
  const {app,BrowserWindow}=require('electron'),scratch=process.argv[2],runtime=path.join(scratch,'runtime');
  app.setPath('userData',path.join(runtime,'user-data'));app.commandLine.appendSwitch('force-device-scale-factor','1');
  const report={source:expected,stage:'starting',started:new Date().toISOString(),versions:{electron:process.versions.electron,chrome:process.versions.chrome},networkFailures:[],httpErrors:[],exceptions:[]};
  const write=()=>save(path.join(scratch,'result.json'),report);const stage=s=>{report.stage=s;write();};
  let server,win,timer;
  try{await Promise.race([(async()=>{
    await app.whenReady();server=createStaticServer(fixture);await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
    win=new BrowserWindow({width:1440,height:900,useContentSize:true,show:false,paintWhenInitiallyHidden:true,autoHideMenuBar:true,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
    await win.loadURL('about:blank');const dbg=win.webContents.debugger;dbg.attach('1.3');
    const requests=new Map();
    dbg.on('message',(_,m,p)=>{
      if(m==='Network.requestWillBeSent')requests.set(p.requestId,new URL(p.request.url).pathname);
      if(m==='Network.loadingFailed')report.networkFailures.push({path:requests.get(p.requestId),error:p.errorText,canceled:p.canceled});
      if(m==='Network.responseReceived'&&p.response.status>=400)report.httpErrors.push({path:new URL(p.response.url).pathname,status:p.response.status});
      if(m==='Runtime.exceptionThrown')report.exceptions.push({text:p.exceptionDetails.exception?.description||p.exceptionDetails.text});
    });
    for(const scope of ['Page','Network','Runtime'])await dbg.sendCommand(scope+'.enable');
    await dbg.sendCommand('Page.addScriptToEvaluateOnNewDocument',{source:'('+installGate.toString()+')()'});
    stage('loading');await win.loadURL('http://127.0.0.1:'+server.address().port+'/');
    const exec=code=>win.webContents.executeJavaScript(code,true);
    while(!await exec('Boolean(window.worldBase?.ready)')){const errors=await exec('window.worldBase?.errors||[]');if(errors.length)throw Error(errors.join('\n'));await sleep(125);}
    stage('native sample');const received=await exec('('+diagnose.toString()+')('+JSON.stringify(camera)+')');
    stage('ground controls, glazing and small pan');const additional=await exec('('+require('./x51-c28-motion-extra.cjs').toString()+')('+JSON.stringify(Object.fromEntries(cameras.pairs.evening.filter(c=>['station-street','shop-door-eye','van-side'].includes(c.view)).map(c=>[c.view,c.camera])))+')');
    const outputs={...received.outputs,...additional.images};delete additional.images;received.groundChecks=additional;delete received.outputs;Object.assign(report,received);report.assets={};
    for(const [name,url] of Object.entries(outputs)){const buffer=Buffer.from(url.split(',')[1],'base64');fs.writeFileSync(path.join(scratch,name),buffer);report.assets[name]={sha256:hash(buffer),bytes:buffer.length};}
    if(report.errors.length||report.exceptions.length||report.httpErrors.length)throw Error('Renderer errors');
    const cases=report.meta;
    if(cases.off.strength!==0||cases.on.strength<=0||cases['on-no-line'].lines!==0||cases.on.lines!==cases['on-repeat'].lines)throw Error('Control replay invalid');
    stage('complete');
  })(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Timed out at '+report.stage)),255000)})]);}
  catch(e){report.failure=String(e.stack||e);stage('failed');}
  finally {clearTimeout(timer);report.finished=new Date().toISOString();write();win?.destroy();server?.close();app.exit(report.stage==='complete'?0:1);}
}
if(process.versions.electron)host().catch(e=>{console.error(e);require('electron').app.exit(1);});else launch();
