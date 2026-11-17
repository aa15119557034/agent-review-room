import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// Author dimensions, never stretched storeys. These lots stay outside the
// station's walkable area and the two existing apartment yards.
const SITES = [
  { name: 'curved-tower', file: 'highrise/high_rise_building.glb', center: [-40, -235], maximumRelief: 3 },
  { name: 'brick-large', file: 'downtown/Building_Large_2.gltf', center: [35, -135], maximumRelief: 1.5 },
  { name: 'brick-medium', file: 'downtown/Building_Medium_2_001.gltf', center: [-65, -145], maximumRelief: 1.5 },
  { name: 'brick-small', file: 'downtown/Building_Small_1.gltf', center: [9, -135], maximumRelief: 1.5 },
];

export async function createCity({ scene, station, island, skyline }) {
  const root = new THREE.Group();
  root.name = 'station-city-background';
  root.userData.walkable = false;
  root.position.copy(station.root.position);
  if (station.root.rotation.y !== 0 || station.root.scale.distanceTo(new THREE.Vector3(1, 1, 1)) > 1e-6) {
    throw new Error('City sites are surveyed for the current unscaled, north-facing station');
  }
  const geometries = new Set(), materials = new Set(), textures = new Set(), bitmaps = new Set();
  const sharedTextures = new Map(), processedMaterials = new Set(), placements = [], vegetationClearAreas = [];
  const stats = { buildings: 0, modelTriangles: 0, modelPrimitives: 0, texturesBeforeSharing: 0, duplicateTexturesRemoved: 0 };
  const foundation = new THREE.MeshToonMaterial({ color: '#aaa79c', gradientMap: station.ctx.mat.gradientMap });
  materials.add(foundation); // gradientMap is borrowed; never disposed here.
  const loader = new GLTFLoader();
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true; root.removeFromParent();
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
    for (const texture of textures) texture.dispose();
    for (const bitmap of bitmaps) bitmap.close?.();
  };
  try {
    for (const site of SITES) {
      const url = new URL('/city-assets/' + site.file, location.href).href;
      const gltf = await loader.loadAsync(url);
      const model = gltf.scene;
      model.traverse(object => {
        if (!object.isMesh) return;
        geometries.add(object.geometry);
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
          materials.add(material);
          for (const texture of Object.values(material)) if (texture?.isTexture) {
            textures.add(texture);
            if (texture.image) bitmaps.add(texture.image);
          }
        }
      });
      model.updateWorldMatrix(true, true);
      const bounds = new THREE.Box3().setFromObject(model, true);
      const size = bounds.getSize(new THREE.Vector3()), center = bounds.getCenter(new THREE.Vector3());
      const [x, z] = site.center;
      const lot = { minX: x - size.x / 2 - 0.25, maxX: x + size.x / 2 + 0.25,
        minZ: z - size.z / 2 - 0.25, maxZ: z + size.z / 2 + 0.25 };
      const overlaps = other => lot.minX < other.maxX && lot.maxX > other.minX && lot.minZ < other.maxZ && lot.maxZ > other.minZ;
      if (lot.maxZ >= station.bounds.z0 || placements.some(p => overlaps(p.footprint)) ||
        skyline.placements.some(p => overlaps(p.footprint.localBounds))) throw new Error('City lot intersects an existing site: ' + site.name);
      const heights = terrainRange(island.terrain, lot, root.position);
      if (heights.max - heights.min > site.maximumRelief) throw new Error('City lot needs too tall a foundation: ' + site.name);
      const top = heights.max + 0.05, bottom = heights.min - 0.05;
      const plinthGeometry = new THREE.BoxGeometry(size.x + 0.5, top - bottom, size.z + 0.5);
      geometries.add(plinthGeometry);
      const plinth = new THREE.Mesh(plinthGeometry, foundation);
      plinth.name = site.name + '-foundation';
      plinth.position.set(x, (top + bottom) / 2 - root.position.y, z);
      root.add(plinth);
      model.position.add(new THREE.Vector3(x - center.x, top - root.position.y - bounds.min.y, z - center.z));
      model.name = site.name;
      model.traverse(object => {
        if (!object.isMesh) return;
        geometries.add(object.geometry);
        object.castShadow = false; object.receiveShadow = false;
        object.userData.walkable = false;
        const list = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of list) {
          if (processedMaterials.has(material)) continue;
          processedMaterials.add(material);
          // Standard exports contain red control colours. Keep the source
          // attributes, but do not multiply these into the painted facade.
          if (site.file.startsWith('downtown/')) material.vertexColors = false;
          for (const [slot, texture] of Object.entries(material)) {
            if (!texture?.isTexture) continue;
            const textureIndex = gltf.parser.associations.get(texture)?.textures;
            const textureDef = gltf.parser.json.textures[textureIndex];
            const imageDef = gltf.parser.json.images[textureDef.source];
            const source = imageDef.uri ? new URL(imageDef.uri, url).href : url + '#image-' + textureDef.source;
            const key = textureKey(source, texture);
            if (sharedTextures.has(key)) {
              const shared = sharedTextures.get(key);
              if (shared !== texture) {
                material[slot] = shared;
                texture.dispose();
              }
            } else sharedTextures.set(key, texture);
          }
          material.needsUpdate = true;
        }
        stats.modelPrimitives += object.geometry.groups.length || 1;
        stats.modelTriangles += (object.geometry.index?.count ?? object.geometry.attributes.position.count) / 3;
      });
      root.add(model);
      placements.push({ name: site.name, file: site.file, scale: 1, center: site.center, sourceSize: size.toArray(),
        footprint: lot, ground: heights, foundation: { top, bottom, height: top - bottom },
        worldOrigin: model.position.clone().add(root.position).toArray() });
      vegetationClearAreas.push({ name: site.name, ...lot });
    }
    stats.buildings = placements.length;
    stats.texturesBeforeSharing = textures.size;
    stats.uniqueTextures = sharedTextures.size;
    stats.duplicateTexturesRemoved = textures.size - sharedTextures.size;
    stats.textureRGBA8WithMipsEstimateBytes = [...sharedTextures.values()].reduce((sum, texture) =>
      sum + texture.image.width * texture.image.height * 4 * (texture.generateMipmaps ? 4 / 3 : 1), 0);
    stats.materials = materials.size;
    stats.geometries = geometries.size;
    stats.limitation = 'Original model scales, no LOD or navigable interior. Texture memory is a format estimate, not measured VRAM. Backgrounds do not cast into the station shadow map.';
    scene.add(root); root.updateWorldMatrix(true, true);
  } catch (error) { dispose(); throw error; }
  return { root, placements, vegetationClearAreas, stats, dispose };

}

// Share only genuinely identical sampling, UV and colour-space semantics.
function textureKey(source, texture) {
  return JSON.stringify([source, texture.colorSpace, texture.channel, texture.wrapS, texture.wrapT,
    texture.magFilter, texture.minFilter, texture.anisotropy, texture.flipY, texture.premultiplyAlpha,
    texture.unpackAlignment, texture.format, texture.type, texture.generateMipmaps,
    texture.offset.toArray(), texture.repeat.toArray(), texture.center.toArray(), texture.rotation,
    texture.matrixAutoUpdate, texture.matrix.toArray()]);
}

// Bilinear heightAt reaches its extrema at grid/boundary intersections. Include
// those exactly rather than guessing from a few footprint corners.
function terrainRange(terrain, lot, offset) {
  const half = terrain.meta.world / 2, cell = terrain.cell;
  const axis = (min, max) => {
    const points = [min, max];
    for (let i = Math.ceil((min + half) / cell - 0.5); ; i++) {
      const value = (i + 0.5) * cell - half;
      if (value >= max) break;
      if (value > min) points.push(value);
    }
    return points;
  };
  const xs = axis(lot.minX + offset.x, lot.maxX + offset.x);
  const zs = axis(lot.minZ + offset.z, lot.maxZ + offset.z);
  let min = Infinity, max = -Infinity;
  for (const x of xs) for (const z of zs) {
    const height = terrain.heightAt(x, z);
    if (!Number.isFinite(height)) throw new Error('Invalid city foundation terrain');
    min = Math.min(min, height); max = Math.max(max, height);
  }
  return { min, max, relief: max - min, samples: xs.length * zs.length, method: 'All bilinear grid and footprint boundary intersections' };
}
