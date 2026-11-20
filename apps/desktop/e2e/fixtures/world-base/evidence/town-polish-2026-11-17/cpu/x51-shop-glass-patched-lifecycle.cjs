// CPU-only regression of the current source fragments. No Electron, canvas or WebGLRenderer.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const { pathToFileURL } = require('node:url');
const fixture = "D:/codex/2026-11-16/world-implementation/world-base/apps/desktop/e2e/fixtures/world-base";
const output = path.join(__dirname, 'x51-shop-glass-patched-lifecycle.json');
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
const names = ['src/city.js', 'src/city-apartments.js', 'src/station.js', 'upstream/sakuragaoka/src/core/materials.js', 'upstream/petalwake/vendor/three/build/three.module.js', 'upstream/petalwake/vendor/three/build/three.core.js'];
const sources = Object.fromEntries(names.map(name => [name, fs.readFileSync(path.join(fixture, name), 'utf8')]));
function section(text, start, end) {
  if (text.split(start).length !== 2 || text.split(end).length !== 2) throw new Error('Source marker changed: ' + start);
  const from = text.indexOf(start), to = text.indexOf(end, from);
  if (to < from) throw new Error('Source section order changed');
  return text.slice(from, to);
}
async function main() {
  if (fs.existsSync(output)) throw new Error('Keep prior evidence; output exists: ' + output);
  const THREE = await import(pathToFileURL(path.join(fixture, 'upstream/petalwake/vendor/three/build/three.module.js')).href);
  const factoryVM = { THREE };
  vm.runInNewContext(sources[names[3]].replace("import * as THREE from 'three';", '').replaceAll('export ', '') + '\nthis.create=createMaterials;', factoryVM);
  const factory = factoryVM.create({});
  const prototype = factory.glass({ tint: '#8fa6bb', opacity: .38 });
  const stationRoot = new THREE.Group();
  const stationGeo = new THREE.BoxGeometry(); stationRoot.add(new THREE.Mesh(stationGeo, prototype));
  stationRoot.updateMatrixWorld(true);
  const clipVM = { THREE };
  vm.runInNewContext(section(sources['src/station.js'], 'function clipMaterials(', 'export async function createStation(') + '\nthis.clip=clipMaterials;', clipVM);
  clipVM.clip(stationRoot, { x0: -97, x1: 97, z0: -97, z1: 97 });
  const uniformState = material => Object.fromEntries(Object.entries(material.uniforms).map(([key, uniform]) => [key, uniform.value?.toArray ? uniform.value.toArray() : uniform.value]));
  const original = JSON.stringify(uniformState(prototype));
  const cacheKeys = [...factory.cache.keys()];
  const root = new THREE.Group(), ownedMaterials = new Set(), geometries = new Set();
  const context = { source: { M: { glass: prototype } }, clones: new Map(), ownedMaterials, geometries, root, H: {}, disposed: false };
  const city = sources['src/city.js'];
  const proxyLine = city.split('\n').find(line => line.includes('const M = new Proxy(source.M'));
  if (!proxyLine) throw new Error('No current material proxy');
  const fragments = section(city, '  const clone = material => {', '  let suppressedPhysicsCalls') + proxyLine + '\n' +
    section(city, '  const houseGlass = M.glass, shopGlass = houseGlass.clone();', '  const checkLot =');
  vm.runInNewContext(fragments + '\nthis.house=houseGlass;this.shop=shopGlass;this.disposeCity=dispose;', context);
  const { house, shop } = context;
  let shopDisposes = 0, houseDisposes = 0, prototypeDisposes = 0;
  shop.addEventListener('dispose', () => shopDisposes++);
  house.addEventListener('dispose', () => houseDisposes++);
  prototype.addEventListener('dispose', () => prototypeDisposes++);
  const calls = [];
  const F = Object.fromEntries(['box', 'boxB', 'cyl'].map(name => [name, (...args) => calls.push({ method: name, material: args[0] })]));
  const builderVM = {};
  const builder = sources['src/city-apartments.js'].slice(sources['src/city-apartments.js'].indexOf('function buildLaundryShop('));
  vm.runInNewContext(builder + '\nthis.build=buildLaundryShop;', builderVM);
  builderVM.build({ M: { plain: null, metal: null }, shopGlass: context.H.shopGlass }, F, -1.25, '#ffffff');
  for (let i = 0; i < 3; i++) root.add(new THREE.Mesh(new THREE.BoxGeometry(), shop));
  root.add(new THREE.Mesh(new THREE.BoxGeometry(), house));
  const checks = {
    threeDistinctMaterials: prototype !== house && prototype !== shop && house !== shop,
    uniformsAreIndependent: [prototype, house].every(other => Object.keys(shop.uniforms).every(key => shop.uniforms[key] !== other.uniforms[key] && (typeof shop.uniforms[key].value !== 'object' || shop.uniforms[key].value === null || shop.uniforms[key].value !== other.uniforms[key].value))),
    prototypeUniformsUnchanged: JSON.stringify(uniformState(prototype)) === original,
    residentialUniformsUnchanged: JSON.stringify(uniformState(house)) === original,
    desiredShopUniforms: shop.uniforms.uTint.value.getHexString() === 'e6eef0' && shop.uniforms.uOpacity.value === .14 && shop.uniforms.uStreaks.value === 0,
    hooksPreserved: shop.onBeforeCompile === house.onBeforeCompile && shop.customProgramCacheKey === house.customProgramCacheKey && house.onBeforeCompile === prototype.onBeforeCompile && house.customProgramCacheKey === prototype.customProgramCacheKey,
    stationClipUnchanged: prototype.clippingPlanes.length === 4 && prototype.clipShadows === true,
    bothCityClonesUnclipped: [house, shop].every(material => material.clippingPlanes === null && material.clipShadows === false && material.clipIntersection === false),
    cityOwnsShop: ownedMaterials.has(shop),
    builderUsesDedicatedGlassForThreePanes: calls.filter(call => call.material === shop).length === 3,
    stationCacheKeysUnchanged: JSON.stringify([...factory.cache.keys()]) === JSON.stringify(cacheKeys),
    noShopCacheKey: !factory.cache.has('glass|' + JSON.stringify({ tint: '#e6eef0', opacity: .14, streaks: false })),
  };
  context.disposeCity();
  const firstDispose = { shop: shopDisposes, house: houseDisposes, prototype: prototypeDisposes };
  context.disposeCity();
  const secondDispose = { shop: shopDisposes, house: houseDisposes, prototype: prototypeDisposes };
  checks.shopDisposedExactlyOnce = firstDispose.shop === 1 && secondDispose.shop === 1;
  checks.houseDisposedExactlyOnce = firstDispose.house === 1 && secondDispose.house === 1;
  checks.stationPrototypeNotDisposed = firstDispose.prototype === 0 && secondDispose.prototype === 0;
  checks.sourceUnchanged = names.every(name => fs.readFileSync(path.join(fixture, name), 'utf8') === sources[name]);
  const report = { head: cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fixture, encoding: 'utf8', windowsHide: true }).trim(),
    sourceHashes: Object.fromEntries(names.map(name => [name, sha(sources[name])])), driverSha256: sha(fs.readFileSync(__filename)),
    runtime: { node: process.versions.node, three: THREE.REVISION }, method: 'Actual Three module and actual material factory; exact current clipMaterials, city clone/proxy/shop/dispose source fragments evaluated in VM. Exact buildLaundryShop called with a recording geometry sink. Three real Mesh panes share the dedicated glass. Not a full station build or GPU allocation/release measurement.',
    checks, firstDispose, secondDispose, cacheKeysBefore: cacheKeys, cacheKeysAfter: [...factory.cache.keys()],
    uniformValues: { prototype: uniformState(prototype), house: uniformState(house), shop: uniformState(shop) },
    passed: Object.values(checks).every(Boolean) };
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  stationGeo.dispose(); // CPU-only probe geometry; station prototype is intentionally not disposed in the measured sequence.
  console.log(JSON.stringify({ output, passed: report.passed, checks, firstDispose, secondDispose }, null, 2));
  process.exitCode = report.passed ? 0 : 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
