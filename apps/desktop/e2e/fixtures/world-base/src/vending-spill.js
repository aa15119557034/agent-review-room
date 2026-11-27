import * as THREE from 'three';
import { groundSpillFronts } from './shop-spill.js';

const deck = { depth: 1.45, cell: 0.18, rayLift: 0.35 };
const width = 1.85;
const plinthClearance = 0.12;
const cabinetContact = -0.055;       // fade starts just under the cabinet's leading edge
const wallReach = 2.15;
const offset = 0.012;

/** A single additive pass for near-machine spill. Paving follows existing floor samples;
 * wall vertices are attached to an actual nearby face and dropped at open edges. */
export function addVendingSpill({ parent, machines, station, city, town, terrain, surfaceAt, strength }) {
  const positions = [], falloff = [], scales = [], coverage = [], heightDelta = [];
  function append(vertices, coordinates, faces, amount, support, baseY = null) {
    for (const i of faces) {
      positions.push(...vertices[i]);
      falloff.push(...coordinates[i]);
      scales.push(amount);
      coverage.push(support ? support[i] : 1);
      heightDelta.push(baseY === null ? 0 : vertices[i][1] - offset - baseY);
    }
  }

  // Reuse the station spill's height tests so vends at kerbs and platform edges
  // don't throw a patch across the drop.
  const stationRoots = [station.root, city?.root].filter(Boolean);
  const fronts = machines.filter(m => m.station).map(m => {
    const p = m.source.clone().addScaledVector(m.forward, plinthClearance);
    return { center: [p.x, m.baseY, p.z], normal: m.forward.toArray(), width };
  });
  const floors = groundSpillFronts(fronts, stationRoots, deck);
  let groundPatches = 0;
  for (const f of floors) {
    if (!f.index.length) continue;
    const vertices = [], coordinates = [];
    for (let i = 0; i < f.vertexCount; i++) {
      vertices.push(f.positions.subarray(i * 3, i * 3 + 3));
      coordinates.push([f.span[i * 2] * 2 / width - 1, f.v[i]]);
    }
    append(vertices, coordinates, f.index, 1, surfaceCoverage(f.vertexCount, f.index));
    groundPatches++;
  }
  for (const m of machines) {
    if (m.station) continue;
    if (m.terrainFloor && terrain.material.uniforms.uWorld.value.w === 0) {
      const patch = terrainFloor(m, terrain);
      if (!patch.faces.length) continue;
      append(patch.vertices, patch.coordinates, patch.faces, 1, null, m.baseY);
      groundPatches++;
      continue;
    }
    const right = new THREE.Vector3(m.forward.z, 0, -m.forward.x);
    const grid = sampleGrid(10, 8, (u, v) => {
      const p = m.source.clone().addScaledVector(right, u * width / 2).addScaledVector(m.forward, cabinetContact + v * deck.depth);
      p.y = surfaceAt(p.x, p.z, m.baseY);
      return Math.abs(p.y - m.baseY) < 0.75 ? p.addScaledVector(THREE.Object3D.DEFAULT_UP, offset).toArray() : null;
    });
    if (!grid.faces.length) continue;
    const support = surfaceCoverage(grid.vertices.length, grid.faces);
    append(grid.vertices, grid.coordinates, grid.faces, 1, support, m.baseY);
    groundPatches++;
  }

  const rootList = [...stationRoots, town.group];
  const targets = [];
  for (const root of rootList) {
    root.updateWorldMatrix(true, true);
    root.traverseVisible(mesh => {
      if (!mesh.isMesh || mesh.isInstancedMesh || mesh.userData.noDecal || Array.isArray(mesh.material) ||
          mesh.material.transparent || mesh.material.isMeshBasicMaterial) return;
      const geometry = mesh.geometry;
      if (!geometry.boundingBox) geometry.computeBoundingBox();
      targets.push({ mesh, box: geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld) });
    });
  }
  const ray = new THREE.Raycaster(), near = new THREE.Box3();
  const stationMachines = machines.filter(m => m.station);
  const casingHit = (p) => stationMachines.some(m => {
    const x = p.x - m.source.x, z = p.z - m.source.z, depth = x * m.forward.x + z * m.forward.z;
    const side = x * m.forward.z - z * m.forward.x;
    return p.y >= m.baseY - 0.05 && p.y <= m.baseY + 1.85 && Math.abs(side) <= 0.53 && depth >= -0.78 && depth <= 0.05;
  });
  const normalOf = hit => hit.face.normal.clone().applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld));
  let wallPatches = 0;
  for (const m of machines) {
    const right = new THREE.Vector3(m.forward.z, 0, -m.forward.x);
    near.setFromCenterAndSize(m.source, new THREE.Vector3(6, 2.4, 6));
    const local = targets.filter(t => t.box.intersectsBox(near));
    for (const side of [-1, 1]) {
      const origin = m.source.clone().addScaledVector(right, side * 0.68).addScaledVector(m.forward, m.station ? 0.04 : 0);
      // Check the backing and the side wall around the casing flank. The first
      // surface on a ray occludes anything behind it.
      const directions = m.station ? [[-1, 0.25], [-0.55, 1], [-0.18, 1], [0.12, 1]] : [[-1, 0.25], [-0.18, 1]];
      const reach = m.station ? 2.55 : wallReach;
      // The opaque south pier is recessed beside W1's display. A shallow ray
      // passes over the standalone bins on its way to that facade.
      if (m.stationId === 'V3a' && side === -1) directions.push([-1, 0.10, -0.09, 3.0]);
      let nearest = null;
      for (const [back, out, down = 0, range = reach] of directions) {
        const direction = m.forward.clone().multiplyScalar(back).addScaledVector(right, side * out).setY(down).normalize();
        ray.set(origin, direction);
        ray.far = Math.min(nearest?.hit.distance ?? range, range);
        const hit = ray.intersectObjects(local.filter(t => ray.ray.intersectsBox(t.box)).map(t => t.mesh), false)[0];
        if (!hit?.face || (m.station && casingHit(hit.point))) continue;
        const normal = normalOf(hit);
        if (Math.abs(normal.y) <= 0.2 && normal.dot(direction) <= -0.5) nearest = { hit, normal, range };
      }
      if (nearest) {
        const patch = wallSurface(nearest.hit, nearest.normal);
        if (!patch.faces.length) continue;
        append(patch.vertices, patch.coordinates, patch.faces, 0.66 * (1 - nearest.hit.distance / (nearest.range + 0.15)));
        wallPatches++;
      }
    }
  }

  if (!positions.length) return { mesh: null, groundPatches, wallPatches, triangles: 0 };
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('aFalloff', new THREE.Float32BufferAttribute(falloff, 2));
  geometry.setAttribute('aScale', new THREE.Float32BufferAttribute(scales, 1));
  geometry.setAttribute('aCoverage', new THREE.Float32BufferAttribute(coverage, 1));
  geometry.setAttribute('aHeightDelta', new THREE.Float32BufferAttribute(heightDelta, 1));
  const material = new THREE.ShaderMaterial({
    name: 'vending-spill',
    uniforms: { uColor: { value: new THREE.Color('#b7e9ff') }, uStrength: { value: strength } },
    vertexShader: /* glsl */`
      attribute vec2 aFalloff;
      attribute float aScale;
      attribute float aCoverage;
      attribute float aHeightDelta;
      varying vec2 vFalloff;
      varying float vScale;
      varying float vCoverage;
      varying float vHeightDelta;
      varying vec3 vWorldPosition;
      void main() {
        vFalloff = aFalloff; vScale = aScale; vCoverage = aCoverage;
        vHeightDelta = aHeightDelta;
        vWorldPosition = ( modelMatrix * vec4( position, 1.0 ) ).xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uColor;
      uniform float uStrength;
      varying vec2 vFalloff;
      varying float vScale;
      varying float vCoverage;
      varying float vHeightDelta;
      varying vec3 vWorldPosition;
      void main() {
        float edge = 1.0 - smoothstep( 0.0, 1.0, length( vFalloff ) );
        float floorNearFade = mix( 1.0, smoothstep( 0.0, 0.12, vFalloff.y ), step( 0.999, vScale ) );
        float support = smoothstep( 0.0, 1.0, vCoverage );
        float slopeFade = 1.0 - smoothstep( 0.30, 0.75, abs( vHeightDelta ) );
        float close = 1.0 - smoothstep( 24.0, 52.0, distance( cameraPosition, vWorldPosition ) );
        gl_FragColor = vec4( uColor * ( uStrength * vScale * edge * edge * support * floorNearFade * slopeFade * close ), 0.0 );
      }`,
    transparent: true, depthTest: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendEquationAlpha: THREE.AddEquation,
    blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
    // Preserve the same outline-coverage alpha as the existing shop spill.
    blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'vending-spill';
  mesh.renderOrder = 2;
  mesh.userData.noDecal = true;
  mesh.userData.walkable = false;
  parent.add(mesh);
  return { mesh, groundPatches, wallPatches, triangles: positions.length / 9 };
}

/** At walking distance, the upstream terrain draws its texel-centred, level-0
 * triangles with alternating diagonals. Project onto those planes so a light
 * pool crosses the paved/grass texture seam without intersecting the terrain. */
function terrainFloor(m, terrain) {
  const center = m.source.clone().addScaledVector(m.forward, cabinetContact);
  const right = new THREE.Vector3(m.forward.z, 0, -m.forward.x);
  const cell = terrain.cell, first = (cell - terrain.meta.world) / 2;
  const reach = Math.hypot(width / 2, deck.depth);
  const gridIndex = value => Math.floor((value - first) / cell);
  const vertices = [], coordinates = [], faces = [];
  const sample = (ix, iz) => {
    const x = first + ix * cell, z = first + iz * cell;
    const dx = x - center.x, dz = z - center.z;
    return [(dx * right.x + dz * right.z) * 2 / width,
      (dx * m.forward.x + dz * m.forward.z) * 2 / deck.depth - 1, x, terrain.heightAt(x, z), z];
  };
  for (let z = gridIndex(center.z - reach); z <= gridIndex(center.z + reach); z++) {
    for (let x = gridIndex(center.x - reach); x <= gridIndex(center.x + reach); x++) {
      const a = sample(x, z), b = sample(x + 1, z), c = sample(x, z + 1), d = sample(x + 1, z + 1);
      const triangles = (x + z) & 1 ? [[a, c, b], [b, c, d]] : [[a, c, d], [a, d, b]];
      for (let polygon of triangles) {
        for (const axis of [0, 1]) for (const edge of [-1, 1]) polygon = clip(polygon, axis, edge);
        const base = vertices.length;
        for (const [u, v, wx, y, wz] of polygon) {
          vertices.push([wx, y + offset, wz]);
          coordinates.push([u, (v + 1) / 2]);
        }
        for (let i = 2; i < polygon.length; i++) faces.push(base, base + i - 1, base + i);
      }
    }
  }
  return { vertices, coordinates, faces };
}

/** At a kerb, an omitted triangle exposes a new boundary inside the floor grid.
 * Fade to zero over the neighbouring triangles so support cuts never become light edges. */
function surfaceCoverage(vertexCount, faces) {
  const used = new Map();
  for (let i = 0; i < faces.length; i += 3) {
    const a = faces[i], b = faces[i + 1], c = faces[i + 2];
    for (const [p, q] of [[a, b], [b, c], [c, a]]) {
      const key = Math.min(p, q) * vertexCount + Math.max(p, q);
      used.set(key, (used.get(key) ?? 0) + 1);
    }
  }
  const support = new Float32Array(vertexCount).fill(1);
  for (const [key, count] of used) if (count === 1) {
    support[Math.floor(key / vertexCount)] = support[key % vertexCount] = 0;
  }
  return support;
}

/** Use the face hit by the visibility ray as a projection plane. Clipping the original
 * coplanar triangles conforms to corners and door openings without casting a ray per vertex. */
function wallSurface(hit, normal) {
  const { geometry, matrixWorld } = hit.object, positions = geometry.attributes.position;
  const along = new THREE.Vector3().crossVectors(THREE.Object3D.DEFAULT_UP, normal).normalize();
  const up = new THREE.Vector3().crossVectors(normal, along);
  const center = hit.point.clone().addScaledVector(normal, offset);
  const plane = new THREE.Vector3().copy(normal).applyMatrix3(new THREE.Matrix3().setFromMatrix4(matrixWorld).transpose());
  const localCenter = hit.point.clone().applyMatrix4(matrixWorld.clone().invert());
  const vertices = [], coordinates = [], faces = [], point = new THREE.Vector3();
  const count = geometry.index?.count ?? positions.count;
  for (let k = 0; k < count; k += 3) {
    const tri = [];
    for (let j = 0; j < 3; j++) {
      point.fromBufferAttribute(positions, geometry.index ? geometry.index.getX(k + j) : k + j);
      if (Math.abs(point.sub(localCenter).dot(plane)) > 0.015) break;
      point.add(localCenter).applyMatrix4(matrixWorld).sub(hit.point);
      tri.push([point.dot(along) / 0.7, point.dot(up) / 0.7]);
    }
    if (tri.length !== 3) continue;
    let poly = tri;
    for (const axis of [0, 1]) for (const edge of [-1, 1]) poly = clip(poly, axis, edge);
    if (poly.length < 3) continue;
    const base = vertices.length;
    for (const [u, v] of poly) {
      vertices.push(center.clone().addScaledVector(along, u * 0.7).addScaledVector(up, v * 0.7).toArray());
      coordinates.push([u, v]);
    }
    for (let i = 2; i < poly.length; i++) faces.push(base, base + i - 1, base + i);
  }
  return { vertices, coordinates, faces };
}

function clip(polygon, axis, edge) {
  if (!polygon.length) return polygon;
  const out = [];
  let a = polygon[polygon.length - 1];
  for (const b of polygon) {
    const insideA = a[axis] * edge <= 1, insideB = b[axis] * edge <= 1;
    if (insideA !== insideB) {
      const t = (edge - a[axis]) / (b[axis] - a[axis]);
      out.push(a.map((v, i) => v + t * (b[i] - v)));
    }
    if (insideB) out.push(b);
    a = b;
  }
  return out;
}

function sampleGrid(nx, ny, sample) {
  const vertices = [], coordinates = [], faces = [];
  for (let y = 0; y <= ny; y++) for (let x = 0; x <= nx; x++) {
    const u = x * 2 / nx - 1, v = y / ny;
    vertices.push(sample(u, v)); coordinates.push([u, v]);
  }
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const a = y * (nx + 1) + x, b = a + 1, c = a + nx + 1, d = c + 1;
    for (const triangle of [[a, b, c], [b, d, c]]) {
      if (!triangle.every(i => vertices[i])) continue;
      const heights = triangle.map(i => vertices[i][1]);
      if (Math.max(...heights) - Math.min(...heights) <= 0.15) faces.push(...triangle);
    }
  }
  return { vertices, coordinates, faces };
}
