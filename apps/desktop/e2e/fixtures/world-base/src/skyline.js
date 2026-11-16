import * as THREE from 'three';
import { buildApartment } from '../upstream/sakuragaoka/src/world/houses/apartment.js';
import { GB, Frame } from '../upstream/sakuragaoka/src/world/houses/gb.js';
import { makeProps } from '../upstream/sakuragaoka/src/world/houses/props.js';
import { Laundry } from '../upstream/sakuragaoka/src/world/houses/laundry.js';

// Original 17 x 10.8 m, two-storey apartment: no stretched storeys or proxy boxes.
// Two adjacent south-facing lots step back along the existing northern levee.
const LOT = { width: 17, depth: 10.8 };
const FOOTPRINT = { width: 18.4, depth: 12.2 }; // includes eaves/props outside the lot
const MAX_RELIEF = 1.2;
const SITES = [
  { name: 'apartment-corridor', rotation: 0, candidates: [[-18, -104]] },
  { name: 'apartment-balconies', rotation: 0, candidates: [[-38, -109]] },
];

/** Background only. The station owns all borrowed textures; dispose this first.
 * Real terrain is sampled before building; no island edit or physics registration.
 */
export function createSkyline({ scene, station, island }) {
  const source = station.ctx.services.houses.buildContext;
  if (!source) throw new Error('Build station houses before skyline');
  station.root.updateWorldMatrix(true, false);
  scene.updateWorldMatrix(true, false);
  const matrix = station.root.matrixWorld.clone(), inverse = matrix.clone().invert();
  const position = new THREE.Vector3(), rotation = new THREE.Quaternion(), scale = new THREE.Vector3();
  matrix.decompose(position, rotation, scale);
  if (new THREE.Vector3(0, 1, 0).applyQuaternion(rotation).distanceTo(new THREE.Vector3(0, 1, 0)) > 1e-6 || scale.distanceTo(new THREE.Vector3(1, 1, 1)) > 1e-6) {
    throw new Error('Skyline placement requires station translation/yaw without scale or tilt');
  }
  const heightAt = (x, z) => {
    const p = new THREE.Vector3(x, 0, z).applyMatrix4(matrix);
    p.y = island.heightAt(p.x, p.z);
    if (!Number.isFinite(p.y)) throw new Error('Non-finite island height under skyline');
    return p.applyMatrix4(inverse).y;
  };
  const placements = [], rejected = [];
  for (const spec of SITES) {
    let selected;
    for (const [x, z] of spec.candidates) {
      const frame = Frame.at(null, x, 0, z, spec.rotation);
      const corners = [[-1,-1],[1,-1],[1,1],[-1,1]].map(([a,b]) => frame.w(a * FOOTPRINT.width / 2, 0, b * FOOTPRINT.depth / 2));
      const bounds = new THREE.Box3().setFromPoints(corners);
      if (bounds.max.z >= station.bounds.z0) throw new Error('Apartment footprint entered the station');
      if (placements.some(p => { const b = p.footprint.localBounds; return bounds.min.x < b.maxX && bounds.max.x > b.minX && bounds.min.z < b.maxZ && bounds.max.z > b.minZ; })) {
        rejected.push({ name: spec.name, local: [x,z], reason: 'overlapping apartment footprints' }); continue;
      }
      let min = Infinity, max = -Infinity;
      const nx = Math.ceil(FOOTPRINT.width), nz = Math.ceil(FOOTPRINT.depth);
      for (let j = 0; j <= nz; j++) for (let i = 0; i <= nx; i++) {
        const p = frame.w(FOOTPRINT.width * (i / nx - 0.5), 0, FOOTPRINT.depth * (j / nz - 0.5));
        const y = heightAt(p.x, p.z); min = Math.min(min, y); max = Math.max(max, y);
      }
      if (max - min > MAX_RELIEF) { rejected.push({ name: spec.name, local: [x,z], reason: 'terrain relief exceeds short-foundation budget', relief: max-min }); continue; }
      selected = { name: spec.name, local: [x,0,z], world: frame.w(0,heightAt(x,z),0).applyMatrix4(matrix).toArray(), rotation: spec.rotation, scale: 1,
        footprint: { ...FOOTPRINT, lot: { ...LOT }, localBounds: { minX: bounds.min.x, maxX: bounds.max.x, minZ: bounds.min.z, maxZ: bounds.max.z }, worldCorners: corners.map(p => { const w = p.applyMatrix4(matrix); return [w.x,w.z]; }) },
        heights: { min: min + position.y, max: max + position.y, relief: max-min, samples: (nx+1)*(nz+1), maximumSampleSpacing: Math.max(FOOTPRINT.width/nx,FOOTPRINT.depth/nz) } };
      break;
    }
    if (!selected) { const error = new Error('No safe short-foundation site for '+spec.name+'; skyline was not attached'); error.placementAttempts = rejected; throw error; }
    placements.push(selected);
  }
  const root = new THREE.Group(); root.name = 'station-background-skyline'; root.userData.walkable = false;
  root.matrix.copy(scene.matrixWorld.clone().invert().multiply(matrix)); root.matrixAutoUpdate = false; root.matrixWorldNeedsUpdate = true;
  const ownedMaterials = new Set(), geometries = new Set(), clones = new Map();
  const cacheSize = station.ctx.tex.cache.size, pixels = station.ctx.tex.pixels;
  const clone = material => {
    if (!clones.has(material)) {
      const copy = material.clone();
      // clone() omits these hooks. Preserve original paint/glass/foliage shaders,
      // but detach hardware clipping; never change a source material/uniform.
      copy.onBeforeCompile = material.onBeforeCompile;
      copy.customProgramCacheKey = material.customProgramCacheKey;
      copy.clippingPlanes = null; copy.clipIntersection = false; copy.clipShadows = false;
      clones.set(material,copy); ownedMaterials.add(copy);
    }
    return clones.get(material);
  };
  let suppressedPhysicsCalls = 0;
  const backgroundPhysics = { addBox(){suppressedPhysicsCalls++;}, addCylinder(){suppressedPhysicsCalls++;}, addWalkBox(){suppressedPhysicsCalls++;}, addWalkRamp(){suppressedPhysicsCalls++;} };
  const ctx = { ...station.ctx, physics: backgroundPhysics, add: object => root.add(object) };
  const gb = new GB(ctx);
  const M = new Proxy(source.M, { get(target,key) { const material = target[key]; return material?.isMaterial ? clone(material) : material; } });
  const H = backgroundContext(source, ctx, gb, M, heightAt);
  const vegetationClearAreas = placements.map(p => clearArea(p.name + '-yard', p.footprint.localBounds));
  const approaches = [];
  const ground = visibleBankHeight(station, island, matrix, inverse, heightAt);
  try {
    for (const placement of placements) {
      const [x,,z] = placement.local;
      const centred = Frame.at(gb,x,0,z,placement.rotation);
      const F = centred.sub(0,0,LOT.depth/2);
      // Same six support samples used by upstream buildApartment; floor remains
      // 0.35m above their maximum, foundation extends 0.14m below their minimum.
      const bx0 = -LOT.width/2+2.6, bx1 = LOT.width/2-0.5;
      const support = [[bx0,-8.6],[bx1,-8.6],[bx0,-2.6],[bx1,-2.6],[bx0-1.3,-9.85],[bx1,-9.85]].map(([a,b]) => H.gy(F,a,b));
      const floor = Math.max(...support)+0.35, bottom = Math.min(...support)-0.14;
      if (floor + position.y < placement.heights.max) throw new Error('Apartment floor would intersect sampled terrain');
      Object.assign(placement.heights, { foundationTop: floor+position.y, foundationBottom: bottom+position.y, foundationHeight: floor-bottom });
      const before = gb.tris;
      buildApartment(H,F,LOT.width,LOT.depth,ctx.rng('skyline-'+placement.name));
      placement.staticTriangles = gb.tris-before;
    }
    for (const placement of placements) {
      const approach = buildApproach(H, placement, station.bounds.z0, ground);
      approaches.push(approach);
      vegetationClearAreas.push(clearArea(placement.name + '-approach', approach.bounds));
    }
    gb.flush(root,'skyline-apartments');
    const laundry = H.laundry.build();
    if (laundry) { ownedMaterials.add(laundry.material); ownedMaterials.add(laundry.customDepthMaterial); }
    root.traverse(object => { if (object.isMesh) { geometries.add(object.geometry); object.castShadow = false; object.userData.walkable = false; } });
    if (station.ctx.tex.cache.size !== cacheSize || station.ctx.tex.pixels !== pixels) throw new Error('Skyline unexpectedly generated textures');
    scene.add(root); root.updateWorldMatrix(true,true);
  } catch (error) {
    root.traverse(object => { if (object.isMesh) geometries.add(object.geometry); });
    for (const geometry of geometries) geometry.dispose();
    for (const material of ownedMaterials) material.dispose();
    throw error;
  }
  let drawCalls = 0, triangles = 0;
  root.traverse(object => { if (object.isMesh) { drawCalls++; triangles += object.geometry.index.count/3; } });
  let disposed = false;
  return { root, placements, approaches, vegetationClearAreas,
    stats: { groups: placements.length, drawCalls, triangles, castShadowDraws: 0, materials: ownedMaterials.size, geometries: geometries.size, laundryItems: H.laundry.count, rejected,
      textureCacheEntriesAdded: station.ctx.tex.cache.size-cacheSize, texturePixelsAdded: station.ctx.tex.pixels-pixels, maxAllowedTerrainRelief: MAX_RELIEF, suppressedPhysicsCalls,
      ownership: 'Own GB output, laundry geometry and cloned/new materials. Borrow station maps/atlases/gradientMap; upstream raw/prototype caches stay module-owned. Dispose skyline before station.',
      limitation: 'Original apartment proportions; <=1m site sampling, <=0.1m stair support checks. No physics/terrain edit; caller applies the returned local vegetation rectangles. GPU cost/composition require rendering.' },
    dispose() { if (disposed) return; disposed = true; root.removeFromParent(); for (const geometry of geometries) geometry.dispose(); for (const material of ownedMaterials) material.dispose(); },
  };
}


// Rectangles already include this thin margin; callers should not expand twice.
function clearArea(name, bounds) {
  const edge = 0.25;
  return { name, minX: bounds.minX-edge, maxX: bounds.maxX+edge, minZ: bounds.minZ-edge, maxZ: bounds.maxZ+edge, edge };
}

function visibleBankHeight(station, island, matrix, inverse, heightAt) {
  // Inside the core, the visible levee is Sakuragaoka's original surface. In
  // the narrow join, sample its actual triangles, not the hidden island ground.
  island.transition.updateWorldMatrix(true, false);
  const ray = new THREE.Raycaster(), down = new THREE.Vector3(0,-1,0);
  const z0 = station.bounds.z0, width = island.stats.transition.width;
  return (x,z) => {
    if (z >= z0) return station.ctx.services.houses.buildContext.L.heightAt(x,z);
    if (z <= z0-width) return heightAt(x,z);
    const world = new THREE.Vector3(x,0,z).applyMatrix4(matrix);
    world.y = Math.max(world.y, island.heightAt(world.x,world.z))+100;
    ray.set(world,down);
    const hit = ray.intersectObject(island.transition,false)[0];
    if (!hit) throw new Error('Missing visible ground transition under apartment approach');
    return hit.point.clone().applyMatrix4(inverse).y;
  };
}

function buildApproach(H, placement, boundaryZ, ground) {
  const { M, L } = H, frame = Frame.at(H.gb,0,0,0);
  // Apartment's original west-side entrance path is centred at bx0 - 0.68.
  const x = placement.local[0]-6.58, doorZ = placement.local[2]+LOT.depth/2;
  const r5 = L.ROADS.R5, width = 2.2; // original small levee staircase width
  const southZ = r5.z-r5.halfW-0.03, flightZ = southZ-0.72;
  const northZ = boundaryZ-1.35;
  const upperY = r5.y+0.03;
  const lowerY = Math.max(ground(x-width/2,northZ),ground(x,northZ),ground(x+width/2,northZ))+0.035;
  const drop = upperY-lowerY, steps = Math.ceil(drop/(3.2/18)); // original levee rise
  if (!(drop > 0 && drop < 2.2 && northZ > doorZ)) throw new Error('Unsafe short levee approach dimensions');
  const rise = drop/steps, tread = (flightZ-northZ)/steps;
  if (tread < 0.25) throw new Error('Levee approach would need undersized treads');
  let maxSupportHeight = 0;
  const supports = [];
  const block = (za,zb,top,nosing) => {
    let min = Infinity, max = -Infinity;
    const nx = Math.ceil(width/0.1), nz = Math.ceil((za-zb)/0.1);
    for (let j=0;j<=nz;j++) for (let i=0;i<=nx;i++) {
      const y = ground(x-width/2+width*i/nx,zb+(za-zb)*j/nz);
      min = Math.min(min,y); max = Math.max(max,y);
    }
    if (top < max-1e-5) throw new Error('Levee stair tread intersects the visible bank');
    const bottom = min-0.08;
    maxSupportHeight = Math.max(maxSupportHeight,top-bottom);
    frame.boxB(M.concrete,'#d4d0c5',width,top-bottom,za-zb,x,bottom,(za+zb)/2,{uv:{world:2}});
    if (nosing) frame.box(M.plain,'#bdb9ad',width,0.012,0.04,x,top+0.006,zb+0.02);
    supports.push({ southZ:za, northZ:zb, top, bottom, groundMin:min, groundMax:max });
  };
  block(southZ,flightZ,upperY,false);
  for (let i=0;i<steps;i++) block(flightZ-i*tread,flightZ-(i+1)*tread,upperY-(i+1)*rise,true);
  // Short terrain-following concrete path; taper from the 2.2m stairs to the
  // existing 1.4m apartment entrance. It ends at the original courtyard edge.
  const n = Math.ceil((northZ-doorZ)/0.25);
  for (let i=0;i<n;i++) {
    const za = northZ+(doorZ-northZ)*i/n, zb = northZ+(doorZ-northZ)*(i+1)/n;
    const wa = THREE.MathUtils.lerp(width,1.4,i/n), wb = THREE.MathUtils.lerp(width,1.4,(i+1)/n);
    const points = [[x-wa/2,za],[x+wa/2,za],[x+wb/2,zb],[x-wb/2,zb]].map(([a,b]) => [a,ground(a,b)+0.035,b]);
    const normal = new THREE.Vector3().crossVectors(new THREE.Vector3().fromArray(points[1]).sub(new THREE.Vector3().fromArray(points[0])),new THREE.Vector3().fromArray(points[3]).sub(new THREE.Vector3().fromArray(points[0]))).normalize();
    H.quads(frame,M.concrete,'#c9c7c0',[{p:points,n:normal.toArray(),uv:points.map(p=>[p[0]/2,-p[2]/2])}],{shadow:false});
  }
  return { name: placement.name, bounds: {minX:x-width/2,maxX:x+width/2,minZ:doorZ,maxZ:southZ},
    stairs: { width, steps, rise, tread, upperY, lowerY, drop, maxSupportHeight, supports },
    path: { length:northZ-doorZ, widthAtDoor:1.4 }, walkable:false };
}

// These small terrain/quad helpers follow houses.js. Its original closures capture
// the station H/GB/physics, so they cannot safely be borrowed for this independent GB.
function backgroundContext(source, ctx, gb, M, heightAt) {
  const L = { ...source.L, heightAt }, tex = source.tex;
  const H = { ctx, L, M, tex, A: source.A, gb, slab: source.slab, poly: source.poly, blobRaw: source.blobRaw, lod: 2, bnd: source.bnd, antennaAz: source.antennaAz, dishAz: source.dishAz };
  H.gy = (fr,x,z) => { const p = fr.w(x,0,z); return heightAt(p.x,p.z)-p.y; };
  // Deliberately non-walkable scenery; apartment's direct physics calls also use
  // the isolated backgroundPhysics service above.
  H.col = () => ctx.physics.addBox();
  H.colC = () => ctx.physics.addCylinder();
  H.walk = () => ctx.physics.addWalkBox();
  H.P = H.props = makeProps(H); H.laundry = new Laundry(H);
  const quadsMesh = (fr, mat, col, quads, fl) => {
    const P = [], N = [], U = [], I = [];
    for (const q of quads) {
      const k = P.length / 3;
      for (let i = 0; i < 4; i++) { P.push(...q.p[i]); N.push(...q.n); U.push(...(q.uv ? q.uv[i] : [0, 0])); }
      const a = q.p[0], b = q.p[1], c = q.p[2];
      const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const cx = e1[1] * e2[2] - e1[2] * e2[1], cy = e1[2] * e2[0] - e1[0] * e2[2], cz = e1[0] * e2[1] - e1[1] * e2[0];
      if (cx * q.n[0] + cy * q.n[1] + cz * q.n[2] >= 0) I.push(k, k + 1, k + 2, k, k + 2, k + 3); else I.push(k, k + 2, k + 1, k, k + 3, k + 2);
    }
    if (quads.length) gb.mesh(mat, col, P, N, U, I, fr.M(0, 0, 0), fl);
  };
  H.quads = quadsMesh;
  /** wall along local x (a..b) at z whose top follows the ground (+h); bottom at ground-0.3 or ground+base */
  H.slopedWall = (fr, a, b, z, h, t, mat, col, uS, vS, base) => {
    const L2 = b - a; if (L2 <= 0.01) return;
    const n = Math.max(1, Math.ceil(L2 / 2.5));
    const quads = [];
    const z0 = z - t / 2, z1 = z + t / 2;
    for (let i = 0; i < n; i++) {
      const x0 = a + L2 * i / n, x1 = a + L2 * (i + 1) / n;
      const g0 = H.gy(fr, x0, z), g1 = H.gy(fr, x1, z);
      const bo = base === undefined ? -0.3 : base;
      const b0 = g0 + bo, b1 = g1 + bo, t0 = g0 + h, t1 = g1 + h;
      const uv = (x, dy) => (uS ? [x / uS, dy / vS] : [0.5, 0.5]);
      quads.push({ p: [[x0, b0, z1], [x1, b1, z1], [x1, t1, z1], [x0, t0, z1]], n: [0, 0, 1], uv: [uv(x0, bo), uv(x1, bo), uv(x1, h), uv(x0, h)] });
      quads.push({ p: [[x1, b1, z0], [x0, b0, z0], [x0, t0, z0], [x1, t1, z0]], n: [0, 0, -1], uv: [uv(-x1, bo), uv(-x0, bo), uv(-x0, h), uv(-x1, h)] });
      quads.push({ p: [[x0, t0, z1], [x1, t1, z1], [x1, t1, z0], [x0, t0, z0]], n: [0, 1, 0], uv: [uv(x0, 0), uv(x1, 0), uv(x1, t), uv(x0, t)] });
      if (i === 0) quads.push({ p: [[x0, b0, z0], [x0, b0, z1], [x0, t0, z1], [x0, t0, z0]], n: [-1, 0, 0], uv: [uv(0, bo), uv(t, bo), uv(t, h), uv(0, h)] });
      if (i === n - 1) quads.push({ p: [[x1, b1, z1], [x1, b1, z0], [x1, t1, z0], [x1, t1, z1]], n: [1, 0, 0], uv: [uv(0, bo), uv(t, bo), uv(t, h), uv(0, h)] });
    }
    quadsMesh(fr, mat, col, quads);
  };
  /** terrain-following ground cover rectangle in frame-local coords; world-space UVs (uvS m per repeat) */
  H.groundRect = (fr, x0, z0, x1, z1, mat, col, lift = 0.02, uvS = 2) => {
    if (x1 - x0 < 0.05 || z1 - z0 < 0.05) return;
    const nx = Math.max(1, Math.ceil((x1 - x0) / 2.2)), nz = Math.max(1, Math.ceil((z1 - z0) / 2.2));
    const P = [], N = [], U = [], I = [];
    for (let j = 0; j <= nz; j++) for (let i = 0; i <= nx; i++) {
      const x = x0 + (x1 - x0) * i / nx, z = z0 + (z1 - z0) * j / nz;
      const w = fr.w(x, 0, z);
      P.push(x, L.heightAt(w.x, w.z) - w.y + lift, z); N.push(0, 1, 0); U.push(w.x / uvS, -w.z / uvS);
    }
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) { const a = j * (nx + 1) + i, b = a + 1, c = a + nx + 1, d = c + 1; I.push(a, c, b, b, c, d); }
    gb.mesh(mat, col, P, N, U, I, fr.M(0, 0, 0), { shadow: false });
  };
  /** decal quad (moss / streak / crack / dirt / stain) facing +z of fr, or on the floor */
  H.decal = (fr, name, x, y, w, h, z, col, o = {}) => {
    const rc = tex.decal.rects[name]; if (!rc) return;
    const uv = [[rc[0], rc[1]], [rc[2], rc[1]], [rc[2], rc[3]], [rc[0], rc[3]]];
    if (o.floor) {
      const zz = o.z, g = (xx, zv) => (o.gy ? o.gy(xx, zv) : H.gy(fr, xx, zv)) + 0.066;
      quadsMesh(fr, M.decal, col, [{ p: [[x - w / 2, g(x - w / 2, zz + h / 2), zz + h / 2], [x + w / 2, g(x + w / 2, zz + h / 2), zz + h / 2], [x + w / 2, g(x + w / 2, zz - h / 2), zz - h / 2], [x - w / 2, g(x - w / 2, zz - h / 2), zz - h / 2]], n: [0, 1, 0], uv }], { shadow: false, noOutline: true });
      return;
    }
    quadsMesh(fr, M.decal, col, [{ p: [[x - w / 2, y - h / 2, z], [x + w / 2, y - h / 2, z], [x + w / 2, y + h / 2, z], [x - w / 2, y + h / 2, z]], n: [0, 0, 1], uv }], { shadow: false, noOutline: true });
  };
  /** see-through wire mesh panel between a..b at z (alpha) */
  H.meshPanel = (fr, a, b, z, y0, y1, col) => {
    const rc = tex.decal.rects.mesh;
    const n = Math.max(1, Math.round((b - a) / 1.0));
    const quads = [];
    for (let i = 0; i < n; i++) {
      const x0 = a + (b - a) * i / n, x1 = a + (b - a) * (i + 1) / n;
      const g0 = H.gy(fr, x0, z), g1 = H.gy(fr, x1, z);
      const rep = (y1 - y0) / (x1 - x0);
      quads.push({ p: [[x0, g0 + y0, z], [x1, g1 + y0, z], [x1, g1 + y1, z], [x0, g0 + y1, z]], n: [0, 0, 1], uv: [[rc[0], rc[1]], [rc[2], rc[1]], [rc[2], rc[3]], [rc[0], rc[3]]] });
    }
    quadsMesh(fr, M.meshFence, col, quads, { shadow: false, noOutline: true });
  };

  return H;
}
