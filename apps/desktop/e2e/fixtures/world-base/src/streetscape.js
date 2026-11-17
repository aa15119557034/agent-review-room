import * as THREE from 'three';
import { Frame } from '../upstream/sakuragaoka/src/world/houses/gb.js';
import { MeshBuilder } from '../upstream/sakuragaoka/src/world/street/mesh.js';
import { UTIL, uvOf } from '../upstream/sakuragaoka/src/world/street/textures.js';
import { townSortingBins } from './city-apartments.js';

/** Small additions to existing frontage assets. Call once after module builds,
 * before station trim/batching, while the district root is still at identity.
 * All positions and returned collision bounds are station-local metres.
 */
export function addStreetscape({ ctx, root }) {
  const H = ctx.services.houses.buildContext;
  const C = ctx.services.shopsA.buildContext;
  const L = ctx.L;
  const group = new THREE.Group();
  group.name = 'station-streetscape';
  ctx.addStatic(group);
  const instances = [], collisions = [];
  const texturePixelsBefore = ctx.tex.pixels;
  const addBox = (id, frame, x, z, width, depth, y0, y1, rotationY = 0) => {
    const position = frame.w(x, 0, z);
    const bounds = { x: position.x, z: position.z, width, depth,
      rotationY: frame.ry + rotationY, y0: position.y + y0, y1: position.y + y1 };
    const collider = ctx.physics.addBox(bounds.x, bounds.z, width, depth, bounds.rotationY, bounds.y0, bounds.y1);
    const entry = { id, type: 'box', ...bounds, collider };
    collisions.push(entry);
    return entry;
  };
  const ground = (frame, x, z) => {
    const point = frame.w(x, 0, z);
    return ctx.physics.groundHeight(point.x, point.z, L.heightAt(point.x, point.z) + 0.5) - point.y;
  };

  const lot = L.lotFrame(L.lotById('W3'));
  const frame = Frame.at(H.gb, lot.x, lot.y, lot.z, lot.rotY);
  // Outside the wall cap (front edge z=0), away from its gate x=-2.1..-0.5.
  // The front edge is only 0.11m inside the existing 1.6m-wide sidewalk.
  const previousLod = H.lod;
  H.lod = 2; // These foreground flowers use the existing detailed leaf variant.
  try {
    // The existing red bicycle occupies lot x=1.5..3.3; leave it and its
    // leaning footprint clear instead of placing a planter under its frame.
    for (const [id, x, length] of [['w3-planter-south', -3.2, 1.4], ['w3-planter-north', 0.6, 1.2]]) {
      const z = 0.17, y = ground(frame, x, z);
      H.P.planter(frame, x, y, z, length, ctx.rng(id));
      const meshes = H.gb.flush(group, id);
      const position = frame.w(x, 0, z);
      const collision = { id, type: 'walk', x: position.x, z: position.z, width: length, depth: 0.28,
        rotationY: frame.ry, y0: position.y + y, y1: position.y + y + 0.26 };
      // A 26cm box is below the existing 45cm step height. Register its top
      // as support so approaching feet rise onto it rather than pass through.
      collision.collider = ctx.physics.addWalkBox(collision.x, collision.z, length, 0.28,
        collision.rotationY, collision.y1, collision.y0);
      collisions.push(collision);
      instances.push({ id, kind: 'planter', lot: 'W3', lotPosition: [x, y, z],
        size: [length, 0.26, 0.28], meshes, footprint: collision });
    }
  } finally {
    H.lod = previousLod;
  }

  // W2 south-facing upper side wall: above the 2.9m rose trellis, ahead
  // of the window at z=-6.2..-5.0. The W3 house is behind this sightline.
  // A CPU ray probe against the original seeded W3 tree clears all nine
  // sampled body points from the fixed street view at (-1.2,2.4,36).
  const originalFlower = root.getObjectByName('shopsA:W2');
  const flower = new THREE.Group();
  flower.name = 'streetscape-W2';
  flower.position.copy(originalFlower.position);
  flower.quaternion.copy(originalFlower.quaternion);
  group.add(flower);
  const ff = L.lotFrame(L.lotById('W2'));
  const flowerFrame = Frame.at(H.gb, ff.x, ff.y, ff.z, ff.rotY);
  const x = -3.365, z = -4.35, y = 3.24;
  const unit = C.P.acUnit({ k: ctx.kit(flower) }, x, y, z, -Math.PI / 2,
    { w: 0.8, h: 0.6, d: 0.29, ductH: 1.4 });
  unit.name = 'w2-side-air-conditioner';
  const unitFrame = flowerFrame.sub(x, y, z, -Math.PI / 2);
  const body = addBox(unit.name, unitFrame, 0, 0.013, 0.8, 0.316, 0, 0.66);
  const duct = addBox(`${unit.name}-duct`, unitFrame, 0.46, -0.205, 0.1, 0.08, 0.27, 1.67);
  const connector = addBox(`${unit.name}-connector`, unitFrame, 0.46, -0.125, 0.1, 0.22, 0.22, 0.32);
  // Two L brackets support the original feet. Rear plates contact the wall
  // at unit-local z=-0.215; horizontal arms end just behind the fan face.
  const mounting = ctx.kit(unit), steel = C.M.t('#8b8e96');
  const supports = [];
  for (const [i, sx] of [-0.288, 0.288].entries()) {
    mounting.box(0.04, 0.28, 0.03, steel, [sx, -0.14, -0.2]);
    mounting.box(0.04, 0.03, 0.325, steel, [sx, -0.015, -0.0525]);
    supports.push(addBox(`${unit.name}-bracket-${i}-wall`, unitFrame, sx, -0.2, 0.04, 0.03, -0.28, 0));
    supports.push(addBox(`${unit.name}-bracket-${i}-arm`, unitFrame, sx, -0.0525, 0.04, 0.325, -0.03, 0));
  }
  instances.push({ id: unit.name, kind: 'acUnit', lot: 'W2', lotPosition: [x, y, z],
    size: [0.8, 0.66, 0.316], meshes: unit.children, footprint: body, duct, connector, supports });
  // The shed already has a broom, hose and the textured crate/carton. Keep its
  // sliding panels and the route to the staff cycle shelter clear. The two
  // house-kit bins reuse the existing burnable/recycling atlas labels.
  const yardFrame = Frame.at(H.gb, 0, 0, 0);
  const binX = 26.4, binZ = -29.18;
  const yardY = ground(yardFrame, binX, binZ) + 0.012; // existing gravel patch lift
  townSortingBins(H, yardFrame, binX, yardY, binZ, 2);
  const bins = H.gb.flush(group, 'service-sorting-bins');
  const binCollisions = [-0.25, 0.25].map((dx, i) =>
    addBox('service-sorting-bin-' + i, yardFrame, binX + dx, binZ, 0.46, 0.46, yardY, yardY + 0.68));
  for (const [i, footprint] of binCollisions.entries()) {
    instances.push({ id: 'service-sorting-bin-' + i, kind: 'labelledBin',
      localPosition: [binX + (i ? .25 : -.25), yardY, binZ], size: [.46, .68, .46], triangles: 36,
      atlasRegion: ['bin_burn', 'bin_res'][i], meshes: bins, footprint });
  }

  const panX = 25.72, panZ = -29.22, panY = ground(yardFrame, panX, panZ) + 0.012;
  H.P.dustpan(yardFrame, panX, panY, panZ);
  const panMeshes = H.gb.flush(group, 'service-dustpan');
  const panBase = { id: 'service-dustpan-base', type: 'walk', x: panX, z: panZ,
    width: 0.26, depth: 0.22, rotationY: 0, y0: panY, y1: panY + 0.04 };
  panBase.collider = ctx.physics.addWalkBox(panX, panZ, 0.26, 0.22, 0, panBase.y1, panBase.y0);
  collisions.push(panBase);
  // The handle leans in X rotation; its tight horizontal envelope is not a
  // solid 55cm-tall box over the whole low pan. The pan itself is stepable.
  const panHandle = addBox('service-dustpan-handle', yardFrame, panX, panZ - 0.08,
    0.03, Math.sin(0.2) * 0.5 + Math.cos(0.2) * 0.03,
    panY + 0.3 - Math.cos(0.2) * 0.25 - Math.sin(0.2) * 0.015,
    panY + 0.3 + Math.cos(0.2) * 0.25 + Math.sin(0.2) * 0.015);
  instances.push({ id: 'service-dustpan', kind: 'dustpan', localPosition: [panX, panY, panZ],
    triangles: 24, meshes: panMeshes, footprint: panBase, handle: panHandle });

  // Thin details on the shed's east return, inside its existing collision
  // envelope. Keep the south sliding doors, handle and original label clear.
  const ventFrame = yardFrame.sub(25.406, 1.65, -29.65, Math.PI / 2);
  ventFrame.box(H.M.atlas, '#ffffff', .32, .12, .012, 0, 0, 0,
    { uv: { rect: H.A.rects.vent, white: H.A.white } });
  const ventMeshes = H.gb.flush(group, 'shed-east-vent');
  instances.push({ id: 'shed-east-vent', kind: 'wallVent', localPosition: [25.406, 1.65, -29.65],
    triangles: 12, atlasRegion: 'vent', meshes: ventMeshes,
    footprint: { type: 'decorative', x: 25.406, z: -29.65, width: .012, depth: .32,
      rotationY: 0, y0: 1.59, y1: 1.71 } });

  // Reuse the already-built station staff-only sign's geometry, UVs and
  // material; do not rebuild its atlas or dispose these borrowed resources.
  const staffSigns = [];
  root.traverse(mesh => {
    if (mesh.isMesh && mesh.material.map === ctx.tex.cache.get('st-atlas-misc') &&
        mesh.position.distanceToSquared(new THREE.Vector3(4.35, 2.5, -35.47)) < 1e-10)
      staffSigns.push(mesh);
  });
  if (staffSigns.length !== 1) throw new Error('Expected one original station staff-only sign');
  const staffSign = new THREE.Mesh(staffSigns[0].geometry, staffSigns[0].material);
  staffSign.name = 'shed-east-staff-sticker';
  staffSign.position.set(25.402, 1.25, -29.72);
  staffSign.rotation.y = Math.PI / 2;
  staffSign.scale.setScalar(.22 / .42);
  staffSign.receiveShadow = staffSigns[0].receiveShadow;
  staffSign.renderOrder = staffSigns[0].renderOrder;
  ctx.noOutline(staffSign);
  group.add(staffSign);
  instances.push({ id: staffSign.name, kind: 'staffSticker', localPosition: staffSign.position.toArray(),
    triangles: 2, atlasRegion: 'misc/staffOnly', meshes: [staffSign],
    footprint: { type: 'decorative', x: 25.402, z: -29.72, width: 0, depth: .22,
      rotationY: 0, y0: 1.25 - .08 * .22 / .42, y1: 1.25 + .08 * .22 / .42 } });

  // Two existing utility-atlas covers beside the toilet plinth. Their 5mm
  // lift over the gravel is a surface detail, not a new hole or walk blocker.
  const utilityDecals = root.getObjectByName('street-util-decals');
  const drainBuilder = new MeshBuilder();
  const drainY = ground(yardFrame, 21.98, -28.35) + .017;
  for (const z0 of [-28.65, -28.35]) {
    const ids = [[21.87, z0, 0, 0], [22.09, z0, 1, 0],
      [22.09, z0 + .3, 1, 1], [21.87, z0 + .3, 0, 1]].map(([dx, dz, u, v]) =>
      drainBuilder.vert(dx, drainY, dz, ...uvOf(UTIL.drain, u, v)));
    drainBuilder.quad(...ids);
  }
  const drain = drainBuilder.mesh(utilityDecals.material,
    { name: 'toilet-east-short-covered-drain', renderOrder: utilityDecals.renderOrder });
  ctx.noOutline(drain);
  group.add(drain);
  instances.push({ id: drain.name, kind: 'coveredDrain', localPosition: [21.98, drainY, -28.35],
    triangles: 4, atlasRegion: 'st-util/drain', meshes: [drain],
    footprint: { type: 'decorative', x: 21.98, z: -28.35, width: .22, depth: .6,
      rotationY: 0, y0: drainY, y1: drainY } });
  // Vent/cover geometries join the station's normal batch/dispose ownership.
  // All three materials and the sticker geometry are borrowed from the same
  // station root, whose teardown deduplicates resources; no separate disposer.

  // E1 and W1 already have umbrella stands. Use the unwindowed south return
  // of E2 instead of filling another doorway: the original meter is deeper
  // along this wall at lot z=-3.2, while this front submeter reads from 01.
  const ef = L.lotFrame(L.lotById('E2'));
  const eastFrame = Frame.at(H.gb, ef.x, ef.y, ef.z, ef.rotY).sub(3.5, 0, -1.8, Math.PI / 2);
  H.P.elecMeter(eastFrame, 0, 1.05);
  const meterMeshes = H.gb.flush(group, 'e2-front-side-meter');
  const meterBody = addBox('e2-front-side-meter', eastFrame, 0, 0.0625, 0.24, 0.125, 0.87, 1.23);
  const meterPipe = addBox('e2-front-side-meter-pipe', eastFrame, 0.1, 0.03, 0.05, 0.05, 1.25, 2.55);
  const meterPosition = eastFrame.w(0, 1.05, 0.07);
  instances.push({ id: 'e2-front-side-meter', kind: 'elecMeter', lot: 'E2',
    lotPosition: [3.5, 1.05, -1.8], localPosition: meterPosition.toArray(),
    triangles: 36, atlasRegion: 'elec_meter', meshes: meterMeshes, footprint: meterBody, pipe: meterPipe });

  let triangles = 0;
  group.traverse(mesh => { if (mesh.isMesh) triangles +=
    (mesh.geometry.index?.count ?? mesh.geometry.attributes.position.count) / 3 * (mesh.isInstancedMesh ? mesh.count : 1); });
  return { root: group, instances, collisions, addedColliders: collisions.length,
    stats: { triangles, densityTriangles: 132, densityObjects: 4, densityColliders: 6,
      serviceDetailTriangles: 18, serviceDetailObjects: 3, serviceDetailColliders: 0,
      newTexturePixels: ctx.tex.pixels - texturePixelsBefore, coordinates: 'station-local; apply station.toWorld after placement' },
    views: { streetDetail: { position: [4.4, ctx.physics.groundHeight(4.4, 24) + 1.6, 24], target: meterPosition.toArray() } } };

}
