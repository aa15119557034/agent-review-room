'use strict';

const assert = require('node:assert/strict');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const fixture = path.resolve(process.env.WORLD_FIXTURE || path.join(__dirname, '../../..'));
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const write = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
const {createStaticServer, cleanEnvironment} = require(path.join(fixture, 'scripts/baseline.cjs'));
const {installGate} = require(path.join(fixture, 'scripts/diagnose-surface.cjs'));
const samples = ['art-a-street','art-b-konbini','art-c-alley','art-d-laundry','sample-e-harbour', 'sample-f-hillside', 'sample-g-rail', 'sample-h-north'];

function source() {
  const git = args => cp.execFileSync('git', args, {cwd:fixture, windowsHide:true, encoding:'utf8'}).trimEnd();
  const files = git(['ls-files', '-z', '--', 'index.html', 'src', 'upstream', 'scripts/baseline.cjs', 'scripts/diagnose-surface.cjs']).split('\0').filter(Boolean);
  return {head:git(['rev-parse','HEAD']), files:Object.fromEntries(files.map(file => [file, hash(fs.readFileSync(path.join(fixture,file)))]))};
}

async function shoot(key, seconds = 14) {
  const w = window.worldBase, camera = w.camera, s = w.station, island = w.island;
  const absolute = key === 'sample-f-absolute-254', name = absolute ? 'sample-f-hillside' : key;
  const start = document.querySelector('#go');
  if (start && !start.disabled) start.click();
  if (!window.__surfaceGate.frozen) window.__surfaceGate.freeze();
  const button = document.querySelector('button[data-view="' + name + '"]');
  if(button.closest('details'))button.closest('details').open=true;
  button.click();
  document.body.classList.add('hide-ui');
  if (absolute) {
    camera.position.set(1040.6682,61.5086,591.5865);camera.lookAt(1062,102.7783,490);camera.updateMatrixWorld(true);
  }
  // One ordinary production frame applies the locked weather to the station lights, wet streets, rain, fog and inland water.
  // Original update functions stay on the native entry path and receive the fixed visual time.
  const old=[island.weather.update,s.update,island.update,island.inland.update,island.inland.reflection.update];
  island.weather.update=()=>old[0](seconds);
  s.update=(dt,ts,feet)=>old[1](0,seconds,feet);
  island.update=()=>old[2](0,seconds);
  island.inland.update=(dt,...args)=>old[3](0,...args);
  island.inland.reflection.update=(renderer,scene,eye,body,omit)=>old[4](renderer,scene,eye,body,omit,seconds);
  w.look.pipeline.hasPrev=false;
  try { window.__surfaceGate.step(performance.now()); }
  finally { [island.weather.update,s.update,island.update,island.inland.update,island.inland.reflection.update]=old; }
  if (island.weather.state.seconds!==seconds) throw Error('Production weather frame did not advance');
  w.look.pipeline.hasPrev = false;
  const gl = w.renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
  const frames = [];
  for (let n=0; n<3; n++) {
    w.look.render(w.scene, 0);
    frames.push(w.renderer.domElement.toDataURL('image/png').split(',')[1]);
  }
  const {x,y,z} = camera.position;
  const local=s.toLocal(camera.position),physical=s.root.position.y+s.ctx.physics.groundHeight(local.x,local.z,local.y);
  const ground = name.startsWith('art-')?physical : name === 'sample-g-rail'
    ? s.root.position.y + s.ctx.physics.groundHeight(x-s.root.position.x,z-s.root.position.z,y-s.root.position.y)
    : Math.max(island.heightAt(x,z),island.town.heightAt(x,z));
  const waterUniforms=island.water.material.uniforms, {waveHeight}=await import('/upstream/petalwake/src/world/water.js');
  const probe = [0,1320];
  return {frames, absolute,stationGround:physical,plan:{source:w.weatheringDecals.stats.source,rays:w.weatheringDecals.stats.rays,fingerprint:w.weatheringDecals.plan.fingerprint,items:w.weatheringDecals.plan.items.length},streetReflection:{...s.streetReflections.stats,cube:s.streetReflections.uniforms.uStreetEnvironment.value.image.map(i=>({path:new URL(i.src).pathname,width:i.width,height:i.height}))},groundArt:w.ground??null,water:{seconds:waterUniforms.uTime.value,sea:waterUniforms.uSea.value,surge:waterUniforms.uSeaSetup.value,probe,bed:island.heightAt(...probe),openWaterHeight:waveHeight(...probe,seconds)},weather:{...island.weather.state}, cloudFlow:island.U.uCloudFlow.value.toArray(), wetRoad:s.wetRoad.rainFilm.value, groundFog:w.look.pipeline.finalMat.uniforms.uGroundFog.value, view:w.views.find(v => v.name===name), current:w.currentView,
    eye:camera.position.toArray(), quaternion:camera.quaternion.toArray(), fov:camera.fov,
    ground, eyeHeight:y-ground, time:s.ctx.time, islandTime:island.U.uTime.value, timeOfDay:island.timeOfDay,
    buttonActive:button.classList.contains('active'), hidden:['#panel','#help','#loading'].every(sel => getComputedStyle(document.querySelector(sel)).display==='none'),
    canvas:[gl.drawingBufferWidth,gl.drawingBufferHeight], gpu:ext && gl.getParameter(ext.UNMASKED_RENDERER_WEBGL),
    glError:gl.getError(), errors:w.errors.slice()};
}

async function flowingShore() {
  const w=window.worldBase, island=w.island;
  const {basins}=await import('/src/basins.js');
  const body=basins.find(b=>b.id==='tarn'), lake=island.inland.group.getObjectByName('tarn-water');
  const select=document.querySelector('#water-view');
  select.value=body.id;select.dispatchEvent(new Event('change'));
  const weather=document.querySelector('#weather-start');
  weather.value='48';weather.dispatchEvent(new Event('change'));
  const frame=()=>new Promise(resolve=>requestAnimationFrame(resolve));
  const gate=window.__surfaceGate;
  const sample=async()=>{
    await frame();
    const {x,y,z}=w.camera.position;
    const gl=w.renderer.getContext();
    return {eye:[x,y,z],eyeHeight:y-island.heightAt(x,z),quaternion:w.camera.quaternion.toArray(),view:w.currentView,
      lakeReflection:{captures:island.inland.reflection.captures,on:lake.material.uniforms.uMirrorOn.value,linked:lake.material.uniforms.uMirrorMap.value===island.inland.reflection.map.value,width:island.inland.reflection.map.value.image.width,height:island.inland.reflection.map.value.image.height},weather:{...island.weather.state},waterTime:lake.material.uniforms.uTime.value,sea:island.water.material.uniforms.uSea.value,
      cloudFlow:island.sky.mesh.material.uniforms.uCloudFlow.value.toArray(),lakePoint:[body.x,body.z],
      lakeSurface:island.inland.sampleSurface(body,body.x,body.z),lakeRain:lake.material.uniforms.uRain.value,
      glError:gl.getError(),pixels:w.renderer.domElement.toDataURL('image/png').split(',')[1]};
  };
  gate.resume();
  try {
    await frame();await frame();
    const a=await sample();
    await new Promise(resolve=>setTimeout(resolve,1300));
    return [a,await sample()];
  } finally {gate.freeze();}
}

async function capture(out, ground) {
  const {app,BrowserWindow} = require('electron');
  const runtime=path.join(out,'runtime'), seen=source();
  const report={source:seen.head, sourceFiles:seen.files, ground, startedAt:new Date().toISOString(), photos:{}, exceptions:[], networkFailures:[]};
  let win, server;
  const timer=setTimeout(() => {report.failure='Capture timed out';write(path.join(out,'report.json'),report);app.exit(1);},480000);
  try {
    app.setPath('userData',path.join(runtime,'user-data'));
    app.commandLine.appendSwitch('force-device-scale-factor','1');
    await app.whenReady();
    server=createStaticServer(fixture);
    await new Promise((resolve,reject) => {server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    win=new BrowserWindow({width:1440,height:900,useContentSize:true,show:false,autoHideMenuBar:true,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
    win.showInactive();const wc=win.webContents;
    await wc.loadURL('about:blank');wc.debugger.attach('1.3');
    const urls=new Map();
    wc.debugger.on('message',(_event,method,ev) => {
      if(method==='Network.requestWillBeSent') urls.set(ev.requestId,ev.request.url);
      if(method==='Network.loadingFailed') report.networkFailures.push({url:urls.get(ev.requestId),error:ev.errorText,canceled:ev.canceled});
      if(method==='Network.responseReceived'&&ev.response.status>=400) report.networkFailures.push({url:ev.response.url,status:ev.response.status});
      if(method==='Runtime.exceptionThrown') report.exceptions.push(ev.exceptionDetails);
    });
    for(const method of ['Page.enable','Runtime.enable','Network.enable']) await wc.debugger.sendCommand(method);
    await wc.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument',{source:'('+installGate.toString().replace('  gate.resume =', '  gate.step = now => { for (const [id,item] of [...pending]) { pending.delete(id); item.callback(now); } };\n  gate.resume =')+')()'});
    await wc.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument',{source:'performance.setResourceTimingBufferSize(1800)'});await wc.loadURL('http://127.0.0.1:'+server.address().port+'/'+(ground==='off'?'?ground=off':''));
    while(!await wc.executeJavaScript('window.worldBase?.ready === true')) {
      const errors=await wc.executeJavaScript('window.worldBase?.errors || []');
      assert.equal(errors.length,0,errors.join('\n'));
      await new Promise(resolve => setTimeout(resolve,200));
    }
    const sequence=[...samples,samples[0],'sample-e-harbour'];
    for(const [i,name] of sequence.entries()) {
      const seconds=i===9 ? 54 : 14;
      const photo=await wc.executeJavaScript('('+shoot.toString()+')('+JSON.stringify(name)+','+seconds+')');
      const frames=photo.frames.map(x=>Buffer.from(x,'base64'));delete photo.frames;
      assert.deepEqual(photo.canvas,[1440,900]);assert.deepEqual(photo.eye,photo.absolute?[1040.6682,61.5086,591.5865]:photo.view.position);
      assert.equal(photo.current,photo.absolute?'sample-f-hillside':name);assert.equal(photo.fov,photo.view.fov);
      assert(photo.hidden && photo.buttonActive);assert.equal(photo.time,seconds);assert.equal(photo.islandTime,seconds);
      assert.equal(photo.timeOfDay,'evening');assert.equal(photo.glError,0);assert.deepEqual(photo.errors,[]);
      assert.match(photo.gpu,/RTX 3060 Laptop/);
      if(name.startsWith('sample-'))assert(photo.eyeHeight>=1.45&&photo.eyeHeight<=1.75,'Unexpected island eye height '+photo.eyeHeight); if(!Number.isFinite(photo.eyeHeight))throw Error('Invalid physics height');
      assert.equal(photo.weather.seconds,seconds);assert.equal(photo.groundFog,photo.weather.fog);assert.equal(photo.wetRoad,photo.weather.wetness);
      assert.equal(Boolean(photo.groundArt),ground==='on');
      const key=i===8?'return-a':i===9?'storm-e':name, file=key+'.png';fs.writeFileSync(path.join(out,file),frames[2]);
      if(['art-c-alley','art-d-laundry'].includes(name)){photo.stationExtrapolationOutsideBounds={ground:photo.ground,eyeMinusExtrapolatedGround:photo.eyeHeight};delete photo.ground;delete photo.eyeHeight;photo.surfaceCheck='See geometry/ground-rays.json for the visible city paving.';}
      report.photos[key]={...photo,file,hashes:frames.map(hash)};
      write(path.join(out,'report.json'),report);console.log('Saved',ground,key);
    }
    for(const k of ['eye','quaternion','fov','time','view']) assert.deepEqual(report.photos[samples[0]][k],report.photos['return-a'][k]);
    if(ground==='on') {
      const live=await wc.executeJavaScript('('+flowingShore.toString()+')()');
      for (const [index,s] of live.entries()) {
        const bytes=Buffer.from(s.pixels,'base64');delete s.pixels;
        s.file='live-tarn-'+(index+1)+'.png';s.sha256=hash(bytes);fs.writeFileSync(path.join(out,s.file),bytes);
        assert.equal(s.view,'tarn');assert.equal(s.glError,0);assert.equal(s.lakeRain,s.weather.rain);
      }
      report.liveShore=live;
      assert(live[1].weather.seconds>live[0].weather.seconds && live[1].waterTime>live[0].waterTime);
      assert.notDeepEqual(live[1].cloudFlow,live[0].cloudFlow);assert.notEqual(live[1].lakeSurface,live[0].lakeSurface);
      assert.notEqual(live[1].sha256,live[0].sha256);assert.deepEqual(live[0].eye,live[1].eye);
    }
    report.arrival=await require('./arrival.cjs')(wc);
    assert(report.arrival.every(t=>t.frames.length>30 && !t.start.glError && !t.end.glError));
    assert(Math.hypot(...report.arrival[1].start.feet.map((n,i)=>n-report.arrival[1].end.feet[i]))>8);
    report.modelRequests=await wc.executeJavaScript("performance.getEntriesByType('resource').map(r=>({path:new URL(r.name).pathname,decoded:r.decodedBodySize})).filter(r=>r.path.startsWith('/station-art/')||r.path.includes('mature-sakura.glb'))");
    assert.deepEqual(report.exceptions,[]);assert.deepEqual(source().files,seen.files);
    report.complete=true;
  } catch(e) {report.failure=String(e.stack||e);console.error(report.failure);}
  finally {clearTimeout(timer);report.finishedAt=new Date().toISOString();write(path.join(out,'report.json'),report);win?.destroy();server?.close();app.exit(report.complete?0:1);}
}

if(process.versions.electron) {
  capture(process.argv[2],process.argv[3]).catch(e=>{console.error(e);require('electron').app.exit(1);});
} else if(process.argv[2]==='verify') {
  require('../verify.cjs');
} else {
  const [exe,out,ground]=process.argv.slice(2);
  assert(['on','off'].includes(ground),'Specify ground on or off as the last argument.');
  assert(exe && path.isAbsolute(out),'Pass the installed Electron executable and a new absolute output directory.');
  fs.mkdirSync(out);const runtime=path.join(out,'runtime');fs.mkdirSync(runtime);
  const result=cp.spawnSync(exe,[__filename,out,ground,fixture],{cwd:fixture,env:{...cleanEnvironment(runtime), WORLD_FIXTURE:fixture},stdio:'inherit',windowsHide:true});
  if(result.error) throw result.error;
  process.exitCode=result.status??1;
}
