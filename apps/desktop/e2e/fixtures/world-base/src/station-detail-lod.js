import * as THREE from 'three';

// Only the upstream static merchandise registries are eligible. No building,
// terrain, vegetation, signal, railway or dynamic-root object enters this list.
const GOODS = /^(shopsA-goods-|shopsB-inst-)/;
const HIDE_PX = 0.55;
const SHOW_PX = 0.75;
const MIN_DISTANCE_M = 300;

// sqrt(||A||1 * ||A||inf) bounds the largest singular value, including shear.
// Taking only a prototype radius or one instance's scale is not a safe bound.
function scaleBound(matrix) {
  const e = matrix.elements;
  const norm1 = Math.max(
    Math.abs(e[0]) + Math.abs(e[1]) + Math.abs(e[2]),
    Math.abs(e[4]) + Math.abs(e[5]) + Math.abs(e[6]),
    Math.abs(e[8]) + Math.abs(e[9]) + Math.abs(e[10]),
  );
  const normInf = Math.max(
    Math.abs(e[0]) + Math.abs(e[4]) + Math.abs(e[8]),
    Math.abs(e[1]) + Math.abs(e[5]) + Math.abs(e[9]),
    Math.abs(e[2]) + Math.abs(e[6]) + Math.abs(e[10]),
  );
  return Math.sqrt(norm1 * normInf);
}

export function createStationDetailLod({ root }) {
  root.updateWorldMatrix(true, true);
  const rows = [];
  const matrix = new THREE.Matrix4();
  const world = new THREE.Matrix4();
  const center = new THREE.Vector3();
  const box = new THREE.Box3();
  const corner = new THREE.Vector3();
  root.traverse(object => {
    if (!object.isInstancedMesh || !GOODS.test(object.name) || object.userData.dynamic ||
        object.castShadow || Array.isArray(object.material) || object.material.transparent ||
        !object.material.isMeshToonMaterial || !object.count) return;
    const geometry = object.geometry;
    if (!geometry.boundingSphere) geometry.computeBoundingSphere();
    const prototype = geometry.boundingSphere;
    let maxRadius = 0;
    box.makeEmpty();
    for (let i = 0; i < object.count; i++) {
      object.getMatrixAt(i, matrix);
      world.multiplyMatrices(object.matrixWorld, matrix);
      center.copy(prototype.center).applyMatrix4(world);
      const radius = prototype.radius * scaleBound(world);
      maxRadius = Math.max(maxRadius, radius);
      box.expandByPoint(corner.copy(center).addScalar(radius));
      box.expandByPoint(corner.copy(center).addScalar(-radius));
    }
    const bounds = box.getBoundingSphere(new THREE.Sphere());
    rows.push({
      object, bounds, maxRadius, hidden: false, visibleBeforeHide: object.visible,
      triangles: (geometry.index?.count ?? geometry.attributes.position.count) / 3 * object.count,
      projectedDiameterPx: null,
    });
  });
  const stats = {
    eligibleMeshes: rows.length,
    eligibleTriangles: rows.reduce((sum, row) => sum + row.triangles, 0),
    hiddenMeshes: 0, hiddenTriangles: 0, hiddenColorDraws: 0,
    hideBelowPx: HIDE_PX, restoreAbovePx: SHOW_PX, minimumDistanceM: MIN_DISTANCE_M,
    scope: 'Static shopsA goods / shopsB goods only; maximum transformed instance diameter bound, no shadow casters. Draw savings exclude outline and other passes.',
    entries: rows.map(row => ({
      name: row.object.name, instances: row.object.count, triangles: row.triangles,
      maxInstanceDiameterM: row.maxRadius * 2,
      center: row.bounds.center.toArray(), radius: row.bounds.radius,
    })),
  };
  const viewCenter = new THREE.Vector3();
  let enabled = true, disposed = false, lastKey = '';

  function restore() {
    for (const row of rows) {
      if (row.hidden) row.object.visible = row.visibleBeforeHide;
      row.hidden = false;
    }
    stats.hiddenMeshes = stats.hiddenTriangles = stats.hiddenColorDraws = 0;
    lastKey = '';
  }

  return {
    stats,
    get enabled() { return enabled; },
    setEnabled(value) {
      enabled = Boolean(value);
      if (!enabled) restore();
      lastKey = '';
    },
    update(camera, width, height) {
      if (disposed || !enabled || !camera.isPerspectiveCamera) {
        if (!disposed) restore();
        return;
      }
      // Fixed cameras hit this fast path: no thousand-mesh traversal or per-
      // instance work is repeated. The registry is immutable after construction.
      const key = camera.matrixWorld.elements.join(',') + '|' + camera.projectionMatrix.elements.join(',') + '|' + width + '|' + height;
      if (key === lastKey) return;
      lastKey = key;
      const p = camera.projectionMatrix.elements;
      const focal = Math.max(Math.abs(p[0]) * width, Math.abs(p[5]) * height) * 0.5;
      stats.hiddenMeshes = stats.hiddenTriangles = stats.hiddenColorDraws = 0;
      for (const row of rows) {
        viewCenter.copy(row.bounds.center).applyMatrix4(camera.matrixWorldInverse);
        const nearest = -viewCenter.z - row.bounds.radius;
        const distance = viewCenter.length() - row.bounds.radius;
        // Perspective division can magnify off-axis spheres. Bound its Jacobian
        // over the entire batch, not just the centre ray or average instance.
        const radial = Math.hypot(viewCenter.x, viewCenter.y) + row.bounds.radius;
        const diameter = nearest > 0
          ? 2 * row.maxRadius * focal / nearest * Math.sqrt(1 + (radial / nearest) ** 2)
          : Infinity;
        row.projectedDiameterPx = diameter;
        const hide = distance >= MIN_DISTANCE_M && diameter < (row.hidden ? SHOW_PX : HIDE_PX);
        if (hide && !row.hidden && row.object.visible) {
          row.visibleBeforeHide = row.object.visible;
          row.hidden = true;
          row.object.visible = false;
        } else if (!hide && row.hidden) {
          row.object.visible = row.visibleBeforeHide;
          row.hidden = false;
        }
        if (row.hidden) {
          stats.hiddenMeshes++;
          stats.hiddenColorDraws++;
          stats.hiddenTriangles += row.triangles;
        }
      }
    },
    snapshot() {
      return {
        enabled, ...stats,
        states: rows.map(row => ({
          name: row.object.name, hidden: row.hidden, visible: row.object.visible,
          projectedDiameterPx: row.projectedDiameterPx,
        })),
      };
    },
    dispose() {
      if (disposed) return;
      restore();
      disposed = true;
      // All meshes/materials/geometries are borrowed; only visibility is owned.
    },
  };
}
