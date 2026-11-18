// Fixed-camera stills for round 23 (weathering: decal bake, van exclusion, shader diet). Usage:
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
  const srv = createStaticServer(fix); await new Promise(r => srv.listen(Number(process.env.PORT || 8765), r));
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const p = await b.newPage({ viewport: { width: 960, height: 600 } });
  p.on('pageerror', e => console.log('PAGEERR', e.message.slice(0, 300)));
  p.on('console', m => { if (m.type() === 'error') console.log('ERR', m.text().slice(0, 300)); });
  await p.goto('http://localhost:' + (process.env.PORT || 8765) + '/index.html' + query);
  const tl = Date.now(); await p.waitForFunction(() => window.worldBase && window.worldBase.ready, null, { timeout: 1800000 }); console.log('ready after s', ((Date.now() - tl) / 1000).toFixed(1));
  const t0 = Date.now(); console.log('timing', JSON.stringify(await p.evaluate(() => ({ weatheringMs: window.worldBase.weatheringMs, decals: window.worldBase.weatheringDecals.stats.source, rays: window.worldBase.weatheringDecals.stats.rays, planMs: window.worldBase.weatheringDecals.stats.planMs, vehicleVolumes: window.worldBase.weathering.stats.vehicleVolumes }))));
  // Vehicle check: every patched vertex inside a vehicle's volume must carry weight 0.
  console.log('vehicleCheck', JSON.stringify(await p.evaluate(async () => {
    const THREE = await import('three'), w = window.worldBase, out = [];
    w.scene.updateMatrixWorld(true);
    w.scene.traverse(v => {
      if (!v.isMesh) return; let veh = false;
      for (let q = v; q; q = q.parent) if (/^vehicles$/.test(q.name || '')) veh = true;
      if (!veh) return;
      const bb = new THREE.Box3().setFromObject(v).expandByVector(new THREE.Vector3(0.3, 1.0, 0.3)); bb.min.y -= 0.2;
      let inside = 0, weighted = 0;
      w.scene.traverse(m => {
        const a = m.isMesh && m.geometry.getAttribute('wxMask'); if (!a) return;
        const pos = m.geometry.attributes.position, p = new THREE.Vector3();
        for (let i = 0; i < pos.count; i++) { p.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld); if (bb.containsPoint(p)) { inside++; if (a.getX(i) > 0.01) weighted++; } }
      });
      out.push({ vehicle: v.parent?.name, glassBox: bb.min.toArray().concat(bb.max.toArray()).map(x => +x.toFixed(1)), patchedVerticesInside: inside, withWeight: weighted });
    });
    return out;
  })));
  await p.evaluate(() => { window.requestAnimationFrame = () => 0; document.body.classList.add('hide-ui'); });
  const views = await p.evaluate(() => {
    const w = window.worldBase; const pl = w.city.placements.find(p => p.type === 'apartment' && p.model.features.shop); const [x, z] = pl.frontage, y = pl.baseY;
    const g = (a, c) => w.island.heightAt(a + w.station.root.position.x, c + w.station.root.position.z) - w.station.root.position.y;
    return [{ name: '01-street', position: [-1.2, 2.4, 36], target: [0, 2.0, -25] },
      { name: '01-leftwall', position: [-1.0, 1.7, 34.6], target: [-4.84, 1.2, 28.8], fov: 50 },
      { name: 'van', fov: 47, world: true, quat: [-0.029182465008512196, -0.7830517056478151, -0.03684648464040197, 0.6201779958912754], position: [276.3147277851227, 11.210013480772632, 971.1462175645175] },
      { name: '20-rear-eye', position: [x - 9, g(x - 9, z - 20) + 1.6, z - 20], target: [x + 2, y + 2.0, z - 10] },
      { name: '21-front-eye', position: [x - 8, g(x - 8, -117) + 1.66, -117], target: [x + 2, y + 2.1, z - .4] },
      { name: '24-laundry-details', fov: 55, ...w.city.stats.texturedProps.view }];
  });
  for (const v of views) {
    if (only && !only.split(',').includes(v.name)) continue;
    const d = await p.evaluate(v => {
      const w = window.worldBase; w.walker.setEnabled(false);
      w.camera.fov = v.fov || 58; w.camera.updateProjectionMatrix();
      const pos = v.world ? w.camera.position.fromArray(v.position) : w.station.toWorld(w.camera.position.fromArray(v.position), w.camera.position);
      if (v.quat) w.camera.quaternion.fromArray(v.quat);
      else { const t = w.camera.position.clone().fromArray(v.target); w.camera.lookAt(v.world ? t : w.station.toWorld(t)); }
      w.camera.updateMatrixWorld();
      w.look.pipeline.hasPrev = false; w.renderer.setPixelRatio(1); w.renderer.shadowMap.needsUpdate = true;
      for (let i = 0; i < 2; i++) { w.island.update(0.016, 10); w.look.render(w.scene, 0.016); }
      return w.renderer.domElement.toDataURL('image/jpeg', 0.92);
    }, v);
    fs.writeFileSync(`${out}/${v.name}-${tag}.jpg`, Buffer.from(d.split(',')[1], 'base64')); console.log('shot', v.name, tag);
  }
  await b.close(); srv.close();
})().catch(e => { console.error(e); process.exit(1); });
