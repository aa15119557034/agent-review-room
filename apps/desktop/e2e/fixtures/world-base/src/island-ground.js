import { Color, Matrix4, Vector4 } from 'three';

// The same paint colors and blend curve are used by the station lawn and island.
export const SWARD_COOL = '#3c8569';
export const SWARD_WARM = '#b2c449';
export const SWARD_WARMTH = 'float swardWarmth(float tone) { return smoothstep(0.16, 0.84, tone); }';

// X-51 art round 2 (#254): island-wide ground.
//  1 flower drifts: the meadow's flower density is gathered into broad drifts (60–250 m) with calm
//    green between them, instead of one even confetti over the whole island. Edits the terrain splat
//    (R = flower density), so the terrain flower wash, the flower instances and splatAt() agree.
//  2 petals: hot magenta and red are pulled toward pastel; the far flower wash gets the same.
//  3 sward: the far grass mottling is gathered into three soft value steps (painted patches).
//  4 rock: cliff strata lose photographic contrast and settle into three flat value steps.
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

/** Terrain and the transition ring (which copied the terrain shader). */
export function patchGroundShader(material, p, label, painted = null) {
  let s = material.fragmentShader;
  material.uniforms.uWbGround = material.uniforms.uWbGround || { value: 1 };
  s = insert(s, 'void main(){', `uniform float uWbGround;\n${STEP3}\nvoid main(){`, label + ' entry');
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
void main(){`, label + ' station paint');
    // The original vegetation coverage controls where the grass paint can appear.
    const floor = 'vec3 meadow = mix(swardFar * mix(vec3(1.0), gDetail, 0.35), swardNear, nearK);';
    s = insert(s, floor, `${floor}
  float paintCover = smoothstep(0.14, 0.64, splat.a) * uWbGround;`, label + ' painted meadow');
    s = insert(s, 'm.n = mg.n * 0.6 * nearK;', 'm.n = mg.n * 0.6 * nearK * (1.0 - 0.9 * paintCover);', label + ' smooth sward normal');
    const lighting = 'vec3 col = m.c * (uSunColor * dif * sh + amb);';
    s = insert(s, lighting, `${lighting}
  if (paintCover > 0.0 && soft > 0.0) {
    vec2 localXZ = (uWbWorldToStation * vec4(P, 1.0)).xz;
    vec2 paintXZ = vec2(localXZ.x + 0.43 * localXZ.y, localXZ.y * 0.72);
    float field = 0.61 * vnoise(paintXZ / 5.0)
      + 0.30 * vnoise(paintXZ / 21.0 + 37.0)
      + 0.09 * vnoise(vec2(paintXZ.x, paintXZ.y * 1.65) / 4.5 + 61.0);
    float tone = 0.60 * smoothstep(0.37, 0.49, field) + 0.40 * smoothstep(0.52, 0.64, field);
    // Clouds soften the value, while ground, buildings and slopes determine the hue.
    float sunlit = smoothstep(0.18, 0.70, sh / max(cs, 0.05)) * smoothstep(-0.13, 0.12, ndlRaw);
    tone *= mix(0.46, 1.0, sunlit);
    tone *= mix(1.0, 0.70, smoothstep(240.0, 650.0, dist));
    float warmth = 0.64 * swardWarmth(tone);
    float light = mix(0.39, 0.46, sunlit);
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
    vec3 paintLit = paint * light * mix(0.92, 1.0, cs);
    paintLit = mix(paintLit, fcol * (uSunColor * dif * sh + amb), saturate(tintAmt));
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
    const stem = 'float stemH = mix(0.58, 1.04, rnd.x) * shp.w * (0.7 + 0.3 * splat.a);';
    shader = insert(shader, stem, `${stem}
  stemH *= mix(0.58, 1.0, max(wbTownMask(xz), smoothstep(0.13, 0.38, splat.r)));`, 'short open-meadow stems');
  }
  return shader;
}
