import { Color, Matrix4, Vector4 } from 'three';

// The same paint colors and blend curve are used by the station lawn and island.
export const SWARD_COOL = '#3c8569';
export const SWARD_WARM = '#b2c449';
export const SWARD_WARMTH = 'float swardWarmth(float tone) { return smoothstep(0.16, 0.84, tone); }';
export const SWARD_DAPPLE = /* glsl */`
float swardMeadow(vec2 xz) {
  float hillside = 1.0 - smoothstep(85.0, 155.0, distance(xz, vec2(1060.0, 557.0)));
  float headland = 1.0 - smoothstep(31.0, 58.0, distance(xz, vec2(174.0, -1231.0)));
  return max(hillside, headland);
}
float swardDapple(vec2 xz, float time) {
  float coverage = swardMeadow(xz);
  if (coverage <= 0.0) return 0.0;
  vec2 q = vec2(0.83*xz.x + 0.56*xz.y, -0.56*xz.x + 0.83*xz.y);
  q += vec2(0.13, -0.04) * time;
  float cloud = 0.72 * vnoise(q / vec2(14.0, 9.0) + vec2(17.0, 9.0))
              + 0.28 * vnoise(q / vec2(7.0, 5.2) + vec2(3.0, 21.0));
  return coverage * smoothstep(0.51, 0.56, cloud);
}
`;
export const SWARD_PAINT_FIELD = /* glsl */ `    vec2 paintXZ = vec2(localXZ.x + 0.43 * localXZ.y, localXZ.y * 0.72);
    float field = 0.52 * vnoise(paintXZ / 14.0)
      + 0.36 * vnoise(paintXZ / 47.0 + 37.0)
      + 0.12 * vnoise(vec2(paintXZ.x, paintXZ.y * 1.65) / 4.5 + 61.0);
    float tone = 0.52 * smoothstep(0.34, 0.44, field) + 0.48 * smoothstep(0.52, 0.61, field);`;
export const SWARD_EXPOSURE = /* glsl */ `    tone *= mix(0.46, 1.0, sunlit);
    tone *= mix(1.0, 0.70, smoothstep(240.0, 650.0, dist));
    float warmth = 0.64 * swardWarmth(tone);
    float light = mix(0.35, 0.49, sunlit);
    float meadowExposure = swardMeadow(P.xz) * sunlit;
    float dappleShade = swardDapple(P.xz, uTime);
    warmth = mix(warmth, max(warmth, 0.24 + 0.49 * swardWarmth(tone)), meadowExposure);
    warmth *= 1.0 - 0.83 * dappleShade;`;

// X-51 art round 2 (#254): island-wide ground.
//  1 flower drifts: the meadow's flower density is gathered into broad drifts (60–250 m) with calm
//    green between them, instead of one even confetti over the whole island. Edits the terrain splat
//    (R = flower density), so the terrain flower wash, the flower instances and splatAt() agree.
//  2 petals: hot magenta and red are pulled toward pastel; the far flower wash gets the same.
//  3 sward: the far grass mottling is gathered into three soft value steps (painted patches).
//  4 stone and mountains: broad painted values with a few world-space joints and strokes.
// ?ground=off installs nothing.
export const groundEnabled = () => new URLSearchParams(location.search).get('ground') !== 'off';

export async function loadGround() {
  return (await fetch(new URL('./island-ground.json', import.meta.url))).json();
}

function hash(ix, iz, seed) {
  let h = (ix * 374761393 + iz * 668265263 + seed * 2246822519) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function valueNoise(x, z, seed) {
  const ix = Math.floor(x), iz = Math.floor(z), fx = x - ix, fz = z - iz;
  const sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
  const a = hash(ix, iz, seed), b = hash(ix + 1, iz, seed), c = hash(ix, iz + 1, seed), d = hash(ix + 1, iz + 1, seed);
  return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz;
}
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** Gathers flower density into drifts. Returns stats for the evidence. */
export function applyFlowerDrifts(terrain, worldSize, p) {
  const S = terrain.splatN, cell = worldSize / S, half = worldSize / 2;
  let before = 0, after = 0;
  for (let j = 0; j < S; j++) {
    const z = j * cell - half;
    for (let i = 0; i < S; i++) {
      const k = (j * S + i) * 4, f = terrain.splat[k];
      if (!f) continue;
      const x = i * cell - half;
      const n = 0.6 * valueNoise(x / p.scale, z / p.scale, 7) + 0.3 * valueNoise(x / (p.scale * 0.37), z / (p.scale * 0.37), 11)
        + 0.1 * valueNoise(x / (p.scale * 0.12), z / (p.scale * 0.12), 13);
      const keep = p.floor + (1 - p.floor) * smooth(p.lo, p.hi, n);
      const next = Math.round(f * keep * p.gain);
      before += f; after += next;
      terrain.splat[k] = Math.min(255, next);
    }
  }
  terrain.splatTex.image.data.set(terrain.splat);
  terrain.splatTex.needsUpdate = true;
  return { before, after, ratio: after / before };
}

function insert(source, needle, replacement, label) {
  if (!source.includes(needle)) throw new Error(`island-ground: ${label} needle missing`);
  return source.replace(needle, replacement);
}
const f = (x) => Number(x).toFixed(4);
const v3 = (a) => `vec3(${a.map(f).join(', ')})`;

// Soft three-step: flat inside a step, a narrow ramp between steps (no hard aliasing at distance).
const STEP3 = `
float wbGStep3(float x, float w){
  float y = clamp(x, 0.0, 1.0) * 2.0;
  float i = floor(y), t = y - i;
  return (i + smoothstep(0.5 - w, 0.5 + w, t)) / 2.0;
}`;

const PAINTED_STONE = `
float wbPaintHash(vec2 tile) {
  vec3 n = fract(tile.xyx * vec3(0.1031, 0.11369, 0.13787));
  n += dot(n, n.yzx + 19.19);
  return fract((n.x + n.y) * n.z);
}

vec3 wbPaving(vec2 xz, float footprint, float flag) {
  vec2 tileSize = mix(vec2(0.55, 0.38), vec2(1.17, 0.84), flag);
  vec2 grid = vec2(xz.x + 0.16*xz.y, xz.y - 0.16*xz.x) / tileSize;
  float row = floor(grid.y);
  grid.x += 0.50*mod(row, 2.0) + 0.19*(wbPaintHash(vec2(97.0, row)) - 0.5);
  vec2 tile = floor(grid);
  vec2 uv = fract(grid);
  float tone = wbPaintHash(tile);
  float detail = 1.0 - smoothstep(0.10, 0.41, footprint / tileSize.y);
  vec3 low = mix(vec3(0.155, 0.161, 0.171), vec3(0.239, 0.226, 0.205), flag);
  vec3 mid = mix(vec3(0.185, 0.188, 0.191), vec3(0.276, 0.258, 0.229), flag);
  vec3 high = mix(vec3(0.212, 0.210, 0.203), vec3(0.307, 0.280, 0.247), flag);
  vec3 face = tone < 0.24 ? low : (tone < 0.71 ? mid : high);

  // Slightly clipped corners and uneven starts leave broken ink between the painted faces.
  vec2 tip = abs(uv - 0.5);
  float roundCorner = (tip.x + tip.y - mix(0.84, 0.92, flag)) * 0.7;
  float edge = 0.5 - max(max(tip.x, tip.y), 0.5 + roundCorner);
  float aa = max(footprint / tileSize.y, 0.007);
  float joint = (1.0 - smoothstep(0.008, 0.012 + aa, edge)) *
                smoothstep(0.28, 0.55, tone + mix(0.4, -0.05, uv.x));
  float lineY = 0.20 + 0.59*wbPaintHash(tile + vec2(7.0, 17.0));
  float stroke = (1.0 - smoothstep(0.010, 0.012 + aa, abs(uv.y - lineY - 0.15*(uv.x - 0.5)))) *
                 smoothstep(0.16, 0.30, uv.x) * (1.0 - smoothstep(0.41, 0.71, uv.x));
  return mix(mid, face, detail) * (1.0 - detail*(0.19*joint + 0.12*stroke*step(0.86, tone)));
}

vec3 wbPackedEarth(vec2 xz, float footprint, float stoneHeight) {
  // The original cobble height channel locates each stone and seam. Paint the faces without normal-map relief.
  float field = 0.79*vnoise(xz / 1.35 + 37.0) + 0.21*stoneHeight;
  float tone = wbGStep3((field - 0.24) / 0.56, 0.10);
  vec3 mid = vec3(0.310, 0.256, 0.193);
  vec3 earth = tone < 0.5 ? mix(vec3(0.263, 0.212, 0.157), mid, tone*2.0)
                          : mix(mid, vec3(0.350, 0.290, 0.221), tone*2.0 - 1.0);
  float aa = clamp(0.32*footprint, 0.014, 0.075);
  float face = smoothstep(0.32 - aa, 0.32 + aa, stoneHeight);
  float lip = smoothstep(0.34 - aa, 0.39, stoneHeight) * (1.0 - smoothstep(0.44, 0.46 + aa, stoneHeight));
  float detail = 1.0 - smoothstep(0.09, 0.30, footprint);
  vec3 grout = vec3(0.195, 0.159, 0.122);
  vec2 grid = xz / vec2(0.63, 0.45);
  vec2 cell = floor(grid);
  vec2 uv = fract(grid);
  float n = wbPaintHash(cell + 53.0);
  float y = uv.y - mix(0.23, 0.67, n) - 0.27*(uv.x - 0.5);
  float mark = (1.0 - smoothstep(0.011, 0.024 + footprint, abs(y))) *
               smoothstep(0.19, 0.36, uv.x) * (1.0 - smoothstep(0.48, 0.72, uv.x));
  earth *= 1.0 + detail*(0.12*lip - 0.20*mark*step(0.74, n));
  return mix(grout, earth, mix(0.72, face, detail));
}

float wbMountainStroke(vec3 p, float footprint) {
  // Broken diagonal marks stay attached to the rock face, with no bands drawn across the whole slope.
  vec2 grid = vec2(dot(p.xz, vec2(0.72, -0.69)),
                  p.y + dot(p.xz, vec2(0.19, -0.12))) / vec2(47.0, 29.0);
  vec2 tile = floor(grid);
  vec2 uv = fract(grid);
  float n = wbPaintHash(tile + vec2(5.0, 67.0));
  float y = uv.y - mix(0.24, 0.63, n) - mix(-0.38, 0.18, n)*(uv.x - 0.5);
  float line = 1.0 - smoothstep(0.013, 0.035 + footprint / 29.0, abs(y));
  return line * smoothstep(0.13, 0.34, uv.x) * (1.0 - smoothstep(0.52, 0.84, uv.x)) *
         step(0.56, n) * (1.0 - smoothstep(0.75, 2.8, footprint));
}`;

/** Terrain and the transition ring (which copied the terrain shader). */
export function patchGroundShader(material, p, label, painted = null, paintExposure = 1) {
  let s = material.fragmentShader;
  material.uniforms.uWbGround = material.uniforms.uWbGround || { value: 1 };
  s = insert(s, 'void main(){', `uniform float uWbGround;\n${STEP3}\n${PAINTED_STONE}\nvoid main(){`, label + ' entry');
  // sward: painted patches instead of continuous mottling
  s = insert(s, 'float mott = ntexA(P.xz * 0.55).r * 0.5 + nzA.b * 0.3 + nzB.a * 0.2;',
    `float mott = ntexA(P.xz * 0.55).r * 0.5 + nzA.b * 0.3 + nzB.a * 0.2;
  mott = mix(mott, wbGStep3((mott - 0.2) / 0.6, ${f(p.swardEdge)}) * 0.6 + 0.2, uWbGround * ${f(p.swardSteps)});`, label + ' sward steps');
  // near ground between the blades: less photographic thatch
  s = insert(s, 'vec3 gDetail = mix(mg.c / uMean[3], mg2.c / uMean[3], 0.45);',
    `vec3 gDetail = mix(mg.c / uMean[3], mg2.c / uMean[3], 0.45);
  gDetail = mix(gDetail, vec3(1.0), uWbGround * ${f(p.thatchFlatten)});`, label + ' thatch');
  if (painted) {
    Object.assign(material.uniforms, {
      uWbStationSwardField: { value: null },
      uWbStationSwardRect: { value: new Vector4() },
      uWbWorldToStation: { value: new Matrix4() },
    });
    s = insert(s, 'void main(){', `
uniform sampler2D uWbStationSwardField;
uniform vec4 uWbStationSwardRect;
uniform mat4 uWbWorldToStation;
${SWARD_WARMTH}
${SWARD_DAPPLE}
void main(){`, label + ' station paint');
    s = insert(s, 'vec3 N = terrainN(P.xz, lodN);\n\n  vec4 splat = texture(uSplatTex, uv);', `
  vec4 splat = texture(uSplatTex, uv);
  // A continuous distance LOD keeps broad grassy folds from taking their
  // lighting scale from the adjacent rendered triangles.
  float nearbySwardLod = mix(0.72, 1.28, swardMeadow(P.xz));
  float swardLod = mix(nearbySwardLod, 2.35, smoothstep(32.0, 430.0, dist));
  float swardNormal = smoothstep(0.35, 0.85, splat.a) * uWbGround;
  vec3 N = terrainN(P.xz, mix(lodN, swardLod, swardNormal));`, label + ' continuous grass normals');
    // The meadow at the apartment's outer fence suppresses blades in the splat
    // map. Treat the grass surface independently of that foliage exclusion.
    const floor = 'vec3 meadow = mix(swardFar * mix(vec3(1.0), gDetail, 0.35), swardNear, nearK);';
    s = insert(s, floor, `${floor}
  vec2 localXZ = (uWbWorldToStation * vec4(P, 1.0)).xz;
  vec2 alleyX = vec2(-17.0, 14.0);
  vec2 alleyZ = vec2(-143.0, -131.0);
  float alleyEdge = min(min(localXZ.x - alleyX.x, alleyX.y - localXZ.x),
                       min(localXZ.y - alleyZ.x, alleyZ.y - localXZ.y));
  float alleyLawn = smoothstep(-1.0, 2.5, alleyEdge);
  float paintCover = max(smoothstep(0.14, 0.64, splat.a), alleyLawn) * uWbGround;`, label + ' painted meadow');
    s = insert(s, 'm.n = mg.n * 0.6 * nearK;', 'm.n = mg.n * 0.6 * nearK * (1.0 - 0.9 * paintCover);', label + ' smooth sward normal');
    const lighting = 'vec3 col = m.c * (uSunColor * dif * sh + amb);';
    s = insert(s, lighting, `${lighting}
  if (paintCover > 0.0 && soft > 0.0) {
${SWARD_PAINT_FIELD}
    // Clouds soften the value, while ground, buildings and slopes determine the hue.
    float sunlit = smoothstep(0.18, 0.70, sh / max(cs, 0.05)) * smoothstep(-0.13, 0.12, ndlRaw);
${SWARD_EXPOSURE}
    if (uWbStationSwardRect.z > 0.0) {
      vec2 lawnXY = localXZ - uWbStationSwardRect.xy;
      vec2 beyondLawn = max(max(-lawnXY, lawnXY - uWbStationSwardRect.zw), vec2(0.0));
      float lawnDistance = length(beyondLawn);
      float overlap = 1.0 - smoothstep(0.0, 18.0, lawnDistance);
      if (overlap > 0.0) {
        float stationTone = texture(uWbStationSwardField, clamp(lawnXY / uWbStationSwardRect.zw, 0.0, 1.0)).g;
        warmth = mix(warmth, swardWarmth(stationTone), overlap);
      }
      // Keep the cool face of the slope near the station within the lawn's shade range.
      float shoulder = 1.0 - smoothstep(20.0, 43.0, lawnDistance);
      light = mix(light, max(light, 0.63 + 0.02 * sunlit), shoulder);
      warmth = max(warmth, 0.12 * shoulder * sunlit);
    }
    vec3 paint = mix(${v3(new Color(SWARD_COOL).toArray())}, ${v3(new Color(SWARD_WARM).toArray())}, warmth);
    vec3 paintLit = paint * light * mix(0.92, 1.0, cs) * ${f(paintExposure)};
    paintLit = mix(paintLit, fcol * (uSunColor * dif * sh + amb), saturate(tintAmt));
    paintLit *= mix(vec3(1.0), vec3(0.54, 0.73, 0.88), dappleShade * mix(0.65, 1.0, sunlit));
    col = mix(col, paintLit, paintCover * soft);
  }`, label + ' continuous sward lighting');
    if (label === 'terrain') {
      // Glancing depth samples on smooth ground can look like repeated contours
      // to the post outline. Keep the ink mask for cliffs, not the sward or sand.
      s = insert(s, 'gl_FragColor = vec4(col, 1.0);',
        'gl_FragColor = vec4(col, mix(1.0, smoothstep(0.32, 0.75, rockAmt), uWbGround));',
        label + ' natural ground outline mask');
    }
  }
  // far flower wash: same pastel pull as the petals
  s = insert(s, 'vec3 fcol = texture(uTintTex, uv).rgb;',
    `vec3 fcol = texture(uTintTex, uv).rgb;
  fcol = mix(fcol, mix(vec3(dot(fcol, vec3(0.299, 0.587, 0.114))), fcol, ${f(p.petalSat)}) * ${f(p.petalGain)} + ${f(p.petalLift)}, uWbGround);`, label + ' flower wash');
  // rock: three flat values on a painted palette, little photographic texture
  s = insert(s, 'vec3 rc = mix(topC, wallC, side);',
    `vec3 rc = mix(topC, wallC, side);
  {
    float wbL = dot(rc, vec3(0.299, 0.587, 0.114));
    float q = wbGStep3((wbL - ${f(p.rockLo)}) / ${f(p.rockHi - p.rockLo)}, ${f(p.rockEdge)});
    vec3 painted = q < 0.5 ? mix(${v3(p.rockDark)}, ${v3(p.rockMid)}, q * 2.0) : mix(${v3(p.rockMid)}, ${v3(p.rockLight)}, q * 2.0 - 1.0);
    rc = mix(rc, painted, uWbGround * ${f(p.rockPaint)});
  }`, label + ' rock paint');
  s = insert(s, 'vec3 rn = normalize(N + nx * b.x + nz * b.z + ny * b.y);',
    `vec3 rn = normalize(N + (nx * b.x + nz * b.z + ny * b.y) * (1.0 - uWbGround * ${f(p.rockFlatten)}));`, label + ' rock normal');
  // The town mask and the original height blend still define each paved surface's edge.
  s = insert(s, 'm.c = mix(m.c, mp.c, paved);', `float flag = saturate(town.g / max(town.r + town.g, 1e-3));
    float footprint = max(length(dPx.xz), length(dPy.xz));
    vec3 stonePaint = earth < 1.0 ? wbPaving(P.xz, footprint, flag) : vec3(0.0);
    vec3 dirtPaint = earth > 0.0 ? wbPackedEarth(P.xz, footprint, mc.h) : vec3(0.0);
    mp.c = mix(mp.c, mix(stonePaint, dirtPaint, earth), uWbGround);
    mp.n *= 1.0 - uWbGround;
    m.c = mix(m.c, mp.c, paved);`, label + ' painted stone road');
  const lightStart = 'float cs = cloudShadow(P.xz, uTime);';
  s = insert(s, lightStart, `
  // Far mountain values follow terrain relief at a broad scale, replacing triplanar photo relief.
  float mountain = smoothstep(130.0, 300.0, dist) * smoothstep(75.0, 155.0, P.y)
                 * smoothstep(0.17, 0.64, rockAmt) * uWbGround;
  if (mountain > 0.0) {
    vec3 macroN = terrainN(P.xz, max(lodN, mix(2.7, 3.5, smoothstep(170.0, 620.0, dist))));
    vec3 ridgeN = normalize(mix(macroN, N, 0.27));
    float relief = dot(ridgeN, normalize(vec3(-0.55, 0.71, 0.39)));
    float tone = wbGStep3((relief - 0.06) / 0.62, 0.075);
    vec3 granite = tone < 0.5 ? mix(vec3(0.112, 0.129, 0.156), vec3(0.185, 0.199, 0.218), tone*2.0)
                              : mix(vec3(0.185, 0.199, 0.218), vec3(0.278, 0.287, 0.298), tone*2.0 - 1.0);
    granite *= 1.0 - 0.17*wbMountainStroke(P, max(length(dPx), length(dPy)));
    m.c = mix(m.c, granite, mountain);
    Nw = normalize(mix(Nw, ridgeN, mountain));
    m.r = mix(m.r, 0.94, mountain);
  }
  ${lightStart}`, label + ' distant mountain paint');
  s = insert(s, 'float cav = mix(1.0, 0.55 + 0.45 * m.h, 0.7 * max(max(rockAmt, lowW), paved));',
    `float paintedStone = max(mountain, paved * uWbGround);
  float cav = mix(1.0, 0.55 + 0.45 * m.h, 0.7 * max(max(rockAmt, lowW), paved) * (1.0 - paintedStone));`,
    label + ' flat stone shading');
  s = insert(s, 'float specMask = max(rockAmt, lowW);',
    'float specMask = max(rockAmt, lowW) * (1.0 - 0.96 * paintedStone);', label + ' remove stone relief gloss');
  // Round 4: aerial perspective. Distant land settles toward the sky colour along the view ray and
  // loses saturation, so far hills read as a soft layer behind the town instead of a grey-green wall.
  if (p.hazeAmt > 0) s = insert(s, 'col = applyAtmosphere(col, P);',
    `{
    float wbFar = smoothstep(${f(p.hazeNear)}, ${f(p.hazeFar)}, dist) * uWbGround;
    vec3 wbD = -V;
    vec3 wbSky = skyBase(normalize(vec3(wbD.x, max(wbD.y, 0.0) * 0.5 + 0.06, wbD.z)));
    float wbL = dot(col, vec3(0.299, 0.587, 0.114));
    col = mix(col, vec3(wbL), wbFar * ${f(p.hazeDesat)});
    col = mix(col, wbSky * ${f(p.hazeGain)}, wbFar * ${f(p.hazeAmt)});
  }
  col = applyAtmosphere(col, P);`, label + ' aerial haze');
  material.fragmentShader = s;
  material.needsUpdate = true;
}

/** Flower petals (meadow flower shells, vertex shader). */
export function patchPetals(vertexShader, p, shortOpenStems = false) {
  let shader = insert(vertexShader, 'vec3 petal = flowerPetal(species, rnd.z);',
    `vec3 petal = flowerPetal(species, rnd.z);
  petal = mix(vec3(dot(petal, vec3(0.299, 0.587, 0.114))), petal, ${f(p.petalSat)}) * ${f(p.petalGain)} + ${f(p.petalLift)};`, 'petal palette');
  if (shortOpenStems) {
    shader = insert(shader, 'void main(){', `#ifdef FLOWER_BED
${SWARD_DAPPLE}
#endif
void main(){`, 'flower bed dapple');
    const silhouette = 'vec4 shp = flowerShape(species);';
    shader = insert(shader, silhouette, `#ifdef FLOWER_BED
  petal *= mix(vec3(1.0), vec3(0.88, 0.94, 1.0), swardDapple(xz, uTime));
  #endif
  ${silhouette}`, 'flower bed shade');
    const stem = 'float stemH = mix(0.58, 1.04, rnd.x) * shp.w * (0.7 + 0.3 * splat.a);';
    shader = insert(shader, stem, `${stem}
  #ifndef FLOWER_BED
  stemH *= mix(0.58, 1.0, max(wbTownMask(xz), smoothstep(0.13, 0.38, splat.r)));
  #endif`, 'short open-meadow stems');
    const habitats = p.flowerBeds.map(({ bounds: [x0, z0, x1, z1], feather }) =>
      `smoothstep(0.0, ${f(feather)}, min(min(xz.x - ${f(x0)}, ${f(x1)} - xz.x), min(xz.y - (${f(z0)}), (${f(z1)}) - xz.y)))`);
    const cover = habitats.reduce((a, b) => `max(${a}, ${b})`, '0.0');
    const keep = 'float keep = step(r2.x, dens * 1.08) * step(0.03, dens);';
    shader = insert(shader, keep, `${keep}
  // Keep the established broad drifts and replace only the open scatter between these beds.
  keep *= 1.0 - ${cover};`, 'flower bed spacing');
  }
  return shader;
}
