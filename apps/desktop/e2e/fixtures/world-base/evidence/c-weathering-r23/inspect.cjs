// Round 23 helper: list the weathered meshes around a world point and any vehicle-looking nodes.
const path = require('node:path');
const fix = path.resolve(__dirname, '../..');
const { createStaticServer } = require(fix + '/scripts/baseline.cjs');
const { chromium } = require('playwright');
(async () => {
  const srv = createStaticServer(fix); await new Promise(r => srv.listen(8766, r));
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const p = await b.newPage({ viewport: { width: 640, height: 400 } });
  p.on('pageerror', e => console.log('PAGEERR', e.message.slice(0, 300)));
  await p.goto('http://localhost:8766/index.html?weathering=off');
  await p.waitForFunction(() => window.worldBase && window.worldBase.ready, null, { timeout: 900000 });
  const out = await p.evaluate(() => {
    const w = window.worldBase, THREE = null; const res = { o: w.station.root.position.toArray(), veh: [], near: [] };
    const re = /van|car\b|vehicle|truck|bus\b|kei|lorry|wagon|auto|train|bike|cart/i;
    const cam = [276.3, 11.2, 971.1];
    w.scene.updateMatrixWorld(true);
    w.scene.traverse(m => {
      if (!m.isMesh) return;
      const chain = []; for (let q = m; q; q = q.parent) if (q.name) chain.push(q.name);
      const mats = [].concat(m.material).map(x => (x.name || x.type) + (x.vertexColors ? '+vc' : '') + (x.map ? '+map' : ''));
      m.geometry.computeBoundingBox(); const bb = m.geometry.boundingBox.clone().applyMatrix4(m.matrixWorld);
      const c = bb.getCenter(bb.min.clone()), d = Math.hypot(c.x - cam[0], c.z - cam[2]);
      const tris = (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3;
      const row = { name: m.name, chain: chain.slice(0, 7).join('<'), mats, tris, size: bb.getSize(bb.min.clone()).toArray().map(v => +v.toFixed(1)), c: c.toArray().map(v => +v.toFixed(1)) };
      if (chain.some(n => re.test(n)) || re.test(mats.join())) res.veh.push(row);
      if (d < 14 && tris < 5000) res.near.push(row);
    });
    return res;
  });
  console.log(JSON.stringify(out, null, 1));
  await b.close(); srv.close();
})().catch(e => { console.error(e); process.exit(1); });
