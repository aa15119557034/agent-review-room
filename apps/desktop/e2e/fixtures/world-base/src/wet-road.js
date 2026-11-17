import * as THREE from 'three';

const SIZE = 512;
const BOUNDS = { x0: -4, z0: 4, x1: 4, z1: 34 };
const DECALS = new Set(['street-lines', 'street-paint', 'street-glyphs', 'street-util-decals', 'street-util-top']);
const GROUPS = [
  // Lane-wide damp bands (refs 10/11 in #252): at street-level grazing angles a
  // 1 m patch collapses to a few pixel rows, so patches span most of a lane.
  { z: 8.5, offset: 1.6, rx: 1.35, rz: 3.2, water: 0.85 },
  { z: 13.8, offset: -1.6, rx: 1.30, rz: 2.8, water: 0.55 },
  { z: 21.7, offset: 1.6, rx: 1.30, rz: 3.4, water: 0.7 },
  { z: 28.0, offset: -1.5, rx: 1.45, rz: 3.6, water: 1.0 },
  { z: 31.5, offset: 1.6, rx: 1.20, rz: 2.4, water: 0.0 },
];

function smooth(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function insert(source, needle, replacement) {
  if (!source.includes(needle)) throw new Error(`Wet road shader entry changed: ${needle}`);
  return source.replace(needle, replacement);
}

function makeMask(root, layout) {
  const width = BOUNDS.x1 - BOUNDS.x0, depth = BOUNDS.z1 - BOUNDS.z0;
  const excluded = new Uint8Array(SIZE * SIZE);
  const inverse = root.matrixWorld.clone().invert();
  const transform = new THREE.Matrix4();
  // Keep markings and manhole covers dry using their real painted shape:
  // rasterise each decal triangle, sample the decal's own alpha at the
  // interpolated UV, then dilate ~12 cm so linear mask filtering never bleeds
  // water onto paint. Triangles without a map or UV use their
  // exact triangle (not its bounding box).
  const alphaCache = new Map();
  const readAlpha = (texture, meshName) => {
    if (!texture) return null;
    if (alphaCache.has(texture)) return alphaCache.get(texture);
    let entry;
    try {
      const image = texture.image, w = image.width, h = image.height;
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const g = canvas.getContext('2d', { willReadFrequently: true });
      g.drawImage(image, 0, 0);
      if (texture.matrixAutoUpdate) texture.updateMatrix();
      entry = { w, h, data: g.getImageData(0, 0, w, h).data, texture };
    } catch (cause) {
      throw new Error(`Wet road cannot read decal alpha: ${meshName} map ${texture.name || texture.uuid} (${texture.image?.width ?? '?'}x${texture.image?.height ?? '?'})`, { cause });
    }
    alphaCache.set(texture, entry);
    return entry;
  };
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const ua = new THREE.Vector2(), ub = new THREE.Vector2(), uc = new THREE.Vector2(), sampleUV = new THREE.Vector2();
  const cellX = width / SIZE, cellZ = depth / SIZE;
  let alphaTriangles = 0, solidTriangles = 0;
  root.traverse(mesh => {
    if (!mesh.isMesh || !DECALS.has(mesh.name)) return;
    const geometry = mesh.geometry, position = geometry.attributes.position, uvs = geometry.attributes.uv, index = geometry.index;
    const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    const alpha = uvs ? readAlpha(material?.map, mesh.name) : null;
    transform.multiplyMatrices(inverse, mesh.matrixWorld);
    const count = index ? index.count : position.count;
    for (let i = 0; i < count; i += 3) {
      const ia = index ? index.getX(i) : i, ib = index ? index.getX(i + 1) : i + 1, ic = index ? index.getX(i + 2) : i + 2;
      a.fromBufferAttribute(position, ia).applyMatrix4(transform);
      b.fromBufferAttribute(position, ib).applyMatrix4(transform);
      c.fromBufferAttribute(position, ic).applyMatrix4(transform);
      const x0 = Math.min(a.x, b.x, c.x), x1 = Math.max(a.x, b.x, c.x), z0 = Math.min(a.z, b.z, c.z), z1 = Math.max(a.z, b.z, c.z);
      if (x1 < BOUNDS.x0 || x0 > BOUNDS.x1 || z1 < BOUNDS.z0 || z0 > BOUNDS.z1) continue;
      const det = (b.z - c.z) * (a.x - c.x) + (c.x - b.x) * (a.z - c.z);
      if (Math.abs(det) < 1e-9) continue;
      if (alpha) { ua.fromBufferAttribute(uvs, ia); ub.fromBufferAttribute(uvs, ib); uc.fromBufferAttribute(uvs, ic); alphaTriangles++; }
      else solidTriangles++;
      const ax = Math.max(0, Math.floor((x0 - BOUNDS.x0) / cellX)), bx = Math.min(SIZE - 1, Math.ceil((x1 - BOUNDS.x0) / cellX));
      const az = Math.max(0, Math.floor((z0 - BOUNDS.z0) / cellZ)), bz = Math.min(SIZE - 1, Math.ceil((z1 - BOUNDS.z0) / cellZ));
      for (let row = az; row <= bz; row++) for (let col = ax; col <= bx; col++) {
        const x = BOUNDS.x0 + (col + 0.5) * cellX, z = BOUNDS.z0 + (row + 0.5) * cellZ;
        const l1 = ((b.z - c.z) * (x - c.x) + (c.x - b.x) * (z - c.z)) / det;
        const l2 = ((c.z - a.z) * (x - c.x) + (a.x - c.x) * (z - c.z)) / det;
        const l3 = 1 - l1 - l2;
        if (l1 < -1e-4 || l2 < -1e-4 || l3 < -1e-4) continue;
        if (alpha) {
          const u = ua.x * l1 + ub.x * l2 + uc.x * l3, v = ua.y * l1 + ub.y * l2 + uc.y * l3;
          sampleUV.set(u, v);
          alpha.texture.transformUv(sampleUV);
          const px = Math.min(alpha.w - 1, Math.max(0, Math.floor(sampleUV.x * alpha.w)));
          const py = Math.min(alpha.h - 1, Math.max(0, Math.floor(sampleUV.y * alpha.h)));
          if (alpha.data[(py * alpha.w + px) * 4 + 3] < 20) continue;
        }
        excluded[row * SIZE + col] = 1;
      }
    }
  });
  // Separable 12 cm dilation (the mask is anisotropic: 8 m x 30 m over 512^2).
  const dilate = (src, radius, horizontal) => {
    const out = new Uint8Array(src.length);
    for (let row = 0; row < SIZE; row++) for (let col = 0; col < SIZE; col++) {
      if (!src[row * SIZE + col]) continue;
      for (let k = -radius; k <= radius; k++) {
        const r = horizontal ? row : row + k, q = horizontal ? col + k : col;
        if (r >= 0 && r < SIZE && q >= 0 && q < SIZE) out[r * SIZE + q] = 1;
      }
    }
    return out;
  };
  const dry = dilate(dilate(excluded, Math.ceil(0.12 / cellX), true), Math.ceil(0.12 / cellZ), false);
  excluded.set(dry);
  const groups = GROUPS.map(group => {
    const slope = layout.streetSlopeX(group.z), scale = Math.hypot(1, slope);
    return { ...group, x: layout.streetCenterX(group.z) + group.offset / scale,
      z: group.z - group.offset * slope / scale, nx: 1 / scale, nz: -slope / scale };
  });
  const data = new Uint8Array(SIZE * SIZE * 2);
  let wetPixels = 0, puddlePixels = 0, wetSum = 0, puddleSum = 0;
  for (let row = 0; row < SIZE; row++) for (let col = 0; col < SIZE; col++) {
    const i = row * SIZE + col;
    if (excluded[i]) continue;
    const x = BOUNDS.x0 + (col + 0.5) / SIZE * width;
    const z = BOUNDS.z0 + (row + 0.5) / SIZE * depth;
    let wet = 0, puddle = 0;
    for (const group of groups) {
      const dx = x - group.x, dz = z - group.z;
      const a = (dx * group.nx + dz * group.nz) / group.rx;
      const b = (-dx * group.nz + dz * group.nx) / group.rz;
      const edge = 1 + 0.11 * Math.sin(z * 5.7 + x * 4.1) + 0.08 * Math.sin(z * 2.9 - x * 11.3);
      const q = (a * a + b * b) / edge;
      wet = Math.max(wet, 1 - smooth(0.12, 1, q));
      puddle = Math.max(puddle, (1 - smooth(0.05, 0.42, q)) * group.water);
    }
    data[i * 2] = Math.round(wet * 255);
    data[i * 2 + 1] = Math.round(puddle * 255);
    wetPixels += data[i * 2] > 0 ? 1 : 0;
    puddlePixels += data[i * 2 + 1] > 0 ? 1 : 0;
    wetSum += data[i * 2] / 255; puddleSum += data[i * 2 + 1] / 255;
  }
  const texture = new THREE.DataTexture(data, SIZE, SIZE, THREE.RGFormat, THREE.UnsignedByteType);
  texture.name = 'station-wet-road-mask';
  texture.colorSpace = THREE.NoColorSpace;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  const pixelArea = width * depth / (SIZE * SIZE);
  return { texture, stats: {
    maskSize: SIZE, maskChannels: 2, maskBaseBytes: data.byteLength,
    bounds: { ...BOUNDS }, patchGroups: groups.length,
    dryDecalTriangles: { alphaShaped: alphaTriangles, solid: solidTriangles }, dryDilationM: 0.12,
    wetAreaM2: wetPixels * pixelArea, puddleAreaM2: puddlePixels * pixelArea,
    wetEquivalentAreaM2: wetSum * pixelArea, puddleEquivalentAreaM2: puddleSum * pixelArea,
  } };
}

/** Static, local wet patches; analytic sky only, never a shop/scene reflection.
 * Call after trim and before batchStatic; update the transform after moving root.
 * This owns its cloned road material and mask, but not the upstream asphalt map.
 */
export function applyWetRoad({ root, ctx }) {
  const targets = [];
  root.traverse(mesh => { if (mesh.isMesh && mesh.name === 'street-asphalt') targets.push(mesh); });
  if (targets.length !== 1) throw new Error(`Wet road expected one street-asphalt mesh, found ${targets.length}`);
  const mesh = targets[0], original = mesh.material;
  if (!original.isMeshToonMaterial || mesh.isInstancedMesh) throw new Error('Wet road requires the pinned, non-instanced toon asphalt mesh');
  root.updateWorldMatrix(true, true);
  const { texture, stats } = makeMask(root, ctx.L);
  const material = original.clone();
  material.name = 'street-asphalt-wet';
  const uniforms = {
    uWetMask: { value: texture }, uWetEnabled: { value: 1 },
    uWetWorldToLocal: { value: root.matrixWorld.clone().invert() },
    uWetBounds: { value: new THREE.Vector4(BOUNDS.x0, BOUNDS.z0, BOUNDS.x1 - BOUNDS.x0, BOUNDS.z1 - BOUNDS.z0) },
    uWetSkyLow: { value: new THREE.Color('#c9d6df') },
    uWetSkyHigh: { value: new THREE.Color('#8fb0c6') },
  };
  const upstreamCompile = original.onBeforeCompile;
  const upstreamKey = original.customProgramCacheKey();
  material.onBeforeCompile = function (shader, renderer) {
    upstreamCompile.call(this, shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = insert(shader.vertexShader, '#include <common>', `#include <common>
      uniform mat4 uWetWorldToLocal;
      varying vec3 vWetWorld;
      varying vec2 vWetLocal;`);
    shader.vertexShader = insert(shader.vertexShader, '#include <project_vertex>', `#include <project_vertex>
      vec4 wetWorld = modelMatrix * vec4(transformed, 1.0);
      vWetWorld = wetWorld.xyz;
      vWetLocal = (uWetWorldToLocal * wetWorld).xz;`);
    shader.fragmentShader = insert(shader.fragmentShader, '#include <common>', `#include <common>
      uniform sampler2D uWetMask;
      uniform float uWetEnabled;
      uniform vec4 uWetBounds;
      uniform vec3 uWetSkyLow, uWetSkyHigh;
      varying vec3 vWetWorld;
      varying vec2 vWetLocal;`);
    shader.fragmentShader = insert(shader.fragmentShader, '#include <map_fragment>', `#include <map_fragment>
      vec2 wetUV = (vWetLocal - uWetBounds.xy) / uWetBounds.zw;
      float wetInside = step(0.0, wetUV.x) * step(wetUV.x, 1.0) * step(0.0, wetUV.y) * step(wetUV.y, 1.0);
      vec2 wetMask = texture2D(uWetMask, wetUV).rg * wetInside * uWetEnabled;
      // Wet asphalt reads darker and slightly cooler/more saturated.
      diffuseColor.rgb *= mix(vec3(1.0), vec3(0.50, 0.53, 0.60), wetMask.r);`);
    shader.fragmentShader = insert(shader.fragmentShader, '#include <opaque_fragment>', `
      vec3 wetN = inverseTransformDirection(normal, viewMatrix);
      vec3 wetV = normalize(cameraPosition - vWetWorld);
      float wetFresnel = pow(1.0 - clamp(dot(wetN, wetV), 0.0, 1.0), 5.0);
      vec3 wetReflection = reflect(-wetV, wetN);
      vec3 wetSky = mix(uWetSkyLow, uWetSkyHigh, smoothstep(0.0, 0.7, wetReflection.y));
      // Standing water is close to a mirror at street-level grazing angles
      // (F0 for water ~0.02, but the cel look needs a readable sheet).
      outgoingLight = mix(outgoingLight, wetSky, wetMask.g * (0.06 + 0.45 * wetFresnel));
      outgoingLight = mix(outgoingLight, wetSky * 0.85, wetMask.r * 0.12 * wetFresnel);
      #include <opaque_fragment>`);
  };
  // The different callback deliberately opts out of batch2's material rewriting.
  // One isolated road material can still use its original single draw.
  material.customProgramCacheKey = () => `${upstreamKey}|station-wet-road-v1`;
  mesh.material = material;
  let disposed = false;
  return {
    material, maskTexture: texture,
    stats: { ...stats, materials: 1, extraPasses: 0, extraRenderTargets: 0, reflection: 'analytic sky only' },
    get enabled() { return uniforms.uWetEnabled.value === 1; },
    setTransform(matrixWorld) { uniforms.uWetWorldToLocal.value.copy(matrixWorld).invert(); },
    setEnabled(enabled) { uniforms.uWetEnabled.value = enabled ? 1 : 0; },
    dispose() {
      if (disposed) return;
      disposed = true;
      uniforms.uWetEnabled.value = 0;
      if (mesh.material === material) mesh.material = original;
      material.dispose();
      texture.dispose();
    },
  };
}
