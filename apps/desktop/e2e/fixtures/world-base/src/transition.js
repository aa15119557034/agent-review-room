import * as THREE from 'three';
import { ownedByOthers, inCorridor, inRect, roadDist, pathDist, smoothstep,
  VACANT_W, ALLOT_W, NANO_E, LEV } from '../upstream/sakuragaoka/src/world/environment/common.js';

// The source terrain also encodes gravel parking, paths and town paving in
// vertex colours. Reuse its layout semantics rather than treating all soil as
// grass, or guessing a surface from RGB. A core cell is 1m: the guard keeps
// interpolation from introducing grass inside these original surface areas.
const parkingGround = { ...VACANT_W, x1: -76, z0: -13.5 };
export function stationGroundGrassWeight(name, x, z) {
  if (name === 'env-terrain-levee') {
    if (z >= LEV.shoulderR - 1 && z <= LEV.shoulderT + 1) return 0;
    return 1;
  }
  if (name !== 'env-terrain-ground' || ownedByOthers(x, z, 1) || inCorridor(x, z, 1)) return 0;
  if (inRect(x, z, parkingGround, 1) || inRect(x, z, ALLOT_W, 3) || inRect(x, z, NANO_E, 2.5)) return 0;
  const path = pathDist(x, z);
  const pathWeight = smoothstep(1.4, 1.4 + 1 / path.w, path.d);
  return pathWeight * smoothstep(1.4, 2.4, roadDist(x, z));
}

/** A narrow, explicit join between the station's ground and the island heightfield. */
export function createGroundTransition({ rect, stationHeight, islandHeight, terrainMaterial, width = 2, spacing = 1 }) {
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
  // The island's fragment shader samples its existing world-space ground maps.
  // Share uniform objects (including large texture arrays), but give this mesh
  // its own disabled cutout: these triangles are precisely what joins that hole.
  // The vertex shader keeps the explicit seam heights rather than CDLOD's aNode
  // displacement. applyIsland() must apply the same toon patch to both materials.
  const material = new THREE.ShaderMaterial({
    uniforms: { ...terrainMaterial.uniforms, uStationCutout: { value: new THREE.Vector4(0, 0, 0, 0) } },
    vertexShader: /* glsl */`
      varying vec3 vWorld;
      void main() {
        vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
        gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
      }
    `,
    fragmentShader: terrainMaterial.fragmentShader,
  });
  material.name = 'station-island-ground-transition';
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'station-island-ground-transition';
  mesh.receiveShadow = true;
  return mesh;
}

/** Blend only the station's original base soil into the island in the inner edge
 * band. Equal depth makes raised asphalt, tracks and paving occlude this pass.
 * Geometry heights, collision and the district cutout stay unchanged.
 */
export function blendStationGround({ root, terrainMaterial, bounds, width = 12 }) {
  const terrain = root.getObjectByName('env-terrain');
  if (!terrain) throw new Error('Station base terrain is required for the ground join');
  const allowed = new Set(['env-terrain-ground', 'env-terrain-levee']);
  const sources = terrain.children.filter(object => object.isMesh && allowed.has(object.name));
  const meshes = [];
  let triangles = 0;
  root.updateWorldMatrix(true, true);
  const inverse = root.matrixWorld.clone().invert();
  const point = new THREE.Vector3();
  for (const source of sources) {
    const sourceGeometry = source.geometry, positions = sourceGeometry.attributes.position;
    const indices = sourceGeometry.index;
    const localMatrix = new THREE.Matrix4().multiplyMatrices(inverse, source.matrixWorld);
    const selected = [], box = new THREE.Box3();
    const grass = new Float32Array(positions.count);
    const visited = new Uint8Array(positions.count);
    const vertices = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    for (let i = 0; i < indices.count; i += 3) {
      for (let corner = 0; corner < 3; corner++) vertices[corner].fromBufferAttribute(positions, indices.getX(i + corner)).applyMatrix4(localMatrix);
      const minX = Math.min(vertices[0].x, vertices[1].x, vertices[2].x), maxX = Math.max(vertices[0].x, vertices[1].x, vertices[2].x);
      const minZ = Math.min(vertices[0].z, vertices[1].z, vertices[2].z), maxZ = Math.max(vertices[0].z, vertices[1].z, vertices[2].z);
      if (maxX < bounds.x0 || minX > bounds.x1 || maxZ < bounds.z0 || minZ > bounds.z1) continue;
      if (minX >= bounds.x0 + width && maxX <= bounds.x1 - width && minZ >= bounds.z0 + width && maxZ <= bounds.z1 - width) continue;
      for (let corner = 0; corner < 3; corner++) {
        const index = indices.getX(i + corner);
        if (!visited[index]) {
          grass[index] = stationGroundGrassWeight(source.name, vertices[corner].x, vertices[corner].z);
          visited[index] = 1;
        }
        selected.push(index);
        box.expandByPoint(point.fromBufferAttribute(positions, index));
      }
    }
    if (!selected.length) continue;
    const geometry = new THREE.BufferGeometry();
    // Share existing attributes. Only the small edge-band index buffer is new.
    for (const [name, attribute] of Object.entries(sourceGeometry.attributes)) geometry.setAttribute(name, attribute);
    geometry.setAttribute('stationGrass', new THREE.BufferAttribute(grass, 1));
    geometry.setIndex(selected);
    geometry.boundingBox = box;
    geometry.boundingSphere = box.getBoundingSphere(new THREE.Sphere());
    const output = 'gl_FragColor = vec4(col, 1.0);';
    if (!terrainMaterial.fragmentShader.includes(output) || !terrainMaterial.fragmentShader.includes('void main(){')) throw new Error('Island ground shader changed; update the edge blend');
    const fragmentShader = '#include <clipping_planes_pars_fragment>\n' + terrainMaterial.fragmentShader.replace('void main(){', `
      varying vec3 vStationGround;
      varying float vStationGrass;
      uniform vec4 uGroundBounds;
      uniform float uGroundBlendWidth;
      void main(){
        float edgeDistance = min(min(vStationGround.x-uGroundBounds.x, vStationGround.z-uGroundBounds.y),
          min(uGroundBounds.z-vStationGround.x, uGroundBounds.w-vStationGround.z));
        float edgeAlpha = (1.0-smoothstep(0.0,uGroundBlendWidth,edgeDistance))*vStationGrass;
    `).replace(output, `
      // Finish terrain derivatives and implicit texture LOD before clipping.
      #include <clipping_planes_fragment>
      gl_FragColor = vec4(col, edgeAlpha);
    `);
    const material = new THREE.ShaderMaterial({
      uniforms: { ...terrainMaterial.uniforms,
        uStationCutout: { value: new THREE.Vector4(0, 0, 0, 0) },
        uStationObject: { value: localMatrix },
        uGroundBounds: { value: new THREE.Vector4(bounds.x0, bounds.z0, bounds.x1, bounds.z1) },
        uGroundBlendWidth: { value: width },
      },
      vertexShader: /* glsl */`
        varying vec3 vWorld;
        varying vec3 vStationGround;
        attribute float stationGrass;
        varying float vStationGrass;
        uniform mat4 uStationObject;
        void main() {
          vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
          vStationGround = (uStationObject * vec4(position, 1.0)).xyz;
          vStationGrass = stationGrass;
          // Match MeshToon's project_vertex order exactly for EqualDepth.
          vec4 mvPosition = vec4(position, 1.0);
          mvPosition = modelViewMatrix * mvPosition;
          gl_Position = projectionMatrix * mvPosition;
        }
      `,
      fragmentShader,
      transparent: true, depthWrite: false, depthFunc: THREE.EqualDepth,
    });
    material.name = `${source.name}-island-blend`;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = material.name;
    mesh.matrix.copy(source.matrix); mesh.matrixAutoUpdate = false;
    mesh.userData.noBatch = true;
    // Preserve the underlying mesh's transform and depth calculation as well.
    source.userData.noBatch = true;
    source.parent.add(mesh);
    meshes.push(mesh); triangles += selected.length / 3;
  }
  return { meshes, triangles, width };
}
