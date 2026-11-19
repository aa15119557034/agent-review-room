import * as THREE from 'three';

// Art round 9 (#254 X-51): fake light pools under the lit door lamps. The lamps are unlit emissive boxes, so the
// walls around them stayed an even dark grey-green; the Zenless-style grade wants cold shade with a warm pool right
// under each lamp. Every lamp gets one wall patch (parallel to the wall, 0.015 m off it) and one floor patch on its
// corridor slab. All wall patches are one InstancedMesh, all floor patches another (two draw calls for the island).
// Additive, depth-tested, no depth/shadow, and the framebuffer alpha is left alone: toon.js keeps the outline coverage
// mask in alpha, so a patch must neither add a line nor change the mask of the wall under it.
// Strengths live in evening.json ("doorGlow"); the group only exists in the evening preset.

const VERT = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  vec4 p = vec4( position, 1.0 );
#ifdef USE_INSTANCING
  p = instanceMatrix * p;
#endif
  gl_Position = projectionMatrix * modelViewMatrix * p;
}`;

// uCenter / uRad are in uv units of the patch quad. uTop fades the last part of a wall patch below the slab above.
const FRAG = /* glsl */`
uniform vec3 uColor;
uniform float uStrength;
uniform vec2 uCenter;
uniform vec2 uRad;
uniform vec2 uFade;   // v fade start / end (1.0, 1.0 = none)
varying vec2 vUv;
void main() {
  float r = length( ( vUv - uCenter ) / uRad );
  float k = pow( 1.0 - smoothstep( 0.0, 1.0, r ), 1.6 );
  k *= 1.0 - smoothstep( uFade.x, uFade.y, vUv.y );
  gl_FragColor = vec4( uColor * ( uStrength * k ), 0.0 );
}`;

function makeMaterial(name, p, strength, center, rad, fade) {
  const m = new THREE.ShaderMaterial({
    name, vertexShader: VERT, fragmentShader: FRAG,
    uniforms: { uColor: { value: new THREE.Color(...p.color) }, uStrength: { value: strength },
      uCenter: { value: new THREE.Vector2(...center) }, uRad: { value: new THREE.Vector2(...rad) }, uFade: { value: new THREE.Vector2(...fade) } },
    transparent: true, depthTest: true, depthWrite: false, toneMapped: false, fog: false, side: THREE.DoubleSide,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendEquationAlpha: THREE.AddEquation,
    blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
    // Keep the destination alpha (outline coverage mask) exactly as the opaque pass left it.
    blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2,
  });
  return m;
}

export async function loadDoorGlow() {
  const json = await (await fetch(new URL('./evening.json', import.meta.url))).json();
  return json.doorGlow ?? null;
}

/** lamps: [{ lamp: [x,y,z] on the wall face, floor: y of the slab top, normal: [x,y,z] outward, slabDepth }] in `parent` space. */
export function addDoorGlow({ parent, lamps, params: p }) {
  const [ww, wh] = p.wallSize, drop = p.wallDrop, rad = p.floorRadius, off = p.wallOffset ?? 0.015;
  // Wall patch: quad spans the lamp-centred ellipse, but its top stops at the slab underside above (lamp + wallTop).
  const top = Math.min(wh / 2 - drop, p.wallTop), bottom = drop + wh / 2, qh = top + bottom;
  const wallMat = makeMaterial('door-glow:wall', p, p.wall, [0.5, (wh / 2) / qh], [0.5, (wh / 2) / qh], [1 - 0.28 / qh, 1]);
  // Floor patch: quad from the wall out to the slab edge, centre p.floorOut off the wall.
  const slab = Math.min(...lamps.map(l => l.slabDepth ?? 1.05));
  const floorMat = makeMaterial('door-glow:floor', p, p.floor, [0.5, p.floorOut / slab], [rad / (2 * rad), rad / slab], [0.8, 1]);
  const plane = new THREE.PlaneGeometry(1, 1);
  const wallMesh = new THREE.InstancedMesh(plane, wallMat, lamps.length);
  const floorMesh = new THREE.InstancedMesh(plane, floorMat, lamps.length);
  wallMesh.name = 'door-glow-wall'; floorMesh.name = 'door-glow-floor';
  const n = new THREE.Vector3(), pos = new THREE.Vector3(), q = new THREE.Quaternion(), qx = new THREE.Quaternion(), scale = new THREE.Vector3(), m = new THREE.Matrix4();
  const zAxis = new THREE.Vector3(0, 0, 1), negZ = new THREE.Vector3(0, 0, -1);
  const rotX = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
  lamps.forEach((l, i) => {
    n.fromArray(l.normal).setY(0).normalize();
    // wall: plane normal +z -> outward
    q.setFromUnitVectors(zAxis, n);
    pos.fromArray(l.lamp).addScaledVector(n, off);
    pos.y = l.lamp[1] - bottom + qh / 2;
    wallMesh.setMatrixAt(i, m.compose(pos, q, scale.set(ww, qh, 1)));
    // floor: plane normal +z -> up, plane +v -> outward (rotX sends +y to -z, then the yaw sends -z to n)
    q.setFromUnitVectors(negZ, n).multiply(rotX);
    pos.fromArray(l.lamp).addScaledVector(n, slab / 2); pos.y = l.floor + 0.012;
    floorMesh.setMatrixAt(i, m.compose(pos, q, scale.set(2 * rad, slab, 1)));
  });
  for (const mesh of [wallMesh, floorMesh]) {
    mesh.instanceMatrix.needsUpdate = true; mesh.castShadow = mesh.receiveShadow = false; mesh.frustumCulled = false;
    mesh.renderOrder = 2; mesh.userData.noDecal = true; mesh.userData.wbDoorGlow = true; mesh.userData.walkable = false;
  }
  const group = new THREE.Group(); group.name = 'door-glow'; group.add(wallMesh, floorMesh); parent.add(group);
  return {
    group, count: lamps.length, drawCalls: 2, params: p,
    setStrength: (wall = p.wall, floor = p.floor) => { wallMat.uniforms.uStrength.value = wall; floorMat.uniforms.uStrength.value = floor; },
    setEnabled: (on) => { group.visible = on; },
    dispose() { group.removeFromParent(); plane.dispose(); wallMat.dispose(); floorMat.dispose(); wallMesh.dispose(); floorMesh.dispose(); },
  };
}
