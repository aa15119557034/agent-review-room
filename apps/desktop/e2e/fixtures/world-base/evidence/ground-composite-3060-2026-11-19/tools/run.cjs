'use strict';
const fs=require('node:fs'), path=require('node:path'), cp=require('node:child_process'), crypto=require('node:crypto'), zlib=require('node:zlib'), assert=require('node:assert/strict');
const [electron,fixture,auditPath,output]=process.argv.slice(2);
const {createStaticServer,cleanEnvironment}=require(path.join(auditPath,'scripts/baseline.cjs'));
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const rt=path.join(output,'runtime');
if(!process.versions.electron){fs.mkdirSync(output);fs.mkdirSync(rt);const child=cp.spawnSync(electron,[__filename,electron,fixture,auditPath,output],{cwd:fixture,env:cleanEnvironment(rt),windowsHide:true,stdio:'inherit'});if(child.error)throw child.error;process.exit(child.status??1);}
const {installGate}=require(path.join(fixture,'scripts/diagnose-surface.cjs'));
const {createTransportAudit}=require(path.join(auditPath,'scripts/acceptance-transport.cjs'));
const {app,BrowserWindow}=require('electron');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const report={head:cp.execFileSync('git',['rev-parse','HEAD'],{cwd:fixture,encoding:'utf8'}).trim(),start:new Date().toISOString(),photos:{},timings:[],exceptions:[],network:[]};
const save=(step)=>{report.step=step;fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n');};
let win,server;const wd=setTimeout(()=>{report.failure='Watchdog '+report.step;save('timeout');app.exit(1);},360000);
async function main(){
  app.setPath('userData',path.join(rt,'user'));app.commandLine.appendSwitch('force-device-scale-factor','1');await app.whenReady();
  const audit=createTransportAudit();server=createStaticServer(fixture,audit);await new Promise((ok,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',ok);});
  win=new BrowserWindow({width:1440,height:900,useContentSize:true,show:false,autoHideMenuBar:true,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});win.showInactive();
  const wc=win.webContents, ev=s=>wc.executeJavaScript(s),cdp=(m,v)=>wc.debugger.sendCommand(m,v);
  await wc.loadURL('about:blank');wc.debugger.attach('1.3');wc.debugger.on('message',(_,m,x)=>{audit.cdp(m,x);if(m==='Network.loadingFailed')report.network.push({id:x.requestId,type:x.type,error:x.errorText,canceled:x.canceled===true});if(m==='Runtime.exceptionThrown')report.exceptions.push(x.exceptionDetails.text);});
  for(const m of ['Page.enable','Network.enable','Runtime.enable'])await cdp(m);
  await cdp('Page.addScriptToEvaluateOnNewDocument',{source:'('+installGate.toString()+')()'});await cdp('Page.addScriptToEvaluateOnNewDocument',{source:audit.pageSource});
  save('loading');await wc.loadURL('http://127.0.0.1:'+server.address().port+'/');
  while(!await ev('window.worldBase?.ready===true')){assert.deepEqual(await ev('window.worldBase?.errors||[]'),[]);await delay(200);}
  await ev('(()=>{const b=document.getElementById("go");if(b&&!b.disabled)b.click();document.body.classList.add("hide-ui");})()');
  report.setup=await ev('('+require('./page.cjs').toString()+')()');
  const views=['art-a-street','art-b-konbini','art-c-alley','art-d-laundry','sample-e-harbour','sample-f-hillside','sample-g-rail','sample-h-north'];
  for(const [i,name] of [...views,'art-a-street','art-b-konbini'].entries()){
    const motion=i>=views.length,key=(motion?'motion-':'')+name;save('pixels '+key);
    const trials=[];for(const [run,single] of [['old',false],['new',true],['restore',false]]) {
      const im=await ev('__compProbe.snap('+JSON.stringify(name)+','+single+','+motion+')');
      const bytes=Buffer.from(im.png,'base64');delete im.png;im.pngSHA=sha(bytes);
      assert.equal(im.glError,0,'GL readback '+key);assert(im.masked>0&&im.masked<1440*900,'Expected alpha mask '+im.masked);
      assert.equal(im.overlayCount,1);assert.equal(im.scene.samples,4);assert(im.scene.depth>0);
      assert.equal(im.comp.samples,single?0:4);assert.equal(im.comp.depth===0,single);
      assert.equal(im.time,14);if(motion)assert(im.blur>0);
      trials.push({run,...im});if(run!=='restore')fs.writeFileSync(path.join(output,key+'-'+run+'.png'),bytes);
    }
    report.photos[key]=trials;save('captured '+key);
  }
  await ev('__compProbe.ready()');await delay(1300);save('timing');
  const measurements=[];
  for(const [index,single] of [false,true,true,false].entries()){
    await ev('__compProbe.setMode('+single+')');await delay(1300);
    for(const instrumented of [false,true]) {
      await ev('__compProbe.start('+instrumented+')');await delay(instrumented?2700:4200);await ev('__compProbe.stop()');
      const t=await ev('__compProbe.take()');assert(t.raf.length>=90);assert.equal(t.disjoint,0);assert(t.overlays>=t.raf.length);if(instrumented)assert(t.frame.length>12&&t.copy.length>12);
      measurements.push({index,single,instrumented,...t});
      const pct=(a,p)=>[...a].sort((x,y)=>x-y)[Math.ceil(a.length*p)-1]??null;
      report.timings.push({index,single,instrumented,n:t.raf.length,fps:1000*t.raf.length/t.raf.reduce((a,b)=>a+b,0),p95:pct(t.raf,.95),copyGPU:pct(t.copy,.5),frameGPU:pct(t.frame,.5),disjoint:t.disjoint});
      fs.writeFileSync(path.join(output,'intervals.json.gz'),zlib.gzipSync(JSON.stringify(measurements)));save('timing '+index+' '+instrumented);
    }
  }
  await ev('__compProbe.restore()');assert.deepEqual(report.exceptions,[]);report.ok=true;save('complete');
}
main().catch(e=>{report.failure=e.stack||String(e);save('failed');}).finally(()=>{clearTimeout(wd);win?.destroy();server?.close();app.exit(report.ok?0:1);});
