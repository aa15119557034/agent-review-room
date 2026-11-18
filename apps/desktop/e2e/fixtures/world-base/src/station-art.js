import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Frame } from '../upstream/sakuragaoka/src/world/houses/gb.js';

const BUILDINGS = [
  { name: 'station-exchange', x: 35, z: -124.2, yaw: 0, halfWidth: 3.15, halfDepth: 3.55 },
  { name: 'alley-workshop', x: -30, z: -142.6, yaw: 2.03, halfWidth: 2.72, halfDepth: 3.07 },
];

/** Only the wings and fascia replace the existing laundry. Other GLB assemblies use their original metres and axes. */
async function loadBuilding(loader, name, node, geometries, materials) {
  const { scene } = await loader.loadAsync('/station-art/' + name + '.glb');
  const group = node ? scene.getObjectByName(node) : scene;
  const retained = new Set();
  group?.traverse(o => { if (o.isMesh) retained.add(o.geometry); });
  scene.traverse(o => {
    if (!o.isMesh) return;
    for (const mat of [].concat(o.material)) materials.add(mat);
    if (retained.has(o.geometry)) {
      geometries.add(o.geometry); o.castShadow = true; o.receiveShadow = true;
    } else o.geometry.dispose();
  });
  if (!group || !retained.size) throw new Error('Missing station art geometry in ' + name + ': ' + (node || 'root'));
  return group;
}

export async function addStationArt({ root, gb, concrete, heightAt, placements, vegetationClearAreas, skyline, connections, shop, materials, geometries }) {
  const loader = new GLTFLoader();
  const grounds = [];
  for (const { name, x, z, yaw, halfWidth, halfDepth } of BUILDINGS) {
    const cos = Math.cos(yaw), sin = Math.sin(yaw);
    const dx = Math.abs(cos) * halfWidth + Math.abs(sin) * halfDepth;
    const dz = Math.abs(sin) * halfWidth + Math.abs(cos) * halfDepth;
    const footprint = { minX: x - dx, maxX: x + dx, minZ: z - dz, maxZ: z + dz };
    const overlap = [...vegetationClearAreas, ...skyline.vegetationClearAreas].find(r =>
      r.minX < footprint.maxX && r.maxX > footprint.minX && r.minZ < footprint.maxZ && r.maxZ > footprint.minZ);
    if (overlap) throw new Error(name + ' overlaps ' + overlap.name);

    // Sample the rotated plinth itself, including all four edges, so the workshop does not inherit
    // a higher point in the wedge outside its long side.
    let min = Infinity, max = -Infinity;
    for (let i = 0; i <= 30; i++) for (let j = 0; j <= 30; j++) {
      const u = halfWidth * (i / 15 - 1), v = halfDepth * (j / 15 - 1);
      const y = heightAt(x + u * cos + v * sin, z - u * sin + v * cos);
      min = Math.min(min, y); max = Math.max(max, y);
    }
    const top = max + .04, bottom = min - .08;
    const frame = Frame.at(gb, x, 0, z, yaw);
    frame.boxB(concrete, '#969f99', halfWidth * 2, top - bottom, halfDepth * 2, 0, bottom, 0, { shadow: false, skip: 'd' });
    const model = await loadBuilding(loader, name, null, geometries, materials);
    model.name = name;
    model.position.set(x, top, z);
    model.rotation.y = yaw;
    root.add(model);
    const foundation = { top: top + root.position.y, bottom: bottom + root.position.y, height: top - bottom };
    const ground = { min: min + root.position.y, max: max + root.position.y, relief: max - min, samples: 961 };
    const plot = { name, type: 'station-art', center: [x,z], baseY: top, yaw, halfWidth, halfDepth, footprint, foundation, ground,
      worldOrigin: [x + root.position.x, foundation.top, z + root.position.z] };
    placements.push(plot);
    grounds.push(plot);
    vegetationClearAreas.push({ name, ...footprint });
    if (name === 'station-exchange') {
      const entry = connections.stairs(name + '-entry', x - .55, 1.64, z + halfDepth, -118.51, top + .32);
      vegetationClearAreas.push(entry);
    }
  }
  const portal = await loadBuilding(loader, 'laundry-infill', 'Portal_wings', geometries, materials);
  portal.position.set(shop.center[0], shop.baseY, shop.center[1] - 1.25);
  root.add(portal);
  return { grounds, portal };
}
