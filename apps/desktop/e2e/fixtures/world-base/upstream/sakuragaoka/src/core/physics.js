// Simple, deterministic walking physics: oriented boxes, cylinders, walkable tops and ramps,
// terrain height function. Player = vertical capsule approximated by a circle in XZ.
import * as THREE from 'three';

const CELL = 8;
export const STEP_HEIGHT = 0.45;

export class Physics {
  constructor(heightAt) {
    this.heightAt = heightAt;
    this.grid = new Map();
    this.items = [];
    this.dynamic = [];
    this._dynItems = [];
  }
  _cells(minx, minz, maxx, maxz, fn) {
    const x0 = Math.floor(minx / CELL), x1 = Math.floor(maxx / CELL), z0 = Math.floor(minz / CELL), z1 = Math.floor(maxz / CELL);
    for (let ix = x0; ix <= x1; ix++) for (let iz = z0; iz <= z1; iz++) fn(ix + ',' + iz);
  }
  _insert(it) {
    this.items.push(it);
    const r = it.type === 'cyl' ? it.r : Math.hypot(it.hw, it.hd);
    this._cells(it.cx - r, it.cz - r, it.cx + r, it.cz + r, (k) => { let a = this.grid.get(k); if (!a) this.grid.set(k, (a = [])); a.push(it); });
    return it;
  }
  _obb(type, cx, cz, w, d, rotY, extra) {
    return { type, cx, cz, hw: w / 2, hd: d / 2, c: Math.cos(rotY), s: Math.sin(rotY), rotY, ...extra };
  }

  /** Solid oriented box: footprint w (local x) × d (local z) rotated by rotY about its centre; vertical range y0..y1. */
  addBox(cx, cz, w, d, rotY = 0, y0 = -50, y1 = 200) { return this._insert(this._obb('box', cx, cz, w, d, rotY, { y0, y1 })); }
  /** Solid axis-aligned box from min/max corners. */
  addAABB(minx, minz, maxx, maxz, y0 = -50, y1 = 200) { return this.addBox((minx + maxx) / 2, (minz + maxz) / 2, maxx - minx, maxz - minz, 0, y0, y1); }
  /** Solid vertical cylinder. */
  addCylinder(cx, cz, r, y0 = -50, y1 = 200) { return this._insert({ type: 'cyl', cx, cz, r, y0, y1 }); }
  /** Walkable flat top (floor, platform, step, bench-free deck). Blocks the player like a wall when
   *  its top is more than STEP_HEIGHT above the feet. bottom: y below which it no longer blocks. */
  addWalkBox(cx, cz, w, d, rotY, topY, bottom = -50) { return this._insert(this._obb('walk', cx, cz, w, d, rotY, { top: topY, y0: bottom })); }
  /** Walkable ramp: local z from -d/2 (height yA) to +d/2 (height yB). */
  addWalkRamp(cx, cz, w, d, rotY, yA, yB) { return this._insert(this._obb('ramp', cx, cz, w, d, rotY, { yA, yB, y0: Math.min(yA, yB) - 50 })); }
  /** Stairs helper: n steps rising along local +z from y0 to y1 inside footprint (w × d). */
  addStairs(cx, cz, w, d, rotY, y0, y1, n) {
    const c = Math.cos(rotY), s = Math.sin(rotY);
    for (let i = 0; i < n; i++) {
      const lz = -d / 2 + d * (i + 0.5) / n;
      this.addWalkBox(cx + lz * s, cz + lz * c, w, d / n, rotY, y0 + (y1 - y0) * (i + 1) / n);
    }
  }
  /** Solid box from an Object3D's world-space AABB (call after positioning it). pad expands XZ. */
  addFromObject(obj, pad = 0) {
    obj.updateWorldMatrix(true, true);
    const b = new THREE.Box3().setFromObject(obj);
    if (b.isEmpty()) return null;
    return this.addAABB(b.min.x - pad, b.min.z - pad, b.max.x + pad, b.max.z + pad, b.min.y, b.max.y);
  }
  /** Moving colliders: fn() returns an array of {cx,cz,w,d,rotY,y0,y1} each frame. */
  addDynamic(fn) { this.dynamic.push(fn); }

  _local(it, x, z) { const dx = x - it.cx, dz = z - it.cz; return [dx * it.c - dz * it.s, dx * it.s + dz * it.c]; }
  _query(x, z, r) {
    const out = new Set();
    this._cells(x - r, z - r, x + r, z + r, (k) => { const a = this.grid.get(k); if (a) for (const it of a) out.add(it); });
    for (const it of this._dynItems) out.add(it);
    return out;
  }
  refreshDynamic() {
    this._dynItems.length = 0;
    for (const fn of this.dynamic) { const arr = fn() || []; for (const b of arr) this._dynItems.push(this._obb('box', b.cx, b.cz, b.w, b.d, b.rotY || 0, { y0: b.y0 ?? -50, y1: b.y1 ?? 200 })); }
  }

  /** Surface height under (x,z) for feet at feetY (highest walkable top not above feet+STEP). */
  groundHeight(x, z, feetY = 1e9) {
    let g = this.heightAt(x, z);
    for (const it of this._query(x, z, 0.01)) {
      if (it.type !== 'walk' && it.type !== 'ramp') continue;
      const [lx, lz] = this._local(it, x, z);
      if (Math.abs(lx) > it.hw || Math.abs(lz) > it.hd) continue;
      const top = it.type === 'walk' ? it.top : it.yA + (it.yB - it.yA) * (lz / (2 * it.hd) + 0.5);
      if (top <= feetY + STEP_HEIGHT && top > g) g = top;
    }
    return g;
  }

  /** Sweep the camera's bounding sphere through the existing collision world.
   * Returns a segment fraction, including 0 if the start already overlaps.
   * Expanded slabs are conservative at box/cylinder edges: they stop slightly
   * early at corners, never let the near plane cross through them.
   */
  sweepSphere(from, to, radius) {
    const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
    let fraction = 1;
    const candidates = this._query((from.x + to.x) / 2, (from.z + to.z) / 2,
      Math.max(Math.abs(dx), Math.abs(dz)) / 2 + radius);
    for (const it of candidates) {
      let enter = 0, leave = fraction;
      // Intersect the segment interval with a linear slab, including parallel
      // segments and initial overlap. All coordinates remain district-local.
      const slab = (start, delta, low, high) => {
        if (Math.abs(delta) < 1e-12) return start >= low && start <= high;
        let a = (low - start) / delta, b = (high - start) / delta;
        if (a > b) [a, b] = [b, a];
        enter = Math.max(enter, a); leave = Math.min(leave, b);
        return enter <= leave;
      };
      if (it.type === 'cyl') {
        if (!slab(from.y, dy, it.y0 - radius, it.y1 + radius)) continue;
        const x = from.x - it.cx, z = from.z - it.cz, r = it.r + radius;
        const a = dx * dx + dz * dz, b = 2 * (x * dx + z * dz), c = x * x + z * z - r * r;
        if (a < 1e-12) { if (c > 0) continue; }
        else {
          const disc = b * b - 4 * a * c;
          if (disc < 0) continue;
          const root = Math.sqrt(disc);
          enter = Math.max(enter, (-b - root) / (2 * a));
          leave = Math.min(leave, (-b + root) / (2 * a));
          if (enter > leave) continue;
        }
      } else {
        const [x, z] = this._local(it, from.x, from.z);
        const vx = dx * it.c - dz * it.s, vz = dx * it.s + dz * it.c;
        if (!slab(x, vx, -it.hw - radius, it.hw + radius)
          || !slab(z, vz, -it.hd - radius, it.hd + radius)) continue;
        if (it.type === 'ramp') {
          const slope = (it.yB - it.yA) / (2 * it.hd);
          const mid = (it.yA + it.yB) / 2;
          if (!slab(from.y, dy, it.y0 - radius, Infinity)
            || !slab(from.y - slope * z, dy - slope * vz, -Infinity,
              mid + radius * Math.hypot(1, slope))) continue;
        } else {
          const top = it.type === 'walk' ? it.top : it.y1;
          if (!slab(from.y, dy, it.y0 - radius, top + radius)) continue;
        }
      }
      fraction = Math.min(fraction, Math.max(0, enter));
      if (fraction === 0) return 0;
    }
    // Analytic terrain has no triangles/colliders in the grid. Search only the
    // short boom segment at 10cm spatial intervals, then refine first contact.
    // This is per-query spatial subdivision, not skipped frames or a cache.
    const length = Math.hypot(dx, dy, dz);
    const steps = Math.max(1, Math.ceil(length * fraction / 0.1));
    const clear = t => from.y + dy * t - radius > this.heightAt(from.x + dx * t, from.z + dz * t);
    if (!clear(0)) return 0;
    let previous = 0;
    for (let index = 1; index <= steps; index++) {
      const t = fraction * index / steps;
      if (!clear(t)) {
        let low = previous, high = t;
        for (let n = 0; n < 12; n++) { const mid = (low + high) / 2; if (clear(mid)) low = mid; else high = mid; }
        return low;
      }
      previous = t;
    }
    return fraction;
  }

  /** Push circle (x,z,r) out of solids overlapping the vertical span [feetY, feetY+height]. Mutates p. */
  resolve(p, r, feetY, height) {
    for (let iter = 0; iter < 3; iter++) {
      let moved = false;
      for (const it of this._query(p.x, p.z, r + 0.5)) {
        let y0, y1;
        if (it.type === 'box') { y0 = it.y0; y1 = it.y1; if (feetY + STEP_HEIGHT >= y1 || feetY + height <= y0) continue; }
        else if (it.type === 'cyl') { if (feetY + STEP_HEIGHT >= it.y1 || feetY + height <= it.y0) continue; }
        else if (it.type === 'walk') { if (it.top <= feetY + STEP_HEIGHT || feetY + height <= it.y0) continue; }
        else if (it.type === 'ramp') {
          // blocks only where the ramp surface is far above feet
          const [lx, lz] = this._local(it, p.x, p.z);
          const lzC = Math.max(-it.hd, Math.min(it.hd, lz));
          const top = it.yA + (it.yB - it.yA) * (lzC / (2 * it.hd) + 0.5);
          if (top <= feetY + STEP_HEIGHT) continue;
        }
        if (it.type === 'cyl') {
          const dx = p.x - it.cx, dz = p.z - it.cz, d = Math.hypot(dx, dz), m = r + it.r;
          if (d < m) { const k = d > 1e-6 ? (m - d) / d : 0; p.x += dx * k; p.z += dz * k; if (d <= 1e-6) p.x += m; moved = true; }
          continue;
        }
        const [lx, lz] = this._local(it, p.x, p.z);
        const qx = Math.max(-it.hw, Math.min(it.hw, lx)), qz = Math.max(-it.hd, Math.min(it.hd, lz));
        let dx = lx - qx, dz = lz - qz, d = Math.hypot(dx, dz);
        let nx, nz, pen;
        if (d > 1e-6) { if (d >= r) continue; nx = dx / d; nz = dz / d; pen = r - d; }
        else { // centre inside: push out along the smallest axis
          const ex = it.hw - Math.abs(lx), ez = it.hd - Math.abs(lz);
          if (ex < ez) { nx = Math.sign(lx) || 1; nz = 0; pen = ex + r; } else { nx = 0; nz = Math.sign(lz) || 1; pen = ez + r; }
        }
        // local -> world (inverse rotation)
        const wx = nx * it.c + nz * it.s, wz = -nx * it.s + nz * it.c;
        p.x += wx * pen; p.z += wz * pen; moved = true;
      }
      if (!moved) break;
    }
    return p;
  }

  get count() { return this.items.length; }
}
