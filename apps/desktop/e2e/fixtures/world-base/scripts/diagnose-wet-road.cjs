// Fixed-sequence wet-road diagnosis, separate from performance baselines.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const { createStaticServer, cleanEnvironment } = require('./baseline.cjs');
const { installGate } = require('./diagnose-surface.cjs');
const fixture = path.resolve(__dirname, '..');
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
const legacyRegions = [
  ['road-lower', 0, .5, 1, 1],
  ['road-left', 0, .55, .5, 1],
  ['road-middle', .3, .55, .7, .9],
  ['road-right', .5, .55, 1, 1],
];

function sceneFiles() {
  const files = {};
  const hash = file => { files[path.relative(fixture, file).replace(/\\/g, '/')] = sha256(fs.readFileSync(file)); };
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (/\.(js|mjs|html|css|json)$/.test(entry.name)) hash(file);
    }
  };
  hash(path.join(fixture, 'index.html'));
  for (const name of ['city-assets.json', 'prop-assets.json', 'apartment-assets.json', 'scripts/prepare-props.cjs',
    'scripts/prepare-apartments.cjs', 'scripts/baseline.cjs', 'scripts/diagnose-wet-road.cjs']) hash(path.join(fixture, name));
  const props = require('./prepare-props.cjs').verifyPreparedAssets(fixture);
  for (const file of props.files) files[file.path] = file.sha256;
  const surfaces = require('./prepare-apartments.cjs').verifyPreparedAssets(fixture);
  for (const file of surfaces.files) files[file.path] = file.sha256;
  for (const directory of ['street-env', 'street-env-evening']) {
    for (const face of ['px', 'nx', 'py', 'ny', 'pz', 'nz']) hash(path.join(fixture, 'src', directory, face + '.png'));
  }
  for (const name of ['src', 'upstream', 'vendor']) if (fs.existsSync(path.join(fixture, name))) walk(path.join(fixture, name));
  return files;
}

function launch() {
  const args = {};
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i], split = arg.indexOf('=');
    if (!arg.startsWith('--')) throw new Error('Expected --option: ' + arg);
    const key = arg.slice(2, split < 0 ? undefined : split);
    args[key] = split < 0 ? (key === 'help' ? true : process.argv[++i]) : arg.slice(split + 1);
  }
  if (args.help) {
    console.log('node scripts/diagnose-wet-road.cjs --electron=<existing executable> --output=<new directory> [--timeout-ms=180000]');
    return;
  }
  for (const key of Object.keys(args)) if (!['electron', 'output', 'timeout-ms'].includes(key)) throw new Error('Unknown --' + key);
  if (typeof args.electron !== 'string' || !fs.statSync(args.electron).isFile()) throw new Error('--electron must name an existing executable');
  if (typeof args.output !== 'string') throw new Error('--output must name a new directory');
  const config = { output: path.resolve(args.output), fixture, width: 1440, height: 900, time: 14,
    timeoutMs: Number(args['timeout-ms'] ?? 180000), startedAt: new Date().toISOString() };
  if (!Number.isFinite(config.timeoutMs) || config.timeoutMs < 1000) throw new Error('Invalid timeout');
  if (fs.existsSync(config.output)) throw new Error('Output exists; previous evidence must remain intact');
  fs.mkdirSync(config.output, { recursive: true });
  config.runtime = fs.mkdtempSync(path.join(config.output, 'runtime-'));
  const files = sceneFiles();
  const head = cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fixture, windowsHide: true, encoding: 'utf8' }).trim();
  const manifest = { head, capturedAt: config.startedAt, count: Object.keys(files).length,
    scope: 'index.html and src/upstream/vendor JS/MJS/HTML/CSS/JSON. Excludes external binary assets and capture scripts.', files };
  const text = JSON.stringify(manifest, null, 2);
  fs.writeFileSync(path.join(config.output, 'source-manifest.json'), text);
  config.sourceManifest = { file: 'source-manifest.json', sha256: sha256(text), head, count: manifest.count };
  config.scripts = Object.fromEntries(['diagnose-wet-road.cjs', 'diagnose-surface.cjs', 'baseline.cjs'].map(name => [name, sha256(fs.readFileSync(path.join(__dirname, name)))]));
  const configFile = path.join(config.runtime, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  fs.writeFileSync(path.join(config.output, 'run-config.json'), JSON.stringify(config, null, 2));
  const log = fs.openSync(path.join(config.output, 'electron.log'), 'w');
  const child = cp.spawn(path.resolve(args.electron), [__filename, configFile], {
    cwd: fixture, windowsHide: true, env: cleanEnvironment(config.runtime), stdio: ['ignore', log, log],
  });
  fs.closeSync(log);
  child.on('spawn', () => {
    fs.writeFileSync(path.join(config.output, 'process.json'), JSON.stringify({ pid: child.pid }));
    console.log('Wet-road diagnosis PID ' + child.pid + '; output ' + config.output);
  });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => { console.log('Electron exited ' + code); process.exitCode = code === 0 ? 0 : 1; });
}

// Runs in the page. No shader edits, material replacement or wet-strength changes.
function prepare() {
  const wb = window.worldBase, gate = window.__surfaceGate, pipeline = wb.look.pipeline;
  gate.freeze();
  const wet = wb.station.wetRoad, camera = wb.camera;
  const saved = {
    view: wb.currentView, camera: camera.clone(), wet: wet.enabled, walker: wb.walker.enabled,
    time: wb.island.U.uTime.value, stationTime: wb.station.ctx.time,
    blur: pipeline.params.blur, rays: pipeline.params.rays, hidden: document.body.classList.contains('hide-ui'),
  };
  wb.walker.setEnabled(false);
  pipeline.params.blur = 0; pipeline.params.rays = 0;
  document.body.classList.add('hide-ui');
  function value(v) {
    if (v?.isTexture) return { texture: v.uuid, version: v.version };
    if (v?.toArray) return v.toArray();
    if (v == null || typeof v !== 'object') return v;
    return String(v);
  }
  const uniforms = u => Object.fromEntries(Object.entries(u).map(([k, v]) => [k, value(v.value)]));
  function snapshot(properties) {
    const wetUniforms = Object.fromEntries(Object.entries(properties.uniforms).filter(([name]) => name.startsWith('uWet') && name !== 'uWetEnabled').map(([name, u]) => [name, value(u.value)]));
    return { view: wb.currentView, camera: { position: camera.position.toArray(), quaternion: camera.quaternion.toArray(),
      projection: camera.projectionMatrix.toArray(), fov: camera.fov, aspect: camera.aspect, near: camera.near, far: camera.far },
      time: wb.island.U.uTime.value, stationTime: wb.station.ctx.time, rafFrozen: gate.frozen, walkerEnabled: wb.walker.enabled,
      viewport: { width: wb.renderer.domElement.width, height: wb.renderer.domElement.height, ratio: wb.renderer.getPixelRatio(), devicePixelRatio },
      pipeline: { ...pipeline.params }, finalUniforms: uniforms(pipeline.finalMat.uniforms),
      islandUniforms: uniforms(wb.island.U), stationUniforms: uniforms(wb.station.ctx.shared),
      wet: { enabled: wet.enabled, material: wet.material.uuid, version: wet.material.version, uniforms: wetUniforms } };
  }
  const diagnostic = window.__wetDiagnosis = {
    select(view) {
      wb.setView('station-street');
      if (view === 'detail') {
        camera.position.copy(wb.station.toWorld(camera.position.clone().fromArray([2, 1.35, 31])));
        camera.lookAt(wb.station.toWorld(camera.position.clone().fromArray([-1.85, .65, 28])));
        camera.updateMatrixWorld();
        wb.currentView = 'wet-road-detail';
      }
      wb.station.update(0, 14, wb.walker.worldPosition);
      wb.island.update(0, 14);
      wb.island.U.uTime.value = 14;
    },
    capture(enabled) {
      wet.setEnabled(enabled);
      pipeline.hasPrev = false;
      wb.renderer.info.reset();
      wb.look.render(wb.scene, 0);
      // Same task readback, before the default framebuffer can be discarded.
      const png = wb.renderer.domElement.toDataURL('image/png');
      const properties = wb.renderer.properties.get(wet.material);
      const program = properties.currentProgram, gl = wb.renderer.getContext();
      if (!program?.program || !properties.uniforms?.uWetEnabled) throw new Error('Wet road has no compiled program/uniform');
      const location = gl.getUniformLocation(program.program, 'uWetEnabled');
      if (location === null) throw new Error('Wet GPU switch was optimized out or not compiled');
      return { png, state: snapshot(properties),
        switchEvidence: { api: wet.enabled, cpuUniform: properties.uniforms.uWetEnabled.value,
          gpuUniform: gl.getUniform(program.program, location), programId: program.id, requested: enabled },
        render: { ...wb.renderer.info.render }, programs: wb.renderer.info.programs.length,
        memory: { ...wb.renderer.info.memory }, errors: [...wb.errors],
        clock: { timeOrigin: performance.timeOrigin, now: performance.now() }, props: wb.island.props.counts };
    },
    restore() {
      wet.setEnabled(saved.wet);
      pipeline.params.blur = saved.blur; pipeline.params.rays = saved.rays;
      wb.setView(saved.view);
      camera.copy(saved.camera); camera.updateMatrixWorld();
      wb.station.update(0, saved.stationTime, wb.walker.worldPosition);
      wb.island.update(0, saved.time);
      wb.island.U.uTime.value = saved.time;
      wb.walker.setEnabled(saved.walker);
      document.body.classList.toggle('hide-ui', saved.hidden);
      pipeline.hasPrev = false;
      gate.resume();
      return { wet: wet.enabled, view: wb.currentView, rafFrozen: gate.frozen, walkerEnabled: wb.walker.enabled };
    },
  };
  return { clock: { timeOrigin: performance.timeOrigin, now: performance.now() }, props: wb.island.props.counts,
    saved: { view: saved.view, wet: saved.wet, time: saved.time, stationTime: saved.stationTime },
    method: 'Freeze all page RAF; stop walker; time 14; disable temporal blur/rays consistently, preserve bloom. One dt=0 station/island update per camera; no updates between captures.' };
}

// Windows nativeImage bitmap is BGRA. All comparisons use original PNG pixels.
function pixels(image, prior) {
  const { width, height } = image.getSize(), a = image.toBitmap(), b = prior?.toBitmap();
  if (prior && (prior.getSize().width !== width || prior.getSize().height !== height)) throw new Error('Image size mismatch');
  const regions = [['full', 0, 0, 1, 1], ...legacyRegions];
  return regions.map(([name, x0, y0, x1, y1]) => {
    const bounds = { minX: Math.floor(x0 * width), minY: Math.floor(y0 * height), maxX: Math.floor(x1 * width), maxY: Math.floor(y1 * height) };
    let count = 0, changed = 0, max = 0, sum = 0, luma = 0, dark = 0;
    const rgb = [0, 0, 0], boxes = [1, 4].map(threshold => ({ threshold, changedPixels: 0, minX: width, minY: height, maxX: -1, maxY: -1 }));
    for (let y = bounds.minY; y < bounds.maxY; y++) for (let x = bounds.minX; x < bounds.maxX; x++) {
      const i = (y * width + x) * 4;
      const lum = .2126 * a[i + 2] + .7152 * a[i + 1] + .0722 * a[i];
      count++; luma += lum; dark += lum <= 8;
      for (let c = 0; c < 3; c++) rgb[c] += a[i + 2 - c];
      if (!b) continue;
      let peak = 0;
      for (let c = 0; c < 3; c++) { const d = Math.abs(a[i + c] - b[i + c]); sum += d; peak = Math.max(peak, d); }
      changed += peak > 0; max = Math.max(max, peak);
      for (const box of boxes) if (peak > box.threshold) {
        box.changedPixels++; box.minX = Math.min(box.minX, x); box.minY = Math.min(box.minY, y);
        box.maxX = Math.max(box.maxX, x); box.maxY = Math.max(box.maxY, y);
      }
    }
    return { name, normalized: { x0, y0, x1, y1 }, bounds, pixels: count, meanRGB: rgb.map(v => v / count), meanLuma: luma / count, darkFraction: dark / count,
      ...(b ? { changedPixels: changed, meanChannelDifference: sum / (count * 3), maxChannelDifference: max,
        thresholdBounds: boxes.map(box => ({ threshold: box.threshold, changedPixels: box.changedPixels,
          bounds: box.changedPixels ? { minX: box.minX, minY: box.minY, maxX: box.maxX, maxY: box.maxY,
            width: box.maxX - box.minX + 1, height: box.maxY - box.minY + 1 } : null })) } : {}) };
  });
}

async function host() {
  const { app, BrowserWindow, nativeImage } = require('electron');
  const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  app.setPath('userData', path.join(config.runtime, 'user-data'));
  app.commandLine.appendSwitch('force-device-scale-factor', '1');
  const report = { config, ok: false, visualStrict: false, transportClean: false, cases: [],
    exceptions: [], consoleErrors: [], networkRequests: [], networkFailures: [], httpErrors: [], serverRequests: [],
    method: 'Per camera exactly two recorded warmups, then wet on A1 / off B / on A2. Full-frame RGB A1/A2 equality is strict (zero tolerance). No retries, frame selection, shader edits or strength tuning. ROI metrics are supplementary and not a complete effect mask. No performance claim.' };
  const write = () => fs.writeFileSync(path.join(config.output, 'wet-road-report.json'), JSON.stringify(report, null, 2));
  const stage = name => { report.stage = name; write(); console.log(name); };
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  let win, server, timedOut = false, timeout;
  const deadline = new Promise((_, reject) => { timeout = setTimeout(() => { timedOut = true; reject(new Error('Timeout at ' + report.stage)); }, config.timeoutMs); });
  const requests = new Map();
  let evaluate;
  stage('bootstrap');
  async function run() {
    await app.whenReady();
    if (timedOut) return;
    stage('app-ready');
    server = createStaticServer(fixture);
    server.on('request', (req, res) => {
      const row = { url: req.url, method: req.method, stage: report.stage, wallTime: Date.now() / 1000 };
      report.serverRequests.push(row);
      res.on('finish', () => Object.assign(row, { status: res.statusCode, contentLength: res.getHeader('content-length'), finished: true, finishedWallTime: Date.now() / 1000 }));
      res.on('close', () => Object.assign(row, { closedWallTime: Date.now() / 1000, responseComplete: res.writableFinished }));
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    win = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, show: true, autoHideMenuBar: true,
      title: 'Frozen wet-road diagnosis', webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false } });
    await win.loadURL('about:blank');
    win.webContents.debugger.attach('1.3');
    const cdp = (method, params) => win.webContents.debugger.sendCommand(method, params);
    evaluate = code => { if (timedOut) throw new Error('Deadline elapsed'); return win.webContents.executeJavaScript(code, true); };
    win.webContents.debugger.on('message', (_event, method, params) => {
      const event = { stage: report.stage, receivedWallTime: Date.now() / 1000, ...params };
      if (method === 'Runtime.exceptionThrown') report.exceptions.push(event);
      if (method === 'Runtime.consoleAPICalled' && params.type === 'error') report.consoleErrors.push(event);
      if (!method.startsWith('Network.') || !params.requestId) return;
      let row = requests.get(params.requestId);
      if (!row) { row = { requestId: params.requestId, events: [] }; requests.set(params.requestId, row); report.networkRequests.push(row); }
      if (['Network.requestWillBeSent', 'Network.responseReceived', 'Network.loadingFinished', 'Network.loadingFailed'].includes(method)) row.events.push({ method, ...event });
      if (method === 'Network.requestWillBeSent' && params.type === 'Document') {
        report.documentAnchors ??= [];
        report.documentAnchors.push({ requestId: params.requestId, url: params.request.url, timestamp: params.timestamp, wallTime: params.wallTime, loaderId: params.loaderId, stage: report.stage });
      }
      if (method === 'Network.loadingFailed') report.networkFailures.push({ requestId: params.requestId, ...event });
      if (method === 'Network.responseReceived' && params.response.status >= 400) report.httpErrors.push({ requestId: params.requestId, ...event });
    });
    win.webContents.on('render-process-gone', (_event, details) => report.exceptions.push({ stage: report.stage, processGone: details }));
    await cdp('Page.enable'); await cdp('Runtime.enable'); await cdp('Network.enable');
    await cdp('Page.addScriptToEvaluateOnNewDocument', { source: '(' + installGate.toString() + ')()' });
    stage('loading-scene');
    await win.loadURL('http://127.0.0.1:' + server.address().port + '/');
    while (!await evaluate('window.worldBase?.ready === true')) {
      const errors = await evaluate('window.worldBase?.errors || []');
      if (errors.length) throw new Error('Scene initialization failed: ' + JSON.stringify(errors));
      await pause(100);
    }
    stage('freezing');
    report.initial = await evaluate('(' + prepare.toString() + ')()');
    async function capture(name, enabled, prior) {
      stage(name);
      const result = await evaluate('window.__wetDiagnosis.capture(' + enabled + ')');
      if (!result.png.startsWith('data:image/png;base64,') || result.render.calls <= 0) throw new Error('No fresh rendered PNG');
      const buffer = Buffer.from(result.png.slice('data:image/png;base64,'.length), 'base64'), image = nativeImage.createFromBuffer(buffer);
      if (image.isEmpty() || image.getSize().width !== 1440 || image.getSize().height !== 900 || result.state.viewport.ratio !== 1 || result.state.viewport.devicePixelRatio !== 1) throw new Error('Unexpected capture dimensions or pixel ratio');
      fs.writeFileSync(path.join(config.output, name + '.png'), buffer);
      fs.writeFileSync(path.join(config.output, name + '.jpg'), image.toJPEG(90));
      delete result.png;
      return { image, data: { ...result, png: name + '.png', jpeg: name + '.jpg', pngSha256: sha256(buffer), regions: pixels(image, prior) } };
    }
    for (const view of ['detail', 'station-street']) {
      stage('select-' + view);
      await evaluate('window.__wetDiagnosis.select(' + JSON.stringify(view) + ')');
      const row = { view, warmups: [] }; report.cases.push(row);
      const warm1 = await capture(view + '-warmup-1', true); row.warmups.push(warm1.data); write();
      const warm2 = await capture(view + '-warmup-2', true, warm1.image); row.warmups.push(warm2.data); write();
      const a1 = await capture(view + '-on-A1', true, warm2.image); row.a1 = a1.data; write();
      const b = await capture(view + '-off-B', false, a1.image); row.b = b.data; write();
      const a2 = await capture(view + '-on-A2', true, a1.image); row.a2 = a2.data;
      const normalized = JSON.parse(JSON.stringify(b.data.state));
      normalized.wet.enabled = a1.data.state.wet.enabled;
      row.controlledState = JSON.stringify(normalized) === JSON.stringify(a1.data.state);
      row.restoredState = JSON.stringify(a2.data.state) === JSON.stringify(a1.data.state);
      row.pixelIdentity = a2.data.regions[0].changedPixels === 0;
      row.effectDetected = b.data.regions[0].changedPixels > 0;
      row.switchVerified = [a1.data, b.data, a2.data].every((capture, i) => {
        const expected = i !== 1, u = capture.switchEvidence;
        return u.api === expected && u.cpuUniform === Number(expected) && u.gpuUniform === Number(expected);
      });
      row.visualStrict = row.controlledState && row.restoredState && row.pixelIdentity && row.effectDetected && row.switchVerified &&
        [a1.data, b.data, a2.data].every(c => !c.errors.length && c.regions[0].darkFraction < .99);
      write();
    }
    report.finalClock = await evaluate('({timeOrigin:performance.timeOrigin,now:performance.now(),props:window.worldBase.island.props.counts})');
    // Let queued CDP network events arrive; this never renders or selects frames.
    await pause(100);
    report.visualStrict = report.cases.length === 2 && report.cases.every(row => row.visualStrict);
    stage('captured');
  }
  try { await Promise.race([run(), deadline]); }
  catch (error) { report.failure = error.stack || String(error); write(); console.error(error); }
  finally {
    clearTimeout(timeout);
    report.stage = 'restoring';
    if (win && !win.isDestroyed()) {
      try {
        report.restore = await Promise.race([win.webContents.executeJavaScript('window.__wetDiagnosis?.restore()'),
          pause(3000).then(() => { throw new Error('Restore timed out'); })]);
      } catch (error) { report.restoreFailure = String(error); }
      win.destroy();
    }
    server?.close();
    try {
      const original = JSON.parse(fs.readFileSync(path.join(config.output, 'source-manifest.json'), 'utf8'));
      const current = sceneFiles(), names = new Set([...Object.keys(original.files), ...Object.keys(current)]);
      report.changedSourceFiles = [...names].filter(name => original.files[name] !== current[name]);
      report.sourceUnchanged = report.changedSourceFiles.length === 0;
      report.headAfter = cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fixture, windowsHide: true, encoding: 'utf8' }).trim();
      report.headUnchanged = report.headAfter === original.head;
      report.scriptsUnchanged = Object.entries(config.scripts).every(([name, hash]) => sha256(fs.readFileSync(path.join(__dirname, name))) === hash);
    } catch (error) { report.sourceVerificationFailure = String(error); report.sourceUnchanged = false; }
    report.transportClean = report.networkFailures.length === 0 && report.httpErrors.length === 0;
    report.renderOk = report.visualStrict && report.exceptions.length === 0 && report.consoleErrors.length === 0 && !report.failure && !report.restoreFailure;
    report.ok = report.renderOk && report.transportClean && report.sourceUnchanged && report.headUnchanged && report.scriptsUnchanged;
    report.stage = 'complete'; write(); app.exit(report.ok ? 0 : 1);
  }
}

module.exports = { pixels, legacyRegions, sceneFiles };
const directEntry = require.main === module || (process.versions.electron && process.argv[1] && path.resolve(process.argv[1]) === __filename);
if (directEntry) {
  if (process.versions.electron) host().catch(error => { console.error(error); require('electron').app.exit(1); });
  else { try { launch(); } catch (error) { console.error(error); process.exitCode = 1; } }
}
