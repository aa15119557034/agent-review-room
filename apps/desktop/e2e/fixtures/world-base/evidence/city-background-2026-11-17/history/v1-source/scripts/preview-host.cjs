const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { createStaticServer } = require('./baseline.cjs');
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
fs.mkdirSync(path.join(config.runtime, 'user-data'), { recursive: true });
app.setPath('userData', path.join(config.runtime, 'user-data'));
app.commandLine.appendSwitch('force-device-scale-factor', '1');
const report = { config, ok: false, renderOk: false, console: [], exceptions: [], networkFailures: [], captures: [], captureDetails: [], views: [], stageHistory: [],
  networkEvidence: { scope: 'Same-requestId CDP lifecycle for menhir.glb and boulders.glb; main-document clock anchors. All failures remain in networkFailures.',
    documentAnchors: [], requests: [], clockNote: 'CDP timestamps are monotonic seconds. Document-relative milliseconds = (document.wallTime + event.timestamp - document.timestamp) * 1000 - performance.timeOrigin. stage is the host stage when the event was received, not proof of its emission time.' } };
const writeReport = () => fs.writeFileSync(path.join(config.output, 'render-report.json'), JSON.stringify(report, null, 2));
const stage = name => { report.stage = name; report.stageAt = new Date().toISOString(); report.stageHistory.push({ stage: name, wallTime: Date.parse(report.stageAt) / 1000 }); writeReport(); console.log(`[${report.stageAt}] ${name}`); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let server, win;
stage('bootstrap');
// This covers app readiness and debugger setup too, not only page loading.
const deadline = setTimeout(() => { report.failure = { kind: 'timeout', stage: report.stage, timeoutMs: config.timeoutMs }; writeReport(); console.error(`Timeout at ${report.stage}`); app.exit(1); }, config.timeoutMs);

// Installed before page scripts using CDP. Measures all WebGL submissions across
// shadow, reflection and postprocessing passes, rather than only the last pass.
function instrumentPage() {
  const state = window.__worldCapture = { firstWebGLDrawMs: null, sceneReadyMs: null, firstReadyFrameMs: null, frames: [], collecting: false, draws: 0, triangles: 0 };
  state.selectView = async name => {
    const scene = window.worldBase;
    if (!scene) throw new Error('Camera presets require window.worldBase');
    if (scene.setView) { await scene.setView(name); return; }
    const view = scene.views.find(view => view.name === name);
    if (!view) throw new Error(`Unknown camera view: ${name}`);
    scene.camera.position.fromArray(view.position);
    scene.camera.zoom = view.zoom ?? 1;
    scene.camera.updateProjectionMatrix();
    if (scene.controls) { scene.controls.target.fromArray(view.target); scene.controls.update(); }
    else scene.camera.lookAt(...view.target);
  };
  const primitiveTriangles = (gl, mode, count) => mode === gl.TRIANGLES ? count / 3 : mode === gl.TRIANGLE_STRIP || mode === gl.TRIANGLE_FAN ? Math.max(0, count - 2) : 0;
  function instrument(prototype, name, countIndex, instanceIndex) {
    const original = prototype?.[name];
    if (!original) return;
    prototype[name] = function (...args) {
      const result = original.apply(this, args);
      state.firstWebGLDrawMs ??= performance.now();
      state.draws++;
      state.triangles += primitiveTriangles(this, args[0], args[countIndex]) * (instanceIndex === undefined ? 1 : args[instanceIndex]);
      return result;
    };
  }
  for (const type of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
    instrument(type?.prototype, 'drawArrays', 2);
    instrument(type?.prototype, 'drawElements', 1);
    instrument(type?.prototype, 'drawArraysInstanced', 2, 3);
    instrument(type?.prototype, 'drawElementsInstanced', 1, 4);
  }
  // Both pinned projects use WebGL2; unsupported extension-only draw paths are
  // not represented as measured calls and are explicitly identified in report.
  let previous, previousReady = false;
  function frame(now) {
    const ready = window.worldBase?.ready === true || window.PW?.ready === true || (window.__ctx && document.body?.classList.contains('loaded')) || window.__ready === true;
    if (ready) state.sceneReadyMs ??= performance.now();
    if (ready && previousReady && state.draws > 0) state.firstReadyFrameMs ??= performance.now();
    if (state.collecting && previous !== undefined) state.frames.push({ ms: now - previous, calls: state.draws, triangles: state.triangles });
    previous = now;
    previousReady = ready;
    state.draws = 0; state.triangles = 0;
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

function snapshot() {
  const f = window.worldBase || window.PW || window.__ctx;
  const renderer = f?.renderer;
  if (!renderer) throw new Error('Scene has no exposed renderer');
  const gl = renderer.getContext(), extension = gl.getExtension('WEBGL_debug_renderer_info');
  let wetProgram = null;
  if (f.station?.wetRoad) {
    const material = f.station.wetRoad.material;
    let renderMeshReferences = 0;
    f.station.root.traverse(mesh => { if (mesh.isMesh && (Array.isArray(mesh.material) ? mesh.material.includes(material) : mesh.material === material)) renderMeshReferences++; });
    const program = renderer.properties.get(material).currentProgram?.program;
    wetProgram = { renderMeshReferences, compiled: Boolean(program), enabled: f.station.wetRoad.enabled };
    if (program) for (const name of ['uWetEnabled', 'uWetBounds', 'uWetWorldToLocal']) {
      const location = gl.getUniformLocation(program, name);
      const value = location ? gl.getUniform(program, location) : null;
      wetProgram[name] = ArrayBuffer.isView(value) ? Array.from(value) : value;
    }
  }
  return {
    ready: window.__worldCapture.sceneReadyMs !== null,
    errors: f.errors || window.__errors || [],
    revision: f.revision || window.THREE?.REVISION || null,
    camera: { position: f.camera?.position.toArray(), currentView: f.currentView || null, mode: f.cameraMode || null },
    stages: f.stages || [],
    dimensions: { viewport: [innerWidth, innerHeight], canvas: [renderer.domElement.width, renderer.domElement.height], pixelRatio: renderer.getPixelRatio() },
    renderer: { version: gl.getParameter(gl.VERSION), shadingLanguage: gl.getParameter(gl.SHADING_LANGUAGE_VERSION), vendor: extension ? gl.getParameter(extension.UNMASKED_VENDOR_WEBGL) : null, gpu: extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : null, contextLost: gl.isContextLost(), info: { render: { ...renderer.info.render }, memory: { ...renderer.info.memory }, programs: renderer.info.programs?.length } },
    originalStats: window.PW?.stats || window.__stats || window.worldBase?.frameStats || null,
    loadedProps: window.worldBase?.island?.props?.counts || window.PW?.props?.counts || null,
    quality: window.PW ? { autoScaleEnabled: window.PW.auto.on, pipelineScale: window.PW.pipeline.scale } : window.__ctx?.quality || null,
    timing: { timeOriginMs: performance.timeOrigin, performanceNowMs: performance.now(), firstWebGLDrawMs: window.__worldCapture.firstWebGLDrawMs, sceneReadyMs: window.__worldCapture.sceneReadyMs, firstReadyFrameMs: window.__worldCapture.firstReadyFrameMs, navigation: performance.getEntriesByType('navigation')[0]?.toJSON() },
    views: window.worldBase?.views?.map(v => typeof v === 'string' ? v : v.name) || [],
    streetscape: f.station?.streetscape ? {
      addedColliders: f.station.streetscape.addedColliders,
      instances: f.station.streetscape.instances.map(item => ({ id: item.id, kind: item.kind,
        lot: item.lot, lotPosition: item.lotPosition, size: item.size,
        footprint: Object.fromEntries(Object.entries(item.footprint).filter(([key]) => key !== 'collider')) })),
    } : null,
    wetRoad: f.station?.wetRoad?.stats || null,
    wetProgram,
    skyline: f.skyline ? { ...f.skyline.stats, placements: f.skyline.placements,
      approaches: f.skyline.approaches, vegetationClear: f.skyline.vegetationClear } : null,
    city: f.city ? { ...f.city.stats, placements: f.city.placements, vegetationClear: f.city.vegetationClear } : null,
  };
}

function summarizeFrames(frames) {
  if (!frames.length || !frames.some(frame => frame.calls > 0)) throw new Error('No rendered frames during the measurement interval');
  const sorted = frames.map(frame => frame.ms).sort((a, b) => a - b);
  const sampleMs = frames.reduce((sum, frame) => sum + frame.ms, 0);
  const summarize = key => ({ mean: frames.reduce((sum, frame) => sum + frame[key], 0) / frames.length, min: Math.min(...frames.map(frame => frame[key])), max: Math.max(...frames.map(frame => frame[key])) });
  return { method: 'RAF intervals with WebGL2 submission counters across all passes; instrumentation overhead included', unsupportedDrawPaths: ['ANGLE_instanced_arrays', 'WEBGL_multi_draw'], frameCount: frames.length, sampleMs, fps: 1000 * frames.length / sampleMs, p95FrameMs: sorted[Math.floor(sorted.length * .95)], drawCalls: summarize('calls'), triangles: summarize('triangles'), framesWithoutDraws: frames.filter(frame => frame.calls === 0).length };
}

function pixelSummary(image) {
  const { width, height } = image.getSize(), bytes = image.toBitmap();
  let total = 0, nonBlack = 0, samples = 0;
  // Inspect the central scene, excluding the outer UI strips. This is a blank
  // frame smoke check, not a claim about aesthetic or semantic image quality.
  for (let y = Math.floor(height * .15); y < height * .85; y += 4) {
    for (let x = Math.floor(width * .15); x < width * .85; x += 4) {
      const offset = (y * width + x) * 4;
      const brightness = (bytes[offset] + bytes[offset + 1] + bytes[offset + 2]) / 3;
      total += brightness; nonBlack += Number(brightness > 8); samples++;
    }
  }
  const meanRgb = total / samples, nonBlackFraction = nonBlack / samples;
  return { width, height, samples, meanRgb, nonBlackFraction, notBlack: meanRgb > 2 && nonBlackFraction > .05 };
}

function pixelDifference(left, right) {
  const a = left.toBitmap(), b = right.toBitmap();
  if (a.length !== b.length) throw new Error('Comparison screenshots changed dimensions');
  let delta = 0, samples = 0;
  for (let index = 0; index < a.length; index += 16) {
    for (let channel = 0; channel < 3; channel++) { delta += Math.abs(a[index + channel] - b[index + channel]); samples++; }
  }
  return { meanAbsoluteRgbDifference: delta / samples, isolatedFromAnimation: false };
}

function lookState() {
  const scene = window.worldBase, pipeline = scene.look.pipeline;
  return { toon: pipeline.finalMat.uniforms.uToon.value, blur: pipeline.params.blur, rays: pipeline.params.rays, toonCheckbox: document.querySelector('#toon').checked, effectsCheckbox: document.querySelector('#effects').checked, currentView: scene.currentView };
}

async function captureFixtureVideo(win, config) {
  const evaluate = code => win.webContents.executeJavaScript(code, true);
  const cdp = (method, params) => win.webContents.debugger.sendCommand(method, params);
  const viewNames = await evaluate('window.worldBase?.views.map(view => view.name) || []');
  const savedUi = await evaluate('document.body.classList.contains("hide-ui")');
  const framesDirectory = path.join(config.output, 'video-frames');
  fs.mkdirSync(framesDirectory, { recursive: true });
  const frames = [], views = [];
  let frameError, firstResolve, firstReject, firstTimer;
  const firstFrame = new Promise((resolve, reject) => { firstResolve = resolve; firstReject = reject; });
  const onMessage = (_event, method, params) => {
    if (method !== 'Page.screencastFrame') return;
    try {
      const timestamp = params.metadata.timestamp;
      if (!Number.isFinite(timestamp)) throw new Error('Screencast frame lacks a source timestamp');
      if (frames.length && timestamp <= frames.at(-1).timestamp) throw new Error('Screencast timestamps are not strictly increasing');
      const file = 'video-frames/frame-' + String(frames.length + 1).padStart(6, '0') + '.jpg';
      const bytes = Buffer.from(params.data, 'base64');
      if (!frames.length) {
        const size = require('electron').nativeImage.createFromBuffer(bytes).getSize();
        if (size.width !== config.width || size.height !== config.height) throw new Error('Screencast dimensions differ from the requested viewport');
      }
      fs.writeFileSync(path.join(config.output, file), bytes);
      frames.push({ file, timestamp, bytes: bytes.length });
      if (frames.length === 1) { clearTimeout(firstTimer); firstResolve(); }
    } catch (error) { frameError = error; firstReject(error); }
    cdp('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(error => { frameError = error; });
  };
  let recording = false;
  try {
    for (const name of viewNames) { await evaluate('window.__worldCapture.selectView(' + JSON.stringify(name) + ')'); await pause(350); }
    if (viewNames.length) await evaluate('window.__worldCapture.selectView(' + JSON.stringify(viewNames[0]) + ')');
    await evaluate('document.body.classList.add("hide-ui")');
    await pause(1000);
    win.webContents.debugger.on('message', onMessage);
    firstTimer = setTimeout(() => firstReject(Error('No fixture screencast frame arrived')), 15000);
    await cdp('Page.startScreencast', { format: 'jpeg', quality: 90, maxWidth: config.width, maxHeight: config.height, everyNthFrame: 2 });
    recording = true;
    await firstFrame;
    if (!viewNames.length) await pause(config.videoMs);
    for (const [index, name] of viewNames.entries()) {
      let timestamp = frames[0].timestamp;
      if (index > 0) {
        timestamp = await evaluate('(async () => { await window.__worldCapture.selectView(' + JSON.stringify(name) + '); return (performance.timeOrigin + performance.now()) / 1000; })()');
      }
      views.push({ name, startMs: (timestamp - frames[0].timestamp) * 1000 });
      await pause(config.videoMs / viewNames.length);
      if (frameError) throw frameError;
    }
    await cdp('Page.stopScreencast'); recording = false;
  } finally {
    clearTimeout(firstTimer);
    if (recording) await cdp('Page.stopScreencast');
    win.webContents.debugger.removeListener('message', onMessage);
    await evaluate('document.body.classList.toggle("hide-ui", ' + savedUi + ')');
  }
  if (frameError) throw frameError;
  if (frames.length < 2) throw new Error('Too few fixture frames to encode');
  const firstTimestamp = frames[0].timestamp;
  for (const frame of frames) frame.timeMs = (frame.timestamp - firstTimestamp) * 1000;
  const source = { method: 'CDP Page.screencastFrame timestamps, fixture WebContents only. No desktop capture or invented frames.', width: config.width, height: config.height, views, frames };
  fs.writeFileSync(path.join(config.output, 'video-source-timeline.json'), JSON.stringify(source, null, 2));
  const concat = ['ffconcat version 1.0'];
  for (const [index, frame] of frames.entries()) {
    concat.push('file ' + frame.file, 'option framerate 1000');
    if (index + 1 < frames.length) concat.push('duration ' + (frames[index + 1].timestamp - frame.timestamp).toFixed(9));
  }
  fs.writeFileSync(path.join(config.output, 'video.ffconcat'), concat.join('\n') + '\n');
  const execFile = require('node:util').promisify(require('node:child_process').execFile);
  const version = await execFile(config.ffmpeg, ['-version'], { windowsHide: true });
  const args = ['-hide_banner', '-loglevel', 'warning', '-nostats', '-n', '-f', 'concat', '-safe', '0', '-i', 'video.ffconcat',
    '-an', '-c:v', 'libvpx', '-deadline', 'good', '-cpu-used', '4', '-b:v', '5M', '-pix_fmt', 'yuv420p',
    '-fps_mode', 'vfr', '-enc_time_base', '1:1000', 'world.webm'];
  try {
    const encoded = await execFile(config.ffmpeg, args, { cwd: config.output, windowsHide: true, timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
    fs.writeFileSync(path.join(config.output, 'ffmpeg.log'), encoded.stdout + encoded.stderr);
  } catch (error) {
    fs.writeFileSync(path.join(config.output, 'ffmpeg.log'), String(error.stdout || '') + String(error.stderr || ''));
    throw error;
  }
  return { mime: 'video/webm;codecs=vp8', bytes: fs.statSync(path.join(config.output, 'world.webm')).size, file: 'world.webm',
    durationRequestedMs: config.videoMs, durationActualMs: frames.at(-1).timeMs, views, frameCount: frames.length,
    captureMethod: 'Fixture-only CDP JPEG screencast; original timestamps -> ffconcat with per-file framerate=1000 -> FFmpeg libvpx VFR. No frame duplication or speedup.',
    recordingOverhead: 'Screencast JPEG capture and subsequent CPU encoding occur outside the existing scene FPS measurements.',
    sourceFramesFile: 'video-source-timeline.json', ffmpeg: { executable: config.ffmpeg, version: version.stdout.split(/\r?\n/)[0], args } };
}

app.whenReady().then(async () => {
  stage('app-ready');
  server = createStaticServer(config.fixture);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  stage('server-listening');
  const route = config.scene === 'combined' ? '/' : `/original/${config.scene}/`;
  const url = `http://127.0.0.1:${server.address().port}${route}${config.query ? '?' + config.query : ''}`;
  report.url = url;
  stage('creating-window');
  win = new BrowserWindow({ width: config.width, height: config.height, useContentSize: true, show: true, autoHideMenuBar: true, title: `World · ${config.scene}`, backgroundColor: '#222222', webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } });
  stage('window-created');
  if (config.proxy) { stage('configuring-proxy'); await win.webContents.session.setProxy({ proxyRules: config.proxy, proxyBypassRules: '<local>;127.0.0.1;localhost' }); }
  win.webContents.on('console-message', (event, ...legacy) => {
    const [level, message, line, sourceId] = legacy;
    const item = event.message !== undefined ? { level: event.level, message: event.message, line: event.lineNumber, source: event.sourceId } : { level, message, line, source: sourceId };
    report.console.push(item);
    if (item.level === 'error' || item.level === 3) console.error(item.message);
  });
  win.webContents.on('render-process-gone', (_event, details) => { report.failure = { kind: 'render-process-gone', ...details }; writeReport(); app.exit(1); });
  // A newly created Electron window has no initialized page runtime yet.
  // Runtime.enable can wait indefinitely if navigation itself waits for it.
  // The measured navigation follows this blank bootstrap and has its own clock.
  stage('initializing-renderer');
  await win.loadURL('about:blank');
  win.webContents.debugger.attach('1.3');
  stage('debugger-attached');
  const requests = new Map();
  const tracedRequests = new Map();
  const lifecycle = new Set(['Network.requestWillBeSent', 'Network.responseReceived', 'Network.loadingFinished', 'Network.loadingFailed']);
  win.webContents.debugger.on('message', (_event, method, params) => {
    const received = { stage: report.stage, receivedWallTime: Date.now() / 1000 };
    if (method === 'Network.requestWillBeSent') {
      requests.set(params.requestId, { url: params.request.url, type: params.type });
      if (params.type === 'Document' && params.request.url === url) {
        report.networkEvidence.documentAnchors.push({ requestId: params.requestId, url: params.request.url, frameId: params.frameId,
          loaderId: params.loaderId, timestamp: params.timestamp, wallTime: params.wallTime, ...received });
      }
      if (/\/(menhir|boulders)\.glb(?:[?#]|$)/.test(params.request.url) && !tracedRequests.has(params.requestId)) {
        const trace = { requestId: params.requestId, url: params.request.url, events: [] };
        tracedRequests.set(params.requestId, trace);
        report.networkEvidence.requests.push(trace);
      }
    }
    // Retain complete params (including initiator, response and terminal byte
    // counts) for these two assets. No event-time file writes or URL joins.
    if (lifecycle.has(method) && tracedRequests.has(params.requestId)) {
      tracedRequests.get(params.requestId).events.push({ method, ...received, ...params });
    }
    if (method === 'Runtime.exceptionThrown') report.exceptions.push(params.exceptionDetails);
    if (method === 'Network.loadingFailed') report.networkFailures.push({ ...requests.get(params.requestId), ...params, ...received });
    if (method === 'Network.responseReceived' && params.response.status >= 400) report.networkFailures.push({ url: params.response.url, status: params.response.status, requestId: params.requestId, timestamp: params.timestamp, ...received });
  });
  const cdp = async (method, params) => { stage(`cdp:${method}`); return win.webContents.debugger.sendCommand(method, params); };
  await cdp('Runtime.enable'); await cdp('Network.enable'); await cdp('Page.enable');
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `(${instrumentPage.toString()})()` });
  const evaluate = code => win.webContents.executeJavaScript(code, true);
  stage('navigating');
  await win.loadURL(url);
  stage('waiting-for-ready-frame');
  while (!await evaluate('window.__worldCapture?.firstReadyFrameMs !== null && window.__worldCapture?.firstReadyFrameMs !== undefined')) await pause(100);
  report.firstReady = await evaluate(`(${snapshot.toString()})()`);
  stage('scene-ready');
  // Exercise the original start controls. This changes UI state, not scene code.
  report.startControl = await evaluate(`(() => { const button = document.getElementById(${JSON.stringify(config.scene === 'petalwake' ? 'start' : 'go')}); if (!button) return null; button.click(); return { id: button.id, disabled: button.disabled }; })()`);
  if (config.preview) { clearTimeout(deadline); report.preview = true; writeReport(); return; }
  if (!config.videoOnly) {
    if (config.scene === 'combined') {
      stage('validating-station');
      report.behaviorValidation = await evaluate(`(async () => { try { return (await import('/src/station-validation.js')).validateStation(window.worldBase); } catch (error) { return { ok: false, error: error.stack || String(error) }; } })()`);
      writeReport();
    }
    await pause(config.warmupMs);
    stage('measuring');
    const measure = async (durationMs, filename) => {
      if (!/^[a-zA-Z0-9_-]+\.json$/.test(filename)) throw new Error('Invalid sample filename');
      await evaluate('window.__worldCapture.frames.length = 0; window.__worldCapture.collecting = true');
      await pause(durationMs + 100);
      while (await evaluate('window.__worldCapture.frames.reduce((sum, frame) => sum + frame.ms, 0)') < durationMs) await pause(100);
      const frames = await evaluate('window.__worldCapture.collecting = false; window.__worldCapture.frames');
      fs.writeFileSync(path.join(config.output, filename), JSON.stringify(frames));
      return { ...summarizeFrames(frames), samplesFile: filename };
    };
    report.performance = await measure(config.sampleMs, 'frame-samples.json');
    report.scene = await evaluate(`(${snapshot.toString()})()`);
    stage('capturing');
    const capture = async name => {
      if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error('Invalid capture name');
      const file = name + '.png', jpeg = name + '.jpg';
      const image = await win.webContents.capturePage();
      fs.writeFileSync(path.join(config.output, file), image.toPNG());
      const preview = image.resize({ width: Math.min(960, image.getSize().width) });
      fs.writeFileSync(path.join(config.output, jpeg), preview.toJPEG(82));
      report.captures.push(file);
      const detail = { file, jpeg, jpegWidth: preview.getSize().width, pixels: pixelSummary(image) };
      report.captureDetails.push(detail);
      return { detail, image };
    };
    await capture('00-default');
    for (const [index, name] of report.scene.views.entries()) {
      stage(`capturing-view:${name}`);
      await evaluate(`window.__worldCapture.selectView(${JSON.stringify(name)})`);
      await pause(1500);
      const performance = await measure(3000, `frame-samples-${name}.json`);
      const shot = await capture(`${String(index + 1).padStart(2, '0')}-${name}`);
      report.views.push({ name, ...performance, capture: shot.detail, scene: await evaluate(`(${snapshot.toString()})()`) });
      writeReport();
    }
    if (config.scene === 'combined') {
      stage('capturing-streetscape');
      report.streetscapeCaptures = [];
      const detailViews = [
        { name: '09-streetscape-planters', position: [-2.2, 1.8, 33.5], target: [-5.6, 0.8, 27.5], wet: true },
        { name: '10-streetscape-sidewall', position: [-3.5, 3.6, 25.8], target: [-9.15, 3.9, 22.365], wet: true },
        { name: '11-streetscape-skyline', position: [1, 19, -72], target: [-28, 5, -104], wet: true },
        { name: '12-street-dry', position: [-1.2, 2.4, 36], target: [0, 2.0, -25], wet: false },
        { name: '13-street-wet', position: [-1.2, 2.4, 36], target: [0, 2.0, -25], wet: true },
        { name: '14-road-wet-detail', position: [2, 1.35, 31], target: [-1.85, 0.65, 28], wet: true },
        { name: '15-road-dry-detail', position: [2, 1.35, 31], target: [-1.85, 0.65, 28], wet: false },
        { name: '16-city-context', position: [100, 66, -70], target: [-15, 40, -185], wet: true },
        { name: '17-city-grounding', position: [-108, 22, -125], target: [-35, 12, -181], wet: true },
      ];
      const savedDetailView = await evaluate('window.worldBase.currentView');
      const savedUi = await evaluate('document.body.classList.contains("hide-ui")');
      try {
        for (const view of detailViews) {
          await evaluate(`(() => { const w=window.worldBase; w.walker.setEnabled(false); w.station.wetRoad.setEnabled(${view.wet}); w.station.toWorld(w.camera.position.fromArray(${JSON.stringify(view.position)}), w.camera.position); const target=w.camera.position.clone().fromArray(${JSON.stringify(view.target)}); w.camera.lookAt(w.station.toWorld(target)); w.camera.updateMatrixWorld(); w.look.pipeline.hasPrev=false; document.body.classList.add('hide-ui'); })()`);
          await pause(750);
          const shot = await capture(view.name);
          report.streetscapeCaptures.push({ ...view, coordinateSpace: 'station local', capture: shot.detail,
            interpretation: 'Qualitative scene capture; animation remains active, not an isolated pixel comparison.' });
        }
      } finally {
        await evaluate(`window.worldBase.station.wetRoad.setEnabled(true); document.body.classList.toggle('hide-ui', ${savedUi}); window.worldBase.setView(${JSON.stringify(savedDetailView)})`);
      }
      writeReport();
      stage('validating-look-controls');
      const saved = await evaluate(`(${lookState.toString()})()`);
      try {
        await evaluate(`window.__worldCapture.selectView('station-street'); window.worldBase.setFlightEffects(false); window.worldBase.setToon(true)`);
        await pause(750);
        const toonOnState = await evaluate(`(${lookState.toString()})()`), toonOn = await capture('05-street-toon-on');
        await evaluate('window.worldBase.setToon(false)');
        await pause(750);
        const toonOffState = await evaluate(`(${lookState.toString()})()`), toonOff = await capture('06-street-toon-off');
        await evaluate('window.worldBase.setToon(true); window.worldBase.setFlightEffects(true)');
        await pause(750);
        const effectsOnState = await evaluate(`(${lookState.toString()})()`), effectsOn = await capture('07-flight-effects-on');
        await evaluate('window.worldBase.setFlightEffects(false)');
        await pause(750);
        const effectsOffState = await evaluate(`(${lookState.toString()})()`), effectsOff = await capture('08-flight-effects-off');
        report.lookValidation = {
          ok: toonOnState.toon === 1 && toonOffState.toon === 0 && toonOnState.toonCheckbox && !toonOffState.toonCheckbox
            && effectsOnState.blur === 1 && effectsOnState.rays === .55 && effectsOnState.effectsCheckbox
            && effectsOffState.blur === 0 && effectsOffState.rays === 0 && !effectsOffState.effectsCheckbox
            && [toonOn, toonOff, effectsOn, effectsOff].every(shot => shot.detail.pixels.notBlack),
          method: 'Actual pipeline uniforms/parameters and UI state; central-pixel nonblack smoke checks. Images retain animation.',
          toon: { on: { state: toonOnState, capture: toonOn.detail }, off: { state: toonOffState, capture: toonOff.detail }, difference: pixelDifference(toonOn.image, toonOff.image) },
          flightEffects: { on: { state: effectsOnState, capture: effectsOn.detail }, off: { state: effectsOffState, capture: effectsOff.detail }, difference: pixelDifference(effectsOn.image, effectsOff.image) },
        };
      } finally {
        await evaluate(`window.worldBase.setToon(${saved.toon === 1}); window.worldBase.setFlightEffects(${saved.blur > 0 || saved.rays > 0}); window.__worldCapture.selectView(${JSON.stringify(saved.currentView)})`);
      }
      writeReport();
    }
    if (config.scene === 'combined') {
      stage('validating-real-walking');
      const savedView = await evaluate('({ name: window.worldBase.currentView, mode: window.worldBase.walker.view })');
      const walking = { ok: false, method: 'Electron sendInputEvent holds W for each measured segment; positions come from the live walker, with no per-frame pose overrides.', segments: [] };
      report.walkingValidation = walking;
      await evaluate(`(() => { const state = window.__worldCapture; state.walkingKeys = []; state.walkingInputAbort = new AbortController(); for (const type of ['keydown', 'keyup']) addEventListener(type, event => state.walkingKeys.push({ type, code: event.code, key: event.key, trusted: event.isTrusted, timeMs: performance.now() }), { signal: state.walkingInputAbort.signal }); window.worldBase.startWalking(); window.worldBase.walker.setView('third'); })()`);
      try {
        win.focus(); win.webContents.focus();
        for (const mode of ['third', 'first']) {
          if (mode === 'first') {
            walking.viewSwitch = await evaluate(`(() => { const w = window.worldBase.walker, before = w.worldPosition.toArray(); w.setView('first'); const after = w.worldPosition.toArray(); return { before, after, distance: Math.hypot(...before.map((value, index) => value - after[index])), mode: w.view }; })()`);
          }
          const before = await evaluate('({ feet: window.worldBase.walker.worldPosition.toArray(), mode: window.worldBase.walker.view, timeMs: performance.now() })');
          win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'W' });
          let performance;
          try { performance = await measure(3000, `frame-samples-walking-${mode}.json`); }
          finally { win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'W' }); }
          const after = await evaluate('({ feet: window.worldBase.walker.worldPosition.toArray(), mode: window.worldBase.walker.view, timeMs: performance.now() })');
          const distance = Math.hypot(...after.feet.map((value, index) => value - before.feet[index]));
          const horizontalDistance = Math.hypot(after.feet[0] - before.feet[0], after.feet[2] - before.feet[2]);
          const shot = await capture(`walking-${mode}`);
          walking.segments.push({ mode, before, after, distance, horizontalDistance, ...performance, capture: shot.detail, ok: before.mode === mode && after.mode === mode && horizontalDistance > 1 && shot.detail.pixels.notBlack });
          await pause(400);
        }
        walking.inputEvents = await evaluate('window.__worldCapture.walkingKeys');
        walking.ok = walking.segments.every(segment => segment.ok) && walking.viewSwitch.mode === 'first' && walking.viewSwitch.distance < 1e-10
          && walking.inputEvents.filter(event => event.type === 'keydown' && event.code === 'KeyW' && event.trusted).length === 2
          && walking.inputEvents.filter(event => event.type === 'keyup' && event.code === 'KeyW' && event.trusted).length === 2;
      } finally {
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'W' });
        await evaluate(`window.__worldCapture.walkingInputAbort.abort(); window.worldBase.walker.setView(${JSON.stringify(savedView.mode)}); window.__worldCapture.selectView(${JSON.stringify(savedView.name)})`);
      }
      writeReport();
    }
  } else {
    report.scene = report.firstReady;
    report.checkedScope = 'Video-only rerun: physical, walking, style and performance checks are not rerun in this report.';
  }
  if (config.videoMs > 0) {
    stage('recording-video');
    win.showInactive();
    report.video = await captureFixtureVideo(win, config);
  }
  report.finalScene = await evaluate(`(${snapshot.toString()})()`);
  report.networkEvidence.pageClock = { timeOriginMs: report.finalScene.timing.timeOriginMs, performanceNowMs: report.finalScene.timing.performanceNowMs };
  for (const trace of report.networkEvidence.requests) {
    const request = trace.events.find(event => event.method === 'Network.requestWillBeSent');
    const anchor = report.networkEvidence.documentAnchors.find(document => document.loaderId === request?.loaderId);
    if (anchor) {
      trace.documentRequestId = anchor.requestId;
      for (const event of trace.events) if (Number.isFinite(event.timestamp)) {
        event.documentRelativeMs = (anchor.wallTime + event.timestamp - anchor.timestamp) * 1000 - report.networkEvidence.pageClock.timeOriginMs;
      }
    }
  }
  report.failedRequestTiming = await evaluate(`performance.getEntriesByType('resource').filter(entry => ${JSON.stringify(report.networkFailures.map(failure => failure.url).filter(Boolean))}.includes(entry.name)).map(entry => entry.toJSON())`);
  report.failedRequestTimingNote = 'Resource Timing entries matched by URL only; they have no CDP requestId and do not establish response/completion of the failed request. Use networkEvidence for same-ID lifecycle evidence.';
  report.gpu = { features: app.getGPUFeatureStatus(), info: await app.getGPUInfo('complete') };
  report.versions = process.versions;
  report.completedAt = new Date().toISOString();
  report.transportClean = report.networkFailures.length === 0;
  report.renderOk = report.exceptions.length === 0 && report.finalScene.errors.length === 0 && !report.finalScene.renderer.contextLost
    && !report.console.some(item => item.level === 'error' || item.level === 3)
    && report.captureDetails.every(capture => capture.pixels.notBlack)
    && (config.videoOnly
      ? report.video.frameCount > 0 && report.video.views.length === 4
      : config.scene !== 'combined' || (report.behaviorValidation.ok === true && report.lookValidation.ok === true && report.walkingValidation.ok === true && report.views.length === 4));
  report.ok = report.renderOk && report.transportClean;
  stage('complete');
  console.log(JSON.stringify({ ok: report.ok, performance: report.performance, output: config.output }));
  clearTimeout(deadline);
  server.close(); win.destroy(); app.exit(report.ok ? 0 : 1);
}).catch(error => {
  report.failure = { kind: 'exception', message: error.message, stack: error.stack };
  writeReport(); console.error(error); server?.close(); app.exit(1);
});
app.on('window-all-closed', () => { server?.close(); app.quit(); });
