import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { loadModel, makeBatch } from './scatter-common.js';

const ASSETS = '/station-foliage/';
const SHRUBS = ['cascade-spreading', 'cascade-upright'];
const GRASSES = ['meadow-ribbon-a', 'meadow-ribbon-b'];

// Authored world-space groups on bank pockets and the two shoulders of the upper stream.
// Entries are model, x, z, yaw, lateral scale, and height scale.
const POCKETS = [
  ['inner-bank', null, [
    [0, -204.90, -494.55, 0.6, 2.13, 1.92], [1, -203.74, -493.95, -1.4, 1.58, 1.52],
    [2, -205.43, -495.64, -0.4, 2.24, 1.77], [3, -204.34, -495.22, 2.1, 2.18, 1.57],
    [2, -203.84, -495.29, 1.1, 1.86, 1.45],
  ]],
  ['cliff-foot', null, [
    [0, -214.01, -484.18, -0.8, 2.17, 1.86], [1, -215.16, -484.36, 2.6, 1.52, 1.46],
    [3, -213.35, -485.28, 0.7, 1.85, 1.54], [2, -214.45, -485.02, -2.2, 1.83, 1.45],
  ]],
  ['outer-bank', null, [
    [0, -199.55, -500.11, 1.6, 2.32, 2.15], [1, -198.49, -500.87, -0.1, 1.61, 1.73],
    [2, -198.08, -500.33, 0.4, 2.36, 1.80], [3, -199.42, -501.27, -1.5, 2.25, 1.86],
    [3, -200.63, -500.91, 1.4, 1.82, 1.57],
  ]],
  ['west-lip', null, [
    [0, -204.50, -470.00, 1.1, 2.28, 2.09], [1, -206.80, -472.30, -1.3, 2.03, 2.25],
    [0, -208.35, -472.15, 0.2, 1.46, 1.67], [2, -205.74, -471.00, 0.5, 2.55, 1.84],
    [3, -204.25, -468.65, 1.9, 2.20, 1.68],
  ]],
  ['east-lip', null, [
    [1, -189.50, -480.50, -1.5, 1.90, 2.00], [0, -187.00, -480.10, 0.9, 2.15, 1.83],
    [1, -186.15, -480.62, 2.2, 1.18, 1.29], [3, -188.30, -481.20, -0.3, 2.25, 1.71],
    [2, -189.80, -481.60, 1.4, 1.68, 1.61],
  ]],
  ['rock-pocket', 'cascade-terrace', [
    [0, -223.65, -485.38, 0.0, 1.78, 1.67], [3, -223.00, -485.54, -1.2, 1.51, 1.51],
    [2, -224.37, -485.13, 0.6, 1.52, 1.47],
  ]],
  ['upper-ledge', 'cascade-high-ledge', [
    [0, -195.15, -490.57, -0.5, 2.85, 2.29], [1, -195.18, -489.34, 1.4, 2.16, 2.05],
    [1, -194.61, -491.52, 0.4, 1.75, 1.60], [3, -195.82, -490.81, 0.6, 1.83, 1.57],
    [2, -195.04, -491.60, -2.3, 2.16, 1.42],
  ]],
];

async function loadShrubs() {
  const { scene } = await new GLTFLoader().loadAsync(`${ASSETS}cascade-shrubs.glb`);
  return SHRUBS.map(name => {
    const mesh = scene.getObjectByName(name);
    if (!mesh?.isMesh || !mesh.geometry.index || !mesh.geometry.hasAttribute('color') || !mesh.geometry.hasAttribute('normal')) {
      throw new Error(`Cascade foliage: missing indexed painted geometry ${name}`);
    }
    // The editable Blender gallery places the variants side by side, so use their local geometry.
    mesh.material.dispose();
    return { id: name, geometry: mesh.geometry };
  });
}

function rootHeight(surface, x, z, radius) {
  const probes = [surface(x, z), surface(x - radius, z), surface(x + radius, z),
    surface(x, z - radius), surface(x, z + radius)];
  const lo = Math.min(...probes), hi = Math.max(...probes);
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo < 0.24 || hi - lo > radius * 1.65) return null;
  // Sink the root slightly into the lowest part of its footprint. The crowns keep their upright form.
  return lo - 0.035;
}

export async function addCascadeFoliage(island, { gradientMap = null, shelves = null } = {}) {
  const [shrubs, ...grasses] = await Promise.all([loadShrubs(), ...GRASSES.map(name =>
    loadModel(`${ASSETS}${name}.glb`, { vertexColors: true, snapGround: true }, name))]);
  const models = [...shrubs, ...grasses];
  const positions = models.map(() => []);
  const group = new THREE.Group();
  group.name = 'cascade-bank-foliage';
  group.userData.noDecal = true;

  const ray = new THREE.Raycaster(new THREE.Vector3(), new THREE.Vector3(0, -1, 0));
  const normalMatrix = new THREE.Matrix3();
  const normal = new THREE.Vector3();
  shelves?.updateWorldMatrix(true, true);
  const placements = [];
  const skipped = [];
  for (const [pocket, shelfName, rows] of POCKETS) {
    const shelf = shelfName ? shelves?.getObjectByName(shelfName) : null;
    const surface = shelfName ? (x, z) => {
      if (!shelf) return NaN;
      ray.ray.origin.set(x, island.river.fall.top.y + 1, z);
      normalMatrix.getNormalMatrix(shelf.matrixWorld);
      const top = ray.intersectObject(shelf, false).find(hit => normal.copy(hit.face.normal).applyNormalMatrix(normalMatrix).y > 0.42);
      return top?.point.y ?? NaN;
    } : island.heightAt;
    rows.forEach(([id, x, z, yaw, sx, sy], i) => {
      // Shelf shrubs can spill over their stone, but all stem-base probes stay on its top face.
      const radius = shelf ? Math.min(0.38, sx * 0.18) : sx * (id < SHRUBS.length ? 0.27 : 0.18);
      const y = rootHeight(surface, x, z, radius);
      const insideStream = island.river.rows.some(r => Math.hypot(r.x - x, r.z - z) < r.hw * 1.12 + radius);
      if (y === null || insideStream) {
        skipped.push({ pocket, model: models[id].id, x, z, reason: insideStream ? 'stream' : 'support' });
        return;
      }
      const pose = { x, y, z, yaw, sx, sy, sz: sx * (i % 2 ? 0.92 : 1), tint: i % 2 ? 0.93 : 1.04 };
      positions[id].push(pose);
      placements.push({ pocket, model: models[id].id, ...pose });
    });
  }

  const material = new THREE.MeshToonMaterial({ vertexColors: true, gradientMap, name: 'vegetation-cascade-bank' });
  let triangles = 0;
  models.forEach((model, i) => {
    const items = positions[i];
    if (!items.length) return;
    const mesh = makeBatch({ name: `foliage-${model.id}`, model, material, items });
    mesh.receiveShadow = true;
    mesh.castShadow = i < SHRUBS.length;
    group.add(mesh);
    triangles += model.geometry.index.count * items.length / 3;
  });
  island.root.add(group);
  return { group, placements, skipped, triangles };
}
