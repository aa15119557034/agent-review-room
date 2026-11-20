// node capture-upload.cjs <existing Electron executable> <afternoon|evening> <new JSON file>
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process');
const fixture=path.resolve(process.env.WORLD_FIXTURE||path.join(__dirname,'../../..')),{cleanEnvironment,createStaticServer}=require(path.join(fixture,'scripts/baseline.cjs'));
const assert=require('node:assert/strict');
if (!process.versions.electron) {
  const [exe,time,file]=process.argv.slice(2);
  assert(['afternoon','evening'].includes(time)&&file,'Pass an Electron executable, lighting profile and an output path');
  const runtime=fs.mkdtempSync(path.join(os.tmpdir(),'cube-upload-'));
  const run=cp.spawnSync(exe,[__filename,time,path.resolve(file)],{cwd:fixture,env:{...cleanEnvironment(runtime),WORLD_FIXTURE:fixture},stdio:'inherit',windowsHide:true});
  if (run.error) throw run.error;
  process.exit(run.status??1);
}
const {app,BrowserWindow}=require('electron');
const [time,file]=process.argv.slice(2);
app.commandLine.appendSwitch('force-device-scale-factor','1');
app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'cube-upload-profile-')));
(async()=>{
  await app.whenReady();
  const server=createStaticServer(fixture);await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
  const delivered=[];server.on('request',(req,res)=>{const url=new URL(req.url,'http://localhost');if(!/^\/src\/street-env(?:-evening)?\/(?:px|nx|py|ny|pz|nz)\.png$/.test(url.pathname))return;res.on('finish',()=>{delivered.push({pathname:url.pathname,http:res.statusCode,bytes:Number(res.getHeader('content-length'))});});});
  const win=new BrowserWindow({width:1440,height:900,useContentSize:true,show:true,webPreferences:{contextIsolation:true,sandbox:true,nodeIntegration:false,backgroundThrottling:false}});
  const timer=setTimeout(()=>{console.error('Normal-entry upload timeout');app.exit(1);},180000);
  try {
    const wc=win.webContents;
    await wc.loadURL('http://127.0.0.1:'+server.address().port+(time==='afternoon'?'/?time=afternoon':'/'));
    while (!await wc.executeJavaScript('window.worldBase?.ready === true')) {
      assert.deepEqual(await wc.executeJavaScript('window.worldBase?.errors || []'),[]);
      await new Promise(ok=>setTimeout(ok,250));
    }
    await wc.executeJavaScript("document.getElementById('go')?.click();window.worldBase.setView('art-b-konbini');new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(()=>requestAnimationFrame(done))))");
    const observe=fs.readFileSync(path.join(__dirname,'gpu-cube.cjs'),'utf8');
    const result=await wc.executeJavaScript('('+observe+')()');
    result.source=cp.execFileSync('git',['rev-parse','HEAD'],{cwd:fixture,encoding:'utf8'}).trim();
    for(const face of result.faces)face.serverRequests=delivered.filter(x=>x.pathname===face.pathname);
    assert.equal(result.time,time);assert.equal(result.faces.length,6);
    fs.writeFileSync(file,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
    assert(result.faces.every(f=>f.differentPixels===0&&f.serverRequests.length===1&&f.serverRequests[0].http===200));
    assert.equal(result.glassCount,8);assert(result.allGlassShare&&result.wetShares);
    assert.equal(result.beforeGL,0);assert.equal(result.afterGL,0);
    console.log(time, result.faces.length, 'normal-entry cube faces match WebGL framebuffer readback');
  }finally{clearTimeout(timer);win.destroy();server.close();}
  app.exit(0);
})().catch(e=>{console.error(e);app.exit(1)});
