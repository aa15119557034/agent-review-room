import * as THREE from 'three';

/** Batched small goods (boxes and bottles) for the art-round shop displays.
 *  Everything added through one stock helper lands in at most two InstancedMesh
 *  objects (boxes, bottles), so a whole outdoor display costs two draw calls.
 *  Positions are in the parent's local frame; colours are per instance. */
let boxGeometry = null, bottleGeometry = null;

function paintVertices(geometry, colour) {
  const count = geometry.attributes.position.count, data = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) data.set(colour(geometry.attributes.position.getY(i), i), i * 3);
  geometry.setAttribute('color', new THREE.BufferAttribute(data, 3));
}

function boxGeo() {
  if (boxGeometry) return boxGeometry;
  boxGeometry = new THREE.BoxGeometry(1, 1, 1);
  boxGeometry.translate(0, 0.5, 0);
  paintVertices(boxGeometry, () => [1, 1, 1]);
  return boxGeometry;
}

function bottleGeo() {
  if (bottleGeometry) return bottleGeometry;
  const body = new THREE.CylinderGeometry(0.5, 0.5, 0.62, 8, 1).toNonIndexed(); body.translate(0, 0.31, 0);
  const neck = new THREE.CylinderGeometry(0.2, 0.46, 0.2, 8, 1).toNonIndexed(); neck.translate(0, 0.72, 0);
  const cap = new THREE.CylinderGeometry(0.22, 0.22, 0.1, 8, 1).toNonIndexed(); cap.translate(0, 0.87, 0);
  const parts = [[body, [1, 1, 1]], [neck, [0.93, 0.95, 0.97]], [cap, [0.2, 0.55, 0.9]]];
  for (const [geo, rgb] of parts) paintVertices(geo, () => rgb);
  const total = parts.reduce((n, [g]) => n + g.attributes.position.count, 0);
  const position = new Float32Array(total * 3), normal = new Float32Array(total * 3), color = new Float32Array(total * 3);
  let offset = 0;
  for (const [geo] of parts) {
    position.set(geo.attributes.position.array, offset * 3); normal.set(geo.attributes.normal.array, offset * 3);
    color.set(geo.attributes.color.array, offset * 3); offset += geo.attributes.position.count;
  }
  bottleGeometry = new THREE.BufferGeometry();
  bottleGeometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  bottleGeometry.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  bottleGeometry.setAttribute('color', new THREE.BufferAttribute(color, 3));
  bottleGeometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(total * 2), 2));
  return bottleGeometry;
}

export function createStock(ctx, name, mat = ctx.mat.toon('#ffffff', { vertexColors: true, paint: 0.02, name: 'art-stock' })) {
  const boxes = [], bottles = [], q = new THREE.Quaternion(), e = new THREE.Euler();
  const matrix = (x, y, z, sx, sy, sz, ry) => new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), q.setFromEuler(e.set(0, ry || 0, 0)), new THREE.Vector3(sx, sy, sz));
  return {
    /** Box with its bottom at y. */
    box(x, y, z, w, h, d, colour, ry = 0) { boxes.push([matrix(x, y, z, w, h, d, ry), new THREE.Color(colour)]); },
    /** Bottle with its base at y; d = diameter, h = height. */
    bottle(x, y, z, d, h, colour, ry = 0) { bottles.push([matrix(x, y, z, d, h, d, ry), new THREE.Color(colour)]); },
    get count() { return boxes.length + bottles.length; },
    get triangles() { return boxes.length * 12 + bottles.length * 48; },
    finish(parent) {
      const out = [];
      for (const [list, geometry, label] of [[boxes, boxGeo(), 'boxes'], [bottles, bottleGeo(), 'bottles']]) {
        if (!list.length) continue;
        const mesh = new THREE.InstancedMesh(geometry, mat, list.length);
        mesh.name = `${name}-${label}`;
        list.forEach(([m, c], i) => { mesh.setMatrixAt(i, m); mesh.setColorAt(i, c); });
        mesh.instanceMatrix.needsUpdate = true; mesh.instanceColor.needsUpdate = true;
        mesh.castShadow = true; mesh.receiveShadow = true;
        mesh.computeBoundingSphere();
        parent.add(mesh); out.push(mesh);
      }
      return out;
    },
  };
}
