const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),ab=process.argv.includes('--crate-opaque-ab'),masked=process.argv.includes('--crate-mask-ab');
const output=path.join(root,'preview-output',...(masked?['crate-mask-ab']:ab?['crate-opaque-ab']:[]));
const vendor='D:/codex/2026-11-16/world-implementation/world-base/apps/desktop/e2e/fixtures/world-base/upstream/petalwake/vendor/three';
app.setPath('userData',path.join(root,'preview-user-data'));
app.setPath('sessionData',path.join(root,'preview-user-data/session'));
app.commandLine.appendSwitch('force-device-scale-factor','1');
const requests=[],exceptions=[],consoleMessages=[],captures=[];
let win,server,exitCode=0;
const receipt=JSON.parse(fs.readFileSync(path.join(root,'download-receipt.json')));
const hashes=()=>receipt.files.map(f=>{const raw=fs.readFileSync(path.join(root,'downloads',f.path));const sha256=crypto.createHash('sha256').update(raw).digest('hex');if(sha256!==f.sha256)throw Error('Original changed: '+f.path);return{path:f.path,bytes:raw.length,sha256};});
const before=hashes();
async function main(){
  fs.mkdirSync(output,{recursive:true});
  server=http.createServer((req,res)=>{
    const url=new URL(req.url,'http://127.0.0.1');let relative,dir;
    if(url.pathname.startsWith('/three/')){dir=vendor;relative=decodeURIComponent(url.pathname.slice(7));}
    else {dir=root;relative=url.pathname==='/'?'preview/index.html':decodeURIComponent(url.pathname.slice(1));}
    const file=path.resolve(dir,relative),record={url:url.pathname,status:0};requests.push(record);
    if(!file.startsWith(path.resolve(dir)+path.sep)){record.status=403;res.writeHead(403).end();return;}
    fs.readFile(file,(err,data)=>{if(err){record.status=404;res.writeHead(404).end();return;}
      record.status=200;record.bytes=data.length;
      const type={'.js':'text/javascript','.html':'text/html','.gltf':'model/gltf+json','.bin':'application/octet-stream','.jpg':'image/jpeg','.png':'image/png'}[path.extname(file)]||'application/octet-stream';
      res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store'});res.end(data);
    });
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  await app.whenReady();
  win=new BrowserWindow({width:1440,height:900,useContentSize:true,show:false,
    webPreferences:{offscreen:true,sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  win.webContents.on('console-message',(_e,level,message,line,source)=>consoleMessages.push({level,message,line,source}));
  win.webContents.on('render-process-gone',(_e,detail)=>exceptions.push({type:'render-process-gone',detail}));
  win.webContents.on('did-fail-load',(_e,code,description,url)=>exceptions.push({type:'did-fail-load',code,description,url}));
  win.webContents.session.webRequest.onErrorOccurred(details=>exceptions.push({type:'request-error',url:details.url,error:details.error}));
  await win.loadURL('http://127.0.0.1:'+server.address().port+'/');
  await win.webContents.executeJavaScript(`new Promise((resolve,reject)=>{const start=Date.now();const poll=()=>{if(window.previewReady)return resolve(true);if(Date.now()-start>30000)return reject(new Error('preview initialization timeout'));setTimeout(poll,100)};poll()})`);
  const shots=masked?[
    {id:'plastic_crate_02',name:'01-crate-original',mode:'original'},
    {id:'plastic_crate_02',name:'02-crate-opaque-control',mode:'opaque'},
    {id:'plastic_crate_02',name:'03-crate-official-mask',mode:'masked'},
    {id:'plastic_crate_02',name:'04-crate-original-restored',mode:'original'},
  ]:ab?[
    {id:'plastic_crate_02',name:'01-crate-original',opaque:false},
    {id:'plastic_crate_02',name:'02-crate-adapted-opaque',opaque:true},
    {id:'plastic_crate_02',name:'03-crate-original-restored',opaque:false},
  ]:['plastic_crate_02','painted_wooden_bench','worn_shutter'].map((id,i)=>({id,name:String(i+1).padStart(2,'0')+'-'+id}));
  for(const shot of shots){
    const {id,name}=shot;
    const adaptation=masked?await win.webContents.executeJavaScript('window.setCratePreviewMode('+JSON.stringify(shot.mode)+')'):
      ab?await win.webContents.executeJavaScript('window.setCrateOpaquePreview('+shot.opaque+')'):null;
    const record=await win.webContents.executeJavaScript('window.previewAsset('+JSON.stringify(id)+')');
    if(record.failures.length||record.renderer.contextLost||record.renderer.error)throw Error('Renderer error '+JSON.stringify(record));
    const captured=await win.webContents.capturePage();
    if(captured.isEmpty())throw Error('Empty capture');
    fs.writeFileSync(path.join(output,name+'.png'),captured.toPNG());
    fs.writeFileSync(path.join(output,name+'.jpg'),captured.resize({width:960,quality:'best'}).toJPEG(92));
    captures.push({...record,adaptation,png:name+'.png',jpg:name+'.jpg',captureSize:captured.getSize()});
    console.log('CAPTURED '+name);
  }
}
main().catch(error=>{exitCode=1;exceptions.push({type:'main-error',message:error.stack});console.error(error.stack);}).finally(()=>{
  let after=[];try{after=hashes();}catch(error){exceptions.push({type:'hash-error',message:error.message});exitCode=1;}
  const failedRequests=requests.filter(r=>r.status!==200&&r.url!=='/favicon.ico');
  if(exceptions.length||failedRequests.length)exitCode=1;
  fs.mkdirSync(output,{recursive:true});
  fs.writeFileSync(path.join(output,'preview-report.json'),JSON.stringify({createdAt:new Date().toISOString(),
    note:'Independent asset preview, not scene acceptance or FPS evidence',captures,requests,failedRequests,exceptions,consoleMessages,
    originalHashesBefore:before,originalHashesAfter:after,originalBytesUnchanged:JSON.stringify(before)===JSON.stringify(after),exitCode},null,2)+'\n');
  if(win&&!win.isDestroyed())win.destroy();
  if(server)server.close();app.exit(exitCode);
});
