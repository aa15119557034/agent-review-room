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
import { createZoneUniforms } from './street-zones.js';
import { addStationTexturedProps } from './textured-props.js';
import { addArtR1Station } from './art-r1.js';
import { loadMatureSakura } from './mature-sakura.js';
import { loadKonbiniFixtures } from './konbini-fixtures.js';

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

// SEBA0-1's south-facing plaster wall. It sits behind the boundary blocks of the drive.
function paintDrivePlaster(material, stationFromWorld) {
  const previous = material.onBeforeCompile, previousKey = material.customProgramCacheKey;
  const limewash = new THREE.Color('#f3efe9');
  material.onBeforeCompile = function (shader, renderer) {
    previous.call(this, shader, renderer);
    shader.uniforms.uDrivePlaster = { value: limewash };
    shader.uniforms.uDriveStationFromWorld = { value: stationFromWorld };
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        #define STATION_DRIVE_PLASTER
        uniform vec3 uDrivePlaster;
        uniform mat4 uDriveStationFromWorld;`)
      .replace('#include <color_fragment>', /* glsl */`
        vec3 driveWall = (uDriveStationFromWorld * vec4( vPWorld, 1.0 )).xyz;
        float driveWallPaint = step( abs( driveWall.z - 22.3984 ), 0.025 )
          * step( 24.89, driveWall.x ) * step( driveWall.x, 33.12 )
          * smoothstep( 0.92, 1.30, driveWall.y ) * step( driveWall.y, 6.66 );
        if (driveWallPaint > 0.0) {
          float dryBrush = pn_noise( vec3( driveWall.x * 1.2, driveWall.y * 0.36, 3.4 ) );
          float coat = 0.947 + 0.036 * smoothstep( 0.36, 0.49, dryBrush )
            + 0.021 * smoothstep( 0.60, 0.68, dryBrush );
          diffuseColor.rgb = mix( diffuseColor.rgb, uDrivePlaster * coat, driveWallPaint * 0.94 );
        }
        #include <color_fragment>
      `);
  };
  material.customProgramCacheKey = () => `${previousKey.call(material)}|residential-drive-plaster`;
  material.needsUpdate = true;
}

// In SEBA0-2 GroundRect writes station-local (x, -z) to the existing map UVs.
function paintResidentialDrive(root, { concrete, gravel, plaster }, stationFromWorld) {
  const finishes = new Map([[concrete.map, 'concrete'], [gravel.map, 'gravel'], [plaster.map, 'plaster']]);
  const painted = new Set();
  root.traverse(object => {
    if (!object.isMesh) return;
    for (const material of [].concat(object.material)) {
      const finish = finishes.get(material.map);
      if (!finish || painted.has(material)) continue;
      painted.add(material);
      if (finish === 'plaster') {
        paintDrivePlaster(material, stationFromWorld);
        continue;
      }
      const previous = material.onBeforeCompile, previousKey = material.customProgramCacheKey;
      const isConcrete = finish === 'concrete';
      const color = new THREE.Color(isConcrete ? '#eeede8' : '#d7d4cb');
      material.onBeforeCompile = function (shader, renderer) {
        previous.call(this, shader, renderer);
        shader.uniforms.uDriveBase = { value: color };
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', `#include <common>\nuniform vec3 uDriveBase;\n${isConcrete ? '#define STATION_DRIVE_CONCRETE' : ''}`)
          .replace('#include <color_fragment>', /* glsl */`
            vec2 driveXZ = vMapUv * vec2( ${isConcrete ? '2.0, -2.0' : '1.5, -1.5'} );
            vec2 driveIn = smoothstep( vec2( 22.20, 23.52 ), vec2( 22.45, 23.75 ), driveXZ );
            vec2 driveOut = 1.0 - smoothstep( vec2( 28.95, 26.98 ), vec2( 29.35, 27.22 ), driveXZ );
            float drivePaint = driveIn.x * driveIn.y * driveOut.x * driveOut.y;
            ${isConcrete ? /* glsl */`
            vec2 driveJointDist = abs( fract( vMapUv ) - 0.5 );
            vec2 driveJointAA = clamp( fwidth( vMapUv ) * 0.62, 0.0008, 0.016 );
            vec2 driveJoints = 1.0 - smoothstep( vec2( 0.0013 ), vec2( 0.0040 ) + driveJointAA, driveJointDist );
            if (drivePaint > 0.0) {
              float slabTint = pn_hash( vec3( floor( vMapUv - 0.5 ), 0.0 ) );
              float driveJoint = max( driveJoints.x, driveJoints.y );
              vec3 driveFinish = uDriveBase * (0.977 + 0.036 * slabTint) * (1.0 - 0.13 * driveJoint);
              diffuseColor.rgb = mix( diffuseColor.rgb, driveFinish, drivePaint * 0.98 );
            }
            ` : /* glsl */`
            float gravelAA = clamp( max( fwidth( driveXZ.x ), fwidth( driveXZ.y ) ) * 11.0, 0.018, 0.20 );
            if (drivePaint > 0.0) {
              vec2 grit = driveXZ * 20.0;
              vec2 gritCell = floor( grit );
              float gritSeed = pn_hash( vec3( gritCell, 7.0 ) );
              vec2 gritShift = vec2( fract( 7.12 * gritSeed ), fract( 29.35 * gritSeed ) ) * 0.38 - 0.19;
              vec2 chip = abs( fract( grit ) - 0.5 - gritShift );
              float chipDist = max( max( chip.x * 0.85, chip.y ), dot( chip, vec2( 0.66, 0.75 ) ) );
              float chipSize = 0.12 + 0.14 * gritSeed;
              float chipPaint = 1.0 - smoothstep( chipSize - gravelAA, chipSize + gravelAA, chipDist );
              chipPaint *= step( 0.46, gritSeed ) * (1.0 - smoothstep( 0.10, 0.20, gravelAA ));
              float bedTone = mix( 0.925, 1.032, smoothstep( 0.29, 0.68, pn_noise( vec3( driveXZ * 3.2, 4.6 ) ) ) );
              float chipTone = gritSeed > 0.80 ? 1.095 : 0.82;
              vec3 driveFinish = uDriveBase * mix( bedTone, chipTone, chipPaint * 0.75 );
              diffuseColor.rgb = mix( diffuseColor.rgb, driveFinish, drivePaint );
            }
            `}
            #include <color_fragment>
          `);
      };
      material.customProgramCacheKey = () => `${previousKey.call(material)}|residential-drive-${finish}`;
      material.needsUpdate = true;
    }
  });
}

export async function createStation({ scene, renderer, camera, offset = [280, 8, 900], rotationY = 0,
  sunDir = new THREE.Vector3(...layout.SUN_DIR).normalize(), evening = false, groundMaterial, refl = null, replaceStreetProps = false,
  vendingGlow = null, onProgress = () => {} }) {
  const root = new THREE.Group();
  root.name = 'Sakuragaoka';
  const localCamera = new THREE.PerspectiveCamera();
  const ctx = createContext({ scene: root, renderer, camera: localCamera, audio: null,
    quality: { name: 'medium', petals: 0, pixelRatio: 1 }, sunDir });
  ctx.people = false;
  if (replaceStreetProps) {
    ctx.services.streetPropReplacements = [];
    ctx.services.stationVending = [];
    (ctx.services.weatheringBakes ??= []).push(new URL('./weathering-decals-vending.json', import.meta.url));
  }
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
    } else if (name === 'shopsA') {
      await module.build(ctx, { konbiniFixtures: await loadKonbiniFixtures(ctx) });
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
  // Art r22: zoned street cubes for the wet road (params from toon.json, baked later by main.js). refl = null keeps r21.
  const zones = refl ? { count: refl.zones.length, params: refl, uniforms: createZoneUniforms(refl) } : null;
  const wetRoad = applyWetRoad({ root, ctx, reflections: streetReflections, zones });
  // These textures belong to the island; the station owns only the blend mesh
  // and material. Disposing the district must not invalidate island rendering.
  const islandTextures = new Set(Object.values(groundMaterial.uniforms).map(uniform => uniform.value).filter(value => value?.isTexture));
  const trimMs = Math.round(performance.now() - clipStart);
  const batchStart = performance.now();
  // Tint the already-packed emissive atlas per display, then let static batching
  // bake the tint into vertex colours. The original artwork stays shared.
  const displayMaterials = new Map();
  const displayTint = vendingGlow ? new THREE.Color('#fffaf1').multiplyScalar(vendingGlow === 'night' ? 1.14 : 1.10) : null;
  for (const display of ctx.services.stationVending ?? []) {
    if (displayTint) for (const mesh of display.meshes) {
      const source = mesh.material;
      if (!displayMaterials.has(source)) {
        const tinted = source.clone();
        tinted.color.multiply(displayTint);
        displayMaterials.set(source, tinted);
      }
      mesh.material = displayMaterials.get(source);
    }
    display.meshCount = display.meshes.length;
    delete display.meshes;
  }
  const batch = batchStatic(ctx.staticRoot, { mat: ctx.mat });
  for (const material of displayMaterials.values()) material.dispose();
  const batchMs = Math.round(performance.now() - batchStart);
  root.position.fromArray(offset);
  root.rotation.y = rotationY;
  scene.add(root);
  root.updateWorldMatrix(true, true);
  streetReflections.setTransform(root.matrixWorld);
  clipMaterials(root, layout.WORLD.play);
  const detailLod = createStationDetailLod({ root: ctx.staticRoot });
  const inverse = root.matrixWorld.clone().invert();
  paintResidentialDrive(ctx.staticRoot, ctx.services.houses.buildContext.M, inverse);
  const rotation = root.getWorldQuaternion(new THREE.Quaternion());
  const scratch = new THREE.Vector3();
  const bufferSize = new THREE.Vector2();
  const bounds = layout.WORLD.play;
  // 附加可走区（#254：主矩形之外的店铺室内等），由 shop-entry 在场景建好后填充。
  // clipMaterials / 网格剔除仍只用主矩形 bounds，不受影响。
  const walkExtra = [];
  let disposed = false;
  const walkers = new Set();
  const station = {
    root, ctx, physics: ctx.physics, camera, localCamera, bounds, walkExtra, moduleStats, batch, detailLod,
    timings: { trimMs, batchMs }, removedMeshes, artR1, groundBlend, streetscape, wetRoad, streetReflections, texturedProps, zones, streetZones: null,
    toLocal(position, target = new THREE.Vector3()) { return target.copy(position).applyMatrix4(inverse); },
    toWorld(position, target = new THREE.Vector3()) { return target.copy(position).applyMatrix4(root.matrixWorld); },
    cameraToWorld(position, quaternion) {
      station.toWorld(position, camera.position);
      camera.quaternion.copy(rotation).multiply(quaternion);
      camera.updateMatrixWorld();
    },
    /** 主矩形 + 附加可走区的并集；都不在时夹到最近的一块 */
    clampWalkable(position, radius) {
      const inside = (a) => position.x >= a.x0 + radius && position.x <= a.x1 - radius
        && position.z >= a.z0 + radius && position.z <= a.z1 - radius;
      if (inside(bounds)) return position;
      for (const a of walkExtra) if (inside(a)) return position;
      let bx = position.x, bz = position.z, bestD = Infinity;
      for (const a of [bounds, ...walkExtra]) {
        const cx = THREE.MathUtils.clamp(position.x, a.x0 + radius, a.x1 - radius);
        const cz = THREE.MathUtils.clamp(position.z, a.z0 + radius, a.z1 - radius);
        const d = (cx - position.x) ** 2 + (cz - position.z) ** 2;
        if (d < bestD) { bestD = d; bx = cx; bz = cz; }
      }
      position.x = bx; position.z = bz;
      return position;
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
    createWalker(dom) {
      const walker = createStationWalker(station, dom);
      walkers.add(walker);
      return walker;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const walker of walkers) walker.dispose();
      detailLod.dispose();
      wetRoad.dispose();
      station.streetZones?.dispose();
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

