import * as THREE from 'three';

// Round 24 (#254 X-51): shade is blue-violet and lifted instead of neutral black-grey.
//  1 lit three.js materials (station, city, skyline, props): lights_fragment_end gets a sky-lit fill
//    on everything whose direct light is low (out of the sun, behind the sun shadow, back faces).
//    Unlit MeshBasic materials (lamps, signs, sky) never include that chunk, so they stay untouched.
//  2 Petalwake terrain / transition / town / prop shaders: the same fill, driven by the baked
//    terrain shadow (uLightTex.r) and N.L, added where they sample it.
//  3 the composite pass (look.js) cools and lifts only the dark end and tints AO creases.
// Round 26: the indoor exclusion is the room itself (inner wall faces, floor, ground-floor ceiling, from ctx.services.shopInteriors),
// not the whole lot, so facades, paving and upper floors keep the fill; the composite tint fades over 0.3 m outside the room.
// ?shadowtint=off installs nothing, so the round 23 look is exactly what renders.

const f3 = (v) => v.map((x) => x.toFixed(4)).join(', ');
const vec3 = (v) => `vec3(${f3(v)})`;

/** Union bound of all (world AABB of the) boxes, so the common (outdoor) fragment pays one box test instead of one per shop. */
const unionBox = (boxes) => [0, 1, 2].map((i) => Math.min(...boxes.map((b) => b.aabb[i]))).concat([3, 4, 5].map((i) => Math.max(...boxes.map((b) => b.aabb[i]))));
const inAabb = (b) => `all( greaterThan( stW, ${vec3(b.slice(0, 3))} ) ) && all( lessThan( stW, ${vec3(b.slice(3))} ) )`;
/** One room: world position is taken into the lot frame (x along the frontage, z toward the street), y stays world. */
const inRoom = (b) => `{ vec2 d = stW.xz - vec2( ${f3(b.o)} ); vec3 q = vec3( dot( d, vec2( ${f3(b.ex)} ) ), stW.y, dot( d, vec2( ${f3(b.ez)} ) ) );
      if ( all( greaterThan( q, ${vec3(b.min)} ) ) && all( lessThan( q, ${vec3(b.max)} ) ) ) { stIn = 1.0;${b.lamp ? ` stLamp = ${vec3(b.lamp)};` : ''} } }`;
export function indoorGlsl(boxes) {
  const u = unionBox(boxes);
  // Inside any room (inner wall faces, floor, ground-floor ceiling) the fill is off: rooms keep their warm lamp-lit colours.
  return `  vec3 stW = cameraPosition + geometryPosition * mat3( viewMatrix );
  float stIn = 0.0;
  vec3 stLamp = vec3( 0.0 );
  if ( ${inAabb(u)} ) {
${boxes.map((b) => `    ${inRoom(b)}`).join('\n')}
  }`;
}

export async function loadShadowTint() {
  const json = await (await fetch(new URL('./shadow-tint.json', import.meta.url))).json();
  return json;
}

export const shadowTintEnabled = () => new URLSearchParams(location.search).get('shadowtint') !== 'off';

/** Must run before the first program that uses lights_fragment_end is compiled. */
export function installLitShadowTint(p, boxes) {
  const chunk = THREE.ShaderChunk.lights_fragment_end;
  if (chunk.includes('wbShadowTint')) return;
  THREE.ShaderChunk.lights_fragment_end = `${chunk}
#if defined( RE_IndirectDiffuse )
{ // wbShadowTint
  float stLum = dot( diffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
  float stSun = dot( reflectedLight.directDiffuse, vec3( 0.2126, 0.7152, 0.0722 ) ) / max( stLum, 0.03 );
  float stShade = 1.0 - smoothstep( ${p.sunLo.toFixed(3)}, ${p.sunHi.toFixed(3)}, stSun );
${indoorGlsl(boxes)}
  reflectedLight.indirectDiffuse += diffuseColor.rgb * ${vec3(p.fill)} * stShade * ( 1.0 - stIn ) + diffuseColor.rgb * stLamp;
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

/**
 * One oriented box per shop room, built from what the shop generators register while building
 * (ctx.services.shopInteriors: lot id + [x0, y0, z0, x1, y1, z1] in lot space = inner faces of the
 * walls, the floor and the ground-floor ceiling, e.g. shopsB: X0 + WT .. X1 - WT, ZI .. ZF - WT, FL .. Y1).
 * `pad` grows each face by a few centimetres so the wall's inner skin and the floor/ceiling surfaces sit
 * inside; it stays well under a wall thickness, so the outside of the facade, the paving in front of the
 * shop and the street-facing upper floors are outside the box.
 * Box: { id, o, ex, ez, min, max, aabb }. o = lot origin (world x, z), ex / ez = world directions of lot x / z,
 * min / max = [lot x, world y, lot z], aabb = world-axis bounds (only for the cheap pre-test).
 */
export function shopInteriorBoxes(layout, station, pad, lamps = null) {
  const root = station.root.position, rooms = station.ctx.services.shopInteriors || [];
  return rooms.map(({ lot, frame, name, box }) => {
    // A room is either in a shop lot (lot id) or in a town building with its own frame (station-root space: x, y, z, rotY).
    const id = lot ?? name, f = frame ?? layout.lotFrame(layout.lotById(lot)), c = Math.cos(f.rotY), s = Math.sin(f.rotY);
    const o = [f.x + root.x, f.z + root.z], ex = [c, -s], ez = [s, c], y = f.y + root.y;
    const min = [box[0] - pad, box[1] + y - pad, box[2] - pad], max = [box[3] + pad, box[4] + y + pad, box[5] + pad];
    const xs = [], zs = [];
    for (const lx of [min[0], max[0]]) for (const lz of [min[2], max[2]]) { xs.push(o[0] + lx * ex[0] + lz * ez[0]); zs.push(o[1] + lx * ex[1] + lz * ez[1]); }
    // Round 11: rooms whose own materials are plain lit toon (the laundromat) get their tube lights as an albedo-multiplied fill.
    const lamp = lamps?.rooms?.[id] ? lamps.color.map((v) => v * lamps.rooms[id]) : null;
    return { id, o, ex, ez, min, max, lamp, aabb: [Math.min(...xs), min[1], Math.min(...zs), Math.max(...xs), max[1], Math.max(...zs)] };
  });
}

/** Distance from a world point to the box (0 inside). The lot frame is a rigid rotation, so it is measured there. */
export function distanceToRoom(b, p) {
  const dx = p.x - b.o[0], dz = p.z - b.o[1];
  const q = [dx * b.ex[0] + dz * b.ex[1], p.y, dx * b.ez[0] + dz * b.ez[1]];
  return Math.hypot(...q.map((v, i) => Math.max(b.min[i] - v, 0, v - b.max[i])));
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
