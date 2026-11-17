import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { visibleBankHeight } from './skyline.js';

// Author dimensions, never stretched storeys. These lots stay outside the
// station's walkable area and the two existing apartment yards.
const SITES = [
  { name: 'brick-large', file: 'downtown/Building_Large_2.gltf', center: [35, -135], maximumRelief: 1.5 },
  { name: 'brick-medium', file: 'downtown/Building_Medium_2_001.gltf', center: [-16, -135], maximumRelief: 1.5 },
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
          if (site.file.startsWith('downtown/')) {
            material.vertexColors = false;
            // The free Standard facades are authored dark for PBR with an
            // environment map; this scene has none. Lift them towards the
            // station's light plaster/brick values so they read as backdrop.
            material.color.multiplyScalar(1.35);
            if ('envMapIntensity' in material) material.envMapIntensity = 0;
          }
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
    const connections = buildConnections({ root, station, island, placements, foundation, geometries, materials });
    vegetationClearAreas.push(...connections.clearAreas);
    stats.connections = connections.report;
    stats.connectionBatching = batchConnections(root, geometries);
    // Once every material has been rewired, close decoded images that no live
    // material uses. Texture sharing alone would retain duplicate CPU bitmaps.
    const liveImages = new Set([...sharedTextures.values()].map(texture => texture.image));
    stats.decodedImagesReleased = 0;
    for (const bitmap of bitmaps) if (!liveImages.has(bitmap)) {
      bitmap.close?.(); bitmaps.delete(bitmap); stats.decodedImagesReleased++;
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

// Only the adapter's direct-child stairs, foundations and road strips are
// merged. Imported model geometry and material groups remain unmodified.
function batchConnections(root, owned) {
  const groups = new Map();
  for (const mesh of root.children.filter(object => object.isMesh)) {
    if (!groups.has(mesh.material)) groups.set(mesh.material, []);
    groups.get(mesh.material).push(mesh);
  }
  let before = 0, triangles = 0;
  for (const [material, meshes] of groups) {
    const inputs = meshes.map(mesh => { mesh.updateMatrix(); return mesh.geometry.clone().applyMatrix4(mesh.matrix); });
    const geometry = mergeGeometries(inputs, false);
    for (const input of inputs) input.dispose();
    if (!geometry) throw new Error('City connection geometry could not be batched');
    before += meshes.length; triangles += geometry.index.count / 3;
    for (const mesh of meshes) { mesh.removeFromParent(); mesh.geometry.dispose(); owned.delete(mesh.geometry); }
    owned.add(geometry);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = material.map ? 'city-roads' : meshes[0].name === 'city-block-paving' ? 'city-block-paving' : 'city-foundations-and-stairs'; root.add(mesh);
  }
  return { meshesBefore: before, meshesAfter: groups.size, triangles, originalBuildingMeshesChanged: 0 };
}

function buildConnections({ root, station, island, placements, foundation, geometries, materials }) {
  const matrix = station.root.matrixWorld.clone(), inverse = matrix.clone().invert();
  const ground = visibleBankHeight(station, island, matrix, inverse,
    (x, z) => island.heightAt(x + root.position.x, z + root.position.z) - root.position.y);
  const asphalt = new THREE.MeshToonMaterial({ color: '#9fa2a5',
    map: station.ctx.services.houses.buildContext.M.asphalt.map, gradientMap: station.ctx.mat.gradientMap });
  materials.add(asphalt); // Both maps are borrowed from station.
  const clearAreas = [], report = { roads: [], stairs: [], walkable: false };
  const roads = [
    { name: 'city-front-street', minX: -27, maxX: 49, minZ: -124.5, maxZ: -118 },
    { name: 'city-east-link', minX: 49, maxX: 54, minZ: -124.5, maxZ: -101 },
  ];
  // One paved city block under the three mid-rises, joining the front street,
  // so the buildings stand on a lot instead of being pushed into the meadow.
  const paving = new THREE.MeshToonMaterial({ color: '#c6c2b8', gradientMap: station.ctx.mat.gradientMap });
  materials.add(paving);
  const block = placements.reduce((box, p) => ({ minX: Math.min(box.minX, p.footprint.minX - 2.5), maxX: Math.max(box.maxX, p.footprint.maxX + 2.5),
    minZ: Math.min(box.minZ, p.footprint.minZ - 2.5), maxZ: -124.5 }), { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -124.5 });
  roads.push({ name: 'city-block-paving', ...block, material: paving });
  for (const road of roads) {
    const nx = Math.ceil(road.maxX - road.minX), nz = Math.ceil(road.maxZ - road.minZ);
    const vertices = [], uv = [], indices = [];
    for (let j = 0; j <= nz; j++) for (let i = 0; i <= nx; i++) {
      const x = road.minX + (road.maxX - road.minX) * i / nx;
      const z = road.minZ + (road.maxZ - road.minZ) * j / nz;
      vertices.push(x, ground(x, z) + (road.material ? 0.03 : 0.06), z); uv.push(x / 4, z / 4);
      if (i < nx && j < nz) {
        const a = j * (nx + 1) + i, c = a + nx + 1;
        indices.push(a, c, a + 1, a + 1, c, c + 1);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geometry.setIndex(indices); geometry.computeVertexNormals(); geometries.add(geometry);
    const mesh = new THREE.Mesh(geometry, road.material || asphalt); mesh.name = road.name; root.add(mesh);
    const { material: _unused, ...area } = road;
    clearAreas.push(area); report.roads.push({ ...area, triangles: indices.length / 3, groundOffset: road.material ? 0.03 : 0.06 });
  }
  const stairs = (name, x, width, highZ, lowZ, top) => {
    const low = Math.max(...[-0.5, 0, 0.5].map(side => ground(x + side * width, lowZ))) + 0.065;
    const drop = top - low, count = Math.ceil(drop / 0.18), run = Math.abs(lowZ - highZ);
    if (!(drop > 0 && count > 0 && run / count >= 0.25)) throw new Error('City entry cannot fit real steps: ' + name);
    let minClearance = Infinity;
    for (let k = 0; k < count; k++) {
      const za = highZ + (lowZ - highZ) * k / count, zb = highZ + (lowZ - highZ) * (k + 1) / count;
      const level = top - drop * k / count;
      let min = Infinity, max = -Infinity;
      const nx = Math.ceil(width / 0.1), nz = Math.ceil(Math.abs(zb - za) / 0.1);
      for (let j = 0; j <= nz; j++) for (let i = 0; i <= nx; i++) {
        const height = ground(x - width / 2 + width * i / nx, za + (zb - za) * j / nz);
        min = Math.min(min, height); max = Math.max(max, height);
      }
      if (level < max + 0.005) throw new Error('City stair intersects visible terrain: ' + name);
      minClearance = Math.min(minClearance, level - max);
      const bottom = min - 0.05;
      const geometry = new THREE.BoxGeometry(width, level - bottom, Math.abs(zb - za)); geometries.add(geometry);
      const mesh = new THREE.Mesh(geometry, foundation);
      mesh.name = name + '-step-' + k; mesh.position.set(x, (level + bottom) / 2, (za + zb) / 2); root.add(mesh);
    }
    clearAreas.push({ name, minX: x - width / 2, maxX: x + width / 2, minZ: Math.min(highZ, lowZ), maxZ: Math.max(highZ, lowZ) });
    report.stairs.push({ name, x, width, highZ, lowZ, steps: count, rise: drop / count, tread: run / count, top, bottom: low, minClearance });
  };
  for (const placement of placements) {
    stairs(placement.name + '-entry', placement.center[0], 2.4, placement.footprint.maxZ, -124.51, placement.foundation.top - root.position.y);
  }
  const r5 = station.ctx.services.houses.buildContext.L.ROADS.R5;
  stairs('station-levee-link', 51.5, 5, r5.z - r5.halfW - 0.03, -101, r5.y + 0.03);
  return { clearAreas, report };
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
