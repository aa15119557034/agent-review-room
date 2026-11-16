const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const output=path.resolve(process.argv[2]),capture=process.argv.includes('--capture');
app.setPath('userData',path.join(output,capture?'capture-profile':'preview-profile'));
app.commandLine.appendSwitch('force-device-scale-factor','1');
app.whenReady().then(async()=>{
 const errors=[];const win=new BrowserWindow({width:1440,height:1000,title:'雨あかり · 三渲二雨夜街角',autoHideMenuBar:true,backgroundColor:'#20253f',webPreferences:{contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
 win.webContents.on('console-message',details=>{if(details.level==='error'||details.level===3){errors.push(details.message);console.error(details.message);}});
 win.webContents.on('render-process-gone',(_event,details)=>{console.error(details);app.exit(1);});
 await win.loadFile(path.join(output,'viewer/index.html'));
 if(!capture)return;
 const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms)),js=code=>win.webContents.executeJavaScript(code),snap=async name=>fs.writeFileSync(path.join(output,name+'.png'),(await win.webContents.capturePage()).toPNG());
 await pause(6500);
 const ready=await js(`({ready:window.rainyKonbini?.ready,errors:window.rainyKonbini?.errors,canvas:document.querySelectorAll('canvas').length,ui:[...document.body.children].filter(x=>!['SCRIPT','CANVAS'].includes(x.tagName)).length})`);
 assert.equal(ready.ready,true);assert.equal(ready.ui,0);assert.equal(ready.canvas,1);assert.deepEqual(ready.errors,[]);assert.deepEqual(errors,[]);
  const bounds=await js('window.rainyKonbini.bounds');
  for(const axis of [0,2]){assert.ok(bounds.min[axis]>=-7.001,'base contains minimum');assert.ok(bounds.max[axis]<=7.001,'base contains maximum');}
 await snap('01-overview');
 await js(`(()=>{const f=window.rainyKonbini;f.controls.target.set(-1.8,1.6,.2);f.camera.position.set(7,6,16);f.camera.zoom=2.3;f.camera.updateProjectionMatrix();f.controls.update()})()`);await pause(1500);await snap('02-storefront');
 await js(`(()=>{const f=window.rainyKonbini;f.controls.target.set(-1.4,1.35,-1.7);f.camera.position.set(-.3,3.0,9);f.camera.zoom=3.4;f.camera.updateProjectionMatrix();f.controls.update()})()`);await pause(1500);await snap('03-interior');
 await js(`(()=>{const f=window.rainyKonbini;f.controls.target.set(0,2.30,0);f.camera.position.set(-20,15,-21);f.camera.zoom=1.1;f.camera.updateProjectionMatrix();f.controls.update()})()`);await pause(1500);await snap('04-back');
  if(process.argv.includes('--stills')){assert.deepEqual(errors,[]);console.log('Four unchanged camera views captured; no renderer errors.');win.close();app.quit();return;}
 await js(`(()=>{const f=window.rainyKonbini;f.controls.target.set(0,2.30,0);f.camera.position.set(18,14,22);f.camera.zoom=1.1;f.camera.updateProjectionMatrix();f.controls.update();f.frameTimes.length=0})()`);
 const waitForOpen=await js(`Math.max(0,12.2-window.rainyKonbini.elapsed)*1000`);await pause(waitForOpen);
 const animation=await js(`new Promise((resolve,reject)=>{const f=window.rainyKonbini,start=f.elapsed,states=[],canvas=document.querySelector('canvas'),stream=canvas.captureStream(30);const mime=['video/webm;codecs=vp9','video/webm;codecs=vp8'].find(x=>MediaRecorder.isTypeSupported(x));if(!mime){reject(Error('WebM recorder unavailable'));return}const recorder=new MediaRecorder(stream,{mimeType:mime,videoBitsPerSecond:3500000}),chunks=[];recorder.ondataavailable=e=>chunks.push(e.data);recorder.onerror=e=>reject(Error(e.error?.message||'Recorder failed'));const timer=setInterval(()=>states.push({t:f.elapsed,open:f.doorOpening,rain:f.effects.rain.material.uniforms.time.value,signal:f.street.signalMats.map(x=>x.color.toArray())}),150);recorder.onstop=async()=>{clearInterval(timer);stream.getTracks().forEach(x=>x.stop());const bytes=new Uint8Array(await new Blob(chunks,{type:mime}).arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=16384)binary+=String.fromCharCode(...bytes.subarray(i,i+16384));resolve({mime,data:btoa(binary),states,start,end:f.elapsed})};recorder.start();setTimeout(()=>recorder.stop(),8200)})`);
 fs.writeFileSync(path.join(output,'rainy-konbini.webm'),Buffer.from(animation.data,'base64'));delete animation.data;
 assert.ok(animation.states.some(x=>x.open>.95),'door opens');assert.ok(animation.states.at(-1).open<.05,'door closes');assert.ok(animation.states.at(-1).rain>animation.states[0].rain+7,'rain clock advances');
 fs.writeFileSync(path.join(output,'animation-report.json'),JSON.stringify(animation,null,2));
 await js('window.rainyKonbini.frameTimes.length=0');
 await pause(15000);
  const report=await js(`(()=>{const f=window.rainyKonbini,times=f.frameTimes.slice(),sorted=times.slice().sort((a,b)=>a-b),gl=f.renderer.getContext(),d=gl.getExtension('WEBGL_debug_renderer_info');return{ready:f.ready,errors:f.errors,elapsed:f.elapsed,statistics:f.statistics,features:f.features,frameCount:times.length,fps:times.length/times.reduce((a,b)=>a+b,0)*1000,p95Ms:sorted[Math.floor(sorted.length*.95)],drawCalls:f.renderer.info.render.calls,triangles:f.renderer.info.render.triangles,gpu:d?gl.getParameter(d.UNMASKED_RENDERER_WEBGL):null,width:innerWidth,height:innerHeight,pixelRatio:f.renderer.getPixelRatio(),doorOpening:f.doorOpening,rainTime:f.effects.rain.material.uniforms.time.value,paintedReflectionTime:f.effects.ground.time.value,lightPools:f.effects.ground.pools,outline:{kind:'depth-normal-sobel',widthAt1080p:1.8},memory:f.renderer.info.memory}})()`);
  report.puddles=await js('({count:window.rainyKonbini.effects.ripples.count,opacity:window.rainyKonbini.effects.puddles.opacity,patches:window.rainyKonbini.effects.puddles.patches})');
   report.bounds=bounds;
  // Check the actual pixels: a running shader alone does not prove that its
  // ground light is visible (the first-round failure this review identified).
  const mean=(image,probe)=>{const {width,height}=image.getSize(),bytes=image.toBitmap();let sum=0,n=0;for(let y=probe.y-4;y<=probe.y+4;y++)for(let x=probe.x-4;x<=probe.x+4;x++){assert.ok(x>=0&&x<width&&y>=0&&y<height);const i=(y*width+x)*4;sum+=bytes[i]+bytes[i+1]+bytes[i+2];n+=3;}return sum/n;};
   report.lightPixelGain=[];
   for(const view of [
     {name:'01-overview',points:[['shop',-2.2,.277,2.72],['lamp',4.6,.075,3.75]]},
     {name:'04-back',points:[['vending',2.10,.277,-6.29],['service-door',-.15,.277,-5.95]]}
   ]){
     if(view.name==='04-back'){await js(`(()=>{const f=window.rainyKonbini;f.controls.target.set(0,2.30,0);f.camera.position.set(-20,15,-21);f.camera.zoom=1.1;f.camera.updateProjectionMatrix();f.controls.update()})()`);await pause(1000);}
     const probes=await js(`${JSON.stringify(view.points)}.map(([name,x,y,z])=>{const p=window.rainyKonbini.camera.position.clone().set(x,y,z).project(window.rainyKonbini.camera);return{name,x:Math.round((p.x*.5+.5)*innerWidth),y:Math.round((.5-p.y*.5)*innerHeight)}})`);
     await js('window.rainyKonbini.effects.ground.group.visible=false');await pause(250);const unlit=await win.webContents.capturePage();
     await js('window.rainyKonbini.effects.ground.group.visible=true');await pause(250);const lit=await win.webContents.capturePage();
     report.lightPixelGain.push(...probes.map(probe=>({...probe,view:view.name,unlit:mean(unlit,probe),lit:mean(lit,probe)})));
   }
  for(const probe of report.lightPixelGain)assert.ok(probe.lit>probe.unlit+3,probe.name+' ground light must be visible');
  win.setContentSize(960,640);await pause(1000);
  report.resize=await js(`(()=>{const f=window.rainyKonbini,c=document.querySelector('canvas');return{canvas:[c.width,c.height],outline:[f.outline.target.width,f.outline.target.height],radius:f.outline.material.uniforms.radius.value,errors:f.errors}})()`);
  assert.deepEqual(report.resize.outline,report.resize.canvas);assert.deepEqual(report.resize.errors,[]);
 fs.writeFileSync(path.join(output,'render-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));assert.deepEqual(report.errors,[]);assert.deepEqual(errors,[]);win.close();app.quit();
}).catch(e=>{console.error(e);app.exit(1);});
