import * as THREE from 'three';

const CELL_SIZE = 384;
// The ground fixture has a zero wake texture. For its unit wind direction and
// [0,1] source weights, maximum tree sway plus leaf flutter is below 0.7 m.
const TREE_PADDING = 2;

export function createPropCellCulling(props) {
  const matrix = new THREE.Matrix4(), sphere = new THREE.Sphere();
  const batches = props.group.children.filter(mesh => mesh.isInstancedMesh &&
    !mesh.castShadow && !mesh.instanceColor && !mesh.material.transparent).map(mesh => {
    // Keep the original full bound used for object sorting even when just a
    // subset of its transforms will be submitted to the colour pass.
    mesh.computeBoundingSphere();
    const cells = new Map(), instances = [];
    const source = mesh.instanceMatrix.array.slice();
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, matrix);
      const key = Math.floor(matrix.elements[12] / CELL_SIZE) + ',' + Math.floor(matrix.elements[14] / CELL_SIZE);
      let cell = cells.get(key);
      if (!cell) {
        cell = { bound: new THREE.Sphere(), visible: true };
        cells.set(key, cell);
      }
      sphere.copy(mesh.geometry.boundingSphere).applyMatrix4(matrix);
      if (mesh.geometry.attributes._wind) sphere.radius += TREE_PADDING;
      cell.bound.union(sphere);
      instances.push(cell);
    }
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    return { mesh, source, cells, instances };
  });

  const frustum = new THREE.Frustum(), clip = new THREE.Matrix4();
  const previous = new THREE.Matrix4();
  return function updatePropCells(camera) {
    props.group.updateWorldMatrix(true, false);
    clip.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).multiply(props.group.matrixWorld);
    if (clip.equals(previous)) return;
    previous.copy(clip);
    frustum.setFromProjectionMatrix(clip, camera.coordinateSystem, camera.reversedDepth);

    for (const { mesh, source, cells, instances } of batches) {
      let changed = false;
      for (const cell of cells.values()) {
        const visible = frustum.intersectsSphere(cell.bound);
        if (visible !== cell.visible) changed = true;
        cell.visible = visible;
      }
      if (!changed) continue;
      const attribute = mesh.instanceMatrix;
      let count = 0;
      // Preserve authored order and every bit of each original transform. Across
      // cell boundaries this also keeps the same relative depth ties. The prop
      // shader reads its colour and wind phase from world position, not instance ID.
      for (let i = 0; i < instances.length; i++) {
        if (!instances[i].visible) continue;
        const offset = i * 16;
        attribute.array.set(source.subarray(offset, offset + 16), count * 16);
        count++;
      }
      mesh.count = count;
      if (count) {
        attribute.clearUpdateRanges();
        attribute.addUpdateRange(0, count * 16);
        attribute.needsUpdate = true;
      }
    }
  };
}
