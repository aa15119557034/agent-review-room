import * as THREE from 'three';
import { loadTable, loadModels, pickWeighted, makeMaterial, makeMaterialSet, makeBatch, makeBatches, partitionOpaqueInstances, limitInstancedDetailDistance, getAerial, getContext, hash32, rngFrom, fbm, noise2, smooth, focusFalloff } from './scatter-common.js';
import { addStationLawn } from './transition.js';
import { SWARD_COOL, SWARD_WARM, SWARD_WARMTH, SWARD_DAPPLE, SWARD_PAINT_FIELD, SWARD_EXPOSURE } from './island-ground.js';
import { ATMOSPHERE, CLOUD_SHADOW, NOISE, TERRAIN_LOOKUP, VALUE_NOISE_2D } from '../upstream/petalwake/src/shaders/common.js';
import { SKY_UNIFORMS } from '../upstream/petalwake/src/world/sky.js';

// X-51 vegetation (2026-11-21): island-wide trees, bushes, hedges and grass tufts as InstancedMesh batches (one draw call per GLB, materials baked into
// vertex colours, toon ramp + camera-distance fog from scatter-common.js). Models, sizes, origin offsets, radii, species weights and scale ranges live in
// src/props-veg.json ("vegetation"); the rules below ask for a species and never name a GLB.
// ?veg=off loads nothing (this file is not even imported) and the page is the one before.
//
// Rules (all of them ask scatter-common's context, none knows a camera):
//   trees      jittered grid of `tree.cell` m over the whole island. Chance = (bg + (density - bg) x forest) x focus, where `forest` is a smooth noise mask (patches of
//              `forestScale` m, not an even sprinkle) and `focus` falls from 1 (near the station and the two towns) to `far` at 1800 m. Skipped: underwater / beach
//              (< `minH` m), above the tree line, slopes > `maxSlope`, where the grass cover of the splat map is < `coverMin` (towns, lots, station, facade rows were all
//              cleared there before this runs), near the river, inside a town's box (x `townKeep`), `walkMargin` m from the walkable area, `bldMargin` m from any building /
//              lot / slot / mesh box, inside a town's solid heightmap, on a road or its corridor, on an old Petalwake prop. Species: conifer on slopes, high ground and in
//              far forests, cherry a few percent near the settlements (more near roads), otherwise broadleaf a / b.
//   street     young trees along every street of the towns, alternate sides, every `street.spacing` m.
//   bushes     one beside `bush.share` of the trees + free bushes along forest edges.
//   hedges     a trimmed row outside the walkable rectangle, layered with lower shrubs where the border has room.
//   grass      small clumps and flowers at tree feet, road verges and town walls. The original
//              open-meadow scattering is retained for the comparison with ?ground=off.
//   LOD        trees with a named near model use the light model beyond the configured camera distance.
// Caps (`cap`) thin a class uniformly when the budget (1.5 M triangles, 60 draw calls for props + vegetation) would be exceeded.

export const vegEnabled = () => new URLSearchParams(location.search).get('veg') !== 'off';
// Keep the complete F and H plantings in their own approved views.
const MEADOW_DETAIL_DISTANCE = 110;
const ISLAND_BATCH_CELL = 640;

export const PARAMS = {
  seed: 2112,
  tree: { cell: 9, density: 0.5, bg: 0.03, far: 0.07, forestScale: 230, forestLo: 0.55, forestHi: 0.7, minH: 1.2, maxSlope: 0.5, coverMin: 0.25, treeline: [170, 300],
    walkMargin: 5, bldMargin: 3, corrMargin: 2, roadMargin: 1.5, townKeep: 0.12, cap: 4200,
    conifer: { slope: 0.3, height: 140, farShare: 0.82 }, cherry: { near: 0.06, byRoad: 0.14, roadReach: 45 } },
  street: { spacing: [9, 13], offset: 1.9, keep: 0.75, minHalfW: 1.8 },
  bush: { share: 0.55, cell: 14, edge: 0.3, base: 0.05, cap: 3500, walkMargin: 2.5 },
  hedge: { offset: 1.4, overlap: 0.92 },   // segment spacing = model length x overlap
  // World-space grass focuses include the extra meadow around (60, 110).
  grass: { cell: 4, p: 0.2, meadowBoost: 1.7, perTree: 2, cap: 30000, coverMin: 0.45, radius: [[280, 900, 450], [176, -1182, 150], [60, 110, 200]], flowerShare: 0.27,
    // Station-local east lawn. The station clears its terrain cover and includes it in the walkable rectangle.
    lawn: { x: [64, 91], z: [8, 126] },
    edge: { step: 1.7, p: 0.6, reach: [0.4, 2.6], reachFocus: 1.25, flower: 0.4, coverMin: 0.2 } },
  skipRoads: /:(mole|pier)$/,
};

const _cam = new THREE.Vector3(), _m = new THREE.Matrix4(), _x = new THREE.Vector3(), _y = new THREE.Vector3(0, 1, 0), _z = new THREE.Vector3(), _t = new THREE.Vector3();
const facing = (x, y, z, fx, fz, sy) => _m.clone().makeBasis(_x.set(fz, 0, -fx), _y.set(0, sy, 0), _z.set(fx, 0, fz)).setPosition(_t.set(x, y, z));

const meadowBlockers = ['walk', 'bld', 'corr', 'prop', 'town', 'solid'];
function canPlantMeadow(ctx, x, z, clearance) {
  const road = ctx.roadDist(x, z);
  return ctx.cover(x, z) >= 0.6 && ctx.slope(x, z) <= 0.92 && !ctx.isWater(x, z, 0.6)
    && (!road || road.over >= 0.55 + clearance) && !ctx.obstacle(x, z, clearance, meadowBlockers);
}

function plantFlowerBeds(ctx, habitats, grassModels, seed) {
  return habitats.map(({ name, clusters }, habitatIndex) => {
    const flowers = [], grass = [], counts = [];
    for (const [index, [cx, cz, radius, count, primary, accent]] of clusters.entries()) {
      const r = rngFrom(hash32(seed, 80 + habitatIndex, index));
      const start = r() * Math.PI * 2;
      const roots = [];
      for (let i = 0; i < count * 8 && roots.length < count; i++) {
        const theta = start + i * 2.399963 + (r() - 0.5) * 0.32;
        const reach = radius * Math.pow(r(), 0.76);
        const x = cx + Math.cos(theta) * reach, z = cz + Math.sin(theta) * reach;
        if (roots.some(p => Math.hypot(p.x - x, p.z - z) < 0.105) || !canPlantMeadow(ctx, x, z, 0.16)) continue;
        const species = r() < 0.14 ? accent : primary;
        const headScale = 1.24 + 0.49 * r();
        roots.push({ x, y: ctx.groundY(x, z), z, species, headScale });
      }
      if (roots.length < 15) continue;
      flowers.push(...roots);
      counts.push(roots.length);
      // Overlap wider low blades in the centre and round the rim to cover the flower stems' bases.
      const grassCount = Math.round(4 + radius * 7);
      for (let i = 0; i < grassCount; i++) {
        const theta = start + i * 2.399963 + (r() - 0.5) * 0.4;
        const reach = radius * (0.14 + r() * 0.72);
        const x = cx + Math.cos(theta) * reach, z = cz + Math.sin(theta) * reach;
        if (!canPlantMeadow(ctx, x, z, 0.4)) continue;
        const kind = pickWeighted(r, grassModels), s = 0.89 + 0.34 * r();
        grass.push({ kind, x, y: ctx.groundY(x, z) - 0.017, z, yaw: r() * Math.PI * 2,
          sx: s, sy: 0.30 + 0.15 * r(), sz: s, tint: 0.82 + 0.15 * r() });
      }
    }
    return { name, flowers, grass, counts };
  });
}

function plantGrassBands(ctx, habitats, seed) {
  const up = new THREE.Vector3(0, 1, 0), normal = new THREE.Vector3();
  const tilt = new THREE.Quaternion(), rotate = new THREE.Quaternion();
  const position = new THREE.Vector3(), scale = new THREE.Vector3();
  return habitats.map(({ name, clusters, grassBands }, habitatIndex) => {
    const grass = [], counts = [];
    for (const [index, [cx, cz, length, width, angle, count, height]] of grassBands.entries()) {
      const r = rngFrom(hash32(seed, 112 + habitatIndex, index));
      const c = Math.cos(angle), s = Math.sin(angle), tufts = [];
      for (let i = 0; i < count * 6 && tufts.length < count; i++) {
        const theta = i * 2.399963 + r() * 0.63;
        const radius = i === 0 ? 0 : 0.34 + 0.66 * Math.sqrt(r());
        const u = Math.cos(theta) * radius * length, v = Math.sin(theta) * radius * width;
        const x = cx + u * c - v * s, z = cz + u * s + v * c;
        if (!canPlantMeadow(ctx, x, z, 0.58) || clusters.some(([fx, fz, fr]) => Math.hypot(fx - x, fz - z) < fr + 0.28)) continue;
        if (tufts.some(t => Math.hypot(t.x - x, t.z - z) < 0.24)) continue;
        const kind = r() < 0.48 ? 'meadowFan' : 'meadowSweep';
        const yaw = angle + (r() - 0.5) * 2.3 + (i % 2) * Math.PI;
        const size = 0.74 + 0.32 * r(), bladeHeight = height * (0.74 + 0.28 * r());
        const y = ctx.groundY(x, z) - 0.045;
        ctx.terrain.normalAt(x, z, normal, 0.56).lerp(up, 0.51).normalize();
        tilt.setFromUnitVectors(up, normal).multiply(rotate.setFromAxisAngle(up, yaw));
        const matrix = new THREE.Matrix4().compose(position.set(x, y, z), tilt, scale.set(size, bladeHeight, size));
        const tint = 0.78 + 0.21 * r();
        tufts.push({ kind, x, y, z, matrix, tint, tr: 0.88 + 0.11 * r(), tb: 0.94 + 0.1 * r() });
      }
      grass.push(...tufts);
      counts.push(tufts.length);
    }
    return { name, grass, counts };
  });
}

function plantShortSward(ctx, habitats, seed) {
  const up = new THREE.Vector3(0, 1, 0), normal = new THREE.Vector3();
  const tilt = new THREE.Quaternion(), rotate = new THREE.Quaternion();
  const position = new THREE.Vector3(), scale = new THREE.Vector3();
  const cell = 12;
  return habitats.map(({ name, carpet, bounds: [x0, z0, x1, z1], clusters, swardAreas }, habitatIndex) => {
    const step = carpet ? 0.56 : 0.88;
    const patches = swardAreas.map(([x, z, length, width, angle, density]) =>
      ({ x, z, length, width, density, c: Math.cos(angle), s: Math.sin(angle) }));
    const cells = new Map();
    for (let gz = Math.ceil(z0 / step); gz * step < z1; gz++) for (let gx = Math.ceil(x0 / step); gx * step < x1; gx++) {
      const r = rngFrom(hash32(seed, gx, gz, habitatIndex + 135));
      const x = (gx + (r() - 0.5) * 0.83) * step, z = (gz + (r() - 0.5) * 0.83) * step;
      const field = noise2(x, z, 3.0, seed + 39);
      let cover = 0;
      for (const area of patches) {
        const dx = x - area.x, dz = z - area.z;
        const u = (dx * area.c + dz * area.s) / area.length;
        const v = (dz * area.c - dx * area.s) / area.width;
        const wobble = (carpet ? 0.12 : 0.22) * (field - 0.5);
        cover = Math.max(cover, area.density * (1 - smooth(0.45, 1.03, u * u + v * v + wobble)));
      }
      // Keep a continuous core. Shape low, overlapping blades at the edge instead of scattering single tiles beyond it.
      if ((carpet ? cover < 0.24 : r() > cover * (0.51 + 0.60 * field)) || !canPlantMeadow(ctx, x, z, 0.90)) continue;
      // Short, sparse blades under the flowers support the bed while leaving its color visible.
      const underFlowers = clusters.some(([fx, fz, fr]) => Math.hypot(fx - x, fz - z) < fr);
      const kind = r() < (underFlowers ? 0.88 : 0.52) ? 'swardLow' : 'swardBowed';
      const yaw = r() * Math.PI * 2, size = 0.84 + 0.20 * r();
      const rim = carpet ? smooth(0.24, 0.78, cover) : 1;
      const bladeHeight = (underFlowers ? 0.56 : 0.82) * (0.77 + 0.26 * field + 0.26 * r());
      const y = ctx.groundY(x, z) - 0.048;
      ctx.terrain.normalAt(x, z, normal, 0.60).lerp(up, 0.26).normalize();
      tilt.setFromUnitVectors(up, normal).multiply(rotate.setFromAxisAngle(up, yaw));
      const spread = size * (carpet ? 0.72 + 0.17 * rim : 1);
      const height = bladeHeight * (carpet ? 0.43 + 0.43 * rim : 1);
      const matrix = new THREE.Matrix4().compose(position.set(x, y, z), tilt, scale.set(spread, height, spread));
      const key = `${Math.floor(x / cell)}:${Math.floor(z / cell)}:${kind}`;
      if (!cells.has(key)) cells.set(key, { kind, items: [] });
      cells.get(key).items.push({ x, y, z, matrix, tint: 0.87 + 0.18 * r(), tr: 0.93 + 0.11 * field, tb: 1.03 - 0.14 * field });
    }
    return { name, carpet, cells };
  });
}

function hillsideBladeMaterial(island) {
  const uniforms = Object.fromEntries([...SKY_UNIFORMS, 'uTime', 'uWorld', 'uHeightTex', 'uSplatTex', 'uLightTex']
    .map(name => [name, island.U[name]]));
  const swatch = hex => new THREE.Vector3(...new THREE.Color(hex).toArray().map(value => +value.toFixed(4)));
  Object.assign(uniforms, {
    uBladeCool: { value: swatch(SWARD_COOL) }, uBladeWarm: { value: swatch(SWARD_WARM) },
    uBladeExposure: { value: island.timeOfDay === 'night' ? 0.35 : 1 },
    uWbWorldToStation: island.terrain.material.uniforms.uWbWorldToStation,
  });
  return new THREE.ShaderMaterial({
    name: 'vegetation-hillside-blade-paint', uniforms,
    vertexShader: /* glsl */ `
varying vec3 vBladeWorld;
varying float vBladeHeight;
void main(){
  vec4 world = modelMatrix * instanceMatrix * vec4(position, 1.0);
  vBladeWorld = world.xyz;
  vBladeHeight = position.y;
  gl_Position = projectionMatrix * viewMatrix * world;
}`,
    fragmentShader: /* glsl */ `
varying vec3 vBladeWorld;
varying float vBladeHeight;
uniform float uTime;
uniform mat4 uWbWorldToStation;
uniform vec3 uBladeCool, uBladeWarm;
uniform float uBladeExposure;
${NOISE}
${ATMOSPHERE}
${CLOUD_SHADOW}
${TERRAIN_LOOKUP}
${SWARD_WARMTH}
${SWARD_DAPPLE}
void main(){
    vec3 P = vBladeWorld;
    float dist = distance(uCamPos, P);
    vec2 localXZ = (uWbWorldToStation * vec4(P, 1.0)).xz;
    float lod = mix(mix(0.72, 1.28, swardMeadow(P.xz)), 2.35, smoothstep(32.0, 430.0, dist));
    float direct = dot(terrainN(P.xz, lod), uSunDir);
    // The shoulder lies outside town and station shadow bounds. Use the island bake and the same cloud paint as its ground.
    float shadow = texture(uLightTex, worldUV(P.xz)).r;
    float sunlit = smoothstep(0.18, 0.70, shadow) * smoothstep(-0.13, 0.12, direct);
${SWARD_PAINT_FIELD}
${SWARD_EXPOSURE}
    float cs = cloudShadow(P.xz, uTime);
    vec3 ground = mix(uBladeCool, uBladeWarm, warmth) * light * mix(0.92, 1.0, cs) * uBladeExposure;
    ground *= mix(vec3(1.0), vec3(0.54, 0.73, 0.88), dappleShade * mix(0.65, 1.0, sunlit));
    float tip = smoothstep(0.012, 0.17, vBladeHeight);
    vec3 bladeTip = mix(vec3(1.07, 1.20, 1.18), vec3(1.24, 1.17, 0.93), sunlit * (1.0 - dappleShade));
    vec3 colour = applyAtmosphere(ground * mix(vec3(1.0), bladeTip, tip), P);
    gl_FragColor = vec4(colour, 0.0);
}`,
  });
}

function shortSwardMaterial(gradientMap, aerial, time) {
  const material = makeMaterial({ gradientMap, aerial, name: 'vegetation-short-sward' });
  const before = material.onBeforeCompile, cacheKey = material.customProgramCacheKey;
  material.onBeforeCompile = (shader, renderer) => {
    before.call(material, shader, renderer);
    shader.uniforms.uSwardTime = time;
    shader.fragmentShader = shader.fragmentShader
      .replace('void main()', `uniform float uSwardTime;\n${VALUE_NOISE_2D}\n${SWARD_DAPPLE}\nvoid main()`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        diffuseColor.rgb *= mix(vec3(1.0), vec3(0.70, 0.86, 0.98), swardDapple(vBkPos.xz, uSwardTime));`);
  };
  material.customProgramCacheKey = () => `${cacheKey.call(material)}|short-sward-dapple`;
  return material;
}

export async function createVegetation({ scene, worldBase, island, station, flowerBeds = [], dryRun = false }) {
  const t0 = performance.now(), P = PARAMS, T = P.tree, rng = rngFrom(hash32(P.seed, 1));
  const ctx = await getContext({ worldBase, island, station, scene });
  const [aerial, table] = await Promise.all([getAerial(worldBase, island), loadTable()]);
  const model = await loadModels(table.vegetation), SP = table.vegetation.species, kindOf = sp => pickWeighted(rng, SP[sp].models), scaleOf = sp => range(SP[sp].scale);
  const materials = makeMaterialSet({ gradientMap: station.ctx.mat.gradientMap, aerial, name: 'vegetation' });
  const root = new THREE.Group(); root.name = 'vegetation-scatter';
  const items = {}, rejects = {}, bump = k => { rejects[k] = (rejects[k] ?? 0) + 1; return null; };
  const push = (kind, it) => (items[kind] ??= []).push(it);
  const tint = (k = 1, v = 0.3) => { const t = (1 - v / 2 + rng() * v) * k; return { tint: t, tr: 1 + (rng() - 0.5) * 0.1, tg: 1, tb: 1 + (rng() - 0.5) * 0.1 }; };
  const range = ([a, b]) => a + rng() * (b - a);
  const props = worldBase.scatter?.props?.items ?? [];
  const nearProp = (x, z, d) => props.some(p => p.kind !== 'wire' && Math.hypot(p.x - x, p.z - z) < d + p.r);
  // the two shared checks of every class
  const room = (x, z, r, margins) => ctx.obstacle(x, z, r, ['walk', 'bld', 'corr', 'prop', 'town'], margins);
  const onRoad = (x, z, r) => { const rd = ctx.roadDist(x, z, 30); return rd && rd.over < r; };
  const half = 3072, bases = [], trees = [];

  // ---- trees ------------------------------------------------------------------------------------------------------------------------------------
  let attempts = 0;
  for (let gz = -half; gz < half; gz += T.cell) for (let gx = -half; gx < half; gx += T.cell) {
    const x = gx + rng() * T.cell, z = gz + rng() * T.cell, f = focusFalloff(ctx, x, z, 1, T.far);
    const n = fbm(x, z, T.forestScale, P.seed), mask = smooth(T.forestLo, T.forestHi, n);
    let p = (T.bg + (T.density - T.bg) * mask) * f.k;
    const roll = rng(), town = island.town.nameAt(x, z);
    if (town) p *= T.townKeep;
    if (roll > p) continue;
    attempts++;
    const h = ctx.groundY(x, z);
    if (h < T.minH) { bump('tree-low'); continue; }
    if (rng() < smooth(T.treeline[0], T.treeline[1], h)) { bump('tree-line'); continue; }
    const sl = ctx.slope(x, z);
    if (sl > T.maxSlope) { bump('tree-slope'); continue; }
    if (ctx.cover(x, z) < T.coverMin) { bump('tree-cover'); continue; }
    if (ctx.isWater(x, z, 5)) { bump('tree-water'); continue; }
    // species
    let sp;
    const rd = ctx.roadDist(x, z, T.cherry.roadReach + 5), nearSettlement = f.d < 150;
    if (sl > T.conifer.slope || h > T.conifer.height || (f.d > 350 && fbm(x, z, 300, P.seed + 3) > T.conifer.farShare)) sp = 'conifer';
    else if (nearSettlement && rng() < (rd && rd.d < T.cherry.roadReach ? T.cherry.byRoad : T.cherry.near)) sp = 'cherry';
    else sp = 'broadleaf';
    const kind = kindOf(sp), s = scaleOf(sp), r = model[kind].radius * s;
    const why = room(x, z, r * 0.7, { walk: T.walkMargin, bld: T.bldMargin, corr: T.corrMargin });
    if (why) { bump('tree-' + why.split(':')[0]); continue; }
    if (rd && rd.over < r + T.roadMargin) { bump('tree-road'); continue; }
    const rec = { kind, x, y: h - 0.2, z, yaw: rng() * Math.PI * 2, sx: s, sy: s * (0.92 + rng() * 0.16), sz: s, r, ...tint(1, 0.3) };
    trees.push(rec);
  }
  // street trees (young): along the settlements' streets
  let streetTrees = 0;
  for (const r of ctx.roads) {
    if (r.group === 'station' || r.halfW < P.street.minHalfW || P.skipRoads.test(r.name)) continue;
    let s = 3 + rng() * P.street.spacing[1], side = hash32(P.seed, r.pts.length) & 1 ? 1 : -1;
    while (s < r.length - 3) {
      const q = r.pts[Math.round(s)], d = r.halfW + P.street.offset, x = q.x - q.tz * side * d, z = q.z + q.tx * side * d;
      s += range(P.street.spacing); side = -side;
      if (rng() > P.street.keep) continue;
      const h = ctx.groundY(x, z), sc = scaleOf('young');
      if (h < T.minH || ctx.isWater(x, z, 1) || ctx.slope(x, z) > T.maxSlope) { bump('street-ground'); continue; }
      if (ctx.obstacle(x, z, 0.9, ['bld', 'prop', 'town', 'solid'], null, ctx.groundY(q.x, q.z))) { bump('street-blocked'); continue; }
      const rd = ctx.roadDist(x, z, 14, r.i ?? ctx.roads.indexOf(r)); if (rd && rd.over < 0.8) { bump('street-road'); continue; }
      if (nearProp(x, z, 0.8) || trees.some(t => t.street && Math.hypot(t.x - x, t.z - z) < 4)) { bump('street-prop'); continue; }
      const yk = kindOf('young'); trees.push({ kind: yk, x, y: h - 0.05, z, yaw: rng() * Math.PI * 2, sx: sc, sy: sc, sz: sc, r: model[yk].radius * sc, street: true, ...tint(1, 0.2) }); streetTrees++;
    }
  }
  // cap: uniform thinning keeps the pattern (street trees are never dropped)
  const treeCap = T.cap + streetTrees; let thinned = 0;
  const keptTrees = trees.length > treeCap ? trees.filter(t => { const keep = t.street || rng() < (T.cap / (trees.length - streetTrees)); if (!keep) thinned++; return keep; }) : trees;
  for (const t of keptTrees) { push(t.kind, t); bases.push(t); }

  // ---- bushes -----------------------------------------------------------------------------------------------------------------------------------
  const B = P.bush; let bushCount = 0; const bushes = [];
  const tryBush = (x, z, why) => {
    const h = ctx.groundY(x, z);
    if (h < T.minH || ctx.slope(x, z) > 0.6 || ctx.cover(x, z) < 0.2 || ctx.isWater(x, z, 2)) return bump('bush-ground');
    const bk = kindOf('bush'), s = scaleOf('bush'), reason = room(x, z, model[bk].radius * s, { walk: B.walkMargin, bld: 1.5, corr: 1 }); if (reason) return bump('bush-' + reason.split(':')[0]);
    if (onRoad(x, z, model[bk].radius * s + 0.6) || nearProp(x, z, 0.9)) return bump('bush-road');
    bushes.push({ kind: bk, r: model[bk].radius * s, x, y: h - 0.08, z, yaw: rng() * Math.PI * 2, sx: s, sy: s * (0.85 + rng() * 0.3), sz: s, ...tint(1, 0.35), companion: why }); return true;
  };
  for (const t of keptTrees) {
    if (t.street || t.kind === 'conifer' && rng() < 0.5) continue;
    if (rng() > B.share) continue;
    const a = rng() * Math.PI * 2, d = t.r * 0.9 + 1.2 + rng() * 2.2;
    tryBush(t.x + Math.cos(a) * d, t.z + Math.sin(a) * d, 'tree');
  }
  for (let gz = -half; gz < half; gz += B.cell) for (let gx = -half; gx < half; gx += B.cell) {
    const x = gx + rng() * B.cell, z = gz + rng() * B.cell, f = focusFalloff(ctx, x, z, 1, T.far), n = fbm(x, z, T.forestScale, P.seed);
    const edge = smooth(T.forestLo - 0.12, T.forestLo, n) * (1 - smooth(T.forestHi, T.forestHi + 0.1, n));
    if (rng() > (B.base + B.edge * edge) * f.k * (island.town.nameAt(x, z) ? T.townKeep : 1)) continue;
    tryBush(x, z, 'free');
  }
  const keptBushes = bushes.length > B.cap ? bushes.filter(() => rng() < B.cap / bushes.length) : bushes;
  for (const b of keptBushes) push(b.kind, b);

  // ---- hedges along the walkable rectangle ---------------------------------------------------------------------------------------------------------
  let hedgeCount = 0; const hk = kindOf('hedge'), hedgeBushes = [];
  {
    const b = station.bounds, o = station.root.position, H = P.hedge, d = H.offset;
    const x0 = b.x0 + o.x - d, x1 = b.x1 + o.x + d, z0 = b.z0 + o.z - d, z1 = b.z1 + o.z + d;
    const step = model[hk].size[0] * H.overlap;
    const borderTrees = keptTrees.filter(t => t.x >= x0 - 7 && t.x <= x1 + 7 && t.z >= z0 - 7 && t.z <= z1 + 7);
    const hedgeRng = rngFrom(hash32(P.seed, 43));
    const tryHedgeBush = (x, z, hedgeY, scale) => {
      const kind = pickWeighted(hedgeRng, SP.bush.models), size = model[kind].size;
      const r = Math.hypot(size[0], size[2]) * scale / 2, y = ctx.groundY(x, z);
      if (y < T.minH || Math.abs(y - hedgeY) > 0.45 || ctx.isWater(x, z, 1) || ctx.slope(x, z) > 0.6) return;
      if (room(x, z, r, { corr: 1.5 }) || onRoad(x, z, r + 1.2) || nearProp(x, z, r + 0.4)) return;
      if (borderTrees.some(t => Math.hypot(t.x - x, t.z - z) < r + 0.55)) return;
      if (hedgeBushes.some(bush => Math.hypot(bush.x - x, bush.z - z) < 2.4)) return;
      const shrub = { kind, r, x, y: y - 0.06, z, yaw: hedgeRng() * Math.PI * 2, sx: scale, sy: scale * 0.95, sz: scale, tint: 0.94 };
      hedgeBushes.push(shrub);
      push(kind, shrub);
    };
    const edges = [[x0, z0, x1, z0, 0, -1], [x1, z0, x1, z1, 1, 0], [x1, z1, x0, z1, 0, 1], [x0, z1, x0, z0, -1, 0]]; // from, to, outward normal
    for (const [ax, az, bx, bz, nx, nz] of edges) {
      const len = Math.hypot(bx - ax, bz - az), ux = (bx - ax) / len, uz = (bz - az) / len;
      for (let s = step / 2; s < len - step / 2; s += step) {
        const x = ax + ux * s, z = az + uz * s;
        // Keep the original sampling sequence for the seeded grass pass below.
        const wasGap = rng() < 0.06;
        const y = ctx.groundY(x, z);
        if (y < T.minH || ctx.isWater(x, z, 1) || ctx.slope(x, z) > 0.8) { bump('hedge-ground'); continue; }
        if (ctx.obstacle(x, z, 1.0, ['walk', 'bld', 'corr', 'prop', 'town'], { corr: 1.5 })) { bump('hedge-blocked'); continue; }
        if (onRoad(x, z, 2.2) || nearProp(x, z, 1.0)) { bump('hedge-road'); continue; }
        const height = 0.68 + 0.62 * noise2(x, z, 6.7, P.seed + 29);
        const color = wasGap ? { tint: 1 } : tint(1, 0.2);
        push(hk, { matrix: facing(x, y - 0.03, z, nx, nz, height), ...color, hedge: true, x, z, y, r: 1.2 });
        hedgeCount++;
        // Keep most of the clipped row open to view and add depth at selected clusters and tree feet.
        const nearCorner = Math.min(s, len - s) < 6;
        const nearTree = borderTrees.some(t => Math.hypot(t.x - x, t.z - z) < 5);
        const cluster = noise2(x, z, 9, P.seed + 37) > 0.61;
        if ((nearCorner || nearTree || cluster) && hedgeRng() > 0.26) {
          const shift = (hedgeRng() - 0.5) * step;
          tryHedgeBush(x + ux * shift - nx * 0.64, z + uz * shift - nz * 0.64, y, 0.41 + hedgeRng() * 0.09);
        }
        if ((nearCorner || nearTree) && hedgeRng() > 0.32) {
          tryHedgeBush(x + nx * 1.25, z + nz * 1.25, y, 0.65 + hedgeRng() * 0.14);
        }
      }
    }
  }

  // ---- grass: tuft rings at tree feet and clusters along roads and walls ----
  const Gp = P.grass, tufts = [];
  const paintedSward = worldBase.ground?.islandSward;
  const makeTuft = (x, z, hy, flower = Gp.flowerShare) => {
    const sp = rng() < flower ? 'flower' : 'grass', s = scaleOf(sp);
    const kind = kindOf(sp), yaw = rng() * Math.PI * 2, h = s * (0.8 + rng() * 0.5);
    return { kind, x, y: hy - 0.02, z, yaw, sx: s, sy: h, sz: s, ...tint(1, 0.35) };
  };
  for (const t of [...keptTrees, ...keptBushes]) {
    if (t.street) continue;
    const heading = paintedSward ? rng() * Math.PI * 2 : 0;
    const groups = paintedSward && t.r >= 1.65 && focusFalloff(ctx, t.x, t.z).d < 120 ? 2 : 1;
    for (let i = 0; i < Gp.perTree * groups; i++) {
      const angle = paintedSward
        ? heading + Math.floor(i / Gp.perTree) * Math.PI + (i % Gp.perTree - 0.5) * 0.26
        : rng() * Math.PI * 2;
      const radius = (t.r ?? 1) * 0.35;
      const distance = paintedSward ? radius + 0.53 + rng() * 0.55 : radius + 0.8 + rng() * 1.5;
      const x = t.x + Math.cos(angle) * distance, z = t.z + Math.sin(angle) * distance;
      if (ctx.cover(x, z) > 0.3 && !onRoad(x, z, 0.5)) tufts.push(makeTuft(x, z, ctx.groundY(x, z)));
    }
  }
  const rootGrass = tufts.length;
  // open meadow around the focus points: patchy, `meadowBoost` over the old density (the foreground was bare), flower patches on a 14 m noise
  let open = 0, edge = 0;
  const meadowWeight = (x, z) => 0.25 + noise2(x, z, 22, P.seed + 5) * 1.2;
  const meadowFlowers = (x, z) => Gp.flowerShare * (0.3 + 1.6 * smooth(0.45, 0.7, noise2(x, z, 14, P.seed + 9)));
  const openReject = (x, z, y, lawn = false) => {
    if (y < T.minH || ctx.slope(x, z) > 0.6 || (!lawn && ctx.cover(x, z) < Gp.coverMin) || ctx.isWater(x, z, 1.5)) return 'grass-ground';
    if (ctx.obstacle(x, z, 0.3, lawn ? ['bld', 'prop', 'town', 'solid'] : ['walk', 'bld', 'prop', 'town'], lawn ? null : { walk: 0.8 })) return lawn ? 'grass-lawn-blocked' : 'grass-blocked';
    if (onRoad(x, z, 0.6) || nearProp(x, z, 0.5)) return 'grass-road';
    return null;
  };
  if (!paintedSward) {
    for (const [fx, fz, R] of Gp.radius) for (let gz = fz - R; gz < fz + R; gz += Gp.cell) for (let gx = fx - R; gx < fx + R; gx += Gp.cell) {
      const x = gx + rng() * Gp.cell, z = gz + rng() * Gp.cell;
      if (Math.hypot(x - fx, z - fz) > R) continue;
      if (rng() > Gp.p * Gp.meadowBoost * meadowWeight(x, z) * (1 - smooth(R * 0.6, R, Math.hypot(x - fx, z - fz)) * 0.8)) continue;
      if (island.town.nameAt(x, z)) continue;
      const y = ctx.groundY(x, z);
      const reason = openReject(x, z, y);
      if (reason) { bump(reason); continue; }
      tufts.push(makeTuft(x, z, y, meadowFlowers(x, z))); open++;
    }
  }
  // verges: both sides of every road near the focus points, `edge.reach` m beyond the kerb, thicker and with more flowers than the open meadow
  const E = Gp.edge;
  for (const r of ctx.roads) {
    if (r.halfW < 1 || P.skipRoads.test(r.name)) continue;
    for (let s = rng() * E.step; s < r.length; s += E.step) {
      const q = r.pts[Math.round(s)]; if (!q) break;
      if (!Gp.radius.some(([fx, fz, R]) => Math.hypot(q.x - fx, q.z - fz) < R * E.reachFocus)) continue;
      for (const side of [-1, 1]) {
        if (rng() > E.p * (0.35 + noise2(q.x, q.z, 18, P.seed + 7) * 1.3)) continue;
        const d = r.halfW + E.reach[0] + rng() * (E.reach[1] - E.reach[0]), x = q.x - q.tz * side * d + (rng() - 0.5) * 0.6, z = q.z + q.tx * side * d + (rng() - 0.5) * 0.6, y = ctx.groundY(x, z);
        if (y < T.minH || ctx.slope(x, z) > 0.6 || ctx.cover(x, z) < Gp.edge.coverMin || ctx.isWater(x, z, 1.5)) { bump('edge-ground'); continue; }
        if (ctx.obstacle(x, z, 0.3, ['walk', 'bld', 'prop', 'town'], { walk: 0.8 })) { bump('edge-blocked'); continue; }
        const rd = ctx.roadDist(x, z, 14, r.i ?? ctx.roads.indexOf(r)); if (rd && rd.over < 0.4) { bump('edge-road'); continue; }
        if (nearProp(x, z, 0.5)) { bump('edge-prop'); continue; }
        tufts.push(makeTuft(x, z, y, E.flower)); edge++;
      }
    }
  }
  const beforeWalls = tufts.length;
  if (paintedSward) {
    const occupied = new Set(), wallRng = rngFrom(hash32(P.seed, 64));
    const sides = [[-1, 0], [1, 0], [0, -1], [0, 1]];
    const addWallClump = (wallX, wallZ, dx, dz) => {
      const spacing = 3.4;
      const key = `${Math.floor(wallX / spacing)},${Math.floor(wallZ / spacing)}`;
      if (occupied.has(key) || wallRng() > 0.22) return;
      let placed = false;
      for (const tangent of [-0.28, 0.28]) {
        const x = wallX + dx * 0.86 + dz * tangent, z = wallZ + dz * 0.86 - dx * tangent;
        const y = ctx.groundY(x, z);
        if (y < T.minH || ctx.cover(x, z) < E.coverMin || ctx.slope(x, z) > 0.6 || ctx.isWater(x, z, 1.2)) continue;
        if (onRoad(x, z, 0.52) || nearProp(x, z, 0.35) || room(x, z, 0.3, { walk: 0.8 })) continue;
        tufts.push(makeTuft(x, z, y, 0.18));
        placed = true;
      }
      if (placed) occupied.add(key);
    };
    for (const s of [...island.town.solids].sort((a, b) => a.x0 - b.x0 || a.z0 - b.z0)) {
      for (let iz = 0; iz < s.nz; iz++) for (let ix = 0; ix < s.nx; ix++) {
        const height = s.grid[iz * s.nx + ix];
        if (!height) continue;
        const x = s.x0 + (ix + 0.5) * s.cell, z = s.z0 + (iz + 0.5) * s.cell;
        for (const [dx, dz] of sides) {
          const nx = ix + dx, nz = iz + dz;
          if (nx >= 0 && nz >= 0 && nx < s.nx && nz < s.nz && s.grid[nz * s.nx + nx]) continue;
          if (s.y0 + height * s.step < ctx.groundY(x, z) + 0.8) break;
          addWallClump(x + dx * s.cell / 2, z + dz * s.cell / 2, dx, dz);
        }
      }
    }
  }
  const wallGrass = tufts.length - beforeWalls;
  const planted = tufts.length > Gp.cap ? tufts.filter(() => rng() < Gp.cap / tufts.length) : tufts;
  const habitats = paintedSward ? flowerBeds : [];
  const flowerKinds = new Set(SP.flower.models.map(m => m.id));
  const keptTufts = planted.filter(({ kind, x, z }) => !flowerKinds.has(kind) || !habitats.some(({ bounds: [x0, z0, x1, z1], feather }) =>
    x > x0 + feather && x < x1 - feather && z > z0 + feather && z < z1 - feather));
  // The station lawn has a separate seed and leaves the existing island batches intact.
  const stationLawn = dryRun ? null : addStationLawn({
    station,
    bounds: Gp.lawn,
    groundMaterials: paintedSward ? [island.terrain.material, island.transition.material] : [],
    random: rngFrom(hash32(P.seed, 51)),
    heightAt: (x, z) => ctx.groundY(x + ctx.ox, z + ctx.oz) - ctx.oy,
    canGrow: (x, z) => {
      const wx = x + ctx.ox, wz = z + ctx.oz;
      return !island.town.nameAt(wx, wz) && !openReject(wx, wz, ctx.groundY(wx, wz), true);
    },
    shadeAt: (x, z) => smooth(0.31, 0.69, 0.7 * noise2(x, z, 14, P.seed + 17) + 0.3 * noise2(x, z, 4, P.seed + 19)),
    // Broad, oblique patches in station space give the paint a canopy-shadow shape.
    paintAt: (x, z) => {
      const u = x + 0.43 * z, v = z * 0.72;
      const field = 0.74 * noise2(u, v, 13, P.seed + 53)
        + 0.18 * noise2(u, v, 5, P.seed + 59)
        + 0.08 * noise2(u, v * 1.65, 2.8, P.seed + 61);
      return 0.60 * smooth(0.417, 0.5, field) + 0.40 * smooth(0.54, 0.61, field);
    },
  });
  for (const g of keptTufts) push(g.kind, g);
  const beds = plantFlowerBeds(ctx, habitats, SP.grass.models, P.seed);
  const grassBands = plantGrassBands(ctx, habitats, P.seed);
  const meadowSward = plantShortSward(ctx, habitats, P.seed);
  const carpetMaterial = meadowSward.some(a => a.carpet) ? hillsideBladeMaterial(island) : null;
  if (!dryRun) for (const bed of beds) island.meadow.addFlowerBed(bed.name, bed.flowers);

  // ---- batches --------------------------------------------------------------------------------------------------------------------------------------
  let drawCalls = 0, triangles = 0; const counts = {}, lods = [], LP = table.vegetation.lod;
  const grassModels = new Set(SP.grass.models.map(({ id }) => id));
  for (const [kind, list] of Object.entries(items)) {
    const near = LP && model[kind].spec.near ? model[model[kind].spec.near] : null;
    if (near) { const lod = makeTreeLod({ far: model[kind], near, list, params: LP, materials, root, name: 'vegetation-' + kind }); lods.push(lod); drawCalls += lod.drawCalls; triangles += model[kind].tris * list.length; counts[kind] = list.length; continue; }
    const groups = grassModels.has(kind) ? partitionOpaqueInstances(model[kind], list, ISLAND_BATCH_CELL) : [list];
    for (const [index, batch] of groups.entries()) {
      const name = 'vegetation-' + kind + (groups.length > 1 ? '-cell-' + index : '');
      for (const mesh of makeBatches({ name, model: model[kind], materials, items: batch })) { root.add(mesh); drawCalls++; }
    }
    triangles += model[kind].tris * list.length; counts[kind] = list.length;
  }
  // Root grass and the folded blades are visible only in their own habitats, even in reflection views.
  for (const [index, { name, grass }] of grassBands.entries()) {
    const patchItems = {};
    for (const tuft of [...beds[index].grass, ...grass]) (patchItems[tuft.kind] ??= []).push(tuft);
    for (const [kind, list] of Object.entries(patchItems)) {
      const batchName = `vegetation-${name}-${kind}`;
      const batches = meadowSward[index].carpet
        ? [makeBatch({ name: batchName, model: model[kind], material: carpetMaterial, items: list })]
        : makeBatches({ name: batchName, model: model[kind], materials, items: list });
      for (const mesh of batches) {
        // Flower-bed base clumps can still use the existing island grass assets.
        // Only the sculpted Blender tuft variants use this distance tier.
        if (kind === 'meadowFan' || kind === 'meadowSweep') limitInstancedDetailDistance(mesh, MEADOW_DETAIL_DISTANCE);
        root.add(mesh);
      }
      drawCalls += batches.length;
      triangles += model[kind].tris * list.length;
      counts[kind] = (counts[kind] ?? 0) + list.length;
    }
  }
  if (meadowSward.length) {
    const material = shortSwardMaterial(station.ctx.mat.gradientMap, aerial, island.U.uTime);
    for (const { name, carpet, cells } of meadowSward) for (const [key, { kind, items: tiles }] of cells) {
      const mesh = makeBatch({ name: `vegetation-${name}-sward-${key}`, model: model[kind], material: carpet ? carpetMaterial : material, items: tiles });
      limitInstancedDetailDistance(mesh, MEADOW_DETAIL_DISTANCE);
      root.add(mesh);
      drawCalls++;
      triangles += model[kind].tris * tiles.length;
      counts[kind] = (counts[kind] ?? 0) + tiles.length;
    }
  }
  /** Called every frame with the camera; cheap unless the camera moved by `lod.step` m. Returns { near, far } counts of the LOD trees. */
  const update = camera => {
    camera.getWorldPosition(_cam);
    const r = { near: 0, far: 0 }; for (const l of lods) { const c = l.update(_cam); r.near += c.near; r.far += c.far; }
    return r;
  };
  if (!dryRun) scene.add(root);
  const summary = { sizeWarnings: model.warnings, trees: keptTrees.length, streetTrees, bushes: keptBushes.length + hedgeBushes.length, hedges: hedgeCount, hedgeBushes: hedgeBushes.length, grass: keptTufts.length, rootGrass, openGrass: open, edgeGrass: edge, wallGrass, flowers: keptTufts.filter(g => flowerKinds.has(g.kind)).length, thinned, stationLawn,
    flowerBeds: beds.map(({ name, grass, counts }) => ({ name, flowersPerCluster: counts, grass: grass.length })),
    grassBands: grassBands.map(({ name, counts }) => ({ name, tuftsPerBand: counts })),
    meadowSward: meadowSward.map(({ name, cells }) => ({ name, cells: cells.size, tiles: [...cells.values()].reduce((n, c) => n + c.items.length, 0) })) };
  worldBase.scatter = { ...(worldBase.scatter ?? {}), veg: { root, counts, summary, update, lods, materials, drawCalls, triangles, rejects, attempts, ms: +(performance.now() - t0).toFixed(1),
    trees: keptTrees.map(t => ({ kind: t.kind, x: t.x, z: t.z, r: t.r })), bushes: [...keptBushes, ...hedgeBushes].map(t => ({ kind: t.kind, x: t.x, z: t.z, r: t.r })), hedges: items[hk]?.map(h => ({ x: h.x, z: h.z })) ?? [], grass: keptTufts.map(t => ({ x: t.x, z: t.z })) } };
  console.info('[world-base] vegetation', JSON.stringify({ ...summary, drawCalls, triangles, ms: worldBase.scatter.veg.ms }));
  return worldBase.scatter.veg;
}

/**
 * Distance LOD of one far (light) model and its near (v2) model, per instance but without a mesh per tree. A far batch holds its own part of the island;
 * a tree that is near is collapsed there (zero matrix) and written into the near InstancedMesh(es) (capacity `nearMax`, nearest first). The camera
 * is only compared with the cells' boxes first, and nothing is recomputed until it moved `params.step` m. Hysteresis: near at < nearDist, far again at > nearDist + hysteresis.
 */
function makeTreeLod({ far: farModel, near, list, params, materials, root, name }) {
  const cell = params.cell, key = r => Math.floor(r.x / cell) * 4096 + Math.floor(r.z / cell), nearMax = params.nearMax;
  const sorted = [...list].sort((a, b) => key(a) - key(b));
  const groups = partitionOpaqueInstances(farModel, sorted, ISLAND_BATCH_CELL);
  const farSlots = new Map();
  const farMeshes = groups.flatMap((items, index) => {
    const groupName = groups.length > 1 ? `${name}-cell-${index}` : name;
    const meshes = makeBatches({ name: groupName, model: farModel, materials, items });
    const matrices = meshes[0].instanceMatrix.array.slice();
    const colors = meshes[0].instanceColor.array;
    items.forEach((item, slot) => farSlots.set(item, { meshes, matrices, colors, slot }));
    return meshes;
  });
  const dummy = Array.from({ length: nearMax }, () => ({ x: 0, y: 0, z: 0 })), nearMeshes = makeBatches({ name: name + '-near', model: near, materials, items: dummy });
  for (const m of nearMeshes) { m.count = 0; m.frustumCulled = false; }
  for (const m of farMeshes) root.add(m); for (const m of nearMeshes) root.add(m);
  const isNear = new Uint8Array(sorted.length);
  const cells = new Map();
  sorted.forEach((t, i) => { const k = key(t); let c = cells.get(k); if (!c) cells.set(k, (c = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity, idx: [] })); c.idx.push(i); c.minX = Math.min(c.minX, t.x); c.maxX = Math.max(c.maxX, t.x); c.minZ = Math.min(c.minZ, t.z); c.maxZ = Math.max(c.maxZ, t.z); });
  // debug ?lod=near / ?lod=far: force every tree within `nearForceDist` m to v2 (still capped by nearMax), or none
  const lodForce = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('lod');
  const nearDist = lodForce === 'far' ? -1 : lodForce === 'near' ? (params.nearForceDist ?? 400) : params.nearDist;
  const cellList = [...cells.values()], reach = Math.max(0, nearDist + params.hysteresis);
  let lastX = Infinity, lastZ = Infinity, nearCount = 0;
  const update = cam => {
    if (Math.hypot(cam.x - lastX, cam.z - lastZ) < params.step) return { near: nearCount, far: sorted.length - nearCount };
    lastX = cam.x; lastZ = cam.z;
    const cand = [];
    for (const c of cellList) {
      const dx = Math.max(c.minX - cam.x, 0, cam.x - c.maxX), dz = Math.max(c.minZ - cam.z, 0, cam.z - c.maxZ);
      if (dx * dx + dz * dz > reach * reach) continue;
      for (const i of c.idx) { const t = sorted[i], d = Math.hypot(t.x - cam.x, t.z - cam.z); if (d < nearDist || (isNear[i] && d < reach)) cand.push([d, i]); }
    }
    cand.sort((a, b) => a[0] - b[0]); if (cand.length > nearMax) cand.length = nearMax;
    const chosen = new Set(cand.map(c => c[1])), changed = new Set();
    // trees that are no longer near come back, newly near ones are collapsed in the far mesh
    for (const c of cellList) {
      const dx = Math.max(c.minX - cam.x, 0, cam.x - c.maxX), dz = Math.max(c.minZ - cam.z, 0, cam.z - c.maxZ), inReach = dx * dx + dz * dz <= reach * reach;
      for (const i of c.idx) {
        if (!inReach && !isNear[i]) continue;
        const want = chosen.has(i);
        if (want === !!isNear[i]) continue;
        isNear[i] = want ? 1 : 0;
        const { meshes, matrices, slot } = farSlots.get(sorted[i]);
        const start = slot * 16;
        for (const mesh of meshes) {
          const far = mesh.instanceMatrix.array;
          if (want) far.fill(0, start, start + 16);
          else far.set(matrices.subarray(start, start + 16), start);
          changed.add(mesh);
        }
        // Far instance colours are never changed when a tree is hidden.
      }
    }
    for (const mesh of changed) mesh.instanceMatrix.needsUpdate = true;
    // the near meshes: the chosen trees, nearest first
    nearCount = cand.length;
    for (const m of nearMeshes) {
      cand.forEach(([, i], n) => {
        const { matrices, colors, slot } = farSlots.get(sorted[i]);
        m.instanceMatrix.array.set(matrices.subarray(slot * 16, slot * 16 + 16), n * 16);
        m.instanceColor.array.set(colors.subarray(slot * 3, slot * 3 + 3), n * 3);
      });
      m.count = nearCount; m.instanceMatrix.needsUpdate = true; m.instanceColor.needsUpdate = true;
    }
    return { near: nearCount, far: sorted.length - nearCount };
  };
  return { kind: farModel.id, update, drawCalls: farMeshes.length + nearMeshes.length, cells: cellList.length, get nearCount() { return nearCount; }, total: sorted.length, nearMeshes, farMeshes };
}
