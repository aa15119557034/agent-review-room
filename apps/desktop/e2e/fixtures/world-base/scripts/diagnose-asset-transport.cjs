// Byte-only transport comparison. Never imports the scene or creates a canvas/WebGL context.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const { createStaticServer, cleanEnvironment } = require('./baseline.cjs');
const { verifyPreparedAssets } = require('./prepare-props.cjs');
const fixture = path.resolve(__dirname, '..');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const petalTargets = [
  ['menhir', '/assets/models/menhir.glb', '.local/petalwake-25443cef0eba802052d9ef24c94ba3c4157b6f2e/assets/models/menhir.glb'],
  ['boulders', '/assets/models/boulders.glb', '.local/petalwake-25443cef0eba802052d9ef24c94ba3c4157b6f2e/assets/models/boulders.glb'],
  ['lighthouse', '/assets/models/lighthouse.glb', '.local/petalwake-25443cef0eba802052d9ef24c94ba3c4157b6f2e/assets/models/lighthouse.glb'],
];

function buildTargets(root = fixture) {
  const placements = JSON.parse(fs.readFileSync(path.join(root, '.local/petalwake-25443cef0eba802052d9ef24c94ba3c4157b6f2e/assets/terrain/props.json'), 'utf8'));
  for (const [name] of petalTargets) if (!Array.isArray(placements[name]) || !placements[name].length) throw new Error('Transport target is no longer listed in current Petalwake props: ' + name);
  const propAssets = verifyPreparedAssets(root);
  const targets = petalTargets.map(([name, url, file]) => { const bytes = fs.readFileSync(path.join(root, file)); return { name, url, file, bytes: bytes.length, sha256: digest(bytes) }; });
  for (const file of propAssets.files) {
    const relative = file.path.slice(propAssets.preparedRoot.length + 1);
    targets.push({ name: 'prop-' + relative.replace(/[^A-Za-z0-9_.-]/g, '-'), url: propAssets.route + relative, file: file.path, bytes: file.bytes, md5: file.md5, sha256: file.sha256 });
  }
  return { targets, propAssets };
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
    console.log('node scripts/diagnose-asset-transport.cjs --electron=<existing executable> --output=<new directory> [--timeout-ms=180000]');
    return;
  }
  for (const key of Object.keys(args)) if (!['electron', 'output', 'timeout-ms'].includes(key)) throw new Error('Unknown --' + key);
  if (typeof args.electron !== 'string' || !fs.statSync(args.electron).isFile()) throw new Error('--electron must name an existing executable');
  if (typeof args.output !== 'string') throw new Error('--output must name a new directory');
  const { targets, propAssets } = buildTargets();
  const methods = ['native', 'fileloader'], repeats = 3;
  const config = { output: path.resolve(args.output), runtime: null, startedAt: new Date().toISOString(),
    timeoutMs: Number(args['timeout-ms'] ?? 180000), terminalWaitMs: 3000,
    targetScope: 'Current Petalwake props referenced by assets/terrain/props.json and src/island.js loadProps: menhir, boulders, lighthouse; plus every pinned prop-assets.json file (crate original glTF/BIN/maps, official supplemental opacity and shutter maps). This run does not retest retired city BIN/GLB assets.',
    head: cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fixture, encoding: 'utf8', windowsHide: true }).trim(),
    targets, propAssets, methods, repeats, expectedCaseCount: targets.length * methods.length * repeats,
    scripts: Object.fromEntries(['diagnose-asset-transport.cjs', 'baseline.cjs', 'prepare-props.cjs', '../prop-assets.json', '../upstream/petalwake/vendor/three/build/three.core.js', '../src/island.js', '../.local/petalwake-25443cef0eba802052d9ef24c94ba3c4157b6f2e/assets/terrain/props.json'].map(file => [file, digest(fs.readFileSync(path.resolve(__dirname, file)))])),
  };
  if (!Number.isFinite(config.timeoutMs) || config.timeoutMs < 10000) throw new Error('Invalid timeout');
  if (fs.existsSync(config.output)) throw new Error('Output exists; preserve previous evidence');
  fs.mkdirSync(config.output, { recursive: true });
  config.runtime = fs.mkdtempSync(path.join(config.output, 'runtime-'));
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
    console.log('Asset transport diagnosis PID ' + child.pid + '; output ' + config.output);
  });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => { console.log('Electron exited ' + code); process.exitCode = code === 0 ? 0 : 1; });
}

// Observers preserve original promises, return values, chunks and errors. Native arrayBuffer
// consumes its stream internally, so a missing JS reader EOF is expected for native cases.
function installObservers() {
  const trace = window.__assetTrace = { events: [], activeCase: null };
  const stamp = () => ({ timeOriginMs: performance.timeOrigin, nowMs: performance.now() });
  const record = (type, data) => trace.events.push({ type, ...stamp(), ...data });
  const bodies = new WeakMap(), readers = new WeakMap();
  const fetchOriginal = window.fetch;
  window.fetch = function(input, init) {
    const url = typeof input === 'string' ? input : input.url;
    const caseId = new URL(url, location.href).searchParams.get('transportCase');
    const signal = init?.signal || (input instanceof Request ? input.signal : null);
    record('fetch', { caseId, url, signalPresent: !!signal, signalAborted: signal?.aborted ?? null });
    signal?.addEventListener('abort', () => record('signal-abort', { caseId, reason: String(signal.reason) }), { once: true });
    const promise = Reflect.apply(fetchOriginal, this, arguments);
    promise.then(response => {
      if (response.body) bodies.set(response.body, caseId);
      record('fetch-response', { caseId, url: response.url, status: response.status });
    }, error => record('fetch-rejected', { caseId, error: String(error) }));
    return promise;
  };
  const abortOriginal = AbortController.prototype.abort;
  AbortController.prototype.abort = function() {
    record('controller-abort', { activeCase: trace.activeCase, reason: String(arguments[0]), stack: new Error('AbortController.abort').stack });
    return Reflect.apply(abortOriginal, this, arguments);
  };
  const getReaderOriginal = ReadableStream.prototype.getReader;
  ReadableStream.prototype.getReader = function() {
    const reader = Reflect.apply(getReaderOriginal, this, arguments);
    readers.set(reader, bodies.get(this) ?? null);
    return reader;
  };
  const readOriginal = ReadableStreamDefaultReader.prototype.read;
  ReadableStreamDefaultReader.prototype.read = function() {
    const caseId = readers.get(this) ?? null;
    const promise = Reflect.apply(readOriginal, this, arguments);
    promise.then(result => { if (result.done) record('reader-eof', { caseId }); },
      error => record('reader-rejected', { caseId, error: String(error) }));
    return promise;
  };
  window.__readAsset = async function(spec) {
    trace.activeCase = spec.id;
    const row = { id: spec.id, method: spec.method, url: spec.url, started: stamp() };
    record('case-started', { caseId: spec.id });
    try {
      let bytes;
      if (spec.method === 'native') {
        const response = await fetch(spec.url);
        row.status = response.status;
        if (!response.ok) throw new Error('HTTP ' + response.status);
        bytes = await response.arrayBuffer();
      } else {
        const loader = new window.__transportThree.FileLoader();
        loader.setResponseType('arraybuffer');
        bytes = await loader.loadAsync(spec.url);
      }
      row.fulfilled = stamp(); row.actualBytes = bytes.byteLength;
      record('body-fulfilled', { caseId: spec.id, bytes: bytes.byteLength });
      const hash = await crypto.subtle.digest('SHA-256', bytes);
      row.actualSha256 = Array.from(new Uint8Array(hash), n => n.toString(16).padStart(2, '0')).join('');
      row.hashed = stamp();
    } catch (error) {
      row.rejected = stamp(); row.error = error.stack || String(error);
      record('case-rejected', { caseId: spec.id, error: String(error) });
    } finally { trace.activeCase = null; }
    return row;
  };
}

async function host() {
  const { app, BrowserWindow } = require('electron');
  const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  app.setPath('userData', path.join(config.runtime, 'user-data'));
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-webgl');
  const report = { config, ok: false, bytesIntegrity: false, transportClean: false, cases: [], networkRequests: [],
    networkFailures: [], httpErrors: [], exceptions: [], consoleErrors: [], documentAnchors: [], stageHistory: [],
    method: 'No scene, canvas or WebGL. Per target: native fetch arrayBuffer x3 then unchanged Three FileLoader arraybuffer x3, sequential, unique query per case, no retries. SHA-256 compares transmitted bytes with local files at launch. Textured prop inputs additionally pass pinned size/MD5/SHA-256 and dependency checks before launch; Petal target hashes remain local transport references. Original reader/fetch promises are observed without replacement. All CDP terminal evidence is collected for 3 seconds after the final case.' };
  let win, server, timeout, expired = false;
  const requests = new Map();
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const write = () => fs.writeFileSync(path.join(config.output, 'asset-transport-report.json'), JSON.stringify(report, null, 2));
  const stage = name => { report.stage = name; report.stageHistory.push({ name, wallTime: Date.now() / 1000 }); write(); console.log(name); };
  const deadline = new Promise((_, reject) => { timeout = setTimeout(() => { expired = true; reject(new Error('Timeout at ' + report.stage)); }, config.timeoutMs); });
  async function run() {
    stage('bootstrap'); await app.whenReady(); if (expired) return;
    stage('app-ready');
    report.runtime = { electron: process.versions.electron, chrome: process.versions.chrome };
    server = createStaticServer(fixture);
    const serve = server.listeners('request')[0]; server.removeListener('request', serve);
    server.on('request', (req, res) => {
      if (req.url === '/__asset_transport.html') {
        res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
        res.end('<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><title>Asset transport only</title>');
      } else serve(req, res);
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    stage('server-ready');
    win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false } });
    stage('window-created');
    await win.loadURL('about:blank');
    stage('renderer-initialized');
    win.webContents.debugger.attach('1.3');
    const cdp = (method, params) => win.webContents.debugger.sendCommand(method, params);
    win.webContents.debugger.on('message', (_event, method, params) => {
      const event = { method, stage: report.stage, receivedWallTime: Date.now() / 1000, ...params };
      if (method === 'Runtime.exceptionThrown') report.exceptions.push(event);
      if (method === 'Runtime.consoleAPICalled' && params.type === 'error') report.consoleErrors.push(event);
      if (!['Network.requestWillBeSent', 'Network.responseReceived', 'Network.loadingFinished', 'Network.loadingFailed'].includes(method)) return;
      let row = requests.get(params.requestId);
      if (!row) { row = { requestId: params.requestId, events: [] }; requests.set(params.requestId, row); report.networkRequests.push(row); }
      row.events.push(event);
      if (method === 'Network.requestWillBeSent') {
        row.url = params.request.url; row.caseId = new URL(row.url).searchParams.get('transportCase');
        if (params.type === 'Document') report.documentAnchors.push({ requestId: params.requestId, loaderId: params.loaderId, frameId: params.frameId, url: row.url, timestamp: params.timestamp, wallTime: params.wallTime });
      }
      if (method === 'Network.loadingFailed') report.networkFailures.push(event);
      if (method === 'Network.responseReceived' && params.response.status >= 400) report.httpErrors.push(event);
    });
    win.webContents.on('render-process-gone', (_event, details) => report.exceptions.push({ stage: report.stage, processGone: details }));
    stage('enabling-network'); await cdp('Network.enable');
    stage('enabling-runtime'); await cdp('Runtime.enable');
    stage('loading-document');
    await win.loadURL('http://127.0.0.1:' + server.address().port + '/__asset_transport.html');
    const evaluate = code => { if (expired) throw new Error('Deadline elapsed'); return win.webContents.executeJavaScript(code, true); };
    await evaluate('(' + installObservers.toString() + ')()');
    await evaluate("import('/upstream/petalwake/vendor/three/build/three.core.js').then(m => { window.__transportThree=m; })");
    report.pageClock = await evaluate('({timeOriginMs:performance.timeOrigin,nowMs:performance.now(),threeRevision:window.__transportThree.REVISION})');
    for (const target of config.targets) for (const method of config.methods) for (let repeat = 1; repeat <= config.repeats; repeat++) {
      const id = `${target.name}-${method}-${repeat}`, url = target.url + '?transportCase=' + id;
      stage(id);
      const row = { id, method, url, hostStartedWallTime: Date.now() / 1000, expectedBytes: target.bytes, expectedSha256: target.sha256 };
      report.cases.push(row); write();
      Object.assign(row, await evaluate('window.__readAsset(' + JSON.stringify({ id, method, url }) + ')'));
      row.bytesIntegrity = row.actualBytes === target.bytes && row.actualSha256 === target.sha256;
      report.pageTrace = await evaluate('window.__assetTrace'); write();
    }
    stage('waiting-for-terminal-events');
    await pause(config.terminalWaitMs);
    report.pageTrace = await evaluate('window.__assetTrace');
    report.finalClock = await evaluate('({timeOriginMs:performance.timeOrigin,nowMs:performance.now()})');
  }
  try { await Promise.race([run(), deadline]); }
  catch (error) { report.failure = error.stack || String(error); console.error(error); }
  finally {
    clearTimeout(timeout);
    // Finalize before destroying the document: teardown-induced cancellations are not this experiment.
    for (const row of report.networkRequests) {
      row.terminals = row.events.filter(e => ['Network.loadingFinished', 'Network.loadingFailed'].includes(e.method));
      const request = row.events.find(e => e.method === 'Network.requestWillBeSent');
      const anchor = report.documentAnchors.find(a => a.loaderId === request?.loaderId);
      for (const event of row.events) if (anchor && report.pageClock && event.timestamp !== undefined) {
        event.documentRelativeMs = (anchor.wallTime + event.timestamp - anchor.timestamp) * 1000 - report.pageClock.timeOriginMs;
      }
    }
    report.missingTerminal = report.networkRequests.filter(r => r.terminals.length === 0).map(r => ({ requestId: r.requestId, url: r.url, caseId: r.caseId }));
    for (const row of report.cases) {
      const matches = report.networkRequests.filter(r => r.caseId === row.id);
      row.requestIds = matches.map(r => r.requestId);
      row.transportClean = matches.length === 1 && matches[0].terminals.length === 1 && matches[0].terminals[0].method === 'Network.loadingFinished' &&
        matches[0].events.some(e => e.method === 'Network.responseReceived' && e.response.status === 200);
    }
    report.bytesIntegrity = report.cases.length === config.expectedCaseCount && report.cases.every(r => r.bytesIntegrity);
    report.transportClean = report.cases.length === config.expectedCaseCount && report.cases.every(r => r.transportClean) && !report.missingTerminal.length && !report.networkFailures.length && !report.httpErrors.length;
    try {
      report.inputsUnchanged = config.targets.every(t => digest(fs.readFileSync(path.join(fixture, t.file))) === t.sha256) &&
        Object.entries(config.scripts).every(([file, hash]) => digest(fs.readFileSync(path.resolve(__dirname, file))) === hash);
    } catch (error) { report.inputsUnchanged = false; report.inputVerificationError = String(error); }
    report.evidenceCutoffWallTime = Date.now() / 1000;
    report.ok = report.bytesIntegrity && report.transportClean && report.inputsUnchanged && !report.failure && !report.exceptions.length && !report.consoleErrors.length;
    stage('complete');
    win?.destroy(); server?.close(); app.exit(report.ok ? 0 : 1);
  }
}

module.exports = { buildTargets };
const direct = require.main === module || (process.versions.electron && process.argv[1] && path.resolve(process.argv[1]) === __filename);
if (direct) {
  if (process.versions.electron) host().catch(error => { console.error(error); require('electron').app.exit(1); });
  else { try { launch(); } catch (error) { console.error(error); process.exitCode = 1; } }
}
