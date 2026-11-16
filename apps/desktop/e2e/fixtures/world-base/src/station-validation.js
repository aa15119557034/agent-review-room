import * as THREE from 'three';
import { lotById, lotFrame, lotToWorld } from '../upstream/sakuragaoka/src/world/layout.js';

/** Run against the built district, without keyboard events or an extra renderer.
 * Browser console: (await import('./src/station-validation.js')).validateStation(worldBase)
 * The real generated colliders and door update callbacks are the test subjects.
 */
export function validateStation({ station, walker, camera }) {
  if (!station || !walker || !camera) throw new Error('Build the station before validating it');
  const checks = [];
  const check = (name, passed, evidence) => checks.push({ name, passed: Boolean(passed), evidence });
  const saved = {
    enabled: walker.enabled, view: walker.view, feet: walker.worldPosition.clone(),
    yaw: walker.yaw * 180 / Math.PI, pitch: walker.pitch * 180 / Math.PI,
    cameraPosition: camera.position.clone(), cameraQuaternion: camera.quaternion.clone(),
    time: station.ctx.time, player: station.toWorld(station.ctx.player.position),
  };
  const lot = lotById('W1'), frame = lotFrame(lot);
  const floor = frame.y + 0.30;
  const localPoint = (x, z, y = floor) => {
    const point = lotToWorld(lot, x, z);
    return new THREE.Vector3(point.x, y, point.z);
  };
  const resolve = point => {
    const candidate = { x: point.x, z: point.z };
    station.physics.resolve(candidate, 0.3, point.y, 1.7);
    return { displacement: Math.hypot(candidate.x - point.x, candidate.z - point.z), candidate };
  };
  try {
    walker.setEnabled(false);
    // An invisible gate or a missing dynamic collider is detectable by probing
    // the exact same doorway after the actual proximity callbacks close/open it.
    const door = localPoint(1, -2.78);
    station.update(1, saved.time + 1, station.spawn);
    const closed = resolve(door);
    check('closed shop door blocks the walking capsule', closed.displacement > 0.30, closed);
    const approach = localPoint(1, -2.0);
    station.update(1, saved.time + 2, station.toWorld(approach));
    const opened = resolve(door);
    check('approaching opens the real shop door collider', opened.displacement < 1e-6, opened);
    const wall = resolve(localPoint(-3, -2.70));
    check('adjacent storefront wall remains solid', wall.displacement > 0.30, wall);
    let maxCorrection = 0, maxHeightError = 0;
    for (let step = 0; step <= 20; step++) {
      const point = localPoint(1, -2.0 - step * 0.1);
      maxCorrection = Math.max(maxCorrection, resolve(point).displacement);
      // Check the interior, avoiding the exterior entrance step by design.
      if (step >= 10) maxHeightError = Math.max(maxHeightError,
        Math.abs(station.physics.groundHeight(point.x, point.z, floor) - floor));
    }
    check('open entrance provides a continuous capsule-width passage', maxCorrection < 1e-5, { maxCorrection });
    check('interior floor uses its raised walkable surface', maxHeightError < 1e-6, { expectedFloor: floor, maxHeightError });

    const garden = lotById('W3'), gardenFrame = lotFrame(garden);
    const gardenPoint = (x, z) => {
      const point = lotToWorld(garden, x, z);
      return new THREE.Vector3(point.x,
        station.physics.groundHeight(point.x, point.z, gardenFrame.y + 0.5), point.z);
    };
    const route = gardenPoint(-4, 1.15);
    let routeFeet = route.y, minSidewalkZ = 1.15, maxSidewalkZ = 1.15, gateCorrection = 0;
    const c = Math.cos(gardenFrame.rotY), s = Math.sin(gardenFrame.rotY);
    // Advance from the previous resolved position, as real walking does, so
    // the capsule can slide around the existing bicycle and sign post.
    for (let step = 0; step < 80; step++) {
      const candidate = { x: route.x + c * 0.1, z: route.z - s * 0.1 };
      station.physics.resolve(candidate, 0.3, routeFeet, 1.7);
      routeFeet = station.physics.groundHeight(candidate.x, candidate.z, routeFeet);
      route.set(candidate.x, routeFeet, candidate.z);
      const localZ = (route.x - gardenFrame.x) * s + (route.z - gardenFrame.z) * c;
      minSidewalkZ = Math.min(minSidewalkZ, localZ); maxSidewalkZ = Math.max(maxSidewalkZ, localZ);
    }
    const endSidewalkX = (route.x - gardenFrame.x) * c - (route.z - gardenFrame.z) * s;
    for (let step = 0; step <= 32; step++) {
      gateCorrection = Math.max(gateCorrection, resolve(gardenPoint(-1.3, 1.15 - step * 0.05)).displacement);
    }
    check('W3 sidewalk walking clears existing furniture and new planters', endSidewalkX > 3.8 && minSidewalkZ >= 0.6 && maxSidewalkZ <= 1.3,
      { endLotX: endSidewalkX, minLotZ: minSidewalkZ, maxLotZ: maxSidewalkZ, radius: 0.3, step: 0.1, inputDistance: 8 });
    check('W3 planters leave the existing garden gate approach clear', gateCorrection < 1e-5, { maxCorrection: gateCorrection });
    const planterProbes = station.streetscape.instances.filter(item => item.kind === 'planter').map(item => {
      const bounds = item.footprint;
      const start = gardenPoint(item.lotPosition[0], 1.15);
      let feetY = start.y;
      const advance = z => {
        const point = lotToWorld(garden, item.lotPosition[0], z);
        const candidate = { x: point.x, z: point.z };
        station.physics.resolve(candidate, 0.3, feetY, 1.7);
        feetY = station.physics.groundHeight(candidate.x, candidate.z, feetY);
      };
      for (let step = 1; step <= 17; step++) advance(1.15 - step * 0.05);
      const onTop = feetY;
      for (let step = 16; step >= 0; step--) advance(1.15 - step * 0.05);
      return { id: item.id, expectedTop: bounds.y1, onTop, initialFeet: start.y, finalFeet: feetY,
        supported: Math.abs(onTop - bounds.y1) < 1e-6, returnedToSidewalk: Math.abs(feetY - start.y) < 1e-6 };
    });
    check('low planter tops support approaching feet and release them on exit',
      planterProbes.length === 2 && planterProbes.every(probe => probe.supported && probe.returnedToSidewalk), planterProbes);

    walker.setPose(station.spawn, 4, -8);
    walker.setEnabled(true);
    const before = walker.worldPosition.clone();
    walker.setView('first');
    const eye = before.clone().add(new THREE.Vector3(0, 1.52, 0));
    check('first person camera is 1.52m above world-space feet', camera.position.distanceTo(eye) < 1e-6,
      { feet: before.toArray(), camera: camera.position.toArray(), error: camera.position.distanceTo(eye) });
    walker.setView('third');
    const followDistance = camera.position.distanceTo(eye);
    check('third person camera follows within its obstruction-limited boom', followDistance > 0.11 && followDistance <= Math.hypot(4.2, 0.45) + 1e-6,
      { followDistance, maximum: Math.hypot(4.2, 0.45) });
    for (let index = 0; index < 10; index++) walker.setView(index % 2 ? 'third' : 'first');
    check('view switching preserves the body and collision position', walker.worldPosition.distanceTo(before) < 1e-10
      && station.toWorld(walker.position).distanceTo(before) < 1e-10,
    { feet: walker.worldPosition.toArray(), initialFeet: before.toArray() });
    const local = station.toLocal(before);
    check('station local/world coordinates round-trip at its nonzero placement', station.toWorld(local).distanceTo(before) < 1e-10,
      { local: local.toArray(), world: before.toArray() });

    // Stand outside the real W1 storefront, facing away. The chase boom points
    // back through its glass wall; its near plane must stay on the street side.
    // Replacing Mesh.raycast makes any accidental render-mesh traversal fail.
    const originalRaycast = THREE.Mesh.prototype.raycast;
    let raycastCalls = 0;
    THREE.Mesh.prototype.raycast = function () { raycastCalls++; throw new Error('Camera queried render triangles'); };
    try {
      const wallFeet = station.toWorld(localPoint(-3, -1.5));
      walker.setPose(wallFeet, -90, 0);
      walker.setView('third');
      const cameraLocal = station.toLocal(camera.position);
      const cameraLotZ = (cameraLocal.x - frame.x) * Math.sin(frame.rotY) + (cameraLocal.z - frame.z) * Math.cos(frame.rotY);
      const halfHeight = camera.near * Math.tan(THREE.MathUtils.degToRad(camera.getEffectiveFOV()) / 2);
      const clearance = Math.hypot(camera.near, halfHeight, halfHeight * camera.aspect) + 0.02;
      const wallEye = wallFeet.clone().add(new THREE.Vector3(0, 1.52, 0));
      const shortened = camera.position.distanceTo(wallEye);
      check('real shop wall shortens third-person boom with near-plane clearance', shortened < 1.2
        && cameraLotZ >= -2.60 + clearance - 1e-6,
      { shortened, cameraLotZ, streetSideWallZ: -2.60, clearance, raycastCalls });
      check('camera collision never scans rendered triangles', raycastCalls === 0, { raycastCalls });
    } finally { THREE.Mesh.prototype.raycast = originalRaycast; }
  } finally {
    walker.setEnabled(false);
    walker.setPose(saved.feet, saved.yaw, saved.pitch);
    walker.setView(saved.view);
    station.update(0, saved.time, saved.player);
    walker.setEnabled(saved.enabled);
    camera.position.copy(saved.cameraPosition);
    camera.quaternion.copy(saved.cameraQuaternion);
    camera.updateMatrixWorld();
  }
  return { ok: checks.every(item => item.passed), checks };
}
