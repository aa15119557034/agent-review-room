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


/** A short sward on the station's open lawn. Its ground and blades share the same map. */
export function addStationLawn({ station, bounds, heightAt, canGrow, shadeAt, paintAt, random }) {
  const [x0, x1] = bounds.x, [z0, z1] = bounds.z;
  const root = station.root;
  const base = root.getObjectByName('env-terrain-ground');
  if (!base?.isMesh) throw new Error('Station lawn needs the original station ground mesh');

  // The colour field crosses blade blockers on eligible ground. Fade the tint
  // and blade density together before the outer edge so the lawn reads as part of the terrain.
  const nx = Math.ceil((x1 - x0) / 0.5), nz = Math.ceil((z1 - z0) / 0.5);
  const data = new Uint8Array(nx * nz * 2);
  const lawnWeight = (x, z, tone) => {
    const distance = Math.min(x - x0, x1 - x, z - z0, z1 - z);
    const feather = 5.8 + 1.4 * tone;
    return stationGroundGrassWeight(base.name, x, z) * smoothstep(0, feather, distance);
  };
  for (let row = 0; row < nz; row++) {
    for (let column = 0; column < nx; column++) {
      const x = x0 + (column + 0.5) * (x1 - x0) / nx, z = z0 + (row + 0.5) * (z1 - z0) / nz;
      const index = (row * nx + column) * 2;
      const tone = shadeAt(x, z);
      data[index] = Math.round(255 * lawnWeight(x, z, tone));
      data[index + 1] = Math.round(255 * paintAt(x, z));
    }
  }
  const field = new THREE.DataTexture(data, nx, nz, THREE.RGFormat);
  field.minFilter = field.magFilter = THREE.LinearFilter;
  field.needsUpdate = true;
  const uniforms = {
    uLawnField: { value: field },
    uLawnRect: { value: new THREE.Vector4(x0, z0, x1 - x0, z1 - z0) },
    uLawnCool: { value: new THREE.Color('#246c67') },
    uLawnWarm: { value: new THREE.Color('#aec14a') },
  };
  const sample = [
    'uniform sampler2D uLawnField;',
    'uniform vec4 uLawnRect;',
    'uniform vec3 uLawnCool;',
    'uniform vec3 uLawnWarm;',
    'vec2 readLawn(vec2 positionXZ) {',
    '  vec2 uv = (positionXZ-uLawnRect.xy)/uLawnRect.zw;',
    '  if (any(lessThan(uv,vec2(0.0))) || any(greaterThan(uv,vec2(1.0)))) return vec2(0.0);',
    '  return texture2D(uLawnField,uv).rg;',
    '}',
    'vec3 lawnColor(vec2 lawn) { return mix(uLawnCool,uLawnWarm,smoothstep(0.16,0.84,lawn.y)); }',
  ].join('\n');
  const transform = root.matrixWorld.clone().invert().multiply(base.matrixWorld);
  function patchMaterial(material, key, vertexDeclarations, vertex, fragmentDeclarations, color, normal = '') {
    const compile = material.onBeforeCompile, cache = material.customProgramCacheKey();
    material.onBeforeCompile = function (shader, renderer) {
      compile.call(this, shader, renderer);
      Object.assign(shader.uniforms, uniforms, { uLawnObject: { value: transform } });
      shader.vertexShader = 'varying vec2 vLawnXZ;\n' + vertexDeclarations + shader.vertexShader
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + vertex);
      shader.fragmentShader = 'varying vec2 vLawnXZ;\n' + sample + '\n' + fragmentDeclarations + shader.fragmentShader
        .replace('#include <color_fragment>', '#include <color_fragment>\n' + color)
        .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\n' + normal);
    };
    material.customProgramCacheKey = () => cache + ':' + key;
    material.needsUpdate = true;
  }
  patchMaterial(
    base.material, 'x51-lawn-ground', 'uniform mat4 uLawnObject;\n',
    'vLawnXZ=(uLawnObject*vec4(position,1.0)).xz;', '',
    'vec2 stationLawn=readLawn(vLawnXZ); diffuseColor.rgb=mix(diffuseColor.rgb,lawnColor(stationLawn),0.9*stationLawn.x);',
  );
  const blend = station.groundBlend.meshes.find(mesh => mesh.name === 'env-terrain-ground-island-blend');
  if (blend) {
    Object.assign(blend.material.uniforms, uniforms);
    blend.material.fragmentShader = sample + '\n' + blend.material.fragmentShader.replace(
      'vec4(col, edgeAlpha)', 'vec4(col, edgeAlpha*(1.0-readLawn(vStationGround.xz).x))',
    );
    blend.material.needsUpdate = true;
  }

  // Vary leaf width, height and curvature so a close view reads as a soft edge.
  const positions = [], indices = [];
  const blades = [
    { x: -0.06, z: 0.02, height: 0.09, halfWidth: 0.012, bend: 0.051, angle: 0.27 },
    { x: 0.035, z: -0.05, height: 0.125, halfWidth: 0.014, bend: 0.063, angle: 1.98 },
    { x: 0.025, z: 0.065, height: 0.068, halfWidth: 0.009, bend: 0.039, angle: 4.19 },
  ];
  for (const { x, z, height, halfWidth, bend, angle } of blades) {
    const sx = Math.cos(angle), sz = Math.sin(angle), start = positions.length / 3;
    const mx = x - bend * 0.3 * sz, mz = z + bend * 0.3 * sx, midWidth = halfWidth * 0.65;
    positions.push(x - halfWidth*sx, 0, z - halfWidth*sz, x + halfWidth*sx, 0, z + halfWidth*sz,
      mx + midWidth*sx, height*0.62, mz + midWidth*sz, mx - midWidth*sx, height*0.62, mz - midWidth*sz,
      x - bend*sz, height, z + bend*sx);
    indices.push(start, start + 1, start + 2, start, start + 2, start + 3, start + 3, start + 2, start + 4);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(Array.from({length: positions.length / 3}, () => [0,1,0]).flat(), 3));
  geometry.setIndex(indices);
  const material = station.ctx.mat.toon('#ffffff', { name: 'station-lawn-blades', paint: 0, side: 'double' });
  patchMaterial(
    material, 'x51-lawn-blades', 'varying float vLawnTip;\n', [
      'vec4 lawnRoot=instanceMatrix*vec4(0.0,0.0,0.0,1.0);',
      'vLawnXZ=lawnRoot.xz;',
      'vec3 lawnWorld=(modelMatrix*lawnRoot).xyz;',
      'float lawnFade=1.0-smoothstep(10.0,25.0,distance(cameraPosition.xz,lawnWorld.xz));',
      'vLawnTip=position.y/0.125*lawnFade;',
      'transformed.xyz*=lawnFade;',
    ].join('\n'),
    'varying float vLawnTip;\n',
    'vec2 stationLawn=readLawn(vLawnXZ); diffuseColor.rgb=lawnColor(stationLawn)*mix(vec3(1.0),vec3(1.13,1.10,1.02),vLawnTip);',
    'normal*=faceDirection;',
  );
  material.addEventListener('dispose', () => field.dispose());
  const step = 3.2, cells = [];
  let groups = 0;
  for (let z = z0; z < z1; z += step) {
    for (let x = x0; x < x1; x += step) {
      const cx = x + random() * Math.min(step, x1 - x), cz = z + random() * Math.min(step, z1 - z);
      const path = pathDist(cx, cz);
      const pathClearance = (path.d - 1) * path.w;
      const borderClearance = station.bounds.x1 - cx;
      const pathShoulder = pathClearance >= 1.4 && pathClearance <= 3.5;
      const plantedBorder = borderClearance >= 3.2 && borderClearance <= 7.6;
      if (!pathShoulder && !plantedBorder) continue;

      const start = cells.length, radius = 0.35 + 0.48 * random();
      const patchesInGroup = 5 + Math.floor(6 * random());
      for (let i = 0; i < patchesInGroup; i++) {
        const turn = random(), angle = turn * 2 * Math.PI, spread = radius * Math.sqrt(random());
        const px = cx + Math.cos(angle) * spread, pz = cz + Math.sin(angle) * spread;
        const weight = lawnWeight(px, pz, shadeAt(px, pz));
        if (random() >= weight || !canGrow(px, pz)) continue;
        const height = (0.78 + random() * 0.56) * (0.55 + 0.45 * weight);
        cells.push([px, pz, heightAt(px, pz), turn, height]);
      }
      if (cells.length > start) groups++;
    }
  }
  const mesh = new THREE.InstancedMesh(geometry, material, cells.length);
  mesh.name = 'station-lawn-short-grass';
  mesh.receiveShadow = true;
  const rotation = new THREE.Matrix4();
  const scale = new THREE.Vector3();
  cells.forEach(([x, z, y, turn, height], index) => {
    const width = 0.8 + turn * 0.6;
    rotation.makeRotationY(turn * 2 * Math.PI).scale(scale.set(width, height, width));
    mesh.setMatrixAt(index, rotation.setPosition(x, y - 0.01, z));
  });
  mesh.computeBoundingSphere();
  root.add(mesh);
  return { groups, patches: cells.length, blades: cells.length * blades.length, triangles: cells.length * indices.length / 3 };
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
