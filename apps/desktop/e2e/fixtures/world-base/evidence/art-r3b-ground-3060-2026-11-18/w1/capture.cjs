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
const previous = path.resolve(__dirname,'../../art-r3-ground-3060-2026-11-18/w1');
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
      const probe = fs.readFileSync(path.join(previous, 'rays.cjs'), 'utf8');
      body = replace(read('src/station.js'), anchor, 'root.updateWorldMatrix(true,true); window.__w1Audit=(' + probe + ')(THREE,root,ctx);' + anchor);
    } else if (req.url === '/upstream/sakuragaoka/src/core/batch2.js') {
      const anchor = '    out.add(mesh);';
      const observe = fs.readFileSync(path.join(__dirname,'observe-atlas.cjs'),'utf8');
      body = replace(read('upstream/sakuragaoka/src/core/batch2.js'), anchor, anchor+'('+observe+')(mesh, list);');
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
      state = await win.webContents.executeJavaScript('({report:window.__w1Audit,cards:window.__w1Cards||[],errors:window.worldBase?.errors||[]})');
      assert.deepEqual(state.errors, []);
    } while (!state.report || state.cards.length !== 3);
    assert.equal(state.report.rows.length, 60);
    const comparison = JSON.parse(fs.readFileSync(path.join(previous,'r3-stock.json'),'utf8'));
    assert.deepEqual(state.report.solids,comparison.solids);
    assert(state.report.rows.every(r=>r.sampled===r.contactCount));
    assert.equal(state.report.rows.reduce((n,r)=>n+r.sampled,0),51036);
    assert(state.cards.every(r=>r.sourceMaterial==='MeshBasicMaterial' && r.batchMaterial==='MeshBasicMaterial' && r.differentPixels===0 && r.groupObjectCount>1));
    const source=cp.execFileSync('git',['rev-parse','HEAD'],{cwd:fixture,encoding:'utf8'}).trim();
    fs.mkdirSync(output,{recursive:true});
    fs.writeFileSync(path.join(output,'r3b-stock.json'),JSON.stringify({source,...state.report,atlas:state.cards},null,2)+'\n');
    console.log(source, state.report.rows.length, 'items; 51036/51036 supported; all 3 unchanged colliders; 3 packed printed cards.');
  } finally {
    clearTimeout(timer); win.destroy(); server.close();
  }
  app.exit(0);
})().catch(error => { console.error(error); app.exit(1); });
