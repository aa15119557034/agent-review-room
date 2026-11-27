import * as THREE from 'three';
import { ATMOSPHERE, NOISE, NOISE_TEX } from '../upstream/petalwake/src/shaders/common.js';
import { SKY_UNIFORMS } from '../upstream/petalwake/src/world/sky.js';

// Across the fall, downstream, height, half-width, half-height, and phase.
const PLUMES = [
  [-4.8, 2.7, 1.6, 4.5, 2.3, 1.1],
  [3.7, 3.1, 1.0, 4.8, 2.5, 2.5],
  [-1.4, 3.6, 2.5, 5.1, 3.2, 3.9],
  [0.8, 5.8, 1.2, 4.8, 2.4, 5.7],
  [-3.1, 1.5, 4.0, 3.2, 3.5, 7.1],
  [2.4, 1.4, 4.5, 3.0, 3.8, 8.4],
];

export function addCascadeMist(island) {
  const { base, dir } = island.river.fall;
  const centers = [], offsets = [], indices = [];
  for (const [across, ahead, y, width, height, phase] of PLUMES) {
    const i = centers.length / 3;
    const x = base.x + dir.x * ahead - dir.y * across;
    const z = base.z + dir.y * ahead + dir.x * across;
    for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      centers.push(x, base.y + y, z);
      offsets.push(u * width, v * height, u, v, phase);
    }
    indices.push(i, i + 1, i + 2, i, i + 2, i + 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(centers, 3));
  // These are per-vertex attributes on one mesh. All six cards share one draw.
  const cardData = new THREE.InterleavedBuffer(new Float32Array(offsets), 5);
  geometry.setAttribute('aCorner', new THREE.InterleavedBufferAttribute(cardData, 4, 0));
  geometry.setAttribute('aPhase', new THREE.InterleavedBufferAttribute(cardData, 1, 4));
  geometry.setIndex(indices);
  // The CPU only sees the card centers. Include the projected corners and drift.
  geometry.computeBoundingSphere();
  geometry.boundingSphere.radius += 7;

  const uniforms = Object.fromEntries([...SKY_UNIFORMS, 'uTime', 'uNoiseTex'].map(name => [name, island.U[name]]));
  const material = new THREE.ShaderMaterial({
    uniforms, transparent: true, depthWrite: false,
    vertexShader: `
attribute vec4 aCorner;
attribute float aPhase;
uniform float uTime;
varying vec2 vCorner;
varying float vPhase;
varying vec3 vWorld;
void main(){
  vCorner = aCorner.zw;
  vPhase = aPhase;
  vWorld = position;
  vec4 p = modelViewMatrix * vec4(position, 1.0);
  p.xy += aCorner.xy + vec2(sin(uTime * 0.93 + aPhase) * 0.39, sin(uTime * 1.48 + aPhase) * 0.5);
  gl_Position = projectionMatrix * p;
}`,
    fragmentShader: `
varying vec2 vCorner;
varying float vPhase;
varying vec3 vWorld;
uniform float uTime;
${NOISE}
${NOISE_TEX}
${ATMOSPHERE}
void main(){
  vec2 p = vCorner;
  float volume = ntex(p * vec2(26.0, 34.0) + vec2(vPhase * 17.0, -uTime * 9.0)).r;
  float billows = ntex(p * 69.0 + vec2(uTime * 6.0, vPhase * 31.0 - uTime * 12.0)).g;
  float edge = 1.0 - smoothstep(0.33, 1.0, length(p) + (volume - 0.5) * 0.40);
  float alpha = edge * smoothstep(0.34, 0.74, volume * 0.74 + billows * 0.26) * 0.71;
  alpha *= (1.0 - smoothstep(0.83, 1.0, abs(p.x))) * (1.0 - smoothstep(0.8, 1.0, abs(p.y)));
  vec3 light = vec3(0.90, 0.95, 1.0) * (uSunColor * 0.22 + uAmbSky * 0.83);
  gl_FragColor = vec4(applyAtmosphere(light, vWorld), alpha);
}`,
  });
  const mist = new THREE.Mesh(geometry, material);
  mist.name = 'cascade-plunge-mist';
  mist.renderOrder = 15;
  island.river.group.add(mist);
}
