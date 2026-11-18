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
    const { carveBasins,basins,contour } = await import(url('src/basins.js'));
    const { createWeather } = await import(url('src/weather.js'));
    const { createRipples } = await import(url('src/water-ripples.js'));
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
    const splatN=2048,splat=new Uint8Array(4*splatN*splatN).fill(150);
    const freshwater=carveBasins({h,N:meta.n,cell:meta.cell,splat,splatN});
    const wetArea=freshwater.reduce((total,b)=>total+b.areaM2,0);
    assert(wetArea>140000 && freshwater.every(b=>b.areaM2>10000 && b.volumeM3/b.areaM2>0.25));
    assert.equal(contour(basins[2],basins[2].x,basins[2].z)>1,true,'oxbow encloses a dry central point bar');
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
    const weather=createWeather('afternoon');
    const stages=[0,24,48,80,165].map(t=>{weather.update(t);return {...weather.state};});
    assert.equal(new Set(stages.map(s=>s.phase)).size,5);
    assert(stages[2].rain>0.8 && stages[2].fog<0.01 && stages[4].fog>0.75 && stages[4].windSpeed<1);
    weather.update(280); assert.equal(weather.state.regime,'干燥高压脊');assert(weather.state.rain<0.01);
    weather.update(494); assert.equal(weather.state.regime,'湿润强锋');assert(weather.state.rain>0.9);
    for(let t=0;t<=1430;t+=0.5){
      weather.update(t);const s=weather.state;
      assert(s.dewPoint<=s.temperature && s.rain>=0 && s.rain<=1 && s.windSpeed>0);
    }
    // An infinitely long dry divider must prevent a forced wave from reaching the other half.
    const ripples=createRipples((b,x)=>x>1.6 && x<2.4 ? 0 : 0.9),lake={};
    assert(!ripples.disturb(lake,2,0));
    assert(ripples.disturb(lake,0,0,0.04));
    let spread=0, leak=0;
    for(let frame=0;frame<100;frame++){
      ripples.update(1/60);
      const v=ripples.texture.image.data;
      for(let j=2;j<94;j++)for(let i=2;i<94;i++){
        if(i<44)spread=Math.max(spread,Math.abs(v[j*96+i]));
        if(i>=59)leak=Math.max(leak,Math.abs(v[j*96+i]));
      }
    }
    assert(spread>0.001 && leak===0);
    console.log(JSON.stringify({samples:h.length, quadrants, signChanges, protectedChanges, relief,
      freshwater,wetArea,stages:stages.map(s=>s.phase),contactWave:{spread,leak}}));
  } finally { hook.deregister(); }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
