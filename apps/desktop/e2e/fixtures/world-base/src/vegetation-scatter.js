import * as THREE from 'three';
import { loadTable, loadModels, pickWeighted, makeMaterial, makeBatch, getAerial, getContext, hash32, rngFrom, fbm, noise2, smooth, focusFalloff } from './scatter-common.js';

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
//   hedges     a hedge row `hedge.offset` m outside the walkable rectangle all round (gaps where a road, a building or water is).
//   grass      `grass.perTree` tufts at every tree foot + open ground within `grass.radius` m of the focus points, patchy.
// Caps (`cap`) thin a class uniformly when the budget (1.5 M triangles, 60 draw calls for props + vegetation) would be exceeded.

export const vegEnabled = () => new URLSearchParams(location.search).get('veg') !== 'off';

export const PARAMS = {
  seed: 2112,
  tree: { cell: 9, density: 0.5, bg: 0.03, far: 0.07, forestScale: 230, forestLo: 0.55, forestHi: 0.7, minH: 1.2, maxSlope: 0.5, coverMin: 0.25, treeline: [170, 300],
    walkMargin: 5, bldMargin: 3, corrMargin: 2, roadMargin: 1.5, townKeep: 0.12, cap: 4200,
    conifer: { slope: 0.3, height: 140, farShare: 0.82 }, cherry: { near: 0.06, byRoad: 0.14, roadReach: 45 } },
  street: { spacing: [9, 13], offset: 1.9, keep: 0.75, minHalfW: 1.8 },
  bush: { share: 0.55, cell: 14, edge: 0.3, base: 0.05, cap: 3500, walkMargin: 2.5 },
  hedge: { offset: 1.4, overlap: 0.92, skip: 0.06 },   // segment spacing = model length x overlap
  grass: { cell: 4, p: 0.2, perTree: 2, cap: 16000, coverMin: 0.45, radius: [[280, 900, 450], [176, -1182, 150]] },
  skipRoads: /:(mole|pier)$/,
};

const _m = new THREE.Matrix4(), _x = new THREE.Vector3(), _y = new THREE.Vector3(0, 1, 0), _z = new THREE.Vector3(), _t = new THREE.Vector3();
const facing = (x, y, z, fx, fz, sx = 1) => { const l = Math.hypot(fx, fz) || 1; fx /= l; fz /= l; return _m.clone().makeBasis(_x.set(fz * sx, 0, -fx * sx), _y, _z.set(fx, 0, fz)).setPosition(_t.set(x, y, z)); };

export async function createVegetation({ scene, worldBase, island, station, dryRun = false }) {
  const t0 = performance.now(), P = PARAMS, T = P.tree, rng = rngFrom(hash32(P.seed, 1));
  const ctx = await getContext({ worldBase, island, station, scene });
  const [aerial, table] = await Promise.all([getAerial(worldBase, island), loadTable()]);
  const model = await loadModels(table.vegetation), SP = table.vegetation.species, kindOf = sp => pickWeighted(rng, SP[sp].models), scaleOf = sp => range(SP[sp].scale);
  const material = makeMaterial({ gradientMap: station.ctx.mat.gradientMap, aerial, name: 'vegetation' });
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
  let hedgeCount = 0; const hk = kindOf('hedge');
  {
    const b = station.bounds, o = station.root.position, H = P.hedge, d = H.offset;
    const x0 = b.x0 + o.x - d, x1 = b.x1 + o.x + d, z0 = b.z0 + o.z - d, z1 = b.z1 + o.z + d;
    const step = model[hk].size[0] * H.overlap;
    const edges = [[x0, z0, x1, z0, 0, -1], [x1, z0, x1, z1, 1, 0], [x1, z1, x0, z1, 0, 1], [x0, z1, x0, z0, -1, 0]]; // from, to, outward normal
    for (const [ax, az, bx, bz, nx, nz] of edges) {
      const len = Math.hypot(bx - ax, bz - az), ux = (bx - ax) / len, uz = (bz - az) / len;
      for (let s = step / 2; s < len - step / 2; s += step) {
        const x = ax + ux * s, z = az + uz * s;
        if (rng() < H.skip) continue;
        const y = ctx.groundY(x, z);
        if (y < T.minH || ctx.isWater(x, z, 1) || ctx.slope(x, z) > 0.8) { bump('hedge-ground'); continue; }
        if (ctx.obstacle(x, z, 1.0, ['walk', 'bld', 'corr', 'prop', 'town'], { corr: 1.5 })) { bump('hedge-blocked'); continue; }
        if (onRoad(x, z, 2.2) || nearProp(x, z, 1.0)) { bump('hedge-road'); continue; }
        push(hk, { matrix: facing(x, y - 0.03, z, nx, nz), ...tint(1, 0.2), hedge: true, x, z, y, r: 1.2 }); hedgeCount++;
      }
    }
  }

  // ---- grass: tuft rings at tree feet + patches of open ground ---------------------------------------------------------------------------------------------
  const Gp = P.grass, tufts = [];
  const tuft = (x, z, hy) => { const s = scaleOf('grass'); tufts.push({ kind: kindOf('grass'), x, y: hy - 0.02, z, yaw: rng() * Math.PI * 2, sx: s, sy: s * (0.8 + rng() * 0.5), sz: s, ...tint(1, 0.35) }); };
  for (const t of [...keptTrees, ...keptBushes]) {
    if (t.street) continue;
    for (let i = 0; i < Gp.perTree; i++) { const a = rng() * Math.PI * 2, d = (t.r ?? 1) * 0.35 + 0.8 + rng() * 1.5, x = t.x + Math.cos(a) * d, z = t.z + Math.sin(a) * d; if (ctx.cover(x, z) > 0.3 && !onRoad(x, z, 0.5)) tuft(x, z, ctx.groundY(x, z)); }
  }
  let open = 0;
  for (const [fx, fz, R] of Gp.radius) for (let gz = fz - R; gz < fz + R; gz += Gp.cell) for (let gx = fx - R; gx < fx + R; gx += Gp.cell) {
    const x = gx + rng() * Gp.cell, z = gz + rng() * Gp.cell;
    if (Math.hypot(x - fx, z - fz) > R) continue;
    if (rng() > Gp.p * (0.25 + noise2(x, z, 22, P.seed + 5) * 1.2) * (1 - smooth(R * 0.6, R, Math.hypot(x - fx, z - fz)) * 0.8)) continue;
    if (island.town.nameAt(x, z)) continue;
    const y = ctx.groundY(x, z);
    if (y < T.minH || ctx.slope(x, z) > 0.6 || ctx.cover(x, z) < Gp.coverMin || ctx.isWater(x, z, 1.5)) { bump('grass-ground'); continue; }
    if (ctx.obstacle(x, z, 0.3, ['walk', 'bld', 'prop', 'town'], { walk: 0.8 })) { bump('grass-blocked'); continue; }
    if (onRoad(x, z, 0.6) || nearProp(x, z, 0.5)) { bump('grass-road'); continue; }
    tuft(x, z, y); open++;
  }
  const keptTufts = tufts.length > Gp.cap ? tufts.filter(() => rng() < Gp.cap / tufts.length) : tufts;
  for (const g of keptTufts) push(g.kind, g);

  // ---- batches --------------------------------------------------------------------------------------------------------------------------------------
  let drawCalls = 0, triangles = 0; const counts = {};
  for (const [kind, list] of Object.entries(items)) {
    const mesh = makeBatch({ name: 'vegetation-' + kind, model: model[kind], material, items: list });
    root.add(mesh); drawCalls++; triangles += model[kind].tris * list.length; counts[kind] = list.length;
  }
  if (!dryRun) scene.add(root);
  const summary = { sizeWarnings: model.warnings, trees: keptTrees.length, streetTrees, bushes: keptBushes.length, hedges: hedgeCount, grass: keptTufts.length, openGrass: open, thinned };
  worldBase.scatter = { ...(worldBase.scatter ?? {}), veg: { root, counts, summary, drawCalls, triangles, rejects, attempts, ms: +(performance.now() - t0).toFixed(1),
    trees: keptTrees.map(t => ({ kind: t.kind, x: t.x, z: t.z, r: t.r })), bushes: keptBushes.map(t => ({ kind: t.kind, x: t.x, z: t.z, r: t.r })), hedges: items[hk]?.map(h => ({ x: h.x, z: h.z })) ?? [], grass: keptTufts.map(t => ({ x: t.x, z: t.z })) } };
  console.info('[world-base] vegetation', JSON.stringify({ ...summary, drawCalls, triangles, ms: worldBase.scatter.veg.ms }));
  return worldBase.scatter.veg;
}
