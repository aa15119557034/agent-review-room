import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { loadTable, loadModels, pickWeighted, makeMaterialSet, makeBatches, getAerial, getContext, hash32, rngFrom } from './scatter-common.js';

// X-51 street props (2026-11-21): island-wide, rule driven; nothing here knows a camera. Models, sizes, origin offsets, radii and all weights live in
// src/props-veg.json ("props"): the rules ask for a GROUP (pole, vending, signStop, ...) and never name a GLB. Wires are generated (wireCount = the pole's attach.offsets).
// ?props=off loads nothing (this file is not even imported) and the page is the one before.
//
// Road data (scatter-common.js getContext): the station layout roads (R1-R6, upstream layout.js) and the street network of Petalwake's three
// settlements (assets/town/sites.json: Larkhaven, Cairnwick, the farms), each as a centreline + half width. The station area is already furnished by
// the upstream modules (POLE_RUNS poles + wires every 26-32 m on every road, VENDING spots, signs, guardrails, bollards), so inside the walkable rectangle
// this pass only fills what upstream does not have at all: hydrants and post boxes at lot seams of the main street. Outside it (the towns) the rules are:
//   poles       every `pole.spacing` m along a street, `pole.offset` m beyond the kerb on one side (the other side / +-3 m along when blocked), pole-a / pole-b
//               by weight; consecutive poles of a run closer than `pole.maxSpan` are joined by wireCount sagging tubes (one merged mesh), from pole to pole at
//               each pole's attach height; the crossarm stands across the road (local x), the wires along it.
//   signs       at every junction, on the arms that lead into it: stop on the minor road, speed / warning / blue elsewhere; at most `sign.perJunction`.
//   frontage    at the two seams (ends) of every lot facing a street, never mid-lot where the door is: vending machine (single or pair), post box or hydrant;
//               at junction corners a hydrant / post box with `corner` probability. All face the street.
//   guardrails  2 m segments `guard.offset` m beyond the kerb wherever the ground drops by > `guard.drop` m within `guard.reach` m (quay edge, bank, terrace),
//               runs shorter than `guard.minRun` segments are dropped; reflector side toward the road.
// Never placed: in water, on another road, on slopes steeper than `maxSlope`, within `clear` of anything the town heightmaps / station colliders /
// buildings already hold, or within `gap` of another prop.

export const propsEnabled = () => new URLSearchParams(location.search).get('props') !== 'off';

export const PARAMS = {
  seed: 2111,
  maxSlope: 0.5,
  gap: 2.2,                          // m between any two props (centres)
  pole: { spacing: [25, 35], offset: 1.1, maxSpan: 42, minSpan: 8, minHalfW: 1.8 },
  sign: { perJunction: 2, setback: 4.5, offset: 1.3 },
  frontage: { offset: 0.95, vending: 0.16, pairShare: 0.35, postbox: 0.16, hydrant: 0.2, corner: 0.3, reach: 14 },
  stationLots: { postbox: 0.18, hydrant: 0.22, seamInset: 0.95, offset: 0.45 },
  guard: { offset: 0.55, reach: 3.2, drop: 1.1, minRun: 3, step: 2 },
  skipRoads: /:(mole|pier)$/,       // jetties: built on piles, not on the heightfield
};

const _m = new THREE.Matrix4(), _x = new THREE.Vector3(), _y = new THREE.Vector3(0, 1, 0), _z = new THREE.Vector3(), _t = new THREE.Vector3();
/** Matrix with +Z toward (fx, fz), x stretched by sx, standing on y. */
const facing = (x, y, z, fx, fz, sx = 1) => { const l = Math.hypot(fx, fz) || 1; fx /= l; fz /= l; return _m.clone().makeBasis(_x.set(fz * sx, 0, -fx * sx), _y, _z.set(fx, 0, fz)).setPosition(_t.set(x, y, z)); };

export async function createStreetProps({ scene, worldBase, island, station, dryRun = false }) {
  const t0 = performance.now(), P = PARAMS, rng = rngFrom(hash32(P.seed, 1));
  const ctx = await getContext({ worldBase, island, station, scene });
  const [aerial, table] = await Promise.all([getAerial(worldBase, island), loadTable()]);
  const model = await loadModels(table.props), GROUPS = table.props.groups, pick = g => pickWeighted(rng, GROUPS[g]), RAD = id => model[id].radius;
  const materials = makeMaterialSet({ gradientMap: station.ctx.mat.gradientMap, aerial, name: 'street-props' }), material = materials.shared;
  const root = new THREE.Group(); root.name = 'street-props';
  const items = {}, all = [], rejects = {};
  const bump = k => { rejects[k] = (rejects[k] ?? 0) + 1; return null; };
  const add = (kind, x, y, z, mat, extra = {}) => { const item = { matrix: mat, tint: 1 }; (items[kind] ??= []).push(item); const r = { kind, x, y, z, r: RAD(kind), item, ...extra }; all.push(r); grid.add(r); return r; };
  const grid = { map: new Map(), add(r) { const k = Math.floor(r.x / 8) + ',' + Math.floor(r.z / 8); (this.map.get(k) ?? this.map.set(k, []).get(k)).push(r); },
    near(x, z, d) { for (let ix = Math.floor((x - d) / 8); ix <= Math.floor((x + d) / 8); ix++) for (let iz = Math.floor((z - d) / 8); iz <= Math.floor((z + d) / 8); iz++) for (const r of this.map.get(ix + ',' + iz) ?? []) if (r.kind !== 'wire' && Math.hypot(x - r.x, z - r.z) < d + r.r) return r; return null; } };

  // surface a prop stands on: a quay / pavement the town heightmap holds at about road level, else the ground
  const surfaceAt = (x, z, ref) => { const t = ctx.townTop(x, z); return t > -1e8 && Math.abs(t - ref) <= 0.7 ? t : ctx.groundY(x, z); };
  /** May something of radius r stand at (x, z) on a street whose surface is ref high? `own` = index of the street it belongs to. */
  const free = (x, z, r, ref, own, what = '') => {
    const y = surfaceAt(x, z, ref);
    if (y < 0.45 || ctx.isWater(x, z, 0.5)) return bump(what + 'water');
    if (Math.abs(y - ref) > 1.2) return bump(what + 'level');
    if (ctx.slope(x, z) > P.maxSlope) return bump(what + 'slope');
    const o = ctx.obstacle(x, z, r + 0.15, ['bld', 'prop', 'town', 'solid'], null, ref); if (o) return bump(what + o.split(':')[0]);
    const rd = ctx.roadDist(x, z, 14, own); if (rd && rd.over < 0.9) return bump(what + 'road');
    if (grid.near(x, z, P.gap)) return bump(what + 'gap');
    return y;
  };
  const roads = ctx.roads.map((r, i) => ({ ...r, i })).filter(r => r.group !== 'station' && !P.skipRoads.test(r.name));
  const rightOf = p => ({ x: -p.tz, z: p.tx }); // normal to the right when walking along the street
  const atRoad = (r, s) => r.pts[Math.max(0, Math.min(r.pts.length - 1, Math.round(s)))];

  // ---- poles + wires ----------------------------------------------------------------------------------------------------------------
  const poleRuns = [];
  for (const r of roads) {
    if (r.halfW < P.pole.minHalfW) continue;
    const side0 = hash32(P.seed, r.i) & 1 ? 1 : -1;
    let s = 4 + rng() * P.pole.spacing[0], run = [];
    while (s < r.length - 3) {
      const p = atRoad(r, s), n = rightOf(p);
      let placed = null;
      search: for (const side of [side0, -side0]) for (const shift of [0, 3, -3]) {
        const q = atRoad(r, s + shift), qn = rightOf(q), d = r.halfW + P.pole.offset;
        const x = q.x + qn.x * side * d, z = q.z + qn.z * side * d, ref = ctx.groundY(q.x, q.z), y = free(x, z, 0.45, ref, r.i, 'pole-');
        if (y !== null) { placed = { x, z, y, tx: q.tx, tz: q.tz, s: s + shift }; break search; }
      }
      if (placed) {
        const k = pick('pole');
        placed.rec = add(k, placed.x, placed.y, placed.z, null, { road: r.name }); placed.kind = k; run.push(placed);
        s = placed.s + P.pole.spacing[0] + rng() * (P.pole.spacing[1] - P.pole.spacing[0]);
      } else { if (run.length > 1) poleRuns.push(run); run = []; s += 6; }
    }
    if (run.length > 1) poleRuns.push(run);
  }
  // pole yaw: along the line (central difference), the transformer side flips with the seed; then the spans
  let wireSpans = 0, wireBlocked = 0; const wireGeoms = [];
  // does any wire of the span (sampled every ~1.5 m) pass through a building footprint box or below a town solid (house, wall, tree)? Then the span is dropped.
  const spanBlocked = curves => {
    for (const curve of curves) for (let k = 1; k < curve.length - 1; k++) {
      const q = curve[k];
      for (let f = 0; f < 1; f += 0.25) { // four samples per segment
        const nq = curve[k + 1], x = q.x + (nq.x - q.x) * f, y = q.y + (nq.y - q.y) * f, z = q.z + (nq.z - q.z) * f;
        if (ctx.rects.hit(x, z, 0.3, ['bld'])) return true;
        if (ctx.townTop(x, z) > y - 0.4) return true;
      }
    }
    return false;
  };
  for (const run of poleRuns) {
    run.forEach((p, i) => {
      const a = run[Math.max(0, i - 1)], b = run[Math.min(run.length - 1, i + 1)];
      let dx = b.x - a.x, dz = b.z - a.z; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l; p.dx = dx; p.dz = dz;
      const flip = rng() < 0.5 ? -1 : 1;
      // local z = line direction, local x = crossarm across the road
      p.rec.item.matrix = facing(p.x, p.y, p.z, dx * flip, dz * flip); p.rec.yaw = Math.atan2(dx * flip, dz * flip);
    });
    for (let i = 0; i + 1 < run.length; i++) {
      const a = run[i], b = run[i + 1], dx = b.x - a.x, dz = b.z - a.z, L = Math.hypot(dx, dz);
      if (L > P.pole.maxSpan || L < P.pole.minSpan) continue;
      const A = model[a.kind].spec.attach, B = model[b.kind].spec.attach;
      if (!A || !B) continue;
      const W = table.props.wire, n = Math.min(A.offsets.length, B.offsets.length), cx = dz / L, cz = -dx / L, curves = [];
      for (let w = 0; w < n; w++) { // wire w hangs from offsets[w] across the road on both poles; parabola sag
        const ya = a.y + A.height, yb = b.y + B.height, curve = [];
        for (let k = 0; k <= W.segments * 4; k++) { const t = k / (W.segments * 4), off = A.offsets[w] + (B.offsets[w] - A.offsets[w]) * t; curve.push(new THREE.Vector3(a.x + dx * t + cx * off, ya + (yb - ya) * t - 4 * W.sagRatio * L * t * (1 - t), a.z + dz * t + cz * off)); }
        curves.push(curve);
      }
      if (spanBlocked(curves)) { wireBlocked++; all.push({ kind: 'wire', blocked: true, x: (a.x + b.x) / 2, z: (a.z + b.z) / 2, y: (a.y + b.y) / 2, r: L / 2, ax: a.x, az: a.z, bx: b.x, bz: b.z, wires: n }); continue; }
      for (const full of curves) {
        const curve = full.filter((_, k) => k % 4 === 0);
        const tube = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(curve), W.segments * 2, W.radius, W.radial, false);
        const nn = tube.attributes.position.count, col = new Float32Array(nn * 3); for (let q = 0; q < nn; q++) col.set(W.color, q * 3);
        tube.deleteAttribute('uv'); tube.setAttribute('color', new THREE.BufferAttribute(col, 3)); wireGeoms.push(tube);
      }
      wireSpans++; all.push({ kind: 'wire', x: (a.x + b.x) / 2, z: (a.z + b.z) / 2, y: (a.y + b.y) / 2, r: L / 2, ax: a.x, az: a.z, bx: b.x, bz: b.z, wires: n });
    }
  }

  // ---- junctions: signs + corner furniture ------------------------------------------------------------------------------------------------
  const junctions = [];
  for (const a of roads) for (const b of roads) {
    if (a.i >= b.i || a.group !== b.group) continue;
    for (let ia = 0; ia < a.pts.length; ia += 2) for (let ib = 0; ib < b.pts.length; ib += 2) {
      const pa = a.pts[ia], pb = b.pts[ib];
      if (Math.abs(pa.x - pb.x) > 2.4 || Math.abs(pa.z - pb.z) > 2.4 || Math.hypot(pa.x - pb.x, pa.z - pb.z) > 2.2) continue;
      let j = junctions.find(q => Math.hypot(q.x - pa.x, q.z - pa.z) < 10);
      if (!j) junctions.push(j = { x: pa.x, z: pa.z, arms: new Map() });
      j.arms.set(a.i, ia); j.arms.set(b.i, ib);
    }
  }
    let signs = 0, corners = 0;
  for (const j of junctions) {
    const arms = [];
    for (const [ri, idx] of j.arms) { const r = ctx.roads[ri]; for (const dir of [-1, 1]) { const k = idx + dir * 10; if (k < 0 || k >= r.pts.length) continue; const q = r.pts[k], l = Math.hypot(q.x - j.x, q.z - j.z) || 1; arms.push({ r, ri, dx: (q.x - j.x) / l, dz: (q.z - j.z) / l }); } }
    const widest = Math.max(...[...j.arms.keys()].map(ri => ctx.roads[ri].halfW));
    arms.sort((a, b) => a.r.halfW - b.r.halfW);
    let n = 0;
    for (const arm of arms) {
      if (n >= P.sign.perJunction || P.skipRoads.test(arm.r.name)) continue;
      const side = rng() < 0.5 ? 1 : -1, back = widest + P.sign.setback, lat = arm.r.halfW + P.sign.offset;
      const x = j.x + arm.dx * back - arm.dz * side * lat, z = j.z + arm.dz * back + arm.dx * side * lat, ref = ctx.groundY(j.x, j.z), y = free(x, z, 0.35, ref, arm.ri, 'sign-');
      if (y === null) continue;
      const kind = pick(arm.r.halfW < widest - 0.3 ? 'signStop' : 'signGeneral');
      add(kind, x, y, z, facing(x, y, z, arm.dx, arm.dz), { road: arm.r.name }); signs++; n++;
    }
    // a corner piece: hydrant or post box on the far side of the first arm
    if (rng() < P.frontage.corner && arms.length) {
      const arm = arms[arms.length - 1], back = widest + 2.2, lat = arm.r.halfW + P.frontage.offset, x = j.x + arm.dx * back + arm.dz * lat, z = j.z + arm.dz * back - arm.dx * lat;
      const kind = pick(rng() < 0.5 ? 'hydrant' : 'postbox'), ref = ctx.groundY(j.x, j.z), y = free(x, z, RAD(kind), ref, arm.ri, 'corner-');
      if (y !== null) { add(kind, x, y, z, facing(x, y, z, -arm.dz, arm.dx), { road: arm.r.name }); corners++; }
    }
  }

  // ---- frontage of the towns' lots ---------------------------------------------------------------------------------------------------------------
  let frontage = 0;
  const FR = P.frontage;
  for (const lot of ctx.lots) {
    let cx = 0, cz = 0; for (const [x, z] of lot.pts) { cx += x / lot.pts.length; cz += z / lot.pts.length; }
    const rd = ctx.roadDist(cx, cz, 40); if (!rd || P.skipRoads.test(ctx.roads[rd.road].name) || ctx.roads[rd.road].group === 'station') continue;
    const r = ctx.roads[rd.road]; if (rd.over > FR.reach + 6) continue;
    const q = r.pts[rd.idx], n0 = rightOf(q), toLot = ((cx - q.x) * n0.x + (cz - q.z) * n0.z) >= 0 ? 1 : -1;
    let tmin = Infinity, tmax = -Infinity; for (const [x, z] of lot.pts) { const t = (x - q.x) * q.tx + (z - q.z) * q.tz; tmin = Math.min(tmin, t); tmax = Math.max(tmax, t); }
    if (tmax - tmin < 3.5) continue;
    const h = hash32(P.seed, lot.id.length, lot.id.charCodeAt(2) | 0, lot.id.charCodeAt(lot.id.length - 1) | 0, Math.round(cx), Math.round(cz));
    [tmin + FR.offset, tmax - FR.offset].forEach((t, side) => {
      const v = (hash32(h, side) % 1000) / 1000, pq = atRoad(r, rd.idx + t), pn = rightOf(pq), d = r.halfW + FR.offset;
      const x = pq.x + pn.x * toLot * d, z = pq.z + pn.z * toLot * d, ref = ctx.groundY(pq.x, pq.z);
      const group = v < FR.vending ? 'vending' : v < FR.vending + FR.postbox ? 'postbox' : v < FR.vending + FR.postbox + FR.hydrant ? 'hydrant' : null;
      if (!group) return;
      const kind = pick(group), y = free(x, z, RAD(kind), ref, rd.road, 'front-'); if (y === null) return;
      const fx = -pn.x * toLot, fz = -pn.z * toLot;
      add(kind, x, y, z, facing(x, y, z, fx, fz), { road: r.name, lot: lot.id }); frontage++;
      if (group === 'vending' && (hash32(h, side, 3) % 1000) / 1000 < FR.pairShare) { // a pair: the second one next to the first, along the street
        const x2 = x + pq.tx * 1.05 * (side ? -1 : 1), z2 = z + pq.tz * 1.05 * (side ? -1 : 1), kind2 = pick('vending'), y2 = free(x2, z2, RAD(kind2), ref, rd.road, 'front-');
        if (y2 !== null) { add(kind2, x2, y2, z2, facing(x2, y2, z2, fx, fz), { road: r.name, lot: lot.id, pair: true }); frontage++; }
      }
    });
  }

  // ---- the station's own main street: only what upstream does not build (hydrants, post boxes), at lot seams -----------------------------------------
  let stationItems = 0;
  {
    const L = ctx.layout, S = P.stationLots, phys = station.ctx.physics;
    const spots = L.VENDING.map(v => [v.x + ctx.ox, v.z + ctx.oz]);
    for (const lot of L.LOTS) {
      const f = L.lotFrame(lot), h = hash32(P.seed, 9, lot.z0 * 10, lot.side + 2);
      [-1, 1].forEach((sgn, k) => {
        const v = (hash32(h, k) % 1000) / 1000, group = v < S.hydrant ? 'hydrant' : v < S.hydrant + S.postbox ? 'postbox' : null;
        if (!group) return;
        const kind = pick(group);
        const w = L.lotToWorld(lot, sgn * (f.w / 2 - S.seamInset), S.offset), x = w.x + ctx.ox, z = w.z + ctx.oz;
        const ly = phys.groundHeight(w.x, w.z, L.heightAt(w.x, w.z) + 0.6) + ctx.oy;
        if (spots.some(([sx, sz]) => Math.hypot(sx - x, sz - z) < 2.2)) return bump('station-vending');
        if (ctx.obstacle(x, z, RAD(kind) + 0.35, ['bld', 'solid'], null, ly)) return bump('station-obstacle');
        if (grid.near(x, z, P.gap)) return bump('station-gap');
        if (Math.abs(ly - (ctx.oy + L.heightAt(w.x, w.z))) > 0.3) return bump('station-level');
        add(kind, x, ly - 0.01, z, facing(x, ly - 0.01, z, Math.sin(f.rotY), Math.cos(f.rotY)), { road: 'R1', lot: lot.id, station: true }); stationItems++;
      });
    }
  }

  // ---- guardrails: where the ground drops away beside a street -----------------------------------------------------------------------------------------
  let guardSegs = 0;
  const G = P.guard;
  for (const r of roads) {
    if (r.halfW < 1.4 || r.length < 8) continue;
    for (const side of [-1, 1]) {
      let run = [];
      const flush = () => { if (run.length >= G.minRun) for (const g of run) { const gk = pick('guardrail'); add(gk, g.x, g.y, g.z, facing(g.x, g.y, g.z, g.fx, g.fz, g.len / model[gk].size[0]), { road: r.name }); guardSegs++; } run = []; };
      for (let s = 1; s + G.step < r.length; s += G.step) {
        const a = atRoad(r, s), b = atRoad(r, s + G.step), na = rightOf(a), nb = rightOf(b), d = r.halfW + G.offset;
        const ax = a.x + na.x * side * d, az = a.z + na.z * side * d, bx = b.x + nb.x * side * d, bz = b.z + nb.z * side * d, mx = (ax + bx) / 2, mz = (az + bz) / 2;
        const ref = ctx.groundY(a.x, a.z), y = surfaceAt(mx, mz, ref);
        const ox = mx + (na.x + nb.x) / 2 * side * G.reach, oz = mz + (na.z + nb.z) / 2 * side * G.reach;
        const yo = surfaceAt(ox, oz, ref), drops = y - yo > G.drop || (ctx.isWater(ox, oz, 0.3) && y > 0.45);
        const rd = ctx.roadDist(mx, mz, 12, r.i), clear = !ctx.obstacle(mx, mz, 0.6, ['bld', 'prop', 'town'], null, ref) && !(rd && rd.over < 1.4) && y > 0.45 && Math.abs(y - ref) < 1.5 && !grid.near(mx, mz, 0.6);
        if (drops && clear) run.push({ x: mx, y, z: mz, fx: -(na.x + nb.x) / 2 * side, fz: -(na.z + nb.z) / 2 * side, len: Math.hypot(bx - ax, bz - az) }); else flush();
      }
      flush();
    }
  }

  // ---- batches -----------------------------------------------------------------------------------------------------------------------------------
  let drawCalls = 0, triangles = 0; const counts = {};
  for (const [kind, list] of Object.entries(items)) {
    for (const mesh of makeBatches({ name: 'street-props-' + kind, model: model[kind], materials, items: list })) { root.add(mesh); drawCalls++; } triangles += model[kind].tris * list.length; counts[kind] = list.length;
  }
  let wireTris = 0;
  if (wireGeoms.length) {
    const geometry = mergeGeometries(wireGeoms, false); geometry.computeBoundingSphere();
    const wires = new THREE.Mesh(geometry, material); wires.name = 'street-props-wires'; wires.frustumCulled = true; wires.userData.walkable = false;
    root.add(wires); drawCalls++; wireTris = geometry.index.count / 3; triangles += wireTris; counts.wireTubes = wireGeoms.length;
  }
  if (!dryRun) scene.add(root);
  const sum = group => GROUPS[group].reduce((n, e) => n + (counts[e.id] ?? 0), 0);
  const summary = { poles: sum('pole'), wireSpans, wireBlocked, wireTubes: wireGeoms.length, signs, corners, frontage, station: stationItems, guardrails: guardSegs,
    vending: sum('vending'), postboxes: sum('postbox'), hydrants: sum('hydrant'), sizeWarnings: model.warnings };
  worldBase.scatter = { ...(worldBase.scatter ?? {}), props: { root, counts, summary, drawCalls, triangles, wireTris, items: all, junctions: junctions.length, rejects, runs: poleRuns.length, ms: +(performance.now() - t0).toFixed(1), contextStats: ctx.stats } };
  console.info('[world-base] street props', JSON.stringify({ ...summary, drawCalls, triangles, ms: worldBase.scatter.props.ms }));
  return worldBase.scatter.props;
}
