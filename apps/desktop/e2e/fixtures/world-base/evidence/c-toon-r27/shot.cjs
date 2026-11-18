// Round 26: indoor-exclusion shrunk to the rooms. All fixed cameras of 林离's c24/c25 photos in ONE page load (SwiftShader).
//   node shot.cjs <fixtureRoot> <outDir> <tag> [query] [port]
// Writes <view>-<tag>.png and weights-<tag>.json (post-processing weight uShOn per view).
const path = require('node:path'), fs = require('node:fs');
const [root, out, tag, query = '', port = '8766', only = ''] = process.argv.slice(2);
const { createStaticServer } = require(path.resolve(root, 'scripts/baseline.cjs'));
const { chromium } = require('playwright');
const ev = path.resolve(__dirname, '..');
const c24 = JSON.parse(fs.readFileSync(path.join(ev, 'c24-shadow-tint-ground-3060-2026-11-18/photos.json'), 'utf8')).pairs.evening;
const shops = JSON.parse(fs.readFileSync(path.join(ev, 'c25-interior-ground-3060-2026-11-18/photos/measurements.json'), 'utf8')).pairs.shops;
const all = [...c24.map(s => ({ name: s.view, camera: s.camera })), ...shops.map(s => ({ name: s.view, camera: s.camera }))];
const views = all.filter(v => !only || only.split(',').includes(v.name));
// PROBE="W4:5,270,..." prints the object hit at those 960x600 pixels (name, lot-local position) for the named view.
const probe = Object.fromEntries((process.env.PROBE || '').split(';').filter(Boolean).map(t => { const [n, xy] = t.split(':'); return [n, xy.split(',').map(Number)]; }));
(async () => {
  fs.mkdirSync(out, { recursive: true });
  const srv = createStaticServer(path.resolve(root)); await new Promise(r => srv.listen(+port, r));
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const p = await b.newPage({ viewport: { width: 960, height: 600 } });
  p.on('pageerror', e => console.log('PAGEERR', e.message.slice(0, 300)));
  p.on('console', m => { if (m.type() === 'error') console.log('ERR', m.text().slice(0, 300)); });
  await p.goto(`http://localhost:${port}/index.html` + query);
  await p.waitForFunction(() => window.worldBase && window.worldBase.ready, null, { timeout: 1500000 });
  await p.evaluate(() => { window.requestAnimationFrame = () => 0; document.body.classList.add('hide-ui'); });
  const weights = {};
  for (const v of views) {
    const d = await p.evaluate(async ([v, pr]) => {
      const w = window.worldBase; w.walker.setEnabled(false);
      w.camera.fov = v.camera.fov; w.camera.updateProjectionMatrix();
      w.camera.position.fromArray(v.camera.position); w.camera.quaternion.fromArray(v.camera.quaternion); w.camera.updateMatrixWorld();
      w.look.pipeline.hasPrev = false; w.renderer.setPixelRatio(1); w.renderer.shadowMap.needsUpdate = true;
      for (let i = 0; i < 2; i++) { w.island.update(0.016, 10); w.look.render(w.scene, 0.016); }
      const u = w.look.pipeline.finalMat.uniforms.uShOn.value;
      const png = w.renderer.domElement.toDataURL('image/png'); // read before any await: the drawing buffer is cleared once the task yields
      let hit = null;
      if (pr) { const rc = new (await import("three")).Raycaster(); for (let i = 0; i < pr.length; i += 2) { rc.setFromCamera({ x: pr[i] / 480 - 1, y: 1 - pr[i + 1] / 300 }, w.camera); const h = rc.intersectObjects(w.scene.children, true)[0]; (hit ||= []).push(h ? { p: h.point.toArray().map(n => +n.toFixed(2)), obj: h.object.name || h.object.type, parent: h.object.parent && h.object.parent.name } : null); } }
      return { hit, png, on: u, boxes: w.shadowTint && w.shadowTint.indoorBox ? w.shadowTint.indoorBox.length : 0 };
    }, [v, probe[v.name]]);
    if (d.hit) console.log('probe', v.name, JSON.stringify(d.hit));
    fs.writeFileSync(`${out}/${v.name}-${tag}.png`, Buffer.from(d.png.split(',')[1], 'base64')); weights[v.name] = d.on; console.log('shot', v.name, tag, 'weight', d.on, 'boxes', d.boxes);
  }
  fs.writeFileSync(`${out}/weights-${tag}.json`, JSON.stringify(weights, null, 1));
  await b.close(); srv.close();
})().catch(e => { console.error(e); process.exit(1); });
