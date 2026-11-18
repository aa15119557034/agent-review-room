import * as THREE from 'three';
import { indoorGlsl } from './shadow-tint.js';

// Round 27 (#254 X-51): Zenless-Zone-Zero style.
//  1 lit materials: the direct-light term is quantised to dark / middle / lit bands with narrow smoothstep steps
//    (lights_fragment_end, before the round 24 fill, so the fill becomes the colour of the dark band). Rooms
//    (shopInteriors boxes) are excluded exactly as in shadow-tint.js and keep their warm lamp-lit look.
//  2 a coverage mask in the alpha channel of the scene colour: opaque_fragment writes 0 for alpha-tested foliage,
//    emissive bodies and unlit materials, so the post outline skips them. Transparent materials are not touched.
//  3 an optional thin warm rim on the side facing the sun.
// The outline itself is in look.js (setToonLines). ?toon=off installs nothing: round 26 exactly.

export async function loadToon() { return (await fetch(new URL('./toon.json', import.meta.url))).json(); }
export const toonEnabled = () => new URLSearchParams(location.search).get('toon') !== 'off';

const f = (x) => Number(x).toFixed(4);
const vec3 = (v) => `vec3( ${v.map(f).join(', ')} )`;

/** Must run before the first program that uses these chunks is compiled. */
export function installLitToon(p, boxes) {
  const end = THREE.ShaderChunk.lights_fragment_end;
  if (!end.includes('wbToonBands')) {
    const [e1, e2] = p.lit.edges, w = p.lit.width, [l0, l1, l2] = p.lit.levels;
    THREE.ShaderChunk.lights_fragment_end = `${end}
#if defined( RE_IndirectDiffuse ) && NUM_DIR_LIGHTS > 0
{ // wbToonBands
  float tbLum = max( dot( diffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) ), 0.02 );
  float tbFull = dot( directionalLights[ 0 ].color, vec3( 0.2126, 0.7152, 0.0722 ) ) * RECIPROCAL_PI;
  float tbU = dot( reflectedLight.directDiffuse, vec3( 0.2126, 0.7152, 0.0722 ) ) / ( tbLum * max( tbFull, 1e-3 ) );
${indoorGlsl(boxes)}
  float tbQ = ${f(l0)} + ( ${f(l1 - l0)} ) * smoothstep( ${f(e1 - w)}, ${f(e1 + w)}, tbU ) + ( ${f(l2 - l1)} ) * smoothstep( ${f(e2 - w)}, ${f(e2 + w)}, tbU );
  float tbK = ${f(p.lit.strength)} * ( 1.0 - stIn );
  reflectedLight.directDiffuse *= mix( 1.0, tbQ / max( tbU, 0.02 ), tbK );
  // thin warm rim on the sunward side (outdoors only)
  float tbRim = pow( 1.0 - saturate( dot( normal, geometryViewDir ) ), ${f(p.rim.power)} ) * saturate( dot( normal, directionalLights[ 0 ].direction ) * 1.5 ) * smoothstep( ${f(e2 - w)}, ${f(e2 + w)}, tbU );
  reflectedLight.directDiffuse += diffuseColor.rgb * ${vec3(p.rim.color)} * ( tbRim * ${f(p.rim.strength)} * ( 1.0 - stIn ) );
}
#endif`;
  }
  const op = THREE.ShaderChunk.opaque_fragment;
  if (!op.includes('wbToonMask')) {
    THREE.ShaderChunk.opaque_fragment = `${op}
#ifdef OPAQUE
{ // wbToonMask: 1 = outline allowed. 0 = foliage cut-outs, emissive bodies, unlit materials
  float tmM = 0.0;
#if defined( RE_IndirectDiffuse )
  tmM = 1.0 - smoothstep( 0.18, 0.5, max( totalEmissiveRadiance.r, max( totalEmissiveRadiance.g, totalEmissiveRadiance.b ) ) );
#ifdef USE_ALPHATEST
  tmM = 0.0;
#endif
#endif
  gl_FragColor.a = tmM;
}
#endif`;
  }
}

/** Post-pass uniforms for look.js. */
export function toonLineUniforms(p) {
  const l = p.line, v4 = (a, b) => new THREE.Vector4(...a, ...b);
  return {
    uLnOn: { value: 1 }, uLn: { value: new THREE.Vector4(l.width, l.strength, l.fade[0], l.fade[1]) },
    uLnS: { value: v4(l.sil, l.crease) }, uLnC: { value: l.creaseWeight }, uLnCol: { value: new THREE.Vector3(...l.tint) },
  };
}
