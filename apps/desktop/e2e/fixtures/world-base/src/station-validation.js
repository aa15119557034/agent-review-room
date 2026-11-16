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
