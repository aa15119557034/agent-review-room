const fs=require('node:fs'),p=require('node:path'),os=require('node:os'),cp=require('node:child_process'),crypto=require('node:crypto'),a=require('node:assert/strict');
const fixture=process.env.WORLD_FIXTURE||p.resolve(__dirname,'../..'),base=require('../../scripts/baseline.cjs');
const {createTransportAudit,classifyTransport}=require('../../scripts/acceptance-transport.cjs');
if(!process.versions.electron){const exe=process.argv[2];a(exe);const runtime=fs.mkdtempSync(p.join(os.tmpdir(),'read-audit-'));const r=cp.spawnSync(exe,[__filename],{cwd:fixture,env:{...base.cleanEnvironment(runtime),WORLD_FIXTURE:fixture,FIXTURE_CONTROL_OUTPUT:process.env.FIXTURE_CONTROL_OUTPUT},windowsHide:true,stdio:'inherit'});if(r.error)throw r.error;process.exit(r.status??1);}
const {app,BrowserWindow}=require('electron');app.disableHardwareAcceleration();app.commandLine.appendSwitch('disable-gpu');app.setPath('userData',fs.mkdtempSync(p.join(os.tmpdir(),'read-audit-profile-')));
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
(async()=>{
 await app.whenReady();const audit=createTransportAudit(),failures=[],httpErrors=[],server=base.createStaticServer(fixture,audit),orig=server.listeners('request')[0];server.removeListener('request',orig);
 const history=[],events=new Map(),names=new Map(),asset=require(p.join(fixture,'scripts/prepare-station-art.cjs')).releasePath(fixture);
 const petal=JSON.parse(fs.readFileSync(p.join(fixture,'sources.json'))).petalwake.commit;
 const prefixes=[['/assets/',p.join(fixture,'.local','petalwake-'+petal,'assets')],['/mature-sakura/',p.join(asset,'.local/mature-sakura')],['/prop-assets/',p.join(fixture,'.local','textured-props')]];
 const files=new Map();
 function file(url){if(!files.has(url)){const [prefix,root]=prefixes.find(([k])=>url.startsWith(k));const b=fs.readFileSync(p.join(root,url.slice(prefix.length)));files.set(url,{b,sha:sha(b),path:p.join(root,url.slice(prefix.length))})}return files.get(url);}
 server.on('request',(req,res)=>{
  const u=new URL(req.url,'http://localhost');
  if(u.pathname==='/audit-shell'){audit.start(req,res);const map=fs.readFileSync(p.join(fixture,'index.html'),'utf8').match(/<script type="importmap">[\s\S]*?<\/script>/)[0];audit.generated(req,map);res.writeHead(200,{'Content-Type':'text/html','Content-Length':Buffer.byteLength(map)}).end(map);return;}
  if(!u.searchParams.has('case'))return orig(req,res);
  const tag=u.searchParams.get('case'), expected=file(u.pathname),key='r'+String(history.length+1).padStart(4,'0');
  res.setHeader('X-Transport-Receipt',key);
  const record={key,path:u.pathname,query:u.search,method:req.method,range:req.headers.range??null,purpose:req.headers['sec-purpose']||req.headers.purpose||null,bytes:0,finished:false,closedBeforeFinish:false,originalBytes:expected.b.length,originalSHA256:expected.sha};
  history.push(record);
  const write=res.write,end=res.end;res.write=function(b,...rest){if(b)record.bytes+=Buffer.byteLength(b);return write.call(this,b,...rest)};res.end=function(b,...rest){if(b)record.bytes+=Buffer.byteLength(b);return end.call(this,b,...rest)};
  res.on('finish',()=>{record.finished=true;record.status=res.statusCode;});res.on('close',()=>{record.closedBeforeFinish=!res.writableFinished;record.status=res.statusCode;});
  if(tag.startsWith('normal-')||tag==='three-coalesced')return orig(req,res);
  audit.start(req,res);audit.file(req,expected.path,fs.statSync(expected.path));
  if(tag.startsWith('missing')){res.writeHead(404,{'Content-Type':'text/plain','Cache-Control':'no-store'}).end('not found');return;}
  const body=Buffer.from(expected.b),twin=req.headers['x-audit-twin'];
  if(tag.startsWith('wrong-')||twin==='2')body[0]^=1;
  res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':body.length,'Cache-Control':'no-store'});
  if(tag.startsWith('short-')||tag.startsWith('abort-')){
    res.write(body.subarray(0,4096));setTimeout(()=>{if(!res.destroyed){if(tag.startsWith('short-'))res.destroy();else res.end(body.subarray(4096));}},75);return;
  }
  res.end(body);
 });
 await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
 const win=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}}),wc=win.webContents;
 const timeout=setTimeout(()=>{console.error('CPU transport audit timeout');app.exit(2)},160000);
 try{
  await wc.loadURL('about:blank');const dbg=wc.debugger;dbg.attach('1.3');
  dbg.on('message',(_e,name,x)=>{
   audit.cdp(name,x); if(!x.requestId)return;
   if(name==='Network.loadingFailed')failures.push({...x,url:names.get(x.requestId)});if(name==='Network.responseReceived'&&x.response.status>=400)httpErrors.push({requestId:x.requestId,url:x.response.url,status:x.response.status});
   const list=events.get(x.requestId)||[];list.push({name,x});events.set(x.requestId,list);
   if(name==='Network.requestWillBeSent' && x.request.url.includes('?case='))names.set(x.requestId,x.request.url);
  });await dbg.sendCommand('Network.enable');await dbg.sendCommand('Page.enable');await dbg.sendCommand('Page.addScriptToEvaluateOnNewDocument',{source:audit.pageSource});await wc.loadURL('http://127.0.0.1:'+server.address().port+'/audit-shell');
  const source=fs.readFileSync(p.join(__dirname,'client.cjs'),'utf8');const appData=await wc.executeJavaScript('('+source+')()');
  await new Promise(ok=>setTimeout(ok,350));
  const cdp=[];for(const [id,url] of names){const es=events.get(id),first=es.find(e=>e.name==='Network.requestWillBeSent').x;
   const response=es.find(e=>e.name==='Network.responseReceived')?.x?.response,extra=es.find(e=>e.name==='Network.responseReceivedExtraInfo')?.x;
   const header=(h,key)=>Object.entries(h||{}).find(([k])=>k.toLowerCase()===key)?.[1],key=header(response?.headers,'x-transport-receipt')||header(extra?.headers,'x-transport-receipt');
   const terminal=es.find(e=>['Network.loadingFinished','Network.loadingFailed'].includes(e.name));const data=es.filter(e=>e.name==='Network.dataReceived');
   const u=new URL(url);cdp.push({requestNumber:cdp.length+1,key,url:u.pathname+u.search,priority:first.request.initialPriority,initiator:first.initiator?.type,
    type:first.type,response:response?.status||extra?.statusCode||null,cache:Boolean(response?.fromDiskCache||response?.fromPrefetchCache||response?.fromServiceWorker),range:header(first.request.headers,'range')||null,
    hasRedirect:es.some(e=>e.name==='Network.requestWillBeSent'&&e.x.redirectResponse),priorityChanges:es.filter(e=>e.name==='Network.resourceChangedPriority').map(e=>e.x.newPriority),
    dataReceived:data.reduce((s,e)=>s+e.x.dataLength,0),events:es.map(e=>e.name),terminal:terminal?.name,error:terminal?.x.errorText||null,canceled:terminal?.x.canceled??false});
  }
  const origin='http://127.0.0.1:'+server.address().port;
  const all=await audit.finish({origin,failures,httpErrors,readPage:x=>wc.executeJavaScript(x)});
  const appByReceipt=new Map(all.reads.map(x=>[x.receipt,x]));
  const cases=all.requests.filter(x=>x.url.includes('?case=')).map(x=>{
    const uri=new URL(x.url),response=all.served.find(s=>s.receipt===x.receipt);
    const r=classifyTransport({origin,failures:failures.filter(f=>f.requestId===x.requestId),httpErrors:httpErrors.filter(f=>f.requestId===x.requestId),requests:[x],served:response?[response]:[],reads:all.reads.filter(f=>f.receipt===x.receipt)});
    const app=appByReceipt.get(x.receipt);
    return {case:uri.searchParams.get('case'),uri:uri.pathname,requestId:x.requestId,terminal:x.terminal,receipt:x.receipt,
      status:x.status,strict:r.strictTransportClean,integrity:r.payloadIntegrityClean,proven:r.verifiedCanceled.length,
      reasons:r.problems.map(y=>y.reason),sourceSHA256:response?.sha256,wireSHA256:response?.wireSHA256,
      received:app?.received,sha:app?.sha256,aborted:app?.aborted};
  });
  const normal=cases.filter(x=>x.case.startsWith('normal-'));a.equal(normal.length,200);a(normal.every(x=>x.integrity));
  for(const mode of ['raw','three'])for(const fault of ['short','wrong','abort','missing']){const row=cases.find(x=>x.case===fault+'-'+mode);a(row&&!row.integrity,fault+' '+mode);}
  const twin=cases.filter(x=>x.case==='same-url-twin');a.equal(twin.length,2);a.deepEqual(twin.map(x=>x.integrity).sort(),[false,true]);a(twin[0].receipt!==twin[1].receipt);
  const coalesced=cases.filter(x=>x.case==='three-coalesced');a.equal(coalesced.length,1);a(coalesced[0].integrity);a.equal(appData.records.filter(x=>x.url.includes('three-coalesced')&&x.resolved).length,2);
  a.equal(cases.length,211);
  a.equal(all.coverage.paired,all.coverage.localHTTP);
  a.equal(all.coverage.paired,all.coverage.serverReceipts);
  const rejected=new Set(cases.filter(row=>!row.integrity).map(row=>row.requestId));
  a.equal(rejected.size,9);
  a.deepEqual(new Set(all.problems.map(row=>row.requestId)),rejected);
  const report={electron:process.versions.electron,chromium:process.versions.chrome,source:cp.execFileSync('git',['rev-parse','HEAD'],{cwd:fixture,encoding:'utf8'}).trim(),
    coverage:all.coverage,strictTransportClean:all.strictTransportClean,payloadIntegrityClean:all.payloadIntegrityClean,
    cases,syntheticFailuresRejected:true,normal:normal.length};
  const output=process.env.FIXTURE_CONTROL_OUTPUT||p.join(fixture,'artifacts','verified-transport-controls.json');fs.mkdirSync(p.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log('200 normal bodies verified, all 8 fault controls rejected, duplicate URL twin distinguished; total requests',cases.length);
 }finally{clearTimeout(timeout);win.destroy();server.close();}
 app.exit(0);
})().catch(e=>{console.error(e);app.exit(1)});
