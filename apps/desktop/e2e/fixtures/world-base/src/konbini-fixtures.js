import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/** Authored fixture meshes in the W1 lot's coordinate system. */
export async function loadKonbiniFixtures(ctx) {
  const { scene } = await new GLTFLoader().loadAsync('/konbini-interior/konbini-interior.glb');
  const materials = new Map();
  const toToon = (source) => {
    if (materials.has(source)) return materials.get(source);
    const material = new THREE.MeshToonMaterial({
      name: source.name,
      color: source.color,
      map: source.map,
      gradientMap: ctx.mat.gradientMap,
      vertexColors: source.vertexColors,
      emissive: source.emissive ?? new THREE.Color(),
      emissiveMap: source.emissiveMap ?? null,
      emissiveIntensity: source.emissiveIntensity ?? 1,
      alphaTest: source.alphaTest,
      opacity: source.opacity,
      transparent: source.transparent,
      depthWrite: source.depthWrite,
      side: source.side,
    });
    if (!source.transparent) {
      // Area fill from the fluorescent strips. Keep printed and painted colours
      // readable while their direct light still uses the station's cel bands.
      material.onBeforeCompile = (shader) => {
        shader.fragmentShader = shader.fragmentShader.replace('#include <emissivemap_fragment>', `
          #include <emissivemap_fragment>
          totalEmissiveRadiance += diffuseColor.rgb * vec3(0.32, 0.36, 0.44);
        `);
      };
      material.customProgramCacheKey = () => 'w1-fluorescent-fill';
    }
    materials.set(source, material);
    return material;
  };
  scene.name = 'w1-authored-interior';
  // The source is already grouped by fixture and material.
  scene.userData.noBatch = true;
  // The exterior decal rays do not need to consider these enclosed shelves.
  scene.userData.noDecal = true;
  scene.traverse(object => {
    if (!object.isMesh) return;
    object.material = toToon(object.material);
    object.castShadow = false;
    object.receiveShadow = !object.material.transparent;
    if (object.material.transparent) ctx.noOutline(object);
  });
  for (const source of materials.keys()) source.dispose();
  const bakes = (ctx.services.weatheringBakes ??= []);
  bakes.push(new URL('./weathering-decals-konbini.json', import.meta.url));
  const vendingBake = new URL('./weathering-decals-vending.json', import.meta.url).href;
  if (bakes.some(url => url.href === vendingBake)) bakes.push(new URL('./weathering-decals-combined.json', import.meta.url));
  return scene;
}
