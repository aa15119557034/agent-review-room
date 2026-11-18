// Verify the adapted relief against the original 16-bit grid, including every
// coastline sign and protected town sample. Run with the fixture assets prepared.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { registerHooks } = require('node:module');
const { pathToFileURL } = require('node:url');

async function main() {
  const fixture = path.resolve(__dirname, '..');
  const url = rel => pathToFileURL(path.join(fixture, rel)).href;
  const hook = registerHooks({ resolve(specifier, ctx, next) {
    if (specifier === 'three') return { url: url('upstream/petalwake/vendor/three/build/three.module.js'), shortCircuit: true };
    return next(specifier, ctx);
  } });
  try {
    const { shapeIslandRelief } = await import(url('src/coast.js'));
    const { World } = await import(url('upstream/petalwake/src/core/ctx.js'));
    const source = require('../sources.json').petalwake;
    const assets = path.join(fixture, '.local', 'petalwake-' + source.commit, 'assets');
    const meta = JSON.parse(fs.readFileSync(path.join(assets,'terrain/meta.json')));
    const { towns } = JSON.parse(fs.readFileSync(path.join(assets,'town/index.json')));
    const buf = fs.readFileSync(path.join(assets,'terrain/height.u16'));
    const raw = new Uint16Array(buf.buffer, buf.byteOffset, buf.length/2);
    const scale = (meta.hMax-meta.hMin)/65535;
    const h = Float32Array.from(raw, value => meta.hMin + scale*value);
    const station = { minX:188, minZ:803, maxX:372, maxZ:1028 };
    assert.equal(meta.world, World.size);
    const relief = shapeIslandRelief({ h, N:meta.n, cell:meta.cell, meta }, towns, station);
    const quadrants = [0,0,0,0];
    let signChanges=0, protectedChanges=0;
    const bounds = towns.map(town => town.aabb);
    for (let row=0; row<meta.n; row++) {
      const z = (row+0.5)*meta.cell-World.half;
      const lots = bounds.filter(b => z>=b[2] && z<=b[5]);
      for (let col=0; col<meta.n; col++) {
        const i=row*meta.n+col, original=Math.fround(meta.hMin+scale*raw[i]);
        if (h[i]===original) continue;
        if ((h[i]>meta.sea)!==(original>meta.sea)) signChanges++;
        const x=(col+0.5)*meta.cell-World.half;
        if (lots.some(b => x>=b[0] && x<=b[3]) ||
            x>=station.minX && x<=station.maxX && z>=station.minZ && z<=station.maxZ) protectedChanges++;
        quadrants[Number(x>0)+2*Number(z>0)]++;
      }
    }
    assert(!!relief.shoreSamples && !!relief.inlandSamples && quadrants.every(n=>n>0));
    assert.equal(signChanges,0);
    assert.equal(protectedChanges,0);
    console.log(JSON.stringify({samples:h.length, quadrants, signChanges, protectedChanges, relief}));
  } finally { hook.deregister(); }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
