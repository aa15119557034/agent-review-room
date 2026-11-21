import * as THREE from 'three';
import { ATMOSPHERE } from '../upstream/petalwake/src/shaders/common.js';

// Shared pieces of the facade (r24) and tower (r25) blocks: seeded helpers, merged-geometry buckets, the canvas sign atlas, and the
// camera-distance aerial perspective patch (same sky-horizon fog colour and near / far curve massing.js bakes into the placeholder towers).
export const WHITE = new THREE.Color(1, 1, 1);
export const hash32 = (...values) => { let h = 2166136261; for (const v of values) { h ^= (v | 0) + 0x9e3779b9 + (h << 6) + (h >>> 2); h = Math.imul(h, 16777619); } return h >>> 0; };
export function rngFrom(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export const pick = (rng, list) => list[Math.floor(rng() * list.length) % list.length];
/** Axis-aligned bounds (minX / maxX / minZ / maxZ) of a w x d rectangle centred on (cx, cz), turned by yaw (same convention as frameOf). */
export function rotRect(cx, cz, yaw, w, d) {
  const c = Math.cos(yaw), s = Math.sin(yaw), r = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
  for (const [lx, lz] of [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]]) {
    const x = cx + lx * c + lz * s, z = cz - lx * s + lz * c;
    r.minX = Math.min(r.minX, x); r.maxX = Math.max(r.maxX, x); r.minZ = Math.min(r.minZ, z); r.maxZ = Math.max(r.maxZ, z);
  }
  return r;
}

// ---- merged output -----------------------------------------------------------------------------------------------------------
export class Bucket {
  constructor() { this.pos = []; this.nrm = []; this.col = []; this.uv = []; this.idx = []; this.crown = []; }
  /** Stamp the crown height (world y of the module's top, for the sky behind it) on every vertex added since the last call. */
  seal(crownY) { while (this.crown.length < this.vertices) this.crown.push(crownY); }
  get vertices() { return this.pos.length / 3; }
  get triangles() { return this.idx.length / 3; }
  geometry(withColor = true) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(this.nrm), 3));
    if (withColor) g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.col), 3));
    g.setAttribute('bkCrown', new THREE.BufferAttribute(new Float32Array(this.crown), 1));
    if (this.uv.length) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(this.uv), 2));
    g.setIndex(new THREE.BufferAttribute(new Uint32Array(this.idx), 1));
    g.computeBoundingSphere(); g.computeBoundingBox();
    return g;
  }
}

/** Placement frame: module-local (x, y, z) -> station-local x / z, world y. mir = -1 mirrors the module along its length. */
export function frameOf(cx, y0, cz, yaw, mir) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return {
    p: (x, y, z) => [cx + x * mir * c + z * s, y0 + y, cz - x * mir * s + z * c],
    n: (x, y, z) => [x * mir * c + z * s, y, -x * mir * s + z * c],
    mir,
  };
}

export function addPart(bucket, F, part, colorOf, uvShift, mapPos) {
  const base = bucket.vertices, count = part.pos.length / 3;
  for (let i = 0; i < count; i++) {
    const q = mapPos ? mapPos(part.pos[i * 3], part.pos[i * 3 + 1], part.pos[i * 3 + 2]) : [part.pos[i * 3], part.pos[i * 3 + 1], part.pos[i * 3 + 2]];
    const p = F.p(q[0], q[1], q[2]), n = F.n(part.nrm[i * 3], part.nrm[i * 3 + 1], part.nrm[i * 3 + 2]);
    bucket.pos.push(p[0], p[1], p[2]); bucket.nrm.push(n[0], n[1], n[2]);
    const c = colorOf(i); bucket.col.push(c.r, c.g, c.b);
    if (part.uv) { const s = uvShift ? uvShift(i) : [0, 0]; bucket.uv.push(part.uv[i * 2] + s[0], part.uv[i * 2 + 1] + s[1]); }
  }
  for (let k = 0; k < part.idx.length; k += 3) {
    if (F.mir < 0) bucket.idx.push(base + part.idx[k], base + part.idx[k + 2], base + part.idx[k + 1]);
    else bucket.idx.push(base + part.idx[k], base + part.idx[k + 1], base + part.idx[k + 2]);
  }
}

/** Four side faces of a box in module-local axes (the plinth under a module). */
export function addPlinth(bucket, F, cx, cz, w, d, y0, y1, color) {
  const hx = w / 2, hz = d / 2;
  const faces = [[0, 1, [[-hx, hz], [hx, hz]]], [1, 0, [[hx, hz], [hx, -hz]]], [0, -1, [[hx, -hz], [-hx, -hz]]], [-1, 0, [[-hx, -hz], [-hx, hz]]]];
  for (const [nx, nz, [a, b]] of faces) {
    const base = bucket.vertices;
    for (const [x, y, z] of [[a[0], y0, a[1]], [b[0], y0, b[1]], [b[0], y1, b[1]], [a[0], y1, a[1]]]) {
      const p = F.p(cx + x, y, cz + z), n = F.n(nx, 0, nz);
      bucket.pos.push(...p); bucket.nrm.push(...n); bucket.col.push(color.r, color.g, color.b);
    }
    if (F.mir < 0) bucket.idx.push(base, base + 2, base + 1, base, base + 3, base + 2); else bucket.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
}

// ---- sign atlas ----------------------------------------------------------------------------------------------------------------
const FONT = '"Yu Gothic","Meiryo","Hiragino Sans","Noto Sans CJK JP","IPAGothic","IPA Gothic",sans-serif';
export function buildSignAtlas(spec) {
  const [W, H] = spec.size, [hw, hh] = spec.h.cell, [vw, vh] = spec.v.cell;
  const hCols = Math.floor(W / hw), vCols = Math.floor(W / vw), schemes = spec.schemes;
  const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const cells = { h: [], v: [], w: [], b: [] };
  // Horizontal boards: every word in every colour scheme, in a fixed order (cell index = word * schemes + scheme).
  spec.h.words.forEach((word, wi) => schemes.forEach((sc, si) => {
    const i = wi * schemes.length + si, col = i % hCols, row = Math.floor(i / hCols), x = col * hw, y = row * hh;
    ctx.fillStyle = sc.bg; ctx.fillRect(x, y, hw, hh);
    ctx.strokeStyle = sc.fg; ctx.globalAlpha = 0.55; ctx.lineWidth = 3; ctx.strokeRect(x + 6, y + 6, hw - 12, hh - 12); ctx.globalAlpha = 1;
    const len = [...word].length;
    let size = Math.min(hh * 0.62, (hw * 0.78) / len);
    ctx.font = `700 ${size}px ${FONT}`; ctx.fillStyle = sc.fg;
    ctx.fillText(word, x + hw / 2, y + hh / 2 + size * 0.04);
    cells.h.push({ x, y, w: hw, h: hh, word, scheme: si });
  }));
  const hRows = Math.ceil(spec.h.words.length * schemes.length / hCols), vTop = hRows * hh;
  // Vertical boards: characters stacked top to bottom, one board per word and scheme.
  spec.v.words.forEach((word, wi) => schemes.forEach((sc, si) => {
    const i = wi * schemes.length + si, col = i % vCols, row = Math.floor(i / vCols), x = col * vw, y = vTop + row * vh;
    ctx.fillStyle = sc.bg; ctx.fillRect(x, y, vw, vh);
    ctx.strokeStyle = sc.fg; ctx.globalAlpha = 0.55; ctx.lineWidth = 3; ctx.strokeRect(x + 4, y + 4, vw - 8, vh - 8); ctx.globalAlpha = 1;
    const chars = [...word], size = Math.min(vw * 0.74, (vh - 24) / chars.length * 0.92);
    ctx.font = `700 ${size}px ${FONT}`; ctx.fillStyle = sc.fg;
    const step = (vh - 16) / chars.length;
    chars.forEach((ch, k) => ctx.fillText(ch, x + vw / 2, y + 8 + step * (k + 0.5) + size * 0.04));
    cells.v.push({ x, y, w: vw, h: vh, word, scheme: si, chars: chars.length });
  }));
  const vRows = Math.ceil(spec.v.words.length * schemes.length / vCols), wTop = vTop + vRows * vh;
  let bTop = wTop;
  // Wide boards (rooftop billboards): one word per cell, a few colour schemes; sampled with a centred crop to match the board's aspect.
  if (spec.w) {
    const [ww, wh] = spec.w.cell, wCols = Math.floor(W / ww);
    spec.w.words.forEach((word, wi) => spec.w.schemes.forEach((si, k) => {
      const sc = schemes[si], i = wi * spec.w.schemes.length + k, col = i % wCols, row = Math.floor(i / wCols), x = col * ww, y = wTop + row * wh;
      ctx.fillStyle = sc.bg; ctx.fillRect(x, y, ww, wh);
      ctx.strokeStyle = sc.fg; ctx.globalAlpha = 0.5; ctx.lineWidth = 4; ctx.strokeRect(x + 6, y + 6, ww - 12, wh - 12); ctx.globalAlpha = 1;
      const size = Math.min(wh * 0.6, ww * 0.5 / [...word].length);
      ctx.font = `700 ${size}px ${FONT}`; ctx.fillStyle = sc.fg;
      ctx.fillText([...word].join(' '), x + ww / 2, y + wh / 2 + size * 0.04);
      cells.w.push({ x, y, w: ww, h: wh, word, scheme: si });
    }));
    bTop = wTop + Math.ceil(spec.w.words.length * spec.w.schemes.length / wCols) * wh;
    if (bTop > H) throw new Error('Sign atlas too small (wide boards)');
  }
  // r26 billboard boards (rooftop panels of the mid-band and the landmark towers, ~ 8-10 x 5-6 m): a squarer cell, the word on one or two
  // lines. Only present when the spec carries `b` (the mid-band adds it; ?midband=off leaves the atlas exactly as in r25).
  if (spec.b) {
    const [bw, bh] = spec.b.cell, bCols = Math.floor(W / bw);
    spec.b.words.forEach((word, wi) => spec.b.schemes.forEach((si, k) => {
      const sc = schemes[si], i = wi * spec.b.schemes.length + k, col = i % bCols, row = Math.floor(i / bCols), x = col * bw, y = bTop + row * bh;
      ctx.fillStyle = sc.bg; ctx.fillRect(x, y, bw, bh);
      ctx.strokeStyle = sc.fg; ctx.globalAlpha = 0.55; ctx.lineWidth = 6; ctx.strokeRect(x + 10, y + 10, bw - 20, bh - 20); ctx.globalAlpha = 1;
      const chars = [...word], half = Math.ceil(chars.length / 2), lines = chars.length > 2 ? [chars.slice(0, half), chars.slice(half)] : [chars];
      const size = Math.min(bh * 0.36, bw * 0.78 / Math.max(...lines.map(l => l.length)));
      ctx.font = `700 ${size}px ${FONT}`; ctx.fillStyle = sc.fg;
      lines.forEach((line, li) => ctx.fillText(line.join(' '), x + bw / 2, y + bh / 2 + (li - (lines.length - 1) / 2) * size * 1.18 + size * 0.04));
      cells.b.push({ x, y, w: bw, h: bh, word, scheme: si });
    }));
    if (bTop + Math.ceil(spec.b.words.length * spec.b.schemes.length / bCols) * bh > H) throw new Error('Sign atlas too small (billboard boards)');
  }
  if (vTop + vRows * vh > H) throw new Error('Sign atlas too small');
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = 4; texture.generateMipmaps = true; texture.minFilter = THREE.LinearMipmapLinearFilter;
  return { texture, canvas, cells, W, H };
}



/** One sign quad in the module frame AFTER the mirror (x' = mir * x), so lettering always reads left to right. n = outward normal (x, z);
 *  crop = { u, v } fractions of the cell to sample (centred). The winding is never flipped. */
export function addSignQuad(bucket, F0, signs, cell, centre, n, w, h, crop = { u: 1, v: 1 }) {
  const W = signs.W, H = signs.H, pad = 2;
  const cu = cell.x + cell.w * (1 - crop.u) / 2, cv = cell.y + cell.h * (1 - crop.v) / 2, cw = cell.w * crop.u, ch = cell.h * crop.v;
  const u0 = (cu + pad) / W, u1 = (cu + cw - pad) / W, vTop = 1 - (cv + pad) / H, vBot = 1 - (cv + ch - pad) / H;
  const right = [n[1], 0, -n[0]], base = bucket.vertices, uvs = [[u0, vBot], [u1, vBot], [u1, vTop], [u0, vTop]];
  [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(([sx, sy], i) => {
    const p = F0.p(centre[0] + right[0] * sx * w / 2, centre[1] + sy * h / 2, centre[2] + right[2] * sx * w / 2), nn = F0.n(n[0], 0, n[1]);
    bucket.pos.push(...p); bucket.nrm.push(...nn); bucket.uv.push(...uvs[i]);
  });
  bucket.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

// ---- camera-distance aerial perspective -----------------------------------------------------------------------------------------
// massing.js bakes the placeholder towers' fog per block, from one reference eye: fog fraction linear in the horizontal eye distance
// (palette.fog.near / far), towards the sky's own horizon colour at the elevation of the block's crown (skyAt * height), luma-capped,
// desaturated and gained. Here the same numbers are evaluated per pixel from the real camera, so the player can walk. A smoothstep ramp
// (fog.start) keeps anything closer than ~60 m crisp. Lit windows / signs fade with (1 - litFade * fog), as in the placeholders.
const ATMOS_UNIFORMS = ['uSunDir', 'uSunColor', 'uSkyZenith', 'uSkyMid', 'uSkyHorizon', 'uSunHalo', 'uAmbSky', 'uAmbGround', 'uFog', 'uCamPos',
  'uSkyP0', 'uSkyP1', 'uSkyP2', 'uSkyP3', 'uSkyP4', 'uCloudP0', 'uCloudP1', 'uCloudP2', 'uCloudP3'];

export function makeAerial(island, fog, start) {
  const f = fog;
  return {
    island, fog: f,
    uniforms: {
      uBkFog: { value: new THREE.Vector4(f.near[0], f.near[1], f.far[0], f.far[1]) },
      uBkRamp: { value: new THREE.Vector4(start[0], start[1], f.litFade, f.windows) },
      uBkSky: { value: new THREE.Vector4(f.lumaMax, f.desat ?? 0, f.gain ?? 1, f.skyAt) },
    },
  };
}

/** kind: 'lit' (MeshToonMaterial: fog after lighting, emissive fades) or 'sign' (MeshBasicMaterial: colour fades, fog * windows). */
export function patchAerial(material, aerial, kind) {
  const U = aerial.island.U;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, aerial.uniforms);
    for (const name of ATMOS_UNIFORMS) if (U[name]) shader.uniforms[name] = U[name];
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float bkCrown;\nvarying vec3 vBkPos;\nvarying float vBkCrown;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBkPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz; vBkCrown = bkCrown;');
    const head = `
varying vec3 vBkPos;
varying float vBkCrown;
uniform vec4 uBkFog;
uniform vec4 uBkRamp;
uniform vec4 uBkSky;
${ATMOSPHERE}`;
    const body = `
  vec2 bkH = vBkPos.xz - cameraPosition.xz;
  float bkD = length( bkH );
  float bkK = clamp( uBkFog.y + ( uBkFog.w - uBkFog.y ) * ( bkD - uBkFog.x ) / ( uBkFog.z - uBkFog.x ), 0.0, 1.0 ) * smoothstep( uBkRamp.x, uBkRamp.y, bkD );
  float bkE = max( 0.035, ( vBkCrown - cameraPosition.y ) / max( bkD, 1.0 ) );
  vec3 bkSky = skyBase( normalize( vec3( bkH.x / max( bkD, 1e-3 ), bkE, bkH.y / max( bkD, 1e-3 ) ) ) );
  float bkL = dot( bkSky, vec3( 0.2126, 0.7152, 0.0722 ) );
  float bkCap = min( 1.0, uBkSky.x / max( bkL, 1e-4 ) );
  float bkG = bkL * bkCap;
  vec3 bkCol = ( vec3( bkG ) + ( bkSky * bkCap - vec3( bkG ) ) * ( 1.0 - uBkSky.y ) ) * uBkSky.z;
`;
    let f = shader.fragmentShader.replace('#include <common>', '#include <common>' + head).replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>' + body);
    if (kind === 'lit') {
      f = f.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n totalEmissiveRadiance *= 1.0 - uBkRamp.z * bkK;')
        .replace('#include <opaque_fragment>', 'outgoingLight = mix( outgoingLight, bkCol, bkK );\n#include <opaque_fragment>');
    } else {
      f = f.replace('#include <color_fragment>', '#include <color_fragment>\n diffuseColor.rgb *= 1.0 - uBkRamp.z * bkK;')
        .replace('#include <opaque_fragment>', 'outgoingLight = mix( outgoingLight, bkCol, bkK * uBkRamp.w );\n#include <opaque_fragment>');
    }
    shader.fragmentShader = f;
  };
  material.customProgramCacheKey = () => 'blocks-aerial-' + kind;
}

/** Everything the facade and tower blocks share: palette, sign atlas, sign material, aerial uniforms. Created once per page. */
export function makeShared({ island, params, timeOfDay, midband = false }) {
  const B = params.blocks, evening = timeOfDay !== 'afternoon', palette = params[evening ? 'evening' : 'afternoon'], L = B[evening ? 'evening' : 'afternoon'];
  // r26: with the mid-band on, the sign atlas also carries the squarer billboard cells (blocks.midband.signs); off = the r25 atlas untouched.
  const signs = buildSignAtlas(midband && B.midband?.signs ? { ...B.signs, ...B.midband.signs } : B.signs);
  const aerial = makeAerial(island, palette.fog, B.fog.start);
  const signMat = new THREE.MeshBasicMaterial({ map: signs.texture, toneMapped: false, name: 'massing-blocks-sign' });
  signMat.color.setScalar(L.signGain);
  signMat.userData.wbEveningGlow = true; // the gain is set here; the generic print pass leaves it alone
  patchAerial(signMat, aerial, 'sign');
  let disposed = false;
  return { B, L, palette, evening, signs, aerial, signMat, dispose() { if (disposed) return; disposed = true; signMat.dispose(); signs.texture.dispose(); } };
}
