import * as THREE from 'three';

// Art round 22 (#254 X-51): zoned street reflection for the wet road.
// The single pre-baked street cube (street-reflections.js) was photographed once from the middle
// of the block and projected onto one box, so shop fronts 6-9 m away landed in the wrong place and
// the road mostly showed a sky tint. Here the main street is cut into a few zones along z. Each
// zone owns an AABB (street width x eave height x zone length) and a 512 px HalfFloat cube that is
// rendered once at load from the zone centre, 1.5 m above the road. The road fragment picks the
// zone(s) by its own street-local z (linear cross-fade at the borders), intersects its reflection
// ray with that zone's box (parallax) and samples the cube. Signs and lit shop windows are then
// smeared vertically: a few extra taps lower in elevation keep only the part above a threshold.
// Nothing is written to disk. ?refl=old (or ?toon=off, or the afternoon preset) never builds any of it.

const MAX_TAPS = 8;

export const reflEnabled = () => {
  const q = new URLSearchParams(location.search).get('refl');
  return q !== 'old' && q !== 'off';
};

/** Runtime uniforms for the road shader. Arrays are sized for the zone count. */
export function createZoneUniforms(params) {
  const n = params.zones.length;
  const blank = () => Array.from({ length: n }, () => new THREE.Vector3());
  const u = {
    uReflOn: { value: 0 },
    uZoneOrigin: { value: blank() }, uZoneMin: { value: blank() }, uZoneMax: { value: blank() },
    uZoneEdge: { value: params.zones.map((zone, i) => (i < n - 1 ? zone.z[1] : 0)) },
    uZoneBlend: { value: params.blend },
    uReflW: { value: new THREE.Vector4(params.base, params.grazing, params.dry, params.ripple ?? 1) },
    uReflLod: { value: new THREE.Vector2(params.lod[0], params.lod[1]) },
    uReflS: { value: new THREE.Vector4(params.streakLen, params.streakThresh, params.streakGain, params.streakLod) },
    uReflN: { value: Math.max(1, Math.min(MAX_TAPS, Math.round(params.streakTaps))) },
  };
  for (let i = 0; i < n; i++) u[`uZoneEnv${i}`] = { value: null };
  return u;
}

/** Fragment GLSL: declarations plus zoneReflection(). Both ends of every uniform are declared by the caller's uniform map. */
export function zoneGlsl(n) {
  const range = Array.from({ length: n }, (_, i) => i);
  const samplers = range.map(i => `uniform samplerCube uZoneEnv${i};`).join('\n');
  const blocks = range.map(i => {
    const lo = i === 0 ? '1.0' : `clamp((z - uZoneEdge[${i - 1}] + h) / (2.0 * h), 0.0, 1.0)`;
    const hi = i === n - 1 ? '1.0' : `1.0 - clamp((z - uZoneEdge[${i}] + h) / (2.0 * h), 0.0, 1.0)`;
    return `    {
      float w = (${lo}) * (${hi});
      if (w > 0.001) {
        vec3 s = vec3(0.0);
        vec3 c = zoneOne(uZoneEnv${i}, uZoneOrigin[${i}], uZoneMin[${i}], uZoneMax[${i}], p, r, basis, lod, s);
        base += w * c; streakSum += w * s; wsum += w;
      }
    }`;
  }).join('\n');
  return /* glsl */`
  uniform float uReflOn;
  uniform vec3 uZoneOrigin[${n}];
  uniform vec3 uZoneMin[${n}];
  uniform vec3 uZoneMax[${n}];
  uniform float uZoneEdge[${n}];
  uniform float uZoneBlend;
  uniform vec4 uReflW;
  uniform vec2 uReflLod;
  uniform vec4 uReflS;
  uniform int uReflN;
  ${samplers}
  // Box projection: intersect the ray (street-local) with the zone's box, look up from the probe to the hit point.
  // The sky is effectively at infinity above the eaves, so steep rays keep their own direction.
  vec3 zoneProbe(samplerCube env, vec3 origin, vec3 bmin, vec3 bmax, vec3 p, vec3 r, mat3 basis, float lod) {
    vec3 side = step(vec3(0.0), r);
    vec3 safeRay = mix(vec3(-1.0), vec3(1.0), side) * max(abs(r), vec3(0.0001));
    vec3 toWall = (mix(bmin, bmax, side) - p) / safeRay;
    float t = max(0.0, min(toWall.x, min(toWall.y, toWall.z)));
    vec3 fromProbe = normalize(p + r * t - origin);
    vec3 dir = mix(fromProbe, r, smoothstep(0.40, 0.88, r.y)) * basis;
    return textureLod(env, dir, lod).rgb;
  }
  // Colour plus a vertical streak term: taps at lower elevation than the pixel's own reflection ray
  // (a sign's mirror image reaches down towards the viewer), keeping only what is above the threshold.
  vec3 zoneOne(samplerCube env, vec3 origin, vec3 bmin, vec3 bmax, vec3 p, vec3 r, mat3 basis, float lod, out vec3 streak) {
    vec3 base = zoneProbe(env, origin, bmin, bmax, p, r, basis, lod);
    vec3 acc = vec3(0.0);
    float wsum = 0.0;
    float taps = float(max(uReflN, 1));
    for (int k = 1; k <= ${MAX_TAPS}; k++) {
      if (k > uReflN) break;
      float f = float(k) / taps;
      float y = max(r.y * (1.0 - uReflS.x * f), 0.02);
      vec3 rk = normalize(vec3(r.x, 0.0, r.z) * sqrt(max(1.0 - y * y, 0.0001) / max(1.0 - r.y * r.y, 0.0001)) + vec3(0.0, y, 0.0));
      vec3 c = zoneProbe(env, origin, bmin, bmax, p, rk, basis, lod + uReflS.w);
      float fall = 1.0 - 0.75 * f;
      acc += max(c - vec3(uReflS.y), vec3(0.0)) * fall;
      wsum += fall;
    }
    streak = acc / max(wsum, 0.0001);
    return base;
  }
  vec3 zoneReflection(vec3 worldPosition, vec3 worldRay, float lod, out vec3 streak) {
    vec3 p = (uStreetWorldToLocal * vec4(worldPosition, 1.0)).xyz;
    mat3 basis = mat3(uStreetWorldToLocal);
    vec3 r = basis * worldRay;
    float z = p.z;
    float h = max(0.5 * uZoneBlend, 0.01);
    vec3 base = vec3(0.0);
    float wsum = 0.0;
    vec3 streakSum = vec3(0.0);
${blocks}
    streak = streakSum / max(wsum, 0.0001);
    return base / max(wsum, 0.0001);
  }`;
}

/**
 * Renders every zone cube. Must run after the whole world is built and before the first frame.
 * Everything it touches (camera, visibility, shadow map state, wet shader, time) is put back.
 */
export async function bakeStreetZones({ world, layout, params, uniforms, onProgress = () => {} }) {
  const t0 = performance.now();
  const { renderer, scene, station: s, island, look, camera } = world;
  const n = params.zones.length, res = params.res;
  const root = s.root;
  root.updateWorldMatrix(true, true);

  // ---- hidden while baking: dynamic, transparent and light-spot objects
  const hidden = new Map(); // object -> visible
  const hide = object => { if (object && !hidden.has(object)) hidden.set(object, object.visible); };
  for (const child of island.root.children) if (child !== island.sky.mesh) hide(child);
  const DYNAMIC = /^(vehicles|keiVan|keiCar|taxi|compact|bicycle|train-A|train-B|train-wheelsets|wires|crossing-halo|crossing-cone|shop-spill|door-glow)$/;
  scene.traverse(o => { if (DYNAMIC.test(o.name)) hide(o); });
  if (world.shopSpill?.mesh) hide(world.shopSpill.mesh);
  if (world.doorGlow?.group) hide(world.doorGlow.group);
  const glass = new Map(); // street shop glass shows the lit interior instead of the old cube
  scene.traverse(o => {
    for (const m of o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : []) {
      if (m.name === 'station-street-window' || m.name === 'vehicle-glass') glass.set(m, m.visible);
    }
  });

  const saved = {
    camera: camera.clone(), time: island.U.uTime.value, stationTime: s.ctx.time,
    target: renderer.getRenderTarget(), face: renderer.getActiveCubeFace(), mip: renderer.getActiveMipmapLevel(),
    auto: renderer.shadowMap.autoUpdate, needs: renderer.shadowMap.needsUpdate,
    wet: s.wetRoad.enabled, reflOn: uniforms.uReflOn.value,
  };
  for (const object of hidden.keys()) object.visible = false;
  for (const m of glass.keys()) m.visible = false;
  s.wetRoad.setEnabled(false);
  uniforms.uReflOn.value = 0;
  renderer.shadowMap.autoUpdate = false;
  renderer.shadowMap.needsUpdate = true;

  const cubes = [];
  const info = [];
  try {
    for (let zi = 0; zi < n; zi++) {
      const zone = params.zones[zi];
      const zc = 0.5 * (zone.z[0] + zone.z[1]);
      const cx = layout.streetCenterX(zc);
      const ground = layout.heightAt(cx, zc);
      const localOrigin = new THREE.Vector3(cx, ground + params.probeHeight, zc);
      const bmin = new THREE.Vector3(cx + zone.x[0], ground - 1, zone.z[0] - params.pad);
      const bmax = new THREE.Vector3(cx + zone.x[1], ground + params.yMax, zone.z[1] + params.pad);
      uniforms.uZoneOrigin.value[zi].copy(localOrigin);
      uniforms.uZoneMin.value[zi].copy(bmin);
      uniforms.uZoneMax.value[zi].copy(bmax);
      info.push({ zone: zi, z: zone.z, origin: localOrigin.toArray(), min: bmin.toArray(), max: bmax.toArray() });

      const rt = new THREE.WebGLCubeRenderTarget(res, {
        type: THREE.HalfFloatType, format: THREE.RGBAFormat, generateMipmaps: true,
        minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, depthBuffer: true,
      });
      rt.texture.name = `station-street-zone-${zi}`;
      const near = 0.18, far = 84;
      const axes = new THREE.CubeCamera(near, far, rt);
      axes.coordinateSystem = renderer.coordinateSystem;
      axes.updateCoordinateSystem();
      axes.position.copy(s.toWorld(localOrigin));
      axes.layers.enableAll();
      axes.updateMatrixWorld(true);
      // CubeCamera r187 uses negative x/y focal lengths. A local Z half-turn with a conventional
      // positive projection samples the same rays while screen-size shaders get the focal length
      // they expect (same construction as scripts/bake-street-reflections.cjs).
      const halfTurn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI);
      const cams = axes.children.map(child => {
        const cam = new THREE.PerspectiveCamera(90, 1, near, far);
        child.matrixWorld.decompose(cam.position, cam.quaternion, cam.scale);
        cam.quaternion.multiply(halfTurn);
        cam.coordinateSystem = renderer.coordinateSystem;
        cam.updateProjectionMatrix();
        cam.updateMatrixWorld(true);
        cam.layers.enableAll();
        return cam;
      });
      const ray = (c, x, y) => new THREE.Vector3(x, y, 0.5).unproject(c).sub(c.getWorldPosition(new THREE.Vector3())).normalize();
      cams.forEach((c, i) => {
        for (const [x, y] of [[-1, -1], [0, 0], [1, 1], [1, -1]]) {
          if (ray(c, x, y).dot(ray(axes.children[i], x, y)) < 1 - 1e-9) throw new Error('Zone probe camera differs from CubeCamera rays');
        }
      });
      for (let face = 0; face < 6; face++) {
        camera.copy(cams[face]);
        camera.updateMatrixWorld();
        s.update(0, saved.stationTime, world.walker.worldPosition);
        island.update(0, saved.time);
        renderer.setRenderTarget(rt, face);
        renderer.clear(true, true, true);
        renderer.render(scene, cams[face]);
        renderer.shadowMap.needsUpdate = false;
      }
      cubes.push(rt);
      uniforms[`uZoneEnv${zi}`].value = rt.texture;
      await new Promise(resolve => setTimeout(resolve, 0));
      onProgress(zi + 1, n);
    }
  } finally {
    renderer.setRenderTarget(saved.target, saved.face, saved.mip);
    renderer.shadowMap.autoUpdate = saved.auto;
    renderer.shadowMap.needsUpdate = true;
    for (const [object, visible] of hidden) object.visible = visible;
    for (const [m, visible] of glass) m.visible = visible;
    s.wetRoad.setEnabled(saved.wet);
    camera.copy(saved.camera);
    camera.updateMatrixWorld();
    s.update(0, saved.stationTime, world.walker.worldPosition);
    island.update(0, saved.time);
    island.U.uTime.value = saved.time;
    if (look?.pipeline) look.pipeline.hasPrev = false;
  }
  uniforms.uReflOn.value = 1;
  const ms = Math.round(performance.now() - t0);
  return {
    ms, zones: info, res, cubes,
    dispose() {
      uniforms.uReflOn.value = 0;
      for (let i = 0; i < cubes.length; i++) { uniforms[`uZoneEnv${i}`].value = null; cubes[i].dispose(); }
      cubes.length = 0;
    },
  };
}
