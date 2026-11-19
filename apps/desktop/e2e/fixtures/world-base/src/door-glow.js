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
varying vec2 vSize;
#ifdef USE_INSTANCING
attribute vec2 aSize;
attribute vec2 aEdge;
#endif
void main() {
  vUv = uv;
  vSize = vec2( 1.0 );
  vec4 p = vec4( position, 1.0 );
#ifdef USE_INSTANCING
  p = instanceMatrix * p;
  vSize = aSize;
  vEdge = aEdge;
#endif
  gl_Position = projectionMatrix * modelViewMatrix * p;
}`;

// Wall patch: uCenter / uRad in uv units of the quad. Floor patch (FLOOR): the quad is aSize metres, the wall edge is v = 0
// and the pool centre sits uFloorOut metres off the wall. uFade fades the far part of the quad (v) to nothing.
const FRAG = /* glsl */`
uniform vec3 uColor;
uniform float uStrength, uPow;
uniform vec2 uCenter;
uniform vec2 uRad;
uniform vec2 uFade;
uniform float uFloorOut;
varying vec2 vUv;
varying vec2 vSize;
varying vec2 vEdge;
void main() {
#ifdef FLOOR
  vec2 pm = ( vUv - vec2( 0.5, 0.0 ) ) * vSize - vec2( 0.0, uFloorOut );
  float r = length( pm / uRad );
  // deck ends along the wall (metres from the lamp): gone within 0.15 m of the edge, so nothing hangs over the drop
  float xm = ( vUv.x - 0.5 ) * vSize.x;
  float edge = smoothstep( 0.0, 0.15, xm - vEdge.x ) * smoothstep( 0.0, 0.15, vEdge.y - xm );
#else
  float r = length( ( vUv - uCenter ) / uRad );
#endif
  float k = pow( 1.0 - smoothstep( 0.0, 1.0, r ), uPow );
  k *= 1.0 - smoothstep( uFade.x, uFade.y, vUv.y );
#ifdef FLOOR
  k *= edge;
#endif
  gl_FragColor = vec4( uColor * ( uStrength * k ), 0.0 );
}`;

function makeMaterial(name, p, strength, center, rad, fade, floor = false) {
  const m = new THREE.ShaderMaterial({
    name, vertexShader: VERT, fragmentShader: FRAG, defines: floor ? { FLOOR: '' } : {},
    uniforms: { uColor: { value: new THREE.Color(...p.color) }, uStrength: { value: strength }, uPow: { value: p.falloff ?? 1.6 },
      uCenter: { value: new THREE.Vector2(...center) }, uRad: { value: new THREE.Vector2(...rad) }, uFade: { value: new THREE.Vector2(...fade) },
      uFloorOut: { value: p.floorOut ?? 0.4 } },
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

/** Lamp registrations (apartment corridor lamps, and ctx.services.doorLamps from the upstream generators) -> `parent` space.
 *  Entry: { lamp: [x,y,z] on the wall face, floor: y of the deck (or null), normal: outward, slabDepth, object? }. With `object`
 *  the numbers are in that Object3D's local space (floor is then a local y); without, they already are in parent space. */
export function resolveDoorLamps(parent, entries) {
  parent.updateWorldMatrix(true, false);
  const out = [], seen = new Set(), v = new THREE.Vector3(), n = new THREE.Vector3();
  for (const e of entries) {
    let lamp, floor, normal;
    if (e.object) {
      e.object.updateWorldMatrix(true, false);
      const m = e.object.matrixWorld;
      lamp = parent.worldToLocal(v.fromArray(e.lamp).applyMatrix4(m)).toArray();
      floor = e.floor == null ? null : parent.worldToLocal(v.set(e.lamp[0], e.floor, e.lamp[2]).applyMatrix4(m)).y;
      normal = n.fromArray(e.normal).transformDirection(m).transformDirection(new THREE.Matrix4().copy(parent.matrixWorld).invert()).toArray();
    } else { lamp = e.lamp; floor = e.floor; normal = e.normal; }
    const tangent = e.tangent && !e.object ? e.tangent : null;
    const key = lamp.map(x => Math.round(x * 50)).join(',');
    if (seen.has(key)) continue; seen.add(key);
    out.push({ lamp, floor, normal, slabDepth: e.slabDepth ?? 1.0, slabSide: e.slabSide && tangent ? e.slabSide : null, tangent });
  }
  return out;
}

export function addDoorGlow({ parent, lamps, params: p }) {
  const [ww, wh] = p.wallSize, drop = p.wallDrop, rad = p.floorRadius, off = p.wallOffset ?? 0.015;
  // Wall patch: quad spans the lamp-centred ellipse, but its top stops at the slab underside above (lamp + wallTop).
  const top = Math.min(wh / 2 - drop, p.wallTop), bottom = drop + wh / 2, qh = top + bottom;
  const wallMat = makeMaterial('door-glow:wall', p, p.wall, [0.5, (wh / 2) / qh], [0.5, (wh / 2) / qh], [1 - 0.28 / qh, 1]);
  // Floor patch: quad from the wall out to the slab edge (per lamp), pool centre p.floorOut off the wall.
  const floorMat = makeMaterial('door-glow:floor', p, p.floor, [0, 0], [rad, rad], [0.8, 1], true);
  const plane = new THREE.PlaneGeometry(1, 1);
  const wallMesh = new THREE.InstancedMesh(plane, wallMat, lamps.length);
  const floorMesh = new THREE.InstancedMesh(plane, floorMat, lamps.length);
  const floorEdge = new Float32Array(lamps.length * 2), floorSize = new Float32Array(lamps.length * 2).fill(1), wallSize = new Float32Array(lamps.length * 2).fill(1);
  wallMesh.name = 'door-glow-wall'; floorMesh.name = 'door-glow-floor';
  for (let i = 0; i < lamps.length; i++) { floorEdge[i * 2] = -1e4; floorEdge[i * 2 + 1] = 1e4; }
  const n = new THREE.Vector3(), pos = new THREE.Vector3(), q = new THREE.Quaternion(), scale = new THREE.Vector3(), m = new THREE.Matrix4();
  const zAxis = new THREE.Vector3(0, 0, 1), negZ = new THREE.Vector3(0, 0, -1);
  const rotX = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
  lamps.forEach((l, i) => {
    n.fromArray(l.normal).setY(0).normalize();
    q.setFromUnitVectors(zAxis, n);
    pos.fromArray(l.lamp).addScaledVector(n, off);
    pos.y = l.lamp[1] - bottom + qh / 2;
    wallMesh.setMatrixAt(i, m.compose(pos, q, scale.set(ww, qh, 1)));
    if (l.floor == null) { floorMesh.setMatrixAt(i, m.makeScale(0, 0, 0)); return; }
    const slab = l.slabDepth;
    q.setFromUnitVectors(negZ, n).multiply(rotX);
    pos.fromArray(l.lamp).addScaledVector(n, slab / 2); pos.y = l.floor + 0.012;
    floorMesh.setMatrixAt(i, m.compose(pos, q, scale.set(2 * rad, slab, 1)));
    floorSize[i * 2] = 2 * rad; floorSize[i * 2 + 1] = slab;
    // The floor quad's +x runs along (-n.z, 0, n.x); the registered ends are along `tangent`.
    if (l.slabSide && l.tangent) { const sgn = Math.sign(l.tangent[0] * -n.z + l.tangent[2] * n.x) || 1; floorEdge.set(sgn > 0 ? l.slabSide : [-l.slabSide[1], -l.slabSide[0]], i * 2); }
  });
  floorMesh.geometry = plane.clone(); wallMesh.geometry = plane.clone();
  floorMesh.geometry.setAttribute('aSize', new THREE.InstancedBufferAttribute(floorSize, 2));
  floorMesh.geometry.setAttribute('aEdge', new THREE.InstancedBufferAttribute(floorEdge, 2));
  wallMesh.geometry.setAttribute('aEdge', new THREE.InstancedBufferAttribute(new Float32Array(lamps.length * 2), 2));
  wallMesh.geometry.setAttribute('aSize', new THREE.InstancedBufferAttribute(wallSize, 2));
  plane.dispose();
  for (const mesh of [wallMesh, floorMesh]) {
    mesh.instanceMatrix.needsUpdate = true; mesh.castShadow = mesh.receiveShadow = false; mesh.frustumCulled = false;
    mesh.renderOrder = 2; mesh.userData.noDecal = true; mesh.userData.wbDoorGlow = true; mesh.userData.walkable = false;
  }
  const group = new THREE.Group(); group.name = 'door-glow'; group.add(wallMesh, floorMesh); parent.add(group);
  return {
    group, lamps, count: lamps.length, drawCalls: 2, params: p,
    setStrength: (wall = p.wall, floor = p.floor) => { wallMat.uniforms.uStrength.value = wall; floorMat.uniforms.uStrength.value = floor; },
    setEnabled: (on) => { group.visible = on; },
    dispose() { group.removeFromParent(); wallMesh.geometry.dispose(); floorMesh.geometry.dispose(); wallMat.dispose(); floorMat.dispose(); wallMesh.dispose(); floorMesh.dispose(); },
  };
}
