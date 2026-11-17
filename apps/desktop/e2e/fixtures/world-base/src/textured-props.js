import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const BASE = '/prop-assets/';
const CRATE = 'plastic_crate_02/';
const SHUTTER = 'worn_shutter/textures/';

// The station builder has baked colours, but has not yet merged these meshes.
// Match the two original sliding panels by their complete local bounds only.
function shedDoors(root) {
  root.updateWorldMatrix(true, true);
  const specs = [[23.65, 1.025, -28.688], [24.7, 1.025, -28.67]];
  const box = new THREE.Box3(), center = new THREE.Vector3(), size = new THREE.Vector3();
  return specs.map(position => {
    const matches = [];
    root.traverse(mesh => {
      if (!mesh.isMesh || mesh.isInstancedMesh) return;
      box.setFromObject(mesh); box.getCenter(center); box.getSize(size);
      if (center.distanceTo(new THREE.Vector3(...position)) < 1e-5 &&
        size.distanceTo(new THREE.Vector3(1.12, 1.65, .02)) < 1e-5) matches.push(mesh);
    });
    if (matches.length !== 1) throw new Error('Expected one original tool-shed door at ' + position.join(',') + '; found ' + matches.length);
    return matches[0];
  });
}

/** Called with the detached identity station root, after module builds and before batching.
 * Success transfers all loaded geometry/materials/textures to station.dispose(). */
export async function addStationTexturedProps({ ctx, root }) {
  const doors = shedDoors(root), originalDoorMaterials = doors.map(mesh => mesh.material);
  const textures = new Set(), geometries = new Set(), materials = new Set();
  const errors = [];
  const manager = new THREE.LoadingManager();
  let finished;
  const drained = new Promise(resolve => { finished = resolve; });
  manager.onLoad = finished;
  manager.onError = url => errors.push('Asset request failed: ' + url);
  class OwnedTextureLoader extends THREE.TextureLoader {
    load(...args) { const texture = super.load(...args); textures.add(texture); return texture; }
  }
  const textureLoader = new OwnedTextureLoader(manager);
  manager.addHandler(/\.(?:jpg|png)$/i, textureLoader);
  manager.itemStart('station-textured-props');
  const pending = [
    new GLTFLoader(manager).loadAsync(BASE + CRATE + 'plastic_crate_02_1k.gltf'),
    textureLoader.loadAsync(BASE + CRATE + 'textures/plastic_crate_02_opacity_1k.png'),
    ...['diff', 'nor_gl', 'arm'].map(kind => textureLoader.loadAsync(BASE + SHUTTER + 'worn_shutter_' + kind + '_1k.jpg')),
  ];
  manager.itemEnd('station-textured-props');
  const settled = await Promise.allSettled(pending);
  await drained; // A rejected glTF promise can leave sibling image loads running.
  const gltf = settled[0].status === 'fulfilled' ? settled[0].value : null;
  if (gltf) gltf.scene.traverse(mesh => {
    if (!mesh.isMesh) return;
    geometries.add(mesh.geometry);
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      materials.add(material);
      for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
    }
  });
  const placed = new THREE.Group(); placed.name = 'station-textured-service-props';
  let cartonGroup;
  try {
    for (const result of settled) if (result.status === 'rejected') errors.push(String(result.reason));
    if (errors.length) throw new Error('Textured props failed: ' + errors.join('; '));
    const [, mask, diffuse, normal, arm] = settled.map(result => result.value);
    const prototype = gltf.scene;
    prototype.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(prototype), size = box.getSize(new THREE.Vector3());
    if (size.distanceTo(new THREE.Vector3(.5055013895, .2540891618, .4055013955)) > 1e-5) throw new Error('Crate source dimensions changed');
    const sourceMaterials = [...materials];
    let triangles = 0, primitives = 0;
    prototype.traverse(mesh => {
      if (!mesh.isMesh) return;
      if (Array.isArray(mesh.material) || !mesh.material.isMeshStandardMaterial) throw new Error('Unexpected crate material layout');
      const source = mesh.material;
      if (!source.map || !source.normalMap || !source.roughnessMap || source.roughnessMap !== source.metalnessMap) throw new Error('Missing original crate maps');
      mask.flipY = false; mask.colorSpace = THREE.NoColorSpace;
      for (const key of ['wrapS', 'wrapT', 'minFilter', 'magFilter']) mask[key] = source.map[key];
      mask.needsUpdate = true;
      const cutout = source.clone(); cutout.transparent = false; cutout.depthWrite = true;
      cutout.alphaMap = mask; cutout.alphaTest = .5;
      cutout.name = 'plastic-crate-02-official-cutout';
      mesh.material = cutout; mesh.castShadow = true; mesh.receiveShadow = true;
      materials.add(cutout);
      triangles += (mesh.geometry.index?.count ?? mesh.geometry.attributes.position.count) / 3;
      primitives++;
    });
    for (const material of sourceMaterials) { material.dispose(); materials.delete(material); }
    if (triangles !== 5840 || primitives !== 1 || textures.size !== 7) throw new Error('Unexpected fixed prop asset structure');
    for (const texture of [diffuse, normal, arm]) {
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
      texture.repeat.set(1.12 / 1.37, 1.65 / 1.37); // Preview art scale, not a certified building dimension.
      texture.colorSpace = texture === diffuse ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      texture.needsUpdate = true;
    }
    const shutter = new THREE.MeshStandardMaterial({ name: 'tool-shed-worn-shutter', map: diffuse,
      normalMap: normal, aoMap: arm, roughnessMap: arm, metalnessMap: arm, roughness: 1, metalness: 1 });
    materials.add(shutter);
    for (const mesh of doors) mesh.material = shutter;
    const ground = ctx.L.heightAt(26.05, -28.35) + .012;
    placed.position.set(26.05, ground - box.min.y, -28.35); placed.add(prototype);
    // Original model stays outside staticRoot, retaining its PBR/cutout material.
    root.add(placed);
    const C = ctx.services.shopsA.buildContext;
    cartonGroup = new THREE.Group(); cartonGroup.name = 'station-service-carton'; root.add(cartonGroup);
    C.P.carton({ k: ctx.kit(cartonGroup) }, 26.05, ground + size.y, -28.35, .58, .28, .46);
    const collider = ctx.physics.addBox(26.05, -28.35, .58, .46, 0, ground, ground + size.y + .28);
    const bounds = { min: box.min.toArray(), max: box.max.toArray(), size: size.toArray() };
    return { cratePrototype: prototype, bounds, textures, stats: {
      assets: ['plastic_crate_02', 'worn_shutter'], source: 'Poly Haven / CC0-1.0',
      crateTriangles: triangles, cratePrimitives: primitives, ownedTextures: textures.size,
      alphaTest: .5, normalScale: prototype.getObjectByProperty('isMesh', true).material.normalScale.toArray(),
      shutterPanels: doors.map((mesh, i) => ({ center: [[23.65, 1.025, -28.688], [24.7, 1.025, -28.67]][i], size: [1.12, 1.65, .02] })),
      crate: { position: placed.position.toArray(), supportY: ground, bounds },
      carton: { position: [26.05, ground + size.y, -28.35], size: [.58, .28, .46] },
      collision: { x: collider.cx, z: collider.cz, width: .58, depth: .46, y0: collider.y0, y1: collider.y1 },
      view: { position: [26.35, ctx.L.heightAt(26.35, -27.1) + .012 + 1.6, -27.1], target: [24.4, .85, -28.78] },
      ownership: 'Station owns source crate geometry, adapted materials and seven textures; city clones geometry/materials and borrows textures. Dispose city first.',
    } };
  } catch (error) {
    placed.removeFromParent(); if (cartonGroup) cartonGroup.removeFromParent();
    doors.forEach((mesh, i) => { mesh.material = originalDoorMaterials[i]; });
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
    for (const texture of textures) texture.dispose();
    throw error;
  }
}
