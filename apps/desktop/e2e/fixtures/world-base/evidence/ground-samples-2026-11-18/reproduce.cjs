'use strict';

const assert = require('node:assert/strict');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const fixture = path.resolve(__dirname, '../..');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const write = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
const {createStaticServer, cleanEnvironment} = require(path.join(fixture, 'scripts/baseline.cjs'));
const {installGate} = require(path.join(fixture, 'scripts/diagnose-surface.cjs'));
const samples = ['sample-e-harbour', 'sample-f-hillside', 'sample-g-rail', 'sample-h-north'];

function source() {
  const git = args => cp.execFileSync('git', args, {cwd:fixture, windowsHide:true, encoding:'utf8'}).trimEnd();
  const files = git(['ls-files', '-z', '--', 'index.html', 'src', 'upstream', 'scripts/baseline.cjs', 'scripts/diagnose-surface.cjs']).split('\0').filter(Boolean);
  return {head:git(['rev-parse','HEAD']), files:Object.fromEntries(files.map(file => [file, hash(fs.readFileSync(path.join(fixture,file)))]))};
}

function shoot(name) {
  const w = window.worldBase, camera = w.camera, s = w.station, island = w.island;
  const start = document.querySelector('#go');
  if (start && !start.disabled) start.click();
  if (!window.__surfaceGate.frozen) window.__surfaceGate.freeze();
  const button = document.querySelector('button[data-view="' + name + '"]');
  button.closest('details').open = true;
  button.click();
  document.body.classList.add('hide-ui');
  s.update(0, 14, w.walker.worldPosition);
  island.update(0, 14);
  island.U.uTime.value = 14;
  w.look.pipeline.hasPrev = false;
  const gl = w.renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
  const frames = [];
  for (let n=0; n<3; n++) {
    w.look.render(w.scene, 0);
    frames.push(w.renderer.domElement.toDataURL('image/png').split(',')[1]);
  }
  const {x,y,z} = camera.position;
  const ground = name === 'sample-g-rail'
    ? s.root.position.y + s.ctx.physics.groundHeight(x-s.root.position.x,z-s.root.position.z,y-s.root.position.y)
    : Math.max(island.heightAt(x,z),island.town.heightAt(x,z));
  return {frames, view:w.views.find(v => v.name===name), current:w.currentView,
    eye:camera.position.toArray(), quaternion:camera.quaternion.toArray(), fov:camera.fov,
    ground, eyeHeight:y-ground, time:s.ctx.time, islandTime:island.U.uTime.value, timeOfDay:island.timeOfDay,
    buttonActive:button.classList.contains('active'), hidden:['#panel','#help','#loading'].every(sel => getComputedStyle(document.querySelector(sel)).display==='none'),
    canvas:[gl.drawingBufferWidth,gl.drawingBufferHeight], gpu:ext && gl.getParameter(ext.UNMASKED_RENDERER_WEBGL),
    glError:gl.getError(), errors:w.errors.slice()};
}

async function capture(out) {
  const {app,BrowserWindow} = require('electron');
  const runtime=path.join(out,'runtime'), seen=source();
  const report={source:seen.head, sourceFiles:seen.files, startedAt:new Date().toISOString(), photos:{}, exceptions:[], networkFailures:[]};
  let win, server;
  const timer=setTimeout(() => {report.failure='Capture timed out';write(path.join(out,'report.json'),report);app.exit(1);},480000);
  try {
    app.setPath('userData',path.join(runtime,'user-data'));
    app.commandLine.appendSwitch('force-device-scale-factor','1');
    await app.whenReady();
    server=createStaticServer(fixture);
    await new Promise((resolve,reject) => {server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    win=new BrowserWindow({width:1440,height:900,useContentSize:true,show:true,autoHideMenuBar:true,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
    const wc=win.webContents;
    await wc.loadURL('about:blank');wc.debugger.attach('1.3');
    const urls=new Map();
    wc.debugger.on('message',(_event,method,ev) => {
      if(method==='Network.requestWillBeSent') urls.set(ev.requestId,ev.request.url);
      if(method==='Network.loadingFailed') report.networkFailures.push({url:urls.get(ev.requestId),error:ev.errorText,canceled:ev.canceled});
      if(method==='Network.responseReceived'&&ev.response.status>=400) report.networkFailures.push({url:ev.response.url,status:ev.response.status});
      if(method==='Runtime.exceptionThrown') report.exceptions.push(ev.exceptionDetails);
    });
    for(const method of ['Page.enable','Runtime.enable','Network.enable']) await wc.debugger.sendCommand(method);
    await wc.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument',{source:'('+installGate.toString()+')()'});
    await wc.loadURL('http://127.0.0.1:'+server.address().port+'/');
    while(!await wc.executeJavaScript('window.worldBase?.ready === true')) {
      const errors=await wc.executeJavaScript('window.worldBase?.errors || []');
      assert.equal(errors.length,0,errors.join('\n'));
      await new Promise(resolve => setTimeout(resolve,200));
    }
    for(const [i,name] of [...samples,samples[0]].entries()) {
      const photo=await wc.executeJavaScript('('+shoot.toString()+')('+JSON.stringify(name)+')');
      const frames=photo.frames.map(x=>Buffer.from(x,'base64'));delete photo.frames;
      assert.deepEqual(photo.canvas,[1440,900]);assert.deepEqual(photo.eye,photo.view.position);
      assert.equal(photo.current,name);assert.equal(photo.fov,photo.view.fov);
      assert(photo.hidden && photo.buttonActive);assert.equal(photo.time,14);assert.equal(photo.islandTime,14);
      assert.equal(photo.timeOfDay,'evening');assert.equal(photo.glError,0);assert.deepEqual(photo.errors,[]);
      assert.match(photo.gpu,/RTX 3060 Laptop/);
      assert(photo.eyeHeight>=1.45 && photo.eyeHeight<=1.75,'Eye height '+name+' '+photo.eyeHeight);
      const key=i===4?'return-e':name, file=key+'.png';fs.writeFileSync(path.join(out,file),frames[2]);
      report.photos[key]={...photo,file,hashes:frames.map(hash)};
    }
    for(const k of ['eye','quaternion','fov','time','view']) assert.deepEqual(report.photos[samples[0]][k],report.photos['return-e'][k]);
    assert.deepEqual(report.exceptions,[]);assert.deepEqual(source().files,seen.files);
    report.complete=true;
  } catch(e) {report.failure=String(e.stack||e);console.error(report.failure);}
  finally {clearTimeout(timer);report.finishedAt=new Date().toISOString();write(path.join(out,'report.json'),report);win?.destroy();server?.close();app.exit(report.complete?0:1);}
}

if(process.versions.electron) {
  capture(process.argv[2]).catch(e=>{console.error(e);require('electron').app.exit(1);});
} else if(process.argv[2]==='verify') {
  const report=read(path.join(__dirname,'report.json'));
  assert(report.complete);
  assert.deepEqual(Object.keys(report.photos), [...samples, 'return-e']);
  assert.deepEqual(report.exceptions, []);
  for(const name of samples) {
    const s = report.photos[name];
    assert.equal(hash(fs.readFileSync(path.join(__dirname,s.file))),s.hashes[2]);
    assert.deepEqual(s.eye,s.view.position);assert.deepEqual(s.canvas,[1440,900]);
    assert.equal(s.current, name);
    assert.equal(s.timeOfDay, 'evening');
    assert.equal(s.time, 14);
    assert.equal(s.islandTime, 14);
    assert(Math.abs(s.eyeHeight - 1.6) < 0.001);
    assert.equal(s.glError, 0);
    assert.deepEqual(s.errors, []);
  }
  assert.equal(report.photos['return-e'].hashes[2], report.photos[samples[0]].hashes[2]);
  console.log('Verified four native ground samples and their camera registrations.');
} else {
  const [exe,out]=process.argv.slice(2);
  assert(exe && path.isAbsolute(out),'Pass the installed Electron executable and a new absolute output directory.');
  fs.mkdirSync(out);const runtime=path.join(out,'runtime');fs.mkdirSync(runtime);
  const result=cp.spawnSync(exe,[__filename,out],{cwd:fixture,env:cleanEnvironment(runtime),stdio:'inherit',windowsHide:true});
  if(result.error) throw result.error;
  process.exitCode=result.status??1;
}
