import * as THREE from 'three';

// Art round 10 (#254 X-51): indoor light spilling out of lit shops onto the paving in front of the door. Every shop room
// registered in ctx.services.shopInteriors (round 26, the laundromat since round 11) gets one horizontal patch:
// as wide as its street front, `depth` m out, strongest at the wall and smoothly gone at the far and side edges. One
// Mesh (one merged geometry, one draw call), additive, depth-tested, no depth write, and the framebuffer alpha (outline coverage mask,
// toon.js) is left alone, exactly as in door-glow.js. Strength and colours live in evening.json ("shopSpill"); evening only.
// The deck height is found with rays at build time so steps and kerbs do not leave the patch floating: it is laid at the
// door landing and cut short where the paving drops away.

const VERT = /* glsl */`
attribute vec2 aSpan;
attribute float aV;
attribute vec3 aColor;
varying float vV;
varying vec3 vColor;
varying vec2 vX;
void main() {
  vX = aSpan; vV = aV; vColor = aColor;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}`;
// v = 0 at the wall, 1 at the far edge. Sides fade over uEdge metres, the far side by (1 - smoothstep(v))^uPow.
const FRAG = /* glsl */`
uniform float uStrength, uPow, uEdge;
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
  const out = [], cell = p.cell ?? 0.25, lift = 0.020, maxStep = p.maxStep ?? 0.03;
  for (const f of fronts) {
    tris = trianglesNear(f);
    n.fromArray(f.normal); t.set(-n.z, 0, n.x);
    // One regular grid per front (cell m spacing), vertices shared between neighbouring cells so the patch is seamless. Every vertex takes
    // the paving height under it (+ lift). A triangle is kept only if its centroid's paving height matches the triangle's own plane within
    // maxStep, so slopes are followed, and the triangles bridging a step or kerb riser are dropped instead of floating. Rays start only
    // rayLift above the room floor, so tops of vending machines, crates and shelves are never taken for ground.
    const cols = Math.max(1, Math.ceil(f.width / cell)), cw = f.width / cols, rows = Math.max(1, Math.ceil(p.depth / cell)), rd = p.depth / rows;
    const nx = cols + 1, ny = rows + 1, pos = new Float32Array(nx * ny * 3), span = new Float32Array(nx * ny * 2), vv = new Float32Array(nx * ny);
    const ok = new Uint8Array(nx * ny), x0 = f.center[0] - t.x * f.width / 2, z0 = f.center[2] - t.z * f.width / 2;
    for (let j = 0; j < nx; j++) for (let i = 0; i < ny; i++) {
      const k = j * ny + i, d = i * rd, x = x0 + t.x * j * cw + n.x * d, z = z0 + t.z * j * cw + n.z * d, y = hit(x, f.center[1] + p.rayLift, z);
      if (y != null) { ok[k] = 1; pos.set([x, y + lift, z], k * 3); }
      span.set([j * cw, f.width], k * 2); vv[k] = i / rows;
    }
    const idx = [];
    const tri = (A, B, C) => {
      if (!ok[A] || !ok[B] || !ok[C]) return;
      const ya = pos[A * 3 + 1], yb = pos[B * 3 + 1], yc = pos[C * 3 + 1];
      const cxm = (pos[A * 3] + pos[B * 3] + pos[C * 3]) / 3, czm = (pos[A * 3 + 2] + pos[B * 3 + 2] + pos[C * 3 + 2]) / 3;
      const g = hit(cxm, f.center[1] + p.rayLift, czm);
      if (g == null || Math.abs((ya + yb + yc) / 3 - lift - g) > maxStep) return;
      idx.push(A, B, C);
    };
    for (let j = 0; j < cols; j++) for (let i = 0; i < rows; i++) {
      const a = j * ny + i, b = (j + 1) * ny + i, c = (j + 1) * ny + i + 1, e = j * ny + i + 1;
      // Split along the diagonal with the smaller height change, so a kerb edge is bridged as little as possible.
      if (Math.abs(pos[a * 3 + 1] - pos[c * 3 + 1]) <= Math.abs(pos[b * 3 + 1] - pos[e * 3 + 1])) { tri(a, b, c); tri(a, c, e); } else { tri(a, b, e); tri(b, c, e); }
    }
    out.push({ ...f, positions: pos, span, v: vv, index: idx, vertexCount: nx * ny, cols, rows, ray: 'ok' });
  }
  return out;
}

export function addShopSpill({ parent, fronts, params: p }) {
  const total = fronts.reduce((a, f) => a + f.vertexCount, 0), nIdx = fronts.reduce((a, f) => a + f.index.length, 0);
  const positions = new Float32Array(total * 3), spans = new Float32Array(total * 2), vs = new Float32Array(total), colors = new Float32Array(total * 3);
  const index = new Uint32Array(nIdx);
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
  // One merged geometry (one draw call): per front a shared-vertex grid, so neighbouring cells have no seam.
  let vo = 0, io = 0;
  for (const f of fronts) {
    positions.set(f.positions, vo * 3); spans.set(f.span, vo * 2); vs.set(f.v, vo);
    const col = /^(konbini|laundry)$/.test(f.kind) ? p.cool : p.warm;
    for (let k = 0; k < f.vertexCount; k++) colors.set(col, (vo + k) * 3);
    for (let k = 0; k < f.index.length; k++) index[io + k] = f.index[k] + vo;
    vo += f.vertexCount; io += f.index.length;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aSpan', new THREE.BufferAttribute(spans, 2));
  geometry.setAttribute('aV', new THREE.BufferAttribute(vs, 1));
  geometry.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  const mesh = new THREE.Mesh(geometry, material), n = fronts.length;
  mesh.name = 'shop-spill';
  mesh.castShadow = mesh.receiveShadow = false; mesh.frustumCulled = false;
  mesh.renderOrder = 2; mesh.userData.noDecal = true; mesh.userData.wbDoorGlow = true; mesh.userData.wbShopSpill = true; mesh.userData.walkable = false;
  parent.add(mesh);
  return { mesh, fronts, count: n, triangles: nIdx / 3, drawCalls: 1, params: p,
    setStrength: (v = p.strength) => { material.uniforms.uStrength.value = v; },
    setEnabled: (on) => { mesh.visible = on; },
    dispose() { mesh.removeFromParent(); geometry.dispose(); material.dispose(); } };
}
