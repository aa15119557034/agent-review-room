'use strict';
const assert=require('node:assert/strict'),cp=require('node:child_process'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const [electron,fixture,auditRoot,out,source]=process.argv.slice(2);
const {createStaticServer,cleanEnvironment}=require(path.join(auditRoot,'scripts/baseline.cjs'));
const {createTransportAudit}=require(path.join(auditRoot,'scripts/acceptance-transport.cjs'));
const {installGate}=require(path.join(fixture,'scripts/diagnose-surface.cjs'));
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
if(!process.versions.electron) {
  assert.equal(cp.execFileSync('git',['rev-parse','HEAD'],{cwd:fixture,encoding:'utf8'}).trim(),source);
  fs.mkdirSync(out);const runtime=path.join(out,'runtime');fs.mkdirSync(runtime);
  const child=cp.spawnSync(electron,[__filename,...process.argv.slice(2)],{env:cleanEnvironment(runtime),cwd:fixture,windowsHide:true,stdio:'inherit'});
  if(child.error)throw child.error;process.exit(child.status??1);
}
const {app,BrowserWindow}=require('electron'),pause=ms=>new Promise(r=>setTimeout(r,ms));
const report={source,started:new Date().toISOString(),views:{},exceptions:[]};
function save(step){report.step=step;fs.writeFileSync(path.join(out,'data.json'),JSON.stringify(report,null,2)+'\n');}
let server,win;
const timeout=setTimeout(()=>{report.failure='Timeout at '+report.step;save('failed');app.exit(1);},200000);
async function main(){
  app.setPath('userData',path.join(out,'runtime/user'));
  app.commandLine.appendSwitch('force-device-scale-factor','1');
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
  app.commandLine.appendSwitch('disable-features','CalculateNativeWinOcclusion');
  await app.whenReady();
  const audit=createTransportAudit();server=createStaticServer(fixture,audit);
  await new Promise((ok,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',ok);});
  win=new BrowserWindow({width:1440,height:900,useContentSize:true,show:false,autoHideMenuBar:true,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  win.showInactive();const wc=win.webContents,ev=s=>wc.executeJavaScript(s),cdp=(m,p)=>wc.debugger.sendCommand(m,p);
  await wc.loadURL('about:blank');wc.debugger.attach('1.3');
  wc.debugger.on('message',(_,m,v)=>{audit.cdp(m,v);if(m==='Runtime.exceptionThrown')report.exceptions.push(v.exceptionDetails.text);});
  for(const m of ['Page.enable','Network.enable','Runtime.enable'])await cdp(m);
  await cdp('Page.addScriptToEvaluateOnNewDocument',{source:'('+installGate.toString()+')()'});
  await cdp('Page.addScriptToEvaluateOnNewDocument',{source:audit.pageSource});
  save('loading');await wc.loadURL('http://127.0.0.1:'+server.address().port+'/');
  while(!await ev('window.worldBase?.ready===true')){assert.deepEqual(await ev('window.worldBase?.errors||[]'),[]);await pause(200);}
  await ev("(()=>{const b=document.getElementById('go');if(b&&!b.disabled)b.click();})()");
  const probe=require('./inspect-steel-page.cjs');
  for(const name of ['art-c-alley','art-d-laundry','sample-e-harbour']){
    save('inspection '+name);const row=await ev('('+probe.toString()+')('+JSON.stringify(name)+')');
    assert.match(row.gpu,/RTX 3060 Laptop/);assert.equal(row.glError,0);assert.equal(row.time,14);assert.deepEqual(row.size,[1440,900]);
    if(name!=='sample-e-harbour')assert(row.portalMeshes.length>=1 && row.materialEvidence['apartment-pbr-metal'] && row.materialEvidence['art-r1-fence-steel']);
    const shots={};for(const [type,val] of Object.entries(row.shots)){
      const bytes=Buffer.from(val,'base64'),file=name+'-'+type+'.png';fs.writeFileSync(path.join(out,file),bytes);shots[type]={file,sha256:hash(bytes)};
    }
    row.shots=shots;report.views[name]=row;save('inspected '+name);
  }
  assert.deepEqual(report.exceptions,[]);assert.deepEqual(await ev('window.worldBase.errors'),[]);report.ok=true;save('complete');
}
main().catch(e=>{report.failure=e.stack||String(e);save('failed');}).finally(()=>{clearTimeout(timeout);win?.destroy();server?.close();app.exit(report.ok?0:1);});
