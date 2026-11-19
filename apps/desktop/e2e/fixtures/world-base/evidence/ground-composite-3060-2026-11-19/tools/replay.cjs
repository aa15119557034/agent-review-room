'use strict';
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const http=require('node:http'),crypto=require('node:crypto'),assert=require('node:assert/strict'),zlib=require('node:zlib');
const [electron,fixture,auditFixture,out,expected,base]=process.argv.slice(2);
const src='apps/desktop/e2e/fixtures/world-base/upstream/petalwake/src/core/pipeline.js';
const currentFile=path.join(fixture,'upstream/petalwake/src/core/pipeline.js');
const git=(...args)=>cp.execFileSync('git',args,{cwd:fixture,windowsHide:true});
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const {createStaticServer,cleanEnvironment}=require(path.join(auditFixture,'scripts/baseline.cjs'));
const runtime=path.join(out,'runtime');
if(!process.versions.electron){
  assert.equal(git('rev-parse','HEAD').toString().trim(),expected);assert(fs.readFileSync(currentFile).equals(git('cat-file','blob',expected+':'+src)),'Changed pipeline');
  fs.mkdirSync(out);fs.mkdirSync(runtime);
  const child=cp.spawnSync(electron,[__filename,...process.argv.slice(2)],{cwd:fixture,env:cleanEnvironment(runtime),windowsHide:true,stdio:'inherit'});
  if(child.error)throw child.error;process.exit(child.status??1);
}
const {app,BrowserWindow,nativeImage}=require('electron');
const {installGate}=require(path.join(fixture,'scripts/diagnose-surface.cjs'));
const {createTransportAudit}=require(path.join(auditFixture,'scripts/acceptance-transport.cjs'));
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const reference=git('cat-file','blob',base+':'+src),name='/upstream/petalwake/src/core/ground-comparison-reference.js';
const report={source:expected,baseline:base,currentPipelineSHA256:sha(fs.readFileSync(currentFile)),baselinePipelineSHA256:sha(reference),
  startedAt:new Date().toISOString(),photos:{},exceptions:[],network:[]};
let win,server;
const save=stage=>{report.stage=stage;fs.writeFileSync(path.join(out,'replay.json'),JSON.stringify(report,null,2)+'\n');};
const watchdog=setTimeout(()=>{report.failure='Timeout during '+report.stage;save('timeout');app.exit(1);},360000);
function comparePNG(a,b){
  const ref=nativeImage.createFromBuffer(a),probe=nativeImage.createFromBuffer(b);
  assert.deepEqual(ref.getSize(),{width:1440,height:900});assert.deepEqual(probe.getSize(),ref.getSize());
  const l=ref.toBitmap(),r=probe.toBitmap(),channels=[0,0,0,0],max=[0,0,0,0];let pixels=0;
  for(let i=0;i<l.length;i+=4){let changed=false;for(let c=0;c<4;c++){
    const v=Math.abs(l[i+c]-r[i+c]);if(v){changed=true;channels[c]++;max[c]=Math.max(max[c],v);}
  }if(changed)pixels++;}
  return {pixels,channelsBGRA:channels,maxLevelsBGRA:max};
}
async function main(){
  app.setPath('userData',path.join(runtime,'user'));app.commandLine.appendSwitch('force-device-scale-factor','1');await app.whenReady();
  const audit=createTransportAudit(),fixtureServer=createStaticServer(fixture,audit);
  server=http.createServer((req,res)=>{
    if(req.url===name){audit.start(req,res);audit.generated(req,reference);
      res.writeHead(200,{'Content-Type':'text/javascript','Content-Length':reference.length,'Cache-Control':'no-store'});res.end(reference);}
    else fixtureServer.emit('request',req,res);
  });
  await new Promise((ok,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',ok);});
  const origin='http://127.0.0.1:'+server.address().port;
  win=new BrowserWindow({width:1440,height:900,useContentSize:true,show:false,autoHideMenuBar:true,
    webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});win.showInactive();
  const wc=win.webContents,ev=s=>wc.executeJavaScript(s),cdp=(m,v)=>wc.debugger.sendCommand(m,v);
  await wc.loadURL('about:blank');wc.debugger.attach('1.3');const requests=new Map(),failures=[],httpErrors=[];
  wc.debugger.on('message',(_,m,x)=>{audit.cdp(m,x);
    if(m==='Network.requestWillBeSent')requests.set(x.requestId,{requestId:x.requestId,url:x.request.url});
    if(m==='Network.loadingFailed')failures.push({...requests.get(x.requestId),...x});
    if(m==='Network.responseReceived'&&x.response.status>=400)httpErrors.push({url:x.response.url,status:x.response.status,requestId:x.requestId});
    if(m==='Runtime.exceptionThrown')report.exceptions.push(x.exceptionDetails.text);
  });
  for(const m of ['Page.enable','Network.enable','Runtime.enable'])await cdp(m);
  await cdp('Page.addScriptToEvaluateOnNewDocument',{source:'('+installGate.toString()+')()'});
  await cdp('Page.addScriptToEvaluateOnNewDocument',{source:audit.pageSource});
  save('loading');await wc.loadURL(origin+'/');
  while(!await ev('window.worldBase?.ready===true')){assert.deepEqual(await ev('window.worldBase?.errors||[]'),[]);await pause(200);}
  await ev('(()=>{const b=document.getElementById("go");if(b&&!b.disabled)b.click();document.body.classList.add("hide-ui");})()');
  report.setup=await ev('('+require('./replay-page.cjs').toString()+')('+JSON.stringify(origin+name)+')');
  const views=['art-a-street','art-b-konbini','art-c-alley','art-d-laundry','sample-e-harbour','sample-f-hillside','sample-g-rail','sample-h-north'];
  for(const [i,view] of [...views,...views.slice(0,2)].entries()){
    const motion=i>=8,id=(motion?'motion-':'')+view;save('capturing '+id);
    const row=await ev('__compositeReplay.snapshot('+JSON.stringify(view)+','+motion+')'),images={};
    for(const [arm,data] of Object.entries(row.pngs))images[arm]=Buffer.from(data,'base64');delete row.pngs;
    row.pngSHA=Object.fromEntries(Object.entries(images).map(([arm,b])=>[arm,sha(b)]));
    row.finalPixels={after:comparePNG(images.before,images.after),restore:comparePNG(images.before,images.restore)};
    for(const arm of ['before','after'])fs.writeFileSync(path.join(out,id+'-'+arm+'.png'),images[arm]);
    report.photos[id]=row;save('captured '+id);
    assert.equal(row.clock,14);assert.equal(row.lighting,'evening');assert.equal(row.worldSkips,3);
    assert.equal(new Set(row.trials.map(t=>t.colorSHA)).size,1,'World color changed '+id);
    assert.equal(new Set(row.trials.map(t=>t.depthSHA)).size,1,'World depth changed '+id);
    assert(row.trials.every(t=>t.nonOpaque>0&&t.nonOpaque<1440*900&&(!motion||t.blur>0)),'Outline or motion mask '+id);
    assert.equal(row.trials[2].delta.pixels,0,'Control HDR drift '+id);
    assert.equal(row.finalPixels.restore.pixels,0,'Control display drift '+id);
  }
  save('foreground and resize');report.foreground=await ev('__compositeReplay.fallback()');
  await ev('__compositeReplay.restore()');
  const transfer=await audit.finish({origin,failures,httpErrors,readPage:ev});
  fs.writeFileSync(path.join(out,'transport.json.gz'),zlib.gzipSync(JSON.stringify(transfer)));
  report.network={serverRequests:transfer.served.length,filesComplete:transfer.served.filter(x=>x.finished&&x.sha256===x.wireSHA256).length,
    payloadIntegrityClean:transfer.payloadIntegrityClean,reportedErrors:failures.map(x=>({url:new URL(x.url).pathname,error:x.errorText})),httpErrors,problems:transfer.problems};
  assert(transfer.payloadIntegrityClean,JSON.stringify(transfer.problems));assert.deepEqual(report.exceptions,[]);
  report.ok=true;report.finishedAt=new Date().toISOString();save('complete');
}
main().catch(e=>{report.failure=e.stack||String(e);save('failed');}).finally(()=>{clearTimeout(watchdog);win?.destroy();server?.close();app.exit(report.ok?0:1);});
