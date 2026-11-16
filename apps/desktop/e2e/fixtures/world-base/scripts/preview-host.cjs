const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { createStaticServer } = require('./baseline.cjs');
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
fs.mkdirSync(path.join(config.runtime, 'user-data'), { recursive: true });
app.setPath('userData', path.join(config.runtime, 'user-data'));
app.commandLine.appendSwitch('force-device-scale-factor', '1');
const report = { config, console: [], exceptions: [], networkFailures: [], captures: [] };
const writeReport = () => fs.writeFileSync(path.join(config.output, 'render-report.json'), JSON.stringify(report, null, 2));
const stage = name => { report.stage = name; report.stageAt = new Date().toISOString(); writeReport(); console.log(`[${report.stageAt}] ${name}`); };
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
  return {
    ready: window.__worldCapture.sceneReadyMs !== null,
    errors: f.errors || window.__errors || [],
    revision: f.revision || window.THREE?.REVISION || null,
    camera: { position: f.camera?.position.toArray(), currentView: f.currentView || null, mode: f.cameraMode || null },
    stages: f.stages || [],
    dimensions: { viewport: [innerWidth, innerHeight], canvas: [renderer.domElement.width, renderer.domElement.height], pixelRatio: renderer.getPixelRatio() },
    renderer: { version: gl.getParameter(gl.VERSION), shadingLanguage: gl.getParameter(gl.SHADING_LANGUAGE_VERSION), vendor: extension ? gl.getParameter(extension.UNMASKED_VENDOR_WEBGL) : null, gpu: extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : null, contextLost: gl.isContextLost(), info: { render: { ...renderer.info.render }, memory: { ...renderer.info.memory }, programs: renderer.info.programs?.length } },
    originalStats: window.PW?.stats || window.__stats || window.worldBase?.frameStats || null,
    loadedProps: window.PW?.props?.counts || null,
    quality: window.PW ? { autoScaleEnabled: window.PW.auto.on, pipelineScale: window.PW.pipeline.scale } : window.__ctx?.quality || null,
    timing: { firstWebGLDrawMs: window.__worldCapture.firstWebGLDrawMs, sceneReadyMs: window.__worldCapture.sceneReadyMs, firstReadyFrameMs: window.__worldCapture.firstReadyFrameMs, navigation: performance.getEntriesByType('navigation')[0]?.toJSON() },
    views: window.worldBase?.views?.map(v => typeof v === 'string' ? v : v.name) || [],
  };
}

async function recordVideo(durationMs, viewNames) {
  const state = window.__worldCapture;
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  // Settle the first preset before recording. Subsequent cuts remain in the
  // clip and the report records their actual time, including async setView work.
  if (viewNames.length) { await state.selectView(viewNames[0]); await wait(1000); }
  const canvas = (window.worldBase || window.PW || window.__ctx).renderer.domElement;
  const stream = canvas.captureStream(30);
  const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8'].find(type => MediaRecorder.isTypeSupported(type));
  if (!mime) { stream.getTracks().forEach(track => track.stop()); throw new Error('WebM recorder unavailable'); }
  return new Promise((resolve, reject) => {
    const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 5000000 });
    const chunks = [], views = [], start = performance.now();
    let failure;
    recorder.ondataavailable = event => chunks.push(event.data);
    recorder.onerror = event => { failure = Error(event.error?.message || 'Recording failed'); stream.getTracks().forEach(track => track.stop()); reject(failure); };
    recorder.onstop = async () => {
      stream.getTracks().forEach(track => track.stop());
      if (failure) { reject(failure); return; }
      try {
        const durationActualMs = performance.now() - start;
        const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
        let binary = '';
        for (let index = 0; index < bytes.length; index += 16384) binary += String.fromCharCode(...bytes.subarray(index, index + 16384));
        resolve({ mime, bytes: bytes.length, data: btoa(binary), durationActualMs, views });
      } catch (error) { reject(error); }
    };
    recorder.start();
    (async () => {
      if (viewNames.length) {
        for (const [index, name] of viewNames.entries()) {
          if (index > 0) await state.selectView(name);
          views.push({ name, startMs: performance.now() - start });
          await wait(durationMs / viewNames.length);
        }
      } else await wait(durationMs);
    })().catch(error => { failure = error; }).finally(() => { if (recorder.state !== 'inactive') recorder.stop(); });
  });
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
  win.webContents.debugger.on('message', (_event, method, params) => {
    if (method === 'Network.requestWillBeSent') requests.set(params.requestId, { url: params.request.url, type: params.type });
    if (method === 'Runtime.exceptionThrown') report.exceptions.push(params.exceptionDetails);
    if (method === 'Network.loadingFailed') report.networkFailures.push({ ...requests.get(params.requestId), ...params });
    if (method === 'Network.responseReceived' && params.response.status >= 400) report.networkFailures.push({ url: params.response.url, status: params.response.status });
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
  await pause(config.warmupMs);
  stage('measuring');
  await evaluate('window.__worldCapture.frames.length = 0; window.__worldCapture.collecting = true');
  await pause(config.sampleMs);
  const frames = await evaluate('window.__worldCapture.collecting = false; window.__worldCapture.frames');
  if (!frames.length || !frames.some(frame => frame.calls > 0)) throw new Error('No rendered frames during the measurement interval');
  const sorted = frames.map(f => f.ms).sort((a, b) => a - b);
  const summarize = key => ({ mean: frames.reduce((sum, frame) => sum + frame[key], 0) / frames.length, min: Math.min(...frames.map(f => f[key])), max: Math.max(...frames.map(f => f[key])) });
  report.performance = { method: 'RAF intervals with WebGL2 submission counters across all passes; instrumentation overhead included', unsupportedDrawPaths: ['ANGLE_instanced_arrays', 'WEBGL_multi_draw'], frameCount: frames.length, sampleMs: frames.reduce((sum, f) => sum + f.ms, 0), fps: 1000 * frames.length / frames.reduce((sum, f) => sum + f.ms, 0), p95FrameMs: sorted[Math.floor(sorted.length * .95)], drawCalls: summarize('calls'), triangles: summarize('triangles'), framesWithoutDraws: frames.filter(f => f.calls === 0).length };
  fs.writeFileSync(path.join(config.output, 'frame-samples.json'), JSON.stringify(frames));
  report.scene = await evaluate(`(${snapshot.toString()})()`);
  stage('capturing');
  const capture = async name => {
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error('Invalid capture name');
    const file = name + '.png';
    fs.writeFileSync(path.join(config.output, file), (await win.webContents.capturePage()).toPNG());
    report.captures.push(file);
  };
  await capture('00-default');
  for (const [index, name] of report.scene.views.entries()) {
    await evaluate(`window.__worldCapture.selectView(${JSON.stringify(name)})`);
    await pause(1500);
    await capture(`${String(index + 1).padStart(2, '0')}-${name}`);
  }
  if (config.videoMs > 0) {
    const video = await evaluate(`(${recordVideo.toString()})(${config.videoMs}, ${JSON.stringify(report.scene.views)})`);
    fs.writeFileSync(path.join(config.output, 'world.webm'), Buffer.from(video.data, 'base64'));
    delete video.data;
    report.video = { ...video, durationRequestedMs: config.videoMs, file: 'world.webm' };
  }
  report.finalScene = await evaluate(`(${snapshot.toString()})()`);
  report.failedRequestTiming = await evaluate(`performance.getEntriesByType('resource').filter(entry => ${JSON.stringify(report.networkFailures.map(failure => failure.url).filter(Boolean))}.includes(entry.name)).map(entry => entry.toJSON())`);
  report.gpu = { features: app.getGPUFeatureStatus(), info: await app.getGPUInfo('complete') };
  report.versions = process.versions;
  report.completedAt = new Date().toISOString();
  report.stage = 'complete';
  report.ok = report.exceptions.length === 0 && report.networkFailures.length === 0 && report.finalScene.errors.length === 0 && !report.finalScene.renderer.contextLost && !report.console.some(item => item.level === 'error' || item.level === 3);
  writeReport();
  console.log(JSON.stringify({ ok: report.ok, performance: report.performance, output: config.output }));
  clearTimeout(deadline);
  server.close(); win.destroy(); app.exit(report.ok ? 0 : 1);
}).catch(error => {
  report.failure = { kind: 'exception', message: error.message, stack: error.stack };
  writeReport(); console.error(error); server?.close(); app.exit(1);
});
app.on('window-all-closed', () => { server?.close(); app.quit(); });
