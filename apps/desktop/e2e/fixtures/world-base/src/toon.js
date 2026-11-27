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
/** Runtime strengths of the compiled-in lit toon (1 on, 0 off). Shared by every program that carries the chunk. */
export const toonLitUniforms = { uTbK: { value: 1 }, uTbRim: { value: 1 } };
export const setToonLit = (on) => { toonLitUniforms.uTbK.value = toonLitUniforms.uTbRim.value = on ? 1 : 0; };
/** Round 12: ?grade=off leaves the final grade stage out of the shader altogether (round 11 pixels). */
export const gradeEnabled = () => new URLSearchParams(location.search).get('grade') !== 'off';
export const formEnabled = () => new URLSearchParams(location.search).get('form') !== 'old';
/** Round 19: outline for printed signs, light boxes and other emissive / unlit panels. form.outlineEmissive in toon.json;
 *  ?form=r18 (or ?form=old) switches it off and restores the round 18 pixels. */
export const signLinesEnabled = (p) => !!(p && p.form && p.form.outlineEmissive) && formEnabled() && new URLSearchParams(location.search).get('form') !== 'r18';
// Coverage mask written by sign materials. Above 1 on purpose: the line test is mask >= 0.95 and an MSAA-resolved edge pixel that is
// part foliage (mask 0) averages to something below 1, so no partly covered pixel can be mistaken for a sign. Alpha is half float.
const SIGN_MASK = 1.5;
/** Round 20: flat colour blocks. form.flat in toon.json pulls the albedo of lit textured materials towards its own low mip (large shapes and
 *  colour blocks stay, fine texture noise goes). Printed signs (TOON_SIGN), unlit, transparent, alpha-cut, shader materials and tree crowns are
 *  left out. ?form=r19 (or r18 / old) installs nothing and restores the round 19 pixels. */
export const flatEnabled = (p) => !!(p && p.form && p.form.flat && p.form.flat.tex > 0) && formEnabled() && !['r18', 'r19'].includes(new URLSearchParams(location.search).get('form'));
export const toonFlatUniforms = { uTfTex: { value: 0 }, uTfBias: { value: 0 }, uTfThr: { value: new THREE.Vector2(0, 0) }, uTfSh: { value: 1 }, uTfCut: { value: new THREE.Vector2(0, 0.5) } };
let flatActive = false;
const LIT_FLAT = /^(MeshStandardMaterial|MeshPhysicalMaterial|MeshPhongMaterial|MeshLambertMaterial|MeshToonMaterial)$/;
const flatEligible = (m) => flatActive && LIT_FLAT.test(m.type) && !!m.map && !m.transparent && !(m.alphaTest > 0) && !m.alphaToCoverage && !m.userData?.wbNoFlat && !NOLINE_NAMES.test(m.name);
export const toonEnabled = () => new URLSearchParams(location.search).get('toon') !== 'off';

const f = (x) => Number(x).toFixed(4);
const vec3 = (v) => `vec3( ${v.map(f).join(', ')} )`;

/** Must run before any material is created (the setter below sees their own onBeforeCompile hooks). Hands the two shared
 *  uniforms to every program that compiles with the lit chunk, and lets fine foliage skip the outline.
 *  The wrapper keeps toString() of the original so three's default program cache keys stay distinct. */
const NOLINE_NAMES = /^(sakura:(blob|cards)|station-lawn-blades|vegetation(?:-.*)?)$/;
export function installToonHook() {
  const proto = THREE.Material.prototype;
  if (Object.getOwnPropertyDescriptor(proto, 'onBeforeCompile').get) return;
  const base = proto.onBeforeCompile;
  const hooks = new WeakMap();
  const originals = new WeakMap();
  function wrap(owner, hook) {
    const original = originals.get(hook) || hook;
    const existing = hooks.get(owner);
    if (existing && originals.get(existing) === original) return existing;
    function onBeforeCompile(shader, renderer) {
      // Foliage saves the previous hook and calls it as a plain function.
      const material = this || owner;
      Object.assign(shader.uniforms, toonLitUniforms);
      if (flatActive) Object.assign(shader.uniforms, toonFlatUniforms);
      const result = original.call(material, shader, renderer);
      if (flatEligible(material) && shader.fragmentShader && !shader.fragmentShader.includes('TOON_FLAT')) {
        shader.fragmentShader = `#define TOON_FLAT\n${shader.fragmentShader}`;
      }
      if (NOLINE_NAMES.test(material.name) && !material.defines?.TOON_TREE_CROWN
          && shader.fragmentShader && !shader.fragmentShader.includes('TOON_NOLINE')) {
        shader.fragmentShader = `#define TOON_NOLINE\n${shader.fragmentShader}`;
      }
      return result;
    }
    // The station batcher saves the hook and compares it by identity. Clones can also assign an already wrapped hook.
    onBeforeCompile.toString = () => original.toString();
    hooks.set(owner, onBeforeCompile);
    originals.set(onBeforeCompile, original);
    return onBeforeCompile;
  }
  Object.defineProperty(proto, 'onBeforeCompile', {
    configurable: true,
    get() { return hooks.get(this) || wrap(this, base); },
    set(hook) { wrap(this, hook || base); },
  });
}

/** Must run before the first program that uses these chunks is compiled. */
export function installLitToon(p, boxes) {
  const signs = signLinesEnabled(p);
  const pars = THREE.ShaderChunk.lights_pars_begin;
  if (!pars.includes('uTbK')) THREE.ShaderChunk.lights_pars_begin = `${pars}\nuniform float uTbK;\nuniform float uTbRim;`;
  const end = THREE.ShaderChunk.lights_fragment_end;
  if (!end.includes('wbToonBands')) {
    const [e1, e2] = p.lit.edges, w = p.lit.width, [l0, l1, l2] = p.lit.levels;
    const [rimLo, rimHi] = p.rim.sun ?? [e2 - w, e2 + w];
    // Shadow tint has already classified the same shop boxes when enabled.
    const room = end.includes('wbShadowTint') ? '' : indoorGlsl(boxes);
    THREE.ShaderChunk.lights_fragment_end = `${end}
#if defined( RE_IndirectDiffuse ) && NUM_DIR_LIGHTS > 0
${room}
if ( stIn < 0.5 && ( uTbK > 0.0 || uTbRim > 0.0 ) ) { // wbToonBands
  float tbLum = max( dot( diffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) ), 0.02 );
  float tbFull = dot( directionalLights[ 0 ].color, vec3( 0.2126, 0.7152, 0.0722 ) ) * RECIPROCAL_PI;
  float tbU = dot( reflectedLight.directDiffuse, vec3( 0.2126, 0.7152, 0.0722 ) ) / ( tbLum * max( tbFull, 1e-3 ) );
  float tbQ = ${f(l0)} + ( ${f(l1 - l0)} ) * smoothstep( ${f(e1 - w)}, ${f(e1 + w)}, tbU ) + ( ${f(l2 - l1)} ) * smoothstep( ${f(e2 - w)}, ${f(e2 + w)}, tbU );
  float tbK = ${f(p.lit.strength)} * uTbK;
  reflectedLight.directDiffuse *= mix( 1.0, tbQ / max( tbU, 0.02 ), tbK );
  // thin warm rim on the sunward side (outdoors only)
  float tbRim = pow( 1.0 - saturate( dot( normal, geometryViewDir ) ), ${f(p.rim.power)} ) * saturate( dot( normal, directionalLights[ 0 ].direction ) * 1.5 ) * smoothstep( ${f(rimLo)}, ${f(rimHi)}, tbU );
  reflectedLight.directDiffuse += diffuseColor.rgb * ${vec3(p.rim.color)} * ( tbRim * ${f(p.rim.strength)} * uTbRim );
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
#ifdef TOON_NOLINE
  tmM = 0.0;
#endif
#endif
${signs ? `#if defined( TOON_SIGN ) && ! defined( TOON_NOLINE )
  tmM = ${f(SIGN_MASK)};
#endif
` : ''}  gl_FragColor.a = tmM;
#ifdef TOON_TREE_CROWN
  // The post pass keeps the silhouette and fades contact shading on painted crowns.
  gl_FragColor.a = mix( tmM, 2.5, vStationCrown * uTbK );
#endif
}
#endif`;
  }
}

/** Round 20: must run before the first program that uses map_fragment is compiled. Values are runtime uniforms (strength, mip bias). */
export function installFlatColour(p) {
  if (!flatEnabled(p) || flatActive) return;
  flatActive = true;
  toonFlatUniforms.uTfTex.value = p.form.flat.tex;
  toonFlatUniforms.uTfBias.value = p.form.flat.bias;
  toonFlatUniforms.uTfThr.value.set(...p.form.flat.keep);
  toonFlatUniforms.uTfSh.value = p.form.flat.shadowNoise;
  toonFlatUniforms.uTfCut.value.set(p.form.flat.shadowCut ?? 0, p.form.flat.shadowCutAt ?? 0.5);
  const pars = THREE.ShaderChunk.map_pars_fragment;
  if (!pars.includes('uTfTex')) THREE.ShaderChunk.map_pars_fragment = `${pars}\nuniform float uTfTex;\nuniform float uTfBias;\nuniform vec2 uTfThr;`;
  // The sun's PCF takes 5 taps rotated per pixel by interleaved gradient noise: harmless when smooth, but the cel bands cut that
  // dither at a threshold and every shadow edge becomes a speckled strip. uTfSh = share of the noise kept (0: five fixed taps).
  const sm = THREE.ShaderChunk.shadowmap_pars_fragment, noise = 'interleavedGradientNoise( gl_FragCoord.xy ) * PI2';
  if (!sm.includes('uTfSh')) {
    if (!sm.includes(noise)) throw new Error('Pinned three shadowmap_pars_fragment changed');
    // Round 20b: uTfCut.x = width in pixels of the edge (0: the filtered value as it is), uTfCut.y = filtered value where it flips (a sub-texel bar casts a value well above 0.5, so a higher flip keeps it). The filtered shadow is cut with a smoothstep
    // whose half width follows fwidth() of the value itself (never narrower than a small floor), so a shadow edge is one clean step
    // about uTfCut pixels wide instead of the wide gradient the bilinear PCF leaves when a texel covers many pixels.
    const ret = 'return mix( 1.0, shadow, shadowIntensity );';
    if (!sm.includes(ret)) throw new Error('Pinned three shadowmap_pars_fragment changed (return)');
    const cut = `if ( uTfCut.x > 0.0 ) {
				float tfW = max( fwidth( shadow ) * 0.5 * uTfCut.x, 0.02 );
				shadow = smoothstep( uTfCut.y - tfW, uTfCut.y + tfW, shadow );
			}
			${ret}`;
    THREE.ShaderChunk.shadowmap_pars_fragment = `uniform float uTfSh;\nuniform vec2 uTfCut;\n${sm.replace(noise, `${noise} * uTfSh`).replace(ret, cut)}`;
  }
  const frag = THREE.ShaderChunk.map_fragment;
  if (!frag.includes('wbFlatTex')) {
    if (!frag.includes('diffuseColor *= sampledDiffuseColor;')) throw new Error('Pinned three map_fragment changed');
    THREE.ShaderChunk.map_fragment = frag.replace('diffuseColor *= sampledDiffuseColor;', `#if defined( TOON_FLAT ) && ! defined( TOON_SIGN ) && ! defined( DECODE_VIDEO_TEXTURE )
	{ // wbFlatTex
		vec3 tfLow = texture2D( map, vMapUv, uTfBias ).rgb;
		// detail that stands out clearly from its own low mip (print, lettering, a bold pattern) is kept; small deviations are texture noise
		float tfKeep = smoothstep( uTfThr.x, uTfThr.y, length( sampledDiffuseColor.rgb - tfLow ) );
		sampledDiffuseColor.rgb = mix( mix( sampledDiffuseColor.rgb, tfLow, uTfTex ), sampledDiffuseColor.rgb, tfKeep );
	}
#endif
	diffuseColor *= sampledDiffuseColor;`);
  }
}

/** Post-pass uniforms for look.js. */
/** Round 17: merges p.form (line / lit overrides) into the round 28 parameters; ?form=old returns p unchanged. */
export function applyForm(p) {
  if (!p.form || !formEnabled()) return p;
  return { ...p, line: { ...p.line, ...p.form.line }, lit: { ...p.lit, ...p.form.lit } };
}

export function toonLineUniforms(p) {
  const l = p.line, k = p.form && formEnabled() ? p.form.ink : null, v4 = (a, b) => new THREE.Vector4(...a, ...b);
  return {
    uLnOn: { value: 1 }, uLn: { value: new THREE.Vector4(l.width, l.strength, l.fade[0], l.fade[1]) },
    uLnS: { value: v4(l.sil, l.crease) }, uLnC: { value: l.creaseWeight }, uLnCol: { value: new THREE.Vector3(...l.tint) },
    uLnF: { value: k ? new THREE.Vector4(1, k.darken, k.sat, k.thinWidth) : new THREE.Vector4(0, 0, 0, 0.35) },
    uLnFl: { value: new THREE.Vector3(...(k ? k.floor : [0, 0, 0])) },
    // round 19: sign outline on / emissive ink level / depth step in metres that starts and completes a line on a sign
    uLnE: { value: signLinesEnabled(p) ? new THREE.Vector4(1, p.form.emissiveInk ?? 0.25, ...(p.form.emissiveStep ?? [0.03, 0.08])) : new THREE.Vector4() },
  };
}

/** Transparent panes that write no depth (shop windows, car glass): keep their colour blend, but write coverage mask 0
 *  into the alpha channel where they are drawn, so no outline shows through them. Run before the first frame. */
export function maskGlassAlpha(root) {
  const seen = new Set();
  root.traverse((o) => {
    for (const m of [].concat(o.material || [])) {
      if (seen.has(m)) continue;
      seen.add(m);
      if (!m.transparent || m.depthWrite !== false || m.alphaToCoverage || m.blending !== THREE.NormalBlending) continue;
      if (!m.isShaderMaterial || !/glass|window/i.test(m.name + (o.name || ''))) continue;
      m.blending = THREE.CustomBlending; m.blendEquation = THREE.AddEquation;
      m.blendSrc = THREE.SrcAlphaFactor; m.blendDst = THREE.OneMinusSrcAlphaFactor;
      m.blendSrcAlpha = THREE.ZeroFactor; m.blendDstAlpha = THREE.ZeroFactor;
      (maskGlassAlpha.found ||= []).push(m.name || o.name);
    }
  });
}

/** Round 19: gives the outline mask to opaque emissive / unlit panels (the coverage mask used to be 0 on them, so signs had no
 *  line). Marks materials with a TOON_SIGN define (part of three's program key, so lit and marked programs never mix).
 *  Eligible: opaque MeshBasic with a map (printed cards, fascia prints), opaque lit materials whose emissive is mapped
 *  (light-box prints), and anything with userData.wbSign. Left out: untextured unlit bodies (lamps, train lights), alpha cut-outs,
 *  transparent / additive layers (glass, door-glow, shop-spill, halos: not OPAQUE, so the chunk never writes them), shader
 *  materials (water, sky, grass), userData.wbNoSignLine, and materials whose every mesh is on the no-outline layer.
 *  Run once after the scene is built, before the first frame. Returns the marked materials for the evidence log. */
export function markSignMaterials(root) {
  const info = new Map();
  root.traverse((o) => {
    if (!o.isMesh) return;
    for (const m of [].concat(o.material || [])) {
      let r = info.get(m);
      if (!r) info.set(m, (r = { meshes: 0, outline: 0, instances: 0, names: new Set() }));
      r.meshes++; r.instances += o.isInstancedMesh ? o.count : 1;
      if (o.layers.test({ mask: 1 << 0 })) r.outline++;
      if (r.names.size < 4) r.names.add(o.name || o.parent?.name || '-');
    }
  });
  const marked = [];
  for (const [m, r] of info) {
    if (!m || m.isShaderMaterial || m.transparent || m.alphaTest > 0 || m.alphaToCoverage || m.depthWrite === false || m.blending !== THREE.NormalBlending) continue;
    if (m.userData.wbNoSignLine || m.defines?.TOON_SIGN !== undefined) continue;
    const emissive = m.emissive ? Math.max(m.emissive.r, m.emissive.g, m.emissive.b) * (m.emissiveIntensity ?? 1) : 0;
    const printed = (m.isMeshBasicMaterial && !!m.map) || (!m.isMeshBasicMaterial && !!m.emissive && !!(m.emissiveMap || m.map) && emissive > 0.12);
    if (!printed && !m.userData.wbSign) continue;
    if (r.outline === 0) continue; // every user sits on the no-outline layer
    m.defines = { ...(m.defines || {}), TOON_SIGN: 1 };
    m.needsUpdate = true;
    marked.push({ name: m.name || '-', type: m.type, map: !!m.map, emissive: +emissive.toFixed(2), meshes: r.meshes, instances: r.instances, parents: [...r.names] });
  }
  return marked;
}
