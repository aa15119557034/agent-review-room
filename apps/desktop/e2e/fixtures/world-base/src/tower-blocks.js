import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { pickLandmarks, obb } from './midband-blocks.js';
import { WHITE, hash32, rngFrom, pick, Bucket, frameOf, addPart, addPlinth, addSignQuad, patchAerial } from './block-common.js';

// Art round 25 (#254 X-51): the six skyline tower GLBs (assets/blocks-2026-11-20/skyline-tower-{slim,slab,setback}-{tank,billboard}.glb)
// replace the r23 `tower` placeholders, one module per slot. Per slot: the variant (shape x roof) whose footprint / height fits best
// (uniform XZ scale within +-15 %, Y within +-25 %, rooftop clutter keeps its size), turned in 90 degree steps towards the cluster's
// `face`, seeded mirror, no identical neighbours. Merged per cluster into solid / atlas / sign meshes like the facades, same toon +
// outline pipeline, same camera-distance fog. Slots that had a rooftop board get a billboard variant whose boards carry a wide sign.
// Parameters: massing.json "blocks.towers". ?towers=off keeps the r23 placeholders.
// Art round 26 (mid-band, blocks.midband, rules in midband-blocks.js; ?midband=off skips all of it): the same pipeline also builds the
// mid-rise GLBs (extra slots from layoutMidband) and puts the landmark GLB on the tower slots best seen from the main street; the rooftop
// panels of the six older billboard variants are enlarged to match the 9 x 5.5 m panels of the new models.
// Art round 26b: the mid-rises stand behind the facade rows, are stretched in height only (to their own 28-32 m, no clamp, footprint 1:1) and use their
// own materials with the lighter fog gain (blocks.midband.fogGain); the landmarks are the towers the art-a-street / sample-g-rail views see best.

export const towersEnabled = () => new URLSearchParams(location.search).get('towers') !== 'off';
const BASE = '/blocks/';
const SHAPES = ['slim', 'slab', 'setback'], ROOFS = ['tank', 'billboard'];
const SPECIAL = ['landmark', 'midrise']; // r26 shapes: never picked by the ordinary best-fit, only through landmarks / extra slots
const CELL = 0.25;

const ROLE_BY_PART = (name, mat) => {
  if (name === 'roof-detail') return 'clutter';
  if (name === 'parapet') return 'trim';
  if (name === 'crown-band' || name === 'core') return 'core';
  return { body: 'wall', podium: 'podium', pilaster: 'pilaster', trim: 'trim', terracotta: 'core' }[mat] ?? 'wall';
};

async function loadTemplates(shapes = SHAPES) {
  const loader = new GLTFLoader(), templates = [];
  let image = null;
  for (const shape of shapes) for (const roof of ROOFS) {
    let gltf;
    try { gltf = await loader.loadAsync(`${BASE}skyline-tower-${shape === 'midrise' ? 'midrise30' : shape}-${roof}.glb`); }
    catch (error) { if (!SPECIAL.includes(shape)) throw error; console.warn(`[world-base] r26: ${shape}-${roof}.glb unavailable, skipped`, error?.message); continue; }
    gltf.scene.updateMatrixWorld(true);
    const t = { shape, roof, name: `${shape}-${roof}`, parts: [], W: 0, D: 0, top: 0, core: null, board: null };
    gltf.scene.traverse(o => {
      if (!o.isMesh) return;
      const g = o.geometry, mat = [].concat(o.material)[0];
      if (mat.map?.image && !image) image = mat.map.image;
      const pos = g.attributes.position.array.slice(), nrm = g.attributes.normal.array.slice();
      const idx = g.index ? Uint32Array.from(g.index.array) : Uint32Array.from({ length: pos.length / 3 }, (_, i) => i);
      const uv = g.attributes.uv ? g.attributes.uv.array.slice() : null;
      g.computeBoundingBox();
      const box = g.boundingBox.clone(), name = o.name;
      if (name === 'body-1') { t.W = box.max.x - box.min.x; t.D = box.max.z - box.min.z; }
      if (name === 'parapet') t.top = box.min.y;
      if (name === 'core') t.core = box;
      if (name === 'roof-detail' && roof === 'billboard') {
        // The first box of the roof detail is the board (build-towers.py): 24 vertices, thin along z.
        const b = new THREE.Box3();
        for (let i = 0; i < 24; i++) b.expandByPoint(new THREE.Vector3(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]));
        t.board = b;
      }
      t.parts.push({ name, kind: name === 'windows' ? 'atlas' : 'flat', role: ROLE_BY_PART(name, mat.name), pos, nrm, idx, uv, box });
    });
    templates.push(t);
    gltf.scene.traverse(o => { if (o.isMesh) { o.geometry.dispose(); for (const m of [].concat(o.material)) { m.map?.dispose(); m.dispose(); } } });
  }
  return { templates, image };
}

/** The 512 tower atlas: 4 x 4 cells of 2 x 2 panes. Evening: every pane repainted (exactly `share` of the 64 panes lit, warm / cool mix),
 *  plus an emissive map holding only the lit panes. Afternoon: the GLB's own day rows. Window strips tile the four cells of one row. */
function buildAtlas(image, evening, share, coolShare, seed) {
  const size = image.width, cell = size / 4, pane = Math.round(cell / 2 - 22);
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
  const rowLit = [0, 0, 0, 0];
  let emissive = null;
  if (evening) {
    const em = document.createElement('canvas'); em.width = em.height = size;
    const ectx = em.getContext('2d'); ectx.fillStyle = '#000'; ectx.fillRect(0, 0, size, size);
    const rng = rngFrom(seed), order = Array.from({ length: 64 }, (_, i) => i);
    for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    const lit = new Set(order.slice(0, Math.round(64 * share)));
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
      const x0 = c * cell, y0 = r * cell;
      ctx.fillStyle = 'rgb(40,42,50)'; ctx.fillRect(x0, y0, cell, cell);
      for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) {
        const px = x0 + 10 + i * (cell / 2 - 6), py = y0 + 10 + j * (cell / 2 - 6), id = (r * 4 + c) * 4 + j * 2 + i;
        let col = 'rgb(52,58,70)';
        if (lit.has(id)) {
          const cool = rng() < coolShare, k = rng() < 0.35 ? 0.78 : 1, base = cool ? [196, 224, 236] : [255, 206, 150];
          col = `rgb(${base.map(v => Math.round(v * k)).join(',')})`; rowLit[r]++;
          ectx.fillStyle = col; ectx.fillRect(px, py, pane + 1, pane + 1);
        }
        ctx.fillStyle = col; ctx.fillRect(px, py, pane + 1, pane + 1);
      }
      ctx.strokeStyle = 'rgb(34,36,40)'; ctx.lineWidth = 3; ctx.strokeRect(x0 + 2, y0 + 2, cell - 5, cell - 5);
    }
    emissive = new THREE.CanvasTexture(em);
  }
  const color = new THREE.CanvasTexture(canvas);
  for (const t of [color, emissive]) if (t) { t.flipY = false; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.wrapS = THREE.RepeatWrapping; }
  return { color, emissive, rowLit, rows: evening ? [0, 1, 2, 3] : [0, 1] };
}

/** r26: the board of an older billboard template (first 24 vertices of roof-detail) resized to w x h metres in its own frame (x about its
 *  centre, y up from its bottom edge); the two posts (next two boxes) move under the new width. Returns a copy of the roof-detail part. */
function reshapeBoard(part, board, w, h, postAt) {
  const pos = part.pos.slice(), cx = (board.min.x + board.max.x) / 2, w0 = board.max.x - board.min.x, h0 = board.max.y - board.min.y;
  for (let i = 0; i < 24; i++) { pos[i * 3] = cx + (pos[i * 3] - cx) * w / w0; pos[i * 3 + 1] = board.min.y + (pos[i * 3 + 1] - board.min.y) * h / h0; }
  for (let bx = 1; bx <= 2; bx++) {
    let mid = 0; for (let v = 0; v < 24; v++) mid += pos[(bx * 24 + v) * 3] / 24;
    const shift = Math.sign(mid || 1) * postAt * w - mid;
    for (let v = 0; v < 24; v++) pos[(bx * 24 + v) * 3] += shift;
  }
  return { ...part, pos };
}

const rectOfModule = (cx, cz, yaw, x0, x1, z0, z1) => {
  const c = Math.cos(yaw), s = Math.sin(yaw), r = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
  for (const [lx, lz] of [[x0, z0], [x1, z0], [x1, z1], [x0, z1]]) { const x = cx + lx * c + lz * s, z = cz - lx * s + lz * c; r.minX = Math.min(r.minX, x); r.maxX = Math.max(r.maxX, x); r.minZ = Math.min(r.minZ, z); r.maxZ = Math.max(r.maxZ, z); }
  return r;
};
const overlap = (a, b) => a.minX < b.maxX && a.maxX > b.minX && a.minZ < b.maxZ && a.maxZ > b.minZ;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Replace every tower slot of `massing` with a tower GLB. `shared` comes from makeShared (palette, sign atlas / material, fog uniforms).
 */
export async function createTowerBlocks({ station, island, massing, params, shared, timeOfDay = 'evening', midband = null, extraSlots = null }) {
  const { B, L, palette, evening, signs, signMat } = shared, T = B.towers;
  const o = station.root.position, ox = o.x, oz = o.z;
  const heightAt = (x, z) => island.heightAt(x + ox, z + oz);
  const { templates, image } = await loadTemplates(midband ? [...SHAPES, ...SPECIAL] : SHAPES);
  const has = shape => templates.some(t => t.shape === shape);
  const atlas = buildAtlas(image, evening, T.litShare, palette.coolShare ?? 0.22, hash32(params.seed, 25));
  const color = hex => new THREE.Color(hex);
  const flat = new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: station.ctx.mat.gradientMap, name: 'massing-blocks-tower-flat' });
  const atlasMat = new THREE.MeshToonMaterial({ vertexColors: true, map: atlas.color, gradientMap: station.ctx.mat.gradientMap, name: 'massing-blocks-tower-atlas' });
  if (evening) { atlasMat.emissive = new THREE.Color(1, 1, 1); atlasMat.emissiveMap = atlas.emissive; atlasMat.emissiveIntensity = L.emissive; }
  atlasMat.userData.wbNoFlat = true; atlasMat.userData.wbNoSignLine = true; atlasMat.userData.wbEveningGlow = true;
  patchAerial(flat, shared.aerial, 'lit'); patchAerial(atlasMat, shared.aerial, 'lit');
  // r26b: the mid-band cluster ('midband') gets its own copies of the three materials with the fog gain blocks.midband.fogGain (default 0.55); everything else
  // keeps the r25 materials. Only built when the mid-band is on and has slots.
  const fogGain = midband ? (midband.fogGain ?? 0.55) : 1, mids = { flat: null, atlas: null, sign: shared.signMatMid ?? signMat };
  if (midband && extraSlots?.length) {
    mids.flat = new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: station.ctx.mat.gradientMap, name: 'massing-blocks-tower-flat' });
    mids.atlas = new THREE.MeshToonMaterial({ vertexColors: true, map: atlas.color, gradientMap: station.ctx.mat.gradientMap, name: 'massing-blocks-tower-atlas' });
    if (evening) { mids.atlas.emissive = new THREE.Color(1, 1, 1); mids.atlas.emissiveMap = atlas.emissive; mids.atlas.emissiveIntensity = L.emissive; }
    mids.atlas.userData.wbNoFlat = true; mids.atlas.userData.wbNoSignLine = true; mids.atlas.userData.wbEveningGlow = true;
    patchAerial(mids.flat, shared.aerial, 'lit', fogGain); patchAerial(mids.atlas, shared.aerial, 'lit', fogGain);
  }

  const towerSlots = massing.slots.filter(s => s.kind === 'tower');
  // r26 (only with the mid-band on and its GLBs present): mid-rise slots appended AFTER the towers (so the tower slots keep their indices and
  // seeds), landmark ids picked among the tower slots.
  const extras = midband && has('midrise') && extraSlots ? extraSlots : [];
  const slots = [...towerSlots, ...extras];
  const faceOf = Object.fromEntries(params.clusters.filter(c => c.kind === 'tower').map(c => [c.name, c.face]));
  const slotRects = new Map(slots.map(s => [s.id, rectOfModule(s.center[0] - ox, s.center[2] - oz, s.yaw, -s.footprint[0] / 2, s.footprint[0] / 2, -s.footprint[1] / 2, s.footprint[1] / 2)]));
  const placed = new Map(); // slot id -> { rect, shape }
  const clusters = new Map(), stats = { slots: slots.length, replaced: 0, perCluster: {}, variants: {}, sxz: [Infinity, -Infinity], sy: [Infinity, -Infinity], windowStrips: 0, litShare: 0, triangles: 0, plinth: { max: 0 }, picks: {}, heightErr: [] };
  const ordered = [...towerSlots.slice().sort((a, b) => a.cluster.localeCompare(b.cluster) || a.center[0] - b.center[0] || a.center[2] - b.center[2]), ...extras];
  // r26b: landmark = the tower slot each main view sees best; what could stand in front of it: the facade rows, the mid-rises and the other towers
  const occluders = !midband || !has('landmark') ? [] : [
    ...massing.slots.filter(s => s.kind === 'facade').map(s => ({ id: s.id, box: obb(s.center[0] - ox, s.center[2] - oz, s.yaw, s.footprint[0], s.footprint[1]), top: s.center[1] + s.height })),
    ...extras.map(s => ({ id: s.id, box: obb(s.center[0] - ox, s.center[2] - oz, s.yaw, s.footprint[0], s.footprint[1]), top: s.center[1] + s.height })),
    ...towerSlots.map(s => ({ id: s.id, box: obb(s.center[0] - ox, s.center[2] - oz, s.yaw, s.footprint[0], s.footprint[1]), top: s.center[1] + s.height })),
  ];
  const landmarks = midband && has('landmark') ? pickLandmarks(towerSlots, o, midband.landmarks, occluders) : [], landmarkIds = new Map(landmarks.map(l => [l.id, l]));
  stats.landmarks = []; stats.midrises = 0;
  let litSum = 0;

  for (const slot of ordered) {
    const rng = rngFrom(hash32(params.seed, 25, slots.indexOf(slot), 3));
    const [sw, sd] = slot.footprint, roofWanted = slot.sign ? 'billboard' : 'tank';
    // ---- variant: footprint / height fit, never the same shape as a neighbour within `near` metres when a near-equal alternative exists ----
    const fit = (t, parity) => {
      const Wv = parity ? t.D : t.W, Dv = parity ? t.W : t.D;
      const sxz = clamp(Math.sqrt((sw / Wv) * (sd / Dv)), T.xz[0], T.xz[1]);
      const sy = clamp(slot.height / t.top, T.y[0], T.y[1]);
      const cost = 0.6 * Math.abs(Math.log(sw / (Wv * sxz))) + 0.6 * Math.abs(Math.log(sd / (Dv * sxz))) + 2 * Math.abs(Math.log(slot.height / (t.top * sy))) + 0.5 * Math.abs(Math.log(sy)) + 0.3 * Math.abs(Math.log(sxz));
      return { t, sxz, sy, cost };
    };
    // r26: mid-rise slots only take the mid-rise GLB, landmark slots the landmark GLB; the ordinary best-fit never sees these shapes
    const isLot = slot.kind === 'midrise', family = slot.shape ?? (landmarkIds.has(slot.id) ? 'landmark' : null);
    const cands = templates.filter(t => t.roof === roofWanted && (family ? t.shape === family : !SPECIAL.includes(t.shape))).map(t => {
      const f0 = fit(t, 0), f1 = fit(t, 1), best = f0.cost <= f1.cost ? f0 : f1;
      return { ...best, parity: best === f0 ? 0 : 1, fits: [f0, f1] };
    }).sort((a, b) => a.cost - b.cost);
    const near = [...placed.entries()].filter(([id]) => Math.hypot(slotRects.get(id).minX - slotRects.get(slot.id).minX, slotRects.get(id).minZ - slotRects.get(slot.id).minZ) < T.sameNeighbour).map(([, p]) => p.shape);
    let choice = cands[0];
    if (near.includes(choice.t.shape)) { const alt = cands.find(c => !near.includes(c.t.shape) && c.cost < cands[0].cost + T.altTolerance); if (alt) choice = alt; }
    // the landmark keeps its own size (20 x 20 x ~110 m, no clamped refit); r26b: the mid-rise keeps its 50 x 20 m footprint and is stretched in height only,
    // to the slot's own 28-32 m (no clamp to the usual +-25 %; the rooftop panel keeps its size, see `map`)
    if (family === 'landmark') { const fixed = { t: choice.t, sxz: 1, sy: 1, cost: choice.cost }; choice = { ...fixed, fits: [fixed, fixed] }; }
    if (family === 'midrise') { const fixed = { t: choice.t, sxz: 1, sy: slot.height / choice.t.top, cost: choice.cost }; choice = { ...fixed, fits: [fixed, fixed] }; }
    // r26e: a tall block of a focus sector (slab / setback GLB on a mid-band lot) keeps its own footprint and is stretched by the seeded `stretch` (1.0-1.05) only
    if (isLot && family !== 'midrise') { const fixed = { t: choice.t, sxz: 1, sy: slot.stretch ?? 1, cost: choice.cost }; choice = { ...fixed, fits: [fixed, fixed] }; }
    const { t } = choice;
    // ---- orientation: any of the four 90 degree turns (the fit of the other parity costs extra), mirror; face the cluster's face vector,
    //      avoid other slots' footprints ----
    const cx = slot.center[0] - ox, cz = slot.center[2] - oz, face = slot.face ?? faceOf[slot.cluster] ?? [0, 1];
    const opts = [];
    // r26b: a mid-rise always faces the street (the layout put it behind a facade row with that yaw): no 90 degree turns, no overlap scoring
    for (const k of isLot ? [0] : [0, 1, 2, 3]) for (const mir of [1, -1]) {
      const f = choice.fits[k % 2], sxz = f.sxz, sy = f.sy;
      const yaw = slot.yaw + k * Math.PI / 2, dot = Math.sin(yaw) * face[0] + Math.cos(yaw) * face[1];
      // the stair core hangs on the +x side of the module (the -x side when mirrored)
      const half = t.W / 2 * sxz + 0.4, extra = t.core ? Math.max(0, (t.core.max.x - t.W / 2) * sxz) : 0;
      const rect = rectOfModule(cx, cz, yaw, mir > 0 ? -half : -half - extra, mir > 0 ? half + extra : half, -t.D / 2 * sxz - 0.4, t.D / 2 * sxz + 0.4);
      let hits = 0; if (!isLot) for (const [id, r] of slotRects) if (id !== slot.id && overlap(rect, placed.get(id)?.rect ?? r)) hits++;
      opts.push({ yaw, mir, rect, sxz, sy, score: hits * 10 + (f.cost - choice.cost) * 3 - dot + (rng() - 0.5) * 0.4 });
    }
    opts.sort((a, b) => a.score - b.score);
    const { yaw, mir, rect, sxz, sy } = opts[0];
    placed.set(slot.id, { rect, shape: t.shape });
    // ---- ground ----
    const sc = Math.cos(yaw), ss = Math.sin(yaw);
    let gmin = Infinity, gmax = -Infinity;
    for (let a = 0; a <= 8; a++) for (let b = 0; b <= 8; b++) {
      const ax = (a / 8 - 0.5) * (t.W * sxz + 0.8), az = (b / 8 - 0.5) * (t.D * sxz + 0.8);
      const h = heightAt(cx + ax * sc + az * ss, cz - ax * ss + az * sc); gmin = Math.min(gmin, h); gmax = Math.max(gmax, h);
    }
    const y0 = gmax + T.lift, F = frameOf(cx, y0, cz, yaw, mir), F0 = frameOf(cx, y0, cz, yaw, 1);
    let cl = clusters.get(slot.cluster);
    if (!cl) { cl = { name: slot.cluster, flat: new Bucket(), atlas: new Bucket(), sign: new Bucket(), slots: [] }; clusters.set(slot.cluster, cl); stats.perCluster[slot.cluster] = { slots: 0, variants: {} }; }
    cl.slots.push(slot);
    const wallC = color(pick(rng, palette.walls)), trimC = color(pick(rng, palette.trims)), clutterC = color(pick(rng, palette.clutter));
    const roleColors = { wall: wallC, podium: wallC.clone().multiplyScalar(L.podium), pilaster: wallC.clone().lerp(trimC, 0.35).multiplyScalar(L.pilaster),
      trim: trimC.clone().multiplyScalar(L.trim), clutter: clutterC, core: color(L.core) };
    addPlinth(cl.flat, F, 0, 0, t.W * sxz + 0.76, t.D * sxz + 0.76, gmin - T.sink, y0 + 0.02, color(L.plinth));
    stats.plinth.max = Math.max(stats.plinth.max, y0 - (gmin - T.sink));
    const top = t.top;
    const map = part => part.name === 'roof-detail' ? (x, y, z) => [x * sxz, top * sy + (y - top), z * sxz] : (x, y, z) => [x * sxz, y * sy, z * sxz];
    // r26: the six older billboard variants get a rooftop panel of the new models' size (final boardW x boardH metres, posts follow);
    // the landmark / mid-rise GLBs already ship a 9 x 5.5 m panel; off = the r25 board untouched
    let parts = t.parts, boardW = null, boardH = null;
    if (midband && t.board && !SPECIAL.includes(t.shape)) {
      const BR = midband.towerBoard, brng = rngFrom(hash32(params.seed, 26, slots.indexOf(slot), 11));
      boardW = BR.w[0] + brng() * (BR.w[1] - BR.w[0]); boardH = BR.h[0] + brng() * (BR.h[1] - BR.h[0]);
      parts = t.parts.map(p => p.name === 'roof-detail' ? reshapeBoard(p, t.board, boardW / sxz, boardH, BR.postAt) : p);
    }
    for (const part of parts) {
      if (part.kind === 'flat') { const col = roleColors[part.role]; addPart(cl.flat, F, part, () => col, null, map(part)); continue; }
      // window strips: one box per floor and side (24 vertices); each takes a random atlas row (+ a whole-cell u shift, the texture repeats)
      const n = part.pos.length / 3 / 24, shifts = [];
      for (let b = 0; b < n; b++) {
        const r = atlas.rows[hash32(slots.indexOf(slot), b, 11) % atlas.rows.length], du = (hash32(slots.indexOf(slot), b, 13) % 4) * CELL;
        shifts.push([du, r * CELL]); stats.windowStrips++; litSum += evening ? atlas.rowLit[r] / 16 : 0;
      }
      addPart(cl.atlas, F, part, () => WHITE, i => shifts[Math.floor(i / 24)], map(part));
    }
    // rooftop boards: a wide sign on both faces of the billboard
    if (t.board) {
      const bb = t.board, w = boardW ?? (bb.max.x - bb.min.x) * sxz, h = boardH ?? (bb.max.y - bb.min.y), cyy = top * sy + ((boardH != null ? bb.min.y + boardH / 2 : (bb.min.y + bb.max.y) / 2) - top);
      const list = midband ? signs.cells.b : signs.cells.w, cell = list[Math.floor(rng() * list.length) % list.length], ca = cell.w / cell.h, r = w / h;
      const crop = r < ca ? { u: r / ca, v: 1 } : { u: 1, v: ca / r };
      const cxm = mir * (bb.min.x + bb.max.x) / 2 * sxz;
      addSignQuad(cl.sign, F0, signs, cell, [cxm, cyy, bb.max.z * sxz + T.signLift], [0, 1], w, h, crop);
      addSignQuad(cl.sign, F0, signs, cell, [cxm, cyy, bb.min.z * sxz - T.signLift], [0, -1], w, h, crop);
      stats.boards = (stats.boards ?? 0) + 1;
    }
    const crownY = y0 + palette.fog.skyAt * top * sy; cl.flat.seal(crownY); cl.atlas.seal(crownY); cl.sign.seal(crownY);
    stats.replaced++; stats.perCluster[slot.cluster].slots++;
    stats.perCluster[slot.cluster].variants[t.name] = (stats.perCluster[slot.cluster].variants[t.name] ?? 0) + 1;
    stats.variants[t.name] = (stats.variants[t.name] ?? 0) + 1;
    stats.sxz = [Math.min(stats.sxz[0], sxz), Math.max(stats.sxz[1], sxz)]; stats.sy = [Math.min(stats.sy[0], sy), Math.max(stats.sy[1], sy)];
    if (family === 'landmark') stats.landmarks.push({ id: slot.id, ...landmarkIds.get(slot.id), variant: t.name, height: +(t.top * sy).toFixed(1), core: t.core ? +(t.core.max.y * sy).toFixed(1) : null, footprint: [+(t.W * sxz).toFixed(1), +(t.D * sxz).toFixed(1)], yaw: +yaw.toFixed(2), centre: [+(slot.center[0] - ox).toFixed(0), +(slot.center[2] - oz).toFixed(0)] });
    if (isLot) stats.midrises++;
    if (boardW != null) (stats.boardSizes ??= []).push([+boardW.toFixed(1), +boardH.toFixed(1)]);
    stats.picks[slot.id] = `${t.name} sxz=${sxz.toFixed(2)} sy=${sy.toFixed(2)} ${mir < 0 ? 'm' : ''} yaw=${yaw.toFixed(2)} h=${slot.height}->${(t.top * sy).toFixed(1)}`;
    stats.heightErr.push(+(t.top * sy - slot.height).toFixed(1));
  }

  const meshes = [];
  for (const cl of clusters.values()) {
    const own = cl.name === 'midband' && mids.flat;
    for (const [key, bucket, material] of [['flat', cl.flat, own ? mids.flat : flat], ['atlas', cl.atlas, own ? mids.atlas : atlasMat], ['sign', cl.sign, own ? mids.sign : signMat]]) {
      if (!bucket.vertices) continue;
      const mesh = new THREE.Mesh(bucket.geometry(key !== 'sign'), material);
      mesh.name = `massing-blocks-tower-${key}-${cl.name}`; mesh.castShadow = false; mesh.receiveShadow = false; mesh.userData.walkable = false;
      massing.root.add(mesh); meshes.push(mesh); stats.triangles += bucket.triangles;
    }
  }
  const replaced = ordered.filter(s => clusters.get(s.cluster)?.slots.includes(s)).map(s => s.id);
  massing.removeSlots(replaced);
  for (const id of replaced) massing.replacements.set(id, { tower: stats.picks[id] });
  stats.drawCalls = meshes.length; stats.meshes = meshes.map(m => m.name);
  stats.litShare = stats.windowStrips ? litSum / stats.windowStrips : 0;
  stats.timeOfDay = timeOfDay;
  const materials = [flat, atlasMat, ...(mids.flat ? [mids.flat, mids.atlas] : [])];
  stats.midFogGain = mids.flat ? fogGain : null; stats.midMaterials = !!mids.flat;
  let disposed = false;
  return {
    meshes, materials, stats, atlas, placed,
    dispose() {
      if (disposed) return; disposed = true;
      for (const m of meshes) { m.removeFromParent(); m.geometry.dispose(); }
      for (const m of materials) m.dispose();
      atlas.color.dispose(); atlas.emissive?.dispose();
    },
  };
}
