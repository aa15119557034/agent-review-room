// Terrain: baked heightfield + CDLOD quadtree mesh + the material that paints meadow, cliff, beach.
import * as THREE from 'three';
import { U, World, shared } from '../core/ctx.js';
import { NOISE, NOISE_TEX, ATMOSPHERE, CLOUD_SHADOW, TERRAIN_LOOKUP, MEADOW, SHADOW, STRIP, TOWN_SHADOW, TOWN_MASK } from '../shaders/common.js';
import { SKY_UNIFORMS } from './sky.js';

// CDLOD. For seams to stay closed, level L may only begin morphing beyond the farthest point any
// level L-1 node can reach: RANGE + LEAF * 2 * sqrt(2) <= 2 * MORPH0 * RANGE. With these numbers
// 150 + 67.9 = 217.9 <= 222.
const GRID = 16;          // cells per node side
const LEAF = 24;          // metres, leaf node size (1.5 m cells)
const LOD_RANGE = 150;    // metres: reach of the finest level
const MORPH0 = 0.74, MORPH1 = 0.97;
const MAX_NODES = 2600;

// createImageBitmap decodes off the main thread and, unlike img.decode(), does not wait on the
// page's rendering loop (which stalls in a hidden or throttled tab)
export async function loadImage(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return createImageBitmap(await res.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
}

export function dataTex(img, { srgb = false, mips = true, aniso = 8, wrap = THREE.ClampToEdgeWrapping } = {}) {
  const t = new THREE.Texture(img);
  t.flipY = false;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.generateMipmaps = mips;
  t.minFilter = mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = wrap;
  t.anisotropy = aniso;
  t.needsUpdate = true;
  return t;
}

function pixels(img, size) {
  const c = document.createElement('canvas');
  c.width = c.height = size || img.width;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0, c.width, c.height);
  return g.getImageData(0, 0, c.width, c.height).data;
}

/** Stack material images into a texture array. */
export async function materialArrays(base) {
  const meta = await (await fetch(`${base}/materials.json`)).json();
  const S = meta.size;
  const L = meta.order.length;
  const col = new Uint8Array(S * S * 4 * L);
  const nrm = new Uint8Array(S * S * 4 * L);
  await Promise.all(meta.order.map(async (name, i) => {
    const [c, n] = await Promise.all([loadImage(`${base}/${name}_c.webp`), loadImage(`${base}/${name}_n.webp`)]);
    col.set(pixels(c, S), i * S * S * 4);
    nrm.set(pixels(n, S), i * S * S * 4);
  }));
  const mk = (data, srgb) => {
    const t = new THREE.DataArrayTexture(data, S, S, L);
    t.format = THREE.RGBAFormat;
    t.type = THREE.UnsignedByteType;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.anisotropy = 8;
    t.needsUpdate = true;
    return t;
  };
  return { color: mk(col, true), normal: mk(nrm, false), mean: meta.order.map((n) => new THREE.Vector3().fromArray(meta.mean[n])) };
}

/** 256px RGBA tileable multi-octave value noise, four independent fields. */
export function makeNoiseTexture() {
  const S = 256;
  const data = new Uint8Array(S * S * 4);
  let seed = 1234567;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let ch = 0; ch < 4; ch++) {
    const acc = new Float32Array(S * S);
    let amp = 0.5, norm = 0;
    for (let oct = 0; oct < 5; oct++) {
      const P = 8 << oct; // lattice period
      const lat = new Float32Array(P * P);
      for (let i = 0; i < lat.length; i++) lat[i] = rnd();
      const cell = S / P;
      for (let y = 0; y < S; y++) {
        const fy = y / cell, iy = Math.floor(fy), ty = fy - iy, sy = ty * ty * (3 - 2 * ty);
        for (let x = 0; x < S; x++) {
          const fx = x / cell, ix = Math.floor(fx), tx = fx - ix, sx = tx * tx * (3 - 2 * tx);
          const a = lat[(iy % P) * P + (ix % P)], b = lat[(iy % P) * P + ((ix + 1) % P)];
          const c = lat[((iy + 1) % P) * P + (ix % P)], d = lat[((iy + 1) % P) * P + ((ix + 1) % P)];
          acc[y * S + x] += amp * (a + (b - a) * sx + ((c + (d - c) * sx) - (a + (b - a) * sx)) * sy);
        }
      }
      norm += amp;
      amp *= 0.5;
    }
    // stretch to full range
    let lo = 1e9, hi = -1e9;
    for (let i = 0; i < acc.length; i++) { const v = acc[i] / norm; if (v < lo) lo = v; if (v > hi) hi = v; }
    for (let i = 0; i < acc.length; i++) data[i * 4 + ch] = Math.round(((acc[i] / norm - lo) / (hi - lo)) * 255);
  }
  const t = new THREE.DataTexture(data, S, S, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return { texture: t, data, size: S };
}

export class Terrain {
  static async load(renderer, base = './assets') {
    const meta = await (await fetch(`${base}/terrain/meta.json`)).json();
    const [buf, splatImg, lightImg, tintImg, mats] = await Promise.all([
      fetch(`${base}/terrain/height.u16`).then((r) => r.arrayBuffer()),
      loadImage(`${base}/terrain/splat.png`),
      loadImage(`${base}/terrain/light.png`),
      loadImage(`${base}/terrain/tint.png`),
      materialArrays(`${base}/textures`),
    ]);
    return new Terrain(renderer, meta, new Uint16Array(buf), splatImg, lightImg, tintImg, mats);
  }

  constructor(renderer, meta, q, splatImg, lightImg, tintImg, mats) {
    this.meta = meta;
    const N = (this.N = meta.n);
    World.size = meta.world;
    World.half = meta.world / 2;
    World.meta = meta;
    this.cell = meta.cell;

    // ---- heights
    const h = (this.h = new Float32Array(N * N));
    const s = (meta.hMax - meta.hMin) / 65535;
    for (let i = 0; i < h.length; i++) h[i] = meta.hMin + q[i] * s;
    const ht = new THREE.DataTexture(h, N, N, THREE.RedFormat, THREE.FloatType);
    ht.internalFormat = 'R32F';
    ht.wrapS = ht.wrapT = THREE.ClampToEdgeWrapping;
    ht.magFilter = THREE.LinearFilter;
    ht.minFilter = THREE.LinearMipmapLinearFilter;
    ht.generateMipmaps = true;
    ht.needsUpdate = true;
    this.heightTex = ht;

    this.splatTex = dataTex(splatImg);
    this.lightTex = dataTex(lightImg);
    this.splatN = splatImg.width;
    this.splat = pixels(splatImg);

    this.tintTex = dataTex(tintImg, { srgb: true });
    U.uHeightTex.value = ht;
    U.uSplatTex.value = this.splatTex;
    U.uLightTex.value = this.lightTex;
    U.uTintTex.value = this.tintTex;
    U.uWorld.value.set(meta.world, 1 / meta.world, 1 / N, Math.log2((LEAF / GRID) / meta.cell));
    U.uSunDir.value.fromArray(meta.sun).normalize();

    this._buildMinMax();
    this._buildMesh(mats);
  }

  // ------------------------------------------------------------------ CPU queries
  /** Fixture integration: one heightfield drives the visible land and walking queries. */
  flattenRect({ minX, maxX, minZ, maxZ, height, blend, surface, approach }) {
    const { cell, N, h } = this;
    // Keep bilinear samples exactly flat up to the requested rectangle's edges.
    minX -= cell; maxX += cell; minZ -= cell; maxZ += cell;
    const x0 = Math.max(0, Math.floor((minX - blend + World.half) / cell));
    const x1 = Math.min(N - 1, Math.ceil((maxX + blend + World.half) / cell));
    const z0 = Math.max(0, Math.floor((minZ - blend + World.half) / cell));
    const z1 = Math.min(N - 1, Math.ceil((maxZ + (approach?.maxBlend ?? blend) + World.half) / cell));
    let changed = 0, originalMin = Infinity, originalMax = -Infinity;
    for (let iz = z0; iz <= z1; iz++) for (let ix = x0; ix <= x1; ix++) {
      const x = (ix + 0.5) * cell - World.half;
      const z = (iz + 0.5) * cell - World.half;
      const distance = Math.hypot(Math.max(minX - x, 0, x - maxX), Math.max(minZ - z, 0, z - maxZ));
      const width = approach ? approach.blendAt(x, z, blend) : blend;
      if (distance >= width) continue;
      const index = iz * N + ix;
      if (distance === 0) { originalMin = Math.min(originalMin, h[index]); originalMax = Math.max(originalMax, h[index]); }
      const t = distance / width;
      const weight = 1 - t * t * (3 - 2 * t);
      const target = surface ? surface(x, z) : height;
      h[index] += (target - h[index]) * weight;
      changed++;
    }
    this.heightTex.needsUpdate = true;
    this._buildMinMax();
    return { changed, originalMin, originalMax, height, blend, conformed: Boolean(surface) };
  }

  /** Bilinear terrain height at world xz. */
  heightAt(x, z) {
    const N = this.N;
    let fx = (x + World.half) / this.cell - 0.5;
    let fz = (z + World.half) / this.cell - 0.5;
    if (fx < 0) fx = 0; else if (fx > N - 1.001) fx = N - 1.001;
    if (fz < 0) fz = 0; else if (fz > N - 1.001) fz = N - 1.001;
    const ix = fx | 0, iz = fz | 0, tx = fx - ix, tz = fz - iz;
    const h = this.h, i = iz * N + ix;
    const a = h[i], b = h[i + 1], c = h[i + N], d = h[i + N + 1];
    return (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz;
  }

  /** Surface normal (unit) at world xz, sampled over span metres. */
  normalAt(x, z, out, span = 2) {
    const hl = this.heightAt(x - span, z), hr = this.heightAt(x + span, z);
    const hd = this.heightAt(x, z - span), hu = this.heightAt(x, z + span);
    return out.set(hl - hr, 2 * span, hd - hu).normalize();
  }

  /** Splat lookup: [flower density, species, wetness, grass cover] in 0..1. */
  splatAt(x, z, out) {
    const S = this.splatN;
    let ix = ((x + World.half) / World.size * S) | 0;
    let iz = ((z + World.half) / World.size * S) | 0;
    ix = ix < 0 ? 0 : ix >= S ? S - 1 : ix;
    iz = iz < 0 ? 0 : iz >= S ? S - 1 : iz;
    const i = (iz * S + ix) * 4;
    out[0] = this.splat[i] / 255; out[1] = this.splat[i + 1] / 255; out[2] = this.splat[i + 2] / 255; out[3] = this.splat[i + 3] / 255;
    return out;
  }

  /** March a ray against the heightfield. Returns distance or -1. */
  raycast(ox, oy, oz, dx, dy, dz, maxDist, step = 1.5) {
    let t = 0, prev = oy - Math.max(this.heightAt(ox, oz), 0);
    if (prev < 0) return 0;
    while (t < maxDist) {
      const st = Math.max(step, prev * 0.5);
      const nt = Math.min(t + st, maxDist);
      const x = ox + dx * nt, y = oy + dy * nt, z = oz + dz * nt;
      const d = y - Math.max(this.heightAt(x, z), 0);
      if (d < 0) {
        // refine
        let a = t, b = nt;
        for (let i = 0; i < 6; i++) {
          const m = (a + b) / 2;
          const dm = oy + dy * m - Math.max(this.heightAt(ox + dx * m, oz + dz * m), 0);
          if (dm < 0) b = m; else a = m;
        }
        return (a + b) / 2;
      }
      prev = d; t = nt;
      if (nt >= maxDist) break;
    }
    return -1;
  }

  // ------------------------------------------------------------------ quadtree
  _buildMinMax() {
    const N = this.N, cell = this.cell;
    const n0 = Math.round(World.size / LEAF);
    this.levels = Math.round(Math.log2(n0)) + 1;
    this.mm = [];
    const per = LEAF / cell; // samples per leaf side
    const mn0 = new Float32Array(n0 * n0), mx0 = new Float32Array(n0 * n0);
    for (let nz = 0; nz < n0; nz++) {
      for (let nx = 0; nx < n0; nx++) {
        let lo = 1e9, hi = -1e9;
        const z0 = Math.max(0, Math.floor(nz * per) - 1), z1 = Math.min(N - 1, Math.ceil((nz + 1) * per) + 1);
        const x0 = Math.max(0, Math.floor(nx * per) - 1), x1 = Math.min(N - 1, Math.ceil((nx + 1) * per) + 1);
        for (let z = z0; z <= z1; z++) {
          const row = z * N;
          for (let x = x0; x <= x1; x++) { const v = this.h[row + x]; if (v < lo) lo = v; if (v > hi) hi = v; }
        }
        mn0[nz * n0 + nx] = lo; mx0[nz * n0 + nx] = hi;
      }
    }
    this.mm.push({ n: n0, mn: mn0, mx: mx0 });
    for (let l = 1; l < this.levels; l++) {
      const p = this.mm[l - 1], n = p.n >> 1;
      const mn = new Float32Array(n * n), mx = new Float32Array(n * n);
      for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) {
        const a = (z * 2) * p.n + x * 2, b = a + 1, c = a + p.n, d = c + 1;
        mn[z * n + x] = Math.min(p.mn[a], p.mn[b], p.mn[c], p.mn[d]);
        mx[z * n + x] = Math.max(p.mx[a], p.mx[b], p.mx[c], p.mx[d]);
      }
      this.mm.push({ n, mn, mx });
    }
  }

  _buildMesh(mats) {
    const verts = new Float32Array((GRID + 1) * (GRID + 1) * 3);
    let k = 0;
    for (let z = 0; z <= GRID; z++) for (let x = 0; x <= GRID; x++) { verts[k++] = x / GRID; verts[k++] = z / GRID; verts[k++] = 0; }
    const idx = new Uint16Array(GRID * GRID * 6);
    k = 0;
    for (let z = 0; z < GRID; z++) for (let x = 0; x < GRID; x++) {
      const a = z * (GRID + 1) + x, b = a + 1, c = a + GRID + 1, d = c + 1;
      // alternate the diagonal so the morph stays symmetric
      if ((x + z) & 1) { idx[k++] = a; idx[k++] = c; idx[k++] = b; idx[k++] = b; idx[k++] = c; idx[k++] = d; }
      else { idx[k++] = a; idx[k++] = c; idx[k++] = d; idx[k++] = a; idx[k++] = d; idx[k++] = b; }
    }
    this.gridPos = new THREE.BufferAttribute(verts, 3);
    this.gridIdx = new THREE.BufferAttribute(idx, 1);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        ...shared(...SKY_UNIFORMS, 'uTime', 'uHeightTex', 'uSplatTex', 'uLightTex', 'uTintTex', 'uWorld', 'uNoiseTex', 'uShadowTex', 'uShadowMat', 'uShadowOn', 'uWakeTex', 'uWake', 'uStripTex',
          'uTownSh0', 'uTownSh1', 'uTownShM0', 'uTownShM1', 'uTownShP', 'uTownMask0', 'uTownMask1', 'uTownRect0', 'uTownRect1'),
        uGrid: { value: GRID },
        uLodRange: { value: LOD_RANGE },
        uLodAlt: { value: 0 },
        uMatC: { value: mats.color },
        uMatN: { value: mats.normal },
        uMean: { value: mats.mean },
        uGrassFade: { value: new THREE.Vector2(60, 150) },
        uClipY: { value: 0 },
        uSeaSetup: U.uSeaSetup,
        uBeachExit: { value: new THREE.Vector2(1e8, 1e8) }, uInlandBank: {value:null}, uBasinLevels:{value:new THREE.Vector4()},
        uStationCutout: { value: new THREE.Vector4() },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
    });
    this.views = [];
    this.mainView = this.addView();
  }

  /** A view = its own instance list (main camera, reflection camera, ...). */
  addView(lodScale = 1) {
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', this.gridPos);
    geo.setIndex(this.gridIdx);
    const arr = new Float32Array(MAX_NODES * 4);
    const attr = new THREE.InstancedBufferAttribute(arr, 4);
    attr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aNode', attr);
    geo.instanceCount = 0;
    const mesh = new THREE.Mesh(geo, this.material);
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    const view = { mesh, geo, attr, arr, lodScale, count: 0 };
    this.views.push(view);
    return view;
  }

  /** Select quadtree nodes for a camera into a view's instance buffer. */
  select(view, camera, lodRange = LOD_RANGE) {
    const fr = (this._fr ||= new THREE.Frustum());
    const m = (this._m ||= new THREE.Matrix4());
    m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    fr.setFromProjectionMatrix(m, camera.coordinateSystem, camera.reversedDepth);
    const box = (this._box ||= new THREE.Box3());
    const cam = camera.getWorldPosition((this._cp ||= new THREE.Vector3()));
    const arr = view.arr;
    let count = 0;
    const half = World.half;
    const off = 0.5 * this.cell; // put level-0 vertices on texel centres
    const range = lodRange * view.lodScale;
    const top = this.levels - 1;

    // The LOD metric must be the same on both sides of every node edge or cracks open, so it uses
    // only the horizontal distance plus one per-frame altitude term - never the (mip-dependent) height.
    const alt = Math.max(0, cam.y - Math.max(this.heightAt(cam.x, cam.z), 0) - 60) * 0.7;
    this.material.uniforms.uLodAlt.value = alt;
    const dist2 = (x0, z0, size) => {
      const dx = cam.x < x0 ? x0 - cam.x : cam.x > x0 + size ? cam.x - x0 - size : 0;
      const dz = cam.z < z0 ? z0 - cam.z : cam.z > z0 + size ? cam.z - z0 - size : 0;
      return dx * dx + dz * dz + alt * alt;
    };

    const visit = (level, nx, nz) => {
      const L = this.mm[level];
      const size = LEAF * (1 << level);
      const x0 = nx * size - half, z0 = nz * size - half;
      const hi = L.mx[nz * L.n + nx];
      if (hi < -6) return; // deep sea floor: the water is opaque there
      // mip-filtered heights can stray outside this node's own range near cliffs: cull with the parent's
      const Lp = this.mm[Math.min(level + 1, top)], sh = level < top ? 1 : 0;
      const pi = (nz >> sh) * Lp.n + (nx >> sh);
      box.min.set(x0 - 2, Lp.mn[pi] - 3, z0 - 2);
      box.max.set(x0 + size + 2, Lp.mx[pi] + 3, z0 + size + 2);
      if (!fr.intersectsBox(box)) return;
      const r = range * (1 << level);
      if (level > 0) {
        const rPrev = r * 0.5;
        if (dist2(x0, z0, size) < rPrev * rPrev) {
          visit(level - 1, nx * 2, nz * 2); visit(level - 1, nx * 2 + 1, nz * 2);
          visit(level - 1, nx * 2, nz * 2 + 1); visit(level - 1, nx * 2 + 1, nz * 2 + 1);
          return;
        }
      }
      if (count >= MAX_NODES) return;
      const o = count * 4;
      arr[o] = x0 + off; arr[o + 1] = z0 + off; arr[o + 2] = size; arr[o + 3] = level;
      count++;
    };
    visit(top, 0, 0);
    view.count = count;
    view.geo.instanceCount = count;
    view.attr.clearUpdateRanges();
    view.attr.addUpdateRange(0, count * 4);
    view.attr.needsUpdate = true;
    this.material.uniforms.uLodRange.value = range;
    return count;
  }
}

// =====================================================================================
const VERT = /* glsl */`
precision highp float;
attribute vec4 aNode;
uniform float uGrid;
uniform float uLodRange;
uniform float uLodAlt;
uniform vec3 uCamPos;
${TERRAIN_LOOKUP}
varying vec3 vWorld;
void main(){
  float size = aNode.z, level = aNode.w;
  vec2 g = position.xy;
  vec2 xz = aNode.xy + g * size;
  float lod0 = max(level + uWorld.w, 0.0);
  float lod1 = max(level + 1.0 + uWorld.w, 0.0);
  float d = length(vec2(distance(xz, uCamPos.xz), uLodAlt));
  float rEnd = uLodRange * exp2(level);
  float k = clamp((d - rEnd * ${MORPH0}) / (rEnd * ${(MORPH1 - MORPH0).toFixed(2)}), 0.0, 1.0);
  vec2 fr = fract(g * uGrid * 0.5) * 2.0 / uGrid;
  xz -= fr * size * k;
  float h = mix(terrainHLod(xz, lod0), terrainHLod(xz, lod1), k);
  vWorld = vec3(xz.x, h, xz.y);
  gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
}
`;

const FRAG = /* glsl */`
precision highp float;
precision highp sampler2DArray;
varying vec3 vWorld;
uniform float uTime;
uniform sampler2DArray uMatC;
uniform sampler2DArray uMatN;
uniform vec3 uMean[8];
uniform vec2 uGrassFade;
uniform float uClipY;      // 1 in the water-reflection pass: drop everything below sea level
uniform vec4 uStationCutout; // fixture-owned ground: min xz, max xz; zero width disables it
uniform float uSeaSetup;
uniform vec2 uBeachExit;
uniform sampler2D uInlandBank;
uniform vec4 uBasinLevels;
uniform sampler2D uTintTex;
${NOISE}
${NOISE_TEX}
${ATMOSPHERE}
${CLOUD_SHADOW}
${TERRAIN_LOOKUP}
${MEADOW}
${STRIP}

const float L_CLIFF = 0.0, L_ROCK = 1.0, L_SCREE = 2.0, L_GROUND = 3.0, L_SAND = 4.0, L_PEB = 5.0, L_COBBLE = 6.0, L_FLAG = 7.0;

struct Mat { vec3 c; float h; vec2 n; float r; };
Mat samp(float layer, vec2 uv, vec2 dx, vec2 dy){
  vec4 c = textureGrad(uMatC, vec3(uv, layer), dx, dy);
  vec4 n = textureGrad(uMatN, vec3(uv, layer), dx, dy);
  Mat m; m.c = c.rgb; m.h = c.a; m.n = n.xy * 2.0 - 1.0; m.r = n.b; return m;
}
Mat mixMat(Mat a, Mat b, float t){
  Mat m; m.c = mix(a.c, b.c, t); m.h = mix(a.h, b.h, t); m.n = mix(a.n, b.n, t); m.r = mix(a.r, b.r, t); return m;
}
// ---- no visible tiling.
// Stochastic sampling (in the manner of Heitz & Neyret's by-example noise and Mikkelsen's hex
// tiling): the plane is cut into a triangle grid a little finer than the texture tile, every grid
// vertex shifts the texture by its own random offset, and each point blends the three copies
// around it. The blend is sharpened and weighted by the material's own height map, so a stone or
// a tuft comes whole from one copy and the seams run along the gaps between them. The tile never
// lines up with itself, however far out you look.
Mat sampS(float layer, vec2 uv, vec2 dx, vec2 dy){
  vec2 st = uv * 2.5;
  vec2 sk = vec2(st.x - 0.57735027 * st.y, 1.15470054 * st.y);
  vec2 id = floor(sk), f = sk - id;
  float z = 1.0 - f.x - f.y;
  float s = step(0.0, -z), s2 = 2.0 * s - 1.0;
  vec3 w = vec3(-z * s2, s - f.y * s2, s - f.x * s2);
  vec2 k = vec2(layer * 17.3, layer * 5.1);
  Mat a = samp(layer, uv + hash22(id + vec2(s, s) + k), dx, dy);
  Mat b = samp(layer, uv + hash22(id + vec2(s, 1.0 - s) + k), dx, dy);
  Mat c = samp(layer, uv + hash22(id + vec2(1.0 - s, s) + k), dx, dy);
  w *= w; w *= w;
  vec3 hh = vec3(a.h, b.h, c.h);
  w *= 0.06 + hh * hh * hh;
  w /= (w.x + w.y + w.z);
  Mat m;
  m.c = a.c * w.x + b.c * w.y + c.c * w.z;
  m.h = dot(hh, w);
  m.n = a.n * w.x + b.n * w.y + c.n * w.z;
  m.r = a.r * w.x + b.r * w.y + c.r * w.z;
  return m;
}
// The noise texture repeats every 256 units of its argument. Two lookups at unrelated scales and
// angles never line up with each other, so nothing built from this one shows a period; the sum is
// stretched back out to the contrast of a single lookup.
vec4 ntexA(vec2 p){
  vec4 a = ntex(p), b = ntex(mat2(0.7986, -0.6018, 0.6018, 0.7986) * p * 0.7317 + 31.7);
  return clamp(0.5 + (a * 0.62 + b * 0.38 - 0.5) * 1.37, 0.0, 1.0);
}
// height-aware blend: the taller material wins near the transition
float hblend(float mask, float hUnder, float hOver, float sharp){
  return saturate((mask * (1.0 + sharp) - (1.0 - hOver) * sharp * (0.5 + 0.5 * hUnder)) );
}
${SHADOW}
${TOWN_SHADOW}
${TOWN_MASK}

void main(){
  vec3 P = vWorld;
  if (uStationCutout.z > uStationCutout.x && all(greaterThanEqual(P.xz, uStationCutout.xy)) && all(lessThanEqual(P.xz, uStationCutout.zw))) discard;
  if (uClipY > 0.5 && P.y < -0.15) discard;
  vec3 toCam = uCamPos - P;
  float dist = length(toCam);
  vec3 V = toCam / dist;
  vec2 uv = worldUV(P.xz);
  vec3 dPx = dFdx(P), dPy = dFdy(P);

  // ---- macro normal from the heightfield
  float fp = max(length(dFdx(uv)), length(dFdy(uv))) / uWorld.z;
  float fpMin = min(length(dFdx(uv)), length(dFdy(uv))) / uWorld.z;
  float lodN = clamp(log2(max(sqrt(fp * fpMin), 1.0)), 0.0, 9.0);
  vec3 N = terrainN(P.xz, lodN);

  vec4 splat = texture(uSplatTex, uv);
  vec4 light = texture(uLightTex, uv);
  float flowers = splat.r, species = splat.g, wet = splat.b;
  float shadowBaked = light.r, ao = light.g, cliffy = light.a;

  // ---- masks
  vec4 nzA = ntexA(P.xz * 1.7);     // ~10 m features
  vec4 nzB = ntexA(P.xz * 9.0);     // ~2 m features
  vec4 nzC = ntexA(P.xz * 34.0);    // ~0.5 m features
  float slope = 1.0 - N.y;
  float rockW = smoothstep(0.235, 0.39, slope + (nzA.r - 0.5) * 0.17 + (nzB.g - 0.5) * 0.10 + (nzC.b - 0.5) * 0.05 + cliffy * 0.10 * smoothstep(0.08, 0.2, slope));
  float lowW = smoothstep(3.7, 2.1, P.y + (nzA.g - 0.5) * 1.4);
  float sandW = lowW * (1.0 - smoothstep(0.25, 0.6, cliffy));
  float pebW = lowW * smoothstep(0.25, 0.6, cliffy);
  // The lower atlas holds wet banks, the upper atlas the four feathered geological districts.
  vec4 bank = texture(uInlandBank,vec2(uv.x,uv.y*0.5));
  vec4 district=texture(uInlandBank,vec2(uv.x,0.5+uv.y*0.5));
  float volcanic=district.r, headland=district.g, badland=district.b, dune=district.a;
  float bareRim=smoothstep(0.10,0.37,slope+(nzA.g-0.5)*0.11);
  rockW=max(rockW,max(volcanic*(0.36+0.64*bareRim),headland*(0.43+0.57*bareRim)));
  rockW=max(rockW,badland*(0.20+0.80*bareRim));
  sandW=max(sandW,dune*(0.84+0.16*nzA.r));
  int basinId=int(clamp(floor(bank.a*255.0/48.0+0.5)-1.0,0.0,3.0));
  float bankHeight=P.y-uBasinLevels[basinId];
  pebW=max(pebW,bank.r); sandW=max(sandW,bank.g);
  float screeW = smoothstep(240.0, 310.0, P.y + (nzA.b - 0.5) * 70.0) * 0.85;
  screeW=max(screeW,volcanic*(0.72+0.28*nzA.r));
  rockW*=1.0-0.995*dune; screeW*=1.0-dune; pebW*=1.0-dune;
  float nearK = 1.0 - smoothstep(uGrassFade.x, uGrassFade.y, dist);

  // ---- meadow floor
  vec2 gUV = P.xz / 2.3;
  Mat mg = samp(L_GROUND, gUV, dPx.xz / 2.3, dPy.xz / 2.3);
  Mat mg2 = sampS(L_GROUND, P.xz / 9.7 + 0.37, dPx.xz / 9.7, dPy.xz / 9.7);
  vec3 tint = meadowTint(P.xz, wet);
  vec3 gDetail = mix(mg.c / uMean[3], mg2.c / uMean[3], 0.45);
  // close up we look between the blades at shaded thatch; far away this stands in for the whole sward
  // grass clinging to steep ground and ledges is short, wind-burnt and darker
  float steepK = max(smoothstep(0.06, 0.24, slope), smoothstep(0.25, 0.8, cliffy) * 0.85);
  tint = mix(tint, vec3(0.135, 0.170, 0.060), steepK * 0.7);
  vec3 swardFar = tint * 1.22 + vec3(0.010, 0.026, 0.0);
  vec3 swardNear = tint * 0.62 * gDetail;
  // seen from afar the sward is tussocks, hollows and wind-combed patches, not a flat wash
  float mott = ntexA(P.xz * 0.55).r * 0.5 + nzA.b * 0.3 + nzB.a * 0.2;
  swardFar *= 0.70 + 0.62 * mott;
  swardFar = mix(swardFar, swardFar * vec3(1.18, 1.10, 0.72), smoothstep(0.55, 0.85, ntex(P.xz * 0.12 + 7.0).g) * 0.5);
  vec3 meadow = mix(swardFar * mix(vec3(1.0), gDetail, 0.35), swardNear, nearK);
  // far-field flowers: confetti that resolves into a wash of colour
  float speck = smoothstep(0.42, 0.62, nzB.b * 0.65 + nzC.a * 0.35);
  // head-on you see the grass between the flowers; at a glancing angle the heads close ranks
  float glance = 1.0 - saturate(dot(V, N));
  float dapple = 0.62 + 0.62 * (ntexA(P.xz * 0.31 + 2.0).b * 0.6 + nzA.r * 0.4);
  float tintAmt = flowers * dapple * mix(0.44, mix(0.50, 0.88, glance * glance), 1.0 - nearK) * mix(0.55 + 0.9 * speck, 1.0, smoothstep(40.0, 260.0, dist));
  // where the wake has torn the petals off there is no flower colour left, only the green
  tintAmt *= 1.0 - strippedFiltered(uv);
  // in a town: streets and squares are paved, and nothing flowers where people walk
  vec4 town = townMask(P.xz);
  tintAmt *= 1.0 - town.a;
  vec3 fcol = texture(uTintTex, uv).rgb;
  meadow = mix(meadow, fcol, saturate(tintAmt));
  Mat m; m.c = meadow; m.h = mg.h; m.n = mg.n * 0.6 * nearK; m.r = 0.92;

  // ---- scree on the high slopes
  if (screeW > 0.002){
    Mat ms = sampS(L_SCREE, P.xz / 3.4, dPx.xz / 3.4, dPy.xz / 3.4);
    ms.c *= vec3(0.80, 0.78, 0.76);
    float ash=dot(ms.c,vec3(0.28,0.54,0.18));
    ms.c=mix(ms.c,ash*mix(vec3(0.47,0.45,0.47),vec3(0.75,0.39,0.225),smoothstep(0.48,0.77,nzA.b))*0.86,volcanic);
    m = mixMat(m, ms, hblend(screeW, m.h, ms.h, 1.2));
  }
  // ---- beach
  // Wind setup and wave run-up leave a broken damp line above the surf.
  float runup = uSeaSetup + 0.12*sin(dot(P.xz, vec2(0.026,0.068)) - uTime*0.53);
  float strand = P.y - runup + (nzA.r-0.5)*0.24;
  float dampMargin=bank.a>0.85 ? bank.b : bank.b*(1.0-smoothstep(0.05,0.43,bankHeight+(nzB.r-0.5)*0.16+(nzC.b-0.5)*0.07));
  float wetLine = max(dampMargin,1.0 - smoothstep(0.14, 0.94, strand));
  if (sandW > 0.002){
    Mat ms = sampS(L_SAND, P.xz / 3.1, dPx.xz / 3.1, dPy.xz / 3.1);
    Mat ms2 = samp(L_SAND, P.xz / 13.0, dPx.xz / 13.0, dPy.xz / 13.0);
    ms.c = mix(ms.c, ms2.c, 0.35) * vec3(1.04, 1.0, 0.94);
    ms.c=mix(ms.c,vec3(0.51,0.405,0.267)*(0.40+0.53*ms.h+0.20*nzB.g),dune);
    float wrack = (1.0-smoothstep(0.04, 0.17, abs(strand-0.94+(nzB.g-0.5)*0.4)))
      * smoothstep(0.42, 0.73, nzC.r*0.6+nzB.b*0.4);
    ms.c *= mix(vec3(1.0),vec3(0.41,0.46,0.51),wetLine) * (1.0-0.45*wrack);
    ms.c *= mix(vec3(1.0),vec3(0.39,0.48,0.35),bank.g);
    ms.r = mix(ms.r, 0.16, wetLine);
    m = mixMat(m, ms, hblend(sandW, m.h, 0.5 + 0.5 * ms.h, 0.6));
  }
  if (pebW > 0.002){
    Mat ms = sampS(L_PEB, P.xz / 1.9, dPx.xz / 1.9, dPy.xz / 1.9);
    ms.c *= mix(1.0, 0.55, wetLine);
    ms.r = mix(0.55, 0.12, wetLine);
    m = mixMat(m, ms, hblend(pebW, m.h, ms.h, 1.0));
  }

  // ---- rock: stratified cliff on the walls, fractured stone where it lies flatter
  vec3 Nw;
  {
    // meadow / beach normal in world space (top projection)
    vec3 t = vec3(m.n.x, 0.0, m.n.y);
    Nw = normalize(N + t * 0.9);
  }
  float rockAmt = 0.0;
  if (rockW > 0.002){
    vec3 b = pow(abs(N), vec3(5.0)); b /= (b.x + b.y + b.z);
    // bedding dips gently east and wanders, matching the ledges cut into the heightfield
    float bed = P.y - P.x * 0.022 + (nzA.a - 0.5) * 3.0;
    const float S1 = 7.5, S2 = 26.0, S3 = 6.0;
    // every bed slides along the wall by its own amount, so the tile's seams never stack up the
    // face (the strata stay level: only the position along the wall shifts)
    float slide = (ntex(vec2(bed * 0.61, 3.3)).r - 0.5) * 11.0 + (ntex(vec2(bed * 2.7, 11.3)).g - 0.5) * 3.0;
    vec2 uvx = vec2(P.z + slide, bed), uvz = vec2(P.x + slide, bed);
    vec2 dxx = vec2(dPx.z, dPx.y - dPx.x * 0.022), dyx = vec2(dPy.z, dPy.y - dPy.x * 0.022);
    vec2 dxz = vec2(dPx.x, dPx.y - dPx.x * 0.022), dyz = vec2(dPy.x, dPy.y - dPy.x * 0.022);
    float farK = smoothstep(30.0, 220.0, dist);
    // stratigraphy: thick units of thin-bedded dark shale alternate with massive pale sandstone
    float lateral = ntex(P.xz * 0.045 + 3.0).g;
    float unitN = ntex(vec2(bed * 0.42 + 11.0, 5.5 + lateral * 3.0)).g + (nzB.r - 0.5) * 0.10;
    float unit = smoothstep(0.44, 0.56, unitN);
    Mat cx = samp(L_CLIFF, uvx / S1, dxx / S1, dyx / S1);
    Mat cz = samp(L_CLIFF, uvz / S1, dxz / S1, dyz / S1);
    Mat cx2 = samp(L_CLIFF, uvx / S2 + 0.31, dxx / S2, dyx / S2);
    Mat cz2 = samp(L_CLIFF, uvz / S2 + 0.31, dxz / S2, dyz / S2);
    cx = mixMat(cx, cx2, 0.35 + 0.45 * farK);
    cz = mixMat(cz, cz2, 0.35 + 0.45 * farK);
    Mat sx = sampS(L_ROCK, uvx / S3, dxx / S3, dyx / S3);
    Mat sz = sampS(L_ROCK, uvz / S3, dxz / S3, dyz / S3);
    Mat ry = sampS(L_ROCK, P.xz / 5.2, dPx.xz / 5.2, dPy.xz / 5.2);
    float wsum = max(b.x + b.z, 1e-4);
    // shale: dark, finely layered
    vec3 shaleC = (cx.c * b.x + cz.c * b.z) / wsum;
    shaleC = mix(vec3(dot(shaleC, vec3(0.333))), shaleC, 0.7) * 1.42;
    float shaleH = (cx.h * b.x + cz.h * b.z) / wsum;
    vec2 shaleNx = cx.n, shaleNz = cz.n;
    // sandstone: paler, blocky, stained warm
    vec3 sandC = (sx.c * b.x + sz.c * b.z) / wsum * vec3(0.56, 0.50, 0.42);
    float sandH = (sx.h * b.x + sz.h * b.z) / wsum;
    // thin partings inside the sandstone so it still reads as bedded
    float parting = smoothstep(0.80, 0.92, ntex(vec2(bed * 4.3, 23.0)).b);
    sandC *= 1.0 - 0.45 * parting;
    vec3 wallC = mix(shaleC, sandC, unit);
    float wallH = mix(shaleH, sandH, unit);
    float wallR = mix(0.62, 0.86, unit);
    vec2 wnx = mix(shaleNx * 1.6, sx.n * 1.3, unit), wnz = mix(shaleNz * 1.6, sz.n * 1.3, unit);
    // slow variation: bed-to-bed tone, lichen-grey and rust blotches, rain streaks
    float bandC = ntex(vec2(bed * 3.3 + 7.0, 17.0)).b;
    vec4 blotch = ntex(vec2(P.x + P.z, P.y * 1.6) * 0.21 + 9.0);
    wallC *= (0.86 + 0.28 * bandC) * mix(vec3(0.82, 0.85, 0.90), vec3(1.16, 1.06, 0.94), blotch.r);
    float streak = ntex(vec2((P.x + P.z) * 1.9, P.y * 0.11)).a;
    wallC *= mix(0.70, 1.06, smoothstep(0.25, 0.7, streak));
    // the lip of each bed catches light, the underside is in shadow: fake bevel from the bedding height
    wallC *= 0.80 + 0.40 * wallH;

    vec3 topC = ry.c * vec3(0.50, 0.48, 0.45);
    float side = saturate((b.x + b.z) * 1.4);
    vec3 rc = mix(topC, wallC, side);
    float rh = mix(ry.h, wallH, side);
    float rr = mix(0.85, wallR, side);
    // sea-stained foot of the cliff: dark, wet, a little green
    float tide = smoothstep(9.0, 0.6, P.y + (nzA.r - 0.5) * 5.0);
    rc = mix(rc, rc * vec3(0.34, 0.40, 0.36), tide * 0.85);
    rr = mix(rr, 0.22, tide * smoothstep(3.0, 0.3, P.y));
    // lichen and moss creeping over rock that is not quite vertical
    float moss = smoothstep(0.45, 0.72, nzB.r * 0.6 + nzA.b * 0.4) * smoothstep(0.62, 0.30, slope) * (1.0 - tide);
    rc = mix(rc, vec3(0.16, 0.22, 0.06) * (0.7 + 0.6 * rh), moss * 0.7);

    // whiteout triplanar normals
    vec3 tny = vec3(ry.n, 1.0);
    vec3 nx = vec3(0.0, wnx.y, wnx.x);   // u->z, v->y
    vec3 nz = vec3(wnz.x, wnz.y, 0.0);   // u->x, v->y
    vec3 ny = vec3(tny.x, 0.0, tny.y);
    vec3 rn = normalize(N + nx * b.x + nz * b.z + ny * b.y);

    rockAmt = hblend(rockW, m.h, rh, 0.9);
    m.c = mix(m.c, rc, rockAmt);
    m.r = mix(m.r, rr, rockAmt);
    m.h = mix(m.h, rh, rockAmt);
    Nw = normalize(mix(Nw, rn, rockAmt));
  }

  // Deposits share the grain and relief of the native materials. Strata follow
  // elevation and bedding dip, while the cinder seams run down the cone.
  float grain=0.57+0.48*m.h+0.19*(nzB.b-0.5)+0.11*(nzC.a-0.5);
  if(volcanic>0.0){
    float cinder=ntexA(P.xz*0.17+vec2(P.y*0.13,0.0)).b*0.62+nzA.r*0.38;
    vec3 lava=mix(vec3(0.139,0.140,0.147),vec3(0.248,0.161,0.119),smoothstep(0.44,0.71,cinder));
    vec2 cone=(P.xz-vec2(951.,-80.))/vec2(343.,290.);
    float angle=atan(cone.y,cone.x), radius=length(cone);
    float ribbons=abs(sin(3.0*angle+radius*3.6+0.42*sin(7.0*angle)+nzA.r*0.18));
    float flow=(1.-smoothstep(0.06,0.24,ribbons))*smoothstep(0.34,0.53,radius);
    lava=mix(lava,vec3(0.075,0.087,0.101),flow*0.72);
    float ashFloor=(1.-smoothstep(0.13,0.31,radius))*smoothstep(0.23,0.69,nzA.g);
    lava=mix(lava,vec3(0.32,0.28,0.25),ashFloor*0.8);
    m.c=mix(m.c,lava*grain,volcanic*(0.66+0.24*bareRim));
  }
  if(headland>0.0){
    float beds=P.y+P.x*0.055+P.z*0.021;
    float chalkBed=ntex(vec2(beds*1.38,nzA.g*3.0+14.1)).b;
    vec3 chalk=mix(vec3(0.26,0.275,0.260),vec3(0.40,0.395,0.32),smoothstep(0.36,0.67,chalkBed));
    m.c=mix(m.c,chalk*grain*(1.0-0.26*wetLine),headland*(0.78+0.13*bareRim));
  }
  if(badland>0.0){
    float deposit=P.y+0.052*P.x-0.033*P.z+2.6*ntexA(P.xz*0.055).r;
    float bedding=0.72*ntex(vec2(deposit*0.43,46.1+nzA.g)).r+0.28*nzB.g;
    vec3 clay=mix(vec3(0.36,0.175,0.099),vec3(0.59,0.34,0.18),smoothstep(0.28,0.76,bedding));
    clay=mix(clay,vec3(0.66,0.53,0.36),smoothstep(0.69,0.82,bedding)*0.45);
    m.c=mix(m.c,clay*grain,badland*0.91);
  }
  if(dune>0.01){
    float phase=(P.z+P.x*0.12+0.18*sin(P.x*0.8)+nzA.g*0.45)*26.0;
    float fine=1.-smoothstep(0.48,2.1,fwidth(phase));
    float ripple=cos(phase)*fine*dune;
    Nw=normalize(Nw+vec3(0.022,0.0,0.105)*ripple);
    m.c*=1.0+0.045*ripple;
  }
  // Baked topographic shadows describe the original island. In edited terrain
  // trace the new heightfield towards the sun, retaining a feathered boundary.
  float edited=max(max(volcanic,headland),max(badland,dune));
  if(edited>0.01){
    float visibility=1.0;
    float travel=5.0;
    for(int i=0;i<8;i++){
      vec3 q=P+uSunDir*travel;
      visibility=min(visibility,smoothstep(-2.1,2.6,q.y-terrainH(q.xz)+1.6));
      travel=travel*1.72+3.0;
    }
    shadowBaked=mix(shadowBaked,visibility,edited);
    ao=mix(ao,0.89+0.11*N.y,edited);
  }

  // ---- towns: cobbled streets, flagged squares and quays, trodden earth round the houses
  float paved = 0.0;
  float pave = max(town.r, max(town.g, town.b));
  if (pave > 0.004){
    Mat mc = sampS(L_COBBLE, P.xz / 2.8, dPx.xz / 2.8, dPy.xz / 2.8);
    Mat mf = sampS(L_FLAG, P.xz / 3.6, dPx.xz / 3.6, dPy.xz / 3.6);
    Mat mp = mixMat(mc, mf, saturate(town.g / max(town.r + town.g, 1e-3)));
    // bare earth: the cobble's grit without its colour
    float earth = saturate(town.b / max(pave, 1e-3));
    mp.c = mix(mp.c * vec3(0.86, 0.82, 0.76), vec3(0.36, 0.295, 0.205) * (0.72 + 0.5 * mc.h) * (0.85 + 0.3 * nzB.r), earth);
    mp.n *= mix(1.0, 0.45, earth);
    mp.r = mix(mp.r, 0.95, earth);
    // its edge frays into the grass along the gaps between the stones
    paved = hblend(saturate(pave * 1.25 + (nzC.r - 0.5) * 0.35 * (1.0 - pave)), m.h, mp.h, 0.9) * (1.0 - rockAmt * 0.8);
    m.c = mix(m.c, mp.c, paved);
    m.r = mix(m.r, mix(0.82, 0.95, mp.r), paved);
    m.h = mix(m.h, mp.h, paved);
    Nw = normalize(mix(Nw, normalize(N + vec3(mp.n.x, 0.0, mp.n.y) * 0.85), paved));
  }

  // Worn path from Sakuragaoka's southern street end disperses onto the sand.
  vec2 exitOffset = P.xz-uBeachExit;
  if (abs(exitOffset.x) < 25.0 && exitOffset.y >= 0.0 && exitOffset.y < 74.0) {
    float bend = 20.0*smoothstep(0.0,68.0,exitOffset.y)-13.0*smoothstep(60.0,100.0,exitOffset.y);
    float edge = abs(exitOffset.x-bend)+(nzB.r-0.5)*1.4;
    float trail = (1.0-smoothstep(1.45,3.0,edge))*(1.0-smoothstep(47.0,74.0,exitOffset.y));
    Mat grit = sampS(L_PEB, P.xz / 2.5, dPx.xz / 2.5, dPy.xz / 2.5);
    vec3 earth = mix(grit.c * vec3(0.77,0.68,0.56), vec3(0.29,0.235,0.165)*(0.72+0.50*grit.h), 0.63);
    m.c = mix(m.c, earth, trail);
    m.r = mix(m.r,0.82,trail);
  }

  // ---- light
  float cs = cloudShadow(P.xz, uTime);
  float sh = shadowBaked * cs * riderShadow(P) * townShadow(P, N);
  float soft = (1.0 - rockAmt) * (1.0 - lowW) * (1.0 - paved);       // grass scatters light around the terminator
  float ndlRaw = dot(Nw, uSunDir);
  float dif = saturate((ndlRaw + 0.32 * soft) / (1.0 + 0.32 * soft));
  float cav = mix(1.0, 0.55 + 0.45 * m.h, 0.7 * max(max(rockAmt, lowW), paved)); // crevice darkening from the height map
  // walls in shade are filled by the sky and by light off the sea and the rock opposite
  vec3 amb = mix(uAmbGround, uAmbSky, Nw.y * 0.5 + 0.5) * mix(ao, 0.35 + 0.65 * ao, rockAmt) * cav * (1.0 + 0.45 * rockAmt);
  // sunlit ground throws warm light back up into shaded walls
  amb += uSunColor * vec3(0.30, 0.36, 0.16) * 0.10 * saturate(1.0 - Nw.y) * ao * shadowBaked;
  vec3 col = m.c * (uSunColor * dif * sh + amb);

  // specular: wet stone and sand glint, dry ground barely
  vec3 H = normalize(uSunDir + V);
  float a = max(m.r * m.r, 0.02);
  float ndh = saturate(dot(Nw, H));
  float D = a * a / (3.14159 * pow(ndh * ndh * (a * a - 1.0) + 1.0, 2.0));
  float F = 0.04 + 0.96 * pow(1.0 - saturate(dot(V, H)), 5.0);
  float specMask = max(max(rockAmt, lowW),dampMargin*0.62);
  col += uSunColor * sh * saturate(ndlRaw) * min(D, 40.0) * F * 0.25 * specMask;
  float fres = 0.04 + 0.96 * pow(1.0 - saturate(dot(Nw, V)), 5.0);
  vec3 R = reflect(-V, Nw);
  col += skyBase(normalize(vec3(R.x, abs(R.y) + 0.02, R.z))) * fres * (1.0 - m.r) * (1.0 - m.r) * specMask * ao;

  col = applyAtmosphere(col, P);
  gl_FragColor = vec4(col, 1.0);
}
`;
