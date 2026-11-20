import * as THREE from 'three';
import { Pipeline } from '../upstream/petalwake/src/core/pipeline.js';
import { distanceToRoom } from './shadow-tint.js';
import { toonEnabled, setToonLit } from './toon.js';

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
// Round 24 shadow tint (composite): AO crease tint, split-tone of the dark end.
uniform float uShOn;
uniform vec3 uShAO, uShMul, uShLift, uShRange;
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
// Crease AO by distance to the occluding plane. A sample on another surface
// occludes when it rises above the centre's plane (up) and the centre lies in
// front of the sample's own plane; the amount depends only on h, the centre's
// distance to that plane. h does not change with where on the plane a sample
// happens to land, so a wall below a ceiling darkens monotonically with its
// distance to the ceiling, whatever the projected sample radius. (Round 10
// weighted by up and by the sample's distance L; under a grazing ceiling an
// outer tap moves towards the crease as the pixel moves away from it, L shrinks,
// and the weight rose again: the second band on the shop's back wall.)
// A mailbox or hedge standing in front of a wall shows the camera its front
// face; the wall behind it is behind that plane (h < 0) and gets nothing.
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
      // The occluder must rise clearly above the centre's plane, by angle and by
      // height: millimetre grout, product faces and panel seams are not creases.
      float rise = dot(n, v);
      float up = smoothstep(0.06, 0.25, rise/max(L, 1e-4))*smoothstep(0.03, 0.12, rise);
      if (up <= 0.0 || L > 2.5*R) continue;
      float h = dot(wbNormal(s, S), P - S);   // centre's height above the sample's plane
      float near = smoothstep(-0.04, 0.0, h)*(1.0 - smoothstep(0.0, 0.6*R, h));
      // Loose range cut only for occluders far beyond the radius (no effect near a crease).
      occ += up*near*(1.0 - smoothstep(1.5*R, 2.5*R, L));
    }
  }
  // At a crease about half the samples land on the other face with near ~1;
  // 1.4 keeps the deepest corner near 70% before uAO (contact shade, not soot).
  return 1.0 - min(1.0, occ/16.0*1.4)*(1.0 - smoothstep(50.0, 90.0, d0));
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
// Round 27 outline (only with ?toon not off): a line on the NEAR side of a depth step, plus faint creases.
// Skips sky, and pixels whose coverage mask (scene alpha, see toon.js) is 0: foliage cut-outs, emissive, unlit.
const LINES = /* glsl */`
uniform float uLnOn, uLnC;
uniform vec4 uLn, uLnS;   // width px / strength / fade near / fade far ; sil lo hi / crease lo hi
uniform vec3 uLnCol;
float wbLine(vec2 uv, float d0) {
  if (d0 >= uFar*0.9 || d0 > uLn.w) return 0.0;
  float mask = texture(tColor, uv).a;
  if (mask < 0.95) return 0.0; // resolved MSAA alpha: any masked coverage at the edge pixel (blade tips, canopy cards, glass) skips the line
  float thin = smoothstep(uLn.z, uLn.w, d0);
  vec2 px = max(uLn.x*(uRes.y/1080.0)*(1.0 - 0.35*thin), 1.0)/uRes;
  float dl = wbDepth(uv-vec2(px.x,0.0)), dr = wbDepth(uv+vec2(px.x,0.0));
  float du = wbDepth(uv+vec2(0.0,px.y)), dd = wbDepth(uv-vec2(0.0,px.y));
  // Depth step on the near side. The slope of the pixel's own surface (the flatter side) is removed first,
  // so a grazing floor or wall is not a step however far it runs, and a small step can be a line.
  float gx = min(abs(dr-d0), abs(d0-dl)), gy = min(abs(du-d0), abs(d0-dd));
  float sx = max(max(dr, dl) - d0 - gx, 0.0), sy = max(max(du, dd) - d0 - gy, 0.0);
  float sil = smoothstep(uLnS.x, uLnS.y, max(sx, sy)/d0);
  // Crease: curvature of inverse depth, the same four taps (frames, sign edges, step sides)
  float i0 = 1.0/max(d0,0.05);
  float lap = max(abs(1.0/max(dl,0.05)+1.0/max(dr,0.05)-2.0*i0),abs(1.0/max(du,0.05)+1.0/max(dd,0.05)-2.0*i0))/i0;
  // A crease is a bend in continuous depth. Both sides of a real depth step have a huge curvature, but the far side
  // belongs to the line of the near side (and to its mask), so the crease is dropped wherever a neighbour is a step away.
  float jump = max(max(abs(dl-d0), abs(dr-d0)), max(abs(du-d0), abs(dd-d0)))/d0;
  float cr = smoothstep(uLnS.z, uLnS.w, lap)*uLnC*(1.0 - smoothstep(0.05, 0.12, jump));
  return max(sil, cr)*(1.0 - thin);
}
`;
const BANDS = /* glsl */`
uniform float uWorldToon;
float wbBand(float n) {
  return n < 0.0 ? 0.0 : (n < 0.12 ? 0.42 : (n < 0.42 ? 0.8 : 1.0));
}
`;

// Town greenery (#254 C15 review): inside the town and a feathered band around it
// the meadow follows the ZZZ rule "muted base, bright accents" - olive, less
// saturated grass and a thinner flower field. The open island keeps its colours.
const TOWN = /* glsl */`
uniform vec4 uTownRect;   // world min.xz, max.xz
uniform vec3 uTownGreen;  // strength, feather start, feather end (metres outside the rect)
float wbTownMask(vec2 xz) {
  vec2 d = max(uTownRect.xy - xz, xz - uTownRect.zw);
  return (1.0 - smoothstep(uTownGreen.y, uTownGreen.z, length(max(d, 0.0)))) * uTownGreen.x;
}
vec3 wbTownGreen(vec3 c, float k) {
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  return mix(c, mix(vec3(l), c, 0.62) * vec3(0.98, 0.95, 0.84) * 0.9, k);
}
`;

function insert(source, needle, replacement, label) {
  if (!source.includes(needle)) throw new Error(`Pinned upstream shader changed: ${label}`);
  return source.replace(needle, replacement);
}

export function createLook(renderer, camera) {
  const pipeline = new Pipeline(renderer);
  const toon = { value: 1 };
  // Empty rect until the town is placed: the mask is zero everywhere.
  const townUniforms = {
    uTownRect: { value: new THREE.Vector4(1e9, 1e9, -1e9, -1e9) },
    uTownGreen: { value: new THREE.Vector3(1, 12, 55) },
  };
  Object.assign(pipeline.params, {
    blur: 0, rays: 0, distortion: 0, fringe: 0,
    bloom: 0.12, exposure: 1.02, saturation: 1.0, contrast: 1.05, vignette: 0.12,
  });
  // Round 28: the motion-blur pass wrote alpha = 1, which turned the outline coverage mask (scene alpha) off for
  // every blurred pixel. Keep the centre pixel's alpha. Rewritten only with the toon on (round 26 stays as it was).
  if (toonEnabled()) pipeline.blurMat.fragmentShader = insert(pipeline.blurMat.fragmentShader, 'gl_FragColor = vec4(acc / wsum, 1.0);', 'gl_FragColor = vec4(acc / wsum, c0.a);', 'blur keeps coverage mask');
  const mat = pipeline.finalMat;
  // Round 24: composite shadow tint fades out while the camera is inside any shop box (see shadow-tint.js).
  let shBase = 0, shBox = null, shFade = 1.5;
  const camIndoor = () => {
    if (!shBox) return 1;
    const p = camera.position;
    let d = Infinity; // distance to the nearest room (0 inside any); weight 1 once the camera is shFade metres outside
    for (const b of shBox) d = Math.min(d, distanceToRoom(b, p));
    return THREE.MathUtils.smoothstep(d, 0, shFade);
  };
  Object.assign(mat.uniforms, {
    tWorldDepth: pipeline.uDepth, uNear: { value: camera.near }, uFar: { value: camera.far },
    uProjScale: { value: 1 }, uAO: { value: 0.55 },
    uReversed: { value: pipeline.reversed ? 1 : 0 }, uToon: toon, uHaze: { value: 1 },
    uLnOn: { value: 0 }, uLn: { value: new THREE.Vector4() }, uLnS: { value: new THREE.Vector4() }, uLnC: { value: 0 }, uLnCol: { value: new THREE.Vector3() },
    uShOn: { value: 0 }, uShAO: { value: new THREE.Vector3(1, 1, 1) }, uShMul: { value: new THREE.Vector3(1, 1, 1) },
    uShLift: { value: new THREE.Vector3() }, uShRange: { value: new THREE.Vector3(0.06, 0.42, 1) },
  });
  mat.fragmentShader = insert(mat.fragmentShader, 'void main(){', `${OUTLINES}\n${LINES}\nvoid main(){`, 'composite entry');
  mat.fragmentShader = insert(mat.fragmentShader, 'col *= uExposure;', `
    // Contact shadows (ZZZ refs: crates, benches, eaves all sit in soft dark creases).
    if (uAO*uToon > 0.0) {
      float wbA = wbAO(uv, wbDepth(uv)), wbAk = uAO*uToon;
      col *= mix(1.0, wbA, wbAk);
      col *= mix(vec3(1.0), uShAO, (1.0 - wbA)*wbAk*uShOn); // creases fall into blue-violet, not grey
    }
    if (uLnOn > 0.5) {
      float wbL27 = wbLine(uv, wbDepth(uv))*uToon;
      col = mix(col, col*uLnCol, wbL27*uLn.y); // round 27: dark, cool, hand-drawn line in the local colour
    } else {
    float edge = wbEdge(uv)*uToon;
    vec3 line = mix(col*vec3(0.42,0.38,0.50),vec3(0.027,0.020,0.051),0.35);
    col = mix(col,line,edge*0.45); // ZZZ scenes keep only faint silhouettes; strong lines are for characters
    }
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
    {
      // Round 24: dark end goes cool blue-violet and is lifted by the sky, sky pixels and bright lights untouched.
      float wbSh = (1.0 - smoothstep(uShRange.x, uShRange.y, wbL))*uShRange.z*uShOn*uToon*(1.0 - wbSky);
      col = mix(col, col*uShMul + uShLift, wbSh);
    }
    // Separate street lettering and paving tones while retaining ink, sky and lamp cores.
    if (uLnOn * uToon > 0.0) {
      float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
      float peak = max(col.r, max(col.g, col.b));
      float midtones = smoothstep(0.035, 0.32, luma) * (1.0 - smoothstep(0.58, 1.0, peak));
      float ink = 1.0 - smoothstep(0.025, 0.105, luma);
      vec3 streetColor = col * (1.0 + 0.43 * midtones - 0.075 * ink);
      streetColor *= mix(vec3(1.0), vec3(1.055, 1.036, 0.974), 1.0 - smoothstep(0.12, 0.57, luma));
      col = mix(col, streetColor, (1.0 - wbSky) * uHaze);
    }
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
    // Town greenery: terrain sward under the blades, the blades and the flowers.
    // The transition ring copied the terrain shader before this patch; the station
    // edge blends are created later from the transition, so patching both here
    // (sharing this look's uniform objects) carries the town tint to all of them.
    for (const [ground, label] of [[island.terrain.material, 'terrain'], [island.transition.material, 'transition']]) {
      Object.assign(ground.uniforms, townUniforms);
      ground.fragmentShader = insert(ground.fragmentShader, 'void main(){', `${TOWN}\nvoid main(){`, label + ' town entry');
      ground.fragmentShader = insert(ground.fragmentShader, 'vec3 tint = meadowTint(P.xz, wet);',
        `vec3 tint = meadowTint(P.xz, wet);
  float wbTown = wbTownMask(P.xz);
  tint = wbTownGreen(tint, wbTown);`, label + ' town sward');
      ground.fragmentShader = insert(ground.fragmentShader, 'tintAmt *= 1.0 - strippedFiltered(uv);',
        `tintAmt *= 1.0 - strippedFiltered(uv);
  tintAmt *= 1.0 - 0.75 * wbTown;`, label + ' town flower wash');
      ground.needsUpdate = true;
    }
    // Meadow builds its shell materials lazily. The prototype wrapper is installed
    // once and holds no look state: each Meadow carries the uniforms of the look
    // that adopted it, and a Meadow no look adopted gets the upstream material.
    const meadow = island.meadow, shell = Object.getPrototypeOf(meadow.shells[0]);
    if (!shell.wbTownMaterial) {
      const material = shell.material;
      shell.wbTownMaterial = function wbTownMaterial() {
        const m = material.call(this);
        const uniforms = this.meadow.wbTownUniforms;
        if (!uniforms) return m;
        Object.assign(m.uniforms, uniforms);
        m.vertexShader = insert(m.vertexShader, 'void main(){', `${TOWN}\nvoid main(){`, 'meadow town entry');
        if (this.kind === 'grass') {
          // Round 27: coverage mask 0 (alpha is unused by the pipeline, colour is unchanged) so blades take no outline.
          m.fragmentShader = insert(m.fragmentShader, 'gl_FragColor = vec4(col, 1.0);', 'gl_FragColor = vec4(col, 0.0);', 'grass outline mask');
          m.vertexShader = insert(m.vertexShader, '* mix(0.88, 1.14, cl.w);',
            `* mix(0.88, 1.14, cl.w);
  vTint = wbTownGreen(vTint, wbTownMask(xz));`, 'grass town tint');
        } else {
          // Art round 2 (island-ground.js): pastel petals island-wide.
          if (this.meadow.wbPetals) m.vertexShader = this.meadow.wbPetals(m.vertexShader);
          // Keep about a quarter of the flowers in the town core; they stay accents.
          if (toonEnabled()) {
            // Round 28: petals are alpha-to-coverage, which keeps the output alpha as the coverage mask for the outline.
            // Cut them out at 0.5 instead and write mask 0, so flowers take no outline.
            m.fragmentShader = insert(m.fragmentShader, 'gl_FragColor = vec4(col, alpha);', 'if (alpha < 0.5) discard;\n  gl_FragColor = vec4(col, 0.0);', 'flower outline mask');
            m.alphaToCoverage = false;
          }
          m.vertexShader = insert(m.vertexShader, 'float keep = step(r2.x, dens * 1.08) * step(0.03, dens);',
            `float keep = step(r2.x, dens * 1.08) * step(0.03, dens);
  keep *= step(wbTownMask(xz) * 0.75, hash12(xz * 5.31 + 3.3));`, 'flower town density');
        }
        return m;
      };
      shell.material = shell.wbTownMaterial;
    }
    meadow.wbTownUniforms = townUniforms;
    for (const s of meadow.shells) for (const mesh of s.pool) { const old = mesh.material; mesh.material = s.material(); old.dispose(); }
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
    setToon(value) { toon.value = value ? 1 : 0; setToonLit(value); },
    /** World-space town rect [minX, minZ, maxX, maxZ]; strength 0 restores the open-island meadow. */
    setTownGreenery(rect, strength = 1) {
      townUniforms.uTownRect.value.set(...rect);
      townUniforms.uTownGreen.value.x = strength;
    },
    /** Round 27: uniforms from toonLineUniforms(); null keeps the round 26 outline. */
    setToonLines(u) {
      if (!u) { mat.uniforms.uLnOn.value = 0; return; }
      for (const [k, v] of Object.entries(u)) mat.uniforms[k].value.copy ? mat.uniforms[k].value.copy(v.value) : (mat.uniforms[k].value = v.value);
    },
    setAO(value) { mat.uniforms.uAO.value = value; },
    /** Round 24: uniforms from shadowTintUniforms(); null switches the composite tint off. */
    setShadowTint(u, indoorBox = null, fade = 1.5) {
      shBox = indoorBox; shFade = fade;
      if (!u) { shBase = 0; mat.uniforms.uShOn.value = 0; return; }
      shBase = 1;
      for (const [k, v] of Object.entries(u)) mat.uniforms[k].value.copy ? mat.uniforms[k].value.copy(v.value) : (mat.uniforms[k].value = v.value);
    },
    setFlightEffects(value) { pipeline.params.blur = value ? 1 : 0; pipeline.params.rays = value ? 0.55 : 0; pipeline.hasPrev = false; },
    setSize(width, height, ratio) { pipeline.setSize(width, height, ratio); },
    render(scene, dt) {
      mat.uniforms.uShOn.value = shBase * camIndoor();
      mat.uniforms.uNear.value = camera.near;
      mat.uniforms.uFar.value = camera.far;
      mat.uniforms.uProjScale.value = 0.5 * mat.uniforms.uRes.value.y / Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
      mat.uniforms.uHaze.value = 1 - THREE.MathUtils.smoothstep(camera.position.y, 120, 600);
      pipeline.render(scene, camera, dt);
    },
  };
}
