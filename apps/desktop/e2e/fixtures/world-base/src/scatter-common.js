import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeAerial, patchAerial, hash32, rngFrom } from './block-common.js';
import { toonEnabled } from './toon.js';
import * as layout from '../upstream/sakuragaoka/src/world/layout.js';

// X-51 street props + vegetation (2026-11-21): the pieces both island-wide scatter passes share (street-props.js, vegetation-scatter.js).
//   * loadModel      one GLB -> ONE merged geometry with the materials baked into vertex colours (a model = one draw call, one shared material)
//   * makeMaterial   MeshToonMaterial (same ramp as the station / blocks) + the camera-distance aerial fog of block-common (instancing aware)
//   * makeBatch      InstancedMesh from {x, y, z, yaw, sx, sy, sz, tint} records
//   * getContext     the world facts a rule needs: ground height, slope, water, roads, and every obstacle that is already there
// Nothing here is for one camera: rules in the two modules only ask the context "may I stand here?".

export { hash32, rngFrom };
export const TAU = Math.PI * 2;
export const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// ---- noise (seeded value noise, 2 octaves) -----------------------------------------------------------------------------------
const hashf = (x, z, s) => { const h = Math.sin(x * 127.1 + z * 311.7 + s * 74.7) * 43758.5453; return h - Math.floor(h); };
export function noise2(x, z, scale, seed = 0) {
  const fx = x / scale, fz = z / scale, x0 = Math.floor(fx), z0 = Math.floor(fz), tx = smooth(0, 1, fx - x0), tz = smooth(0, 1, fz - z0);
  const a = hashf(x0, z0, seed), b = hashf(x0 + 1, z0, seed), c = hashf(x0, z0 + 1, seed), d = hashf(x0 + 1, z0 + 1, seed);
  return (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz;
}
export const fbm = (x, z, scale, seed = 0) => noise2(x, z, scale, seed) * 0.65 + noise2(x, z, scale * 0.37, seed + 11) * 0.35;

// ---- asset table (src/props-veg.json): the only place that names a model ------------------------------------------------------------------
export async function loadTable() { return (await fetch(new URL('./props-veg.json', import.meta.url))).json(); }
/** Weighted pick from a group list [{ id, weight }]. */
export function pickWeighted(rng, list) {
  let total = 0; for (const e of list) total += e.weight ?? 1;
  let v = rng() * total; for (const e of list) { v -= e.weight ?? 1; if (v <= 0) return e.id; }
  return list[list.length - 1].id;
}
/** Load every model of a section ({ base, models }) -> { id: model }; model.spec is the table entry, model.radius the placement radius. */
export async function loadModels(section) {
  const warnings = [];
  const entries = await Promise.all(Object.entries(section.models).map(async ([id, spec]) => {
    if (typeof spec.tint === 'string') spec = { ...spec, tint: section.tints?.[spec.tint] ?? null }; // a name from the section's "tints"
    return [id, await loadModel((spec.base ?? section.base) + spec.file, spec, id, warnings)];
  }));
  const models = Object.fromEntries(entries); models.warnings = warnings;
  return models;
}

// ---- models --------------------------------------------------------------------------------------------------------------------
export async function loadModel(url, spec = {}, id = url, warnings = []) {
  const gltf = await new GLTFLoader().loadAsync(url);
  gltf.scene.updateMatrixWorld(true);
  // Untextured parts: material colour (x the GLB's vertex colours when spec.vertexColors) baked into ONE merged geometry. Parts whose material has a base-colour
  // texture go into a geometry that keeps its UVs. A named vending window retains its separate emissive texture.
  const parts = [], cardParts = [], windowParts = [];
  let map = null, windowMap = null, windowEmission = null;
  gltf.scene.traverse(o => {
    if (!o.isMesh) return;
    const g = o.geometry.clone();
    g.applyMatrix4(o.matrixWorld);
    const m = [].concat(o.material)[0], n = g.attributes.position.count, col = new Float32Array(n * 3), src = spec.vertexColors || m.map ? g.attributes.color : null;
    for (let i = 0; i < n; i++) {
      const k = src ? [src.getX(i), src.getY(i), src.getZ(i)] : [1, 1, 1];
      col[i * 3] = m.color.r * k[0]; col[i * 3 + 1] = m.color.g * k[1]; col[i * 3 + 2] = m.color.b * k[2];
    }
    const card = !!m.map;
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && !(card && k === 'uv')) g.deleteAttribute(k);
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    if (spec.toonCrown && !card) {
      const crown = new Uint8Array(n).fill(o.userData.stationCrown === true ? 1 : 0);
      g.setAttribute('stationCrown', new THREE.BufferAttribute(crown, 1));
    }
    if (!g.index) g.setIndex(Array.from({ length: n }, (_, i) => i));
    if (spec.window && m.name === spec.window) {
      windowParts.push(g); windowMap = m.map; windowEmission = m.emissiveMap;
    } else if (card) { cardParts.push(g); map ??= m.map; map.anisotropy = 4; }
    else { parts.push(g); o.material.dispose?.(); }
  });
  if (spec.window && (windowParts.length !== 1 || !windowMap || !windowEmission)) {
    throw new Error(`${url}: expected one textured ${spec.window} mesh with an emissive map`);
  }
  if (windowMap) windowMap.anisotropy = windowEmission.anisotropy = 4;
  if (!parts.length && !cardParts.length && !windowParts.length) throw new Error(`${url}: no meshes`);
  const merge = list => { if (!list.length) return null; const g = list.length === 1 ? list[0] : mergeGeometries(list, false); if (list.length > 1) for (const p of list) p.dispose(); return g; };
  const geometry = merge(parts), cardGeometry = merge(cardParts), windowGeometry = merge(windowParts);
  const all = [geometry, cardGeometry, windowGeometry].filter(Boolean);
  // table: origin offset, scale / fit, ground snap (same transform for both geometries)
  const [ox, oy, oz] = spec.origin ?? [0, 0, 0], boxOf = () => { const b = new THREE.Box3(); for (const g of all) { g.computeBoundingBox(); b.union(g.boundingBox); } return b; };
  for (const g of all) g.translate(-ox, -oy, -oz);
  let b = boxOf(), scale = spec.scale ?? 1;
  if (spec.fit === 'height' && spec.size) scale *= spec.size[1] / Math.max(1e-3, b.max.y - b.min.y);
  if (scale !== 1) for (const g of all) g.scale(scale, scale, scale);
  b = boxOf();
  if (spec.snapGround) { for (const g of all) g.translate(0, -b.min.y, 0); b = boxOf(); }
  for (const g of all) { g.computeBoundingBox(); g.computeBoundingSphere(); }
  const box = b, size = [box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z];
  if (spec.size && spec.size.some((v, i) => Math.abs(size[i] - v) > 0.35 * Math.max(v, 0.2))) warnings.push({ id, expected: spec.size, measured: size.map(v => +v.toFixed(2)) });
  const tris = all.reduce((n, g) => n + g.index.count / 3, 0);
  return { id, spec, geometry, cardGeometry, map, windowGeometry, windowMap, windowEmission, box, size, tris, url,
    radius: spec.radius ?? Math.max(size[0], size[2]) / 2 };
}

// ---- material (toon ramp + aerial fog, instancing aware) ------------------------------------------------------------------------
export async function getAerial(worldBase, island) {
  if (worldBase.blockShared?.aerial) return worldBase.blockShared.aerial;
  const params = worldBase.massingParams ?? await (await fetch(new URL('./massing.json', import.meta.url))).json();
  const palette = params[island.timeOfDay === 'afternoon' ? 'afternoon' : 'evening'];
  return makeAerial(island, palette.fog, params.blocks.fog.start);
}
export function makeMaterial({ gradientMap, aerial, name, map = null, alphaTest = 0, tint = null, height = 1, toonCrown = false }) {
  const m = new THREE.MeshToonMaterial({ vertexColors: true, gradientMap, name });
  if (toonCrown) m.defines.TOON_TREE_CROWN = 1;
  if (map) { m.map = map; m.alphaTest = alphaTest || 0.5; m.side = THREE.DoubleSide; }
  const vegetation = name === 'vegetation' || name.startsWith('vegetation-');
  // Preserve distant leaf color where the warm evening haze is tuned for buildings.
  patchAerial(m, aerial, 'lit', vegetation ? 0.45 : 1);
  // patchAerial reads the vertex position in model space; with instancing the instance matrix has to be applied first.
  const aerialHook = m.onBeforeCompile;
  m.onBeforeCompile = (shader, renderer) => {
    if (toonCrown && toonEnabled()) applyCrownColors(shader, toonCrown);
    aerialHook.call(m, shader, renderer);
    if (tint) m.userData.tintUniforms = applyTint(shader, tint, height);
    shader.vertexShader = shader.vertexShader.replace('vBkPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;',
      'vec4 bkP = vec4( transformed, 1.0 );\n#ifdef USE_INSTANCING\nbkP = instanceMatrix * bkP;\n#endif\nvBkPos = ( modelMatrix * bkP ).xyz;');
  };
  m.customProgramCacheKey = () => 'scatter-aerial-lit' + (vegetation ? '-vegetation' : '') + (map ? '-card' : '') +
    (tint ? '-tint' : '') + (toonCrown ? '-' + toonCrown : '');
  return m;
}

/** Paint the three big values from the crown normals. Keep bark in the common lighting
 * and let the existing aerial fog run after the crown colors have been chosen. */
function applyCrownColors(shader, kind) {
  const [shade, side, top] = kind === 'cherry'
    ? ['#986481', '#cf8fb3', '#f0b9ce']
    : ['#326960', '#527f5b', '#7d9d63'];
  shader.uniforms.uCrownShade = { value: new THREE.Color(shade) };
  shader.uniforms.uCrownSide = { value: new THREE.Color(side) };
  shader.uniforms.uCrownTop = { value: new THREE.Color(top) };
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nattribute float stationCrown;\nvarying float vStationCrown;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvStationCrown = stationCrown;');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying float vStationCrown;\n'
      + 'uniform vec3 uCrownShade, uCrownSide, uCrownTop;')
    .replace('#include <opaque_fragment>', `
      vec3 crownUp = ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz;
#if NUM_DIR_LIGHTS > 0
      crownUp = normalize( crownUp + directionalLights[ 0 ].direction * 0.42 );
#endif
      float crownLight = dot( normal, crownUp );
      float edge = clamp( fwidth( crownLight ) * 0.65, 0.012, 0.045 );
      float side = smoothstep( -0.18 - edge, -0.18 + edge, crownLight );
      float top = smoothstep( 0.35 - edge, 0.35 + edge, crownLight );
      vec3 crown = mix( mix( uCrownShade, uCrownSide, side ), uCrownTop, top );
      float leafValue = dot( diffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
      crown *= mix( 0.93, 1.07, smoothstep( 0.06, 0.38, leafValue ) );
      outgoingLight = mix( outgoingLight, crown, vStationCrown * uTbK );
      #include <opaque_fragment>
    `);
}
/**
 * Per-model colour grade of the leaves (props-veg.json "tint": { low, high, from, to, sat, leafOnly }), applied after the vertex colour x texture:
 *   t = smoothstep(from, to, height / modelHeight);  rgb = mix(grey, rgb, sat) x mix(low, high, t)
 *   the non-green parts (bark) get tint.bark = { mul: [r, g, b], sat } instead (only when leafOnly)
 * low = colour multiplier at the bottom of the crown (slightly blue-green), high = at the top (yellow-green, brighter). Green-dominant texels only
 * (bark / trunk stay as they are) unless leafOnly is false.
 */
function applyTint(shader, tint, height) {
  const v3 = a => new THREE.Vector3(...a), bark = tint.bark ?? {};
  shader.uniforms.uVegLow = { value: v3(tint.low ?? [1, 1, 1]) };
  shader.uniforms.uVegHigh = { value: v3(tint.high ?? [1, 1, 1]) };
  shader.uniforms.uVegRange = { value: new THREE.Vector4(tint.from ?? 0, tint.to ?? 1, tint.sat ?? 1, height) };
  shader.uniforms.uVegLeaf = { value: tint.leafOnly === false ? 0 : 1 };
  shader.uniforms.uVegBark = { value: new THREE.Vector4(...(bark.mul ?? [1, 1, 1]), bark.sat ?? 1) };
  shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nvarying float vVegH;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvVegH = transformed.y;');
  shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vVegH;\nuniform vec3 uVegLow;\nuniform vec3 uVegHigh;\nuniform vec4 uVegRange;\nuniform float uVegLeaf;\nuniform vec4 uVegBark;')
    .replace('#include <color_fragment>', `#include <color_fragment>
  {
    float vgT = smoothstep( uVegRange.x, uVegRange.y, vVegH / uVegRange.w );
    float vgLum = dot( diffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
    float vgW = mix( 1.0, smoothstep( -0.02, 0.06, diffuseColor.g - diffuseColor.r ), uVegLeaf );
    vec3 vgC = mix( vec3( vgLum ), diffuseColor.rgb, uVegRange.z ) * mix( uVegLow, uVegHigh, vgT );
    vec3 vgB = mix( vec3( vgLum ), diffuseColor.rgb, uVegBark.w ) * uVegBark.rgb;
    diffuseColor.rgb = mix( mix( diffuseColor.rgb, vgB, uVegLeaf ), vgC, vgW );
  }`);
  return shader.uniforms;
}
/** Cache materials by model when tint, tree shading or alpha-masked cards need their own program. */
export function makeMaterialSet({ gradientMap, aerial, name, windowLight = 0 }) {
  const shared = makeMaterial({ gradientMap, aerial, name }), cache = new Map();
  const get = (model, card) => {
    const key = model.id + (card ? ':card' : ':solid');
    const toonCrown = !card && model.spec.toonCrown;
    if (!card && !model.spec.tint && !toonCrown) return shared;
    if (!cache.has(key)) cache.set(key, makeMaterial({
      gradientMap, aerial, name: name + '-' + key, map: card ? model.map : null,
      tint: model.spec.tint ?? null, height: model.size[1], toonCrown,
    }));
    return cache.get(key);
  };
  const window = model => {
    const key = model.id + ':window';
    if (!cache.has(key)) {
      const m = makeMaterial({ gradientMap, aerial, name: 'vend-window', map: model.windowMap });
      m.alphaTest = 0;
      if (windowLight > 0) {
        m.emissive.set('#fff1da');
        m.emissiveMap = model.windowEmission;
        m.emissiveIntensity = windowLight;
      }
      cache.set(key, m);
    }
    return cache.get(key);
  };
  return { shared, solid: m => get(m, false), card: m => get(m, true), window, all: () => [shared, ...cache.values()] };
}

// ---- instancing -----------------------------------------------------------------------------------------------------------------
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _c = new THREE.Color(), _up = new THREE.Vector3(0, 1, 0);
export function makeBatch({ name, model, material, items }) {
  const mesh = new THREE.InstancedMesh(model.geometry, material, items.length);
  mesh.name = name;
  items.forEach((it, i) => {
    if (it.matrix) _m.copy(it.matrix);
    else _m.compose(_p.set(it.x, it.y, it.z), _q.setFromAxisAngle(_up, it.yaw ?? 0), _s.set(it.sx ?? 1, it.sy ?? it.sx ?? 1, it.sz ?? it.sx ?? 1));
    mesh.setMatrixAt(i, _m);
    const t = it.tint ?? 1; mesh.setColorAt(i, _c.setRGB(t * (it.tr ?? 1), t * (it.tg ?? 1), t * (it.tb ?? 1)));
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.castShadow = false; mesh.receiveShadow = false; mesh.userData.walkable = false;
  mesh.computeBoundingSphere();
  return mesh;
}

/** One InstancedMesh per part of a model (solid geometry, alpha-card geometry), same records. materials = makeMaterialSet(). */
export function makeBatches({ name, model, materials, items }) {
  const out = [];
  if (model.geometry) out.push(makeBatch({ name, model, material: materials.solid(model), items }));
  if (model.cardGeometry) out.push(makeBatch({ name: name + '-cards', model: { geometry: model.cardGeometry }, material: materials.card(model), items }));
  if (model.windowGeometry) {
    const mesh = makeBatch({ name: name + '-window', model: { geometry: model.windowGeometry }, material: materials.window(model), items });
    mesh.castShadow = false;
    out.push(mesh);
  }
  return out;
}

// ---- spatial index of rectangles ----------------------------------------------------------------------------------------------
class RectGrid {
  constructor(cell = 24) { this.cell = cell; this.map = new Map(); this.rects = []; }
  add(r, kind) {
    const rect = { minX: r.minX, maxX: r.maxX, minZ: r.minZ, maxZ: r.maxZ, kind, name: r.name };
    if (![rect.minX, rect.maxX, rect.minZ, rect.maxZ].every(Number.isFinite)) return;
    const i = this.rects.push(rect) - 1, c = this.cell;
    for (let ix = Math.floor(rect.minX / c); ix <= Math.floor(rect.maxX / c); ix++) for (let iz = Math.floor(rect.minZ / c); iz <= Math.floor(rect.maxZ / c); iz++) {
      const k = ix + ',' + iz; let a = this.map.get(k); if (!a) this.map.set(k, (a = [])); a.push(i);
    }
  }
  /** First rect of one of the kinds within r (rectangle grown by r) of (x, z), or null. margins: per-kind extra radius. */
  hit(x, z, r, kinds, margins = null) {
    const c = this.cell, reach = r + (margins ? Math.max(0, ...Object.values(margins)) : 0);
    for (let ix = Math.floor((x - reach) / c); ix <= Math.floor((x + reach) / c); ix++) for (let iz = Math.floor((z - reach) / c); iz <= Math.floor((z + reach) / c); iz++) {
      const a = this.map.get(ix + ',' + iz); if (!a) continue;
      for (const i of a) {
        const q = this.rects[i]; if (!kinds.includes(q.kind)) continue;
        const m = r + (margins?.[q.kind] ?? 0);
        if (x > q.minX - m && x < q.maxX + m && z > q.minZ - m && z < q.maxZ + m) return q;
      }
    }
    return null;
  }
}

// ---- road polylines -------------------------------------------------------------------------------------------------------------
/** Resample to ~1 m and add arc length; returns { pts: [{x, z, s, tx, tz}], length }. */
export function resample(points, step = 1) {
  const out = []; let s = 0, next = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const [ax, az] = points[i], [bx, bz] = points[i + 1], len = Math.hypot(bx - ax, bz - az);
    if (len < 1e-6) continue;
    for (; next <= s + len; next += step) { const t = (next - s) / len; out.push({ x: ax + (bx - ax) * t, z: az + (bz - az) * t, s: next, tx: (bx - ax) / len, tz: (bz - az) / len }); }
    s += len;
  }
  return { pts: out, length: s };
}

// ---- the world context -----------------------------------------------------------------------------------------------------------
/**
 * Everything a placement rule needs, built once per page (worldBase.scatter). Coordinates are world metres.
 *   groundY(x, z)         the surface the player would stand on (station formula inside the station rect, island heightfield elsewhere)
 *   slope(x, z)           |grad h| over 3 m
 *   isWater(x, z)         sea / river bed (heightfield below 0.45 m or inside the river ribbon + margin)
 *   cover(x, z)           grass cover 0..1 from the splat map AFTER every clearVegetationAreas (0 under towns, lots, station, facade rows)
 *   obstacle(x, z, r, kinds)  'walk' (station walkable rects), 'bld' (every building / lot / slot / mesh box of the station frame), 'corr' (road corridors),
 *                         'prop' (island rocks and old trees), 'town' (solid heightmaps of Larkhaven / Cairnwick / the farms, via Town.heightAt)
 *   roads                 [{ name, group, halfW, kind, pts }] of the whole island (station layout roads + the three towns' street networks)
 *   roadDist(x, z)        nearest centreline: { d, over (d - halfW), road, idx }
 */
export async function getContext({ worldBase, island, station, scene }) {
  if (worldBase.scatter?.ctx) return worldBase.scatter.ctx;
  const t0 = performance.now();
  const terrain = island.terrain, o = station.root.position, ox = o.x, oy = o.y, oz = o.z;
  const rects = new RectGrid(24);
  const stationRect = { minX: 188, maxX: 372, minZ: 803, maxZ: 1028 };
  const inStation = (x, z) => x >= stationRect.minX && x <= stationRect.maxX && z >= stationRect.minZ && z <= stationRect.maxZ;
  const local = a => ({ minX: a.minX + ox, maxX: a.maxX + ox, minZ: a.minZ + oz, maxZ: a.maxZ + oz, name: a.name });
  const stats = { rects: {}, roads: 0 };
  const addAll = (list, kind, fn = local) => { let n = 0; for (const a of list ?? []) { rects.add(fn(a), kind); n++; } stats.rects[kind] = (stats.rects[kind] ?? 0) + n; };
  // walkable: the main rectangle and every shop interior etc. that shop-entry.js added
  addAll([{ minX: station.bounds.x0, maxX: station.bounds.x1, minZ: station.bounds.z0, maxZ: station.bounds.z1, name: 'bounds' },
    ...station.walkExtra.map((a, i) => ({ minX: a.x0, maxX: a.x1, minZ: a.z0, maxZ: a.z1, name: 'walkExtra' + i }))], 'walk');
  // buildings of the station frame (station-local rectangles)
  const city = worldBase.city, skyline = worldBase.skyline, massing = worldBase.massing;
  if (city) { addAll(city.placements.map(p => ({ ...p.footprint, name: p.name })), 'bld'); addAll(city.vegetationClearAreas, 'bld'); }
  if (skyline) { addAll(skyline.placements.map(p => ({ ...p.footprint.localBounds, name: p.name })), 'bld'); addAll(skyline.vegetationClearAreas, 'bld'); }
  if (massing) {
    addAll(massing.vegetationClearAreas, 'bld');
    addAll(massing.exclusions.meshBoxes, 'bld');
    // every facade row / tower / mid-rise slot (world centre, footprint, yaw)
    const slotRect = s => { const c = Math.cos(s.yaw), sn = Math.sin(s.yaw), r = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity, name: s.id };
      for (const [lx, lz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { const x = s.center[0] + lx * s.footprint[0] / 2 * c + lz * s.footprint[1] / 2 * sn, z = s.center[2] - lx * s.footprint[0] / 2 * sn + lz * s.footprint[1] / 2 * c;
        r.minX = Math.min(r.minX, x); r.maxX = Math.max(r.maxX, x); r.minZ = Math.min(r.minZ, z); r.maxZ = Math.max(r.maxZ, z); } return r; };
    addAll([...massing.slots, ...(worldBase.midband?.slots ?? [])], 'bld', slotRect);
    // road corridors the massing keeps clear (R3 / R4 / R6 / R5 lanes continuing east-west, main street to the south)
    addAll(massing.exclusions.corridors, 'corr');
  }
  // station solid colliders (boxes and cylinders of ctx.physics): only used inside the walkable area
  const solids = [];
  for (const it of station.physics.items) {
    if (it.type === 'cyl') { if (it.y1 - it.y0 < 0.3 || it.y1 - it.y0 > 150) { if (it.y1 - it.y0 < 0.3) continue; } solids.push({ cyl: true, cx: it.cx, cz: it.cz, r: it.r, y0: it.y0, y1: it.y1 }); }
    else if (it.type === 'box') solids.push({ cx: it.cx, cz: it.cz, hw: it.hw, hd: it.hd, c: it.c, s: it.s, y0: it.y0, y1: it.y1 });
  }
  const solidGrid = new Map(); const SC = 8;
  solids.forEach((q, i) => { const r = q.cyl ? q.r : Math.hypot(q.hw, q.hd); for (let ix = Math.floor((q.cx - r) / SC); ix <= Math.floor((q.cx + r) / SC); ix++) for (let iz = Math.floor((q.cz - r) / SC); iz <= Math.floor((q.cz + r) / SC); iz++) { const k = ix + ',' + iz; let a = solidGrid.get(k); if (!a) solidGrid.set(k, (a = [])); a.push(i); } });
  /** Station-local test: does a collider whose vertical span overlaps [y, y + 1.4] come within r of (lx, lz)? */
  const solidAt = (lx, lz, r, y) => {
    const a = solidGrid.get(Math.floor(lx / SC) + ',' + Math.floor(lz / SC)); if (!a) return null;
    for (const i of a) {
      const q = solids[i]; if (q.y1 < y + 0.15 || q.y0 > y + 1.4) continue;
      if (q.cyl) { if (Math.hypot(lx - q.cx, lz - q.cz) < q.r + r) return q; continue; }
      const dx = lx - q.cx, dz = lz - q.cz, px = Math.abs(dx * q.c - dz * q.s), pz = Math.abs(dx * q.s + dz * q.c);
      if (px < q.hw + r && pz < q.hd + r) return q;
    }
    return null;
  };
  // island props (old trees, rocks, menhirs): points with a radius
  const propPoints = new Map(); const PC = 32;
  try {
    const props = await (await fetch('/assets/terrain/props.json')).json();
    const R = { tree: 3.5, boulders: 4, menhir: 2.5, lighthouse: 9 };
    for (const [kind, list] of Object.entries(props)) for (const p of list) { const k = Math.floor(p[0] / PC) + ',' + Math.floor(p[2] / PC); let a = propPoints.get(k); if (!a) propPoints.set(k, (a = [])); a.push([p[0], p[2], (R[kind] ?? 3) * (kind === 'boulders' || kind === 'tree' ? p[4] : 1)]); }
  } catch (error) { console.warn('[world-base] scatter: island props unavailable', error.message); }
  const propHit = (x, z, r) => { for (let ix = Math.floor((x - r) / PC) - 1; ix <= Math.floor((x + r) / PC) + 1; ix++) for (let iz = Math.floor((z - r) / PC) - 1; iz <= Math.floor((z + r) / PC) + 1; iz++) { const a = propPoints.get(ix + ',' + iz); if (a) for (const p of a) if (Math.hypot(x - p[0], z - p[1]) < p[2] + r) return true; } return false; };

  // ---- ground ----------------------------------------------------------------------------------------------------------------
  const groundY = (x, z) => inStation(x, z) ? oy + layout.heightAt(x - ox, z - oz) : terrain.heightAt(x, z);
  const slope = (x, z) => { const s = 1.5; return Math.hypot(groundY(x + s, z) - groundY(x - s, z), groundY(x, z + s) - groundY(x, z - s)) / (2 * s); };
  // river ribbon rows (x, z, half width) in a coarse grid
  const riverGrid = new Map(); const RC = 48; let riverRows = 0;
  for (const r of island.river?.rows ?? []) { riverRows++; const k = Math.floor(r.x / RC) + ',' + Math.floor(r.z / RC); let a = riverGrid.get(k); if (!a) riverGrid.set(k, (a = [])); a.push(r); }
  const nearRiver = (x, z, margin) => { for (let ix = Math.floor((x - 40) / RC); ix <= Math.floor((x + 40) / RC); ix++) for (let iz = Math.floor((z - 40) / RC); iz <= Math.floor((z + 40) / RC); iz++) { const a = riverGrid.get(ix + ',' + iz); if (a) for (const r of a) if (Math.hypot(x - r.x, z - r.z) < r.hw + margin) return true; } return false; };
  const isWater = (x, z, margin = 2.5) => terrain.heightAt(x, z) < 0.45 || nearRiver(x, z, margin);
  const splat4 = [0, 0, 0, 0];
  const cover = (x, z) => terrain.splatAt(x, z, splat4)[3];

  // ---- roads -----------------------------------------------------------------------------------------------------------------
  const roads = [];
  const addRoad = (name, group, halfW, kind, points) => { const r = resample(points, 1); if (r.pts.length > 1) roads.push({ name, group, halfW, kind, pts: r.pts, length: r.length }); };
  // station layout (station-local): the only roads that exist as geometry there. Used for distance tests; props there are the upstream's own.
  {
    const R = layout.ROADS, S = [];
    for (let z = 1; z <= 130; z += 2) S.push([layout.streetCenterX(z) + ox, z + oz]);
    addRoad('R1', 'station', R.R1.halfW, 'main', S);
    addRoad('R2', 'station', R.R2.halfW, 'local', [[R.R2.x + ox, R.R2.z0 + oz], [R.R2.x + ox, R.R2.z1 + oz]]);
    addRoad('R3', 'station', R.R3.halfW, 'local', [[R.R3.x0 + ox, R.R3.z + oz], [R.R3.x1 + ox, R.R3.z + oz]]);
    addRoad('R4', 'station', R.R4.halfW, 'lane', [[R.R4.x0 + ox, R.R4.z + oz], [R.R4.x1 + ox, R.R4.z + oz]]);
    addRoad('R6', 'station', R.R6.halfW, 'lane', [[R.R6.x0 + ox, R.R6.z + oz], [R.R6.x1 + ox, R.R6.z + oz]]);
    addRoad('R5', 'station', R.R5.halfW, 'path', [[R.R5.x0 + ox, R.R5.z + oz], [R.R5.x1 + ox, R.R5.z + oz]]);
  }
  // Petalwake's own towns: streets and plazas from town/sites.json (the network the town geometry was built from)
  const sites = await (await fetch('/assets/town/sites.json')).json();
  const lots = [];
  for (const t of sites.towns) {
    for (const s of t.streets) if (s.kind !== 'edge' && s.width >= 1) addRoad(t.id + ':' + s.key, t.id, s.width / 2, s.kind, s.pts);
    for (const l of t.lots) lots.push({ town: t.id, id: l.id, pts: l.pts });
  }
  stats.roads = roads.length;
  const roadGrid = new Map(); const GC = 32;
  roads.forEach((r, ri) => r.pts.forEach((p, i) => { if (i % 2) return; const k = Math.floor(p.x / GC) + ',' + Math.floor(p.z / GC); let a = roadGrid.get(k); if (!a) roadGrid.set(k, (a = [])); a.push([ri, i]); }));
  const roadDist = (x, z, reach = 40, skip = -1) => {
    let best = null;
    for (let ix = Math.floor((x - reach) / GC); ix <= Math.floor((x + reach) / GC); ix++) for (let iz = Math.floor((z - reach) / GC); iz <= Math.floor((z + reach) / GC); iz++) {
      const a = roadGrid.get(ix + ',' + iz); if (!a) continue;
      for (const [ri, i] of a) { if (ri === skip) continue; const p = roads[ri].pts[i], d = Math.hypot(x - p.x, z - p.z); if (!best || d - roads[ri].halfW < best.over) best = { d, over: d - roads[ri].halfW, road: ri, idx: i }; }
    }
    return best;
  };

  // ---- the towns' solid heightmaps ---------------------------------------------------------------------------------------------
  const townTop = (x, z) => island.town.heightAt(x, z);
  /** Is something taller than `ref + 0.7` built within r of (x, z)? (house, wall, tree, boat, lamp...) ref = the surface the item stands on. */
  const townBlocked = (x, z, r, ref) => {
    for (const [dx, dz] of [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r], [r * 0.7, r * 0.7], [-r * 0.7, r * 0.7], [r * 0.7, -r * 0.7], [-r * 0.7, -r * 0.7]]) if (townTop(x + dx, z + dz) > ref + 0.7) return true;
    return false;
  };

  /** kinds: subset of 'walk' | 'bld' | 'corr' | 'prop' | 'town' | 'solid'. margins: extra metres per rect kind. */
  const obstacle = (x, z, r, kinds, margins = null, ref = null) => {
    const rk = kinds.filter(k => k === 'walk' || k === 'bld' || k === 'corr');
    if (rk.length) { const h = rects.hit(x, z, r, rk, margins); if (h) return h.kind + ':' + (h.name ?? ''); }
    if (kinds.includes('prop') && propHit(x, z, r)) return 'prop';
    if (kinds.includes('town') && townBlocked(x, z, r, ref ?? groundY(x, z))) return 'town';
    if (kinds.includes('solid') && inStation(x, z)) { const lx = x - ox, lz = z - oz; if (solidAt(lx, lz, r, (ref ?? groundY(x, z)) - oy)) return 'solid'; }
    return null;
  };
  stats.ms = +(performance.now() - t0).toFixed(1); stats.solids = solids.length; stats.riverRows = riverRows; stats.lots = lots.length;
  const ctx = { terrain, island, station, ox, oy, oz, rects, roads, lots, roadDist, groundY, slope, isWater, cover, obstacle, townTop, townBlocked, inStation, stats,
    layout, focus: [[280, 900, 700], [-70, 1058, 420], [176, -1182, 300]] };
  worldBase.scatter = { ...(worldBase.scatter ?? {}), ctx };
  return ctx;
}

/** Distance (m) to the nearest focus (station, Larkhaven, Cairnwick), with that focus' radius; the rules thin out with it. */
export function focusFalloff(ctx, x, z, near = 1, far = 0.07) {
  let best = 1e9;
  for (const [fx, fz, r] of ctx.focus) best = Math.min(best, Math.max(0, Math.hypot(x - fx, z - fz) - r));
  return { d: best, k: near + (far - near) * smooth(0, 1800, best) };
}
