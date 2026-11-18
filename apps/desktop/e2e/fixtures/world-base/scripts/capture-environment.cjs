const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { createStaticServer, cleanEnvironment } = require('./baseline.cjs');
const [executable, directory, variant, sceneDirectory] = process.argv.slice(2);
const fixture = path.resolve(sceneDirectory || path.join(__dirname, '..'));
const output = path.resolve(directory);
const runtime = path.join(output, 'runtime');
const write = (file, data) => fs.writeFileSync(path.join(output, file), JSON.stringify(data, null, 2));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

if (!process.versions.electron) {
  if (!['before', 'after'].includes(variant)) throw new Error('Expected electron.exe output-directory before|after');
  fs.mkdirSync(output, { recursive: true });
  const log = fs.openSync(path.join(output, 'electron.log'), 'w');
  const child = cp.spawnSync(executable, [__filename, executable, output, variant, fixture], {
    cwd: fixture, windowsHide: true, env: cleanEnvironment(runtime), timeout: 300000, stdio: ['ignore', log, log],
  });
  fs.closeSync(log);
  console.log(variant, output, child.error?.message || child.status);
  process.exit(child.status ?? 1);
}

const { app, BrowserWindow } = require('electron');
app.setPath('userData', path.join(runtime, 'user-data'));
app.commandLine.appendSwitch('force-device-scale-factor', '1');
const report = { variant, started: new Date(), errors: [], requests: [], shots: [], samples: [] };
const deadline = setTimeout(() => finish(new Error('Scene capture timed out')), 270000);
let win, server;
function finish(err) {
  if (err) report.errors.push(String(err.stack || err));
  report.ended = new Date();
  write('report.json', report);
  clearTimeout(deadline);
  server?.close();
  app.exit(report.errors.length ? 1 : 0);
}
app.whenReady().then(async () => {
  server = createStaticServer(fixture);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  win = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, show: true, autoHideMenuBar: true,
    webPreferences: { backgroundThrottling: false, sandbox: true, contextIsolation: true } });
  const wc = win.webContents;
  const evaluate = expr => wc.executeJavaScript(expr);
  wc.on('console-message', (e) => {
    if (e.level === 'error') report.errors.push(e.message);
    if (e.message?.startsWith('[world-base]') || e.level === 'error') console.log(e.message);
  });
  wc.session.webRequest.onErrorOccurred(item => report.requests.push({ url: item.url, error: item.error }));
  await win.loadURL('http://127.0.0.1:' + server.address().port);
  while (!await evaluate('window.worldBase?.ready')) {
    const errors = await evaluate('window.worldBase?.errors');
    if (errors?.length) throw new Error(errors.join('\n'));
    await pause(250);
  }
  const state = () => evaluate(`(() => { const w=worldBase, g=w.renderer.getContext(), ext=g.getExtension('WEBGL_debug_renderer_info');
    return { gpu:g.getParameter(ext.UNMASKED_RENDERER_WEBGL), camera:w.camera.position.toArray(), direction:w.camera.quaternion.toArray(),
      fov:w.camera.fov, feet:w.walker.worldPosition.toArray(), weather:w.island.weather?.state, errors:w.errors, size:[innerWidth,innerHeight,devicePixelRatio] }; })()`);
  async function view(name) {
    await evaluate(`(()=>{const w=worldBase; w.setView('station-street');
      const views={coast:[[270,2.58,1110],[-55,3,1230]],ridge:[[650,237.5,215],[-65,145,300]],
        trail:[[287,13.05,1026],[300,1.0,1100]]};
      const v=views[${JSON.stringify(name)}];
      if(v){w.camera.position.fromArray(v[0]);w.camera.lookAt(...v[1]);w.camera.updateMatrixWorld();}
      document.body.classList.add('hide-ui');})()`);
  }
  async function shot(name) {
    await pause(250);
    const capture = await wc.capturePage();
    fs.writeFileSync(path.join(output, name + '.jpg'), capture.toJPEG(90));
    report.shots.push({ name, ...await state() });
  }
  async function sample(name, walking) {
    await pause(1800);
    const start = await state();
    if (walking) wc.sendInputEvent({ type: 'keyDown', keyCode: 'W' });
    try {
      const frames = await evaluate(`new Promise(resolve=>{const ms=[];let first,prev;
        function next(t){first??=t;if(prev!==undefined)ms.push(t-prev);prev=t;
        if(t-first>=6000)resolve(ms);else requestAnimationFrame(next);}requestAnimationFrame(next);})`);
      const end = await state();
      const dist = Math.hypot(end.feet[0]-start.feet[0],end.feet[2]-start.feet[2]);
      if (walking && dist < 1) throw new Error(name + ' did not move');
      const sorted = [...frames].sort((a,b)=>a-b);
      report.samples.push({name, start, end, distance:dist, fps:1000*frames.length/frames.reduce((a,b)=>a+b,0), p95:sorted[Math.ceil(sorted.length*.95)-1], frames});
      console.log('sample', name, frames.length);
    } finally { if (walking) wc.sendInputEvent({ type:'keyUp', keyCode:'W' }); }
  }

  for (const name of ['street','coast','trail','ridge']) { await view(name); await shot(name+'-clear'); }
  if (variant === 'after') {
    for (const t of [24, 48, 80]) {
      while (await evaluate('worldBase.island.weather.state.seconds') < t) await pause(300);
      for (const name of ['street','coast']) { await view(name); await shot(name+'-'+t); }
      if (t === 48) {
        for (const name of ['coast','street']) { await view(name); await sample(name+'-front',false); }
      }
    }
  }
  for (const name of ['coast','street']) { await view(name); await sample(name,false); }
  for (const mode of ['third','first']) {
    await evaluate(`worldBase.startWalking();worldBase.walker.setView('${mode}');document.querySelector('#world').focus()`);
    await sample('walking-'+mode,true);
    await shot('walking-'+mode);
  }
  report.behavior = await evaluate(`import('./src/station-validation.js').then(m=>m.validateStation(worldBase))`);
  if (!report.behavior.ok) throw new Error('Station validation failed');
  if (variant === 'after') {
    await evaluate(`import('./scripts/validate-environment.js').then(m => {
      const drive = m.beginTrailWalk(worldBase);
      let id;
      const steer = () => { drive.steer(1); id = requestAnimationFrame(steer); };
      steer();
      window.stopTrailCapture = () => { cancelAnimationFrame(id); drive.release(); };
    })`);
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'W' });
    const trailStart = Date.now();
    try {
      for (const seconds of [0, 10, 21, 32]) {
        await pause(Math.max(0, trailStart + seconds * 1000 - Date.now()));
        await shot('trail-walk-' + seconds);
      }
    } finally {
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'W' });
      await evaluate('window.stopTrailCapture()');
    }
    const trailShots = report.shots.filter(s => s.name.startsWith('trail-walk'));
    if (trailShots.at(-1).feet[2] - trailShots[0].feet[2] < 80) throw new Error('Coastal walk did not reach the beach');
    report.environment = await evaluate(`import('./scripts/validate-environment.js').then(m=>m.validateEnvironment(worldBase))`);
    if (!report.environment.ok) throw new Error('Environment validation failed');
  }
  if (report.requests.length) throw new Error('Network request failed; see requests');
  finish();
}).catch(finish);
