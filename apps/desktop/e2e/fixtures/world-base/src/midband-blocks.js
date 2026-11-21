import { hash32, rngFrom } from './block-common.js';

// Art round 26 / 26b (#254 X-51): the mid-height transition band between the ~13 m street facades and the ~80 m towers, plus landmark towers.
// This file holds the RULES (where things go); the geometry comes from the real GLBs, built by tower-blocks.js through the same pipeline
// as the r25 towers (same atlas with 17 % evening panes lit, sign atlas, toon + outline materials, camera-distance fog):
//   * mid-rises  assets/blocks-2026-11-20/skyline-tower-midrise-{tank,billboard}.glb (50 x 20 m, 23 m before the vertical stretch, 9 x 5.5 m rooftop
//                panel). r26b: each stands directly BEHIND a facade row (2-4 m of air between the two), stretched in height only to 28-32 m;
//   * landmarks  skyline-tower-landmark-{tank,billboard}.glb (20 x 20 x ~110 m) replace the tower slot that the two main camera views
//                (art-a-street, sample-g-rail) see best: 150-400 m away, inside +-25 degrees of the view direction, least covered by what is in front.
// Parameters: massing.json "blocks.midband". ?midband=off skips all of it and the page is the r25 page again.

export const midbandEnabled = () => new URLSearchParams(location.search).get('midband') !== 'off';
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const DEG = 180 / Math.PI;

// ---- oriented boxes (station-local x / z; yaw convention of frameOf / rotRect: local +z -> world (sin yaw, cos yaw)) -------------------------
/** w x d box centred on (cx, cz), turned by yaw, grown by m on every side. */
export function obb(cx, cz, yaw, w, d, m = 0) {
  const c = Math.cos(yaw), s = Math.sin(yaw), hw = w / 2 + m, hd = d / 2 + m;
  return { cx, cz, c, s, hw, hd, corners: [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(([lx, lz]) => [cx + lx * c + lz * s, cz - lx * s + lz * c]) };
}
/** Separating-axis test: true when the two boxes share any area. */
export function obbOverlap(A, B) {
  for (const P of [A, B]) for (const [ax, az] of [[P.c, -P.s], [P.s, P.c]]) {
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (const [x, z] of A.corners) { const v = x * ax + z * az; a0 = Math.min(a0, v); a1 = Math.max(a1, v); }
    for (const [x, z] of B.corners) { const v = x * ax + z * az; b0 = Math.min(b0, v); b1 = Math.max(b1, v); }
    if (a1 <= b0 || b1 <= a0) return false;
  }
  return true;
}
const aabbOf = B => ({ minX: Math.min(...B.corners.map(p => p[0])), maxX: Math.max(...B.corners.map(p => p[0])), minZ: Math.min(...B.corners.map(p => p[1])), maxZ: Math.max(...B.corners.map(p => p[1])) });
/** Nearest distance from the box outline to the walkable rectangle {x0, x1, z0, z1} (0 when they touch). */
function distToBounds(B, bounds) {
  let best = Infinity;
  for (let i = 0; i < 4; i++) {
    const [ax, az] = B.corners[i], [bx, bz] = B.corners[(i + 1) % 4], n = Math.ceil(Math.hypot(bx - ax, bz - az) / 1.5);
    for (let k = 0; k <= n; k++) {
      const x = ax + (bx - ax) * k / n, z = az + (bz - az) * k / n;
      best = Math.min(best, Math.hypot(Math.max(bounds.x0 - x, 0, x - bounds.x1), Math.max(bounds.z0 - z, 0, z - bounds.z1)));
    }
  }
  return best;
}
/** First distance t >= 0 along the segment (ex, ez) -> (px, pz) at which it enters the box, or null. */
function segmentEntry(B, ex, ez, px, pz) {
  const dx = px - ex, dz = pz - ez, ox = ex - B.cx, oz = ez - B.cz;
  // into the box frame: local x = (c, -s), local z = (s, c)
  const o = [ox * B.c - oz * B.s, ox * B.s + oz * B.c], d = [dx * B.c - dz * B.s, dx * B.s + dz * B.c], h = [B.hw, B.hd];
  let t0 = 0, t1 = 1;
  for (let k = 0; k < 2; k++) {
    if (Math.abs(d[k]) < 1e-9) { if (Math.abs(o[k]) > h[k]) return null; continue; }
    let a = (-h[k] - o[k]) / d[k], b = (h[k] - o[k]) / d[k]; if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a); t1 = Math.min(t1, b); if (t0 > t1) return null;
  }
  return t0 * Math.hypot(dx, dz);
}

/**
 * r26b: the mid-rise lots. Every facade slot of the massing is a row of facade modules (`footprint` wide, 10 m deep, +z = street side). For each one, in
 * a seeded order that takes the facade clusters in turn, a lot is tried straight behind it: the same yaw (so it faces the street like the row does),
 * `backGap` m of air between the back of the row and the front of the block (the facade rows of a cluster are staggered in depth: when another row is in the
 * way the block backs off until it is clear of all of them, at most `pushMax` m; at most `perSlot` blocks per row), shifted sideways by a seeded amount so neighbouring blocks tile. A lot is
 * kept when it is `band[0]..band[1]` m from the walkable area (nearest edge), passes the cluster exclusion tests of massing.js (walkable rectangles, corridors,
 * city / skyline lots, meshes, village, props; oriented-box exact against every facade and tower slot: `backGap` m of air to every facade, `gap` m to towers),
 * keeps `lotGap` m from earlier lots, and stands on dry, gentle ground. Returns extra tower-style slots for createTowerBlocks (world centre) and stats.
 */
export function layoutMidband({ massing, station, params }) {
  const M = params.blocks.midband, o = station.root.position, ox = o.x, oz = o.z, bounds = station.bounds;
  const rng = rngFrom(hash32(params.seed, 26, 2));
  const [FW, FD] = M.footprint, front = FD / 2 + M.frontPad, [CW, CD] = M.clear;
  const boxOf = (s, m) => obb(s.center[0] - ox, s.center[2] - oz, s.yaw, s.footprint[0], s.footprint[1], m);
  const facades = massing.slots.filter(s => s.kind === 'facade');
  const facadeBoxes = facades.map(s => boxOf(s, 0)), towerBoxes = massing.slots.filter(s => s.kind !== 'facade').map(s => boxOf(s, M.gap));
  const lots = [], rejects = {}, perCluster = {};
  const bySlot = {}, bump = (k, id) => { rejects[k] = (rejects[k] ?? 0) + 1; if (id) (bySlot[id] ??= {})[k] = (bySlot[id][k] ?? 0) + 1; };
  // facade clusters in turn, each in a seeded order
  const byCluster = new Map();
  for (const s of facades) { if (!byCluster.has(s.cluster)) byCluster.set(s.cluster, []); byCluster.get(s.cluster).push(s); }
  const queues = [...byCluster.values()].map(list => { const q = list.slice(); for (let i = q.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [q[i], q[j]] = [q[j], q[i]]; } return q; });
  const order = []; for (let k = 0; queues.some(q => k < q.length); k++) for (const q of queues) if (k < q.length) order.push(q[k]);
  const done = new Map(); // facade slot id -> blocks behind it
  const attempt = s => {
    const cx0 = s.center[0] - ox, cz0 = s.center[2] - oz, yaw = s.yaw, f = [Math.sin(yaw), Math.cos(yaw)], t = [Math.cos(yaw), -Math.sin(yaw)];
    const gap = M.backGap[0] + rng() * (M.backGap[1] - M.backGap[0]), span = (s.footprint[0] + FW) / 2 * M.slide, shift = (rng() * 2 - 1) * span;
    // straight behind the row (slot centre -> block centre along -facing); when another facade row (they are staggered) is in the way, the block backs off in
    // half-metre steps until `gap` m of air separate it from every facade, so it stands behind the row group instead of inside it
    let back = s.footprint[1] / 2 + gap + front, cx, cz, lotBox;
    for (let push = 0; ; push += 0.5) {
      cx = cx0 - f[0] * (back + push) + t[0] * shift; cz = cz0 - f[1] * (back + push) + t[1] * shift;
      lotBox = obb(cx, cz, yaw, CW, CD, 0);
      const grown = obb(cx, cz, yaw, CW, CD, gap);
      if (!facadeBoxes.some(b => obbOverlap(grown, b))) { back += push; break; }
      if (push >= M.pushMax) return bump('slots', s.id);
    }
    const rect = aabbOf(obb(cx, cz, yaw, CW + 2, CD + 2, 0));
    const near = distToBounds(lotBox, bounds), centre = Math.hypot(Math.max(bounds.x0 - cx, 0, cx - bounds.x1), Math.max(bounds.z0 - cz, 0, cz - bounds.z1));
    if (near < M.band[0] || near > M.band[1]) return bump('band', s.id);
    const why = massing.rejectReason(rect, { boundsMargin: M.boundsMargin, lotMargin: M.lotMargin });
    if (why) return bump(why, s.id);
    if (towerBoxes.some(b => obbOverlap(lotBox, b))) return bump('towers', s.id);
    if (lots.some(l => obbOverlap(lotBox, obb(l.cx, l.cz, l.yaw, CW, CD, M.lotGap)))) return bump('spacing', s.id);
    const ground = massing.groundStats(cx, cz, CW + 2, CD + 2, yaw, 5);
    if (!ground || ground.min < M.minGround) return bump('ground', s.id);
    if (ground.relief > M.maxRelief) return bump('relief', s.id);
    const height = Math.round((M.height[0] + rng() * (M.height[1] - M.height[0])) * 2) / 2;
    lots.push({ cx, cz, yaw, height, ground, near, centre, shift, gap, pushed: back - (s.footprint[1] / 2 + gap + front), behind: s.id, cluster: s.cluster, face: f, box: lotBox });
    perCluster[s.cluster] = (perCluster[s.cluster] ?? 0) + 1; done.set(s.id, (done.get(s.id) ?? 0) + 1);
    return true;
  };
  for (let round = 0; round < M.tries && lots.length < M.count; round++) {
    for (const s of order) {
      if (lots.length >= M.count) break;
      if ((done.get(s.id) ?? 0) >= M.perSlot) continue;
      attempt(s);
    }
  }
  const slots = lots.map((l, i) => ({
    id: `midrise-${String(i).padStart(2, '0')}`, kind: 'midrise', shape: 'midrise', cluster: 'midband', center: [l.cx + ox, l.ground.max + 0.15, l.cz + oz], yaw: l.yaw,
    footprint: [FW, FD], height: l.height, face: l.face, sign: rng() < M.boardChance, behind: l.behind, boundsDist: +l.near.toFixed(0),
  }));
  const areas = lots.map((l, i) => ({ name: `midband-${i}`, ...aabbOf(obb(l.cx, l.cz, l.yaw, CW + 4, CD + 4)) }));
  const near = lots.map(l => l.near), centres = lots.map(l => l.centre), range = v => v.length ? [+Math.min(...v).toFixed(1), +Math.max(...v).toFixed(1)] : null;
  return {
    slots, areas, stats: {
      wanted: M.count, placed: lots.length, rejects, rejectsBySlot: bySlot, perCluster, facadeSlots: facades.length, behindSlots: done.size,
      nearEdge: range(near), centre: range(centres), height: range(lots.map(l => l.height)), backGap: range(lots.map(l => l.gap)),
    },
  };
}

/**
 * r26b: the tower slots the main camera views see best. `LM.views` = [{ name, frame: 'local' | 'world', eye, target, fov }] (frame: station-local x / z with
 * y above the station origin, or world). A tower slot qualifies for a view when it is `dist` m away horizontally, within `halfAngle` degrees of the view
 * direction and at least `minFootprint` m across. Its score is how many degrees of the landmark (base to `top` m above its ground) are not hidden by
 * something in front of it and lie inside the vertical field of view, averaged over a few rays across its width; `occluders` are the station-local boxes
 * { box (obb), top (world y) } of everything that could stand in the way (facade rows, mid-rises, the other towers). The best qualifying slot of each view
 * (`perView`), at least `minGap` m from the ones already chosen, becomes a landmark. Returns [{ id, view, dist, az, visible, hidden }] (az in degrees).
 */
export function pickLandmarks(slots, o, LM, occluders = []) {
  const ox = o.x, oy = o.y, oz = o.z, out = [], taken = new Set();
  for (const v of LM.views) {
    const eye = v.frame === 'world' ? [v.eye[0] - ox, v.eye[1], v.eye[2] - oz] : [v.eye[0], v.eye[1] + oy, v.eye[2]];
    const tgt = v.frame === 'world' ? [v.target[0] - ox, v.target[1], v.target[2] - oz] : [v.target[0], v.target[1] + oy, v.target[2]];
    const heading = Math.atan2(tgt[2] - eye[2], tgt[0] - eye[0]), pitch = Math.atan2(tgt[1] - eye[1], Math.hypot(tgt[0] - eye[0], tgt[2] - eye[2])) * DEG;
    const fTop = pitch + v.fov / 2, fBot = pitch - v.fov / 2, scored = [];
    for (const s of slots) {
      if (taken.has(s.id) || Math.min(...s.footprint) < LM.minFootprint) continue;
      const sx = s.center[0] - ox, sz = s.center[2] - oz, dx = sx - eye[0], dz = sz - eye[2], dist = Math.hypot(dx, dz);
      if (dist < LM.dist[0] || dist > LM.dist[1]) continue;
      const az = Math.abs(((Math.atan2(dz, dx) - heading) * DEG + 540) % 360 - 180);
      if (az > LM.halfAngle) continue;
      const nx = -dz / dist, nz = dx / dist, base = s.center[1], topY = base + LM.top, half = LM.footprint / 2 - 1;
      let vis = 0, hid = 0;
      const rays = LM.rays;
      for (let k = 0; k < rays; k++) {
        const off = rays === 1 ? 0 : (k / (rays - 1) * 2 - 1) * half, px = sx + nx * off, pz = sz + nz * off, D = Math.hypot(px - eye[0], pz - eye[2]);
        let occ = -90;
        for (const q of occluders) {
          if (q.id === s.id) continue;
          const t = segmentEntry(q.box, eye[0], eye[2], px, pz);
          if (t != null && t > 1 && t < D - 1) occ = Math.max(occ, Math.atan2(q.top - eye[1], t) * DEG);
        }
        const elTop = Math.atan2(topY - eye[1], D) * DEG, elBase = Math.atan2(base - eye[1], D) * DEG;
        vis += Math.max(0, Math.min(elTop, fTop) - Math.max(occ, elBase, fBot));
        hid += Math.max(0, Math.min(occ, elTop) - elBase);
      }
      scored.push({ s, id: s.id, dist, az, visible: vis / rays, hidden: hid / rays });
    }
    scored.sort((a, b) => b.visible - a.visible || a.az - b.az || a.id.localeCompare(b.id));
    let n = 0;
    for (const c of scored) {
      if (n >= LM.perView) break;
      if (c.visible < LM.minVisible) break;
      if (out.some(p => Math.hypot(p.s.center[0] - c.s.center[0], p.s.center[2] - c.s.center[2]) < LM.minGap)) continue;
      out.push({ ...c, view: v.name }); taken.add(c.id); n++;
    }
  }
  return out.map(c => ({ id: c.id, view: c.view, dist: +c.dist.toFixed(0), az: +c.az.toFixed(1), visible: +c.visible.toFixed(1), hidden: +c.hidden.toFixed(1) }));
}
