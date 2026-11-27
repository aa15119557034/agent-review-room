'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const views = ['art-a-street', 'art-b-konbini', 'art-c-alley', 'art-d-laundry',
  'sample-e-harbour', 'sample-f-hillside', 'sample-g-rail', 'sample-h-north'];
const settings = { width: 1440, height: 900, dpr: 1, clockSeconds: 5, seed: '0x254',
  warmup: 60, renderedFrames: 120, measuredFrames: 118, rounds: 3,
  telemetryIntervalMs: 250, preheatMinMs: 6000, preheatWindowMs: 4000, preheatTimeoutMs: 60000,
  clockTolerance: 0.10, maxRoundAttempts: 3 };
const order = [['base','candidate'], ['candidate','base'], ['base','candidate']];
const mode = process.argv[2] || '';

function median(values) {
  const sorted = [...values].sort((a,b) => a-b);
  const middle = Math.floor(sorted.length/2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle-1]+sorted[middle])*0.5;
}

function outsideTolerance(value, reference) {
  return Math.abs(value-reference)/reference > settings.clockTolerance;
}

function readClocks(file,gpu) {
  return fs.readFileSync(file,'utf8').split(/\r?\n/).flatMap(line => {
    const [timestamp,name,graphics,,,,,utilization] = line.split(',').map(value => value.trim());
    const date = timestamp?.match(/^(\d{4})[/-](\d{2})[/-](\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d+)$/);
    const clock = Number.parseInt(graphics,10), load = Number.parseInt(utilization,10);
    if (!date || !name || !gpu.includes(name) || !Number.isFinite(clock) || clock<=0 || !Number.isFinite(load)) return [];
    const [,year,month,day,hour,minute,second,fraction] = date;
    const time = new Date(+year,+month-1,+day,+hour,+minute,+second,+fraction.padEnd(3,'0').slice(0,3)).getTime();
    return [{time,clock,load}];
  });
}

async function preheatGpu(webContents,clockFile,gpu) {
  await webContents.executeJavaScript("window.worldBase.setView('sample-g-rail')");
  const started = Date.now();
  await delay(settings.preheatMinMs);
  while (Date.now()-started < settings.preheatTimeoutMs) {
    const now = Date.now();
    const samples = readClocks(clockFile,gpu).filter(row => row.time >= Math.max(started,now-settings.preheatWindowMs) && row.load >= 50);
    if (samples.length >= 8 && samples.at(-1).time-samples[0].time >= 2500) {
      const clocks = samples.map(row => row.clock);
      const reference = median(clocks);
      if (clocks.every(value => !outsideTolerance(value,reference))) return {clocks,median:reference};
    }
    await delay(500);
  }
  throw Error('GPU clock did not settle under G load: '+gpu);
}

async function sample(name, capture) {
  const world = window.worldBase;
  const {renderer, camera} = world;
  renderer.setPixelRatio(1);
  renderer.setSize(1440,900,false);
  world.setView(name);
  const frames = (count, onFrame = () => {}) => new Promise(resolve => {
    function step() {
      onFrame();
      if (--count) requestAnimationFrame(step);
      else resolve();
    }
    requestAnimationFrame(step);
  });
  await frames(60);
  const gl = renderer.getContext();
  const hardware = gl.getExtension('WEBGL_debug_renderer_info');
  const gpu = hardware && gl.getParameter(hardware.UNMASKED_RENDERER_WEBGL);
  const pose = {world: camera.matrixWorld.toArray(), projection: camera.projectionMatrix.toArray()};
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  if (!ext) throw Error('GPU timer unavailable');
  const original = renderer.render, queries = [], workload = [];
  let frame = 0;
  const startedAt = Date.now();
  renderer.render = function (...args) {
    const query = gl.createQuery();
    gl.beginQuery(ext.TIME_ELAPSED_EXT,query);
    try { return original.apply(this,args); }
    finally { gl.endQuery(ext.TIME_ELAPSED_EXT); queries.push({query,frame}); }
  };
  try {
    await frames(120, () => {
      workload[frame++] = [renderer.info.render.calls, renderer.info.render.triangles];
    });
  } finally {
    renderer.render = original;
  }
  const endedAt = Date.now();
  let disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
  for (let retry = 0; retry < 50 && !disjoint; retry++) {
    if (queries.every(({query}) => gl.getQueryParameter(query,gl.QUERY_RESULT_AVAILABLE))) break;
    await new Promise(resolve => setTimeout(resolve,60));
    disjoint ||= gl.getParameter(ext.GPU_DISJOINT_EXT);
  }
  const values = new Map();
  for (const {query,frame: i} of queries) {
    if (!disjoint && i > 0 && i < 119 && gl.getQueryParameter(query,gl.QUERY_RESULT_AVAILABLE)) {
      values.set(i, (values.get(i) ?? 0) + gl.getQueryParameter(query,gl.QUERY_RESULT) / 1e6);
    }
    gl.deleteQuery(query);
  }
  const sorted = [...values.values()].sort((a,b) => a-b);
  if (disjoint || sorted.length !== 118) throw Error('Invalid GPU samples for ' + name);
  if (!gpu) throw Error('GPU identity unavailable');
  const png = capture && renderer.domElement.toDataURL('image/png').split(',')[1];
  return {name, gpu, pose, png, startedAt, endedAt, samples: sorted.length,
    p95: sorted[Math.ceil(sorted.length*.95)-1], gpuMs: Object.fromEntries(values), workload};
}

async function inElectron() {
  const {app,BrowserWindow} = require('electron');
  const {sources,output} = JSON.parse(process.env.X51_RENDER_BENCHMARK_CONFIG);
  app.commandLine.appendSwitch('force-device-scale-factor','1');
  app.commandLine.appendSwitch('disable-gpu-vsync');
  app.commandLine.appendSwitch('disable-frame-rate-limit');
  app.setPath('userData',outputPath('browser-profile'));
  app.on('window-all-closed', () => {});
  await app.whenReady();
  const poses = new Map(), attempts = [];
  let gpu;
  function outputPath(file) { return path.join(output,file); }
  function save(file,value) { fs.writeFileSync(outputPath(file), JSON.stringify(value,null,2)+'\n'); }
  async function scenario(side,round,attempt) {
    const browser = new BrowserWindow({width:settings.width,height:settings.height,useContentSize:true,show:false,
      webPreferences:{offscreen:true,backgroundThrottling:false,
        preload:path.join(__dirname,'benchmark-freeze.cjs'),contextIsolation:false}});
    const errors = [], session = browser.webContents.session;
    browser.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
    const filter = {urls:['http://127.0.0.1:*/*']};
    session.webRequest.onCompleted(filter, event => { if (event.statusCode >= 400) errors.push(event.statusCode+' '+event.url); });
    session.webRequest.onErrorOccurred(filter, event => errors.push(event.error+' '+event.url));
    try {
      await browser.loadURL(sources[side].url+'?time=evening');
      for (let retry = 0; ; retry++) {
        const state = await browser.webContents.executeJavaScript('({ready: !!window.worldBase?.ready, errors:window.worldBase?.errors??[]})');
        if (state.errors.length || errors.length) throw Error([...state.errors,...errors].join('\n'));
        if (state.ready) break;
        if (retry === 599) throw Error('Scene failed to become ready');
        await delay(200);
      }
      const bakeMs = await browser.webContents.executeJavaScript('window.worldBase.refl?.bakeMs ?? null');
      const rendererName = await browser.webContents.executeJavaScript(`(() => {
        const gl = window.worldBase.renderer.getContext();
        const extension = gl.getExtension('WEBGL_debug_renderer_info');
        return extension && gl.getParameter(extension.UNMASKED_RENDERER_WEBGL);
      })()`);
      if (!rendererName || (gpu && rendererName!==gpu)) throw Error('GPU identity changed or is unavailable');
      gpu = rendererName;
      const clockFile = outputPath('gpu-clocks.csv');
      const warmed = await preheatGpu(browser.webContents,clockFile,gpu);
      const rows = [];
      for (const name of views) {
        const {png,...row} = await browser.webContents.executeJavaScript('('+sample.toString()+')('+JSON.stringify(name)+','+(round===1)+')');
        gpu ??= row.gpu;
        if (row.gpu !== gpu) throw Error('The GPU changed during comparison');
        if (poses.has(name) && poses.get(name)!==JSON.stringify(row.pose)) throw Error('Camera matrices changed for '+name);
        poses.set(name,JSON.stringify(row.pose));
        if (png) {
          const image = Buffer.from(png,'base64');
          if (image.readUInt32BE(16)!==settings.width || image.readUInt32BE(20)!==settings.height) throw Error('Incorrect PNG size');
          fs.writeFileSync(outputPath(side+'-'+name+'.png'),image);
        }
        rows.push({side,round,attempt,...row});
        console.log(side,round,attempt,name,row.p95.toFixed(3),row.samples);
      }
      const runtime = await browser.webContents.executeJavaScript('window.worldBase.errors');
      errors.push(...runtime);
      if (errors.length) throw Error(errors.join('\n'));
      const telemetry = readClocks(clockFile,gpu);
      const clockWindows = Object.fromEntries(rows.map(row => [
        row.name, telemetry.filter(sample => sample.time>=row.startedAt && sample.time<=row.endedAt).map(sample => sample.clock),
      ]));
      const coverage = Object.values(clockWindows);
      const clockMedian = coverage.every(series => series.length) ? median(coverage.map(median)) : null;
      return {rows,profile:{side,round,attempt,bakeMs,errors,warmed,clockMedian,clockWindows}};
    } finally {
      session.webRequest.onCompleted(null);
      session.webRequest.onErrorOccurred(null);
      browser.destroy();
    }
  }
  const accepted = new Map(), retries = new Map();
  while (accepted.size < order.length) {
    for (const [index,sides] of order.entries()) {
      const round = index+1;
      if (accepted.has(round)) continue;
      const attempt = (retries.get(round)??0)+1;
      if (attempt>settings.maxRoundAttempts) throw Error('GPU clock did not pass comparison for round '+round);
      retries.set(round,attempt);
      const pair = [];
      for (const side of sides) pair.push(await scenario(side,round,attempt));
      const clocks = pair.map(side => side.profile.clockMedian);
      const validCoverage = clocks.every(value => value!==null);
      const clockMedian = validCoverage ? median(clocks) : null;
      const reason = !validCoverage ? 'missing clock samples' :
        clocks.some(value => outsideTolerance(value,clockMedian)) ? 'sides differ from round median' : null;
      const record = {round,attempt,clockMedian,reason,profiles:pair.map(item => item.profile)};
      attempts.push(record);
      if (reason) console.warn('Repeating round',round,reason,clocks);
      else accepted.set(round,{record,rows:pair.flatMap(side => side.rows)});
      save('clock-attempts.json',attempts);
    }
    if (accepted.size===order.length) {
      const reference = median([...accepted.values()].map(pair => pair.record.clockMedian));
      for (const [round,pair] of accepted) {
        if (outsideTolerance(pair.record.clockMedian,reference) ||
          pair.record.profiles.some(profile => outsideTolerance(profile.clockMedian,reference))) {
          pair.record.reason = 'clock differs from three-round median';
          console.warn('Repeating round',round,pair.record.reason,pair.record.clockMedian,reference);
          accepted.delete(round);
        }
      }
      save('clock-attempts.json',attempts);
    }
    save('measurements.json',[...accepted.values()].flatMap(pair => pair.rows));
  }
  const validRounds = [...accepted].sort((a,b)=>a[0]-b[0]).map(([,pair])=>pair);
  const results = validRounds.flatMap(pair=>pair.rows);
  const profiles = validRounds.flatMap(pair=>pair.record.profiles);
  save('measurements.json',results);
  const summary = views.map(name => {
    const sampleSide = side => {
      const rounds = results.filter(row => row.name===name && row.side===side).map(row => row.p95);
      return {rounds,p95:[...rounds].sort((a,b)=>a-b)[1]};
    };
    return {name,base:sampleSide('base'),candidate:sampleSide('candidate')};
  });
  save('report.json',{settings,order,sources,profiles,gpu,summary});
  app.exit(0);
}

function revision(root) {
  return execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
}

async function compare() {
  const [executable,baseline,candidate,destination] = process.argv.slice(2);
  if (!destination || process.argv.length!==6) {
    throw Error('Usage: node scripts/benchmark-render.cjs <electron executable> <baseline fixture dir> <candidate fixture dir> <output dir>');
  }
  const output = path.resolve(destination);
  fs.mkdirSync(output,{recursive:true});
  const servers = [], sources = {};
  let clocks, clockFile, electron;
  try {
    for (const [side,directory] of [['base',baseline],['candidate',candidate]]) {
      const root = path.resolve(directory);
      const source = revision(root);
      if (execFileSync('git',['status','--porcelain','--','.'],{cwd:root,encoding:'utf8'}).trim()) {
        throw Error('Fixture worktree must match its revision: '+root);
      }
      const { createStaticServer } = require(path.join(root,'scripts','baseline.cjs'));
      const server = createStaticServer(root);
      servers.push(server);
      server.listen(0,'127.0.0.1');
      await once(server,'listening');
      sources[side] = {root,revision:source,url:'http://127.0.0.1:'+server.address().port+'/'};
    }
    clockFile = fs.createWriteStream(path.join(output,'gpu-clocks.csv'));
    clocks = spawn('nvidia-smi',['--query-gpu=timestamp,name,clocks.gr,clocks.mem,pstate,temperature.gpu,power.draw,utilization.gpu',
      '--format=csv','--loop-ms='+settings.telemetryIntervalMs],{windowsHide:true});
    clocks.stdout.pipe(clockFile);
    const monitorStopped = once(clocks,'exit').then(([status]) => { throw Error('GPU clock monitor exited: '+status); });
    const env = {...process.env,X51_RENDER_BENCHMARK_CONFIG:JSON.stringify({sources,output})};
    delete env.ELECTRON_RUN_AS_NODE;
    electron = spawn(path.resolve(executable),[__filename,'--measure'],{env,windowsHide:true,stdio:'inherit'});
    const [status] = await Promise.race([once(electron,'exit'),monitorStopped]);
    if (status !== 0) throw Error('Electron benchmark failed: '+status);
    for (const {root,revision:sha} of Object.values(sources)) {
      if (revision(root)!==sha || execFileSync('git',['status','--porcelain','--','.'],{cwd:root,encoding:'utf8'}).trim()) {
        throw Error('Fixture changed during the comparison: '+root);
      }
    }
  } finally {
    if (electron && electron.exitCode===null) electron.kill();
    if (clocks) {
      clocks.stdout.unpipe(clockFile);
      clocks.kill();
    }
    clockFile?.end();
    for (const server of servers) server.close();
  }
}

if (mode === '--measure' && process.versions.electron) {
  inElectron().catch(error => { console.error(error); require('electron').app.exit(1); });
} else {
  compare().catch(error => { console.error(error); process.exitCode=1; });
}
