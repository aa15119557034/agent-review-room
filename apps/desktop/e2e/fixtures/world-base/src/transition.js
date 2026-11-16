import * as THREE from 'three';

/** A narrow, explicit join between the station's ground and the island heightfield. */
export function createGroundTransition({ rect, stationHeight, islandHeight, width = 2, spacing = 1 }) {
  const inner = [[rect.minX, rect.minZ], [rect.maxX, rect.minZ], [rect.maxX, rect.maxZ], [rect.minX, rect.maxZ]];
  const outer = [[rect.minX - width, rect.minZ - width], [rect.maxX + width, rect.minZ - width],
    [rect.maxX + width, rect.maxZ + width], [rect.minX - width, rect.maxZ + width]];
  const positions = [], indices = [];
  for (let edge = 0; edge < 4; edge++) {
    const next = (edge + 1) % 4;
    const count = Math.ceil(Math.hypot(inner[next][0] - inner[edge][0], inner[next][1] - inner[edge][1]) / spacing);
    const start = positions.length / 3;
    for (let i = 0; i <= count; i++) {
      const t = i / count;
      const ix = THREE.MathUtils.lerp(inner[edge][0], inner[next][0], t);
      const iz = THREE.MathUtils.lerp(inner[edge][1], inner[next][1], t);
      const ox = THREE.MathUtils.lerp(outer[edge][0], outer[next][0], t);
      const oz = THREE.MathUtils.lerp(outer[edge][1], outer[next][1], t);
      positions.push(ix, stationHeight(ix, iz), iz, ox, islandHeight(ox, oz), oz);
      if (i < count) {
        const a = start + i * 2;
        indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  const material = new THREE.MeshLambertMaterial({ color: '#8fb96f' });
  material.name = 'station-island-ground-transition';
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'station-island-ground-transition';
  mesh.receiveShadow = true;
  return mesh;
}
