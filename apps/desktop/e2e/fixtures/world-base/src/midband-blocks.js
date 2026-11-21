import { streetCenterX } from '../upstream/sakuragaoka/src/world/layout.js';
import { hash32, rngFrom, rotRect } from './block-common.js';

// Art round 26 (#254 X-51): the mid-height transition band between the ~13 m street facades and the ~80 m towers, plus landmark towers.
// This file holds the RULES (where things go); the geometry comes from the real GLBs, built by tower-blocks.js through the same pipeline
// as the r25 towers (same atlas with 17 % evening panes lit, sign atlas, toon + outline materials, camera-distance fog):
//   * mid-rises  assets/blocks-2026-11-20/skyline-tower-midrise-{tank,billboard}.glb (50 x 20 x 23 m, 9 x 5.5 m rooftop panel), laid out
//                here as extra slots in a ring 60-150 m outside the walkable station area, over whatever free ground massing.js leaves
//                (the same exclusion tests as the facade / tower clusters; no hand-placed shots);
//   * landmarks  skyline-tower-landmark-{tank,billboard}.glb (20 x 20 x ~110 m) replace the 1-2 tower slots best seen from the main street.
// Parameters: massing.json "blocks.midband". ?midband=off skips all of it and the page is the r25 page again.

export const midbandEnabled = () => new URLSearchParams(location.search).get('midband') !== 'off';
const overlap = (a, b) => a.minX < b.maxX && a.maxX > b.minX && a.minZ < b.maxZ && a.maxZ > b.minZ;
const grow = (r, m) => ({ minX: r.minX - m, maxX: r.maxX + m, minZ: r.minZ - m, maxZ: r.maxZ + m });
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Lots for the ring. A lot (w x d, seeded) is kept when it is `band[0]..band[1]` m from the walkable area (station.bounds), passes the same
 * exclusion tests as the massing clusters (walkable rects, corridors, city / skyline lots, meshes, village, props), keeps `gap` from every
 * slot and earlier lot, stands on dry, gentle ground, and faces the street along the nearest grid axis. The ring is filled sector by
 * sector (quota first, then whatever is left) so it surrounds the street instead of clumping. Returns extra tower-style slots for
 * createTowerBlocks (world centre, like massing slots) and stats.
 */
export function layoutMidband({ massing, station, params }) {
  const M = params.blocks.midband, o = station.root.position, ox = o.x, oz = o.z, bounds = station.bounds;
  const rng = rngFrom(hash32(params.seed, 26, 1));
  const obstacles = massing.slots.map(s => grow(rotRect(s.center[0] - ox, s.center[2] - oz, s.yaw, s.footprint[0], s.footprint[1]), M.gap));
  const sectors = M.sectors, quota = Math.ceil(M.count / sectors), perSector = new Array(sectors).fill(0), lots = [], rejects = {};
  const bump = k => { rejects[k] = (rejects[k] ?? 0) + 1; };
  const [x0, z0, x1, z1] = M.region;
  for (let attempt = 0; attempt < M.attempts && lots.length < M.count; attempt++) {
    const cx = x0 + rng() * (x1 - x0), cz = z0 + rng() * (z1 - z0);
    const w = Math.round((M.width[0] + rng() * (M.width[1] - M.width[0])) / 2) * 2, d = Math.round(M.depth[0] + rng() * (M.depth[1] - M.depth[0])), height = Math.round((M.height[0] + rng() * (M.height[1] - M.height[0])) * 2) / 2;
    const boundsDist = Math.hypot(Math.max(bounds.x0 - cx, 0, cx - bounds.x1), Math.max(bounds.z0 - cz, 0, cz - bounds.z1));
    if (boundsDist < M.band[0] || boundsDist > M.band[1]) { bump('band'); continue; }
    const sector = Math.floor(((Math.atan2(cz - M.ring[1], cx - M.ring[0]) / (Math.PI * 2) + 1) % 1) * sectors);
    if (perSector[sector] >= quota && attempt < M.attempts * 0.6) { bump('sector'); continue; }
    // face the street: direction to the nearest street sample, snapped to a grid axis (the GLB front is +z)
    let best = null;
    for (let z = 1; z <= 130; z += 3) { const sx = streetCenterX(z), dist = Math.hypot(cx - sx, cz - z); if (!best || dist < best.dist) best = { dist, dx: sx - cx, dz: z - cz }; }
    const yaw = Math.abs(best.dx) > Math.abs(best.dz) ? (best.dx > 0 ? Math.PI / 2 : -Math.PI / 2) : (best.dz > 0 ? 0 : Math.PI);
    const rect = rotRect(cx, cz, yaw, w + 2, d + 2);
    const why = massing.rejectReason(rect, { boundsMargin: M.boundsMargin, lotMargin: M.lotMargin });
    if (why) { bump(why); continue; }
    if (obstacles.some(a => overlap(rect, a)) || lots.some(l => overlap(rect, grow(l.rect, M.gap)))) { bump('spacing'); continue; }
    const ground = massing.groundStats(cx, cz, w + 2, d + 2, yaw, 5);
    if (!ground || ground.min < M.minGround) { bump('ground'); continue; }
    if (ground.relief > M.maxRelief) { bump('relief'); continue; }
    lots.push({ cx, cz, w, d, yaw, height, rect, ground, sector, boundsDist, face: [Math.sin(yaw), Math.cos(yaw)] });
    perSector[sector]++;
  }
  const slots = lots.map((l, i) => ({
    id: `midrise-${String(i).padStart(2, '0')}`, kind: 'midrise', shape: 'midrise', cluster: 'midband', center: [l.cx + ox, l.ground.max + 0.15, l.cz + oz], yaw: l.yaw,
    footprint: [l.w, l.d], height: l.height, face: l.face, sign: rng() < M.boardChance, sector: l.sector, boundsDist: +l.boundsDist.toFixed(0),
  }));
  const areas = lots.map((l, i) => ({ name: `midband-${i}`, ...rotRect(l.cx, l.cz, l.yaw, l.w + 4, l.d + 4) }));
  return { slots, areas, stats: { wanted: M.count, placed: lots.length, rejects, perSector } };
}

/**
 * The tower slots best seen from the main street (inside `halfAngle` degrees of the view direction from many street points, `dist` m away,
 * footprint at least `minFootprint`), at least `minGap` metres apart: these become the landmark towers. Station-local coordinates.
 */
export function pickLandmarks(slots, ox, oz, LM) {
  const eyes = []; for (let z = LM.eyes[0]; z <= LM.eyes[1]; z += LM.eyes[2]) eyes.push([streetCenterX(z), z]);
  const scored = [];
  for (const s of slots) {
    if (Math.min(...s.footprint) < LM.minFootprint) continue;
    const sx = s.center[0] - ox, sz = s.center[2] - oz; let vis = 0;
    for (const [ex, ez] of eyes) {
      const dx = sx - ex, dz = sz - ez, dist = Math.hypot(dx, dz);
      if (dist < LM.dist[0] || dist > LM.dist[1]) continue;
      const ang = Math.acos(clamp((dx * LM.view[0] + dz * LM.view[1]) / dist, -1, 1)) * 180 / Math.PI;
      if (ang <= LM.halfAngle) vis += 1 - 0.5 * ang / LM.halfAngle;
    }
    if (vis > 0) scored.push({ s, score: vis / eyes.length });
  }
  scored.sort((a, b) => b.score - a.score || a.s.id.localeCompare(b.s.id));
  const out = [];
  for (const c of scored) {
    if (out.length >= LM.count) break;
    if (out.every(p => Math.hypot(p.s.center[0] - c.s.center[0], p.s.center[2] - c.s.center[2]) >= LM.minGap)) out.push(c);
  }
  return out.map(c => ({ id: c.s.id, score: +c.score.toFixed(3) }));
}
