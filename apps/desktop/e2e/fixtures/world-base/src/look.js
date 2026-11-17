import * as THREE from 'three';
import { Pipeline } from '../upstream/petalwake/src/core/pipeline.js';

// The depth source is the actual displaced terrain colour pass. Sakuragaoka's
// normal override would outline Petalwake's undisplaced tile grid instead.
const OUTLINES = /* glsl */`
uniform sampler2D tWorldDepth;
uniform float uNear, uFar, uReversed, uToon, uHaze;
float wbDepth(vec2 uv) {
  float z = texture(tWorldDepth, uv).r;
  return uNear*uFar / mix(uFar+(uNear-uFar)*z, uNear+(uFar-uNear)*z, uReversed);
}
uniform float uProjScale, uAO;
// View-space position from linear depth (uProjScale = focal length in pixels).
vec3 wbPos(vec2 uv) {
  float d = wbDepth(uv);
  return vec3((uv - 0.5)*uRes*d/uProjScale, -d);
}
// Normal from the flatter of each pair of one-pixel differences, so a pixel on a
// silhouette takes its own surface's slope, never the step to the background.
vec3 wbNormal(vec2 uv, vec3 P) {
  vec2 px = 1.0/uRes;
  vec3 r = wbPos(uv + vec2(px.x, 0.0)), l = wbPos(uv - vec2(px.x, 0.0));
  vec3 u = wbPos(uv + vec2(0.0, px.y)), b = wbPos(uv - vec2(0.0, px.y));
  vec3 dx = abs(r.z - P.z) < abs(P.z - l.z) ? r - P : P - l;
  vec3 dy = abs(u.z - P.z) < abs(P.z - b.z) ? u - P : P - b;
  vec3 n = normalize(cross(dx, dy));
  return dot(n, P) > 0.0 ? -n : n;
}
// Crease AO. A sample only occludes when the two surfaces face each other: it
// must rise above the centre's plane AND the centre must lie in front of the
// sample's own plane. A wall/ground or wall/eave corner passes both tests; a
// mailbox, railing or hedge standing in front of a wall fails the second (its
// front face points at the camera, away from the wall behind), so depth steps
// no longer leave rings on the far side. Both factors fall to zero as a sample
// slides onto the far face through the corner, so the result has no per-sample
// on/off steps (the old pair test banded at every sample radius).
float wbAO(vec2 uv, float d0) {
  if (d0 > 90.0 || d0 >= uFar*0.9) return 1.0;
  const float R = 0.8;
  vec3 P = wbPos(uv), n = wbNormal(uv, P);
  float rpx = clamp(R*uProjScale/d0, 3.0, 48.0), occ = 0.0;
  vec2 edge = 1.5/uRes;
  for (int i = 0; i < 8; i++) {
    float a = float(i)*0.7854 + 0.2;
    vec2 dir = vec2(cos(a), sin(a))/uRes;
    for (int k = 0; k < 2; k++) {
      vec2 s = uv + dir*rpx*(k == 0 ? 0.4 : 0.9);
      if (any(lessThan(s, edge)) || any(greaterThan(s, 1.0 - edge))) continue;
      vec3 S = wbPos(s), v = S - P;
      float L = length(v);
      vec3 vn = v/max(L, 1e-4);
      float up = dot(n, vn) - 0.08;
      if (up <= 0.0 || L > 1.6*R) continue;
      float back = dot(wbNormal(s, S), -vn) - 0.08;
      if (back <= 0.0) continue;
      occ += up*back*(1.0 - smoothstep(0.6*R, 1.6*R, L));
    }
  }
  // A square corner gives up*back ~0.35 on the half of the samples that land on
  // the other face; scale so a square corner reads as fully occluded before uAO.
  return 1.0 - min(1.0, occ/16.0*6.0)*(1.0 - smoothstep(50.0, 90.0, d0));
}
float wbEdge(vec2 uv) {
  vec2 px = max(1.0, uRes.y/1100.0)/uRes;
  float d0 = wbDepth(uv), dl = wbDepth(uv-vec2(px.x,0.0)), dr = wbDepth(uv+vec2(px.x,0.0));
  float du = wbDepth(uv+vec2(0.0,px.y)), dd = wbDepth(uv-vec2(0.0,px.y));
  float i0 = 1.0/max(d0,0.05);
  float lap = max(abs(1.0/max(dl,0.05)+1.0/max(dr,0.05)-2.0*i0),abs(1.0/max(du,0.05)+1.0/max(dd,0.05)-2.0*i0))/i0;
  float dm = min(min(dl,dr),min(du,dd));
  float edge = max(smoothstep(0.06,0.18,lap),smoothstep(0.10,0.25,(d0-dm)/max(dm,0.05)));
  return edge*(1.0-smoothstep(35.0,190.0,min(d0,dm)));
}
`;
const BANDS = /* glsl */`
uniform float uWorldToon;
float wbBand(float n) {
  return n < 0.0 ? 0.0 : (n < 0.12 ? 0.42 : (n < 0.42 ? 0.8 : 1.0));
}
`;

function insert(source, needle, replacement, label) {
  if (!source.includes(needle)) throw new Error(`Pinned upstream shader changed: ${label}`);
  return source.replace(needle, replacement);
}

export function createLook(renderer, camera) {
  const pipeline = new Pipeline(renderer);
  const toon = { value: 1 };
  Object.assign(pipeline.params, {
    blur: 0, rays: 0, distortion: 0, fringe: 0,
    bloom: 0.12, exposure: 1.02, saturation: 1.0, contrast: 1.05, vignette: 0.12,
  });
  const mat = pipeline.finalMat;
  Object.assign(mat.uniforms, {
    tWorldDepth: pipeline.uDepth, uNear: { value: camera.near }, uFar: { value: camera.far },
    uProjScale: { value: 1 }, uAO: { value: 0.55 },
    uReversed: { value: pipeline.reversed ? 1 : 0 }, uToon: toon, uHaze: { value: 1 },
  });
  mat.fragmentShader = insert(mat.fragmentShader, 'void main(){', `${OUTLINES}\nvoid main(){`, 'composite entry');
  mat.fragmentShader = insert(mat.fragmentShader, 'col *= uExposure;', `
    // Contact shadows (ZZZ refs: crates, benches, eaves all sit in soft dark creases).
    if (uAO*uToon > 0.0) col *= mix(1.0, wbAO(uv, wbDepth(uv)), uAO*uToon);
    float edge = wbEdge(uv)*uToon;
    vec3 line = mix(col*vec3(0.42,0.38,0.50),vec3(0.027,0.020,0.051),0.35);
    col = mix(col,line,edge*0.45); // ZZZ scenes keep only faint silhouettes; strong lines are for characters
    // Anime aerial perspective: distant land fades to a cool sky haze so the
    // island behind the station reads as backdrop. Sky (far plane) and high
    // aerial cameras are left alone.
    float wbD = wbDepth(uv);
    float wbHaze = (1.0-exp(-max(wbD-60.0,0.0)/750.0)) * (1.0-step(uFar*0.9,wbD)) * uHaze * uToon;
    col = mix(col, vec3(0.80,0.83,0.88)*max(dot(col,vec3(0.2126,0.7152,0.0722))*1.15,0.55), wbHaze*0.72);
    col *= uExposure;`, 'outline stage');
  // Station soft clip below the knee keeps anime mid-tones bright and saturated;
  // ACES stays for the high aerial view (whole-island HDR) and the toon-off comparison.
  mat.fragmentShader = insert(mat.fragmentShader, 'col = acesFilm(col * 0.92);', `
    // Shoulder on the brightest channel so sunlit flower fields keep their hue.
    float wbPeak = max(max(col.r, col.g), max(col.b, 1e-4));
    float wbClip = min(wbPeak, 0.72) + 0.28 * (1.0 - exp(-max(wbPeak - 0.72, 0.0) / 0.28));
    col = mix(acesFilm(col * 0.92), col * (wbClip / wbPeak), uToon * uHaze);`, 'tone curve');
  // Upstream contrast pivots at 0.5 in linear light, so with 1.05 everything
  // below ~0.024 goes negative and clamps to black (#254: shutters, dark PBR).
  // Keep the curve above x0 and replace the bottom with a power toe that meets it
  // in value and slope: true black stays black, dark detail keeps its ratios.
  mat.fragmentShader = insert(mat.fragmentShader, 'col = (col - 0.5) * uContrast + 0.5;', `
    const float wbX0 = 0.12;
    float wbY0 = max((wbX0 - 0.5)*uContrast + 0.5, 1e-3);
    float wbP = uContrast*wbX0/wbY0;
    vec3 wbToe = wbY0*pow(max(col, 0.0)/wbX0, vec3(wbP));
    col = mix(wbToe, (col - 0.5)*uContrast + 0.5, step(wbX0, col));`, 'contrast toe');
  mat.fragmentShader = insert(mat.fragmentShader, 'col = clamp(col, 0.0, 1.0);', `
    // ZZZ grade (#252 breakdown): muted base, punchy accents; cool shadows that
    // keep their detail, warm highlights.
    float wbL = dot(col, vec3(0.2126,0.7152,0.0722));
    float wbChroma = max(max(col.r,col.g),col.b) - min(min(col.r,col.g),col.b);
    float wbSky = step(uFar*0.9, wbDepth(uv)) * uHaze;
    col = mix(col, mix(vec3(wbL), col, 0.86 + 0.9*wbChroma), uToon*(1.0-wbSky));
    // ZZZ skies are hazy and pale behind the city (refs 1, 5, 7).
    col = mix(col, mix(vec3(wbL), col, 0.78) + 0.035, wbSky*uToon);
    col = mix(col, col*vec3(0.92,0.98,1.07), (1.0-smoothstep(0.10,0.50,wbL))*0.6*uToon);
    col += vec3(0.035,0.016,-0.022)*smoothstep(0.50,1.0,wbL)*uToon;
    col = mix(col, col*1.04+0.012, (1.0-smoothstep(0.0,0.25,wbL))*uToon);
    col = clamp(col, 0.0, 1.0);`, 'purple shadows');

  function applyIsland(island) {
    // Quantize terrain's calibrated diffuse, including its grass wrap-lighting.
    // The town's raw-normal bands otherwise lift sunlit terrain straight to 1.
    for (const [material, needle, band] of [
      [island.terrain.material, 'float dif = saturate((ndlRaw + 0.32 * soft) / (1.0 + 0.32 * soft));', 'floor(dif * 3.0 + 0.5) / 3.0'],
      [island.transition.material, 'float dif = saturate((ndlRaw + 0.32 * soft) / (1.0 + 0.32 * soft));', 'floor(dif * 3.0 + 0.5) / 3.0'],
      [island.town.material, 'float dif = saturate(ndl);', 'wbBand(ndl)'],
    ]) {
      material.uniforms.uWorldToon = toon;
      material.fragmentShader = insert(material.fragmentShader, 'void main(){', `${BANDS}\nvoid main(){`, 'island bands entry');
      material.fragmentShader = insert(material.fragmentShader, needle,
        `${needle}\n  dif = mix(dif, ${band}, uWorldToon);`, 'island diffuse band');
      material.needsUpdate = true;
    }
    const water = island.water.material;
    // The shallow coefficient, rather than bloom, dominates the cyan halos.
    // Keep deep-water colour and the transmitted seabed independently calibrated.
    water.fragmentShader = insert(water.fragmentShader, 'vec3 shallow = vec3(0.030, 0.420, 0.380);',
      `vec3 shallow = vec3(0.030, 0.420, 0.380);
  shallow *= 0.4;`, 'shallow water scatter');
    // Compute derivatives before the upstream shore discard. Both water LOD
    // corrections use the actual world-space pixel footprint, not camera height.
    water.fragmentShader = insert(water.fragmentShader, 'vec3 P = vWorld;',
      `vec3 P = vWorld;
  float wbWaterFootprint = max(length(dFdx(P.xz)), length(dFdy(P.xz)));`, 'water pixel footprint');
    // Filtering the two height channels before their nonlinear caustic formula
    // converges to 1.6, instead of its measured full-resolution mean of 0.398.
    water.fragmentShader = insert(water.fragmentShader, 'float pathLen = depth *',
      `float wbCausticLod = log2(max(1.0, wbWaterFootprint * 0.19 * 1.37 * float(textureSize(uRipple, 0).x)));
  caust = mix(caust, 0.398, smoothstep(3.0, 5.0, wbCausticLod));
  float pathLen = depth *`, 'caustic minification');
    // Unresolved shore bubbles average into a solid collar. Resolved surf,
    // whitecaps and the later wake/waterfall contributions retain their values.
    water.fragmentShader = insert(water.fragmentShader, 'float foam = max(max(cap, surfBand * 0.9), max(lace, churn));',
      `float wbShoreFoam = max(surfBand * 0.9, max(lace, churn));
  wbShoreFoam *= mix(1.0, 0.35, smoothstep(0.75, 3.0, wbWaterFootprint));
  float foam = max(cap, wbShoreFoam);`, 'shore foam coverage');
    water.needsUpdate = true;
  }
  return {
    pipeline, applyIsland,
    setToon(value) { toon.value = value ? 1 : 0; },
    setAO(value) { mat.uniforms.uAO.value = value; },
    setFlightEffects(value) { pipeline.params.blur = value ? 1 : 0; pipeline.params.rays = value ? 0.55 : 0; pipeline.hasPrev = false; },
    setSize(width, height, ratio) { pipeline.setSize(width, height, ratio); },
    render(scene, dt) {
      mat.uniforms.uNear.value = camera.near;
      mat.uniforms.uFar.value = camera.far;
      mat.uniforms.uProjScale.value = 0.5 * mat.uniforms.uRes.value.y / Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
      mat.uniforms.uHaze.value = 1 - THREE.MathUtils.smoothstep(camera.position.y, 120, 600);
      pipeline.render(scene, camera, dt);
    },
  };
}
