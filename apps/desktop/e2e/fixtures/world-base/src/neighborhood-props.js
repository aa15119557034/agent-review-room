// Street-side displays for four separate workplaces. Metres, local +Z outwards.
// The station owns the print atlas; the apartments borrow it for two signs.
export function makeNeighborhoodLabels(ctx) {
  const labels = [
    ['工具置場', '保線係　点検済', '#455f65', '#e2d8bb'],
    ['春の和菓子', '桜もち　　季節限定', '#7d454c', '#f1e4c8'],
    ['返却口', 'ランドリーバスケット', '#2e666a', '#ede6d6'],
    ['町内掲示板', '回覧　清掃日のお知らせ', '#465d59', '#e7ddbd'],
  ];
  const map = ctx.tex.draw(512, 256, g => {
    g.fillStyle = '#f0eadc'; g.fillRect(0, 0, 512, 256);
    labels.forEach(([title, sub, ink, paper], index) => {
      const x = index % 2 * 256, y = Math.floor(index / 2) * 128;
      g.fillStyle = paper; g.fillRect(x, y, 256, 128);
      g.fillStyle = ink; g.fillRect(x + 6, y + 6, 244, 64);
      g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = '#fff5df';
      ctx.tex.fitText(g, title, x + 128, y + 39, 212, 44, ctx.tex.FONTS.sans, 800);
      g.fillStyle = ink;
      ctx.tex.fitText(g, sub, x + 128, y + 95, 226, 22, ctx.tex.FONTS.sans, 600);
    });
  }, { key: 'station-neighborhood-labels', anisotropy: 8 });
  return ctx.mat.toon('#ffffff', { map, vertexColors: true, paint: 0.01 });
}

function placard(F, material, index, width, height, x, y, z) {
  const col = index % 2, row = Math.floor(index / 2);
  const rect = [(col + 0.012) / 2, 1 - (row + 0.985) / 2, (col + 0.988) / 2, 1 - (row + 0.015) / 2];
  F.box(material, '#ffffff', width, height, 0.008, x, y, z, { uv: { rect, white: [0.002, 0.998] }, skip: 'rltdb' });
}

export function addShopMenu(F, M, labels) {
  F.box(M.metal, '#414747', 0.06, 0.18, 0.19, 0, 0.33, 0.07);
  F.box(M.plain, '#785740', 0.75, 0.53, 0.08, 0, 0, 0.12);
  placard(F, labels, 1, 0.69, 0.46, 0, 0, 0.164);
  // Two brass turn buttons hold the replaceable seasonal card.
  for (const x of [-0.31, 0.31]) F.box(M.metal, '#ae9467', 0.045, 0.018, 0.012, x, 0.205, 0.175);
}

export function addMaintenanceRack(F, M, labels) {
  F.box(M.metal, '#687a75', 0.80, 0.74, 0.055, 0, 0, 0.025);
  placard(F, labels, 0, 0.43, 0.20, 0.13, 0.22, 0.058);
  for (const x of [-0.22, 0.14]) F.box(M.metal, '#a99a7e', 0.05, 0.045, 0.14, x, 0.04, 0.10);
  for (const radius of [0.12, 0.16]) {
    let prev = [-0.20 + radius, -0.10, 0.13];
    for (let i = 1; i <= 16; i++) {
      const angle = i * Math.PI / 8;
      const next = [-0.20 + Math.cos(angle) * radius, -0.10 + Math.sin(angle) * radius, 0.13];
      F.beam(M.plain, '#46625d', prev, next, 0.027, 0.027); prev = next;
    }
  }
  F.beam(M.plain, '#46625d', [-0.04, -0.10, 0.13], [-0.02, -0.40, 0.13], 0.026, 0.026);
  F.box(M.metal, '#b29d77', 0.041, 0.072, 0.04, -0.02, -0.42, 0.13);
  F.box(M.plain, '#bd9665', 0.06, 0.21, 0.04, 0.15, -0.10, 0.11);
  F.box(M.metal, '#8a908a', 0.11, 0.06, 0.05, 0.15, -0.22, 0.11);
}

/** A wall-mounted drying rail, with two brackets transferring the load into the wall. */
export function addLaundryRail(F, M, width, depth) {
  const steel = '#a4aea1', plate = '#6d8078';
  for (const x of [-width / 2 + .045, width / 2 - .045]) {
    F.box(M.metal, plate, .065, .26, .027, x, -.095, .014, { skip: 'b' });
    F.box(M.metal, steel, .032, .036, depth, x, 0, depth / 2);
    F.beam(M.metal, steel, [x, -.19, .029], [x, -.012, depth - .025], .028, .028);
  }
  F.cyl(M.metal, steel, .018, width, 0, .014, depth, { rz: Math.PI / 2, seg: 8 });
}

export function addLaundryCart(F, M, labels) {
  const steel = '#839396';
  for (const x of [-0.24, 0.24]) for (const z of [-0.16, 0.16]) {
    F.cyl(M.plain, '#464d51', 0.058, 0.042, x, 0.061, z, { seg: 12, rz: Math.PI / 2 });
    F.box(M.metal, steel, 0.025, 0.58, 0.025, x, 0.38, z);
  }
  for (const y of [0.19, 0.36, 0.52, 0.66]) {
    for (const z of [-0.16, 0.16]) F.box(M.metal, steel, 0.51, 0.017, 0.017, 0, y, z);
    for (const x of [-0.24, 0.24]) F.box(M.metal, steel, 0.017, 0.017, 0.32, x, y, 0);
  }
  for (const z of [-0.16, 0.16]) for (const x of [-0.15, -0.05, 0.05, 0.15]) F.box(M.metal, steel, 0.012, 0.44, 0.012, x, 0.42, z);
  F.box(M.metal, steel, 0.49, 0.026, 0.34, 0, 0.18, 0);
  for (const [i, color] of ['#e5ded0', '#91b2b2', '#e2dac6'].entries()) {
    F.box(M.plain, color, 0.36 - i * 0.012, 0.055, 0.22, 0.018 * i, 0.22 + i * 0.055, 0, { ry: 0.045 * (1 - i) });
  }
  F.box(M.plain, '#557474', 0.22, 0.11, 0.016, 0, 0.54, 0.177);
  placard(F, labels, 2, 0.21, 0.10, 0, 0.54, 0.19);
}

export function addDeliveryCorner(F, M, labels) {
  F.box(M.plain, '#856e53', 0.94, 0.64, 0.080, 0.28, 1.57, 0.045);
  placard(F, labels, 3, 0.53, 0.30, 0.16, 1.67, 0.09);
  for (const [x, y, color] of [[0.56, 1.53, '#eee5c8'], [0.32, 1.35, '#b4ccca']]) {
    F.box(M.plain, color, 0.20, 0.16, 0.008, x, y, 0.09, { rz: 0.03 });
    F.box(M.metal, '#9c7658', 0.024, 0.015, 0.012, x, y + 0.07, 0.095);
  }
  for (const x of [-0.25, 0.17]) {
    F.cyl(M.plain, '#414849', 0.088, 0.047, x, 0.092, 0.28, { rz: Math.PI / 2, seg: 12 });
    F.beam(M.metal, '#627d78', [x, 0.13, 0.24], [x, 1.04, 0.085], 0.033, 0.033);
  }
  for (const y of [0.24, 0.58, 1.02]) F.box(M.metal, '#758f87', 0.43, 0.038, 0.035, -0.04, y, 0.26 - y * 0.17);
  F.box(M.metal, '#87908f', 0.52, 0.04, 0.34, -0.04, 0.12, 0.37);
}
