import * as THREE from 'three';

// Art round 10 (#254 X-51): indoor light spilling out of lit shops onto the paving in front of the door. Every shop room
// registered in ctx.services.shopInteriors (round 26, the laundromat since round 11) gets one horizontal patch:
// as wide as its street front, `depth` m out, strongest at the wall and smoothly gone at the far and side edges. One
// InstancedMesh (one draw call), additive, depth-tested, no depth write, and the framebuffer alpha (outline coverage mask,
// toon.js) is left alone, exactly as in door-glow.js. Strength and colours live in evening.json ("shopSpill"); evening only.
// The deck height is found with rays at build time so steps and kerbs do not leave the patch floating: it is laid at the
// door landing and cut short where the paving drops away.

const VERT = /* glsl */`
attribute vec2 aSize;
attribute vec2 aRange;
attribute vec2 aSpan;
attribute vec3 aColor;
varying vec2 vUv;
varying vec2 vSize;
varying float vV;
varying vec3 vColor;
varying vec2 vX;
void main() {
  vX = vec2( aSpan.x + uv.x * aSize.x, aSpan.y );
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
varying vec2 vX;
void main() {
  float along = pow( 1.0 - smoothstep( 0.0, 1.0, vV ), uPow );
  float e = max( uEdge, 1e-3 );
  float side = smoothstep( 0.0, e, vX.x ) * smoothstep( 0.0, e, vX.y - vX.x );
  gl_FragColor = vec4( vColor * ( uStrength * along * side ), 0.0 );
}`;

export async function loadShopSpill() {
  const json = await (await fetch(new URL('./evening.json', import.meta.url))).json();
  return json.shopSpill ?? null;
}

/** Shop rooms (lot id + [x0,y0,z0,x1,y1,z1] in lot space, +z toward the street) -> fronts in station-root space. */
export function shopFrontsFromRooms(layout, rooms, p) {
  return rooms.map(({ lot: id, frame, name, kind: roomKind, box }) => {
    const lot = frame ? null : layout.lotById(id), f = frame ?? layout.lotFrame(lot), c = Math.cos(f.rotY), s = Math.sin(f.rotY);
    const ex = [c, -s], ez = [s, c], lz = box[5] + (p.wallOut ?? 0.25), lx = (box[0] + box[3]) / 2;
    return { center: [f.x + lx * ex[0] + lz * ez[0], f.y + box[1], f.z + lx * ex[1] + lz * ez[1]], normal: [ez[0], 0, ez[1]],
      width: box[3] - box[0], kind: roomKind ?? lot.kind, name: name ?? id };
  });
}

/** Fronts are in parent space; `offset` is the parent's world position (rays are cast in world space). Lay the patch on the
 *  actual paving: rays go down from just above the room floor (so crates, signs and awnings are not hit) at 0.3 m steps out
 *  from the door; runs of equal height become one quad each, so a landing, a step and the pavement below are each covered
 *  at their own height and nothing floats. */
export function groundSpillFronts(fronts, roots, p, offset = new THREE.Vector3()) {
  const n = new THREE.Vector3(), t = new THREE.Vector3();
  const meshes = [];
  for (const r of roots) { r.updateWorldMatrix(true, true); r.traverse(o => {
    if (!o.isMesh || o.isInstancedMesh || o.isSkinnedMesh || o.userData.wbDoorGlow || !o.geometry.attributes.position) return;
    const m = o.material; if (m && !Array.isArray(m) && m.transparent && m.depthWrite === false) return;
    meshes.push(o);
  }); }
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), nn = new THREE.Vector3();
  /** Up-facing triangles (projected to xz, with their plane) near one front, in parent space. */
  const trianglesNear = (f) => {
    const reach = f.width / 2 + p.depth + 1.5, x0 = f.center[0] - reach, x1 = f.center[0] + reach, z0 = f.center[2] - reach, z1 = f.center[2] + reach;
    const y0 = f.center[1] - 2, y1 = f.center[1] + 1.2, out = [];
    for (const o of meshes) {
      const g = o.geometry; if (!g.boundingBox) g.computeBoundingBox();
      const bb = new THREE.Box3().copy(g.boundingBox).applyMatrix4(o.matrixWorld);
      if (bb.max.x - offset.x < x0 || bb.min.x - offset.x > x1 || bb.max.z - offset.z < z0 || bb.min.z - offset.z > z1 || bb.max.y - offset.y < y0 || bb.min.y - offset.y > y1) continue;
      const pos = g.attributes.position, idx = g.index, count = idx ? idx.count : pos.count, mw = o.matrixWorld;
      for (let i = 0; i < count; i += 3) {
        const ia = idx ? idx.getX(i) : i, ib = idx ? idx.getX(i + 1) : i + 1, ic = idx ? idx.getX(i + 2) : i + 2;
        a.fromBufferAttribute(pos, ia).applyMatrix4(mw).sub(offset); b.fromBufferAttribute(pos, ib).applyMatrix4(mw).sub(offset); c.fromBufferAttribute(pos, ic).applyMatrix4(mw).sub(offset);
        if (Math.max(a.x, b.x, c.x) < x0 || Math.min(a.x, b.x, c.x) > x1 || Math.max(a.z, b.z, c.z) < z0 || Math.min(a.z, b.z, c.z) > z1) continue;
        if (Math.min(a.y, b.y, c.y) > y1 || Math.max(a.y, b.y, c.y) < y0) continue;
        nn.crossVectors(e1.subVectors(b, a), e2.subVectors(c, a));
        if (nn.y <= 0.8 * nn.length() || nn.y < 1e-9) continue;       // up-facing only (winding-independent for the common +y case)
        out.push([a.x, a.z, a.y, b.x, b.z, b.y, c.x, c.z, c.y]);
      }
    }
    return out;
  };
  let tris = [];
  const hit = (x, y, z) => {
    let best = null;
    for (const T of tris) {
      const d = (T[3] - T[0]) * (T[7] - T[1]) - (T[6] - T[0]) * (T[4] - T[1]); if (Math.abs(d) < 1e-9) continue;
      const u = ((x - T[0]) * (T[7] - T[1]) - (T[6] - T[0]) * (z - T[1])) / d, v = ((T[3] - T[0]) * (z - T[1]) - (x - T[0]) * (T[4] - T[1])) / d;
      if (u < -1e-4 || v < -1e-4 || u + v > 1 + 1e-4) continue;
      const h = T[2] + u * (T[5] - T[2]) + v * (T[8] - T[2]);
      if (h <= y && (best == null || h > best)) best = h;
    }
    return best;
  };
  const out = [], cell = p.cell ?? 0.25;
  for (const f of fronts) {
    tris = trianglesNear(f);
    n.fromArray(f.normal); t.set(-n.z, 0, n.x);
    // The patch is cut into small flat cells, each laid at the paving height under its centre (lamp field stays one continuous function
    // of the whole front: x along the front, v from the wall, see aSpan / aRange), so slopes and steps are followed without a big flat
    // plane being clipped by the ground in an oblique line. Rays start only rayLift above the room floor, so tops of vending
    // machines, crates and shelves are never taken for ground.
    const cols = Math.max(1, Math.ceil(f.width / cell)), cw = f.width / cols, rows = Math.max(1, Math.ceil(p.depth / cell)), rd = p.depth / rows;
    for (let j = 0; j < cols; j++) {
      const off = (j + 0.5) * cw - f.width / 2, cx = f.center[0] + t.x * off, cz = f.center[2] + t.z * off;
      for (let i = 0; i < rows; i++) {
        const d = (i + 0.5) * rd, y = hit(cx + n.x * d, f.center[1] + p.rayLift, cz + n.z * d);
        if (y == null) continue;
        out.push({ ...f, center: [cx, f.center[1], cz], width: cw, x0: j * cw, totalW: f.width, floor: y + 0.008, d0: i * rd, d1: (i + 1) * rd, total: p.depth, ray: 'ok' });
      }
    }
  }
  return out;
}

export function addShopSpill({ parent, fronts, params: p }) {
  const plane = new THREE.PlaneGeometry(1, 1), n = fronts.length;
  const sizes = new Float32Array(n * 2), ranges = new Float32Array(n * 2), spans = new Float32Array(n * 2), colors = new Float32Array(n * 3);
  const material = new THREE.ShaderMaterial({
    name: 'shop-spill', vertexShader: VERT, fragmentShader: FRAG,
    uniforms: { uStrength: { value: p.strength }, uPow: { value: p.falloff ?? 1.5 }, uEdge: { value: p.edge ?? 0.8 } },
    transparent: true, depthTest: true, depthWrite: false, toneMapped: false, fog: false, side: THREE.DoubleSide,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendEquationAlpha: THREE.AddEquation,
    // Additive. Screen blend (OneMinusDstColor) was tried in r10b and does nothing here: the scene target is HDR and lit paving
    // is above 1, so (1 - dst) goes to zero or negative. Whitening is limited by low strength and by laying the patch on the real paving.
    blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
    blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2,
  });
  plane.setAttribute('aSize', new THREE.InstancedBufferAttribute(sizes, 2));
  plane.setAttribute('aRange', new THREE.InstancedBufferAttribute(ranges, 2));
  plane.setAttribute('aSpan', new THREE.InstancedBufferAttribute(spans, 2));
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
    sizes.set([f.width, len], i * 2); ranges.set([f.d0 / f.total, f.d1 / f.total], i * 2); spans.set([f.x0, f.totalW], i * 2);
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
