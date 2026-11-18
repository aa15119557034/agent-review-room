const assert = require('node:assert/strict');
const path = require('node:path');
const { registerHooks } = require('node:module');
const { pathToFileURL } = require('node:url');

async function main() {
  const root = path.resolve(__dirname, '..');
  const url = relative => pathToFileURL(path.join(root, relative)).href;
  const threeUrl = url('upstream/petalwake/vendor/three/build/three.module.js');
  const hook = registerHooks({ resolve(specifier, context, next) {
    if (specifier === 'three') return { url: threeUrl, shortCircuit: true };
    if (specifier.startsWith('three/addons/')) return { url: url('upstream/petalwake/vendor/three/examples/jsm/' + specifier.slice(13)), shortCircuit: true };
    return next(specifier, context);
  } });
  try {
    const THREE = await import(threeUrl);
    const { Terrain } = await import(url('upstream/petalwake/src/world/terrain.js'));
    const { U, World } = await import(url('upstream/petalwake/src/core/ctx.js'));
    const { createGroundTransition, blendStationGround, stationGroundGrassWeight } = await import(url('src/transition.js'));
    // Build the real island material without image loading or a WebGL context.
    const terrain = Object.create(Terrain.prototype);
    terrain._buildMesh({ color: new THREE.DataArrayTexture(), normal: new THREE.DataArrayTexture(), mean: [] });
    const rect = { minX: 188, maxX: 372, minZ: 803, maxZ: 1028 };
    terrain.material.uniforms.uStationCutout.value.set(188, 803, 372, 1028);
    const stationHeight = (x, z) => 8 + x * 0.001 + z * 0.002;
    const islandHeight = (x, z) => 7 + x * 0.002 + z * 0.001;
    const mesh = createGroundTransition({ rect, stationHeight, islandHeight, terrainMaterial: terrain.material });
    assert.equal(mesh.material.fragmentShader, terrain.material.fragmentShader);
    for (const [name, uniform] of Object.entries(terrain.material.uniforms)) {
      if (name !== 'uStationCutout') assert.equal(mesh.material.uniforms[name], uniform, `Shared uniform: ${name}`);
    }
    assert.notEqual(mesh.material.uniforms.uStationCutout, terrain.material.uniforms.uStationCutout);
    assert.deepEqual(mesh.material.uniforms.uStationCutout.value.toArray(), [0, 0, 0, 0]);
    assert.deepEqual(terrain.material.uniforms.uStationCutout.value.toArray(), [188, 803, 372, 1028]);
    assert.equal(mesh.geometry.index.count / 3, 1636);
    const positions = mesh.geometry.attributes.position;
    for (let i = 0; i < positions.count; i++) {
      const x = positions.getX(i), z = positions.getZ(i);
      const expected = i % 2 ? islandHeight(x, z) : stationHeight(x, z);
      assert.ok(Math.abs(positions.getY(i) - expected) < 1e-5, 'Original inner/outer seam heights');
    }
    console.log('PASS real terrain shader/uniform reuse, isolated cutout, unchanged 1,636-triangle seam');

    const stationRoot = new THREE.Group(), base = new THREE.Group(); base.name = 'env-terrain'; stationRoot.add(base);
    stationRoot.position.set(280, 8, 900); stationRoot.rotation.y = 0.2;
    const groundGeometry = new THREE.BufferGeometry();
    groundGeometry.setAttribute('position', new THREE.Float32BufferAttribute([
      -91, 0, 0, -90, 0, 0, -90, 0, 1, // inner boundary band
      0, 0, 0, 1, 0, 0, 0, 0, 1, // centre: unchanged
      150, 0, 0, 151, 0, 0, 150, 0, 1, // outside the district: not submitted
    ], 3));
    groundGeometry.setIndex([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    const originalGroundMaterial = new THREE.MeshToonMaterial();
    const ground = new THREE.Mesh(groundGeometry, originalGroundMaterial); ground.name = 'env-terrain-ground'; base.add(ground);
    const roadMaterial = new THREE.MeshToonMaterial();
    const road = new THREE.Mesh(groundGeometry, roadMaterial); road.name = 'street-road'; stationRoot.add(road);
    const result = blendStationGround({ root: stationRoot, terrainMaterial: mesh.material,
      bounds: { x0: -92, x1: 92, z0: -97, z1: 128 } });
    assert.equal(result.meshes.length, 1); assert.equal(result.triangles, 1);
    const edge = result.meshes[0];
    assert.equal(edge.geometry.attributes.position, groundGeometry.attributes.position);
    assert.deepEqual(Array.from(edge.geometry.index.array), [0, 1, 2]);
    assert.equal(ground.material, originalGroundMaterial); assert.equal(ground.geometry, groundGeometry);
    assert.equal(road.material, roadMaterial); assert.equal(road.userData.noBatch, undefined);
    assert.equal(edge.material.depthFunc, THREE.EqualDepth);
    assert.equal(edge.material.depthWrite, false); assert.equal(edge.material.transparent, true);
    assert.equal(edge.material.uniforms.uMatC, terrain.material.uniforms.uMatC);
    const fragment = edge.material.fragmentShader;
    const clipping = fragment.indexOf('#include <clipping_planes_fragment>');
    assert.ok(fragment.includes('#include <clipping_planes_pars_fragment>'));
    assert.ok(clipping > fragment.lastIndexOf('dFdx(') && clipping > fragment.lastIndexOf('dFdy('));
    assert.ok(clipping > fragment.lastIndexOf('texture('));
    assert.ok(!fragment.includes('if (edgeAlpha <= 0.0) discard'));
    assert.ok(clipping < fragment.indexOf('gl_FragColor = vec4(col, edgeAlpha)'));
    stationRoot.updateWorldMatrix(true, true);
    assert.deepEqual(edge.matrixWorld.elements, ground.matrixWorld.elements);
    console.log('PASS only base-soil edge triangles blend; centre/road/height untouched; shared attributes and EqualDepth');
    console.log('PASS edge alpha does not discard; clipping follows terrain sampling and derivatives');

    // Build Sakuragaoka's actual vertex-coloured ground. The parking surface is
    // part of this mesh, not a raised parking plane, so test its real vertices.
    const { buildTerrain } = await import(url('upstream/sakuragaoka/src/world/environment/terrain.js'));
    const actualRoot = new THREE.Group();
    const actual = buildTerrain({ THREE,
      mat: { toon: () => new THREE.MeshToonMaterial() },
      noBatch: object => { object.userData.noBatch = true; },
      addStatic: object => actualRoot.add(object),
    }, {}, new THREE.MeshBasicMaterial());
    const actualBlend = blendStationGround({ root: actualRoot, terrainMaterial: mesh.material,
      bounds: { x0: -92, x1: 92, z0: -97, z1: 128 } });
    const actualEdge = actualBlend.meshes.find(object => object.name === 'env-terrain-ground-island-blend');
    const p = actualEdge.geometry.attributes.position, weights = actualEdge.geometry.attributes.stationGrass;
    let parkingVertices = 0, openGrassVertices = 0;
    for (const i of new Set(actualEdge.geometry.index.array)) {
      const x = p.getX(i), z = p.getZ(i);
      if (x >= -92 && x <= -78 && z >= -13 && z <= -7) {
        assert.equal(weights.getX(i), 0, `Original parking stays gravel at ${x},${z}`);
        parkingVertices++;
      }
      if (x === -90 && z === -20) { assert.equal(weights.getX(i), 1); openGrassVertices++; }
    }
    assert.ok(parkingVertices >= 70 && openGrassVertices > 0);
    for (const [name, x, z] of [
      ['ground', -90, 50], ['ground', 90, 20], ['ground', -90, -45],
      ['ground', -78, 128], ['levee', -90, -93], ['bank', -90, -100],
    ]) assert.equal(stationGroundGrassWeight(`env-terrain-${name}`, x, z), 0);
    assert.equal(stationGroundGrassWeight('env-terrain-levee', -90, -96), 1);
    assert.ok(!actualBlend.meshes.some(object => object.name.includes('bank')));
    assert.ok(!actual.group.children.find(object => object.name === 'env-terrain-ground').geometry.hasAttribute('stationGrass'));
    console.log(`PASS ${parkingVertices} real parking vertices remain gravel; paths, fields, corridor and masonry excluded; nearby grass still blends`);

    const { clearStationVegetation } = await import(url('src/island.js'));
    const S = 1024, pixels = new Uint8Array(S * S * 4);
    for (let i = 0; i < pixels.length; i += 4) pixels.set([200, 77, 123, 220], i);
    let disposed = false;
    const field = { splatN: S, splat: pixels, splatTex: { dispose() { disposed = true; } } };
    clearStationVegetation(field);
    assert.ok(disposed);
    assert.equal(field.splatTex.image.data, pixels);
    assert.equal(U.uSplatTex.value, field.splatTex);
    assert.equal(mesh.material.uniforms.uSplatTex.value, field.splatTex);
    const cell = World.size / S;
    const sample = (x, z, channel) => {
      const fx = (x + World.half) / cell - 0.5, fz = (z + World.half) / cell - 0.5;
      const ix = Math.floor(fx), iz = Math.floor(fz), a = fx - ix, b = fz - iz;
      const at = (dx, dz) => pixels[((iz + dz) * S + ix + dx) * 4 + channel];
      return (at(0, 0) * (1 - a) + at(1, 0) * a) * (1 - b) + (at(0, 1) * (1 - a) + at(1, 1) * a) * b;
    };
    for (let z = rect.minZ; z <= rect.maxZ; z += 0.5) for (const x of [rect.minX, 280, rect.maxX]) {
      assert.equal(sample(x, z, 0), 0, 'No flower interpolation into core');
      assert.equal(sample(x, z, 3), 0, 'No grass interpolation into core');
    }
    for (const channel of [0, 3]) {
      const profile = [0, 3, 6, 9, 12, 18, 24].map(distance => sample(rect.maxX + distance, 900, channel));
      assert.ok(profile.every((value, i) => i === 0 || value >= profile[i - 1]));
      assert.ok(profile.some(value => value > 0 && value < (channel === 0 ? 200 : 220)));
      assert.equal(profile.at(-1), channel === 0 ? 200 : 220);
      console.log(`PASS boundary channel ${channel} smooth profile:`, profile.map(value => +value.toFixed(2)));
    }
    for (let i = 0; i < pixels.length; i += 4) { assert.equal(pixels[i + 1], 77); assert.equal(pixels[i + 2], 123); }
    console.log('PASS zero bilinear core, unchanged species/wetness, shared replacement GPU texture');
  } finally { hook.deregister(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
