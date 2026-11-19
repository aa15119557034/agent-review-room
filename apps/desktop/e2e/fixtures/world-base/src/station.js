import * as THREE from 'three';
import { createContext } from '../upstream/sakuragaoka/src/core/ctx.js';
import { batchStatic } from '../upstream/sakuragaoka/src/core/batch2.js';
import * as layout from '../upstream/sakuragaoka/src/world/layout.js';
import { createStationWalker } from './station-view.js';
import { createStationDetailLod } from './station-detail-lod.js';
import { blendStationGround } from './transition.js';
import { addStreetscape } from './streetscape.js';
import { applyWetRoad } from './wet-road.js';
import { createStreetReflections } from './street-reflections.js';
import { addStationTexturedProps } from './textured-props.js';
import { addArtR1Station } from './art-r1.js';
import { loadMatureSakura } from './mature-sakura.js';

// Keep the upstream dependency order. Characters and camera-centred petal shaders
// are deliberately omitted; the shared island supplies its own petal field.
export const STATION_MODULES = [
  'environment', 'street', 'poles', 'railway', 'station', 'plaza',
  'shopsA', 'shopsB', 'houses', 'sakura', 'trains', 'crossing', 'props', 'vehicles',
];

function trimOutside(root, bounds) {
  root.updateWorldMatrix(true, true);
  const box = new THREE.Box3();
  const remove = [];
  root.traverse(object => {
    if (!object.isMesh) return;
    box.setFromObject(object);
    if (box.max.x < bounds.x0 || box.min.x > bounds.x1 || box.max.z < bounds.z0 || box.min.z > bounds.z1) remove.push(object);
  });
  for (const object of remove) object.removeFromParent();
  return remove.length;
}

function clipMaterials(root, bounds) {
  const planes = [
    new THREE.Plane(new THREE.Vector3(1, 0, 0), -bounds.x0),
    new THREE.Plane(new THREE.Vector3(-1, 0, 0), bounds.x1),
    new THREE.Plane(new THREE.Vector3(0, 0, 1), -bounds.z0),
    new THREE.Plane(new THREE.Vector3(0, 0, -1), bounds.z1),
  ].map(plane => plane.applyMatrix4(root.matrixWorld));
  const materials = new Set();
  root.traverse(object => {
    for (const material of Array.isArray(object.material) ? object.material : object.material ? [object.material] : []) materials.add(material);
    if (object.customDepthMaterial) materials.add(object.customDepthMaterial);
  });
  for (const material of materials) {
    material.clippingPlanes = planes;
    material.clipShadows = true;
    if (material.isShaderMaterial) {
      material.clipping = true;
      // Upstream custom shaders predate the district boundary. Use Three's
      // regular clipping uniforms so colour and built-in materials agree.
      if (!material.vertexShader.includes('clipping_planes_pars_vertex')) {
        let code = material.vertexShader;
        const close = code.lastIndexOf('}');
        const position = /\bvec4\s+mvPosition\b/.test(code) ? '' : 'vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);\n';
        code = code.slice(0, close) + '\n' + position + '#include <clipping_planes_vertex>\n' + code.slice(close);
        material.vertexShader = '#include <clipping_planes_pars_vertex>\n' + code;
      }
      if (!material.fragmentShader.includes('clipping_planes_pars_fragment')) {
        material.fragmentShader = '#include <clipping_planes_pars_fragment>\n' + material.fragmentShader.replace(/void\s+main\s*\(\s*\)\s*\{/, 'void main() {\n#include <clipping_planes_fragment>\n');
      }
    }
    material.needsUpdate = true;
  }
}

export async function createStation({ scene, renderer, camera, offset = [280, 8, 900], rotationY = 0,
  sunDir = new THREE.Vector3(...layout.SUN_DIR).normalize(), evening = false, groundMaterial, onProgress = () => {} }) {
  const root = new THREE.Group();
  root.name = 'Sakuragaoka';
  const localCamera = new THREE.PerspectiveCamera();
  const ctx = createContext({ scene: root, renderer, camera: localCamera, audio: null,
    quality: { name: 'medium', petals: 0, pixelRatio: 1 }, sunDir });
  ctx.people = false;
  const moduleStats = {};
  let matureResources;
  for (const name of STATION_MODULES) {
    onProgress(name);
    const start = performance.now();
    const module = await import(`../upstream/sakuragaoka/src/world/${name}.js`);
    if (name === 'sakura') {
      const { variants, resources } = await loadMatureSakura(ctx);
      matureResources = resources;
      await module.build(ctx, variants);
    } else await module.build(ctx);
    moduleStats[name] = Math.round(performance.now() - start);
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  // Station yard gravel (#254 C15): the yards map 1.6 m onto a tile drawn as 1.5 m,
  // so at eye height the stones read as 6-8 cm cobbles. Halve the stone size.
  const gravel = ctx.tex.cache.get('st-gravel');
  if (!gravel) throw new Error('Station gravel texture missing');
  gravel.wrapS = gravel.wrapT = THREE.RepeatWrapping;
  gravel.repeat.set(1.9, 1.9);
  const streetscape = addStreetscape({ ctx, root });
  const artR1 = addArtR1Station({ ctx });
  onProgress('textured-props');
  const texturedProps = await addStationTexturedProps({ ctx, root });
  // Facade drops and batching bake matrixWorld. Finish while the detached root
  // is identity, then attach/translate exactly once.
  const wires = ctx.wires.build();
  if (wires) {
    wires.material.vertexShader = wires.material.vertexShader.replaceAll('viewMatrix * vec4(', 'modelViewMatrix * vec4(');
    root.add(wires);
  }
  const clipStart = performance.now();
  const removedMeshes = trimOutside(root, layout.WORLD.play);
  const groundBlend = blendStationGround({ root, terrainMaterial: groundMaterial, bounds: layout.WORLD.play });
  const streetReflections = await createStreetReflections(root, layout, evening);
  const wetRoad = applyWetRoad({ root, ctx, reflections: streetReflections });
  // These textures belong to the island; the station owns only the blend mesh
  // and material. Disposing the district must not invalidate island rendering.
  const islandTextures = new Set(Object.values(groundMaterial.uniforms).map(uniform => uniform.value).filter(value => value?.isTexture));
  const trimMs = Math.round(performance.now() - clipStart);
  const batchStart = performance.now();
  const batch = batchStatic(ctx.staticRoot, { mat: ctx.mat });
  const batchMs = Math.round(performance.now() - batchStart);
  root.position.fromArray(offset);
  root.rotation.y = rotationY;
  scene.add(root);
  root.updateWorldMatrix(true, true);
  streetReflections.setTransform(root.matrixWorld);
  clipMaterials(root, layout.WORLD.play);
  const detailLod = createStationDetailLod({ root: ctx.staticRoot });
  const inverse = root.matrixWorld.clone().invert();
  const rotation = root.getWorldQuaternion(new THREE.Quaternion());
  const scratch = new THREE.Vector3();
  const bufferSize = new THREE.Vector2();
  const bounds = layout.WORLD.play;
  let disposed = false;
  const walkers = new Set();
  const station = {
    root, ctx, physics: ctx.physics, camera, localCamera, bounds, moduleStats, batch, detailLod,
    timings: { trimMs, batchMs }, removedMeshes, artR1, groundBlend, streetscape, wetRoad, streetReflections, texturedProps,
    toLocal(position, target = new THREE.Vector3()) { return target.copy(position).applyMatrix4(inverse); },
    toWorld(position, target = new THREE.Vector3()) { return target.copy(position).applyMatrix4(root.matrixWorld); },
    cameraToWorld(position, quaternion) {
      station.toWorld(position, camera.position);
      camera.quaternion.copy(rotation).multiply(quaternion);
      camera.updateMatrixWorld();
    },
    contains(position) {
      station.toLocal(position, scratch);
      return scratch.x >= bounds.x0 && scratch.x <= bounds.x1 && scratch.z >= bounds.z0 && scratch.z <= bounds.z1;
    },
    groundHeight(position) {
      station.toLocal(position, scratch);
      return ctx.physics.groundHeight(scratch.x, scratch.z, scratch.y) + root.position.y;
    },
    update(dt, time, worldFeet) {
      if (disposed) return;
      localCamera.position.copy(camera.position).applyMatrix4(inverse);
      // Trains compare the local position; shop steam uses a world quaternion
      // against its parent's getWorldQuaternion() to face the shared camera.
      localCamera.quaternion.copy(camera.quaternion);
      if (worldFeet) station.toLocal(worldFeet, ctx.player.position);
      ctx.time = time;
      ctx.shared.uTime.value = time;
      ctx.shared.uGust.value = 0.5 + 0.28 * Math.sin(time * 0.37) + 0.14 * Math.sin(time * 1.13 + 1.7) + 0.08 * Math.sin(time * 2.9 + 0.4);
      for (const update of ctx._updates) update(dt, time);
      ctx.physics.refreshDynamic();
      renderer.getDrawingBufferSize(bufferSize);
      ctx.wires.setResolution(bufferSize.x, bufferSize.y);
      detailLod.update(camera, bufferSize.x, bufferSize.y);
    },
    createWalker(dom, coast) {
      const walker = createStationWalker(station, dom, coast);
      walkers.add(walker);
      return walker;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const walker of walkers) walker.dispose();
      detailLod.dispose();
      wetRoad.dispose();
      streetReflections.dispose();
      root.removeFromParent();
      const { geometries, materials } = matureResources;
      const textures = new Set(matureResources.textures);
      for (const texture of texturedProps.textures) textures.add(texture);
      root.traverse(object => {
        if (object.geometry) geometries.add(object.geometry);
        if (object.customDepthMaterial) materials.add(object.customDepthMaterial);
        for (const material of Array.isArray(object.material) ? object.material : object.material ? [object.material] : []) materials.add(material);
      });
      for (const material of materials) {
        for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
        for (const uniform of Object.values(material.uniforms || {})) if (uniform.value?.isTexture) textures.add(uniform.value);
        material.dispose();
      }
      for (const geometry of geometries) geometry.dispose();
      for (const texture of textures) if (!islandTextures.has(texture)) texture.dispose();
      for (const texture of matureResources.textures) texture.source.data?.close?.();
    },
  };
  station.spawn = station.toWorld(new THREE.Vector3(layout.HERO.x, ctx.physics.groundHeight(layout.HERO.x, layout.HERO.z), layout.HERO.z));
  ctx.player.position.set(layout.HERO.x, ctx.physics.groundHeight(layout.HERO.x, layout.HERO.z), layout.HERO.z);
  station.update(0, 14);
  return station;
}
