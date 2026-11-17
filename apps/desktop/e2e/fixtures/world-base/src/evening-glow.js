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
