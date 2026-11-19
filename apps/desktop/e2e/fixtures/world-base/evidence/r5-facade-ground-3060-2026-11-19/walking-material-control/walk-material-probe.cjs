'use strict';
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),assert=require('node:assert/strict');
const [electron,fixture,auditRoot,out]=process.argv.slice(2);
const {createStaticServer,cleanEnvironment}=require(path.join(auditRoot,'scripts/baseline.cjs'));
const {createTransportAudit}=require(path.join(auditRoot,'scripts/acceptance-transport.cjs'));
if(!process.versions.electron) {
  fs.mkdirSync(out);
  const runtime=path.join(out,'runtime');fs.mkdirSync(runtime);
  const child=cp.spawnSync(electron,[__filename,electron,fixture,auditRoot,out],
    {cwd:fixture,env:cleanEnvironment(runtime),windowsHide:true,stdio:'inherit'});
  if(child.error)throw child.error;
  process.exit(child.status??1);
}
const {app,BrowserWindow}=require('electron');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const report={started:new Date().toISOString(),runs:[],errors:[],ignoredRequests:[]};
function save(step){report.step=step;fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));}
const percentile=(values,z)=>[...values].sort((a,b)=>a-b)[Math.ceil(z*values.length)-1]??null;
const dist=(a,b)=>Math.hypot(a[0]-b[0],a[2]-b[2]);
let win,server;
const watchdog=setTimeout(()=>{report.failure='Timed out at '+report.step;save('timeout');app.exit(1);},180000);
async function run() {
  app.setPath('userData',path.join(out,'runtime/user'));
  app.commandLine.appendSwitch('force-device-scale-factor','1');
  for(const s of ['disable-backgrounding-occluded-windows','disable-renderer-backgrounding','disable-background-timer-throttling'])app.commandLine.appendSwitch(s);
  app.commandLine.appendSwitch('disable-features','CalculateNativeWinOcclusion');
  await app.whenReady();
  const audit=createTransportAudit();
  server=createStaticServer(fixture,audit);await new Promise((ok,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',ok);});
  win=new BrowserWindow({width:1440,height:900,useContentSize:true,show:false,autoHideMenuBar:true,
    webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  win.showInactive();
  const wc=win.webContents,ev=s=>wc.executeJavaScript(s),cdp=(m,o)=>wc.debugger.sendCommand(m,o);
  await wc.loadURL('about:blank');wc.debugger.attach('1.3');
  wc.debugger.on('message',(_,m,p)=>{audit.cdp(m,p);if(m==='Runtime.exceptionThrown')report.errors.push(p.exceptionDetails.text);});
  for(const m of ['Page.enable','Runtime.enable','Network.enable'])await cdp(m);
  await cdp('Page.addScriptToEvaluateOnNewDocument',{source:audit.pageSource});
  save('loading');await wc.loadURL('http://127.0.0.1:'+server.address().port+'/');
  while(!await ev('window.worldBase?.ready===true')){assert.deepEqual(await ev('window.worldBase?.errors||[]'),[]);await delay(130);}
  await ev("(()=>{const b=document.getElementById('go');if(b&&!b.disabled)b.click();document.body.classList.add('hide-ui');})()");
  report.setup=await ev('('+require('./walk-material-probe-page.cjs').toString()+')()');
  for(const v of [false,true]) {
    await ev("window.__walkProbe.variant("+v+");window.worldBase.setView('art-c-alley')");
    await delay(900);
    await ev('window.__walkProbe.start(false)');await delay(800);
    const warm=await ev('window.__walkProbe.stop()');assert(warm.mainCalls>0,'Draw instrumentation was inactive on C');
    (report.calibration??=[]).push({v,draws:warm.mainCalls,frames:warm.frames,facade:warm.facadeCalls});
  }
  assert.equal((await ev('window.__walkProbe.stripped()')).length,4);
  const key=type=>cdp('Input.dispatchKeyEvent',{type,key:'w',code:'KeyW',nativeVirtualKeyCode:87,windowsVirtualKeyCode:87});
  for(const [i,refined] of [false,true,true,false,false,true,true,false].entries()) {
    const timed=i>=4;
    save('walking '+i);
    await ev('window.__walkProbe.variant('+refined+');window.worldBase.startWalking();window.worldBase.walker.setView("third");');
    await delay(1150);
    await ev('window.__walkProbe.start('+timed+')');
    await key('keyDown');
    try{await delay(3300);}finally{await key('keyUp');}
    const t=await ev('window.__walkProbe.stop()');
    assert(t.frames>=110 && t.raf.length===t.frames-1 && dist(t.start,t.end)>5);
    assert.equal(t.mode,'third');assert.deepEqual(t.keys,[{kind:'keydown',trusted:true},{kind:'keyup',trusted:true}]);
    assert.equal(t.disjoint,0);if(timed)assert(t.gpu.length>=15);
    if(report.runs.length)assert(dist(report.runs[0].start,t.start)<.05,'Walking spawn differs');
    const raw='round-'+i+'.json';fs.writeFileSync(path.join(out,raw),JSON.stringify(t));
    report.runs.push({i,refined,timed,frames:t.frames,distance:dist(t.start,t.end),start:t.start,end:t.end,eye:t.eye,
      mainCalls:t.mainCalls,facadeCalls:t.facadeCalls,p50:percentile(t.raf,.5),p95:percentile(t.raf,.95),
      fps:1000*t.raf.length/t.raf.reduce((a,b)=>a+b),gpu50:percentile(t.gpu,.5),gpu95:percentile(t.gpu,.95),
      nQueries:t.gpu.length,disjoint:t.disjoint,raw});save('captured '+i);
  }
  assert.deepEqual(report.errors,[]);assert.deepEqual(await ev('window.worldBase.errors'),[]);
  report.ok=true;save('complete');
}
run().catch(e=>{report.failure=e.stack||String(e);save('failed');}).finally(()=>{clearTimeout(watchdog);win?.destroy();server?.close();app.exit(report.ok?0:1);});
