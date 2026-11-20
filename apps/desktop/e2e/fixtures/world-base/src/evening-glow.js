import * as THREE from 'three';

// Evening (#254 C19): unlit light sources (street lamps, light-box signs, door lamps,
// train head/tail lights, skyline windows) were authored at display white, so the
// pipeline's bloom knee (luminance 0.85) barely touched them. Push only untextured,
// already-bright MeshBasic colours into HDR so they glow against the dusk sky; textured
// prints keep their colour so lettering stays readable.
export function applyEveningGlow(scene, look, { gain = 2.1, printGain = 1.25, minLuma = 0.5, bloom = 0.2 } = {}) {
  const seen = new Set(), stats = { lamps: 0, prints: 0 };
  scene.traverse((object) => {
    if (!object.isMesh) return;
    for (const material of [].concat(object.material)) {
      if (seen.has(material) || !material.isMeshBasicMaterial || material.userData.wbEveningGlow) continue;
      seen.add(material);
      const luma = material.color.r * 0.2126 + material.color.g * 0.7152 + material.color.b * 0.0722;
      if (luma < minLuma) continue;
      // Saturated signal reds (crossing, train tails) stay as authored: boosted, they bloomed
      // into a red-orange smear in the island aerial (#254 C20).
      const c = material.color, chroma = Math.min(c.r, c.g, c.b) / Math.max(c.r, c.g, c.b, 1e-4);
      if (!material.map && chroma < 0.6) continue;
      if (material.map) {
        if (!/fascia|sign/.test(material.name)) continue;
        material.color.multiplyScalar(printGain); stats.prints++;
      } else {
        material.color.multiplyScalar(gain); stats.lamps++;
      }
      material.userData.wbEveningGlow = true;
    }
  });
  look.pipeline.params.bloom = bloom;
  return stats;
}

// Evening (#254 C20): the low orange sun multiplied into the pink crowns and the upstream
// backlit rim glow pushed sun-facing clumps to orange-red. Shift only those back to pink.
const SAKURA_EVENING = /* glsl */`
  {
    // Linear space: crown pink is about (1, .48, .60), sun-hit orange-red (1, .2, .12).
    // Lift green to a floor and keep blue just above green: pink stays, orange turns pink.
    vec3 c = gl_FragColor.rgb;
    float g = max( c.g, c.r * 0.42 );
    gl_FragColor.rgb = vec3( c.r, g, max( c.b, g * 1.12 ) );
  }
  #include <tonemapping_fragment>`;

export function applyEveningSakura(scene) {
  const seen = new Set();
  scene.traverse((object) => {
    if (!object.isMesh) return;
    for (const material of [].concat(object.material)) {
      if (seen.has(material) || !/^sakura:(blob|cards)$/.test(material.name)) continue;
      seen.add(material);
      const prev = material.onBeforeCompile, prevKey = material.customProgramCacheKey;
      material.onBeforeCompile = (shader, renderer) => {
        prev.call(material, shader, renderer);
        if (!shader.fragmentShader.includes('#include <tonemapping_fragment>')) throw new Error('Sakura shader lacks tonemapping chunk');
        shader.fragmentShader = shader.fragmentShader.replace('#include <tonemapping_fragment>', SAKURA_EVENING);
      };
      material.customProgramCacheKey = () => prevKey.call(material) + '|evening';
      material.needsUpdate = true;
    }
  });
  if (seen.size === 0) throw new Error('No sakura crown materials found for the evening grade');
  return { materials: [...seen].map((m) => m.name) };
}

// Crossing halos (#254 C21): upstream keeps a 7 px minimum sprite so distant lamps sparkle; from
// the island aerial five of them bloomed into one red-orange blob over the station. Keep the
// minimum size (lamps still read as points) but fade a halo by how much it was enlarged, so a
// lamp seen at its true size (the street views) is unchanged.
export function fadeDistantCrossingHalos(scene, { floor = 0.12 } = {}) {
  const sizeNeedle = 's = max(s, minPx);';
  const alphaNeedle = 'float a = (core * 1.2 + halo + streak) * vFace * uOn;';
  const materials = new Set();
  scene.traverse((object) => { if (object.name === 'crossing-halo') materials.add(object.material); });
  if (materials.size === 0) throw new Error('No crossing halos found');
  for (const material of materials) {
    if (!material.vertexShader.includes(sizeNeedle) || !material.fragmentShader.includes(alphaNeedle)) throw new Error('Crossing halo shader changed upstream');
    material.vertexShader = material.vertexShader
      .replace('varying vec2 vUv; varying float vFace;', 'varying vec2 vUv; varying float vFace; varying float vKeep;')
      .replace(sizeNeedle, `vKeep = mix(${floor.toFixed(2)}, 1.0, clamp(s / max(minPx, 1e-4), 0.0, 1.0));\n    ${sizeNeedle}`);
    material.fragmentShader = material.fragmentShader
      .replace('varying vec2 vUv; varying float vFace;', 'varying vec2 vUv; varying float vFace; varying float vKeep;')
      .replace(alphaNeedle, alphaNeedle.replace('* uOn;', '* uOn * vKeep;'));
    material.needsUpdate = true;
  }
  return { materials: materials.size };
}
