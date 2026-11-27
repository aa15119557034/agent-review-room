import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { terrainH } from '../upstream/sakuragaoka/src/world/environment/common.js';
import { limitInstancedDetailDistance } from './scatter-common.js';

const LEAF_DETAIL_DISTANCE = 60;
// Low sprays follow the measured shoulders of the two R4 shrubs. Their bases sit inside the
// crowns. Each row gives local x, z, height above ground, yaw, pitch, roll, and scale.
const placements = {
  'spray-spreading': [
    [54.31, -52.84, 0.482, 0.58, -0.945, -0.048, 0.74],
    [54.69, -52.91, 0.524, -1.15, -0.545, 0.856, 0.805],
    [54.99, -52.80, 0.612, 1.00, 0.025, -0.592, 0.87],
    [54.59, -52.64, 0.711, 0.56, 0.476, 0.401, 0.74],
    [49.14, -52.77, 0.361, 0.89, -0.466, -0.513, 0.805],
    [49.53, -52.89, 0.463, -1.05, -0.342, 0.755, 0.87],
    [49.92, -52.88, 0.453, 0.57, -0.672, -0.533, 0.74],
  ],
  'spray-rising': [
    [54.48, -52.91, 0.456, 1.03, -0.928, -0.718, 0.74],
    [54.77, -52.77, 0.688, -0.40, -0.374, 0.020, 0.805],
    [55.06, -52.72, 0.623, 1.19, 0.436, -0.173, 0.87],
    [49.31, -52.83, 0.436, 0.59, -0.774, -0.022, 0.74],
    [49.74, -52.92, 0.432, 0.11, -0.896, -0.114, 0.805],
    [50.09, -52.79, 0.503, 1.00, 0.141, -0.523, 0.87],
  ],
  'spray-tipped': [
    [54.56, -52.78, 0.693, -1.24, -0.001, 0.476, 0.74],
    [54.88, -52.91, 0.495, 0.93, -0.658, -0.855, 0.805],
    [54.23, -52.68, 0.509, -0.67, -0.243, 0.101, 0.87],
    [49.61, -52.67, 0.636, -0.78, 0.256, -0.167, 0.74],
    [49.82, -52.73, 0.592, 0.49, 0.027, -0.150, 0.805],
    [49.40, -52.66, 0.583, -0.85, 0.470, -0.047, 0.87],
  ],
};

export async function addRailLeafSprays(ctx) {
  const { scene } = await new GLTFLoader().loadAsync('/station-foliage/rail-leaf-sprays.glb');
  const variants = Object.entries(placements).map(([name, poses]) => {
    const part = scene.getObjectByName(name);
    if (!part?.isMesh || !part.geometry.index || !part.geometry.getAttribute('color') || !part.geometry.getAttribute('normal')) {
      throw new Error(`Rail leaf sprays: missing indexed painted geometry ${name}`);
    }
    // The Blender source displays variants side by side. Their local origins are the twig bases.
    return { name, poses, geometry: part.geometry };
  });
  const importedMaterials = new Set();
  scene.traverse(object => { if (object.isMesh) importedMaterials.add(object.material); });
  for (const material of importedMaterials) material.dispose();
  const material = ctx.mat.toon('#ffffff', { vertexColors: true, paint: 0.025, name: 'foliage-rail-leaf-sprays' });
  const transform = new THREE.Matrix4(), rotation = new THREE.Quaternion(), euler = new THREE.Euler();
  const position = new THREE.Vector3(), scale = new THREE.Vector3();
  for (const { name, poses, geometry } of variants) {
    const mesh = new THREE.InstancedMesh(geometry, material, poses.length);
    mesh.name = `foliage-rail-${name}`;
    for (const [index, [x, z, height, yaw, pitch, roll, size]] of poses.entries()) {
      position.set(x, terrainH(x, z) + height, z);
      rotation.setFromEuler(euler.set(pitch, yaw, roll, 'YXZ'));
      transform.compose(position, rotation, scale.setScalar(size));
      mesh.setMatrixAt(index, transform);
    }
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.computeBoundingSphere();
    limitInstancedDetailDistance(mesh, LEAF_DETAIL_DISTANCE);
    ctx.addStatic(mesh);
  }
}
