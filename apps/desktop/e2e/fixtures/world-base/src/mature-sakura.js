import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { paintedSakuraMaterial } from '../upstream/sakuragaoka/src/world/sakura/materials.js';
import { matureTreeShape } from '../upstream/sakuragaoka/src/world/sakura.js';

export async function loadMatureSakura(ctx) {
  const { scene } = await new GLTFLoader().loadAsync('/mature-sakura/mature-sakura.glb');
  const variants = new Map(), replacements = new Map();
  const resources = { geometries: new Set(), materials: new Set(), textures: new Set() };
  for (const group of scene.children) {
    const { seed, sourceSpec, sourceGeometry } = group.userData;
    const { base, info, colliders } = JSON.parse(sourceGeometry);
    const counts = {};
    for (const part of group.children) {
      const role = part.userData.role, source = part.material;
      if (!['bark', 'blob', 'cards'].includes(role) || !source.map || counts[role] !== undefined) throw new Error('Invalid mature cherry mesh: ' + part.name);
      if (!replacements.has(source)) replacements.set(source, paintedSakuraMaterial(ctx, role, source.map, source.alphaTest));
      part.material = replacements.get(source);
      part.castShadow = true;
      part.receiveShadow = role === 'bark';
      if (role === 'cards') ctx.noOutline(part);
      if (role === 'blob') ctx.noBatch(part);
      counts[role] = part.geometry.index.count / 3;
      resources.geometries.add(part.geometry);
      resources.materials.add(part.material);
      resources.textures.add(source.map);
    }
    if (Object.keys(counts).length !== 3 || variants.has(seed)) throw new Error('Invalid mature cherry variant: ' + seed);
    group.position.fromArray(base);
    variants.set(seed, { group, shape: matureTreeShape(JSON.parse(sourceSpec)), groundY: base[1], info, colliders, counts });
  }
  for (const source of replacements.keys()) source.dispose();
  return { variants, resources };
}
