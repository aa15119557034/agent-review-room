// Temporary profiling driver. Does not modify or import fixture scene code in Node.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const fixture = 'D:/codex/2026-11-16/world-implementation/world-base/apps/desktop/e2e/fixtures/world-base';
const { createStaticServer, cleanEnvironment } = require(path.join(fixture, 'scripts/baseline.cjs'));
const expectedCommit = '76a000dbded2ed581f41eae5446b37137a1aafe4';
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function sourceFiles() {
  const files = {};
  function walk(file) {
    if (fs.statSync(file).isDirectory()) { for (const name of fs.readdirSync(file).sort()) walk(path.join(file, name)); }
    else if (/\.(?:js|mjs|cjs|html|css|json)$/.test(file)) files[path.relative(fixture, file).replace(/\\/g, '/')] = hash(fs.readFileSync(file));
  }
  for (const name of ['index.html', 'city-assets.json', 'src', 'upstream', 'vendor']) if (fs.existsSync(path.join(fixture, name))) walk(path.join(fixture, name));
  return files;
}
function launch() {
  const args = {};
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i], split = arg.indexOf('=');
    if (!arg.startsWith('--')) throw new Error('Expected --option');
    const key = arg.slice(2, split < 0 ? undefined : split);
    args[key] = split < 0 ? (key === 'help' ? true : process.argv[++i]) : arg.slice(split + 1);
  }
  if (args.help) { console.log('node x51-profile-walking-no-trace.cjs --electron=<existing executable> [--output=<new directory>] [--timeout-ms=180000]'); return; }
  for (const name of Object.keys(args)) if (!['electron', 'output', 'timeout-ms'].includes(name)) throw new Error('Unknown --' + name);
  if (typeof args.electron !== 'string' || !fs.statSync(args.electron).isFile()) throw new Error('--electron must exist');
  const output = path.resolve(args.output || path.join(fixture, 'artifacts/walking-profile-76a-v2'));
  if (fs.existsSync(output)) throw new Error('Output already exists; preserve earlier evidence');
  // This also catches working-tree edits relative to the requested scene commit.
  cp.execFileSync('git', ['diff', '--quiet', expectedCommit, '--', 'index.html', 'city-assets.json', 'src', 'upstream', 'vendor'], { cwd: fixture, windowsHide: true });
  const files = sourceFiles();
  const referenceFile = path.join(fixture, 'artifacts/gpu-city-v4/render-report.json');
  const reference = JSON.parse(fs.readFileSync(referenceFile, 'utf8'));
  const referenceManifest = JSON.parse(fs.readFileSync(path.join(path.dirname(referenceFile), 'source-manifest.json'), 'utf8'));
  const names = new Set([...Object.keys(files), ...Object.keys(referenceManifest.files)]);
  const changed = [...names].filter(name => files[name] !== referenceManifest.files[name]);
  if (changed.length) throw new Error('Source differs from gpu-city-v4: ' + changed.join(', '));
  const routes = ['third', 'first'].map(mode => {
    const segment = reference.walkingValidation.segments.find(s => s.mode === mode);
    if (!segment || segment.before.feet.length !== 3) throw new Error('Missing original route ' + mode);
    return { mode, feet: segment.before.feet, yawDegrees: 4, pitchDegrees: -8 };
  });
  const config = { fixture, output, expectedCommit, head: cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fixture, encoding: 'utf8', windowsHide: true }).trim(),
    startedAt: new Date().toISOString(), timeoutMs: Number(args['timeout-ms'] ?? 180000), warmupMs: 1500, sampleMs: 3000,
    referenceFile, referenceSha256: hash(fs.readFileSync(referenceFile)), routes,
    scriptSha256: hash(fs.readFileSync(__filename)), baselineSha256: hash(fs.readFileSync(path.join(fixture, 'scripts/baseline.cjs'))) };
  if (!Number.isFinite(config.timeoutMs) || config.timeoutMs < 10000) throw new Error('Invalid timeout');
  fs.mkdirSync(output, { recursive: true });
  config.runtime = fs.mkdtempSync(path.join(output, 'runtime-'));
  fs.writeFileSync(path.join(output, 'source-manifest.json'), JSON.stringify({ expectedCommit, head: config.head, files }, null, 2));
  const configFile = path.join(config.runtime, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  fs.writeFileSync(path.join(output, 'run-config.json'), JSON.stringify(config, null, 2));
  const log = fs.openSync(path.join(output, 'electron.log'), 'w');
  const child = cp.spawn(path.resolve(args.electron), [__filename, configFile], { cwd: fixture, windowsHide: true, env: cleanEnvironment(config.runtime), stdio: ['ignore', log, log] });
  fs.closeSync(log);
  child.on('spawn', () => { fs.writeFileSync(path.join(output, 'process.json'), JSON.stringify({ pid: child.pid })); console.log('Walking profiler PID ' + child.pid + '; ' + output); });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => { console.log('Electron exited ' + code); process.exitCode = code === 0 ? 0 : 1; });
}

function installProfiler() {
  const wb = window.worldBase;
  const entries = [['station', wb.station, 'update'], ['walker', wb.walker, 'update'], ['island', wb.island, 'update'], ['render', wb.look, 'render']];
  for (const [name, object, method] of entries) if (typeof object?.[method] !== 'function') throw new Error('Unavailable method: ' + name);
  if (!wb.city?.root || typeof wb.walker.setPose !== 'function') throw new Error('Missing city/pose API');
  const saved = { city: wb.city.root.visible, enabled: wb.walker.enabled, mode: wb.walker.view,
    feet: wb.walker.worldPosition.clone(), yaw: wb.walker.yaw * 180 / Math.PI, pitch: wb.walker.pitch * 180 / Math.PI,
    view: wb.currentView, camera: wb.camera.clone(), hasPrev: wb.look.pipeline.hasPrev };
  const inputAbort = new AbortController();
  const p = window.__walkingProfile = { frames: [], inputEvents: [], collecting: false, elapsed: 0, current: null };
  for (const type of ['keydown', 'keyup']) addEventListener(type, e => {
    if (e.code === 'KeyW') p.inputEvents.push({ type, code: e.code, trusted: e.isTrusted, repeat: e.repeat, nowMs: performance.now(), label: p.current });
  }, { signal: inputAbort.signal });
  const empty = () => Object.fromEntries(entries.map(([name]) => [name, { ms: 0, calls: 0 }]));
  let cpu = empty(), draws = 0, triangles = 0, raf, previous, done, arm = false;
  const restoreMethods = [];
  for (const [name, object, method] of entries) {
    const original = object[method];
    object[method] = function(...args) { const start = performance.now(); try { return Reflect.apply(original, this, args); }
      finally { cpu[name].ms += performance.now() - start; cpu[name].calls++; } };
    restoreMethods.push(() => { object[method] = original; });
  }
  // Same all-pass submission accounting as preview-host, including its JS overhead.
  for (const type of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
    for (const [method, countIndex, instanceIndex] of [['drawArrays', 2], ['drawElements', 1], ['drawArraysInstanced', 2, 3], ['drawElementsInstanced', 1, 4]]) {
      const prototype = type?.prototype, original = prototype?.[method];
      if (!original) continue;
      prototype[method] = function(...args) { const result = Reflect.apply(original, this, args); draws++;
        const n = args[countIndex], mode = args[0];
        triangles += (mode === this.TRIANGLES ? n / 3 : mode === this.TRIANGLE_STRIP || mode === this.TRIANGLE_FAN ? Math.max(0, n - 2) : 0) * (instanceIndex === undefined ? 1 : args[instanceIndex]); return result; };
      restoreMethods.push(() => { prototype[method] = original; });
    }
  }
  function frame(now) {
    if (arm) { arm = false; previous = now; cpu = empty(); draws = 0; triangles = 0; p.collecting = true; }
    else {
      if (p.collecting && previous !== undefined) {
        const ms = now - previous;
        p.frames.push({ nowMs: now, ms, cpu, draws, triangles }); p.elapsed += ms;
        if (p.elapsed >= p.durationMs) { p.collecting = false; performance.mark(p.current + ':end'); done({ frames: p.frames, end: p.state() }); done = null; }
      }
      previous = now; cpu = empty(); draws = 0; triangles = 0;
    }
    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);
  p.state = () => ({ feet: wb.walker.worldPosition.toArray(), yaw: wb.walker.yaw, pitch: wb.walker.pitch,
    mode: wb.walker.view, enabled: wb.walker.enabled, cityVisible: wb.city.root.visible,
    camera: { position: wb.camera.position.toArray(), quaternion: wb.camera.quaternion.toArray() },
    timeOriginMs: performance.timeOrigin, nowMs: performance.now(), islandTime: wb.island.U.uTime.value,
    programs: wb.renderer.info.programs.length, textures: wb.renderer.info.memory.textures, geometries: wb.renderer.info.memory.geometries });
  p.prepare = (route, visible, label) => {
    if (p.collecting || arm) throw new Error('Sample still running');
    p.current = label; wb.city.root.visible = visible;
    wb.startWalking(); wb.walker.setView(route.mode);
    p.resetPose(route); performance.mark(label + ':warmup-start');
    return p.state();
  };
  p.resetPose = route => { wb.walker.setPose(saved.feet.clone().fromArray(route.feet), route.yawDegrees, route.pitchDegrees); wb.look.pipeline.hasPrev = false; return p.state(); };
  p.sample = durationMs => {
    if (p.collecting || arm) throw new Error('Sample already running');
    p.frames = []; p.elapsed = 0; p.durationMs = durationMs; arm = true;
    performance.mark(p.current + ':start'); return new Promise(resolve => { done = resolve; });
  };
  p.restore = () => {
    p.collecting = false; arm = false; cancelAnimationFrame(raf); inputAbort.abort();
    if (done) { done({ aborted: true, frames: p.frames }); done = null; }
    for (const restore of restoreMethods.reverse()) restore();
    wb.city.root.visible = saved.city; wb.walker.setEnabled(false); wb.walker.setView(saved.mode);
    wb.walker.setPose(saved.feet, saved.yaw, saved.pitch);
    wb.setView(saved.view); wb.walker.setEnabled(saved.enabled); wb.camera.copy(saved.camera); wb.camera.updateMatrixWorld();
    wb.look.pipeline.hasPrev = saved.hasPrev;
    return { cityVisible: wb.city.root.visible, walkerEnabled: wb.walker.enabled, mode: wb.walker.view,
      feet: wb.walker.worldPosition.toArray(), methodsRestored: true, inputsRemoved: true };
  };
  return { available: entries.map(([name]) => name), original: p.state() };
}

function summarize(frames) {
  const stats = values => { const sorted = [...values].sort((a, b) => a - b); return { mean: values.reduce((a, b) => a + b, 0) / values.length, p95: sorted[Math.floor(sorted.length * .95)], max: sorted.at(-1) }; };
  const durationMs = frames.reduce((sum, f) => sum + f.ms, 0);
  return { frameCount: frames.length, durationMs, fps: frames.length * 1000 / durationMs, frameMs: stats(frames.map(f => f.ms)),
    framesOver22Ms: frames.filter(f => f.ms > 22).length, draws: stats(frames.map(f => f.draws)), triangles: stats(frames.map(f => f.triangles)),
    cpu: Object.fromEntries(['station', 'walker', 'island', 'render'].map(name => [name, { ...stats(frames.map(f => f.cpu[name].ms)), totalCalls: frames.reduce((sum, f) => sum + f.cpu[name].calls, 0) }])) };
}

async function host() {
  const { app, BrowserWindow } = require('electron');
  const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  app.setPath('userData', path.join(config.runtime, 'user-data')); app.commandLine.appendSwitch('force-device-scale-factor', '1');
  const report = { config, traceEnabled: false, comparison: { referenceDriver: "D:/codex/2026-11-16/world-implementation/handoff/x51-profile-walking.cjs", referenceDriverSha256: "d7ab2ff39f4f6a6daab43a29cd4db0b22bac993e8a14a5b241341aeec2ea515d", onlyMeasurementChange: "CDP Tracing is disabled; wrappers, draw counters, real W route, warmup and network collection are unchanged." }, ok: false, cases: [], stages: [], networkRequests: [], networkFailures: [], httpErrors: [], exceptions: [], consoleErrors: [],
    limitations: ['All six segments include the same CPU wrappers and all-pass draw counters; CDP timeline/CPU profiling is disabled. Wrapper and counter overhead remains; not a replacement performance baseline.',
      'CPU render duration measures JS and synchronous submission, not completed GPU execution. RAF buckets cover work since the previous observer callback.',
      'Animation and wall-clock time continue. ABA is route/visibility controlled, not identical pixels or frozen animation.',
      'Each mode starts at its original gpu-city-v4 segment before.feet, prewarms stationary for 1500ms, resets pose once, then holds real W for at least 3000ms. No per-frame pose override.',
      'Restoration covers methods, visibility, camera, input listeners, walker pose/mode/enabled; elapsed simulation, shader caches and physics internal transient history cannot be rewound. The isolated process exits.'] };
  const write = () => fs.writeFileSync(path.join(config.output, 'walking-profile-report.json'), JSON.stringify(report, null, 2));
  const stage = name => { report.stage = name; report.stages.push({ name, wallTime: Date.now() / 1000 }); write(); console.log(name); };
  let win, server, cdp, tracing = false, expired = false, timeout, stopPoll;
  const requests = new Map();
  const deadline = new Promise((_, reject) => { timeout = setTimeout(() => { expired = true; reject(new Error('Timeout at ' + report.stage)); }, config.timeoutMs); });
  // A local STOP file requests the same key-up/restore/trace-flush path as a failure.
  const stopped = new Promise((_, reject) => { stopPoll = setInterval(() => {
    if (fs.existsSync(path.join(config.output, 'STOP'))) { expired = true; report.stopRequested = true; reject(new Error('Stop requested')); }
  }, 250); });
  const bounded = (promise, ms, label) => { let timer; return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms); })]).finally(() => clearTimeout(timer)); };
  const evaluate = code => { if (expired) throw new Error('Deadline elapsed'); return win.webContents.executeJavaScript(code, true); };
  async function run() {
    stage('bootstrap'); await app.whenReady(); if (expired) return; stage('app-ready');
    server = createStaticServer(fixture); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); stage('server-ready');
    win = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, show: true, autoHideMenuBar: true,
      title: 'X51 walking CPU/trace profile', webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false } });
    await win.loadURL('about:blank'); stage('blank-ready'); win.webContents.debugger.attach('1.3');
    cdp = (method, params) => win.webContents.debugger.sendCommand(method, params);
    win.webContents.debugger.on('message', (_event, method, params) => {
      const event = { method, stage: report.stage, receivedWallTime: Date.now() / 1000, ...params };
      if (method === 'Runtime.exceptionThrown') report.exceptions.push(event);
      if (method === 'Runtime.consoleAPICalled' && params.type === 'error') report.consoleErrors.push(event);
      if (!['Network.requestWillBeSent', 'Network.responseReceived', 'Network.loadingFinished', 'Network.loadingFailed'].includes(method)) return;
      let row = requests.get(params.requestId);
      if (!row) { row = { requestId: params.requestId, events: [] }; requests.set(params.requestId, row); report.networkRequests.push(row); }
      row.events.push(event);
      if (method === 'Network.requestWillBeSent') { row.url = params.request.url; if (params.type === 'Document') { report.documentAnchors ??= []; report.documentAnchors.push(event); } }
      if (method === 'Network.loadingFailed') report.networkFailures.push(event);
      if (method === 'Network.responseReceived' && params.response.status >= 400) report.httpErrors.push(event);
    });
    win.webContents.on('render-process-gone', (_event, details) => report.exceptions.push({ stage: report.stage, processGone: details }));
    await cdp('Runtime.enable'); await cdp('Network.enable'); stage('loading-scene');
    await win.loadURL('http://127.0.0.1:' + server.address().port + '/');
    while (!await evaluate('window.worldBase?.ready === true')) {
      const errors = await evaluate('window.worldBase?.errors || []'); if (errors.length) throw new Error(JSON.stringify(errors)); await pause(100);
    }
    report.runtime = { electron: process.versions.electron, chrome: process.versions.chrome };
    stage('installing-profiler'); report.installation = await evaluate('(' + installProfiler.toString() + ')()');
    // Controlled v2 comparison: do not start CDP Tracing. The unchanged guarded cleanup remains inactive.
    report.traceCategories = null;
    win.focus(); win.webContents.focus();
    for (const route of config.routes) for (const [variant, visible] of [['A1', true], ['B', false], ['A2', true]]) {
      const label = route.mode + '-' + variant;
      stage(label + '-warmup');
      const row = { label, route, cityVisible: visible, warmupStart: await evaluate('window.__walkingProfile.prepare(' + JSON.stringify(route) + ',' + visible + ',' + JSON.stringify(label) + ')') };
      report.cases.push(row); await pause(config.warmupMs);
      row.warmupEnd = await evaluate('window.__walkingProfile.state()');
      row.before = await evaluate('window.__walkingProfile.resetPose(' + JSON.stringify(route) + ')');
      stage(label + '-walking');
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'W' });
      let result;
      try { result = await evaluate('window.__walkingProfile.sample(' + config.sampleMs + ')'); }
      finally { if (!win.isDestroyed()) win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'W' }); }
      if (result.aborted) throw new Error('Sample aborted');
      row.end = result.end; row.afterKeyUp = await evaluate('window.__walkingProfile.state()');
      row.samplesFile = 'frames-' + label + '.json'; fs.writeFileSync(path.join(config.output, row.samplesFile), JSON.stringify(result.frames));
      row.summary = summarize(result.frames);
      row.horizontalDistance = Math.hypot(result.end.feet[0] - row.before.feet[0], result.end.feet[2] - row.before.feet[2]);
      row.inputEvents = (await evaluate('window.__walkingProfile.inputEvents')).filter(e => e.label === label);
      row.routeValid = row.before.feet.every((v, i) => Math.abs(v - route.feet[i]) < 1e-10) && row.before.mode === route.mode && row.end.mode === route.mode &&
        row.before.cityVisible === visible && row.end.cityVisible === visible && row.horizontalDistance > 1 && result.frames.length > 0 &&
        row.inputEvents.some(e => e.type === 'keydown' && e.trusted) && row.inputEvents.some(e => e.type === 'keyup' && e.trusted);
      write();
    }
  }
  try { await Promise.race([run(), deadline, stopped]); }
  catch (error) { report.failure = error.stack || String(error); console.error(error); }
  finally {
    clearTimeout(timeout); clearInterval(stopPoll); stage('restoring');
    if (win && !win.isDestroyed()) {
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'W' });
      try { report.restore = await bounded(win.webContents.executeJavaScript('window.__walkingProfile?.restore()'), 3000, 'Restore timeout'); }
      catch (error) { report.restoreFailure = String(error); }
      if (tracing) {
        try {
          const complete = new Promise(resolve => { const listener = (_event, method, params) => { if (method === 'Tracing.tracingComplete') { win.webContents.debugger.removeListener('message', listener); resolve(params); } }; win.webContents.debugger.on('message', listener); });
          await bounded(cdp('Tracing.end'), 3000, 'Trace end timeout');
          const result = await bounded(complete, 10000, 'Trace stream timeout');
          if (!result.stream) throw new Error('No trace stream');
          report.trace = { file: 'walking-trace.json', dataLossOccurred: result.dataLossOccurred === true };
          const fd = fs.openSync(path.join(config.output, report.trace.file), 'w');
          try { while (true) { const chunk = await bounded(cdp('IO.read', { handle: result.stream, size: 1048576 }), 10000, 'Trace read timeout'); fs.writeSync(fd, Buffer.from(chunk.data, chunk.base64Encoded ? 'base64' : 'utf8')); if (chunk.eof) break; } }
          finally { fs.closeSync(fd); await cdp('IO.close', { handle: result.stream }); }
          report.trace.sha256 = hash(fs.readFileSync(path.join(config.output, report.trace.file)));
        } catch (error) { report.traceFailure = String(error); }
      }
    }
    try {
      const initial = JSON.parse(fs.readFileSync(path.join(config.output, 'source-manifest.json'), 'utf8')).files, current = sourceFiles();
      report.changedSourceFiles = [...new Set([...Object.keys(initial), ...Object.keys(current)])].filter(name => initial[name] !== current[name]);
      report.sourceUnchanged = !report.changedSourceFiles.length;
      report.driverUnchanged = hash(fs.readFileSync(__filename)) === config.scriptSha256 && hash(fs.readFileSync(path.join(fixture, 'scripts/baseline.cjs'))) === config.baselineSha256;
    } catch (error) { report.verificationFailure = String(error); }
    report.missingTerminal = report.networkRequests.filter(r => !r.events.some(e => /Network.loading(Finished|Failed)/.test(e.method))).map(r => ({ requestId: r.requestId, url: r.url }));
    report.transportClean = !report.networkFailures.length && !report.httpErrors.length && !report.missingTerminal.length;
    report.profileComplete = report.cases.length === 6 && report.cases.every(r => r.routeValid) && !!report.restore && !report.failure && !report.restoreFailure && !report.exceptions.length && !report.consoleErrors.length;
    report.ok = report.profileComplete && report.transportClean && report.sourceUnchanged && report.driverUnchanged;
    stage('complete'); win?.destroy(); server?.close(); app.exit(report.ok ? 0 : 1);
  }
}
if (process.versions.electron) host().catch(error => { console.error(error); require('electron').app.exit(1); });
else { try { launch(); } catch (error) { console.error(error); process.exitCode = 1; } }
