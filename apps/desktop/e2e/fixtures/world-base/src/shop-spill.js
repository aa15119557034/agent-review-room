import * as THREE from 'three';

// Art round 10 (#254 X-51): indoor light spilling out of lit shops onto the paving in front of the door. Every shop room
// registered in ctx.services.shopInteriors (round 26) and the laundromat (city-apartments.js) gets one horizontal patch:
// as wide as its street front, `depth` m out, strongest at the wall and smoothly gone at the far and side edges. One
// InstancedMesh (one draw call), additive, depth-tested, no depth write, and the framebuffer alpha (outline coverage mask,
// toon.js) is left alone, exactly as in door-glow.js. Strength and colours live in evening.json ("shopSpill"); evening only.
// The deck height is found with rays at build time so steps and kerbs do not leave the patch floating: it is laid at the
// door landing and cut short where the paving drops away.

const VERT = /* glsl */`
attribute vec2 aSize;
attribute vec2 aRange;
attribute vec3 aColor;
varying vec2 vUv;
varying vec2 vSize;
varying float vV;
varying vec3 vColor;
void main() {
  vUv = uv; vSize = aSize; vColor = aColor; vV = mix( aRange.x, aRange.y, uv.y );
  gl_Position = projectionMatrix * modelViewMatrix * ( instanceMatrix * vec4( position, 1.0 ) );
}`;
// v = 0 at the wall, 1 at the far edge. Sides fade over uEdge metres, the far side by (1 - smoothstep(v))^uPow.
const FRAG = /* glsl */`
uniform float uStrength, uPow, uEdge;
varying vec2 vUv;
varying vec2 vSize;
varying vec3 vColor;
varying float vV;
void main() {
  float along = pow( 1.0 - smoothstep( 0.0, 1.0, vV ), uPow );
  float e = max( uEdge, 1e-3 );
  float side = smoothstep( 0.0, e, vUv.x * vSize.x ) * smoothstep( 0.0, e, ( 1.0 - vUv.x ) * vSize.x );
  gl_FragColor = vec4( vColor * ( uStrength * along * side ), 0.0 );
}`;

export async function loadShopSpill() {
  const json = await (await fetch(new URL('./evening.json', import.meta.url))).json();
  return json.shopSpill ?? null;
}

/** Shop rooms (lot id + [x0,y0,z0,x1,y1,z1] in lot space, +z toward the street) -> fronts in station-root space. */
export function shopFrontsFromRooms(layout, rooms, p) {
  return rooms.map(({ lot: id, box }) => {
    const lot = layout.lotById(id), f = layout.lotFrame(lot), c = Math.cos(f.rotY), s = Math.sin(f.rotY);
    const ex = [c, -s], ez = [s, c], lz = box[5] + (p.wallOut ?? 0.25), lx = (box[0] + box[3]) / 2;
    return { center: [f.x + lx * ex[0] + lz * ez[0], f.y + box[1], f.z + lx * ex[1] + lz * ez[1]], normal: [ez[0], 0, ez[1]],
      width: box[3] - box[0], kind: lot.kind, name: id };
  });
}

/** Fronts are in parent space; `offset` is the parent's world position (rays are cast in world space). Lay the patch on the
 *  actual paving: rays go down from just above the room floor (so crates, signs and awnings are not hit) at 0.3 m steps out
 *  from the door; runs of equal height become one quad each, so a landing, a step and the pavement below are each covered
 *  at their own height and nothing floats. */
export function groundSpillFronts(fronts, roots, p, offset = new THREE.Vector3()) {
  const ray = new THREE.Raycaster(), down = new THREE.Vector3(0, -1, 0), o = new THREE.Vector3(), n = new THREE.Vector3(), t = new THREE.Vector3();
  const hit = (x, y, z) => {
    ray.set(o.set(x + offset.x, y + offset.y, z + offset.z), down); ray.far = 2.4;
    for (const h of ray.intersectObjects(roots, true)) {
      if (h.object.userData.wbDoorGlow || !h.face) continue;
      if (h.object.material?.transparent && h.object.material.depthWrite === false) continue;
      n.copy(h.face.normal).transformDirection(h.object.matrixWorld);
      if (n.y > 0.8) return h.point.y - offset.y;
    }
    return null;
  };
  const out = [], gap = p.step ?? 0.09, dd = 0.3;
  for (const f of fronts) {
    n.fromArray(f.normal); t.set(-n.z, 0, n.x);
    const hs = [];
    for (let d = dd / 2; d < p.depth; d += dd) {
      const ys = [-0.25, 0, 0.25].map(k => hit(f.center[0] + n.x * d + t.x * f.width * k, f.center[1] + p.rayLift, f.center[2] + n.z * d + t.z * f.width * k)).filter(y => y != null).sort((a, b) => a - b);
      hs.push({ d, y: ys.length ? ys[(ys.length - 1) >> 1] : null });
    }
    const runs = [];
    for (const s of hs) {
      if (s.y == null) break;
      const last = runs[runs.length - 1];
      if (last && Math.abs(s.y - last.prev) <= gap) { last.ys.push(s.y); last.prev = s.y; last.end = s.d + dd / 2; }
      else runs.push({ start: last ? last.end : 0, end: s.d + dd / 2, ys: [s.y], prev: s.y });
    }
    if (!runs.length) { out.push({ ...f, floor: f.center[1], d0: 0, d1: 1.0, total: p.depth, ray: 'none' }); continue; }
    for (const r of runs) out.push({ ...f, floor: r.ys.reduce((a, b) => a + b, 0) / r.ys.length, d0: r.start, d1: r.end, total: p.depth, ray: 'ok' });
  }
  return out;
}

export function addShopSpill({ parent, fronts, params: p }) {
  const plane = new THREE.PlaneGeometry(1, 1), n = fronts.length;
  const sizes = new Float32Array(n * 2), ranges = new Float32Array(n * 2), colors = new Float32Array(n * 3);
  const material = new THREE.ShaderMaterial({
    name: 'shop-spill', vertexShader: VERT, fragmentShader: FRAG,
    uniforms: { uStrength: { value: p.strength }, uPow: { value: p.falloff ?? 1.5 }, uEdge: { value: p.edge ?? 0.8 } },
    transparent: true, depthTest: true, depthWrite: false, toneMapped: false, fog: false, side: THREE.DoubleSide,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendEquationAlpha: THREE.AddEquation,
    blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
    blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2,
  });
  plane.setAttribute('aSize', new THREE.InstancedBufferAttribute(sizes, 2));
  plane.setAttribute('aRange', new THREE.InstancedBufferAttribute(ranges, 2));
  plane.setAttribute('aColor', new THREE.InstancedBufferAttribute(colors, 3));
  const mesh = new THREE.InstancedMesh(plane, material, n);
  mesh.name = 'shop-spill';
  const nv = new THREE.Vector3(), pos = new THREE.Vector3(), q = new THREE.Quaternion(), scale = new THREE.Vector3(), m = new THREE.Matrix4();
  const negZ = new THREE.Vector3(0, 0, -1), rotX = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
  fronts.forEach((f, i) => {
    nv.fromArray(f.normal).setY(0).normalize();
    q.setFromUnitVectors(negZ, nv).multiply(rotX);          // plane +v -> outward, normal up
    const len = f.d1 - f.d0;
    pos.fromArray(f.center).addScaledVector(nv, f.d0 + len / 2); pos.y = f.floor + 0.012;
    mesh.setMatrixAt(i, m.compose(pos, q, scale.set(f.width, len, 1)));
    sizes.set([f.width, len], i * 2); ranges.set([f.d0 / f.total, f.d1 / f.total], i * 2);
    colors.set(/^(konbini|laundry)$/.test(f.kind) ? p.cool : p.warm, i * 3);
  });
  mesh.instanceMatrix.needsUpdate = true; mesh.castShadow = mesh.receiveShadow = false; mesh.frustumCulled = false;
  mesh.renderOrder = 2; mesh.userData.noDecal = true; mesh.userData.wbDoorGlow = true; mesh.userData.wbShopSpill = true; mesh.userData.walkable = false;
  parent.add(mesh);
  return { mesh, fronts, count: n, drawCalls: 1, params: p,
    setStrength: (v = p.strength) => { material.uniforms.uStrength.value = v; },
    setEnabled: (on) => { mesh.visible = on; },
    dispose() { mesh.removeFromParent(); plane.dispose(); material.dispose(); mesh.dispose(); } };
}
