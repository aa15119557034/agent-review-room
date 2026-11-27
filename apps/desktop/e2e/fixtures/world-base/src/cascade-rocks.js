import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { ATMOSPHERE, TERRAIN_LOOKUP } from '../upstream/petalwake/src/shaders/common.js';
import { SKY_UNIFORMS } from '../upstream/petalwake/src/world/sky.js';

const MODEL_URL = new URL('/station-foliage/cascade-rocks/cascade-rocks.glb', import.meta.url);

// X/Z offsets are relative to the measured lip of the impact pool. In each model +Z faces the water.
// Recessed toes enter the existing gravel terrace. The higher backs stay at the wall side of the shelf.
export const CASCADE_ROCK_SHELVES = [
  { name: 'cascade-terrace', offset: [-8.91, 8.14], outward: [-0.21, -0.98], rad: [5.5, 2.36], seat: -0.11, toeDepth: 0.72 },
  { name: 'cascade-angled-shelf', offset: [9.39, -7.15], outward: [-0.86, -0.51], rad: [4.25, 2.16], seat: -0.10, toeDepth: 0.61 },
  { name: 'cascade-wet-toe', offset: [11.71, -17.78], outward: [-0.98, -0.19], rad: [2.73, 1.57], seat: 0.04, toeDepth: 0.46 },
];
const HIGH_LEDGE = { name: 'cascade-high-ledge', offset: [20.013, 2.524], outward: [-0.879, -0.477], rad: [3.15, 2.75], seat: -0.47 };

function paintMaterial(island, dayLedge = false) {
  const uniforms = Object.fromEntries([...SKY_UNIFORMS, 'uWorld', 'uHeightTex', 'uSplatTex', 'uLightTex']
    .map(name => [name, island.U[name]]));
  const { timeOfDay } = island;
  uniforms.uRockExposure = { value: timeOfDay === 'afternoon' ? 1 : timeOfDay === 'night' ? 0.38 : 0.49 };
  return new THREE.ShaderMaterial({
    name: 'cascade-ledge-stone', uniforms, vertexColors: true,
    vertexShader: /* glsl */ `
varying vec3 vStonePos, vStoneNormal, vStonePigment;
void main(){
  vec4 world = modelMatrix * vec4(position, 1.0);
  vStonePos = world.xyz;
  vStoneNormal = normalize(mat3(modelMatrix) * normal);
  vStonePigment = color.rgb;
  gl_Position = projectionMatrix * viewMatrix * world;
}`,
    fragmentShader: /* glsl */ `
varying vec3 vStonePos, vStoneNormal, vStonePigment;
uniform float uRockExposure;
${ATMOSPHERE}
${TERRAIN_LOOKUP}
void main(){
  vec3 n = normalize(vStoneNormal);
  float baked = texture(uLightTex, worldUV(vStonePos.xz)).r;
  float face = smoothstep(-0.23, 0.12, dot(n, uSunDir));
  float sun = mix(0.37, 1.0, baked) * face;
  vec3 light = mix(vec3(0.57, 0.66, 0.77), vec3(0.91, 0.91, 0.94), sun);
  float bed = vStonePos.y - vStonePos.x * 0.022 + 0.12 * sin(vStonePos.z * 0.73);
  float parting = smoothstep(0.74, 1.0, sin(bed * 7.0)) * (1.0 - max(n.y, 0.0));
  vec3 pigment = vStonePigment * (1.0 - 0.13 * parting);${dayLedge ? `
  // The embedded ledge shares the cliff's muted daylight limestone rather than the gravel's warmth.
  float stoneValue = dot(pigment, vec3(0.2126, 0.7152, 0.0722));
  pigment = mix(pigment, vec3(stoneValue), 0.52) * vec3(0.89, 0.85, 0.81);` : ''}
  vec3 stone = applyAtmosphere(pigment * light * uRockExposure, vStonePos);
  // The geometry supplies its own contours. Keep the post outline off the strata and wet toes.
  gl_FragColor = vec4(stone, 0.0);
}`,
  });
}

/** Adds the authored geomorphology as a visual layer over the upstream terrain and collisions. */
export async function addCascadeRocks(island) {
  const gltf = await new GLTFLoader().loadAsync(MODEL_URL.href);
  const material = paintMaterial(island);
  const ledgePaint = island.timeOfDay === 'afternoon' ? paintMaterial(island, true) : material;
  const group = new THREE.Group();
  group.name = 'cascade-rock-shelves';
  const { base } = island.river.fall;
  const placed = [];
  for (const shelf of [...CASCADE_ROCK_SHELVES, HIGH_LEDGE]) {
    const object = gltf.scene.getObjectByName(shelf.name);
    if (!object?.isMesh) throw new Error(`cascade shelf GLB is missing ${shelf.name}`);
    const x = base.x + shelf.offset[0], z = base.z + shelf.offset[1];
    const y = island.terrain.heightAt(x, z) + shelf.seat;
    object.position.set(x, y, z);
    object.rotation.y = Math.atan2(...shelf.outward);
    object.material = shelf === HIGH_LEDGE ? ledgePaint : material;
    object.userData.walkable = false;
    group.add(object);
    placed.push({ ...shelf, world: [x, y, z] });
  }
  island.root.add(group);
  return { group, shelves: placed.slice(0, CASCADE_ROCK_SHELVES.length), ledge: placed.at(-1) };
}
