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
    bloom: 0.07, exposure: 1.02, saturation: 1.08, contrast: 1.05, vignette: 0.12,
  });
  const mat = pipeline.finalMat;
  Object.assign(mat.uniforms, {
    tWorldDepth: pipeline.uDepth, uNear: { value: camera.near }, uFar: { value: camera.far },
    uReversed: { value: pipeline.reversed ? 1 : 0 }, uToon: toon, uHaze: { value: 1 },
  });
  mat.fragmentShader = insert(mat.fragmentShader, 'void main(){', `${OUTLINES}\nvoid main(){`, 'composite entry');
  mat.fragmentShader = insert(mat.fragmentShader, 'col *= uExposure;', `
    float edge = wbEdge(uv)*uToon;
    vec3 line = mix(col*vec3(0.42,0.38,0.50),vec3(0.027,0.020,0.051),0.35);
    col = mix(col,line,edge*0.88);
    // Anime aerial perspective: distant land fades to a cool sky haze so the
    // island behind the station reads as backdrop. Sky (far plane) and high
    // aerial cameras are left alone.
    float wbD = wbDepth(uv);
    float wbHaze = (1.0-exp(-max(wbD-110.0,0.0)/700.0)) * (1.0-step(uFar*0.9,wbD)) * uHaze * uToon;
    col = mix(col, vec3(0.62,0.74,0.92)*max(dot(col,vec3(0.2126,0.7152,0.0722))*1.15,0.55), wbHaze*0.62);
    col *= uExposure;`, 'outline stage');
  // Station soft clip below the knee keeps anime mid-tones bright and saturated;
  // ACES stays for the high aerial view (whole-island HDR) and the toon-off comparison.
  mat.fragmentShader = insert(mat.fragmentShader, 'col = acesFilm(col * 0.92);', `
    // Shoulder on the brightest channel so sunlit flower fields keep their hue.
    float wbPeak = max(max(col.r, col.g), max(col.b, 1e-4));
    float wbClip = min(wbPeak, 0.72) + 0.28 * (1.0 - exp(-max(wbPeak - 0.72, 0.0) / 0.28));
    col = mix(acesFilm(col * 0.92), col * (wbClip / wbPeak), uToon * uHaze);`, 'tone curve');
  mat.fragmentShader = insert(mat.fragmentShader, 'col = clamp(col, 0.0, 1.0);', `
    col = mix(col, col*vec3(0.9,0.92,1.1), (1.0-smoothstep(0.08,0.55,l))*0.4*uToon);
    col += vec3(0.022,0.012,-0.012)*smoothstep(0.55,1.0,l)*uToon;
    col = clamp(col, 0.0, 1.0);`, 'purple shadows');

  function applyIsland(island) {
    for (const [material, needle, normal] of [
      [island.terrain.material, 'float dif = saturate((ndlRaw + 0.32 * soft) / (1.0 + 0.32 * soft));', 'ndlRaw'],
      [island.town.material, 'float dif = saturate(ndl);', 'ndl'],
    ]) {
      material.uniforms.uWorldToon = toon;
      material.fragmentShader = insert(material.fragmentShader, 'void main(){', `${BANDS}\nvoid main(){`, 'island bands entry');
      material.fragmentShader = insert(material.fragmentShader, needle,
        `${needle}\n  dif = mix(dif, wbBand(${normal}), uWorldToon);`, 'island diffuse band');
      material.needsUpdate = true;
    }
  }
  return {
    pipeline, applyIsland,
    setToon(value) { toon.value = value ? 1 : 0; },
    setFlightEffects(value) { pipeline.params.blur = value ? 1 : 0; pipeline.params.rays = value ? 0.55 : 0; pipeline.hasPrev = false; },
    setSize(width, height, ratio) { pipeline.setSize(width, height, ratio); },
    render(scene, dt) {
      mat.uniforms.uNear.value = camera.near;
      mat.uniforms.uFar.value = camera.far;
      mat.uniforms.uHaze.value = 1 - THREE.MathUtils.smoothstep(camera.position.y, 120, 600);
      pipeline.render(scene, camera, dt);
    },
  };
}
