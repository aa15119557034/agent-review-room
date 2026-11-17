import * as THREE from 'three';
import { UTIL, uvOf } from '../upstream/sakuragaoka/src/world/street/textures.js';

export function createTownPaving(ctx, materials) {
  function mapped(key, roughness, options = {}) {
    const map = ctx.tex.cache.get(key);
    if (!map) throw new Error('Missing station paving texture ' + key);
    const material = new THREE.MeshStandardMaterial({ map, roughness, vertexColors: true, ...options });
    material.name = 'town-' + key;
    materials.add(material);
    return material;
  }
  return {
    bricks: mapped('st-pavers', 0.86, { bumpMap: ctx.tex.cache.get('st-pavers'), bumpScale: 0.012 }),
    asphalt: mapped('st-asphalt', 0.92),
    curb: mapped('st-curb', 0.88),
    gutter: mapped('st-lgutter', 0.74),
    utilities: mapped('st-util', 0.78, { transparent: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -1 }),
  };
}

// Interpolate on the same two triangles per cell as the lane. A manhole or
// long curb follows the visible stepped terrain even across a CDLOD cell edge.
function roadSurface(road, ground) {
  const nx = Math.ceil(road.maxX - road.minX), nz = Math.ceil(road.maxZ - road.minZ);
  const dx = (road.maxX - road.minX) / nx, dz = (road.maxZ - road.minZ) / nz;
  const levels = Array.from({ length: nz + 1 }, (_, j) => Array.from({ length: nx + 1 },
    (_, i) => ground(road.minX + i * dx, road.minZ + j * dz) + 0.06));
  return (x, z) => {
    const u = (x - road.minX) / dx, v = (z - road.minZ) / dz;
    const i = Math.min(nx - 1, Math.max(0, Math.floor(u))), j = Math.min(nz - 1, Math.max(0, Math.floor(v)));
    const a = u - i, b = v - j;
    return a + b <= 1 ? levels[j][i] * (1 - a - b) + levels[j][i + 1] * a + levels[j + 1][i] * b
      : levels[j + 1][i + 1] * (a + b - 1) + levels[j + 1][i] * (1 - a) + levels[j][i + 1] * (1 - b);
  };
}

export function finishTownLanes(H, frame, placements, roads, ground) {
  const start = H.gb.tris, [front, east] = roads, surfaces = roads.map(road => roadSurface(road, ground));
  const counts = { curbStones: 0, grates: 0, covers: 0, repairs: 0 };
  const matrix = frame.M(0, 0, 0), noShadow = { shadow: false };
  function patch(material, shade, x, z, w, d, surface, lift, uv) {
    const nx = Math.ceil(w / 0.5), nz = Math.ceil(d / 0.5);
    const p = [], n = [], t = [], indices = [];
    for (let j = 0; j <= nz; j++) for (let i = 0; i <= nx; i++) {
      const a = i / nx, b = j / nz, xx = x + (a - 0.5) * w, zz = z + (b - 0.5) * d;
      p.push(xx, surface(xx, zz) + lift, zz); n.push(0, 1, 0); t.push(...uv(a, b));
      if (i < nx && j < nz) { const k = j * (nx + 1) + i, c = k + nx + 1; indices.push(k, c, k + 1, k + 1, c, c + 1); }
    }
    H.gb.mesh(material, shade, p, n, t, indices, matrix, noShadow);
  }
  function decal(road, cell, x, z, w, d) {
    patch(H.paving.utilities, '#ffffff', x, z, w, d, surfaces[road], 0.012, (u, v) => uvOf(cell, u, 1 - v));
  }
  const drainZ = front.minZ + 0.25;
  patch(H.paving.gutter, '#e3dfd4', (front.minX + front.maxX) / 2, drainZ, front.maxX - front.minX, 0.30,
    surfaces[0], 0.005, (u, v) => [u * (front.maxX - front.minX) / 2, v]);
  patch(H.paving.gutter, '#e3dfd4', east.maxX - 0.18, (east.minZ + east.maxZ) / 2, 0.32, east.maxZ - east.minZ,
    surfaces[1], 0.005, (u, v) => [v * (east.maxZ - east.minZ) / 2, u]);
  // Drop the curb at each stair landing. Segmented tops catch the light from
  // eye height while the grates and gutters sit below them.
  for (let x = front.minX + 0.39; x < front.maxX - 0.38; x += 0.78) {
    if (placements.some(p => Math.abs(x - (p.center[0] + (p.model?.entrances[0]?.x || 0))) < 1.6)) continue;
    const z = front.minZ + 0.08, y = surfaces[0](x, z);
    const rise = Math.atan2(surfaces[0](x + 0.38, z) - surfaces[0](x - 0.38, z), 0.76);
    frame.box(H.paving.curb, '#ddd8c9', 0.766, 0.080, 0.15, x, y + 0.045, z,
      { ...noShadow, rz: rise, uv: { world: 1.20 } });
    counts.curbStones++;
  }
  for (const x of [-49.5, -38.8, -24, -11, 0, 12, 25, 34.4]) { decal(0, UTIL.drain, x, drainZ, 0.49, 0.26); counts.grates++; }
  for (const z of [-113.5, -105.2]) { decal(1, UTIL.drain, east.maxX - 0.18, z, 0.26, 0.5); counts.grates++; }
  for (const [road, cell, x, z, w, d] of [
    [0, UTIL.manholeB, -20.1, -117.06, 0.72, 0.72], [0, UTIL.manholeC, 4.4, -117.0, 0.72, 0.72],
    [0, UTIL.valveS, 0.65, -117.92, 0.3, 0.3], [1, UTIL.manholeC, 34.8, -110.5, 0.72, 0.72],
  ]) { decal(road, cell, x, z, w, d); counts.covers++; }
  for (const [road, cell, x, z, w, d] of [
    [0, UTIL.patchC, -36.3, -116.7, 2.3, 0.86], [0, UTIL.stain, -15.1, -117.65, 1.9, 0.7],
    [0, UTIL.trench, -2.3, -117.16, 0.34, 2.15], [0, UTIL.oilB, 6.9, -116.6, 0.85, 0.65],
    [0, UTIL.seal, 16.8, -117.15, 0.3, 1.7], [1, UTIL.patchB, 35.25, -106.8, 1.65, 1.3],
  ]) { decal(road, cell, x, z, w, d); counts.repairs++; }
  return { ...counts, triangles: H.gb.tris - start };
}
