import * as THREE from 'three';

/** Art round 1, shot D (24 laundromat): paper notices and stickers on the glass and wings,
 *  plus a second standing board. One canvas atlas (1024 px, 4 x 4 tiles) and one material;
 *  every notice is a 4-vertex quad appended to the city's own geometry builder, so the whole
 *  set adds one draw call. Coordinates are the apartment-local frame F (+Z toward the lane). */
/** Canvas texture owned by the caller. The city must not touch the station's texture cache or pixel budget. */
function ownCanvasTexture(w, h, paint) {
  const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
  paint(canvas.getContext('2d'), w, h);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = 8; texture.needsUpdate = true;
  return texture;
}

export const NOTICE_TILES = [
  'hours', 'caution', 'prices', 'mascot', 'camera', 'sale', 'a4-grey', 'no-smoking',
  'blue-star', 'lost-item', 'a4-pink', 'a4-teal', 'coupon', 'bike', 'a4-yellow', 'closed',
];

function paintNotices(ctx, g, W) {
  const T = W / 4, sans = ctx.tex.FONTS.sans;
  const text = (s, x, y, size, colour, maxW, weight = 800) => {
    g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = colour;
    ctx.tex.fitText(g, s, x, y, maxW, size, sans, weight);
  };
  const lines = (x, y, w, n, colour, step = 18) => { g.fillStyle = colour; for (let i = 0; i < n; i++) g.fillRect(x, y + i * step, w * (i === n - 1 ? 0.6 : 1), 6); };
  NOTICE_TILES.forEach((name, i) => {
    const x = (i % 4) * T, y = Math.floor(i / 4) * T;
    g.save(); g.translate(x, y);
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, T, T);
    switch (name) {
      case 'hours':
        g.fillStyle = '#d7263d'; g.fillRect(0, 0, T, 64); text('営業時間', T / 2, 33, 44, '#ffffff', T - 30);
        text('6:00-24:00', T / 2, 110, 46, '#d7263d', T - 20); lines(24, 150, T - 48, 4, '#555a62'); text('年中無休', T / 2, 232, 34, '#333', T - 40); break;
      case 'caution':
        g.fillStyle = '#ffd23f'; g.fillRect(0, 0, T, T); g.fillStyle = '#1b1b1b';
        g.beginPath(); g.moveTo(T / 2, 22); g.lineTo(T - 40, 150); g.lineTo(40, 150); g.closePath(); g.fill();
        g.fillStyle = '#ffd23f'; g.fillRect(T / 2 - 7, 60, 14, 50); g.fillRect(T / 2 - 7, 120, 14, 14);
        text('ご注意', T / 2, 196, 52, '#1b1b1b', T - 30); lines(30, 226, T - 60, 1, '#1b1b1b'); break;
      case 'prices':
        g.fillStyle = '#1f5fbf'; g.fillRect(0, 0, T, 58); text('料金表', T / 2, 30, 40, '#ffffff', T - 30);
        ['洗濯 7kg  ¥400', '乾燥 10分 ¥100', '洗剤 ¥50', '毛布 ¥600'].forEach((s, r) => { text(s, T / 2, 92 + r * 38, 26, '#1d2733', T - 24, 700); g.fillStyle = '#c7d3e6'; g.fillRect(16, 112 + r * 38, T - 32, 2); });
        break;
      case 'mascot':
        g.fillStyle = '#ff6fa0'; g.fillRect(0, 0, T, T); g.fillStyle = '#ffffff'; g.beginPath(); g.arc(T / 2, 118, 70, 0, 7); g.fill();
        g.fillStyle = '#222'; g.beginPath(); g.arc(T / 2 - 24, 108, 8, 0, 7); g.arc(T / 2 + 24, 108, 8, 0, 7); g.fill();
        g.fillStyle = '#ffb703'; g.beginPath(); g.moveTo(T / 2 - 12, 126); g.lineTo(T / 2 + 12, 126); g.lineTo(T / 2, 142); g.closePath(); g.fill();
        text('おせんたく', T / 2, 218, 38, '#ffffff', T - 20); break;
      case 'camera':
        g.fillStyle = '#1f8f5a'; g.fillRect(0, 0, T, T); g.fillStyle = '#ffffff'; g.fillRect(50, 60, 120, 70); g.beginPath(); g.arc(150, 95, 30, 0, 7); g.fill();
        g.fillStyle = '#1f8f5a'; g.beginPath(); g.arc(150, 95, 16, 0, 7); g.fill(); text('防犯カメラ', T / 2, 182, 40, '#ffffff', T - 24); text('作動中', T / 2, 226, 40, '#ffe14a', T - 24); break;
      case 'sale':
        g.fillStyle = '#ff7b1c'; g.fillRect(0, 0, T, T); text('SALE', T / 2, 84, 84, '#ffffff', T - 20, 900);
        g.fillStyle = '#ffe14a'; g.beginPath(); g.arc(T / 2, 168, 50, 0, 7); g.fill(); text('半額', T / 2, 168, 50, '#d7263d', 90, 900); text('毎週火曜', T / 2, 232, 30, '#ffffff', T - 30); break;
      case 'a4-grey': lines(26, 36, T - 52, 9, '#6b7077', 22); g.fillStyle = '#c9ced4'; g.fillRect(0, 0, T, 6); break;
      case 'no-smoking':
        g.fillStyle = '#ffffff'; g.fillRect(0, 0, T, T); g.strokeStyle = '#d7263d'; g.lineWidth = 16; g.beginPath(); g.arc(T / 2, 110, 70, 0, 7); g.stroke();
        g.beginPath(); g.moveTo(T / 2 - 50, 60); g.lineTo(T / 2 + 50, 160); g.stroke(); g.fillStyle = '#333'; g.fillRect(T / 2 - 45, 104, 70, 14);
        text('禁煙', T / 2, 214, 46, '#d7263d', T - 40); break;
      case 'blue-star':
        g.fillStyle = '#1c4fd8'; g.fillRect(0, 0, T, T); g.fillStyle = '#ffffff'; g.beginPath();
        for (let k = 0; k < 10; k++) { const a = -Math.PI / 2 + k * Math.PI / 5, r = k % 2 ? 36 : 82; g.lineTo(T / 2 + Math.cos(a) * r, 118 + Math.sin(a) * r); } g.fill();
        text('NEW', T / 2, 222, 50, '#ffe14a', T - 30, 900); break;
      case 'lost-item':
        g.fillStyle = '#b7e34a'; g.fillRect(0, 0, T, T); text('お忘れ物', T / 2, 70, 52, '#1d3b05', T - 20); text('ご注意', T / 2, 132, 52, '#1d3b05', T - 20); lines(34, 176, T - 68, 3, '#3f6a10', 22); break;
      case 'a4-pink': g.fillStyle = '#ff9fc2'; g.fillRect(0, 0, T, 56); text('お知らせ', T / 2, 30, 36, '#ffffff', T - 30); lines(26, 84, T - 52, 7, '#7d6670', 22); break;
      case 'a4-teal': g.fillStyle = '#17a398'; g.fillRect(0, 0, T, 56); text('ご利用案内', T / 2, 30, 34, '#ffffff', T - 30); lines(26, 84, T - 52, 7, '#5a6e6c', 22); break;
      case 'coupon':
        g.fillStyle = '#fff3c4'; g.fillRect(0, 0, T, T); g.strokeStyle = '#e63946'; g.lineWidth = 8; g.setLineDash([16, 10]); g.strokeRect(12, 12, T - 24, T - 24); g.setLineDash([]);
        text('クーポン', T / 2, 72, 48, '#e63946', T - 40); text('乾燥10分', T / 2, 140, 40, '#333', T - 40); text('無料', T / 2, 204, 62, '#e63946', T - 50, 900); break;
      case 'bike':
        g.fillStyle = '#2b6cb0'; g.fillRect(0, 0, T, T); g.strokeStyle = '#ffffff'; g.lineWidth = 10; g.beginPath(); g.arc(78, 130, 36, 0, 7); g.arc(178, 130, 36, 0, 7); g.stroke();
        g.beginPath(); g.moveTo(78, 130); g.lineTo(118, 80); g.lineTo(178, 130); g.stroke(); text('駐輪禁止', T / 2, 222, 44, '#ffffff', T - 30); break;
      case 'a4-yellow': g.fillStyle = '#ffe9a3'; g.fillRect(0, 0, T, T); text('貼紙禁止', T / 2, 58, 44, '#8a5a00', T - 30); lines(30, 96, T - 60, 6, '#8a6a2a', 22); break;
      case 'closed':
        g.fillStyle = '#ffffff'; g.fillRect(0, 0, T, T); g.strokeStyle = '#1f2a37'; g.lineWidth = 6; g.strokeRect(10, 10, T - 20, T - 20);
        text('OPEN', T / 2, 100, 82, '#17a398', T - 40, 900); text('24H', T / 2, 190, 70, '#1f2a37', T - 60, 900); break;
    }
    g.restore();
  });
}

/** `own` clones a station material into a city-owned one (no district clipping planes, released with the city). */
export function createNoticeSheet(ctx, own = m => m) {
  const map = ownCanvasTexture(1024, 1024, (g, w) => paintNotices(ctx, g, w));
  const material = own(ctx.mat.toon('#ffffff', { map, paint: 0, emissive: '#ffffff', emissiveIntensity: 0.22, name: 'art-r1-notices' }));
  material.emissiveMap = map; material.needsUpdate = true;
  return { map, material };
}

const tileUV = name => {
  const i = NOTICE_TILES.indexOf(name), c = i % 4, r = Math.floor(i / 4), e = 0.004;
  return [c / 4 + e, 1 - (r + 1) / 4 + e, (c + 1) / 4 - e, 1 - r / 4 - e];
};

/** One paper notice, centred at (x, y, z), facing +Z, rotated by roll about Z. */
export function noticeCard(F, sheet, name, w, h, x, y, z, roll = 0, o = {}) {
  const [u0, v0, u1, v1] = tileUV(name), c = Math.cos(roll), s = Math.sin(roll);
  const corners = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]];
  const p = [];
  for (const [cx, cy] of corners) p.push(cx * c - cy * s, cx * s + cy * c, 0);
  F.raw(sheet.material, '#ffffff', { p, n: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], u: [u0, v0, u1, v0, u1, v1, u0, v1], i: [0, 1, 2, 0, 2, 3] },
    x, y, z, { shadow: false, ...o });
}

/** Notice layout for the laundromat storefront. glassZ is the pane plane in F, front-wall z for the wings. */
export function addLaundryNotices(F, sheet, glassZ, wallZ) {
  const gz = glassZ + 0.014;
  let count = 0;
  const put = (...a) => { noticeCard(F, sheet, ...a); count++; };
  // Left pane: a strip beside the first washer, a stack in the corner, a row above the function label.
  put('hours', 0.27, 0.27, -2.80, 1.40, gz, 0.02);
  put('caution', 0.23, 0.23, -2.78, 1.07, gz, -0.05);
  put('a4-grey', 0.2, 0.28, -2.78, 0.66, gz, 0.03);
  put('sale', 0.23, 0.23, -2.52, 0.42, gz, -0.08);
  for (const [i, [n, x]] of [['coupon', -2.58], ['a4-pink', -2.22], ['camera', -1.86], ['a4-teal', -1.5], ['mascot', -1.14]].entries())
    put(n, 0.2, 0.2, x, 2.10 + (i % 2) * 0.02, gz, (i - 2) * 0.03);
  // Door pane: notices on the fixed half, below the handle height.
  put('no-smoking', 0.2, 0.2, -0.26, 1.50, gz, 0.0);
  put('a4-yellow', 0.17, 0.24, -0.26, 1.20, gz, 0.04);
  put('closed', 0.2, 0.2, 0.0, 0.46, gz, -0.03);
  put('bike', 0.17, 0.17, 0.30, 0.78, gz, 0.0);
  // Right pane.
  put('prices', 0.32, 0.32, 2.80, 1.38, gz, -0.02);
  put('lost-item', 0.22, 0.22, 2.77, 1.02, gz, 0.05);
  put('a4-grey', 0.2, 0.28, 2.80, 0.62, gz, -0.03);
  for (const [i, [n, x]] of [['sale', 0.95], ['a4-pink', 1.32], ['coupon', 1.68], ['blue-star', 2.04], ['a4-teal', 2.40]].entries())
    put(n, 0.2, 0.2, x, 2.10 + (i % 2) * 0.02, gz, (2 - i) * 0.03);
  // Wings beside the portal (outer wall faces).
  const wz = wallZ + 0.012;
  put('blue-star', 0.4, 0.4, -4.4, 1.55, wz, 0.04);
  put('a4-yellow', 0.26, 0.36, -3.9, 1.35, wz, -0.05);
  put('hours', 0.3, 0.3, -4.0, 0.9, wz, 0.02);
  put('caution', 0.3, 0.3, 4.35, 1.4, wz, 0.0);
  put('mascot', 0.32, 0.32, 4.0, 0.9, wz, -0.04);
  put('a4-grey', 0.24, 0.34, 4.5, 0.85, wz, 0.05);
  return count;
}

/** Second folding board at the laundromat portal (grey-blue frame, printed face on both sides). */
export function addStandingBoard(F, M, sheet, face, x, y, z, ry = 0.25) {
  const s = F.sub(x, y, z, ry), h = 0.78, w = 0.46, lean = 0.2, tilt = Math.atan2(lean, h);
  for (const side of [1, -1]) {
    s.box(M.plain, '#3c5057', w, h, 0.03, 0, h / 2, side * lean * 0.5, { rx: -side * tilt, ry: side > 0 ? 0 : Math.PI });
    noticeCard(s, sheet, face, w - 0.07, h - 0.1, 0, h / 2 + 0.01, side * (lean * 0.5 + 0.021), 0, { rx: -side * tilt, ry: side > 0 ? 0 : Math.PI });
  }
  s.box(M.metal, '#8e949b', 0.012, 0.012, lean * 1.6, 0, h * 0.4, 0);
}

/** Chain-link, shade net, cardboard and pipe layers for the rear passage (shot C). Station-local
 *  metres; the passage floor is y = 4.78 and the rear wall plane is z = -131. */
export function addBackAlley({ root, ctx, own, ownTexture, frame, M, A, sheet }) {
  const FLOOR = 4.78, FENCE_Z = -133.0, HEIGHT = 2.1;
  const tile = ownCanvasTexture(128, 128, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    g.strokeStyle = '#ffffff'; g.lineWidth = 4.5; g.lineCap = 'round';
    for (let i = -1; i <= 2; i++) {
      g.beginPath(); g.moveTo(-8, i * 64 + 32 + 16); g.lineTo(72, i * 64 + 32 - 64); g.stroke();
      g.beginPath(); g.moveTo(-8, i * 64 + 32 - 16 + 64); g.lineTo(72, i * 64 + 32 + 64 - 64 + 64 - 128 + 0); g.stroke();
    }
    // Diamond lattice: two families of diagonals, wrapped by drawing across the tile edges.
    g.clearRect(0, 0, w, h);
    for (let k = -2; k <= 4; k++) {
      g.beginPath(); g.moveTo(-10, k * 64 - 10); g.lineTo(138, k * 64 + 138); g.stroke();
      g.beginPath(); g.moveTo(-10, k * 64 + 138); g.lineTo(138, k * 64 - 10); g.stroke();
    }
  });
  tile.wrapS = tile.wrapT = THREE.RepeatWrapping;
  ownTexture(tile);
  const linkMat = own(ctx.mat.toon('#ffffff', { map: tile, alphaTest: 0.5, side: 'double', paint: 0, color: '#8aa3ab', emissive: '#6f8a92', emissiveIntensity: 0.16, name: 'art-r1-chainlink' }));
  const netMat = own(ctx.mat.toon('#274a52', { transparent: true, opacity: 0.66, side: 'double', depthWrite: false, paint: 0, name: 'art-r1-shade-net' }));
  const steel = own(ctx.mat.toon('#56676c', { paint: 0.04, name: 'art-r1-fence-steel' }));
  const plane = (mat, w, h, x, y, z, uvScale, name) => {
    const geo = new THREE.PlaneGeometry(w, h);
    if (uvScale) { const uv = geo.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * w / uvScale, uv.getY(i) * h / uvScale); }
    const mesh = new THREE.Mesh(geo, mat); mesh.name = name; mesh.position.set(x, y, z);
    mesh.castShadow = false; mesh.receiveShadow = false; ctx.noOutline(mesh); root.add(mesh); return mesh;
  };
  const bar = (w, h, d, x, y, z, name) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), steel); mesh.name = name; mesh.position.set(x, y, z);
    mesh.castShadow = true; mesh.receiveShadow = true; root.add(mesh); return mesh;
  };
  const runs = [[5.6, 1.2], [-1.6, -9.8]];
  for (const [x0, x1] of runs) {
    const len = Math.abs(x0 - x1), cx = (x0 + x1) / 2, y0 = FLOOR + 0.12;
    plane(linkMat, len, HEIGHT, cx, y0 + HEIGHT / 2, FENCE_Z, 0.24, 'art-r1-chainlink');
    plane(netMat, len, HEIGHT - 0.35, cx, y0 + 0.2 + (HEIGHT - 0.35) / 2, FENCE_Z - 0.03, 0, 'art-r1-shade-net');
    bar(len, 0.05, 0.05, cx, y0 + HEIGHT, FENCE_Z, 'art-r1-fence-rail');
    bar(len, 0.03, 0.03, cx, y0 + 0.04, FENCE_Z, 'art-r1-fence-foot');
    const n = Math.round(len / 2.4);
    for (let i = 0; i <= n; i++) bar(0.07, HEIGHT + 0.9, 0.07, Math.min(x0, x1) + len * i / n, y0 + (HEIGHT - 0.9) / 2, FENCE_Z, 'art-r1-fence-post');
  }
  // Two small colour spots on the fence face: a red prohibition disc and a blue notice.
  const spot = (name, w, h, x, y, z) => {
    const [u0, v0, u1, v1] = tileUV(name), geo = new THREE.PlaneGeometry(w, h);
    geo.attributes.uv.set([u0, v1, u1, v1, u0, v0, u1, v0]);
    const mesh = new THREE.Mesh(geo, sheet.material); mesh.name = 'art-r1-fence-' + name; mesh.position.set(x, y, z);
    mesh.castShadow = false; ctx.noOutline(mesh); root.add(mesh);
  };
  spot('no-smoking', 0.34, 0.34, 4.1, FLOOR + 1.45, FENCE_Z + 0.025);
  spot('blue-star', 0.3, 0.3, -4.6, FLOOR + 1.35, FENCE_Z + 0.025);
  spot('camera', 0.3, 0.3, -7.4, FLOOR + 1.5, FENCE_Z + 0.025);
  // Cardboard on the passage floor against the fence, one stack near the camera and two further in.
  const box = { uv: { rect: A.rects.cardboard, white: A.white } };
  const stack = (x, z, list) => {
    let y = FLOOR;
    list.forEach(([w, h, d, ry, dx], i) => {
      frame.boxB(M.atlas, i % 2 ? '#d8b98f' : '#c9a373', w, h, d, x + (dx || 0), y, z, { ...box, ry });
      y += h;
    });
  };
  stack(5.0, -132.55, [[0.62, 0.42, 0.46, 0.1], [0.5, 0.34, 0.4, -0.18, 0.03], [0.34, 0.2, 0.3, 0.3, -0.02]]);
  stack(-2.7, -132.6, [[0.7, 0.46, 0.5, -0.06], [0.55, 0.38, 0.42, 0.15, 0.02]]);
  stack(-3.45, -132.5, [[0.44, 0.3, 0.36, 0.12]]);
  stack(-6.8, -132.55, [[0.66, 0.4, 0.48, 0.05], [0.6, 0.3, 0.44, -0.1], [0.4, 0.26, 0.34, 0.2, 0.05]]);
  // Pipes run along the foot of the wall (two horizontal runs and a riser), with clips.
  const pipe = '#a7b5bb', clip = '#586369';
  for (const [y, r] of [[0.46, 0.034], [0.64, 0.027]]) {
    frame.cyl(M.metal, pipe, r, 6.2, -0.8, FLOOR + y, -131.1, { rz: Math.PI / 2, seg: 8 });
    for (let x = -3.4; x < 2.4; x += 1.4) frame.box(M.metal, clip, 0.05, 0.1, 0.05, x, FLOOR + y, -131.07);
  }
  frame.cyl(M.metal, pipe, 0.04, 2.3, -3.6, FLOOR + 1.15, -131.1, { seg: 8 });
  frame.cyl(M.metal, pipe, 0.04, 0.2, -3.6, FLOOR + 0.55, -131.1, { rz: Math.PI / 2, seg: 8 });
  return { fence: runs.length, cardboardStacks: 4, pipeRuns: 3, spots: 3 };
}
