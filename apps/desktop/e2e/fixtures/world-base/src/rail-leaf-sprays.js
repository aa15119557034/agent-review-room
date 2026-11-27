import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { terrainH } from '../upstream/sakuragaoka/src/world/environment/common.js';

// Small shoots on the two R4 shrub crowns. Each base sits 3 cm within the shrub at its authored height.
// The turn opens some faces toward the sidewalk while preserving gaps and a rounded outer profile.
const placements = {
  'spray-spreading': [
    [54.48, -52.74, 0.684, -0.78, -0.58, 0.78],
    [54.91, -52.88, 0.518, 0.36, -0.45, 0.78],
    [49.36, -52.75, 0.510, -0.91, -0.42, 0.79],
    [49.80, -52.90, 0.433, 0.33, -0.51, 0.79],
  ],
  'spray-rising': [
    [54.63, -52.69, 0.727, -0.21, -0.52, 0.74],
    [54.13, -52.73, 0.425, -0.97, -0.54, 0.67],
    [49.54, -52.74, 0.595, -0.11, -0.51, 0.76],
  ],
  'spray-tipped': [
    [54.36, -52.62, 0.608, -0.61, -0.57, 0.75],
    [54.76, -52.67, 0.702, 2.48, 0.42, 0.78],
    [49.37, -52.65, 0.551, -0.53, -0.46, 0.73],
    [49.99, -52.61, 0.556, 2.30, 0.44, 0.75],
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
    for (const [index, [x, z, height, yaw, tilt, size]] of poses.entries()) {
      position.set(x, terrainH(x, z) + height, z);
      rotation.setFromEuler(euler.set(tilt, yaw, 0, 'YXZ'));
      transform.compose(position, rotation, scale.setScalar(size));
      mesh.setMatrixAt(index, transform);
    }
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.computeBoundingSphere();
    ctx.addStatic(mesh);
  }
}
