'use strict';
// node reproduce.cjs verify
// node reproduce.cjs photos <electron executable> <new artifacts folder>
// node reproduce.cjs timing <electron executable> <new artifacts folder>
const fs = require('node:fs'), p = require('node:path'), cp = require('node:child_process');
const crypt = require('node:crypto'), z = require('node:zlib'), assert = require('node:assert/strict');
const fixture = p.resolve(__dirname, '../..'), f = fixture, s = p.join(fixture, 'scripts'), a = assert;
const r = file => JSON.parse(fs.readFileSync(file));
const sha = bytes => crypt.createHash('sha256').update(bytes).digest('hex');
const write = (file,data) => fs.writeFileSync(file, JSON.stringify(data,null,2)+'\n');
const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
const head = () => cp.execFileSync('git',['rev-parse','HEAD'],{cwd:fixture,encoding:'utf8',windowsHide:true}).trim();
const {createStaticServer,cleanEnvironment} = require(p.join(s,'baseline.cjs'));
const {installGate} = require(p.join(s,'diagnose-surface.cjs'));
const reference=r(p.join(__dirname,'report.json'));
const lockedViews=Object.entries(reference.photos.pictures).map(([k,v])=>({k,name:v.view.name,eye:v.eye,target:v.view.target,fov:v.fov}));
const [mode,exe,folder]=process.argv.slice(2), expected=head();

function verify() {
  const bytes=fs.readFileSync(p.join(__dirname,reference.timing.samples.file));
  assert.equal(sha(bytes),reference.timing.samples.sha256);
  for(const [k,rows] of Object.entries(JSON.parse(z.gunzipSync(bytes)))) {
    const s=reference.timing.segments[k], sorted=rows.map(x=>x.ms).sort((a,b)=>a-b);
    assert.equal(sha(JSON.stringify(rows)),s.samplesSha256);assert.equal(rows.length,s.frames);
    assert.equal(1000*rows.length/rows.reduce((sum,x)=>sum+x.ms,0),s.fps);assert.equal(sorted[Math.ceil(rows.length*.95)-1],s.p95Ms);
  }
  for(const v of Object.values(reference.photos.pictures)) assert.equal(sha(fs.readFileSync(p.join(__dirname,v.file))),v.hashes.at(-1));
  console.log('Verified 4 PNGs and 6 raw timing series.');
}

function launchPhoto() {
  const out=p.join(fixture,'artifacts',folder);fs.mkdirSync(out);
  const cfg={mode:'formal',hash:expected,out,views:lockedViews,nativeFolder:p.join(out,'runtime')};
  fs.mkdirSync(cfg.nativeFolder);write(p.join(out,'config.json'),cfg);
  const log=fs.openSync(p.join(out,'native.log'),'wx');
  const run=cp.spawnSync(exe,[__filename,p.join(out,'config.json')],{stdio:['ignore',log,log],windowsHide:true,env:cleanEnvironment(cfg.nativeFolder),cwd:fixture});
  fs.closeSync(log);if(run.error)throw run.error;process.exitCode=run.status??1;
}
async function shoot(spec,mode){
 const w=window.worldBase,s=w.station,c=w.camera,x=document.getElementById('go');if(x&&!x.disabled)x.click();
 if(!window.__surfaceGate.frozen)window.__surfaceGate.freeze();
 document.body.classList.add('hide-ui');
 let dom=null;
 {const matches=[...document.querySelectorAll('button[data-view]')].filter(b=>b.dataset.view===spec.name);if(matches.length!==1)throw Error('Expected one deployed button '+spec.name);const b=matches[0];b.click();dom={tag:b.tagName,datasetView:b.dataset.view,text:b.textContent,active:b.classList.contains('active'),modeText:document.getElementById('mode').textContent};if(!dom.active)throw Error('View button inactive');}
 const view=w.views.find(v=>v.name===spec.name);
 s.update(0,14,w.walker.worldPosition);w.island.update(0,14);w.island.U.uTime.value=14;w.look.pipeline.hasPrev=false;
 const samples=[];for(let i=0;i<3;i++){w.renderer.info.reset();w.look.render(w.scene,0);samples.push(w.renderer.domElement.toDataURL('image/png'));}
 const gl=w.renderer.getContext(),ext=gl.getExtension('WEBGL_debug_renderer_info');
 const l=w.look.pipeline,sky=w.scene.children.find(o=>o.isHemisphereLight&&o.groundColor.getHexString()==="a08068");
 return {samples,view,dom,observed:w.currentView,eye:c.position.toArray(),quat:c.quaternion.toArray(),fov:c.fov,stationTime:s.ctx.time,look:{timeOfDay:w.island.timeOfDay,hemisphere:sky?.color.getHexString(),hemisphereGround:sky?.groundColor.getHexString(),hemisphereIntensity:sky?.intensity,sun:w.scene.children.filter(o=>o.isDirectionalLight).map(o=>({rgb:o.color.getHexString(),intensity:o.intensity})),toon:!!w.toon27,shadowTint:!!w.shadowTint,outline:l.finalMat.uniforms.uLnOn.value,ao:l.finalMat.uniforms.uAO.value,post:{...l.params}},
 islandTime:w.island.U.uTime.value,camDirection:c.getWorldDirection(c.position.clone()).toArray(),pixelRatio:w.renderer.getPixelRatio(),dimensions:[gl.drawingBufferWidth,gl.drawingBufferHeight],weathering:w.weathering.uniforms.uWx.value,
 gpu:ext&&gl.getParameter(ext.UNMASKED_RENDERER_WEBGL),hidden:document.body.classList.contains('hide-ui')&&['#panel','#help','#loading'].every(sel=>getComputedStyle(document.querySelector(sel)).display==='none'),walking:w.walker.enabled,errors:w.errors,glError:gl.getError()};
}
async function host(){const {app,BrowserWindow,nativeImage}=require('electron'),cfg=r(process.argv[2]),out=cfg.out;
const report={mode:cfg.mode,head:cfg.hash,stage:'bootstrap',shots:{},exceptions:[],networkFailures:[]},save=()=>write(p.join(out,'report.json'),report);
let server,win,timer=setTimeout(()=>{report.failure='Timed out at '+report.stage;save();app.exit(1)},480000);
try{a.equal(head(),cfg.hash);app.setPath('userData',p.join(cfg.nativeFolder,'user-data'));app.commandLine.appendSwitch('force-device-scale-factor','1');await app.whenReady();server=createStaticServer(fixture);await new Promise((y,n)=>{server.once('error',n);server.listen(0,'127.0.0.1',y)});
win=new BrowserWindow({width:1440,height:900,useContentSize:true,show:true,autoHideMenuBar:true,webPreferences:{contextIsolation:true,sandbox:true,nodeIntegration:false,backgroundThrottling:false}});
const wc=win.webContents;await wc.loadURL('about:blank');wc.debugger.attach('1.3');const urls=new Map();
wc.debugger.on('message',(_,m,s)=>{if(m==='Network.requestWillBeSent')urls.set(s.requestId,s.request.url);if(m==='Runtime.exceptionThrown')report.exceptions.push(s.exceptionDetails);
if(m==='Network.loadingFailed')report.networkFailures.push({error:s.errorText,url:urls.get(s.requestId),canceled:s.canceled});if(m==='Network.responseReceived'&&s.response.status>=400)report.networkFailures.push({url:s.response.url,status:s.response.status});});
for(const m of ['Page.enable','Network.enable','Runtime.enable'])await wc.debugger.sendCommand(m);
await wc.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument',{source:'('+installGate.toString()+')()'});
report.stage='loading';save();await win.loadURL('http://127.0.0.1:'+server.address().port+'/');while(!await wc.executeJavaScript('window.worldBase?.ready===true')){const e=await wc.executeJavaScript('window.worldBase?.errors||[]');if(e.length)throw Error(e.join('\n'));await sleep(180);}
const entries=cfg.views.concat({...cfg.views[0],k:'A-return'});for(const e of entries){if(report.shots[e.k])continue;a.match(e.k,/^[a-zA-Z0-9-]+$/);report.stage=e.k;save();
const v=await wc.executeJavaScript('('+shoot.toString()+')('+JSON.stringify(e)+','+JSON.stringify(cfg.mode)+')');const arr=v.samples.map(s=>Buffer.from(s.split(',')[1],'base64'));delete v.samples;
a.deepEqual(v.dimensions,[1440,900]);a.equal(v.observed,e.name);a.equal(v.hidden,true);a.equal(v.walking,false);a.equal(v.pixelRatio,1);a.equal(v.glError,0);a.equal(v.islandTime,14);a.equal(v.stationTime,14);a.equal(v.errors.length,0);a(/RTX 3060 Laptop/.test(v.gpu));
if(e.eye){a.deepEqual(v.eye,e.eye);a.equal(v.fov,e.fov);a.deepEqual(v.view.target,e.target);}
fs.writeFileSync(p.join(out,e.k+'.png'),arr[2]);fs.writeFileSync(p.join(out,e.k+'-repeat-1.png'),arr[1]);const im=nativeImage.createFromBuffer(arr[2]);fs.writeFileSync(p.join(out,e.k+'.jpg'),im.resize({width:840}).toJPEG(90));
report.shots[e.k]={...v,hashes:arr.map(sha),nativeSize:im.getSize()};save();}

if(cfg.mode==='formal'){a.equal(Object.keys(report.shots).length,5);for(const k of ['eye','quat','fov','stationTime','islandTime','look','view','dom'])a.deepEqual(report.shots.A[k],report.shots['A-return'][k]);}
a.equal(head(),cfg.hash);a.equal(report.exceptions.length,0);report.stage='complete';}
catch(e){report.failure=e.stack||String(e);console.error(report.failure);}
finally{clearTimeout(timer);save();win?.destroy();server?.close();app.exit(report.failure?1:0);}}

function runTiming(){
const git=(...args)=>cp.execFileSync('git',args,{cwd:f,encoding:'utf8',windowsHide:true}).trim(),digest=x=>crypt.createHash('sha256').update(x).digest('hex'),read=file=>JSON.parse(fs.readFileSync(file)),write=(name,r)=>fs.writeFileSync(p.join(out,name),JSON.stringify(r,null,2)+'\n');
const out=p.join(f,'artifacts',folder),runtime=p.join(out,'runtime');fs.mkdirSync(out);fs.mkdirSync(runtime);
const views=['art-a-street','art-b-konbini','art-c-alley','art-d-laundry'],spec=Object.fromEntries(lockedViews.map(v=>[v.name,v]));
assert.deepEqual(Object.keys(spec),views);const gitPaths=['index.html','src','scripts/baseline.cjs','scripts/preview-host.cjs'];
const manifest=()=>{assert.equal(git('rev-parse','HEAD'),expected);assert.equal(git('status','--porcelain','--untracked-files=all','--',...gitPaths),'');const files={};for(const n of git('ls-files','-z','--',...gitPaths).split('\0').filter(Boolean))files[n]=digest(fs.readFileSync(p.join(f,n)));return {head:expected,files};};const source=manifest();
const base=fs.readFileSync(p.join(s,'preview-host.cjs'),'utf8').replace(/\r\n/g,'\n');let host=base;
const once=(a,b)=>{assert.equal(host.split(a).length,2,a);host=host.replace(a,()=>b);};
const omit=(a,b)=>{assert.equal(host.split(a).length,2,a);const i=host.indexOf(a),j=host.indexOf(b,i+a.length);assert(j>i,b);host=host.slice(0,i)+host.slice(j);};
once("const { createStaticServer } = require('./baseline.cjs');","const { createStaticServer } = require("+JSON.stringify(p.join(s,'baseline.cjs'))+");");
once("const CORE_VIEWS = ['station-street', 'station-port', 'island-aerial', 'shop-interior'];","const CORE_VIEWS = "+JSON.stringify(views)+";");
omit("      stage('capturing-streetscape');","      stage('validating-look-controls');");omit("      stage('capturing-town-details');","    }\n  } else {");
once("window.__worldCapture.selectView('station-street'); window.worldBase.setFlightEffects(false)","window.__worldCapture.selectView('art-a-street'); window.worldBase.setFlightEffects(false)");
once("await measure(3000, \x60frame-samples-\x24{name}.json\x60)","await measure(10000, \x60frame-samples-\x24{name}.json\x60)");
once("stage('validating-station');","await evaluate(\"document.body.classList.add('hide-ui')\");\n      stage('validating-station');");
once("camera: { position: f.camera?.position.toArray(), currentView:", "camera: { position: f.camera?.position.toArray(), quaternion:f.camera?.quaternion.toArray(),fov:f.camera?.fov,hidden:document.body.classList.contains('hide-ui'),target:f.views?.find(v=>v.name===f.currentView)?.target, currentView:");
write('source-manifest.json',source);fs.writeFileSync(p.join(runtime,'art-host.cjs'),host);
const cfg={scene:'combined',fixture:f,source:f,output:out,runtime,preview:false,videoOnly:false,ffmpeg:null,width:1440,height:900,sampleMs:3000,warmupMs:5000,timeoutMs:400000,videoMs:0,query:'',proxy:'',startedAt:new Date().toISOString(),entrySha256:source.files['index.html'],
sourceManifest:{file:'source-manifest.json',head:expected,sha256:digest(fs.readFileSync(p.join(out,'source-manifest.json')))}};
write('run-config.json',cfg);const fd=fs.openSync(p.join(out,'native.log'),'wx'),result=cp.spawnSync(exe,[p.join(runtime,'art-host.cjs'),p.join(out,'run-config.json')],{cwd:f,windowsHide:true,env:require(p.join(s,'baseline.cjs')).cleanEnvironment(runtime),stdio:['ignore',fd,fd]});fs.closeSync(fd);
if(result.error)throw result.error;assert.deepEqual(manifest(),source);
const report=read(p.join(out,'render-report.json'));assert.equal(report.stage,'complete');assert(report.renderOk&&report.behaviorValidation.ok&&report.lookValidation.ok&&report.walkingValidation.ok);
assert.deepEqual(report.views.map(x=>x.name),views);assert.deepEqual(report.walkingValidation.segments.map(x=>x.mode),['third','first']);const raw={},segments={};
for(const v of [...report.views,...report.walkingValidation.segments]){const key=v.name??'walk-'+v.mode,file=p.join(out,v.samplesFile),buf=fs.readFileSync(file),rows=JSON.parse(buf);
assert(rows.every(r=>r.ms>0&&r.calls>0&&r.triangles>0));const times=rows.map(r=>r.ms).sort((a,b)=>a-b),duration=rows.reduce((sum,r)=>sum+r.ms,0),count=rows.length;
assert(duration>=(v.name?10000:3000));const fps=count*1000/duration,p95=times[Math.ceil(count*.95)-1],p99=times[Math.ceil(count*.99)-1];
assert.equal(v.frameCount,count);assert(Math.abs(fps-v.fps)<1e-8);assert.equal(v.p95FrameMs,times[Math.floor(.95*count)]);
const metric={frames:count,durationMs:duration,fps,p95Ms:p95,p99Ms:p99,maxMs:times.at(-1),over20Ms:times.filter(x=>x>20).length,pass:fps>=60&&p95<=16.7,samplesSha256:digest(buf)};
if(v.name){const cam=v.scene.camera,ref=spec[v.name];assert.equal(cam.currentView,v.name);assert(cam.hidden);assert.deepEqual(cam.position,ref.eye);assert.deepEqual(cam.target,ref.target);assert.equal(cam.fov,ref.fov);assert.deepEqual(v.scene.dimensions.canvas,[1440,900]);assert.equal(v.scene.dimensions.pixelRatio,1);metric.camera=cam;}
else {assert(v.ok&&v.horizontalDistance>1);metric.walk={from:v.before,to:v.after,distanceXZ:v.horizontalDistance};}raw[key]=rows;segments[key]=metric;}
const packed=z.gzipSync(Buffer.from(JSON.stringify(raw)),{level:9}),name='frames.json.gz';fs.writeFileSync(p.join(out,name),packed);
const summary={source:expected,verifiedSourceFiles:Object.keys(source.files).length,startedAt:cfg.startedAt,finishedAt:new Date().toISOString(),gpu:report.firstReady.renderer.gpu,canvas:[1440,900],dpr:1,samples:{file:name,sha256:digest(packed),fps:'1000 × frame count / sum of RAF intervals',p95:'nearest rank',fixedSeconds:10,walkingSeconds:3},threshold:{fps:60,p95Ms:16.7},segments,walkingInputs:report.walkingValidation.inputEvents,renderOk:report.renderOk,nativeExit:result.status,jsExceptions:report.exceptions.length,networkFailures:report.networkFailures.map(e=>({asset:e.url?new URL(e.url).pathname:null,stage:e.stage,error:e.errorText||e.status,canceled:e.canceled||false})),canonicalHostSha256:digest(base),measuredHostSha256:digest(host)};
assert(/RTX 3060 Laptop/.test(summary.gpu));write('frame-times.json',summary);console.log(JSON.stringify(Object.fromEntries(Object.entries(segments).map(([k,v])=>[k,[v.frames,v.fps,v.p95Ms]]))));

}
if(process.versions.electron) host();
else if(mode==='verify') verify();
else {
  assert(['photos','timing'].includes(mode),'Expected photos, timing, or verify');
  assert(exe&&fs.existsSync(exe),'Pass an installed Electron executable');assert.match(folder,/^[a-zA-Z0-9_-]+$/);
  if(mode==='photos')launchPhoto();else runTiming();
}
