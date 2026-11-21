import * as THREE from 'three';
import { STEP_HEIGHT } from '../upstream/sakuragaoka/src/core/physics.js';

// The same capsule, substeps, step threshold and gravity as upstream Player,
// with one removable input owner and a camera independent of the feet position.
export function createStationWalker(station, dom) {
  const physics = station.physics;
  const position = station.toLocal(station.spawn);
  const worldPosition = station.spawn.clone();
  const velocity = new THREE.Vector3();
  const keys = new Set();
  const listeners = new AbortController();
  const signal = listeners.signal;
  const camera = new THREE.PerspectiveCamera();
  const target = new THREE.Vector3(), desired = new THREE.Vector3();
  let enabled = false, disposed = false, mode = 'third', yaw = 4 * Math.PI / 180, pitch = -0.14;
  let verticalSpeed = 0, grounded = true, dragging = false, lastX = 0, lastY = 0;
  let indoorT = 0;          // 0..0.3 s，进店累加、出店递减
  let indoorBlend = 0, lastShot = null;
  const indoorPos = new THREE.Vector3(), indoorLook = new THREE.Vector3(), tmpQ = new THREE.Quaternion(), lookM = new THREE.Matrix4(), rawThird = new THREE.Vector3();
  const radius = 0.3, height = 1.7, eye = 1.52;
  const editable = target => target?.closest?.('input,select,textarea,[contenteditable="true"]');
  const clear = () => { keys.clear(); dragging = false; velocity.set(0, 0, 0); };
  window.addEventListener('keydown', event => {
    if (!enabled || editable(event.target)) return;
    keys.add(event.code);
    if (event.code === 'KeyV' && !event.repeat) walker.setView(mode === 'third' ? 'first' : 'third');
    if (event.code === 'Space') {
      event.preventDefault();
      if (!event.repeat && grounded) { verticalSpeed = 4.2; grounded = false; }
    }
  }, { signal });
  window.addEventListener('keyup', event => keys.delete(event.code), { signal });
  window.addEventListener('blur', clear, { signal });
  dom.addEventListener('pointerdown', event => {
    if (!enabled || event.button !== 0) return;
    dragging = true; lastX = event.clientX; lastY = event.clientY;
  }, { signal });
  window.addEventListener('pointerup', () => { dragging = false; }, { signal });
  window.addEventListener('pointermove', event => {
    if (!enabled) return;
    let dx = 0, dy = 0;
    if (document.pointerLockElement === dom) { dx = event.movementX; dy = event.movementY; }
    else if (dragging) { dx = event.clientX - lastX; dy = event.clientY - lastY; }
    lastX = event.clientX; lastY = event.clientY;
        if (indoorBlend < 0.5) yaw -= dx * 0.0022;   // 固定机位下不改 yaw
    pitch = THREE.MathUtils.clamp(pitch - dy * 0.0022, -1.2, 1.2);
  }, { signal });

  function syncCamera(dt = 0) {
    camera.rotation.set(pitch, yaw, 0, 'YXZ');
    target.copy(position); target.y += eye;
    camera.position.copy(target);
    if (mode === "third") {
      // No avatar mesh is created. This camera follows the same invisible body
      // as first person; switching views never teleports the body through a wall.
      desired.set(0, 0.45, 4.2).applyQuaternion(camera.quaternion).add(target);
      const view = station.camera;
      const halfHeight = view.near * Math.tan(THREE.MathUtils.degToRad(view.getEffectiveFOV()) / 2);
      const clearance = Math.hypot(view.near, halfHeight, halfHeight * view.aspect) + 0.02;
      const fraction = physics.sweepSphere(target, desired, clearance);
      camera.position.lerpVectors(target, desired, fraction);
      rawThird.copy(camera.position);          // 没夹过的第三人称位置 = 混合起点
      if (fraction > 1e-6) camera.lookAt(target);

      // 室内专用机位：进店切固定角度，进出都用 0.3 s 线性 + smoothstep
      let shotNow = null;
      if (station.indoorCamera) {
        shotNow = station.indoorCamera.pose(position);
        if (shotNow) lastShot = shotNow;
        if (dt > 0) {
          const dir = shotNow ? 1 : -1;
          indoorT = Math.min(0.3, Math.max(0, indoorT + dir * dt));
        }
        const u = indoorT / 0.3;
        indoorBlend = u * u * (3 - 2 * u);      // smoothstep
        const shot = shotNow ?? lastShot;
        if (indoorBlend > 1e-3 && shot) {
          indoorPos.set(shot.pos.x, shot.pos.y, shot.pos.z);
          indoorLook.set(shot.look.x, shot.look.y, shot.look.z);
          camera.position.copy(rawThird).lerp(indoorPos, indoorBlend);
          lookM.lookAt(indoorPos, indoorLook, THREE.Object3D.DEFAULT_UP);
          tmpQ.setFromRotationMatrix(lookM);
          camera.quaternion.slerp(tmpQ, indoorBlend);
        }
      }
      // 没有固定机位、或完全回到第三人称时，才用房间盒夹相机（兜底）
      if (station.clampCamera && indoorBlend <= 1e-3) {
        station.clampCamera(position, camera.position);
        if (fraction > 1e-6) camera.lookAt(target);
      }
    }
    station.cameraToWorld(camera.position, camera.quaternion);
  }

  const walker = {
    position, worldPosition,
    get enabled() { return enabled; },
    set enabled(value) { walker.setEnabled(value); },
    get view() { return mode; },
    get yaw() { return yaw; },
    get pitch() { return pitch; },
    setEnabled(value) {
      enabled = Boolean(value) && !disposed;
      if (!enabled) { clear(); indoorT = 0; indoorBlend = 0; lastShot = null; if (document.pointerLockElement === dom) document.exitPointerLock(); }
      else syncCamera();
    },
    setView(value) {
      if (value !== 'first' && value !== 'third') throw new Error(`Unknown station view: ${value}`);
      mode = value;
      if (mode === 'first') { indoorT = 0; indoorBlend = 0; lastShot = null; }
      if (enabled) syncCamera();
    },
    setPose(worldFeet, yawDegrees = 4, pitchDegrees = -8) {
      station.toLocal(worldFeet, position);
      yaw = yawDegrees * Math.PI / 180; pitch = pitchDegrees * Math.PI / 180;
      verticalSpeed = 0; clear();
      indoorT = 0; indoorBlend = 0; lastShot = null;   // setPose 是瞬移，机位状态重置
      station.toWorld(position, worldPosition);
      station.ctx.player.position.copy(position);
      if (enabled) syncCamera();
    },
    update(elapsed) {
      if (!enabled || disposed) return worldPosition;
      const dt = Math.min(Math.max(elapsed, 0), 0.05);
      let forward = Number(keys.has('KeyW') || keys.has('ArrowUp')) - Number(keys.has('KeyS') || keys.has('ArrowDown'));
      let sideways = Number(keys.has('KeyD') || keys.has('ArrowRight')) - Number(keys.has('KeyA') || keys.has('ArrowLeft'));
      const length = Math.hypot(forward, sideways);
      if (length > 1) { forward /= length; sideways /= length; }
      const speed = keys.has('ShiftLeft') || keys.has('ShiftRight') ? 6.4 : 3.1;
      // 固定机位下，WASD 相对机位方向（W = 朝画面里走）
      let moveYaw = yaw;
      if (indoorBlend > 0.5 && lastShot) {
        const fx = lastShot.look.x - lastShot.pos.x, fz = lastShot.look.z - lastShot.pos.z;
        if (Math.hypot(fx, fz) > 1e-4) moveYaw = Math.atan2(-fx, -fz);
      }
      const vx = (-Math.sin(moveYaw) * forward + Math.cos(moveYaw) * sideways) * speed;
      const vz = (-Math.cos(moveYaw) * forward - Math.sin(moveYaw) * sideways) * speed;
      const acceleration = Math.min(1, (grounded ? 10 : 2.5) * dt);
      velocity.x += (vx - velocity.x) * acceleration;
      velocity.z += (vz - velocity.z) * acceleration;
      const count = Math.max(1, Math.ceil(Math.hypot(velocity.x, velocity.z) * dt / 0.12));
      const next = { x: position.x, z: position.z };
      for (let index = 0; index < count; index++) {
        const x = next.x, z = next.z;
        next.x += velocity.x * dt / count; next.z += velocity.z * dt / count;
        physics.resolve(next, radius, position.y, height);
        if (physics.groundHeight(next.x, next.z, position.y) - position.y > STEP_HEIGHT) { next.x = x; next.z = z; }
      }
      position.x = next.x; position.z = next.z;
      if (station.clampWalkable) station.clampWalkable(position, radius);
      else {
        const bounds = station.bounds;
        position.x = THREE.MathUtils.clamp(next.x, bounds.x0 + radius, bounds.x1 - radius);
        position.z = THREE.MathUtils.clamp(next.z, bounds.z0 + radius, bounds.z1 - radius);
      }
      const ground = physics.groundHeight(position.x, position.z, position.y);
      verticalSpeed -= 12 * dt; position.y += verticalSpeed * dt;
      grounded = position.y <= ground || position.y - ground < 0.06 && verticalSpeed <= 0;
      if (grounded) { position.y = ground; verticalSpeed = 0; }
      station.toWorld(position, worldPosition);
      station.ctx.player.position.copy(position);
      syncCamera(dt);
      return worldPosition;
    },
    dispose() { if (!disposed) { walker.setEnabled(false); disposed = true; listeners.abort(); } },
  };
  return walker;
}


