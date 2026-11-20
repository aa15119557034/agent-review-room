import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { WHITE, hash32, rngFrom, pick, Bucket, frameOf, addPart, addPlinth, addSignQuad, patchAerial } from './block-common.js';

// Art round 24 / 25 (#254 X-51): the real facade modules (assets/blocks-2026-11-20/street-facade-01..04.glb) replace the r23 placeholder
// `facade` slots. Each slot becomes a row of modules (16 / 20 / 24 m, 10 m deep, +Z towards the street) that tile end to end.
// Everything is merged per cluster into three meshes: flat colours (walls, podium, pilasters, trim, stair cores, plinths), the shared
// 1024 atlas (windows, shutters, canopies, air conditioners; evening lit cells go through an emissive map) and the shop signs
// (a small canvas atlas with Japanese shop words). Parameters: massing.json "blocks". ?blocks=off keeps the r23c placeholders.

export const blocksEnabled = () => new URLSearchParams(location.search).get('blocks') !== 'off';
const BASE = '/blocks/';
const MODULES = [1, 2, 3, 4];
const FLOOR = 3.2, GROUND = 4.0, CELL = 1 / 8;


/** massing.json "blocks" -> the params createMassing sees when blocks are on: wide, 10 m deep lots that fit a row of modules, and the
 *  facing of every cluster. ?blocks=off never calls this, so the r23c layout is untouched. */
export function applyBlocksParams(params) {
  const b = params.blocks;
  if (!b) return params;
  const next = JSON.parse(JSON.stringify(params));
  Object.assign(next.facade, b.facade);
  for (const spec of next.clusters) if (spec.kind === 'facade' && b.clusters?.[spec.name]) Object.assign(spec, b.clusters[spec.name]);
  return next;
}

// ---- templates -------------------------------------------------------------------------------------------------------------
const ROLE = { wall: 'wall', podium: 'podium', pilaster: 'pilaster', trim: 'trim', terracotta: 'core' };
const ATLAS_PARTS = new Set(['windows', 'storefront', 'canopy', 'roof-ac', 'wall-ac']);

async function loadTemplates(loader) {
  const templates = [];
  let image = null;
  for (const n of MODULES) {
    const gltf = await loader.loadAsync(`${BASE}street-facade-0${n}.glb`);
    gltf.scene.updateMatrixWorld(true);
    const t = { n, parts: [], slots: [], vslots: [], width: 0, depth: 10, top: 0 };
    gltf.scene.traverse(o => {
      if (!o.isMesh) return;
      const g = o.geometry, mat = [].concat(o.material)[0];
      if (mat.map?.image && !image) image = mat.map.image;
      const pos = g.attributes.position.array.slice(), nrm = g.attributes.normal.array.slice();
      const idx = g.index ? Uint32Array.from(g.index.array) : Uint32Array.from({ length: pos.length / 3 }, (_, i) => i);
      const uv = g.attributes.uv ? g.attributes.uv.array.slice() : null;
      g.computeBoundingBox();
      const name = o.name, box = g.boundingBox.clone();
      if (/^sign-slot-v-/.test(name)) { t.vslots.push({ name, box }); return; }
      if (/^sign-slot-\d+$/.test(name)) { t.slots.push({ name, box }); return; }
      if (name === 'body') { t.width = box.max.x - box.min.x; t.depth = box.max.z - box.min.z; }
      if (name === 'parapet') t.top = box.min.y;
      t.parts.push({ name, kind: ATLAS_PARTS.has(name) ? 'atlas' : 'flat', role: ROLE[mat.name] ?? 'wall', pos, nrm, idx, uv, mat: mat.name });
    });
    templates.push(t);
    gltf.scene.traverse(o => { if (o.isMesh) { o.geometry.dispose(); for (const m of [].concat(o.material)) { m.map?.dispose(); m.dispose(); } } });
  }
  return { templates, image };
}

/** Atlas cells: classify the evening window rows (2-3) once by looking at the glass pixels. */
function classifyAtlas(image) {
  const size = image.width, cell = size / 8;
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true }); ctx.drawImage(image, 0, 0);
  const data = ctx.getImageData(0, 0, size, size).data, lit = { warm: [], cool: [], dark: [] }, day = [];
  const px = (x, y) => { const k = (y * size + x) * 4; return [data[k], data[k + 1], data[k + 2]]; };
  for (let row = 0; row < 4; row++) for (let col = 0; col < 8; col++) {
    const [r, g, b] = px(Math.round((col + 0.3) * cell), Math.round((row + 0.5) * cell)), luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (row < 2) day.push([col, row]);
    else if (luma > 150) (b > r ? lit.cool : lit.warm).push([col, row]);
    else lit.dark.push([col, row]);
  }
  // Emissive map: the bright glass of the lit cells only (frame and mullion stay dark).
  const em = document.createElement('canvas'); em.width = em.height = size;
  const ectx = em.getContext('2d'), out = ectx.createImageData(size, size);
  for (const [col, row] of [...lit.warm, ...lit.cool]) {
    for (let y = Math.round(row * cell); y < Math.round((row + 1) * cell); y++) for (let x = Math.round(col * cell); x < Math.round((col + 1) * cell); x++) {
      const k = (y * size + x) * 4, luma = 0.2126 * data[k] + 0.7152 * data[k + 1] + 0.0722 * data[k + 2];
      if (luma > 150) { out.data[k] = data[k]; out.data[k + 1] = data[k + 1]; out.data[k + 2] = data[k + 2]; out.data[k + 3] = 255; } else out.data[k + 3] = 255;
    }
  }
  ectx.putImageData(out, 0, 0);
  const color = new THREE.CanvasTexture(canvas), emissive = new THREE.CanvasTexture(em);
  for (const t of [color, emissive]) { t.flipY = false; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; }
  return { lit, day, color, emissive };
}

/** Seeded decomposition of a row width into module widths (16 / 20 / 16 / 24 m), never the same module twice in a row when it can be avoided. */
function composeRow(rng, width, widths) {
  const ok = new Map();
  const can = rem => { if (rem === 0) return true; if (rem < 16) return false; if (ok.has(rem)) return ok.get(rem); const r = widths.some(w => w <= rem && can(rem - w)); ok.set(rem, r); return r; };
  if (!can(width)) return null;
  const row = []; let rem = width;
  while (rem > 0) {
    const options = widths.map((w, i) => i).filter(i => widths[i] <= rem && can(rem - widths[i]));
    const fresh = options.filter(i => i !== row[row.length - 1]);
    const choose = fresh.length ? fresh : options;
    const i = choose[Math.floor(rng() * choose.length) % choose.length];
    row.push(i); rem -= widths[i];
  }
  return row;
}

/**
 * Replace every facade slot of `massing` (rows of modules) with the real facade GLBs. Returns { root meshes, stats, dispose }.
 * Slots narrower than the smallest module keep their placeholder.
 */
export async function createFacadeBlocks({ station, island, massing, params, shared, timeOfDay = 'evening' }) {
  const { B, L, palette, evening, signs, signMat } = shared;
  const o = station.root.position, ox = o.x, oz = o.z;
  const heightAt = (x, z) => island.heightAt(x + ox, z + oz);
  const { templates, image } = await loadTemplates(new GLTFLoader());
  const widths = templates.map(t => t.width);
  const atlas = classifyAtlas(image);
  const gradientMap = station.ctx.mat.gradientMap;

  const color = hex => new THREE.Color(hex);
  const flat = new THREE.MeshToonMaterial({ vertexColors: true, gradientMap, name: 'massing-blocks-flat' });
  const atlasMat = new THREE.MeshToonMaterial({ vertexColors: true, map: atlas.color, gradientMap, name: 'massing-blocks-atlas' });
  if (evening) { atlasMat.emissive = new THREE.Color(1, 1, 1); atlasMat.emissiveMap = atlas.emissive; atlasMat.emissiveIntensity = L.emissive; }
  // The atlas holds windows, not paint: no flat-colour mip pull and no printed-sign outline (the lit windows are emissive, the walls are lit toon).
  atlasMat.userData.wbNoFlat = true; atlasMat.userData.wbNoSignLine = true; atlasMat.userData.wbEveningGlow = true;
  patchAerial(flat, shared.aerial, 'lit'); patchAerial(atlasMat, shared.aerial, 'lit');
  const materials = [flat, atlasMat];

  const stats = { slots: 0, replaced: 0, kept: [], modules: 0, perCluster: {}, windows: 0, litWindows: 0, signsH: 0, signsV: 0, triangles: 0, plinth: { max: 0, count: 0 }, combos: {}, terrain: [], words: {} };
  const clusters = new Map(), modulesOut = [];
  const slots = massing.slots.filter(s => s.kind === 'facade');
  slots.forEach((slot, si) => {
    const rng = rngFrom(hash32(params.seed, 24, si));
    const row = slot.footprint[0] >= Math.min(...widths) ? composeRow(rng, slot.footprint[0], widths) : null;
    stats.slots++;
    if (!row) { stats.kept.push({ id: slot.id, footprint: slot.footprint }); return; }
    let cl = clusters.get(slot.cluster);
    if (!cl) { cl = { name: slot.cluster, flat: new Bucket(), atlas: new Bucket(), sign: new Bucket(), slots: [] }; clusters.set(slot.cluster, cl); stats.perCluster[slot.cluster] = { slots: 0, modules: 0, width: 0 }; }
    cl.slots.push(slot);
    const cx = slot.center[0] - ox, cz = slot.center[2] - oz, c = Math.cos(slot.yaw), s = Math.sin(slot.yaw);
    let lx = -slot.footprint[0] / 2;
    const names = [];
    row.forEach((ti, k) => {
      const t = templates[ti], mrng = rngFrom(hash32(params.seed, 24, si, k, 5)), mir = mrng() < 0.5 ? -1 : 1;
      const mx = lx + t.width / 2; lx += t.width;
      const px = cx + mx * c, pz = cz - mx * s;
      // Ground under the module (rotated rectangle incl. podium): the module stands on the highest point, a plinth reaches the lowest.
      let gmin = Infinity, gmax = -Infinity;
      for (let a = 0; a <= 8; a++) for (let b = 0; b <= 4; b++) {
        const ax = (a / 8 - 0.5) * (t.width + 0.8), az = (b / 4 - 0.5) * (t.depth + 0.4) + 0.2;
        const h = heightAt(px + ax * c + az * s, pz - ax * s + az * c); gmin = Math.min(gmin, h); gmax = Math.max(gmax, h);
      }
      const y0 = gmax + B.lift;
      const F = frameOf(px, y0, pz, slot.yaw, mir);
      names.push(`0${t.n}${mir < 0 ? 'm' : ''}`);
      const wallC = color(pick(mrng, palette.walls)), trimC = color(pick(mrng, palette.trims));
      const roleColors = {
        wall: wallC, podium: wallC.clone().multiplyScalar(L.podium), pilaster: wallC.clone().lerp(trimC, 0.35).multiplyScalar(L.pilaster),
        trim: trimC.clone().multiplyScalar(L.trim), core: color(L.core),
      };
      const plinthColor = color(L.plinth);
      addPlinth(cl.flat, F, 0, 0.2, t.width + 0.76, t.depth + 0.36, gmin - B.sink, y0 + 0.02, plinthColor);
      stats.plinth.max = Math.max(stats.plinth.max, y0 - (gmin - B.sink)); stats.plinth.count++;
      const canopyTint = new THREE.Color(1, 1, 1).lerp(color(pick(mrng, palette.signs)), L.canopyTint);
      const litBase = L.litChance * (0.55 + mrng() * 0.9);
      let wBox = 0;
      for (const part of t.parts) {
        if (part.kind === 'flat') { const col = roleColors[part.role]; addPart(cl.flat, F, part, () => col); continue; }
        if (part.name === 'windows') {
          const n = part.pos.length / 3 / 24, shifts = [];
          for (let b = 0; b < n; b++) {
            let mn = Infinity, mx = -Infinity;
            for (let v = 0; v < 24; v++) { const yy = part.pos[(b * 24 + v) * 3 + 1]; mn = Math.min(mn, yy); mx = Math.max(mx, yy); }
            const y = (mn + mx) / 2;
            const side = part.pos[(b * 24) * 3 + 2] > 0 ? 1 : 0, f = Math.round((y - GROUND - FLOOR / 2) / FLOOR);
            const floorOn = hash32(si, k, f, side, 7) % 100 < L.floorOn * 100, lit = evening && floorOn && (hash32(si, k, b, 3) % 1000) / 1000 < litBase;
            let cell;
            if (!evening) cell = atlas.day[hash32(si, k, b) % atlas.day.length];
            else if (lit) { const cool = (hash32(b, f, k, si) % 100) / 100 < L.coolShare, list = cool && atlas.lit.cool.length ? atlas.lit.cool : atlas.lit.warm; cell = list[hash32(si, b, k, 9) % list.length]; }
            else cell = atlas.lit.dark.length ? atlas.lit.dark[hash32(si, k, b) % atlas.lit.dark.length] : atlas.day[0];
            shifts.push([cell[0] * CELL, cell[1] * CELL]);
            if (side === 1) { stats.windows++; if (lit) stats.litWindows++; }
          }
          addPart(cl.atlas, F, part, () => WHITE, i => shifts[Math.floor(i / 24)]);
          wBox += n; continue;
        }
        const tint = part.name === 'canopy' ? canopyTint : WHITE;
        addPart(cl.atlas, F, part, () => tint);
      }
      // Sign boards: horizontal slots (front) and the vertical blade (both faces), seeded word + colour scheme.
      const schemes = B.signs.schemes.length, hWords = B.signs.h.words.length, vWords = B.signs.v.words.length;
      // Sign boards are built in the module frame AFTER the mirror (x' = mir * x), so the lettering always reads left to right.
      const F0 = frameOf(px, y0, pz, slot.yaw, 1);
      const quad = (bucket, cell, centre, n, w, h) => addSignQuad(bucket, F0, signs, cell, centre, n, w, h);
      t.slots.forEach((sl, i) => {
        const wi = Math.floor(mrng() * hWords) % hWords, sc = Math.floor(mrng() * schemes) % schemes, cell = signs.cells.h[wi * schemes + sc];
        const w = sl.box.max.x - sl.box.min.x, h = sl.box.max.y - sl.box.min.y, z = sl.box.max.z + B.signLift;
        quad(cl.sign, cell, [mir * (sl.box.min.x + sl.box.max.x) / 2, (sl.box.min.y + sl.box.max.y) / 2, z], [0, 1], w, h);
        stats.signsH++; stats.words[cell.word] = (stats.words[cell.word] || 0) + 1;
      });
      t.vslots.forEach(sl => {
        const wi = Math.floor(mrng() * vWords) % vWords, sc = Math.floor(mrng() * schemes) % schemes, cell = signs.cells.v[wi * schemes + sc];
        const depth = sl.box.max.z - sl.box.min.z, x = mir * (sl.box.min.x + sl.box.max.x) / 2, zc = (sl.box.min.z + sl.box.max.z) / 2;
        // Board length follows the word (the cell is 100 px per metre); it hangs from the top of the slot.
        const hBoard = Math.min(sl.box.max.y - sl.box.min.y, cell.h / B.signs.v.pxPerMetre), yc = sl.box.max.y - hBoard / 2 - 0.3;
        quad(cl.sign, cell, [x + B.bladeLift, yc, zc], [1, 0], depth, hBoard);
        quad(cl.sign, cell, [x - B.bladeLift, yc, zc], [-1, 0], depth, hBoard);
        stats.signsV++; stats.words[cell.word] = (stats.words[cell.word] || 0) + 1;
      });
      const crownY = y0 + palette.fog.skyAt * t.top; cl.flat.seal(crownY); cl.atlas.seal(crownY); cl.sign.seal(crownY);
      stats.modules++; stats.perCluster[slot.cluster].modules++; stats.perCluster[slot.cluster].width += t.width;
      modulesOut.push({ slot: slot.id, cluster: slot.cluster, module: t.n, mirrored: mir < 0, centre: [px + ox, y0, pz + oz], yaw: slot.yaw, width: t.width, depth: t.depth, ground: [gmin, gmax], windows: wBox });
      stats.terrain.push({ id: `${slot.id}#${k}`, relief: +(gmax - gmin).toFixed(2), plinth: +(y0 - (gmin - B.sink)).toFixed(2) });
    });
    stats.perCluster[slot.cluster].slots++; stats.replaced++;
    stats.combos[slot.id] = names.join('+');
  });

  // ---- meshes (one set per cluster, parented under the massing root so they share its offset) ----------------------------------------------
  const meshes = [];
  for (const cl of clusters.values()) {
    for (const [key, bucket, material] of [['flat', cl.flat, flat], ['atlas', cl.atlas, atlasMat], ['sign', cl.sign, signMat]]) {
      if (!bucket.vertices) continue;
      const mesh = new THREE.Mesh(bucket.geometry(key !== 'sign'), material);
      mesh.name = `massing-blocks-${key}-${cl.name}`; mesh.castShadow = false; mesh.receiveShadow = false; mesh.userData.walkable = false;
      massing.root.add(mesh); meshes.push(mesh); stats.triangles += bucket.triangles;
    }
  }
  const replaced = slots.filter(s => clusters.get(s.cluster)?.slots.includes(s)).map(s => s.id);
  if (massing.removeSlots) massing.removeSlots(replaced); else replaced.forEach(id => massing.removeSlot(id));
  for (const id of replaced) massing.replacements.set(id, { blocks: stats.combos[id] });
  stats.drawCalls = meshes.length; stats.meshes = meshes.map(m => m.name);
  stats.litShare = stats.windows ? stats.litWindows / stats.windows : 0;
  stats.atlas = { litWarm: atlas.lit.warm.length, litCool: atlas.lit.cool.length, dark: atlas.lit.dark.length, day: atlas.day.length };
  stats.timeOfDay = timeOfDay;
  let disposed = false;
  return {
    meshes, materials, stats, modules: modulesOut, signs, atlas,
    dispose() {
      if (disposed) return; disposed = true;
      for (const m of meshes) { m.removeFromParent(); m.geometry.dispose(); }
      for (const m of materials) m.dispose();
      atlas.color.dispose(); atlas.emissive.dispose();
    },
  };
}
