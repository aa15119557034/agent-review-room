// Run with Node. Electron builds the complete station, with WebGL disabled, then
// examines every visible triangle near the three displays before static batching.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const args = process.argv.slice(2), value = key => args.find(a => a.startsWith('--' + key + '='))?.slice(key.length + 3);
const fixture = path.resolve(value('fixture') || path.join(__dirname, '../../..'));
const output = path.resolve(value('output') || path.join(fixture, 'artifacts', 'w1-audit-replay'));
const baseline = require(path.join(fixture, 'scripts', 'baseline.cjs'));
const read = file => fs.readFileSync(path.join(fixture, file), 'utf8');
const stairs = args.includes('--stairs');
if (!process.versions.electron) {
  const exe = value('electron');
  assert(exe, 'Provide --electron=<local Electron executable>');
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-w1-cpu-'));
  const result = cp.spawnSync(exe, [__filename, ...args], {
    cwd: fixture, env: baseline.cleanEnvironment(runtime), stdio: 'inherit', windowsHide: true
  });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}
const { app, BrowserWindow } = require('electron');
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'r3-w1-profile-')));
function replace(file, anchor, change) {
  assert.equal(file.split(anchor).length, 2, 'Expected unique R3 source anchor ' + anchor);
  return file.replace(anchor, change);
}
function mount() {
  const server = baseline.createStaticServer(fixture), original = server.listeners('request')[0];
  server.removeListener('request', original);
  server.on('request', (req, res) => {
    let body;
    if (req.url === '/src/main.js') {
      const ctor = "new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' })";
      const standIn = '({domElement:canvas,shadowMap:{},capabilities:{getMaxAnisotropy:()=>8,reversedDepthBuffer:false},info:{},setRenderTarget(){},setClearColor(){},clear(){},setScissorTest(){},setScissor(){},setViewport(){},render(){},getRenderTarget(){return null},getClearColor(v){return v.set(0)},getClearAlpha(){return 1},setSize(){},setPixelRatio(){},getPixelRatio(){return 1},getDrawingBufferSize(v){return v.set(1440,900)}})';
      body = replace(read('src/main.js'), ctor, standIn);
      const gate = "const originalGetContext = HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext = function(type,...args) { if (/webgl/i.test(type)) throw Error('A WebGL context was requested during the CPU audit'); return originalGetContext.call(this,type,...args); }; ";
      body = replace(body, 'const canvas =', gate + 'const canvas =');
    } else if (req.url === '/src/station.js') {
      const anchor = '  const batchStart = performance.now();';
      const probe = fs.readFileSync(path.join(__dirname, 'rays.cjs'), 'utf8');
      body = replace(read('src/station.js'), anchor, 'root.updateWorldMatrix(true,true); window.__w1Audit=(' + probe + ')(THREE,root,ctx);' + anchor);
    } else if (stairs && req.url === '/src/art-r1.js') {
      const anchor = '      const tiers = [[0.12, 0.13, 0.36], [0.25, 0.04, 0.24], [0.38, -0.05, 0.12]];';
      body = replace(read('src/art-r1.js'), anchor, [
        "      k.box(0.78, 0.13, 0.28, M.t('#e9ecef', { paint: 0.02 }), [z.cx, FY + 0.185, iz - 0.07]);",
        "      k.box(0.78, 0.13, 0.14, M.t('#e9ecef', { paint: 0.02 }), [z.cx, FY + 0.315, iz - 0.14]);", anchor
      ].join('\n'));
      body = replace(body, '0.05, 0.07, 0.2, c)', '0.15, 0.07, 0.2, c)');
      body = replace(body, '0.06, 0.11, 0.12, 0.09, c', '0.16, 0.11, 0.12, 0.09, c');
    } else return original(req, res);
    res.writeHead(200, {'Content-Type':'application/javascript','Cache-Control':'no-store'}).end(body);
  });
  return server;
}
(async () => {
  await app.whenReady();
  const server = mount();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const win = new BrowserWindow({show:false,width:1440,height:900,webPreferences:{sandbox:true,nodeIntegration:false,contextIsolation:true,backgroundThrottling:false}});
  const timer = setTimeout(() => { console.error('CPU station build timeout'); app.exit(1); }, 180000);
  try {
    await win.loadURL('http://127.0.0.1:' + server.address().port + '/');
    let state;
    do {
      await new Promise(resolve => setTimeout(resolve, 250));
      state = await win.webContents.executeJavaScript('({report:window.__w1Audit,errors:window.worldBase?.errors||[]})');
      assert.deepEqual(state.errors, []);
    } while (!state.report);
    assert.equal(state.report.rows.length, 60);
    const unsupported = state.report.rows.filter(r => !r.contactCount).length;
    assert.equal(unsupported, stairs ? 0 : 48);
    if (stairs) assert(state.report.rows.every(r => r.sampled === r.contactCount));
    fs.mkdirSync(output, {recursive:true});
    fs.writeFileSync(path.join(output, stairs ? 'trial-stairs.json' : 'r3-stock.json'), JSON.stringify(state.report,null,2) + '\n');
    console.log(JSON.stringify({goods:state.report.rows.length,unsupported}));
  } finally {
    clearTimeout(timer); win.destroy(); server.close();
  }
  app.exit(0);
})().catch(error => { console.error(error); app.exit(1); });
