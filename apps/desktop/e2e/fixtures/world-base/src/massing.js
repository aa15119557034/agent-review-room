import * as THREE from 'three';
import { streetCenterX } from '../upstream/sakuragaoka/src/world/layout.js';

// Art round 23 (#254 X-51): placeholder massing for the far skyline (tower) and the main-street densification (facade).
// Procedural, seeded (no Math.random), merged per cluster into one toon wall mesh + one unlit window mesh. Every block is a
// SLOT: { id, kind, cluster, center:[x,y,z] world (footprint centre at the floor level), yaw, footprint:[w,d], height }. The real
// building modules replace a slot with massing.replaceSlot(id, object3d) (or just massing.removeSlot(id) to hide the block).
// ?massing=off installs nothing. Parameters: massing.json.

export const massingEnabled = () => new URLSearchParams(location.search).get('massing') !== 'off';
export async function loadMassing() { return (await fetch(new URL('./massing.json', import.meta.url))).json(); }

function rngFrom(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const hash32 = (...values) => { let h = 2166136261; for (const v of values) { h ^= (v | 0) + 0x9e3779b9 + (h << 6) + (h >>> 2); h = Math.imul(h, 16777619); } return h >>> 0; };
const pick = (rng, list) => list[Math.floor(rng() * list.length) % list.length];
const range = (rng, [a, b]) => a + (b - a) * rng();
const rectsOverlap = (a, b) => a.minX < b.maxX && a.maxX > b.minX && a.minZ < b.maxZ && a.maxZ > b.minZ;
const grow = (r, m) => ({ minX: r.minX - m, maxX: r.maxX + m, minZ: r.minZ - m, maxZ: r.maxZ + m });
const color = hex => new THREE.Color(hex);

/** Growing indexed triangle soup: position / normal / colour / index. */
class Part {
  constructor() { this.pos = []; this.nrm = []; this.col = []; this.idx = []; }
  quad(p0, p1, p2, p3, n, c) {
    const base = this.pos.length / 3;
    this.pos.push(...p0, ...p1, ...p2, ...p3);
    for (let i = 0; i < 4; i++) { this.nrm.push(n[0], n[1], n[2]); this.col.push(c.r, c.g, c.b); }
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  tri(p0, p1, p2, n, c) {
    const base = this.pos.length / 3;
    this.pos.push(...p0, ...p1, ...p2);
    for (let i = 0; i < 3; i++) { this.nrm.push(n[0], n[1], n[2]); this.col.push(c.r, c.g, c.b); }
    this.idx.push(base, base + 1, base + 2);
  }
  get triangles() { return this.idx.length / 3; }
  freeze() {
    return { pos: new Float32Array(this.pos), nrm: new Float32Array(this.nrm), col: new Float32Array(this.col),
      idx: new Uint32Array(this.idx) };
  }
}

/** Concatenate frozen parts into one BufferGeometry. */
function mergeParts(parts) {
  let v = 0, i = 0;
  for (const p of parts) { v += p.pos.length / 3; i += p.idx.length; }
  const pos = new Float32Array(v * 3), nrm = new Float32Array(v * 3), col = new Float32Array(v * 3), idx = new Uint32Array(i);
  let vo = 0, io = 0;
  for (const p of parts) {
    pos.set(p.pos, vo * 3); nrm.set(p.nrm, vo * 3); col.set(p.col, vo * 3);
    for (let k = 0; k < p.idx.length; k++) idx[io + k] = p.idx[k] + vo;
    vo += p.pos.length / 3; io += p.idx.length;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeBoundingSphere(); g.computeBoundingBox();
  return g;
}

const FACES = [[0, 1], [1, 0], [0, -1], [-1, 0]]; // outward normals (x, z) in block-local axes

/** Block-local -> world helper. yaw is three.js rotation.y. */
function frameOf(cx, cz, yaw) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return {
    p: (lx, y, lz) => [cx + lx * c + lz * s, y, cz - lx * s + lz * c],
    n: (nx, nz) => [nx * c + nz * s, 0, -nx * s + nz * c],
  };
}

/** Box with four side faces and a roof (the underside is never seen). */
function addBox(wall, F, o, y0, y1, w, d, side, roof) {
  const hw = w / 2, hd = d / 2;
  for (const [nx, nz] of FACES) {
    const half = nx ? hw : hd, ht = nx ? hd : hw;
    const tx = nz, tz = -nx;
    const fx = o[0] + nx * half, fz = o[1] + nz * half;
    wall.quad(F.p(fx - tx * ht, y0, fz - tz * ht), F.p(fx + tx * ht, y0, fz + tz * ht),
      F.p(fx + tx * ht, y1, fz + tz * ht), F.p(fx - tx * ht, y1, fz - tz * ht), F.n(nx, nz), side);
  }
  wall.quad(F.p(o[0] - hw, y1, o[1] + hd), F.p(o[0] + hw, y1, o[1] + hd), F.p(o[0] + hw, y1, o[1] - hd), F.p(o[0] - hw, y1, o[1] - hd), [0, 1, 0], roof ?? side);
}

/** Low-poly cylinder (flat sides + cap), for the water tanks. */
function addPrism(wall, F, o, y0, y1, r, seg, side, cap) {
  for (let i = 0; i < seg; i++) {
    const a0 = i / seg * Math.PI * 2, a1 = (i + 1) / seg * Math.PI * 2, am = (a0 + a1) / 2;
    const x0 = o[0] + Math.cos(a0) * r, z0 = o[1] + Math.sin(a0) * r, x1 = o[0] + Math.cos(a1) * r, z1 = o[1] + Math.sin(a1) * r;
    wall.quad(F.p(x1, y0, z1), F.p(x0, y0, z0), F.p(x0, y1, z0), F.p(x1, y1, z1), F.n(Math.cos(am), Math.sin(am)), side);
    wall.tri(F.p(o[0], y1, o[1]), F.p(x1, y1, z1), F.p(x0, y1, z0), [0, 1, 0], cap);
  }
}

/** Window quad on a vertical face. t = along-face unit (x, z) in block-local axes. */
function addPane(win, F, face, along, ycentre, pw, ph, off, c) {
  const [nx, nz] = face.n, tx = nz, tz = -nx;
  const cx = face.o[0] + nx * (face.half + off) + tx * along, cz = face.o[1] + nz * (face.half + off) + tz * along;
  win.quad(F.p(cx - tx * pw / 2, ycentre - ph / 2, cz - tz * pw / 2), F.p(cx + tx * pw / 2, ycentre - ph / 2, cz + tz * pw / 2),
    F.p(cx + tx * pw / 2, ycentre + ph / 2, cz + tz * pw / 2), F.p(cx - tx * pw / 2, ycentre + ph / 2, cz - tz * pw / 2), F.n(nx, nz), c);
}

/** Terrain statistics under a (rotated) footprint: min / max over an n x n grid plus the rim. */
function terrainStats(heightAt, cx, cz, w, d, yaw, n = 5) {
  const F = frameOf(cx, cz, yaw);
  let min = Infinity, max = -Infinity;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const [x, , z] = F.p((i / (n - 1) - 0.5) * w, 0, (j / (n - 1) - 0.5) * d);
    const h = heightAt(x, z);
    if (!Number.isFinite(h)) return null;
    min = Math.min(min, h); max = Math.max(max, h);
  }
  return { min, max, relief: max - min };
}

function footprintRect(cx, cz, w, d, yaw) {
  const F = frameOf(cx, cz, yaw), r = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
  for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    const p = F.p(a * w / 2, 0, b * d / 2);
    r.minX = Math.min(r.minX, p[0]); r.maxX = Math.max(r.maxX, p[0]); r.minZ = Math.min(r.minZ, p[2]); r.maxZ = Math.max(r.maxZ, p[2]);
  }
  return r;
}

async function loadAvoidSets(assetBase) {
  const out = { towns: [], props: [] };
  try {
    const index = await (await fetch(`${assetBase}/town/index.json`)).json();
    // Real village geometry (world rectangles): every chunk box plus a disc around each named building. The "meadows" entry is
    // only fences and fields and is not excluded.
    for (const t of index.towns.filter(t => t.id !== 'fields')) {
      const town = await (await fetch(`${assetBase}/town/${t.id}.json`)).json();
      for (const c of town.chunks) out.towns.push({ id: t.id, minX: c.aabb[0], minZ: c.aabb[2], maxX: c.aabb[3], maxZ: c.aabb[5] });
      for (const b of town.buildings) { const r = b.id.startsWith('p_') ? 4 : 10; out.towns.push({ id: t.id, minX: b.pos[0] - r, maxX: b.pos[0] + r, minZ: b.pos[2] - r, maxZ: b.pos[2] + r }); }
    }
    const props = await (await fetch(`${assetBase}/terrain/props.json`)).json();
    for (const list of Object.values(props)) for (const p of list) out.props.push([p[0], p[2]]);
  } catch (error) { console.warn('[world-base] massing: avoid sets unavailable', error.message); }
  return out;
}

/**
 * Build the massing. Needs the station frame (unrotated), the island height field and the finished city (for its lots).
 * Returns { root, slots, stats, vegetationClearAreas, removeSlot, replaceSlot, dispose }.
 */
export async function createMassing({ scene, station, island, city, skyline, params, timeOfDay = 'evening', assetBase = '/assets' }) {
  if (station.root.rotation.y !== 0) throw new Error('Massing expects the unrotated station frame');
  const palette = params[timeOfDay === 'afternoon' ? 'afternoon' : 'evening'];
  const evening = timeOfDay !== 'afternoon';
  const o = station.root.position, ox = o.x, oz = o.z;
  const worldHeight = (x, z) => island.heightAt(x, z);
  const localHeight = (x, z) => island.heightAt(x + ox, z + oz);
  const avoid = await loadAvoidSets(assetBase);

  // ---- exclusion rectangles (station-local) ------------------------------------------------------------------------
  const walkable = [{ ...station.bounds, name: 'bounds' }, ...station.walkExtra.map((a, i) => ({ ...a, name: 'walkExtra' + i }))]
    .map(a => ({ minX: a.x0, maxX: a.x1, minZ: a.z0, maxZ: a.z1, name: a.name }));
  const buildings = [];
  for (const p of city.placements) buildings.push({ ...p.footprint, name: p.name });
  for (const a of city.vegetationClearAreas) buildings.push({ minX: a.minX, maxX: a.maxX, minZ: a.minZ, maxZ: a.maxZ, name: a.name ?? 'clear' });
  for (const p of skyline.placements) buildings.push({ ...p.footprint.localBounds, name: p.name });
  for (const a of skyline.vegetationClearAreas) buildings.push({ minX: a.minX, maxX: a.maxX, minZ: a.minZ, maxZ: a.maxZ, name: a.name ?? 'clear' });
  // Existing meshes of the city / skyline (their world boxes, local frame). Merged station batches are far larger than any block.
  const meshBoxes = [];
  { const box = new THREE.Box3(); scene.updateMatrixWorld(true);
    for (const root of [city.root, skyline.root]) root.traverse(m => {
      if (!m.isMesh || m.isInstancedMesh) return;
      box.setFromObject(m);
      const sx = box.max.x - box.min.x, sz = box.max.z - box.min.z;
      if (sx > 90 || sz > 90 || box.max.y - box.min.y < 0.5) return;
      meshBoxes.push({ minX: box.min.x - ox, maxX: box.max.x - ox, minZ: box.min.z - oz, maxZ: box.max.z - oz });
    }); }
  const corridors = params.avoid.corridors.map(c => c.axis === 'x'
    ? { minX: c.from, maxX: c.to, minZ: c.at - c.half, maxZ: c.at + c.half }
    : { minX: c.at - c.half, maxX: c.at + c.half, minZ: c.from, maxZ: c.to });
  const towns = avoid.towns.map(t => ({ minX: t.minX - ox - 8, maxX: t.maxX - ox + 8, minZ: t.minZ - oz - 8, maxZ: t.maxZ - oz + 8, name: t.id }));
  const propHit = (rect, radius) => avoid.props.some(([x, z]) => x - ox > rect.minX - radius && x - ox < rect.maxX + radius && z - oz > rect.minZ - radius && z - oz < rect.maxZ + radius);
  // Main street centreline sample points (station-local), z from 1 to 130.
  const street = []; for (let z = 1; z <= 130; z += 3) street.push([streetCenterX(z), z]);
  const streetDistance = (x, z) => { let d = Infinity; for (const [sx, sz] of street) d = Math.min(d, Math.hypot(x - sx, z - sz)); return d; };

  const slots = [], rejects = { bounds: 0, buildings: 0, meshes: 0, spacing: 0, ground: 0, relief: 0, street: 0, corridor: 0, town: 0, props: 0 };
  const placedRects = [];
  const clusters = [];

  // ---- placement ---------------------------------------------------------------------------------------------------
  params.clusters.forEach((spec, ci) => {
    const P = params[spec.kind];
    const rng = rngFrom(hash32(params.seed, ci, 7));
    const [x0, z0, x1, z1] = spec.box;
    const accepted = [];
    const centre = spec.centre ?? [(x0 + x1) / 2, (z0 + z1) / 2];
    const radius = spec.radius ?? Math.max(x1 - x0, z1 - z0) / 2;
    let attempts = 0;
    while (accepted.length < spec.count && attempts++ < spec.count * 160) {
      const [fw, fd] = P.footprint.map(r => range(rng, r) * (spec.scale ?? 1));
      const w = Math.round(fw * 2) / 2, d = Math.round(fd * 2) / 2;
      const yaw = (spec.yaw ?? 0) + (rng() - 0.5) * 0.14;
      const cx = x0 + rng() * (x1 - x0), cz = z0 + rng() * (z1 - z0);
      const rect = footprintRect(cx, cz, w, d, yaw);
      const isTower = spec.kind === 'tower';
      if (walkable.some(a => rectsOverlap(rect, grow(a, P.boundsMargin)))) { rejects.bounds++; continue; }
      if (isTower && streetDistance(cx, cz) < P.minStreetDist + Math.hypot(w, d) / 2) { rejects.street++; continue; }
      if (corridors.some(a => rectsOverlap(rect, grow(a, 2)))) { rejects.corridor++; continue; }
      if (buildings.some(a => rectsOverlap(rect, grow(a, P.lotMargin ?? 4)))) { rejects.buildings++; continue; }
      if (meshBoxes.some(a => rectsOverlap(rect, grow(a, 2.5)))) { rejects.meshes++; continue; }
      if (towns.some(a => rectsOverlap(rect, a))) { rejects.town++; continue; }
      if (placedRects.some(a => rectsOverlap(rect, grow(a, P.gap)))) { rejects.spacing++; continue; }
      if (propHit(rect, params.avoid.propRadius)) { rejects.props++; continue; }
      const ground = terrainStats(localHeight, cx, cz, w + 2, d + 2, yaw);
      if (!ground || ground.min < P.minGround) { rejects.ground++; continue; }
      if (ground.relief > P.maxRelief) { rejects.relief++; continue; }
      placedRects.push(rect);
      accepted.push({ cx, cz, w, d, yaw, rect, ground, e: Math.max(0, 1 - Math.hypot(cx - centre[0], cz - centre[1]) / radius), r: rng() });
    }
    // Height rhythm. Score = closeness to the cluster centre + dice; the top `anchors` are the tall anchors, the next third
    // are tall, the rest mid / low. Facades use storeys, towers metres.
    const order = accepted.map((a, i) => ({ i, s: a.e * 0.7 + a.r * 0.55 })).sort((a, b) => b.s - a.s);
    order.forEach(({ i }, rank) => {
      const a = accepted[i];
      if (spec.kind === 'tower') {
        const [lo, hiMax] = P.heightRange;
        // View cap: the top of a block may not rise above `maxAngle` degrees as seen from the reference eye, so a nearby block
        // never walls the frame in; the dice then spread the blocks between lo and that cap.
        let hi = hiMax;
        if (spec.view) {
          const dist = Math.hypot(a.cx + ox - spec.view.eye[0], a.cz + oz - spec.view.eye[2]);
          hi = Math.min(hiMax, Math.max(lo, spec.view.eye[1] + Math.tan(spec.view.maxAngle * Math.PI / 180) * dist - a.ground.max));
        }
        const tier = rank < (spec.anchors ?? 2) ? [0.8, 1.0] : rank < (spec.anchors ?? 2) + Math.ceil(accepted.length * 0.3) ? [0.5, 0.78] : [0, 0.45];
        a.height = Math.round((lo + (hi - lo) * range(rng, tier)) * 2) / 2;
      } else {
        const [lo, hi] = P.floors;
        const tall = spec.tall ? 0.45 : 0;
        const t = Math.min(1, rank / Math.max(1, accepted.length - 1));
        a.floors = Math.max(lo, Math.min(hi, Math.round(lo + (hi - lo) * Math.min(1, (1 - t) * 0.55 + tall + rng() * 0.45))));
        a.height = P.groundFloor + (a.floors - 1) * P.floor;
      }
    });
    clusters.push({ spec, index: ci, accepted });
  });

  // ---- geometry ----------------------------------------------------------------------------------------------------
  const groups = []; // one per cluster
  const stats = { towers: 0, facades: 0, windows: 0, litWindows: 0, signs: 0, towerHeights: [], facadeFloors: [] };
  clusters.forEach(({ spec, index, accepted }) => {
    const P = params[spec.kind], isTower = spec.kind === 'tower';
    const group = { name: spec.name, slots: [], root: null };
    accepted.forEach((a, k) => {
      const rng = rngFrom(hash32(params.seed, index, k, 11));
      const id = `${spec.kind}-${spec.name}-${String(k).padStart(2, '0')}`;
      const F = frameOf(a.cx, a.cz, a.yaw);
      const floorY = a.ground.max + 0.15, baseY = a.ground.min - P.skirt;
      // Aerial perspective baked into the vertex colours: seen from the cluster's reference eye, distant blocks drift towards the haze.
      const eyeDist = spec.view ? Math.hypot(a.cx + ox - spec.view.eye[0], a.cz + oz - spec.view.eye[2]) : 0;
      const hz = palette.haze, hk = spec.view ? Math.max(0, Math.min(1, (eyeDist - hz.start) / (hz.end - hz.start))) * hz.max : 0;
      const hazeCol = color(hz.color);
      const tint = c => (hk > 0 ? c.lerp(hazeCol, hk) : c);
      const wallCol = tint(color(pick(rng, palette.walls))), trimCol = tint(color(pick(rng, palette.trims))), roofCol = tint(color(pick(rng, palette.roofs)));
      const wall = new Part(), win = new Part();
      // Tiers: [y0, y1, w, d, offset]. Tower setbacks shrink the footprint and slide it off-centre.
      const tiers = [];
      const total = a.height;
      const nT = isTower ? (total < 34 ? 1 : (rng() < P.setbackChance ? (total > 55 && rng() < 0.55 ? 3 : 2) : 1)) : (a.floors >= 5 && rng() < 0.5 ? 2 : 1);
      let y = floorY, w = a.w, d = a.d, off = [0, 0];
      for (let t = 0; t < nT; t++) {
        const share = nT === 1 ? 1 : t === 0 ? (nT === 2 ? 0.58 + rng() * 0.12 : 0.46 + rng() * 0.1) : t === 1 && nT === 3 ? 0.28 + rng() * 0.08 : 0;
        const rest = total - (y - floorY);
        const h = t === nT - 1 ? rest : Math.max(P.floor * 2, total * share);
        tiers.push({ y0: t === 0 ? baseY : y, y1: y + h, wy: t === 0 ? floorY : y, w, d, o: [off[0], off[1]], face: t });
        y += h;
        const sw = w * (0.68 + rng() * 0.16), sd = d * (0.68 + rng() * 0.16);
        off = [off[0] + (rng() - 0.5) * (w - sw) * 0.9, off[1] + (rng() - 0.5) * (d - sd) * 0.9];
        w = sw; d = sd;
      }
      for (const [t, tier] of tiers.entries()) {
        addBox(wall, F, tier.o, tier.y0, tier.y1, tier.w, tier.d, wallCol, roofCol);
        // Cornice: a pale slab a little wider than the tier, the chunky ZZZ edge.
        addBox(wall, F, tier.o, tier.y1 - 0.55, tier.y1 + 0.18, tier.w + 0.7, tier.d + 0.7, trimCol, trimCol);
        // Roof clutter on every tier roof: more on the top.
        const top = t === tiers.length - 1;
        const clutterN = top ? 3 + Math.floor(rng() * 4) : Math.floor(rng() * 3);
        for (let c = 0; c < clutterN; c++) {
          const cw = 0.9 + rng() * 2.2, cd = 0.9 + rng() * 2, ch = 0.7 + rng() * 1.5;
          const px = tier.o[0] + (rng() - 0.5) * Math.max(0.1, tier.w - cw - 1.6), pz = tier.o[1] + (rng() - 0.5) * Math.max(0.1, tier.d - cd - 1.6);
          const cc = tint(color(pick(rng, palette.clutter)));
          addBox(wall, F, [px, pz], tier.y1 + 0.18, tier.y1 + 0.18 + ch, cw, cd, cc, cc.clone().multiplyScalar(1.12));
        }
        if (top) {
          // Stair house + water tank on legs + (towers) a mast.
          const sh = [tier.o[0] + (rng() - 0.5) * Math.max(0.1, tier.w - 5), tier.o[1] + (rng() - 0.5) * Math.max(0.1, tier.d - 5)];
          addBox(wall, F, sh, tier.y1 + 0.18, tier.y1 + 2.8, 2.8 + rng() * 1.2, 2.6 + rng(), trimCol, roofCol);
          if (rng() < (isTower ? 0.7 : 0.5)) {
            const tx = tier.o[0] + (rng() - 0.5) * Math.max(0.1, tier.w - 6), tz = tier.o[1] + (rng() - 0.5) * Math.max(0.1, tier.d - 6);
            if (Math.hypot(tx - sh[0], tz - sh[1]) > 3.2) {
              const r = 1.0 + rng() * 0.6, tc = tint(color(pick(rng, palette.tanks))), leg = tint(color('#777f8e'));
              for (const [lx, lz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) addBox(wall, F, [tx + lx * r * 0.7, tz + lz * r * 0.7], tier.y1 + 0.18, tier.y1 + 1.5, 0.2, 0.2, leg, leg);
              addPrism(wall, F, [tx, tz], tier.y1 + 1.5, tier.y1 + 3.3, r, 8, tc, tc.clone().multiplyScalar(1.1));
            }
          }
          if (isTower && rng() < 0.4) { const mc = tint(color('#8a93a3')); addBox(wall, F, [tier.o[0] + tier.w * 0.25, tier.o[1] - tier.d * 0.2], tier.y1 + 0.18, tier.y1 + 7 + rng() * 6, 0.3, 0.3, mc, mc); }
        }
      }
      // Rooftop sign board facing the cluster's `face` direction: posts + board + lit face.
      let sign = null;
      if (rng() < P.signChance) {
        const tier = tiers[tiers.length - 1];
        const fvx = spec.face[0], fvz = spec.face[1];
        // pick the block face whose world normal best matches the view direction
        let best = 0, bestDot = -Infinity;
        FACES.forEach(([nx, nz], i) => { const n = F.n(nx, nz); const dot = n[0] * fvx + n[2] * fvz; if (dot > bestDot) { bestDot = dot; best = i; } });
        const [nx, nz] = FACES[best], tx = nz, tz = -nx;
        const half = nx ? tier.w / 2 : tier.d / 2, len = nx ? tier.d : tier.w;
        const sw = Math.min(len - 1.5, 5 + rng() * 6), sh = 2.4 + rng() * 1.6, thick = 0.5;
        const inset = 0.9;
        const bx = tier.o[0] + nx * (half - inset), bz = tier.o[1] + nz * (half - inset);
        const along = (rng() - 0.5) * Math.max(0, len - sw - 2);
        const cx = bx + tx * along, cz = bz + tz * along;
        const sc = color(pick(rng, palette.signs)), pc = tint(color('#6d7585'));
        const y0 = tier.y1 + 0.18, bottom = y0 + 1.4;
        for (const s of [-1, 1]) addBox(wall, F, [cx + tx * s * (sw / 2 - 0.5), cz + tz * s * (sw / 2 - 0.5)], y0, bottom, 0.22, 0.22, pc, pc);
        // board footprint: along the face tangent, thin along the normal
        addBox(wall, F, [cx, cz], bottom, bottom + sh, nx ? thick : sw, nx ? sw : thick, tint(color('#59606f')), tint(color('#59606f')));
        const faceSign = { o: [cx, cz], half: thick / 2, n: [nx, nz] };
        const gain = palette.signGain;
        const face = sc.clone().multiplyScalar(gain);
        addPane(win, F, faceSign, 0, bottom + sh / 2, sw - 0.5, sh - 0.5, 0.03 + (a.d + a.w) * 0.0, face);
        sign = { face: best, width: sw, height: sh };
        stats.signs++;
      }
      // Windows. Tier side faces, skipping the part of a face hidden by... (tiers are nested, so every side face is open above its y0).
      const bay = P.bay, fh = P.floor;
      const dist = Math.hypot(a.cx - ((station.bounds.x0 + station.bounds.x1) / 2), a.cz - ((station.bounds.z0 + station.bounds.z1) / 2));
      const off2 = Math.min(0.45, 0.05 + dist * 0.0006);
      const litBase = palette.litChance * (0.55 + rng() * 0.9);
      const glassCol = tint(color(palette.glass)).lerp(wallCol, 1 - palette.glassMix);
      let wcount = 0, lcount = 0;
      for (const tier of tiers) {
        for (const [nx, nz] of FACES) {
          const half = nx ? tier.w / 2 : tier.d / 2, len = nx ? tier.d : tier.w;
          const nb = Math.floor((len - 1.6) / bay);
          if (nb < 1) continue;
          const startY = tier.wy + (tier.face === 0 ? 1.0 : 0.7);
          const nf = Math.floor((tier.y1 - startY - 0.9) / fh);
          const face = { o: tier.o, half, n: [nx, nz] };
          for (let f = 0; f < nf; f++) {
            const floorOn = hash32(a.cx | 0, a.cz | 0, f, nx * 3 + nz) % 100 < 72;
            const yc = startY + (f + 0.55) * fh;
            for (let b = 0; b < nb; b++) {
              const along = (b - (nb - 1) / 2) * bay;
              const h = (hash32(a.cx | 0, a.cz | 0, f, b, nx * 7 + nz * 3) % 1000) / 1000;
              const lit = floorOn && h < litBase * 1.7;
              let c;
              if (lit) {
                const hh = (hash32(b, f, a.cz | 0) % 100) / 100;
                c = color(hh < palette.coolShare ? pick(rng, palette.litCool) : pick(rng, palette.litWarm)).lerp(hazeCol, hk * 0.35).multiplyScalar(palette.windowGain);
                lcount++;
              } else c = glassCol;
              addPane(win, F, face, along, yc, bay * 0.56, fh * 0.52, off2, c);
              wcount++;
            }
          }
        }
      }
      stats.windows += wcount; stats.litWindows += lcount;
      const slot = { id, kind: spec.kind, cluster: spec.name, center: [a.cx + ox, floorY, a.cz + oz], yaw: a.yaw, footprint: [a.w, a.d],
        height: a.height, ...(isTower ? {} : { floors: a.floors }), baseY, tiers: tiers.length, sign };
      slot.parts = { wall: wall.freeze(), win: win.freeze() };
      Object.defineProperty(slot, 'parts', { enumerable: false });
      group.slots.push(slot); slots.push(slot);
      if (isTower) { stats.towers++; stats.towerHeights.push(a.height); } else { stats.facades++; stats.facadeFloors.push(a.floors); }
    });
    groups.push(group);
  });

  // ---- meshes ------------------------------------------------------------------------------------------------------
  // Geometry is station-local in x / z (like the city) and world-absolute in y; the group carries the station offset.
  const root = new THREE.Group(); root.name = 'massing'; root.userData.walkable = false; root.position.set(ox, 0, oz);
  const wallMaterial = new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: station.ctx.mat.gradientMap, name: 'massing-wall' });
  const windowMaterial = new THREE.MeshBasicMaterial({ vertexColors: true, name: 'massing-window', toneMapped: false });
  windowMaterial.polygonOffset = true; windowMaterial.polygonOffsetFactor = -2; windowMaterial.polygonOffsetUnits = -2;
  windowMaterial.userData.wbEveningGlow = true; // gain is baked into the vertex colours; the generic glow pass leaves it alone
  const geometries = new Set();
  const build = group => {
    for (const mesh of [group.wallMesh, group.windowMesh]) if (mesh) { mesh.removeFromParent(); mesh.geometry.dispose(); geometries.delete(mesh.geometry); }
    group.wallMesh = group.windowMesh = null;
    const live = group.slots.filter(s => !s.removed && s.parts);
    if (!live.length) return;
    const wallGeometry = mergeParts(live.map(s => s.parts.wall)), windowGeometry = mergeParts(live.map(s => s.parts.win));
    geometries.add(wallGeometry); geometries.add(windowGeometry);
    group.wallMesh = new THREE.Mesh(wallGeometry, wallMaterial); group.wallMesh.name = `massing-wall-${group.name}`;
    group.windowMesh = new THREE.Mesh(windowGeometry, windowMaterial); group.windowMesh.name = `massing-window-${group.name}`;
    for (const mesh of [group.wallMesh, group.windowMesh]) { mesh.castShadow = false; mesh.receiveShadow = false; mesh.userData.walkable = false; root.add(mesh); }
  };
  groups.forEach(build);
  root.userData.slotCount = slots.length;
  scene.add(root); root.updateWorldMatrix(true, true);

  const slotById = new Map(slots.map(s => [s.id, s]));
  const groupOf = new Map(); for (const g of groups) for (const s of g.slots) groupOf.set(s, g);
  const replacements = new Map();
  let disposed = false;
  const api = {
    root, slots, slotById, stats: null, vegetationClearAreas: [], groups, replacements,
    /** Drop a block's placeholder geometry (the cluster mesh is rebuilt without it). */
    removeSlot(id) {
      const s = slotById.get(id); if (!s || s.removed) return false;
      s.removed = true; build(groupOf.get(s)); return true;
    },
    /** Swap a placeholder for the real module: object3d is placed at the slot centre with the slot yaw. */
    replaceSlot(id, object) {
      const s = slotById.get(id); if (!s) throw new Error('Unknown massing slot ' + id);
      api.removeSlot(id);
      object.position.set(s.center[0] - ox, s.center[1], s.center[2] - oz); object.rotation.y = s.yaw; object.userData.massingSlot = id;
      root.add(object); replacements.set(id, object); return object;
    },
    setEnabled(on) { root.visible = !!on; },
    dispose() {
      if (disposed) return; disposed = true; root.removeFromParent();
      for (const g of geometries) g.dispose();
      wallMaterial.dispose(); windowMaterial.dispose();
    },
  };
  // Footprints (station-local rectangles) so main.js can clear grass and flowers under every block.
  // Only the facade blocks are close enough for grass or flowers to be seen against their walls.
  api.vegetationClearAreas = slots.filter(s => s.kind === 'facade').map(s => ({ name: s.id, ...footprintRect(s.center[0] - ox, s.center[2] - oz, s.footprint[0] + 1, s.footprint[1] + 1, s.yaw) }));
  const sum = (list) => list.reduce((n, v) => n + v, 0);
  const tris = [];
  for (const g of groups) for (const m of [g.wallMesh, g.windowMesh]) if (m) tris.push(m.geometry.index.count / 3);
  api.stats = {
    towers: stats.towers, facades: stats.facades, slots: slots.length, meshes: groups.length * 2, drawCalls: groups.filter(g => g.wallMesh).length * 2,
    triangles: sum(tris), windows: stats.windows, litWindows: stats.litWindows, signs: stats.signs,
    towerHeight: stats.towerHeights.length ? [Math.min(...stats.towerHeights), Math.max(...stats.towerHeights)] : null,
    facadeFloors: stats.facadeFloors.length ? [Math.min(...stats.facadeFloors), Math.max(...stats.facadeFloors)] : null,
    perCluster: Object.fromEntries(clusters.map(c => [c.spec.name, { placed: c.accepted.length, wanted: c.spec.count }])),
    rejects, walkableRects: walkable.length, meshBoxes: meshBoxes.length, timeOfDay,
    note: 'Placeholder massing: slots only, no physics. Replace blocks by slot id.',
  };
  return api;
}
