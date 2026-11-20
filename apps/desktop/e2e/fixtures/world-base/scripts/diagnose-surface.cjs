// Local, frozen-state A/B diagnosis. Does not change the baseline performance path.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const { createStaticServer, cleanEnvironment } = require('./baseline.cjs');
const fixture = path.resolve(__dirname, '..');
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
const diagnosticRegions = [
  { name: 'aerial-three-shoals-v2', minX: .20, maxX: .40, minY: .66, maxY: .94, note: 'Replaces the original .19-.33/.64-.91 ROI, which covered only two shoals. Historical reports remain unchanged.' },
  { name: 'aerial-shoal-1-v2', minX: .24, maxX: .31, minY: .68, maxY: .77 },
  { name: 'aerial-shoal-2-v2', minX: .23, maxX: .31, minY: .79, maxY: .89 },
  { name: 'aerial-shoal-3-v2', minX: .32, maxX: .40, minY: .83, maxY: .94 },
  { name: 'station-distant-hill', minX: .55, maxX: .68, minY: .27, maxY: .39, note: 'Wide hill context rectangle includes some blossom, sky, wires and roof edge; not a terrain segmentation mask.' },
  { name: 'station-distant-hill-core', minX: .57, maxX: .65, minY: .355, maxY: .385, note: 'Visually checked hillside patch excluding shop/roof, with crossing wires retained.' },
];

function launch() {
  const args = Object.fromEntries(process.argv.slice(2).map(arg => {
    const split = arg.indexOf('=');
    if (!arg.startsWith('--')) throw new Error(`Expected --option, got ${arg}`);
    return split < 0 ? [arg.slice(2), true] : [arg.slice(2, split), arg.slice(split + 1)];
  }));
  if (args.help) {
    console.log('node scripts/diagnose-surface.cjs --electron=<existing executable> --output=<new directory> [--fixture=<isolated scene root>] [--time=14] [--timeout-ms=180000]');
    return;
  }
  for (const key of Object.keys(args)) if (!['electron', 'output', 'fixture', 'time', 'timeout-ms'].includes(key)) throw new Error(`Unknown --${key}`);
  if (typeof args.electron !== 'string' || !fs.statSync(args.electron).isFile()) throw new Error('--electron must name an existing executable');
  if (typeof args.output !== 'string') throw new Error('--output must name a new directory');
  const source = args.fixture === undefined ? fixture : path.resolve(args.fixture);
  const config = { fixture: source, output: path.resolve(args.output), time: Number(args.time ?? 14), timeoutMs: Number(args['timeout-ms'] ?? 180000), width: 1440, height: 900, startedAt: new Date().toISOString() };
  if (!Number.isFinite(config.time) || config.time < 0 || !Number.isFinite(config.timeoutMs) || config.timeoutMs < 1000) throw new Error('Invalid time or timeout');
  if (fs.existsSync(config.output)) throw new Error('Output already exists; preserve previous evidence');
  fs.mkdirSync(config.output, { recursive: true });
  config.runtime = fs.mkdtempSync(path.join(config.output, 'runtime-'));
  const files = {};
  const hash = file => { files[path.relative(source, file).replace(/\\/g, '/')] = sha256(fs.readFileSync(file)); };
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file); else if (/\.(?:js|mjs|html|css|json)$/.test(entry.name)) hash(file);
    }
  };
  hash(path.join(source, 'index.html'));
  for (const directory of ['src', 'upstream']) walk(path.join(source, directory));
  const manifest = { head: cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, windowsHide: true, encoding: 'utf8' }).trim(), capturedAt: config.startedAt, scope: 'Scene index.html and src/upstream HTML/JS/CSS/JSON, including upstream/petalwake/vendor; excludes external binary assets.', files };
  fs.writeFileSync(path.join(config.output, 'source-manifest.json'), JSON.stringify(manifest, null, 2));
  config.sourceManifest = { file: 'source-manifest.json', sha256: sha256(JSON.stringify(manifest, null, 2)), head: manifest.head };
  config.driverSha256 = sha256(fs.readFileSync(__filename));
  const configFile = path.join(config.runtime, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  fs.writeFileSync(path.join(config.output, 'run-config.json'), JSON.stringify(config, null, 2));
  const log = fs.openSync(path.join(config.output, 'electron.log'), 'w');
  const child = cp.spawn(path.resolve(args.electron), [__filename, configFile], { cwd: fixture, windowsHide: true, env: cleanEnvironment(config.runtime), stdio: ['ignore', log, log] });
  fs.closeSync(log);
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('spawn', () => {
    fs.writeFileSync(path.join(config.output, 'process.json'), JSON.stringify({ pid: child.pid }, null, 2));
    console.log(`Surface diagnosis PID ${child.pid}; output ${config.output}`);
  });
  child.on('exit', code => { console.log(`Electron exited ${code}`); process.exitCode = code ?? 1; });
}

// Gate every page RAF before application scripts register their loops. Native
// callbacks already scheduled are retained for restoration, not executed frozen.
function installGate() {
  const nativeRequest = window.requestAnimationFrame.bind(window);
  const nativeCancel = window.cancelAnimationFrame.bind(window);
  const pending = new Map();
  let sequence = 0;
  const gate = window.__surfaceGate = { frozen: false };
  function schedule(id, item) {
    item.nativeId = nativeRequest(now => {
      if (gate.frozen) { item.nativeId = null; return; }
      pending.delete(id);
      item.callback(now);
    });
  }
  window.requestAnimationFrame = callback => {
    const id = ++sequence, item = { callback, nativeId: null };
    pending.set(id, item);
    if (!gate.frozen) schedule(id, item);
    return id;
  };
  window.cancelAnimationFrame = id => {
    const item = pending.get(id);
    if (item?.nativeId != null) nativeCancel(item.nativeId);
    pending.delete(id);
  };
  gate.freeze = () => {
    gate.frozen = true;
    for (const item of pending.values()) {
      if (item.nativeId != null) nativeCancel(item.nativeId);
      item.nativeId = null;
    }
  };
  gate.resume = () => { gate.frozen = false; for (const [id, item] of pending) schedule(id, item); };
}

function prepareFrozen(time) {
  const wb = window.worldBase, pipeline = wb.look.pipeline;
  window.__surfaceGate.freeze();
  const saved = { view: wb.currentView, time: wb.island.U.uTime.value, hidden: document.body.classList.contains('hide-ui'), terrainUniform: wb.island.terrain.material.uniforms.uWorldToon, bloom: pipeline.params.bloom, blur: pipeline.params.blur, rays: pipeline.params.rays, transition: wb.island.transition.visible };
  const terrain = wb.island.terrain.material.uniforms;
  const terrainMaterial = wb.island.terrain.material, waterMaterial = wb.island.water.material;
  const shaders = { terrain: terrainMaterial.fragmentShader, water: waterMaterial.fragmentShader };
  const scales = { 'water-scatter-off': 'uWBShallowScatter', 'water-caustic-off': 'uWBCaustic', 'water-spec-off': 'uWBSpecular', 'water-foam-off': 'uWBFoam' };
  let injected = false;
  let diagnosticWater, diagnosticTerrain;
  if (!saved.terrainUniform || !wb.island.town.material.uniforms.uWorldToon) throw new Error('Missing island toon uniforms');
  document.body.classList.add('hide-ui');
  pipeline.params.blur = 0;
  pipeline.params.rays = 0;
  const uniformValues = uniforms => Object.fromEntries(Object.entries(uniforms).filter(([, u]) => !u.value?.isTexture).map(([name, u]) => [name, u.value?.toArray ? u.value.toArray() : typeof u.value === 'number' || typeof u.value === 'boolean' || u.value == null ? u.value : String(u.value)]));
  const state = window.__surfaceDiagnosis = {
    inject() {
      if (injected) throw new Error('Diagnostic shaders are already injected');
      function replaceOnce(source, needle, replacement) {
        if (source.split(needle).length !== 2) throw new Error(`Diagnostic shader needle must occur exactly once: ${needle}`);
        return source.replace(needle, replacement);
      }
      for (const name of Object.values(scales)) {
        if (name in waterMaterial.uniforms) throw new Error(`Diagnostic uniform already exists: ${name}`);
      }
      if ('uWBSwardBoost' in terrain) throw new Error('Diagnostic sward uniform already exists');
      let water = shaders.water;
      water = replaceOnce(water, 'void main()', 'uniform float uWBShallowScatter, uWBCaustic, uWBSpecular, uWBFoam;\nvoid main()');
      water = replaceOnce(water, 'vec3 shallow = vec3(0.030, 0.420, 0.380);', 'vec3 shallow = vec3(0.030, 0.420, 0.380);\n  if (uWBShallowScatter != 1.0) shallow *= uWBShallowScatter;');
      water = replaceOnce(water, 'float pathLen = depth *', 'if (uWBCaustic != 1.0) caust *= uWBCaustic;\n  float pathLen = depth *');
      water = replaceOnce(water, 'vec3 col = mix(body, refl, F) + spec;', 'if (uWBSpecular != 1.0) spec *= uWBSpecular;\n  vec3 col = mix(body, refl, F) + spec;');
      water = replaceOnce(water, 'col = mix(col, foamCol, foam);', 'if (uWBFoam != 1.0) foam *= uWBFoam;\n  col = mix(col, foamCol, foam);');
      let ground = replaceOnce(shaders.terrain, 'void main()', 'uniform float uWBSwardBoost;\nvoid main()');
      const sward = 'vec3 swardFar = tint * 1.22 + vec3(0.010, 0.026, 0.0);';
      ground = replaceOnce(ground, sward, sward + '\n  if (uWBSwardBoost < 0.5) swardFar = tint;');
      for (const name of Object.values(scales)) waterMaterial.uniforms[name] = { value: 1 };
      terrain.uWBSwardBoost = { value: 1 };
      diagnosticWater = water;
      diagnosticTerrain = ground;
      // Merely adding an inactive GLSL branch can alter compiler arithmetic.
      // Keep original shader bytes/programs for A/default=1. Activate a
      // diagnostic program only for its corresponding B, never another view.
      injected = true;
      return { waterUniforms: Object.values(scales), terrainUniform: 'uWBSwardBoost', defaultValue: 1, changes: 'Preparation registers controls but retains byte-identical original shaders at default 1. Only a water or sward B activates its diagnostic shader; A2 restores the original shader. Shallow scales only the shallow coefficient; sward changes its initial tint boost and preserves later mottling. GPU numerical differences within the active B shader remain part of its measured pixel difference.' };
    },
    uninject() {
      if (!injected) return;
      state.restoreVariant();
      waterMaterial.fragmentShader = shaders.water; terrainMaterial.fragmentShader = shaders.terrain;
      for (const name of Object.values(scales)) delete waterMaterial.uniforms[name];
      delete terrain.uWBSwardBoost;
      waterMaterial.needsUpdate = true; terrainMaterial.needsUpdate = true;
      injected = false;
    },
    select(view) {
      wb.setView(view);
      // One deterministic zero-delta update selects terrain/vegetation LOD and
      // positions time-driven objects. No update is called between A/B captures.
      wb.station.update(0, time, wb.walker.worldPosition);
      wb.island.update(0, time);
      wb.island.U.uTime.value = time;
    },
    // Pipeline has no accumulated time; dt only controls motion-blur shutter.
    // Reset its previous-view history before every actual render, including A2.
    render() {
      pipeline.hasPrev = false;
      wb.renderer.info.reset();
      wb.look.render(wb.scene, 0);
      // Read the freshly drawn default framebuffer in this same JS task,
      // before preserveDrawingBuffer=false permits browser clearing. This
      // avoids treating a stale compositor screenshot as a repeated baseline.
      return {
        png: wb.renderer.domElement.toDataURL('image/png'), render: { ...wb.renderer.info.render },
        resources: {
          programs: wb.renderer.info.programs.length, memory: { ...wb.renderer.info.memory },
          shadows: { autoUpdate: wb.renderer.shadowMap.autoUpdate, needsUpdate: wb.renderer.shadowMap.needsUpdate },
          groundBlend: (wb.station.groundBlend?.meshes || []).map(mesh => ({ name: mesh.name, materialVersion: mesh.material.version, uniformsNeedUpdate: mesh.material.uniformsNeedUpdate, indexVersion: mesh.geometry.index.version, positionVersion: mesh.geometry.attributes.position.version, worldMatrix: mesh.matrixWorld.toArray(), modelViewMatrix: mesh.modelViewMatrix.toArray() })),
        },
      };
    },
    change(kind) {
      if (kind === 'terrain-toon-off') terrain.uWorldToon = { value: 0 };
      else if (kind === 'bloom-off') pipeline.params.bloom = 0;
      else if (kind === 'transition-hidden') wb.island.transition.visible = false;
      else if (kind === 'sward-tint') { terrain.uWBSwardBoost.value = 0; terrainMaterial.fragmentShader = diagnosticTerrain; terrainMaterial.needsUpdate = true; }
      else if (scales[kind]) { waterMaterial.uniforms[scales[kind]].value = 0; waterMaterial.fragmentShader = diagnosticWater; waterMaterial.needsUpdate = true; }
      else throw new Error(`Unknown intervention ${kind}`);
    },
    restoreVariant() {
      terrain.uWorldToon = saved.terrainUniform; pipeline.params.bloom = saved.bloom; wb.island.transition.visible = saved.transition;
      if (injected) { terrain.uWBSwardBoost.value = 1; for (const name of Object.values(scales)) waterMaterial.uniforms[name].value = 1; }
      if (waterMaterial.fragmentShader !== shaders.water) { waterMaterial.fragmentShader = shaders.water; waterMaterial.needsUpdate = true; }
      if (terrainMaterial.fragmentShader !== shaders.terrain) { terrainMaterial.fragmentShader = shaders.terrain; terrainMaterial.needsUpdate = true; }
    },
    shaderState() { return { terrainOriginal: terrainMaterial.fragmentShader === shaders.terrain, waterOriginal: waterMaterial.fragmentShader === shaders.water }; },
    snapshot() {
      const camera = wb.camera;
      return { view: wb.currentView, camera: { position: camera.position.toArray(), quaternion: camera.quaternion.toArray(), projection: camera.projectionMatrix.toArray(), near: camera.near, far: camera.far, fov: camera.fov, zoom: camera.zoom }, time: wb.island.U.uTime.value, rafFrozen: window.__surfaceGate.frozen, walkerEnabled: wb.walker.enabled, pipeline: { ...pipeline.params }, finalUniforms: uniformValues(pipeline.finalMat.uniforms), diagnosticUniforms: injected ? { uWBSwardBoost: terrain.uWBSwardBoost.value, ...Object.fromEntries(Object.values(scales).map(name => [name, waterMaterial.uniforms[name].value])) } : null, terrainToon: terrain.uWorldToon.value, townToon: wb.island.town.material.uniforms.uWorldToon.value, terrainSharesTown: terrain.uWorldToon === wb.island.town.material.uniforms.uWorldToon, transitionVisible: wb.island.transition.visible, errors: [...wb.errors] };
    },
    restore() {
      state.restoreVariant();
      state.uninject();
      pipeline.params.blur = saved.blur; pipeline.params.rays = saved.rays; wb.setView(saved.view); wb.island.U.uTime.value = saved.time; document.body.classList.toggle('hide-ui', saved.hidden); window.__surfaceGate.resume();
    },
  };
  return state.snapshot();
}

// Electron nativeImage.toBitmap on this Windows harness is BGRA. Statistics
// use uncompressed screen pixels, never JPEG differences or image hashes.
function pixelStats(image, reference) {
  const { width, height } = image.getSize(), bytes = image.toBitmap();
  if (reference && (reference.getSize().width !== width || reference.getSize().height !== height)) throw new Error('A/B dimensions differ');
  const prior = reference?.toBitmap();
  const regions = [{ name: 'full', x: 0, y: 0, w: width, h: height }];
  for (const { name, minX, maxX, minY, maxY, note } of diagnosticRegions) regions.push({ name, ...(note ? { note } : {}), normalized: { minX, maxX, minY, maxY }, x: Math.floor(minX * width), y: Math.floor(minY * height), w: Math.ceil(maxX * width) - Math.floor(minX * width), h: Math.ceil(maxY * height) - Math.floor(minY * height) });
  for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) regions.push({ name: `grid-${row}-${col}`, x: Math.floor(col * width / 3), y: Math.floor(row * height / 3), w: Math.floor((col + 1) * width / 3) - Math.floor(col * width / 3), h: Math.floor((row + 1) * height / 3) - Math.floor(row * height / 3) });
  return regions.map(region => {
    let luma = 0, bright = 0, dark = 0, absolute = 0, maximum = 0, changed = 0;
    const rgb = [0, 0, 0], rgbAbsolute = [0, 0, 0];
    const histogram = new Uint32Array(256);
    for (let y = region.y; y < region.y + region.h; y++) for (let x = region.x; x < region.x + region.w; x++) {
      const i = (y * width + x) * 4;
      for (let channel = 0; channel < 3; channel++) rgb[channel] += bytes[i + 2 - channel];
      const value = .2126 * bytes[i + 2] + .7152 * bytes[i + 1] + .0722 * bytes[i];
      luma += value; histogram[Math.round(value)]++; bright += value >= 240; dark += value <= 8;
      if (prior) {
        const differences = [0, 1, 2].map(channel => Math.abs(bytes[i + channel] - prior[i + channel]));
        const peak = Math.max(...differences);
        for (let channel = 0; channel < 3; channel++) rgbAbsolute[channel] += differences[2 - channel];
        absolute += differences.reduce((a, b) => a + b, 0); maximum = Math.max(maximum, peak); changed += peak > 0;
      }
    }
    const pixels = region.w * region.h;
    let total = 0, p95 = 0;
    for (; p95 < 255; p95++) { total += histogram[p95]; if (total >= pixels * .95) break; }
    return { ...region, pixels, meanRGB: rgb.map(value => value / pixels), meanLuma: luma / pixels, p95Luma: p95, brightFraction: bright / pixels, darkFraction: dark / pixels, ...(prior ? { meanAbsoluteDifferenceRGB: rgbAbsolute.map(value => value / pixels), meanAbsoluteRgbDifference: absolute / (pixels * 3), maxChannelDifference: maximum, changedPixels: changed, changedFraction: changed / pixels } : {}) };
  });
}

async function host() {
  const { app, BrowserWindow, nativeImage } = require('electron');
  const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  app.setPath('userData', path.join(config.runtime, 'user-data'));
  app.commandLine.appendSwitch('force-device-scale-factor', '1');
  const report = { config, ok: false, cases: [], exceptions: [], networkFailures: [], method: 'One scene load; pause all page RAF after ready. Per preset update station/island once with dt=0 and fixed U.uTime, then render identical frozen state for baseline/intervention/restored. No performance claim. Restored PNG pixels must exactly match baseline; hashes are provenance only. Brightness is display-encoded luma, not physical luminance. Port visibility toggle is diagnostic, not a proposed fix.' };
  const write = () => fs.writeFileSync(path.join(config.output, 'surface-report.json'), JSON.stringify(report, null, 2));
  const stage = name => { report.stage = name; write(); console.log(name); };
  const timeout = setTimeout(() => { report.failure = `Timeout at ${report.stage}`; write(); app.exit(1); }, config.timeoutMs);
  let win, server;
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  stage('bootstrap');
  try {
    await app.whenReady();
    stage('app-ready');
    server = createStaticServer(config.fixture);
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    win = new BrowserWindow({ width: config.width, height: config.height, useContentSize: true, show: true, autoHideMenuBar: true, title: 'World surface diagnosis', webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false } });
    await win.loadURL('about:blank');
    win.webContents.debugger.attach('1.3');
    const cdp = (method, params) => win.webContents.debugger.sendCommand(method, params);
    const evaluate = code => win.webContents.executeJavaScript(code, true);
    const requests = new Map();
    win.webContents.debugger.on('message', (_event, method, params) => {
      if (method === 'Network.requestWillBeSent') requests.set(params.requestId, params.request.url);
      if (method === 'Runtime.exceptionThrown') report.exceptions.push(params.exceptionDetails);
      if (method === 'Network.loadingFailed') report.networkFailures.push({ url: requests.get(params.requestId), ...params });
      if (method === 'Network.responseReceived' && params.response.status >= 400) report.networkFailures.push({ url: params.response.url, status: params.response.status });
    });
    await cdp('Page.enable'); await cdp('Runtime.enable'); await cdp('Network.enable');
    await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `(${installGate.toString()})()` });
    stage('loading-scene');
    await win.loadURL(`http://127.0.0.1:${server.address().port}/`);
    while (!await evaluate('window.worldBase?.ready === true')) await pause(100);
    await pause(1000);
    report.initial = await evaluate(`(${prepareFrozen.toString()})(${config.time})`);
    const capture = async (name, reference) => {
      const rendered = await evaluate('window.__surfaceDiagnosis.render()');
      if (!rendered.png.startsWith('data:image/png;base64,') || rendered.render.calls <= 0) throw new Error('No fresh rendered PNG');
      const buffer = Buffer.from(rendered.png.slice('data:image/png;base64,'.length), 'base64'), image = nativeImage.createFromBuffer(buffer);
      if (image.isEmpty()) throw new Error(`Empty image ${name}`);
      fs.writeFileSync(path.join(config.output, `${name}.png`), buffer);
      fs.writeFileSync(path.join(config.output, `${name}.jpg`), image.toJPEG(90));
      return { image, data: { png: `${name}.png`, jpeg: `${name}.jpg`, readback: 'renderer canvas immediately after fresh look.render; no compositor cache', render: rendered.render, resources: rendered.resources, shaderState: await evaluate('window.__surfaceDiagnosis.shaderState()'), size: image.getSize(), state: await evaluate('window.__surfaceDiagnosis.snapshot()'), regions: pixelStats(image, reference) } };
    };
    const views = ['station-street', 'island-aerial', 'station-port'];
    report.injection = { views: [], method: 'Same camera and frozen object state. Exactly three predetermined original-shader renders A0/A1/A2 are recorded, with no retry or best-frame selection; A1/A2 must match exactly. A2 is then compared to diagnostic preparation. Default=1 retains original shader bytes; no station/island update between these captures. Active variants compile their target shader only, restored A uses original shader.' };
    for (const view of views) {
      await evaluate(`window.__surfaceDiagnosis.select(${JSON.stringify(view)})`);
      const a0 = await capture(`${view}-warmup-A0`);
      const a1 = await capture(`${view}-warmup-A1`, a0.image);
      const original = await capture(`${view}-before-injection`, a1.image);
      report.injection.configuration = await evaluate('window.__surfaceDiagnosis.inject()');
      const identity = await capture(`${view}-after-injection`, original.image);
      const warmupStable = original.data.regions[0].changedPixels === 0;
      report.injection.views.push({ view, warmup: { a0: a0.data, a1: a1.data, a2File: original.data.png, stable: warmupStable }, before: original.data, after: identity.data, pixelsIdentical: identity.data.regions[0].changedPixels === 0 });
      await evaluate('window.__surfaceDiagnosis.uninject()');
      write();
    }
    report.injection.identity = report.injection.views.every(view => view.warmup.stable && view.pixelsIdentical);
    report.strictStaticIsolation = report.injection.identity;
    write();
    if (!report.injection.identity) throw new Error('Diagnostic preparation changed baseline pixels; do not interpret subsequent A/B as isolated');
    await evaluate('window.__surfaceDiagnosis.inject()');
    for (const [view, intervention] of [['station-street', 'terrain-toon-off'], ['station-street', 'sward-tint'], ['island-aerial', 'bloom-off'], ['island-aerial', 'water-scatter-off'], ['island-aerial', 'water-caustic-off'], ['island-aerial', 'water-spec-off'], ['island-aerial', 'water-foam-off'], ['station-port', 'transition-hidden']]) {
      stage(view);
      await evaluate(`window.__surfaceDiagnosis.select(${JSON.stringify(view)})`);
      const prefix = `${view}-${intervention}`;
      const baseline = await capture(`${prefix}-baseline`);
      let variant;
      try {
        await evaluate(`window.__surfaceDiagnosis.change(${JSON.stringify(intervention)})`);
        variant = await capture(`${prefix}-variant`, baseline.image);
      } finally { await evaluate('window.__surfaceDiagnosis.restoreVariant()'); }
      const restored = await capture(`${prefix}-restored`, baseline.image);
      const a = baseline.data.state, b = variant.data.state;
      const normalized = JSON.parse(JSON.stringify(b));
      if (intervention === 'terrain-toon-off') { normalized.terrainToon = a.terrainToon; normalized.terrainSharesTown = a.terrainSharesTown; }
      if (intervention === 'bloom-off') { normalized.pipeline.bloom = a.pipeline.bloom; normalized.finalUniforms.uBloom = a.finalUniforms.uBloom; }
      if (intervention === 'transition-hidden') normalized.transitionVisible = a.transitionVisible;
      const diagnosticName = { 'sward-tint': 'uWBSwardBoost', 'water-scatter-off': 'uWBShallowScatter', 'water-caustic-off': 'uWBCaustic', 'water-spec-off': 'uWBSpecular', 'water-foam-off': 'uWBFoam' }[intervention];
      if (diagnosticName) normalized.diagnosticUniforms[diagnosticName] = a.diagnosticUniforms[diagnosticName];
      const controlledState = JSON.stringify(normalized) === JSON.stringify(a);
      const restoredState = JSON.stringify(restored.data.state) === JSON.stringify(a);
      const expectedShader = { terrainOriginal: intervention !== 'sward-tint', waterOriginal: !intervention.startsWith('water-') };
      const controlledShader = Object.values(baseline.data.shaderState).every(Boolean) && Object.values(restored.data.shaderState).every(Boolean) && JSON.stringify(variant.data.shaderState) === JSON.stringify(expectedShader);
      const staticIsolation = restored.data.regions[0].changedPixels === 0;
      report.cases.push({ view, intervention, controlledState, controlledShader, restoredState, staticIsolation, baseline: baseline.data, variant: variant.data, restored: restored.data });
      write();
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(config.output, 'source-manifest.json'), 'utf8'));
    report.strictStaticIsolation = report.injection.identity && report.cases.every(item => item.staticIsolation);
    report.changedSourceFiles = Object.entries(manifest.files).filter(([name, hash]) => sha256(fs.readFileSync(path.join(config.fixture, name))) !== hash).map(([name]) => name);
    report.sourceUnchanged = report.changedSourceFiles.length === 0;
    report.renderOk = report.sourceUnchanged && report.cases.every(item => item.controlledState && item.controlledShader && item.restoredState && item.staticIsolation && item.baseline.state.errors.length === 0 && item.variant.state.errors.length === 0 && item.baseline.regions[0].darkFraction < .99) && report.exceptions.length === 0;
    report.transportClean = report.networkFailures.length === 0;
    report.ok = report.renderOk && report.transportClean;
    stage('complete');
  } catch (error) { report.failure = error.stack || String(error); write(); console.error(error); }
  finally {
    if (win && !win.isDestroyed()) {
      try { await win.webContents.executeJavaScript('window.__surfaceDiagnosis?.restore()'); } catch (error) { report.restoreFailure = String(error); report.ok = false; }
      win.destroy();
    }
    server?.close(); clearTimeout(timeout); write(); app.exit(report.ok ? 0 : 1);
  }
}

module.exports = { pixelStats, diagnosticRegions, installGate };
// Electron's default-app loader does not assign this CJS file to require.main.
// Compare its explicit entry path while keeping nativeImage-only imports inert.
const directEntry = require.main === module || (process.versions.electron && process.argv[1] && path.resolve(process.argv[1]) === __filename);
if (directEntry) {
  if (process.versions.electron) host().catch(error => { console.error(error); require('electron').app.exit(1); });
  else { try { launch(); } catch (error) { console.error(error); process.exitCode = 1; } }
}
