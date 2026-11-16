import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { U, World, applyEnv } from '../upstream/petalwake/src/core/ctx.js';
import { Terrain, makeNoiseTexture } from '../upstream/petalwake/src/world/terrain.js';
import { Sky } from '../upstream/petalwake/src/world/sky.js';
import { CloudBaker } from '../upstream/petalwake/src/world/clouds.js';
import { Water } from '../upstream/petalwake/src/world/water.js';
import { River } from '../upstream/petalwake/src/world/river.js';
import { Meadow } from '../upstream/petalwake/src/world/meadow.js';
import { Town } from '../upstream/petalwake/src/world/town.js';
import { Props } from '../upstream/petalwake/src/world/props.js';
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
  for (let iz = 0; iz < S; iz++) {
    const z = (iz + 0.5) * cell - World.half;
    if (z < stationRect.minZ - cell || z > stationRect.maxZ + cell) continue;
    for (let ix = 0; ix < S; ix++) {
      const x = (ix + 0.5) * cell - World.half;
      if (!inRect(x, z, cell)) continue;
      const index = (iz * S + ix) * 4;
      terrain.splat[index] = 0;
      terrain.splat[index + 3] = 0;
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
export async function createIsland({ scene, renderer, camera, assetBase = '/assets' }) {
  applyEnv('afternoon');
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
    terrain.select(terrain.mainView, camera);
    meadow.update(camera);
    town.update(dt, time, camera);
    water.update(camera);
    stats.terrainNodes = terrain.mainView.count;
    stats.meadow = { ...meadow.stats };
  }
  return {
    ready: true, root, terrain, town, props, meadow, water, sky, river, transition, U, stationPlacement, stats, update,
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
