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

const GLSL_COMMON = /* glsl */`
varying vec3 vWxPos;
uniform float uWx;
uniform vec3 uWxGrime;     // height, strength, -
uniform vec4 uWxRain;      // strength, period, fade, stripesPerMetre
uniform float uWxStretch;
uniform vec4 uWxBlotch;    // lightLow, lightMid, hue, sat
uniform vec3 uWxFreq;      // low, mid, vertical gradient (+-)
uniform vec4 uWxEdge;      // lift, desat, fadeStart, fadeEnd
uniform vec3 uWxTintA; uniform vec3 uWxTintB;
uniform sampler2D uWxGround;
uniform vec4 uWxGroundRect; // minX, minZ, 1/sizeX, 1/sizeZ (world)
uniform vec3 uWxOrigin;     // station root position
uniform vec4 uWxRects[16];  // world minX, minZ, maxX, maxZ
uniform float uWxRectCount;
uniform float uWxClass;
float wxHash(vec2 p){ vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
float wxNoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0 - 2.0*f);
  return mix(mix(wxHash(i), wxHash(i + vec2(1.0,0.0)), f.x), mix(wxHash(i + vec2(0.0,1.0)), wxHash(i + vec2(1.0,1.0)), f.x), f.y); }
`;

const GLSL_BODY = /* glsl */`
#include <normal_fragment_maps>
if (uWx > 0.0) {
  vec3 wxP = vWxPos;
  vec3 wxN = normalize((vec4(normalize(vNormal), 0.0) * viewMatrix).xyz);
  float wxWall = 1.0 - smoothstep(0.45, 0.8, abs(wxN.y));
  float wxSeed = 0.0, wxTone = 0.0;
  for (int i = 0; i < 16; i++) {
    if (float(i) >= uWxRectCount) break;
    vec4 r = uWxRects[i];
    if (wxP.x > r.x - 0.6 && wxP.x < r.z + 0.6 && wxP.z > r.y - 0.6 && wxP.z < r.w + 0.6) { wxSeed = float(i) * 13.37 + 3.1; wxTone = fract(float(i) * 0.618); break; }
  }
  vec2 gUv = (wxP.xz - uWxGroundRect.xy) * uWxGroundRect.zw;
  float wxGround = texture2D(uWxGround, clamp(gUv, 0.0, 1.0)).r + uWxOrigin.y;
  float wxH = max(wxP.y - wxGround, 0.0);
  float wxU = dot(wxP.xz, vec2(-wxN.z, wxN.x));
  vec2 wxPc = mix(wxP.xz, vec2(wxU, wxP.y), wxWall);
  float wxK = uWx * uWxClass;
  vec3 wxC = diffuseColor.rgb;
  // 3 blotches: lightness, a warm/cool tilt and saturation
  float b1 = smoothstep(0.12, 0.88, wxNoise(wxPc * uWxFreq.x + wxSeed)), b2 = smoothstep(0.12, 0.88, wxNoise(wxPc * uWxFreq.y + wxSeed * 2.1 + 7.0));
  float wxL = 1.0 + ((b1 - 0.5) * uWxBlotch.x + (b2 - 0.5) * uWxBlotch.y) * 2.0 * wxK;
  vec3 wxTilt = mix(vec3(1.03, 1.0, 0.94), vec3(0.96, 0.99, 1.03), b1);
  wxC = mix(wxC, wxC * wxTilt, uWxBlotch.z * 4.0 * wxK);
  float wxLum = dot(wxC, vec3(0.2126, 0.7152, 0.0722));
  wxC = mix(vec3(wxLum), wxC, 1.0 + (b2 - 0.5) * 2.0 * uWxBlotch.w * wxK);
  wxC *= wxL * (1.0 + (smoothstep(0.0, 14.0, wxH) - 0.35) * uWxFreq.z * wxWall * wxK);
  // 1 wall foot grime
  float wxG = pow(1.0 - smoothstep(0.0, uWxGrime.x, wxH), 1.6) * (0.65 + 0.7 * wxNoise(vec2(wxU * 2.3, wxP.y * 1.4) + wxSeed)) * wxWall;
  vec3 wxDirt = mix(uWxTintA, uWxTintB, wxTone);
  wxC = mix(wxC, wxC * wxDirt, clamp(wxG * uWxGrime.y, 0.0, 0.7) * wxK);
  // 2 rain streaks under each storey ledge
  float wxCol = floor(wxU * uWxRain.w);
  float wxOff = wxHash(vec2(wxCol, wxSeed)) * uWxRain.y * 0.5;
  float wxD = mod(wxH + wxOff, uWxRain.y);
  float wxS = wxNoise(vec2(wxU * uWxRain.w + wxSeed, wxP.y * uWxStretch)) * 0.65 + wxNoise(vec2(wxU * uWxRain.w * 2.7 + 5.1, wxP.y * uWxStretch * 1.7)) * 0.35;
  float wxStreak = smoothstep(0.42, 0.7, wxS) * exp(-wxD * uWxRain.z);
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
    shader.vertexShader = v.replace('#include <common>', '#include <common>\nvarying vec3 vWxPos;')
      .replace('#include <project_vertex>', `#include <project_vertex>
        { vec4 wxw = vec4(transformed, 1.0);
          #ifdef USE_INSTANCING
            wxw = instanceMatrix * wxw;
          #endif
          vWxPos = (modelMatrix * wxw).xyz; }`);
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
  const rects = [];
  for (const p of city.placements) rects.push(new THREE.Vector4(p.footprint.minX + o.x, p.footprint.minZ + o.z, p.footprint.maxX + o.x, p.footprint.maxZ + o.z));
  for (const p of skyline.placements) { const r = p.footprint.localBounds; rects.push(new THREE.Vector4(r.minX + o.x, r.minZ + o.z, r.maxX + o.x, r.maxZ + o.z)); }
  while (rects.length < 16) rects.push(new THREE.Vector4(1e9, 1e9, 1e9, 1e9));
  const scale = params.timeScale[timeOfDay] ?? 1;
  const uniforms = {
    uWx: { value: scale },
    uWxGrime: { value: new THREE.Vector3(params.grime.height, params.grime.strength, 0) },
    uWxRain: { value: new THREE.Vector4(params.rain.strength, params.rain.period, params.rain.fade, params.rain.stripesPerMetre) },
    uWxStretch: { value: params.rain.stretch },
    uWxBlotch: { value: new THREE.Vector4(params.blotch.lightLow, params.blotch.lightMid, params.blotch.hue, params.blotch.sat) },
    uWxFreq: { value: new THREE.Vector3(params.blotch.lowFreq, params.blotch.midFreq, params.blotch.vertical) },
    uWxEdge: { value: new THREE.Vector4(params.edge.lift, params.edge.desat, params.edge.fadeStart, params.edge.fadeEnd) },
    uWxTintA: { value: hex(params.grime.tints[0]) }, uWxTintB: { value: hex(params.grime.tints[1]) },
    uWxGround: { value: ground.texture }, uWxGroundRect: { value: ground.rect },
    uWxOrigin: { value: o.clone() }, uWxRects: { value: rects }, uWxRectCount: { value: Math.min(16, city.placements.length + skyline.placements.length) },
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
  const clones = new Map(), swaps = [], counts = { wall: 0, prop: 0, atlas: 0 };
  scene.traverse(mesh => {
    if (!mesh.isMesh) return;
    const list = [].concat(mesh.material), next = list.map(m => {
      const cls = classify(m, mesh);
      if (!cls) return m;
      let c = clones.get(m);
      if (!c) { c = cloneOwned(m); patchMaterial(c, uniforms, params.classScale[cls]); clones.set(m, c); counts[cls]++; }
      return c;
    });
    if (next.some((m, i) => m !== list[i])) { swaps.push([mesh, mesh.material]); mesh.material = Array.isArray(mesh.material) ? next : next[0]; }
  });
  let disposed = false;
  const api = {
    uniforms, stats: { materials: clones.size, meshes: swaps.length, classes: counts, groundSamples: ground.samples, buildingSeeds: uniforms.uWxRectCount.value,
      extraDrawCalls: 0, noiseTaps: 'blotch 2 + grime 1 + rain 2 (2D value noise) + 1 height texture + 6 derivatives/fragment on patched materials' },
    wallMaterials: new Set(clones.values()),
    setEnabled(on) { uniforms.uWx.value = on ? scale : 0; },
    dispose() {
      if (disposed) return; disposed = true;
      for (const [mesh, original] of swaps) mesh.material = original;
      for (const c of clones.values()) c.dispose();
      ground.texture.dispose();
    },
  };
  return api;
}
