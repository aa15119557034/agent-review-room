import * as THREE from 'three';

// Round 22 (#254 X-51): one shared "clean old" patch for opaque static surfaces. Every material it
// touches is cloned and owned here (the station/city caches are only prototypes), the meshes are
// re-pointed at the clones, and dispose() restores the originals.
//
//  1 wall foot grime   world height above the terrain (baked height texture, foundations included)
//  2 rain streaks      vertical stripes that start under each storey ledge and fade downwards
//  3 blotches          low + mid frequency world noise on lightness, hue and saturation, per-building seed
//  4 edge wear         fwidth(vNormal) at convex creases: lift + desaturate, fades with distance
// Poster / sticker decals live in weathering-decals.js.
//
// Round 23 cost cuts: noise comes from two small tiling textures (one fetch gives four decorrelated
// values) instead of procedural value noise; the building seed is one uniform per mesh instead of a
// 16-rect search per fragment; the rain streak lost its second noise; the per-vertex mask is welded by
// position so it varies smoothly instead of stepping at triangle edges.

const GLSL_COMMON = /* glsl */`
varying vec3 vWxPos;
varying vec3 vWxMask;
uniform float uWx;
uniform vec3 uWxGrime;     // height, strength, -
uniform vec4 uWxRain;      // strength, period, columnSkip (0..1), stripesPerMetre
uniform float uWxStretch;
uniform vec4 uWxBlotch;    // lightLow, lightMid, hue, sat
uniform vec3 uWxFreq;      // low, mid, vertical gradient (+-)
uniform vec4 uWxEdge;      // lift, desat, fadeStart, fadeEnd
uniform vec3 uWxTintA; uniform vec3 uWxTintB;
uniform sampler2D uWxGround;
uniform vec4 uWxGroundRect; // minX, minZ, 1/sizeX, 1/sizeZ (world)
uniform vec3 uWxOrigin;     // station root position
uniform sampler2D uWxNoise; // 256x256 tiling smooth value noise, 4 independent channels, 16 lattice cells per tile
uniform sampler2D uWxWhite; // 64x64 white noise, nearest, 4 channels
uniform float uWxClass;
vec4 wxTex(vec2 p){ return texture2D(uWxNoise, p * 0.0625); }
vec4 wxCell(vec2 c){ return texture2D(uWxWhite, (mod(c, 64.0) + 0.5) * 0.015625); }
`;

const GLSL_BODY = /* glsl */`
#include <normal_fragment_maps>
if (uWx > 0.0 && vWxMask.x > 0.01) {
  vec3 wxP = vWxPos;
  vec3 wxN = normalize((vec4(normalize(vNormal), 0.0) * viewMatrix).xyz);
  float wxWall = 1.0 - smoothstep(0.45, 0.8, abs(wxN.y));
  float wxSeed = vWxMask.y, wxTone = vWxMask.z;
  vec2 gUv = (wxP.xz - uWxGroundRect.xy) * uWxGroundRect.zw;
  float wxGround = texture2D(uWxGround, clamp(gUv, 0.0, 1.0)).r + uWxOrigin.y;
  float wxH = max(wxP.y - wxGround, 0.0);
  float wxU = dot(wxP.xz, vec2(-wxN.z, wxN.x));
  vec2 wxPc = mix(wxP.xz, vec2(wxU, wxP.y), wxWall);
  float wxK = uWx * uWxClass * vWxMask.x;
  vec3 wxC = diffuseColor.rgb;
  // 3 blotches: lightness, a warm/cool tilt and saturation
  vec4 wxT1 = wxTex(wxPc * uWxFreq.x + wxSeed), wxT2 = wxTex(wxPc * uWxFreq.y + wxSeed * 2.1 + 7.0);
  float b1 = smoothstep(0.12, 0.88, wxT1.r), b2 = smoothstep(0.12, 0.88, wxT2.r);
  float wxL = 1.0 + ((b1 - 0.5) * uWxBlotch.x + (b2 - 0.5) * uWxBlotch.y) * 2.0 * wxK;
  vec3 wxTilt = mix(vec3(1.03, 1.0, 0.94), vec3(0.96, 0.99, 1.03), b1);
  wxC = mix(wxC, wxC * wxTilt, uWxBlotch.z * 4.0 * wxK);
  float wxLum = dot(wxC, vec3(0.2126, 0.7152, 0.0722));
  wxC = mix(vec3(wxLum), wxC, 1.0 + (0.5 - b1) * 2.0 * uWxBlotch.w * wxK);
  wxC *= wxL * (1.0 + (smoothstep(0.0, 14.0, wxH) - 0.35) * uWxFreq.z * wxWall * wxK);
  // 1 wall foot grime
  float wxG = pow(1.0 - smoothstep(0.0, uWxGrime.x, wxH), 1.25) * (0.8 + 0.4 * wxT2.b) * wxWall;
  vec3 wxDirt = mix(uWxTintA, uWxTintB, wxTone);
  wxC = mix(wxC, wxC * wxDirt, clamp(wxG * uWxGrime.y, 0.0, 1.0) * wxK);
  // 2 rain streaks: start under each storey slab / sill line, one narrow stripe per column, own length per stripe
  float wxF = wxU * uWxRain.w, wxCol = floor(wxF), wxCu = fract(wxF);
  vec4 wxR = wxCell(vec2(wxCol, wxSeed * 0.37));
  float wxOff = wxR.r * 0.18;
  float wxStorey = floor((wxH + wxOff) / uWxRain.y);
  float wxD = (wxStorey + 1.0) * uWxRain.y - (wxH + wxOff); // metres below the slab / sill line above
  vec4 wxS = wxCell(vec2(wxCol + wxStorey * 7.0, wxSeed * 0.37 + 31.0));
  float wxLen = mix(0.8, 2.4, wxS.g);
  float wxCentre = 0.5 + (wxR.g - 0.5) * 0.3;
  float wxWob = sin(wxP.y * 2.1 + wxR.b * 6.283) * 0.07;
  float wxLat = 1.0 - smoothstep(0.12, 0.25, abs(wxCu - wxCentre - wxWob));
  float wxStreak = step(uWxRain.z, wxS.r) * wxLat * exp(-wxD / wxLen * 2.4) * smoothstep(0.0, 0.05, wxD) * (0.65 + 0.35 * wxT2.g);
  wxC *= 1.0 - uWxRain.x * wxStreak * wxWall * wxK;
  // 4 convex edge wear
  float wxEd = smoothstep(0.12, 0.5, length(fwidth(vNormal)));
  float wxCv = step(0.0, dot(dFdx(vNormal), dFdx(wxP)) + dot(dFdy(vNormal), dFdy(wxP)));
  float wxFade = 1.0 - smoothstep(uWxEdge.z, uWxEdge.w, length(cameraPosition - wxP));
  float wxE = wxEd * wxCv * wxFade * wxK;
  float wxLum2 = dot(wxC, vec3(0.2126, 0.7152, 0.0722));
  wxC = mix(wxC, mix(vec3(wxLum2), wxC, 1.0 - uWxEdge.y) * (1.0 + uWxEdge.x), wxE);
  diffuseColor.rgb = wxC;
}
`;

const hex = (v) => new THREE.Color(v[0], v[1], v[2]);

function patchMaterial(material, uniforms, wxClass) {
  const prev = material.onBeforeCompile, prevKey = material.customProgramCacheKey;
  const own = { value: wxClass };
  material.userData.wxClass = own;
  material.onBeforeCompile = (shader, renderer) => {
    prev?.call(material, shader, renderer);
    for (const name of Object.keys(uniforms)) shader.uniforms[name] = uniforms[name];
    shader.uniforms.uWxClass = own;
    const v = shader.vertexShader, f = shader.fragmentShader;
    if (!v.includes('#include <project_vertex>') || !f.includes('#include <normal_fragment_maps>') || !f.includes('#include <common>')) {
      throw new Error('Weathering: shader chunks missing for ' + material.type);
    }
    shader.vertexShader = v.replace('#include <common>', '#include <common>\nvarying vec3 vWxPos;\nvarying vec3 vWxMask;\nattribute vec3 wxMask;')
      .replace('#include <project_vertex>', `#include <project_vertex>
        { vec4 wxw = vec4(transformed, 1.0);
          #ifdef USE_INSTANCING
            wxw = instanceMatrix * wxw;
          #endif
          vWxPos = (modelMatrix * wxw).xyz; vWxMask = wxMask; }`);
    shader.fragmentShader = f.replace('#include <common>', '#include <common>\n' + GLSL_COMMON)
      .replace('#include <normal_fragment_maps>', GLSL_BODY);
  };
  material.customProgramCacheKey = () => (prevKey ? prevKey.call(material) : '') + '|weathering22';
  material.needsUpdate = true;
}

function cloneOwned(material) {
  const copy = material.clone();
  copy.onBeforeCompile = material.onBeforeCompile;
  copy.customProgramCacheKey = material.customProgramCacheKey;
  copy.userData = { ...material.userData };
  return copy;
}

// Per-vertex weight (x; y/z carry the per-mesh building seed and tone): 1 on large, thick faces (walls, low walls, foundations, steps), 0 on thin or tiny
// geometry (railing bars, signposts, bike frames, small props). Computed once per mesh from triangle size,
// then welded by position (max over every triangle touching a point), so merged flat-shaded meshes, whose
// triangles do not share vertices, still get one value per point and the weight varies smoothly across
// faces instead of stepping at each triangle edge.
function addMask(geometry, [seed, tone], mesh, vehicleBoxes) {
  if (geometry.getAttribute('wxMask')) return false;
  const pos = geometry.attributes.position, index = geometry.index, count = pos.count, mask = new Float32Array(count * 3);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), ab = new THREE.Vector3(), ac = new THREE.Vector3(), bc = new THREE.Vector3();
  const tris = (index ? index.count : count) / 3, ss = (lo, hi, x) => { const t = Math.min(1, Math.max(0, (x - lo) / (hi - lo))); return t * t * (3 - 2 * t); };
  const keyOf = i => (Math.imul(Math.round(pos.getX(i) * 500), 73856093) ^ Math.imul(Math.round(pos.getY(i) * 500), 19349663) ^ Math.imul(Math.round(pos.getZ(i) * 500), 83492791)) >>> 0;
  const weld = new Map();
  for (let t = 0; t < tris; t++) {
    const i0 = index ? index.getX(t * 3) : t * 3, i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1, i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
    a.fromBufferAttribute(pos, i0); b.fromBufferAttribute(pos, i1); c.fromBufferAttribute(pos, i2);
    ab.subVectors(b, a); ac.subVectors(c, a); bc.subVectors(c, b);
    const area = ab.cross(ac).length() / 2, longest = Math.sqrt(Math.max(ac.lengthSq(), bc.lengthSq(), b.distanceToSquared(a)));
    const thin = longest > 1e-6 ? 2 * area / longest : 0;
    const w = ss(0.11, 0.18, thin) * ss(0.02, 0.08, area);
    for (const i of [i0, i1, i2]) { const k = keyOf(i); if (w > (weld.get(k) ?? -1)) weld.set(k, w); }
  }
  // Vehicles are never weathered. Their bodies are merged into the static batches (no node name survives), so
  // vertices inside a vehicle's volume get weight 0; only meshes whose box meets a vehicle volume are tested.
  let hits = null;
  if (vehicleBoxes.length) {
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    const mb = geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld);
    hits = vehicleBoxes.filter(v => v.intersectsBox(mb));
  }
  const wp = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    if (hits?.length) { wp.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld); if (hits.some(v => v.containsPoint(wp))) { mask[i * 3] = 0; mask[i * 3 + 1] = seed; mask[i * 3 + 2] = tone; continue; } }
    mask[i * 3] = weld.get(keyOf(i)) ?? 0; mask[i * 3 + 1] = seed; mask[i * 3 + 2] = tone;
  }
  geometry.setAttribute('wxMask', new THREE.BufferAttribute(mask, 3));
  return true;
}

// Tiling smooth value noise (4 independent channels) and nearest white noise, both tiny and shared.
function mulberry(seed) { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function makeNoiseTextures() {
  const N = 256, L = 16, r = mulberry(2301), data = new Uint8Array(N * N * 4);
  for (let ch = 0; ch < 4; ch++) {
    const lat = new Float32Array(L * L); for (let i = 0; i < lat.length; i++) lat[i] = r();
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const fx = x / N * L, fy = y / N * L, ix = Math.floor(fx), iy = Math.floor(fy);
      let tx = fx - ix, ty = fy - iy; tx = tx * tx * (3 - 2 * tx); ty = ty * ty * (3 - 2 * ty);
      const v = (i, j) => lat[((j % L) * L) + (i % L)];
      const top = v(ix, iy) + (v(ix + 1, iy) - v(ix, iy)) * tx, bot = v(ix, iy + 1) + (v(ix + 1, iy + 1) - v(ix, iy + 1)) * tx;
      data[(y * N + x) * 4 + ch] = Math.round((top + (bot - top) * ty) * 255);
    }
  }
  const noise = new THREE.DataTexture(data, N, N, THREE.RGBAFormat); noise.name = 'weathering-noise';
  noise.wrapS = noise.wrapT = THREE.RepeatWrapping; noise.minFilter = noise.magFilter = THREE.LinearFilter; noise.generateMipmaps = false; noise.needsUpdate = true;
  const W = 64, wd = new Uint8Array(W * W * 4); for (let i = 0; i < wd.length; i++) wd[i] = Math.floor(r() * 256);
  const white = new THREE.DataTexture(wd, W, W, THREE.RGBAFormat); white.name = 'weathering-white';
  white.wrapS = white.wrapT = THREE.RepeatWrapping; white.minFilter = white.magFilter = THREE.NearestFilter; white.generateMipmaps = false; white.needsUpdate = true;
  return { noise, white };
}

function bakeGround({ island, station, city, params }) {
  const g = params.ground, o = station.root.position, b = station.bounds, cell = g.cell;
  const nx = Math.round((g.maxX - g.minX) / cell), nz = Math.round((g.maxZ - g.minZ) / cell);
  const data = new Uint16Array(nx * nz);
  const stamps = city.placements.filter(p => p.foundation).map(p => ({ r: p.footprint, top: p.foundation.top - o.y }));
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const x = g.minX + (i + 0.5) * cell, z = g.minZ + (j + 0.5) * cell;
    let h = (x > b.x0 && x < b.x1 && z > b.z0 && z < b.z1) ? station.ctx.L.heightAt(x, z) : island.heightAt(x + o.x, z + o.z) - o.y;
    for (const s of stamps) if (x > s.r.minX - 0.1 && x < s.r.maxX + 0.1 && z > s.r.minZ - 0.1 && z < s.r.maxZ + 0.1) h = Math.max(h, s.top);
    data[j * nx + i] = THREE.DataUtils.toHalfFloat(Number.isFinite(h) ? h : 0);
  }
  const texture = new THREE.DataTexture(data, nx, nz, THREE.RedFormat, THREE.HalfFloatType);
  texture.minFilter = texture.magFilter = THREE.LinearFilter;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true; texture.name = 'weathering-ground-height';
  return { texture, rect: new THREE.Vector4(g.minX + o.x, g.minZ + o.z, 1 / (nx * cell), 1 / (nz * cell)), samples: nx * nz };
}

export async function loadWeatheringParams() {
  const response = await fetch(new URL('./weathering.json', import.meta.url));
  if (!response.ok) throw new Error('weathering.json: ' + response.status);
  return response.json();
}

export function applyWeathering({ scene, station, island, city, skyline, params, timeOfDay = 'evening' }) {
  const o = station.root.position;
  const ground = bakeGround({ island, station, city, params });
  // The array position selects the building's dirt tint. Keep the original city and skyline indices.
  const rects = [
    ...city.placements.filter(p => p.type !== 'station-art').map(p => p.footprint),
    ...skyline.placements.map(p => p.footprint.localBounds),
    ...city.placements.filter(p => p.type === 'station-art').map(p => p.footprint),
  ].map(r => new THREE.Vector4(r.minX + o.x, r.minZ + o.z, r.maxX + o.x, r.maxZ + o.z));
  const scale = params.timeScale[timeOfDay] ?? 1;
  const noiseTex = makeNoiseTextures();
  const rectCount = Math.min(16, rects.length);
  const uniforms = {
    uWx: { value: scale },
    uWxGrime: { value: new THREE.Vector3(params.grime.height, params.grime.strength, 0) },
    uWxRain: { value: new THREE.Vector4(params.rain.strength, params.rain.period, params.rain.skip, params.rain.stripesPerMetre) },
    uWxStretch: { value: params.rain.stretch },
    uWxBlotch: { value: new THREE.Vector4(params.blotch.lightLow, params.blotch.lightMid, params.blotch.hue, params.blotch.sat) },
    uWxFreq: { value: new THREE.Vector3(params.blotch.lowFreq, params.blotch.midFreq, params.blotch.vertical) },
    uWxEdge: { value: new THREE.Vector4(params.edge.lift, params.edge.desat, params.edge.fadeStart, params.edge.fadeEnd) },
    uWxTintA: { value: hex(params.grime.tints[0]) }, uWxTintB: { value: hex(params.grime.tints[1]) },
    uWxGround: { value: ground.texture }, uWxGroundRect: { value: ground.rect },
    uWxOrigin: { value: o.clone() },
    uWxNoise: { value: noiseTex.noise }, uWxWhite: { value: noiseTex.white },
  };
  const houses = station.ctx.services.houses.buildContext.M;
  const stationClass = new Map();
  for (const key of params.stationMaps) if (houses[key]?.map) stationClass.set(houses[key].map, 'wall');
  for (const key of params.excludeStationMaps) if (houses[key]?.map) stationClass.set(houses[key].map, 'skip');
  const excludeName = new RegExp(params.excludeName, 'i');
  const roots = { city: city.root, skyline: skyline.root };
  const inRoot = (mesh, root) => { for (let p = mesh; p; p = p.parent) if (p === root) return true; return false; };
  const excludeNode = new RegExp(params.excludeNode, 'i');
  const plantish = mesh => { for (let p = mesh; p; p = p.parent) if (p.name && excludeNode.test(p.name)) return true; return false; };
  const classify = (material, mesh) => {
    if (!(material.isMeshToonMaterial || material.isMeshStandardMaterial) || material.transparent || material.alphaTest > 0) return null;
    if (material.emissive && (material.emissive.r + material.emissive.g + material.emissive.b) > 0.01) return null;
    if (excludeName.test(material.name || '') || material.isShaderMaterial) return null;
    if (material.userData.wbEveningGlow) return null;
    if (material.map && stationClass.has(material.map)) return stationClass.get(material.map) === 'wall' ? 'wall' : null;
    if (material.name?.startsWith('apartment-pbr')) return 'wall';
    if (plantish(mesh)) return null;
    const local = inRoot(mesh, roots.city) || inRoot(mesh, roots.skyline);
    if (material.isMeshToonMaterial && material.vertexColors) return material.map ? 'atlas' : (local ? 'wall' : 'prop');
    return null;
  };
  // One seed per mesh, stored in the mask attribute: the footprint that holds the mesh centre (first match, 0.6 m slack).
  scene.updateMatrixWorld(true);
  const box = new THREE.Box3(), centre = new THREE.Vector3();
  const meshSeed = mesh => {
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    box.copy(mesh.geometry.boundingBox).applyMatrix4(mesh.matrixWorld); box.getCenter(centre);
    for (let i = 0; i < rectCount; i++) { const r = rects[i]; if (centre.x > r.x - 0.6 && centre.x < r.z + 0.6 && centre.z > r.y - 0.6 && centre.z < r.w + 0.6) return [i * 13.37 + 3.1, (i * 0.618) % 1]; }
    return [0, 0];
  };
  const vehicleRe = new RegExp(params.excludeVehicle, 'i'), vehicleBoxes = [];
  scene.traverse(m => {
    if (!m.isMesh) return;
    for (let p = m; p; p = p.parent) if (p.name && vehicleRe.test(p.name)) {
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
      // Cars: widen a little, and reach down to the wheels and up to the roof from the glass band.
      const vb = m.geometry.boundingBox.clone().applyMatrix4(m.matrixWorld);
      vb.min.add(new THREE.Vector3(-0.3, -1.2, -0.3)); vb.max.add(new THREE.Vector3(0.3, 1.0, 0.3)); vehicleBoxes.push(vb); break;
    }
  });
  const maskedGeometries = [], clones = new Map(), swaps = [], counts = { wall: 0, prop: 0, atlas: 0 };
  scene.traverse(mesh => {
    if (!mesh.isMesh) return;
    const list = [].concat(mesh.material), next = list.map(m => {
      const cls = classify(m, mesh);
      if (!cls) return m;
      let c = clones.get(m);
      if (!c) { c = cloneOwned(m); patchMaterial(c, uniforms, params.classScale[cls]); clones.set(m, c); counts[cls]++; }
      return c;
    });
    if (next.some((m, i) => m !== list[i])) { if (addMask(mesh.geometry, meshSeed(mesh), mesh, vehicleBoxes)) maskedGeometries.push(mesh.geometry); swaps.push([mesh, mesh.material]); mesh.material = Array.isArray(mesh.material) ? next : next[0]; }
  });
  let disposed = false;
  const api = {
    uniforms, stats: { vehicleVolumes: vehicleBoxes.length, materials: clones.size, meshes: swaps.length, classes: counts, groundSamples: ground.samples, buildingSeeds: rectCount,
      extraDrawCalls: 0, noiseTaps: '2 tiling-noise fetches (4 channels each) + 1 white-noise fetch x2 + 1 height texture + 6 derivatives/fragment; no loops, no procedural hashing' },
    // The authored laundry portal has its paint baked into COLOR_0. It still physically supports the five original decals.
    wallMaterials: new Set([...clones.values(), city.laundryPortal.material]), vehicleBoxes,
    setEnabled(on) { uniforms.uWx.value = on ? scale : 0; },
    dispose() {
      if (disposed) return; disposed = true;
      for (const [mesh, original] of swaps) mesh.material = original;
      for (const g of maskedGeometries) g.deleteAttribute('wxMask');
      for (const c of clones.values()) c.dispose();
      ground.texture.dispose(); noiseTex.noise.dispose(); noiseTex.white.dispose();
    },
  };
  return api;
}
