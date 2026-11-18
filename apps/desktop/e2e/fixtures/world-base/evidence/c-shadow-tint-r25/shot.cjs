// Round 25: indoor-exclusion check. Fixed cameras (04, 20, and林离's seven shop eyes from the c24 evidence), PNG, one query.
//   node shot.cjs <fixtureRoot> <outDir> <tag> [query] [port]
const path = require('node:path'), fs = require('node:fs');
const [root, out, tag, query = '', port = '8766', only = ''] = process.argv.slice(2);
const { createStaticServer } = require(path.resolve(root, 'scripts/baseline.cjs'));
const { chromium } = require('playwright');
const photos = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../c24-shadow-tint-ground-3060-2026-11-18/photos.json'), 'utf8'));
(async () => {
  fs.mkdirSync(out, { recursive: true });
  const srv = createStaticServer(path.resolve(root)); await new Promise(r => srv.listen(+port, r));
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const p = await b.newPage({ viewport: { width: 960, height: 600 } });
  p.on('pageerror', e => console.log('PAGEERR', e.message.slice(0, 300)));
  p.on('console', m => { if (m.type() === 'error') console.log('ERR', m.text().slice(0, 300)); });
  await p.goto(`http://localhost:${port}/index.html` + query);
  await p.waitForFunction(() => window.worldBase && window.worldBase.ready, null, { timeout: 900000 });
  await p.evaluate(() => { window.requestAnimationFrame = () => 0; document.body.classList.add('hide-ui'); });
  const shops = photos.pairs.shops.map(s => ({ name: s.view, fov: s.camera.fov, abs: s.camera }));
  const base = await p.evaluate(() => {
    const w = window.worldBase; const pl = w.city.placements.find(p => p.type === 'apartment' && p.model.features.shop); const [x, z] = pl.frontage, y = pl.baseY;
    const g = (a, c) => w.island.heightAt(a + w.station.root.position.x, c + w.station.root.position.z) - w.station.root.position.y;
    const v = w.views.find(q => q.name === 'shop-interior');
    return [{ name: '20', position: [x - 9, g(x - 9, z - 20) + 1.6, z - 20], target: [x + 2, y + 2.0, z - 10] },
      { name: '04', world: true, position: v.position.toArray ? v.position.toArray() : v.position, target: v.target.toArray ? v.target.toArray() : v.target }];
  });
  const views = [...base, ...shops].filter(v => !only || only.split(',').includes(v.name));
  const t0 = Date.now(); let renders = 0;
  for (const v of views) {
    const d = await p.evaluate(v => {
      const w = window.worldBase; w.walker.setEnabled(false);
      w.camera.fov = v.fov || 58; w.camera.updateProjectionMatrix();
      if (v.abs) { w.camera.position.fromArray(v.abs.position); w.camera.quaternion.fromArray(v.abs.quaternion); }
      else {
        w.camera.position.fromArray(v.position); if (!v.world) w.station.toWorld(w.camera.position, w.camera.position);
        const t = w.camera.position.clone().fromArray(v.target); w.camera.lookAt(v.world ? t : w.station.toWorld(t));
      }
      w.camera.updateMatrixWorld();
      w.look.pipeline.hasPrev = false; w.renderer.setPixelRatio(1); w.renderer.shadowMap.needsUpdate = true;
      for (let i = 0; i < 2; i++) { w.island.update(0.016, 10); w.look.render(w.scene, 0.016); }
      return { png: w.renderer.domElement.toDataURL('image/png'), cam: w.camera.position.toArray(), box: w.shadowTint && w.shadowTint.indoorBox ? w.shadowTint.indoorBox.length : 0 };
    }, v);
    fs.writeFileSync(`${out}/${v.name}-${tag}.png`, Buffer.from(d.png.split(',')[1], 'base64')); console.log('shot', v.name, tag, 'boxes', d.box); renders++;
  }
  console.log('ms/view', Math.round((Date.now() - t0) / renders));
  await b.close(); srv.close();
})().catch(e => { console.error(e); process.exit(1); });
