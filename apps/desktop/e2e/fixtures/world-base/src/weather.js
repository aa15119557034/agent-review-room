import * as THREE from 'three';
import { ENV, U } from '../upstream/petalwake/src/core/ctx.js';
import { SEA_STATE } from '../upstream/petalwake/src/world/water.js';

// A sea front brings low stratus under the evening cumulus, then clears inland.
// Use scene seconds so loading, frame rate and switching cameras do not reset the front.
export function createWeather(timeOfDay) {
  const palette = ENV[timeOfDay];
  const overcast = {
    sunColor: [0.94, 0.91, 0.95], zenith: [0.10, 0.15, 0.25], mid: [0.25, 0.34, 0.46],
    horizon: [0.53, 0.57, 0.64], halo: [0.25, 0.22, 0.25],
    ambSky: [0.34, 0.40, 0.52], ambGround: [0.19, 0.20, 0.18],
  };
  const fields = { sunColor: U.uSunColor, zenith: U.uSkyZenith, mid: U.uSkyMid, horizon: U.uSkyHorizon,
    halo: U.uSunHalo, ambSky: U.uAmbSky, ambGround: U.uAmbGround };
  const colors = Object.entries(fields).map(([key, uniform]) => [
    uniform.value, new THREE.Vector3(...palette[key]), new THREE.Vector3(...overcast[key]),
  ]);
  const state = { seconds: 0, cover: 0, wind: 1, sea: 0.62, surge: 0 };
  function update(seconds) {
    const angle = seconds * 2 * Math.PI / 100;
    const wave = 0.5 - 0.5 * Math.cos(angle);
    const cover = THREE.MathUtils.smoothstep(wave, 0.03, 0.95);
    // Integral of a wind which strengthens as the front arrives (metres).
    const travel = 6 * seconds - 2 * Math.sin(angle) * 100 / (2 * Math.PI);
    U.uCloudFlow.value.set(U.uWind.value.x * travel, U.uWind.value.y * travel, cover, seconds * 0.00065);
    for (const [value, clear, grey] of colors) value.lerpVectors(clear, grey, cover);
    U.uFog.value.x = palette.fog[0] + cover * 0.00110;
    U.uWind.value.z = 1 + 0.65 * wave;
    SEA_STATE.value = 0.62 + 0.53 * wave;
    U.uSeaSetup.value = 0.19 * cover;
    Object.assign(state, { seconds, cover, wind: U.uWind.value.z, sea: SEA_STATE.value, surge: U.uSeaSetup.value });
  }
  update(0);
  return { state, update };
}
