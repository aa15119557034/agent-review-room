import * as THREE from 'three';

// Round 24 (#254 X-51): shade is blue-violet and lifted instead of neutral black-grey.
//  1 lit three.js materials (station, city, skyline, props): lights_fragment_end gets a sky-lit fill
//    on everything whose direct light is low (out of the sun, behind the sun shadow, back faces).
//    Unlit MeshBasic materials (lamps, signs, sky) never include that chunk, so they stay untouched.
//  2 Petalwake terrain / transition / town / prop shaders: the same fill, driven by the baked
//    terrain shadow (uLightTex.r) and N.L, added where they sample it.
//  3 the composite pass (look.js) cools and lifts only the dark end and tints AO creases.
// ?shadowtint=off installs nothing, so the round 23 look is exactly what renders.

const f3 = (v) => v.map((x) => x.toFixed(4)).join(', ');
const vec3 = (v) => `vec3(${f3(v)})`;

export async function loadShadowTint() {
  const json = await (await fetch(new URL('./shadow-tint.json', import.meta.url))).json();
  return json;
}

export const shadowTintEnabled = () => new URLSearchParams(location.search).get('shadowtint') !== 'off';

/** Must run before the first program that uses lights_fragment_end is compiled. */
export function installLitShadowTint(p, box) {
  const chunk = THREE.ShaderChunk.lights_fragment_end;
  if (chunk.includes('wbShadowTint')) return;
  THREE.ShaderChunk.lights_fragment_end = `${chunk}
#if defined( RE_IndirectDiffuse )
{ // wbShadowTint
  float stLum = dot( diffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
  float stSun = dot( reflectedLight.directDiffuse, vec3( 0.2126, 0.7152, 0.0722 ) ) / max( stLum, 0.03 );
  float stShade = 1.0 - smoothstep( ${p.sunLo.toFixed(3)}, ${p.sunHi.toFixed(3)}, stSun );
  // Inside the shop (padded box, world space) the fill is off: the room keeps its warm lamp-lit colours.
  vec3 stW = cameraPosition + geometryPosition * mat3( viewMatrix );
  float stIn = float( all( greaterThan( stW, ${vec3(box.slice(0, 3))} ) ) && all( lessThan( stW, ${vec3(box.slice(3))} ) ) );
  reflectedLight.indirectDiffuse += diffuseColor.rgb * ${vec3(p.fill)} * stShade * ( 1.0 - stIn );
}
#endif`;
}

function patchShader(material, edits, label) {
  let src = material.fragmentShader, hit = 0;
  for (const [needle, replacement] of edits) {
    if (!src.includes(needle)) continue;
    src = src.replace(needle, replacement); hit++;
  }
  if (!hit) return false;
  material.fragmentShader = src; material.needsUpdate = true;
  return true;
}

/** Island shaders (terrain, ground transition, town roofs, props). Run before the station copies the transition. */
export function patchIslandShadowTint(island, p) {
  const fill = vec3(p.terrainFill);
  const edits = [
    ['vec3 col = m.c * (uSunColor * dif * sh + amb);', `vec3 col = m.c * (uSunColor * dif * sh + amb + ${fill} * (1.0 - saturate(dif * sh)));`],
    ['vec3 col = alb * (uSunColor * dif * sunVis * mix(0.80, 1.0, ao) + amb);', `vec3 col = alb * (uSunColor * dif * sunVis * mix(0.80, 1.0, ao) + amb + ${fill} * (1.0 - saturate(dif * sunVis)));`],
    ['vec3 col = alb * (uSunColor * dif * sun + amb);', `vec3 col = alb * (uSunColor * dif * sun + amb + ${fill} * (1.0 - saturate(dif * sun)));`],
  ];
  const seen = new Set([island.terrain.material, island.transition.material, island.town.material]);
  island.root.traverse((o) => { for (const m of [].concat(o.material || [])) if (m.isShaderMaterial) seen.add(m); });
  let patched = 0;
  for (const m of seen) if (patchShader(m, edits)) patched++;
  return { patched };
}

/** World-space box [minX, minY, minZ, maxX, maxY, maxZ] of the convenience-store interior, padded. */
export function shopInteriorBox(layout, station, pad) {
  const lot = layout.LOTS.find((l) => l.kind === 'konbini'), f = layout.lotFrame(lot), o = station.root.position;
  const xs = [], zs = [];
  for (const lx of [-f.w / 2, f.w / 2]) for (const lz of [0, -f.depth]) { const c = layout.lotToWorld(lot, lx, lz); xs.push(c.x); zs.push(c.z); }
  return [Math.min(...xs) + o.x - pad, o.y - 1, Math.min(...zs) + o.z - pad, Math.max(...xs) + o.x + pad, o.y + 7, Math.max(...zs) + o.z + pad];
}

/** Uniforms for the composite pass. */
export function shadowTintUniforms(p) {
  const q = p.post, v = (a) => new THREE.Vector3(...a);
  return {
    uShOn: { value: 1 }, uShAO: { value: v(p.aoTint) },
    uShMul: { value: v(q.mul) }, uShLift: { value: v(q.lift) },
    uShRange: { value: new THREE.Vector3(q.lo, q.hi, q.strength) },
  };
}
