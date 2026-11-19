'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

function shootRear(name) {
  const w = window.worldBase;
  const detail = name === 'rear-4f-parcels';
  const suffix = detail ? '4f' : name.slice(5);
  const building = w.city.placements.find(p => p.name === 'town-apartment-' + suffix);
  const [x, y, z] = building.worldOrigin;
  const depth = name === 'rear-5f' ? 10 : 9;
  const position = detail ? [x + 3.8, y + 4.17, z - depth - .88] : [x + 2.4, y + 2.7, z - depth - 7.8];
  const target = detail ? [x + 5.15, y + 3.19, z - depth - .37] : [x, y + 1.6, z - depth - .18];
  const fov = detail ? 55 : 46;

  const camera = w.camera, renderer = w.renderer;
  const start = document.querySelector('#go');
  if (start && !start.disabled) start.click();
  window.__surfaceGate.freeze();
  w.walker.setEnabled(false);
  w.setFlightEffects(false);
  document.body.classList.add('hide-ui');
  camera.position.fromArray(position);
  camera.lookAt(...target);
  camera.fov = fov;
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
  w.station.update(0, 14, w.walker.worldPosition);
  w.island.update(0, 14);
  w.island.U.uTime.value = 14;
  w.look.pipeline.hasPrev = false;
  const gl = renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
  const frames = [];
  for (let n = 0; n < 3; n++) {
    w.look.render(w.scene, 0);
    frames.push(renderer.domElement.toDataURL('image/png').split(',')[1]);
  }
  return {
    frames,
    view: {name, position, target, fov},
    current: name,
    location: {name: building.name, worldOrigin: building.worldOrigin, floors: building.floors, floorHeight: building.floorHeight},
    eye: camera.position.toArray(),
    quaternion: camera.quaternion.toArray(),
    fov: camera.fov,
    time: w.station.ctx.time,
    islandTime: w.island.U.uTime.value,
    timeOfDay: w.island.timeOfDay,
    hidden: ['#panel','#help','#loading'].every(sel => getComputedStyle(document.querySelector(sel)).display === 'none'),
    canvas: [gl.drawingBufferWidth,gl.drawingBufferHeight],
    gpu: ext && gl.getParameter(ext.UNMASKED_RENDERER_WEBGL),
    glError:gl.getError(),
    errors:w.errors.slice(),
    geometry:{calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, doorsteps: w.city.stats.artDoorsteps ?? null},
  };
}

const [runtime] = process.argv.slice(2);
assert(runtime, 'Pass the installed Electron executable.');
const dir = __dirname, root = path.dirname(dir);
const fixturePath = 'apps/desktop/e2e/fixtures/world-base';
const audit = path.join('D:/codex/2026-11-16/world-implementation/world-request-audit', fixturePath);
const state = JSON.parse(fs.readFileSync(path.join(dir, 'running-state.json'), 'utf8'));
assert(state.length === 8 && state.every(s => s.status === 0), 'Complete B��y��y�H, walking and legacy sessions first.');
let host = fs.readFileSync(path.join(dir, 'plaza-capture.cjs'), 'utf8').replaceAll('\r\n','\n');
const edit = (from, to) => {
  assert.equal(host.split(from).length, 2, from);
  host = host.replace(from, () => to);
};
const prefix = host.indexOf('function shoot(name)');
const suffix = host.indexOf('async function capture(out)', prefix);
assert(prefix !== -1 && suffix > prefix);
host = host.slice(0,prefix) + shootRear.toString().replace('function shootRear','function shoot') + '\n\n' + host.slice(suffix);
edit(host.split('\n').find(line => line.startsWith('const samples = ')), 'const samples = [\'rear-3f\',\'rear-5f\',\'rear-4f-parcels\'];');
edit('show:true,autoHideMenuBar:true', 'show:false,autoHideMenuBar:true');
edit('    const wc=win.webContents;', '    win.showInactive(); const wc=win.webContents;');
edit("app.commandLine.appendSwitch('force-device-scale-factor','1');","app.commandLine.appendSwitch('force-device-scale-factor','1');\n    app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');\n    app.commandLine.appendSwitch('disable-features','CalculateNativeWinOcclusion');");
edit('[...samples,samples[0]].entries()', 'samples.entries()');
edit("const key=i===samples.length?'return-a':name, file=key+'.png';", "const key=name, file=key+'.png';");
edit("    for(const k of ['eye','quaternion','fov','time','view']) assert.deepEqual(report.photos[samples[0]][k],report.photos['return-a'][k]);", '');
edit('assert(photo.hidden && photo.buttonActive);', 'assert(photo.hidden);');
const temp = fs.mkdtempSync(path.join(os.tmpdir(),'x51-r8-rear-'));
const generated = path.join(temp,'capture.cjs');
fs.writeFileSync(generated,host);
try {
  for (const arm of ['before','after']) {
    const fixture = path.join(root, arm === 'before' ? 'x51-r7-after' : 'x51-r8-after', fixturePath);
    const output = path.join(dir, 'rear-' + arm);
    const result = spawnSync(process.execPath, [generated,'on',path.resolve(runtime),output], {
      cwd: fixture,
      env: {...process.env,WORLD_FIXTURE:fixture,AUDIT_FIXTURE:audit},
      windowsHide:true,stdio:'inherit',
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw Error('Rear photo ' + arm + ' exited ' + result.status);
  }
  const reports = ['before','after'].map(a => JSON.parse(fs.readFileSync(path.join(dir,'rear-'+a,'report.json'),'utf8')));
  assert.equal(reports[0].source,state[0].sha);
  assert.equal(reports[1].source,state[1].sha);
  for (const name of ['rear-3f','rear-5f','rear-4f-parcels']) {
    for (const key of ['location','view','eye','quaternion','fov','time','canvas']) {
      assert.deepEqual(reports[0].photos[name][key],reports[1].photos[name][key]);
    }
  }
  console.log('Three matching rear camera poses verified.');
} finally {
  fs.unlinkSync(generated);
  fs.rmdirSync(temp);
}
