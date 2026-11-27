const TONE_MAP = '#include <tonemapping_fragment>';
const TERRAIN_ATMOSPHERE = 'col = applyAtmosphere(col, P);';

// Muted cool pink at the canopy's existing luminance keeps the folded leaf faces readable.
const SAKURA_NIGHT = /* glsl */`
  float sakuraValue = dot(gl_FragColor.rgb, vec3(0.2126, 0.7152, 0.0722));
  gl_FragColor.rgb = mix(gl_FragColor.rgb, sakuraValue * vec3(1.28, 0.90, 1.10), 0.93);
`;

// Elevated slopes northeast of Sakuragaoka seen above the shops in view A. World-space
// tapers keep the treatment on the same mountain as the camera moves.
const RIDGE_NIGHT = /* glsl */`
vec3 stationNightRidge(vec3 color, vec3 p) {
  float east = smoothstep(315.0, 440.0, p.x) * (1.0 - smoothstep(840.0, 1040.0, p.x));
  float north = smoothstep(-515.0, -325.0, p.z) * (1.0 - smoothstep(395.0, 575.0, p.z));
  float height = smoothstep(52.0, 140.0, p.y);
  return color * mix(vec3(1.0), vec3(0.26, 0.32, 0.46), east * north * height);
}
`;

function patchOutput(material, grade, shared = '') {
  const compile = material.onBeforeCompile, cacheKey = material.customProgramCacheKey;
  material.onBeforeCompile = (shader, renderer) => {
    compile.call(material, shader, renderer);
    if (!shader.fragmentShader.includes(TONE_MAP)) throw new Error(`Night grade: missing output for ${material.name}`);
    shader.fragmentShader = shared + shader.fragmentShader.replace(TONE_MAP, `${grade}\n${TONE_MAP}`);
  };
  material.customProgramCacheKey = () => `${cacheKey.call(material)}|station-night`;
  material.needsUpdate = true;
}

export function applyStationNightArt(scene, island) {
  if (island.timeOfDay !== 'night') return null;
  const terrain = island.terrain.material;
  if (!terrain.fragmentShader.includes(TERRAIN_ATMOSPHERE)) throw new Error('Night ridge grade: missing terrain atmosphere');
  terrain.fragmentShader = RIDGE_NIGHT + terrain.fragmentShader.replace(TERRAIN_ATMOSPHERE,
    `col = stationNightRidge(col, P);\n  ${TERRAIN_ATMOSPHERE}`);
  terrain.needsUpdate = true;

  const sakura = new Set(), conifers = new Set();
  scene.traverse(object => {
    if (!object.isMesh) return;
    for (const material of [].concat(object.material)) {
      if (/^sakura:(blob|cards)$/.test(material.name)) sakura.add(material);
      if (/^vegetation-conifer2?:solid$/.test(material.name)) conifers.add(material);
    }
  });
  if (!sakura.size) throw new Error('No sakura crown materials found for the night grade');
  for (const material of sakura) patchOutput(material, SAKURA_NIGHT);
  for (const material of conifers) {
    patchOutput(material, 'gl_FragColor.rgb = stationNightRidge(gl_FragColor.rgb, vBkPos);', RIDGE_NIGHT);
  }
  return { sakura: [...sakura].map(m => m.name), conifers: [...conifers].map(m => m.name) };
}
