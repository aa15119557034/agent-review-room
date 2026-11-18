import * as THREE from 'three';

// Round 22 (#254 X-51): procedural posters, stickers and marker doodles. One 1024x1024 canvas atlas,
// one merged mesh (one draw call), placed by raycasting onto flat, free wall areas of already
// weathered materials. Nothing here is taken from any game: shapes, palettes and pseudo-lettering
// are drawn from scratch with a seeded random generator.

const PALETTE = ['#c8f400', '#ff3d8b', '#19d3ff', '#ff8a1f', '#ffe21a', '#8a4dff', '#ff3b30', '#f4f1e8'];
const INK = '#1b1a24';
const CELL = 256;

function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// Pseudo letters: 2-4 strokes picked from a 7-point grid, so lines of text read as writing without being words.
function glyphRow(g, r, x, y, w, h, color, count) {
  const gw = w / count;
  g.strokeStyle = color; g.lineWidth = Math.max(2, h * 0.16); g.lineCap = 'square';
  for (let i = 0; i < count; i++) {
    if (r() < 0.14) continue;
    const x0 = x + i * gw + gw * 0.12, x1 = x + (i + 1) * gw - gw * 0.12, y0 = y, y1 = y + h, ym = y + h / 2;
    const pts = [[x0, y0], [x1, y0], [x0, ym], [x1, ym], [x0, y1], [x1, y1]];
    const strokes = 2 + Math.floor(r() * 3);
    g.beginPath();
    for (let k = 0; k < strokes; k++) {
      const a = pts[Math.floor(r() * pts.length)], b = pts[Math.floor(r() * pts.length)];
      if (a === b) continue;
      g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]);
    }
    g.stroke();
  }
}

function poster(g, r, cx, cy, w, h, color) {
  g.save(); g.translate(cx, cy);
  g.fillStyle = '#f2efe6'; g.fillRect(-w / 2, -h / 2, w, h);
  const m = 6, iw = w - 2 * m, ih = h - 2 * m;
  g.fillStyle = color; g.fillRect(-iw / 2, -ih / 2, iw, ih);
  const alt = PALETTE[Math.floor(r() * PALETTE.length)];
  // Diagonal band and a bold block.
  g.save(); g.beginPath(); g.rect(-iw / 2, -ih / 2, iw, ih); g.clip();
  g.fillStyle = alt; g.beginPath(); g.moveTo(-iw / 2, ih * (0.05 + r() * 0.2)); g.lineTo(iw / 2, -ih * (0.1 + r() * 0.2)); g.lineTo(iw / 2, ih * 0.1); g.lineTo(-iw / 2, ih * 0.4); g.fill();
  g.fillStyle = INK; for (let i = 0; i < 6; i++) g.fillRect(-iw / 2 + i * iw / 6, ih / 2 - ih * 0.06, iw / 12, ih * 0.06); // hazard-style foot
  g.restore();
  // Headline block, big symbol, small print.
  g.fillStyle = INK; g.fillRect(-iw / 2 + 8, -ih / 2 + 8, iw * 0.62, ih * 0.14);
  glyphRow(g, r, -iw / 2 + 14, -ih / 2 + 8 + ih * 0.03, iw * 0.5, ih * 0.08, color, 4 + Math.floor(r() * 3));
  const kind = Math.floor(r() * 3), sx = (r() - 0.5) * iw * 0.3, sy = ih * 0.02, sr = Math.min(iw, ih) * (0.2 + r() * 0.08);
  g.fillStyle = INK; g.strokeStyle = '#fff'; g.lineWidth = 5;
  g.beginPath();
  if (kind === 0) g.arc(sx, sy, sr, 0, 7);
  else if (kind === 1) { for (let i = 0; i < 10; i++) { const a = i * Math.PI / 5 - Math.PI / 2, rr = i % 2 ? sr * 0.5 : sr; g.lineTo(sx + Math.cos(a) * rr, sy + Math.sin(a) * rr); } g.closePath(); }
  else { g.moveTo(sx - sr, sy + sr); g.lineTo(sx, sy - sr); g.lineTo(sx + sr, sy + sr); g.closePath(); }
  g.fill(); g.stroke();
  g.fillStyle = color; g.beginPath(); g.arc(sx, sy, sr * 0.28, 0, 7); g.fill();
  for (let i = 0; i < 3; i++) glyphRow(g, r, -iw / 2 + 10, ih * (0.2 + i * 0.075), iw * (0.5 + r() * 0.4), ih * 0.035, INK, 6 + Math.floor(r() * 5));
  g.restore();
}

function sticker(g, r, cx, cy, size, color) {
  g.save(); g.translate(cx, cy);
  g.fillStyle = '#fff'; g.beginPath(); g.arc(0, 0, size / 2, 0, 7); g.fill();
  g.fillStyle = color; g.beginPath(); g.arc(0, 0, size / 2 - 7, 0, 7); g.fill();
  g.fillStyle = INK; g.strokeStyle = INK; g.lineWidth = 9; g.lineCap = 'round'; g.lineJoin = 'round';
  const k = Math.floor(r() * 4), s = size * 0.26;
  if (k === 0) { g.beginPath(); g.moveTo(-s * 0.3, -s); g.lineTo(s * 0.5, -s * 0.1); g.lineTo(-s * 0.1, -s * 0.1); g.lineTo(s * 0.3, s); g.lineTo(-s * 0.5, 0.1 * s); g.lineTo(s * 0.1, s * 0.1); g.closePath(); g.fill(); }
  else if (k === 1) { g.beginPath(); g.arc(-s * 0.45, -s * 0.2, s * 0.16, 0, 7); g.arc(s * 0.45, -s * 0.2, s * 0.16, 0, 7); g.fill(); g.beginPath(); g.arc(0, s * 0.1, s * 0.7, 0.15 * Math.PI, 0.85 * Math.PI); g.stroke(); }
  else if (k === 2) { g.beginPath(); g.moveTo(-s, 0); g.lineTo(s, 0); g.moveTo(s * 0.3, -s * 0.6); g.lineTo(s, 0); g.lineTo(s * 0.3, s * 0.6); g.stroke(); }
  else { g.beginPath(); for (let i = 0; i < 10; i++) { const a = i * Math.PI / 5 - Math.PI / 2, rr = i % 2 ? s * 0.45 : s; g.lineTo(Math.cos(a) * rr, Math.sin(a) * rr); } g.closePath(); g.fill(); }
  g.restore();
}

function doodle(g, r, cx, cy, size, color) {
  g.save(); g.translate(cx, cy); g.strokeStyle = color; g.lineWidth = 11; g.lineCap = 'round'; g.lineJoin = 'round';
  const k = Math.floor(r() * 3), s = size * 0.38;
  g.beginPath();
  if (k === 0) { g.moveTo(0, s * 0.8); g.bezierCurveTo(-s * 1.4, -s * 0.2, -s * 0.5, -s * 1.1, 0, -s * 0.3); g.bezierCurveTo(s * 0.5, -s * 1.1, s * 1.4, -s * 0.2, 0, s * 0.8); }
  else if (k === 1) { g.moveTo(-s, -s); g.lineTo(s, s); g.moveTo(s, -s); g.lineTo(-s, s); g.moveTo(-s * 1.1, s * 1.2); g.quadraticCurveTo(0, s * 1.5, s * 1.1, s * 1.15); }
  else { g.arc(0, 0, s, 0.2, 5.6); g.moveTo(-s * 0.4, -s * 0.2); g.lineTo(-s * 0.4, -s * 0.2); g.moveTo(s * 0.4, -s * 0.2); g.lineTo(s * 0.4, -s * 0.2); }
  g.stroke(); g.restore();
}

function drawAtlas() {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1024;
  const g = canvas.getContext('2d'), r = rng(2202);
  const cells = [];
  for (let i = 0; i < 16; i++) {
    const cx = (i % 4) * CELL + CELL / 2, cy = Math.floor(i / 4) * CELL + CELL / 2;
    if (i < 8) { poster(g, r, cx, cy, 176, 244, PALETTE[i]); cells.push({ kind: 'poster', aspect: 176 / 244, w: 176, h: 244 }); }
    else if (i < 12) { sticker(g, r, cx, cy, 190, PALETTE[(i * 3) % PALETTE.length]); cells.push({ kind: 'sticker', aspect: 1, w: 190, h: 190 }); }
    else { doodle(g, r, cx, cy, 200, i % 2 ? '#f4f1e8' : '#2b2a35'); cells.push({ kind: 'doodle', aspect: 1, w: 200, h: 200 }); }
  }
  return { canvas, cells };
}

const SPOTS = {
  main: { scale: 0.72, z: [-16, 22], dirs: [[1, 0], [-1, 0]], mode: 'street', maxDist: 12 },
  laundry: { x: [-6, 8.2], z: -112, dirs: [[0, -1]], mode: 'row', maxDist: 14 },
  rear: { x: [-26, 28], z: -141, dirs: [[0, 1]], mode: 'row', maxDist: 14 },
};
const PLAN = [
  ['main', { poster: 6, sticker: 4, doodle: 1 }], ['laundry', { poster: 3, sticker: 2, doodle: 1 }], ['rear', { poster: 4, sticker: 3, doodle: 2 }],
];

export function addWeatheringDecals({ scene, station, wallMaterials, roots, gradientMap }) {
  const o = station.root.position, r = rng(2203);
  const { canvas, cells } = drawAtlas();
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = 4; texture.generateMipmaps = true; texture.minFilter = THREE.LinearMipmapLinearFilter; texture.name = 'weathering-decal-atlas';
  const material = new THREE.MeshToonMaterial({ name: 'weathering-decals', map: texture, gradientMap, alphaTest: 0.5, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
  const targets = [];
  for (const root of roots) root.traverse(m => {
    if (!m.isMesh || m.isInstancedMesh) return;
    for (let p = m; p; p = p.parent) if (p.userData?.noDecal) return;
    targets.push(m);
  });
  const ray = new THREE.Raycaster(); ray.far = 16;
  const hitAt = (origin, dir) => {
    ray.set(origin, dir);
    const hit = ray.intersectObjects(targets, false)[0];
    if (!hit || !hit.face) return null;
    const mats = [].concat(hit.object.material);
    const material0 = mats[hit.face.materialIndex ?? 0] ?? mats[0];
    if (!wallMaterials.has(material0)) return null;
    const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
    return { point: hit.point, normal, distance: hit.distance };
  };
  const flat = (hit, w, h) => {
    const up = new THREE.Vector3(0, 1, 0), right = new THREE.Vector3().crossVectors(up, hit.normal).normalize(), inward = hit.normal.clone().negate();
    for (const u of [-0.5, 0, 0.5]) for (const v of [-0.5, 0, 0.5]) {
      // Probe a 3x3 grid slightly larger than the decal, from 0.7 m in front of the wall: every ray must meet the same plane.
      const origin = hit.point.clone().addScaledVector(hit.normal, 0.7).addScaledVector(right, u * (w + 0.06)).addScaledVector(up, v * (h + 0.06));
      const hh = hitAt(origin, inward);
      if (!hh || Math.abs(hh.distance - 0.7) > 0.012 || hh.normal.dot(hit.normal) < 0.995) return false;
    }
    return true;
  };
  const positions = [], uvs = [], indices = [], placed = [], stats = { posters: 0, stickers: 0, doodles: 0, rejected: 0, byArea: {} };
  const pushQuad = (hit, w, h, cell, roll) => {
    const idx = cells.indexOf(cell), c = idx % 4, rr = Math.floor(idx / 4);
    const up = new THREE.Vector3(0, 1, 0), right = new THREE.Vector3().crossVectors(up, hit.normal).normalize(), upv = new THREE.Vector3().crossVectors(hit.normal, right);
    const q = new THREE.Quaternion().setFromAxisAngle(hit.normal, roll); right.applyQuaternion(q); upv.applyQuaternion(q);
    const centre = hit.point.clone().addScaledVector(hit.normal, 0.007), base = positions.length / 3;
    const hw = w / 2, hh = h / 2;
    for (const [sx, sy, u, v] of [[-1, -1, 0, 0], [1, -1, 1, 0], [1, 1, 1, 1], [-1, 1, 0, 1]]) {
      const p = centre.clone().addScaledVector(right, sx * hw).addScaledVector(upv, sy * hh);
      positions.push(p.x, p.y, p.z);
      const fu = (cell.w * (u - 0.5) / CELL + 0.5), fv = (cell.h * (v - 0.5) / CELL + 0.5);
      uvs.push((c + fu) / 4, 1 - (rr + 1 - fv) / 4);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  for (const [area, counts] of PLAN) {
    const spot = SPOTS[area], found = [];
    for (let attempt = 0; attempt < 700 && found.length < 60; attempt++) {
      const dir = spot.dirs[Math.floor(r() * spot.dirs.length)], y = 0.95 + r() * 1.05;
      let origin;
      if (spot.mode === 'street') origin = new THREE.Vector3(o.x, o.y + y, o.z + spot.z[0] + r() * (spot.z[1] - spot.z[0]));
      else {
        // Row mode: floor level of the town apartment whose span holds x (3F / 4F / 5F sites).
        const x = spot.x[0] + r() * (spot.x[1] - spot.x[0]), base = x < -11.2 ? 5.32 : x < 9 ? 4.76 : 4.64;
        origin = new THREE.Vector3(o.x + x, o.y + base + y, o.z + spot.z);
      }
      const hit = hitAt(origin, new THREE.Vector3(dir[0], 0, dir[1]));
      if (!hit || hit.distance > spot.maxDist || Math.abs(hit.normal.y) > 0.08) continue;
      found.push(hit);
    }
    for (const [kind, n] of Object.entries(counts)) {
      let made = 0;
      for (const hit of found.sort(() => r() - 0.5)) {
        if (made >= n) break;
        const pool = cells.filter(c => c.kind === kind), cell = pool[Math.floor(r() * pool.length)];
        const k = spot.scale ?? 1, w = k * (kind === 'poster' ? 0.42 + r() * 0.2 : kind === 'sticker' ? 0.16 + r() * 0.08 : 0.3 + r() * 0.15), h = w / cell.aspect;
        if (placed.some(p => p.point.distanceTo(hit.point) < (w + p.w) * 0.9 + 0.5)) continue;
        if (!flat(hit, w, h)) { stats.rejected++; continue; }
        pushQuad(hit, w, h, cell, kind === 'poster' ? (r() - 0.5) * 0.06 : (r() - 0.5) * 0.5);
        placed.push({ point: hit.point.clone(), w }); made++; stats[kind + 's']++;
        (stats.byArea[area] ??= []).push({ kind, at: [+(hit.point.x - o.x).toFixed(2), +(hit.point.y - o.y).toFixed(2), +(hit.point.z - o.z).toFixed(2)] });
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices); geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, material); mesh.name = 'weathering-decals'; mesh.receiveShadow = true; mesh.castShadow = false; mesh.frustumCulled = false; mesh.userData.noDecal = true; mesh.userData.walkable = false;
  scene.add(mesh);
  let disposed = false;
  return { mesh, stats: { ...stats, drawCalls: 1, triangles: indices.length / 3 }, setEnabled(on) { mesh.visible = on; },
    dispose() { if (disposed) return; disposed = true; mesh.removeFromParent(); geometry.dispose(); material.dispose(); texture.dispose(); } };
}
