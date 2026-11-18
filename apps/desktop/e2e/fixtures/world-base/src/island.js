import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { U, World, ENV, applyEnv } from '../upstream/petalwake/src/core/ctx.js';
import { Terrain, makeNoiseTexture } from '../upstream/petalwake/src/world/terrain.js';
import { Sky } from '../upstream/petalwake/src/world/sky.js';
import { CloudBaker } from '../upstream/petalwake/src/world/clouds.js';
import { Water } from '../upstream/petalwake/src/world/water.js';
import { River } from '../upstream/petalwake/src/world/river.js';
import { Meadow } from '../upstream/petalwake/src/world/meadow.js';
import { Town } from '../upstream/petalwake/src/world/town.js';
import { Props } from '../upstream/petalwake/src/world/props.js';
import { createPropCellCulling } from './island-prop-cells.js';
import { heightAt as stationHeight } from '../upstream/sakuragaoka/src/world/layout.js';
import { createGroundTransition } from './transition.js';

export const stationPlacement = Object.freeze({
  x: 280, y: 8, z: 900, position: Object.freeze([280, 8, 900]), rotationY: 0,
  width: 184, depth: 225,
  bounds: Object.freeze({ minX: -92, maxX: 92, minZ: -97, maxZ: 128 }),
});

const stationRect = { minX: 188, maxX: 372, minZ: 803, maxZ: 1028 };
const blend = 32;
const inRect = (x, z, margin = 0) => x >= stationRect.minX - margin && x <= stationRect.maxX + margin
  && z >= stationRect.minZ - margin && z <= stationRect.maxZ + margin;

async function json(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}

function clearStationVegetation(terrain) {
  const S = terrain.splatN, cell = World.size / S;
  const fadeWidth = 12;
  const reach = cell + fadeWidth;
  for (let iz = 0; iz < S; iz++) {
    const z = (iz + 0.5) * cell - World.half;
    if (z < stationRect.minZ - reach || z > stationRect.maxZ + reach) continue;
    for (let ix = 0; ix < S; ix++) {
      const x = (ix + 0.5) * cell - World.half;
      if (!inRect(x, z, reach)) continue;
      const dx = Math.max(stationRect.minX - x, 0, x - stationRect.maxX);
      const dz = Math.max(stationRect.minZ - z, 0, z - stationRect.maxZ);
      // A zero texel guard keeps bilinear grass/flower samples zero throughout
      // the core, including corners. Outside it, retain the original field's
      // species and wetness while its cover returns gradually over 12 metres.
      const t = THREE.MathUtils.clamp((Math.hypot(dx, dz) - cell) / fadeWidth, 0, 1);
      const cover = t * t * (3 - 2 * t);
      const index = (iz * S + ix) * 4;
      terrain.splat[index] = Math.round(terrain.splat[index] * cover);
      terrain.splat[index + 3] = Math.round(terrain.splat[index + 3] * cover);
    }
  }
  // The original bitmap and CPU pixels are separate; replace the GPU texture as well.
  const texture = new THREE.DataTexture(terrain.splat, S, S, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 8;
  texture.needsUpdate = true;
  terrain.splatTex.dispose();
  terrain.splatTex = texture;
  U.uSplatTex.value = texture;
}

/** Clear only background lots/approaches before Meadow creates its first cells. */
export function clearVegetationAreas(terrain, areas, localToWorld, feather = null) {
  const S = terrain.splatN, cell = World.size / S, changed = new Set();
  const point = new THREE.Vector3();
  for (const area of areas) {
    const bounds = new THREE.Box3();
    for (const x of [area.minX, area.maxX]) for (const z of [area.minZ, area.maxZ]) {
      bounds.expandByPoint(point.set(x, 0, z).applyMatrix4(localToWorld));
    }
    // Include both bilinear contributors at the edge; this is a texel-support
    // guard, not an extra geometric margin around the supplied rectangles.
    const ix0 = Math.max(0, Math.floor((bounds.min.x + World.half) / cell - 0.5));
    const ix1 = Math.min(S - 1, Math.ceil((bounds.max.x + World.half) / cell - 0.5));
    const iz0 = Math.max(0, Math.floor((bounds.min.z + World.half) / cell - 0.5));
    const iz1 = Math.min(S - 1, Math.ceil((bounds.max.z + World.half) / cell - 0.5));
    for (let iz = iz0; iz <= iz1; iz++) for (let ix = ix0; ix <= ix1; ix++) {
      const index = (iz * S + ix) * 4;
      if (terrain.splat[index] || terrain.splat[index + 3]) changed.add(index);
      terrain.splat[index] = terrain.splat[index + 3] = 0;
    }
  }
  const featherStats = feather ? featherVegetation(terrain, areas, localToWorld, feather, changed) : null;
  // clearStationVegetation made this DataTexture share the CPU array. Updating
  // it in place preserves all existing shader references and texture ownership.
  terrain.splatTex.needsUpdate = true;
  return { areas, changedTexels: changed.size, texelSizeM: cell, feather: featherStats, channels: 'R flowers / A grass; G species and B wetness retained' };
}

// Feather flowers outside the protected footprint. The hard clear already includes
// all bilinear support texels; attenuating grass again can erase another whole 3m
// row even with a sub-metre ramp. Preserve A so lawn can recover at the hard edge.
function featherVegetation(terrain, areas, localToWorld, { flowers = 8, jitter = 2.5 }, cleared) {
  const S = terrain.splatN, cell = World.size / S, inverse = localToWorld.clone().invert();
  const reach = cell + flowers + jitter;
  const world = new THREE.Box3(), point = new THREE.Vector3();
  for (const area of areas) for (const x of [area.minX - reach, area.maxX + reach]) for (const z of [area.minZ - reach, area.maxZ + reach])
    world.expandByPoint(point.set(x, 0, z).applyMatrix4(localToWorld));
  const ix0 = Math.max(0, Math.floor((world.min.x + World.half) / cell)), ix1 = Math.min(S - 1, Math.ceil((world.max.x + World.half) / cell));
  const iz0 = Math.max(0, Math.floor((world.min.z + World.half) / cell)), iz1 = Math.min(S - 1, Math.ceil((world.max.z + World.half) / cell));
  const hash = (x, z) => { const h = Math.sin(x * 127.1 + z * 311.7) * 43758.5453; return h - Math.floor(h); };
  const smooth = t => { t = THREE.MathUtils.clamp(t, 0, 1); return t * t * (3 - 2 * t); };
  // Value noise at ~6 m so the edge wanders in lobes instead of per-texel speckle.
  const noise = (x, z) => {
    const fx = x / 6, fz = z / 6, x0 = Math.floor(fx), z0 = Math.floor(fz), tx = smooth(fx - x0), tz = smooth(fz - z0);
    const a = hash(x0, z0), b = hash(x0 + 1, z0), c = hash(x0, z0 + 1), d = hash(x0 + 1, z0 + 1);
    return (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz;
  };
  let touched = 0;
  for (let iz = iz0; iz <= iz1; iz++) for (let ix = ix0; ix <= ix1; ix++) {
    const index = (iz * S + ix) * 4;
    if (cleared.has(index) || !terrain.splat[index]) continue;
    point.set((ix + 0.5) * cell - World.half, 0, (iz + 0.5) * cell - World.half);
    const wx = point.x, wz = point.z; point.applyMatrix4(inverse);
    let d = Infinity;
    for (const a of areas) d = Math.min(d, Math.hypot(Math.max(a.minX - point.x, 0, point.x - a.maxX), Math.max(a.minZ - point.z, 0, point.z - a.maxZ)));
    // Distance beyond the bilinear guard texel, shifted by the wandering noise.
    const e = d - cell + (noise(wx, wz) - 0.5) * 2 * jitter;
    const kR = smooth(e / flowers);
    if (kR >= 1) continue;
    const next = Math.round(terrain.splat[index] * kR);
    if (next === terrain.splat[index]) continue;
    terrain.splat[index] = next;
    touched++;
  }
  return { flowerFadeM: flowers, jitterM: jitter, texels: touched };
}

async function loadProps(assetBase, terrain) {
  const placements = await json(`${assetBase}/terrain/props.json`);
  const loader = new GLTFLoader();
  let removed = 0, reseated = 0;
  const loaded = await Promise.all(Object.entries(placements).map(async ([name, placements]) => {
    const [gltf, info] = await Promise.all([
      loader.loadAsync(`${assetBase}/models/${name}.glb`), json(`${assetBase}/models/${name}.json`),
    ]);
    const list = placements.filter(([x, , z, , scale]) => {
      const remove = inRect(x, z, info.radius * scale);
      if (remove) removed++;
      return !remove;
    }).map((placement) => {
      const [x, , z] = placement;
      if (!inRect(x, z, blend)) return placement;
      reseated++;
      return [x, terrain.heightAt(x, z), ...placement.slice(2)];
    });
    return { name, gltf, info, list };
  }));
  return { props: new Props(loaded), removed, reseated };
}

/** Adopt the native island into the caller's renderer and scene, without starting the game. */
export async function createIsland({ scene, renderer, camera, assetBase = '/assets', timeOfDay = 'evening' }) {
  // Evening (#254 C19) moves the sun, sky palette and the terrain's baked sun
  // shadow together; 'afternoon' keeps Petalwake's original bake for comparison.
  if (timeOfDay !== 'evening' && timeOfDay !== 'afternoon') throw new Error('Unknown time of day: ' + timeOfDay);
  const evening = timeOfDay === 'evening' ? await json(new URL('./evening.json', import.meta.url)) : null;
  if (evening) ENV.evening = evening.env;
  applyEnv(timeOfDay);
  U.uTime.value = 0;
  U.uShadowOn.value = 0;
  U.uRider.value.set(1e6, 1e6, 1e6, 0);
  U.uRiderVel.value.set(0, 0, 0);
  const noise = makeNoiseTexture();
  U.uNoiseTex.value = noise.texture;
  const blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
  blank.needsUpdate = true;
  for (const name of ['uWakeTex', 'uStripTex', 'uShadowTex', 'uTownSh0', 'uTownSh1', 'uTownMask0', 'uTownMask1']) U[name].value = blank;

  // Town.load intentionally tolerates absent assets upstream. This fixture requires a real port.
  const index = await json(`${assetBase}/town/index.json`);
  if (!index.towns.some((town) => town.id === 'larkhaven')) throw new Error('Petalwake assets contain no Larkhaven harbour.');
  await json(`${assetBase}/town/masks.json`);
  const [terrain, town] = await Promise.all([Terrain.load(renderer, assetBase), Town.load(renderer, assetBase)]);
  if (!town.towns.some((entry) => entry.id === 'larkhaven')) throw new Error('Larkhaven geometry failed to load.');
  if (evening) {
    // Terrain's constructor installed meta.sun and the afternoon light map; swap both
    // before anything else (clouds, water, props, station lights) reads them.
    const url = `${assetBase}/${evening.lightMap}`;
    const image = new Image();
    image.src = url;
    try { await image.decode(); } catch {
      throw new Error(`${url} is missing: run scripts/bake-evening-light.py once (local Petalwake checkout).`);
    }
    if (image.naturalWidth !== terrain.lightTex.image.width) throw new Error('Evening light map size differs from light.png');
    terrain.lightTex.image = image;
    terrain.lightTex.needsUpdate = true;
    const elev = THREE.MathUtils.degToRad(evening.sunElevDeg), az = THREE.MathUtils.degToRad(evening.sunAzDeg);
    U.uSunDir.value.set(Math.sin(az) * Math.cos(elev), Math.sin(elev), Math.cos(az) * Math.cos(elev)).normalize();
  }
  const surface = (x, z) => {
    const localX = THREE.MathUtils.clamp(x - stationPlacement.x, stationPlacement.bounds.minX, stationPlacement.bounds.maxX);
    const localZ = THREE.MathUtils.clamp(z - stationPlacement.z, stationPlacement.bounds.minZ, stationPlacement.bounds.maxZ);
    return stationPlacement.y + stationHeight(localX, localZ) - 0.08;
  };
  const flatten = terrain.flattenRect({ ...stationRect, height: stationPlacement.y, blend, surface });
  // The station owns core colour and depth. Fitting a coarser island heightfield alone
  // cannot reproduce its narrow railway cut and levee without terrain poking through.
  terrain.material.uniforms.uStationCutout.value.set(stationRect.minX, stationRect.minZ, stationRect.maxX, stationRect.maxZ);
  const transition = createGroundTransition({ rect: stationRect,
    terrainMaterial: terrain.material,
    stationHeight: (x, z) => stationPlacement.y + stationHeight(x - stationPlacement.x, z - stationPlacement.z),
    islandHeight: (x, z) => terrain.heightAt(x, z),
  });
  clearStationVegetation(terrain);

  const root = new THREE.Group();
  root.name = 'petalwake-island';
  scene.add(root);
  terrain.mainView.mesh.renderOrder = 500;
  const meadow = new Meadow(terrain, 'medium');
  const sky = new Sky();
  const clouds = new CloudBaker(renderer);
  clouds.begin();
  while (!clouds.done) {
    clouds.step(2);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  sky.cloudTex.value = clouds.texture;
  sky.cloudOn.value = 1;
  const water = new Water(sky);
  const river = new River(terrain, terrain.meta, sky);
  water.material.uniforms.uFallBase.value.set(river.fall.base.x, river.fall.base.z, river.fall.hw * 1.6);
  const { props, removed, reseated } = await loadProps(assetBase, terrain);
  const updatePropCells = createPropCellCulling(props);
  root.add(terrain.mainView.mesh, meadow.group, sky.mesh, water.mesh, river.group, town.group, props.group, transition);
  if (props.overlay) root.add(props.overlay);
  town.bakeShadows();

  const stats = { towns: town.towns.map((entry) => entry.id), townTriangles: town.tris,
    props: props.counts, removedProps: removed, reseatedProps: reseated, flatten,
    transition: { width: 2, spacing: 1, triangles: transition.geometry.index.count / 3 } };
  function update(dt, time) {
    U.uTime.value = time;
    U.uCamPos.value.copy(camera.position);
    camera.updateMatrixWorld();
    updatePropCells(camera);
    terrain.select(terrain.mainView, camera);
    meadow.update(camera);
    town.update(dt, time, camera);
    water.update(camera);
    stats.terrainNodes = terrain.mainView.count;
    stats.meadow = { ...meadow.stats };
  }
  return {
    ready: true, root, terrain, town, props, meadow, water, sky, river, transition, U, stationPlacement, stats, update, timeOfDay,
    heightAt: (x, z) => terrain.heightAt(x, z),
    // Meadow allocates materials lazily as camera cells enter view.
    get materials() {
      const materials = new Set();
      root.traverse((object) => {
        if (object.material) for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material);
      });
      return [...materials];
    },
  };
}
