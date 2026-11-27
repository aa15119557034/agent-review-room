'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const views = ['art-a-street', 'art-b-konbini', 'art-c-alley', 'art-d-laundry',
  'sample-e-harbour', 'sample-f-hillside', 'sample-g-rail', 'sample-h-north'];
const settings = { width: 1440, height: 900, dpr: 1, clockSeconds: 5, seed: '0x254',
  warmup: 60, renderedFrames: 120, measuredFrames: 118, rounds: 3 };
const order = [['base','candidate'], ['candidate','base'], ['base','candidate']];
const mode = process.argv[2] || '';

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
  const results = [], profiles = [], poses = new Map();
  let gpu;
  function outputPath(file) { return path.join(output,file); }
  function save(file,value) { fs.writeFileSync(outputPath(file), JSON.stringify(value,null,2)+'\n'); }
  async function scenario(side,round) {
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
        results.push({side,round,...row});
        console.log(side,round,name,row.p95.toFixed(3),row.samples);
        save('measurements.json',results);
      }
      const runtime = await browser.webContents.executeJavaScript('window.worldBase.errors');
      errors.push(...runtime);
      if (errors.length) throw Error(errors.join('\n'));
      profiles.push({side,round,bakeMs,errors});
    } finally {
      session.webRequest.onCompleted(null);
      session.webRequest.onErrorOccurred(null);
      browser.destroy();
    }
  }
  for (const [index,sides] of order.entries()) {
    for (const side of sides) await scenario(side,index+1);
  }
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
  let clocks, clockFile;
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
    clocks = spawn('nvidia-smi',['--query-gpu=timestamp,clocks.gr,clocks.mem,pstate,temperature.gpu,power.draw,utilization.gpu',
      '--format=csv','-l','1'],{windowsHide:true});
    clocks.stdout.pipe(clockFile);
    clocks.on('error',err => console.error('GPU clock log unavailable:',err.message));
    const env = {...process.env,X51_RENDER_BENCHMARK_CONFIG:JSON.stringify({sources,output})};
    delete env.ELECTRON_RUN_AS_NODE;
    const electron = spawn(path.resolve(executable),[__filename,'--measure'],{env,windowsHide:true,stdio:'inherit'});
    const [status] = await once(electron,'exit');
    if (status !== 0) throw Error('Electron benchmark failed: '+status);
    for (const {root,revision:sha} of Object.values(sources)) {
      if (revision(root)!==sha || execFileSync('git',['status','--porcelain','--','.'],{cwd:root,encoding:'utf8'}).trim()) {
        throw Error('Fixture changed during the comparison: '+root);
      }
    }
  } finally {
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
