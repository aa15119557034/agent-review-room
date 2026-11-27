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
  scene.userData.softenWindowHighlights = (new URLSearchParams(location.search).get('time') ?? 'evening') === 'evening';
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

/** Reuse the floor's existing instanced draw and anchor its contact shade to the exported shelf feet. */
export function shadeKonbiniFloor(floor, fixtures) {
  if (!floor?.isInstancedMesh) throw new Error('W1 instanced floor is missing');
  fixtures.updateWorldMatrix(true, true);
  floor.updateWorldMatrix(true, false);
  const lotInverse = fixtures.matrixWorld.clone().invert();
  const floorToLot = lotInverse.clone().multiply(floor.matrixWorld);
  const point = new THREE.Vector3();
  const footprints = ['gondola-a', 'gondola-b', 'gondola-c', 'magazine-rack'].map(name => {
    const shelf = fixtures.getObjectByName(`${name}-paint`);
    if (!shelf?.isMesh) throw new Error(`W1 contact shelf is missing: ${name}`);
    const position = shelf.geometry.attributes.position;
    const shelfToLot = lotInverse.clone().multiply(shelf.matrixWorld);
    const bounds = new THREE.Box3();
    for (let i = 0; i < position.count; i++) {
      point.fromBufferAttribute(position, i).applyMatrix4(shelfToLot);
      if (Math.abs(point.y - 0.30) <= 0.012) bounds.expandByPoint(point);
    }
    if (bounds.isEmpty()) throw new Error(`W1 shelf has no floor support: ${name}`);
    return new THREE.Vector4(bounds.min.x, bounds.min.z, bounds.max.x, bounds.max.z);
  });

  const original = floor.material, material = original.clone();
  material.onBeforeCompile = (shader, renderer) => {
    original.onBeforeCompile.call(material, shader, renderer);
    shader.uniforms.uW1FloorToLot = { value: floorToLot };
    shader.uniforms.uW1ShelfFeet = { value: footprints };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform mat4 uW1FloorToLot;\nvarying vec2 vW1Floor;')
      .replace('#include <project_vertex>', `#include <project_vertex>
        vW1Floor = (uW1FloorToLot * instanceMatrix * vec4(transformed, 1.0)).xz;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform vec4 uW1ShelfFeet[${footprints.length}];
        varying vec2 vW1Floor;`)
      .replace('#include <opaque_fragment>', `
        float shelfDistance = 1e4;
        for (int i = 0; i < ${footprints.length}; i++) {
          vec4 foot = uW1ShelfFeet[i];
          vec2 gap = max(max(foot.xy - vW1Floor, vW1Floor - foot.zw), vec2(0.0));
          shelfDistance = min(shelfDistance, length(gap));
        }
        float contact = 1.0 - smoothstep(0.035, 0.34, shelfDistance);
        outgoingLight *= mix(vec3(1.0), vec3(0.48, 0.55, 0.66), contact);
        #include <opaque_fragment>`);
  };
  material.customProgramCacheKey = () => `${original.customProgramCacheKey()}|w1-floor-contact`;
  floor.material = material;
}

/** The W1 panes keep their shared batch. Only these surveyed glass surfaces lose the painted streaks. */
export function softenKonbiniGlazing({ material, fixtures, front, corner, bottom, top }) {
  const uniforms = material.uniforms;
  uniforms.uW1GlassToLot = { value: fixtures.matrixWorld.clone().invert() };
  uniforms.uW1GlassFront = { value: new THREE.Vector4(...front) };
  uniforms.uW1GlassCorner = { value: new THREE.Vector4(...corner) };
  uniforms.uW1GlassHeight = { value: new THREE.Vector2(bottom, top) };
  material.fragmentShader = material.fragmentShader
    .replace('#include <common>', `#include <common>
      uniform mat4 uW1GlassToLot;
      uniform vec4 uW1GlassFront, uW1GlassCorner;
      uniform vec2 uW1GlassHeight;
      bool wbW1Pane(vec2 point, vec4 bounds) {
        return all(greaterThanEqual(point, bounds.xy)) && all(lessThanEqual(point, bounds.zw));
      }`)
    .replace('col += vec3(1.0) * streak * 0.55;', `
      vec3 w1Glass = (uW1GlassToLot * vec4(vW, 1.0)).xyz;
      bool w1Pane = w1Glass.y >= uW1GlassHeight.x && w1Glass.y <= uW1GlassHeight.y &&
        (wbW1Pane(w1Glass.xz, uW1GlassFront) || wbW1Pane(w1Glass.xz, uW1GlassCorner));
      if (w1Pane) streak *= 0.16;
      col += vec3(1.0) * streak * 0.55;`)
    .replace('float a = uOpacity + fres * 0.35 + streak * 0.35;',
      'float a = (w1Pane ? 0.13 : uOpacity) + fres * 0.35 + streak * 0.35;');
  material.needsUpdate = true;
}
