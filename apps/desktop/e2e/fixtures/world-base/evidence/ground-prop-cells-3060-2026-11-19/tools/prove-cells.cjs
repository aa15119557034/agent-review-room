'use strict';
const fs=require('node:fs'),p=require('node:path'),cp=require('node:child_process'),z=require('node:zlib'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const [fixture,exe,auditDir,out,source,mode]=process.argv.slice(2),rt=p.join(out,'runtime'),sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const {createStaticServer,cleanEnvironment}=require(p.join(auditDir,'scripts/baseline.cjs'));
if(!process.versions.electron){assert.equal(cp.execFileSync('git',['rev-parse','HEAD'],{cwd:fixture,encoding:'utf8'}).trim(),source);fs.mkdirSync(out);fs.mkdirSync(rt);
  const a=cp.spawnSync(exe,[__filename,...process.argv.slice(2)],{cwd:fixture,env:cleanEnvironment(rt),windowsHide:true,stdio:'inherit'});if(a.error)throw a.error;process.exit(a.status??1);}
const {app,BrowserWindow,nativeImage}=require('electron'),{installGate}=require(p.join(fixture,'scripts/diagnose-surface.cjs')),{createTransportAudit}=require(p.join(auditDir,'scripts/acceptance-transport.cjs'));
const report={source,mode,views:{},exceptions:[]};let win,server;
const save=stage=>{report.stage=stage;fs.writeFileSync(p.join(out,'proof.json'),JSON.stringify(report,null,2)+'\n');};
const timer=setTimeout(()=>{report.failure='Timeout at '+report.stage;save('timeout');app.exit(1);},350000);
function compare(name,row,first){
  const imgs={};for(const [arm,encoded] of Object.entries(row.pngs))imgs[arm]=Buffer.from(encoded,'base64');delete row.pngs;
  const ref=nativeImage.createFromBuffer(imgs[first]).toBitmap();row.png={};
  for(const [arm,bytes] of Object.entries(imgs)){const img=nativeImage.createFromBuffer(bytes);assert.deepEqual(img.getSize(),{width:1440,height:900});
    const buf=img.toBitmap();let pixels=0,max=0,over2=0;for(let i=0;i<buf.length;i+=4){let m=0;for(let c=0;c<4;c++)m=Math.max(m,Math.abs(buf[i+c]-ref[i+c]));if(m)pixels++;if(m>2)over2++;max=Math.max(max,m);}
    row.png[arm]={sha256:sha(bytes),comparedTo:first,pixels,over2,max};if(['original','cells'].includes(arm))fs.writeFileSync(p.join(out,name+'-'+arm+'.png'),bytes);
  }return row;
}
(async()=>{app.setPath('userData',p.join(rt,'user'));app.commandLine.appendSwitch('force-device-scale-factor','1');await app.whenReady();
  const audit=createTransportAudit();server=createStaticServer(fixture,audit);await new Promise((r,j)=>{server.once('error',j);server.listen(0,'127.0.0.1',r);});
  const origin='http://127.0.0.1:'+server.address().port;win=new BrowserWindow({width:1440,height:900,useContentSize:true,show:false,autoHideMenuBar:true,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});win.showInactive();
  const wc=win.webContents,ev=s=>wc.executeJavaScript(s),cdp=(m,x)=>wc.debugger.sendCommand(m,x);
  await wc.loadURL('about:blank');wc.debugger.attach('1.3');const urls=new Map(),failed=[],httpErrors=[];
  wc.debugger.on('message',(_,m,x)=>{audit.cdp(m,x);if(m==='Network.requestWillBeSent')urls.set(x.requestId,x.request.url);if(m==='Network.loadingFailed')failed.push({...x,url:urls.get(x.requestId)});if(m==='Network.responseReceived'&&x.response.status>=400)httpErrors.push({url:x.response.url,status:x.response.status,requestId:x.requestId});if(m==='Runtime.exceptionThrown')report.exceptions.push(x.exceptionDetails.text);});
  for(const m of ['Page.enable','Network.enable','Runtime.enable'])await cdp(m);await cdp('Page.addScriptToEvaluateOnNewDocument',{source:'('+installGate.toString()+')()'});await cdp('Page.addScriptToEvaluateOnNewDocument',{source:audit.pageSource});
  save('loading');await wc.loadURL(origin+'/');while(!await ev('window.worldBase?.ready===true')){assert.deepEqual(await ev('window.worldBase?.errors??[]'),[]);await new Promise(r=>setTimeout(r,150));}
  await ev('(()=>{let b=document.querySelector("#go");if(b&&!b.disabled)b.click();document.body.classList.add("hide-ui");window.__surfaceGate.freeze();})()');
  report.setup=await ev('('+require('./cells-page.cjs').toString()+')()');assert.match(report.setup.renderer,/RTX 3060 Laptop/);
  if(mode==='lake'){save('lake mirror');report.lake=compare('tarn',await ev('__propCells.lake()'),'original');}
  else{const cases=['art-a-street','art-b-konbini','art-c-alley','art-d-laundry','sample-e-harbour','sample-f-hillside','sample-g-rail','sample-h-north'].map(k=>[k,0]);
    for(const sample of [['art-a-street',180],['sample-e-harbour',90],['sample-h-north',180]])cases.push(sample);
    for(const [key,yaw] of cases){const id=yaw?key+'-turn-'+yaw:key;save('ground '+id);const row=await ev('__propCells.view('+JSON.stringify(key)+','+yaw+')');report.views[id]=compare(id,row,yaw?'cells':'original');}
  }
  await ev('__propCells.dispose()');const auditResult=await audit.finish({origin,failures:failed,httpErrors,readPage:ev});
  fs.writeFileSync(p.join(out,'network.json.gz'),z.gzipSync(JSON.stringify(auditResult)));
  report.network={coverage:auditResult.coverage,verifiedCanceled:auditResult.verifiedCanceled.length,clean:auditResult.payloadIntegrityClean,problems:auditResult.problems};assert(report.network.clean);
  assert.deepEqual(report.exceptions,[]);report.ok=true;save('complete');
})().catch(e=>{report.failure=e.stack||String(e);save('failed');}).finally(()=>{clearTimeout(timer);win?.destroy();server?.close();app.exit(report.ok?0:1);});
