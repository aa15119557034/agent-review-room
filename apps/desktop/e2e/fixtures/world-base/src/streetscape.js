import * as THREE from 'three';
import { Frame } from '../upstream/sakuragaoka/src/world/houses/gb.js';

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
  return { root: group, instances, collisions, addedColliders: collisions.length };
}
