// Fixed-camera stills for round 22 (weathering). Usage:
//   node shot.cjs <outDir> <tag> [query]   e.g.  node shot.cjs /tmp/out before "" ;  node shot.cjs /tmp/out after "?time=afternoon"
// Cloud renderer: Playwright + SwiftShader, loop stopped after ready, two manual frames per view.
const path = require('node:path');
const fix = path.resolve(__dirname, '../..');
const { createStaticServer } = require(fix + '/scripts/baseline.cjs');
const { chromium } = require('playwright');
const fs = require('node:fs');
(async () => {
  const [out, tag, query = '', only = ''] = process.argv.slice(2);
  fs.mkdirSync(out, { recursive: true });
  const srv = createStaticServer(fix); await new Promise(r => srv.listen(8765, r));
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const p = await b.newPage({ viewport: { width: 960, height: 600 } });
  p.on('pageerror', e => console.log('PAGEERR', e.message.slice(0, 300)));
  p.on('console', m => { if (m.type() === 'error') console.log('ERR', m.text().slice(0, 300)); });
  await p.goto('http://localhost:8765/index.html' + query);
  await p.waitForFunction(() => window.worldBase && window.worldBase.ready, null, { timeout: 900000 });
  await p.evaluate(() => { window.requestAnimationFrame = () => 0; document.body.classList.add('hide-ui'); });
  const views = await p.evaluate(() => {
    const w = window.worldBase; const pl = w.city.placements.find(p => p.type === 'apartment' && p.model.features.shop); const [x, z] = pl.frontage, y = pl.baseY;
    const g = (a, c) => w.island.heightAt(a + w.station.root.position.x, c + w.station.root.position.z) - w.station.root.position.y;
    return [{ name: '01-street', position: [-1.2, 2.4, 36], target: [0, 2.0, -25] },
      { name: '20-rear-eye', position: [x - 9, g(x - 9, z - 20) + 1.6, z - 20], target: [x + 2, y + 2.0, z - 10] },
      { name: '21-front-eye', position: [x - 8, g(x - 8, -117) + 1.66, -117], target: [x + 2, y + 2.1, z - .4] },
      { name: '24-laundry-details', fov: 55, ...w.city.stats.texturedProps.view },
      { name: '30-aerial', fov: 58, world: true, position: [2100, 2350, 2450], target: [-150, 70, -150] }];
  });
  for (const v of views) {
    if (only && !only.split(',').includes(v.name)) continue;
    const d = await p.evaluate(v => {
      const w = window.worldBase; w.walker.setEnabled(false);
      w.camera.fov = v.fov || 58; w.camera.updateProjectionMatrix();
      const pos = v.world ? w.camera.position.fromArray(v.position) : w.station.toWorld(w.camera.position.fromArray(v.position), w.camera.position);
      const t = w.camera.position.clone().fromArray(v.target);
      w.camera.lookAt(v.world ? t : w.station.toWorld(t)); w.camera.updateMatrixWorld();
      w.look.pipeline.hasPrev = false; w.renderer.setPixelRatio(1); w.renderer.shadowMap.needsUpdate = true;
      for (let i = 0; i < 2; i++) { w.island.update(0.016, 10); w.look.render(w.scene, 0.016); }
      return w.renderer.domElement.toDataURL('image/jpeg', 0.92);
    }, v);
    fs.writeFileSync(`${out}/${v.name}-${tag}.jpg`, Buffer.from(d.split(',')[1], 'base64')); console.log('shot', v.name, tag);
  }
  await b.close(); srv.close();
})().catch(e => { console.error(e); process.exit(1); });
