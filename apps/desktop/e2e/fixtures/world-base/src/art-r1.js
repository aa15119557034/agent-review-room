import * as THREE from 'three';
import { makeKeiVan } from '../upstream/sakuragaoka/src/world/vehicles/cars.js';
import { createStock } from './art-stock.js';

/** Art round 1 (#252 fixed shots A and B): ground-floor density on the main street and the
 *  W1 entrance display. Station-local metres, built before the district is trimmed and batched.
 *  Only new geometry, canvas textures and instanced goods; no upstream file is edited. */
export function addArtR1Station({ ctx }) {
  const C = ctx.services.shopsA.buildContext, L = ctx.L;
  const { M } = C;
  const stats = { triangles: 0, instancedMeshes: 0, props: [] };
  const rng = ctx.rng('art-r1');
  const gh = (S, lx, lz) => {
    const p = S.toW(lx, lz);
    return ctx.physics.groundHeight(p.x, p.z, L.heightAt(p.x, p.z) + 0.5) - S.f.y;
  };
  const note = (name, tris) => { stats.props.push({ name, triangles: tris }); stats.triangles += tris; };
  // Printed panel that keeps its colours at dusk: a toon base plus a mapped emissive share.
  const lit = (w, h, draw, key, intensity = 0.55) => {
    const map = ctx.tex.draw(w, h, draw, { key, anisotropy: 8 });
    const m = ctx.mat.toon('#ffffff', { map, paint: 0, emissive: '#ffffff', emissiveIntensity: intensity, name: key });
    m.emissiveMap = map; m.needsUpdate = true;
    return m;
  };
  const sans = ctx.tex.FONTS.sans;
  const text = (g, s, x, y, size, colour, maxW, weight = 800) => {
    g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = colour;
    ctx.tex.fitText(g, s, x, y, maxW, size, sans, weight);
  };

  // ---------------------------------------------------------------- A: parked kei van, east shoulder
  {
    const van = makeKeiVan(ctx), d = van.userData.dims;
    const z = 12.5, f = L.streetFrame(z, 1, 2.1), rotY = Math.atan2(f.tx, f.tz) + Math.PI; // left-hand traffic: east kerb faces south
    const fx = Math.sin(rotY), fz = Math.cos(rotY);
    const lift = 0.02;
    const hF = L.heightAt(f.x + fx * d.wb / 2, f.z + fz * d.wb / 2) + lift, hR = L.heightAt(f.x - fx * d.wb / 2, f.z - fz * d.wb / 2) + lift;
    const y = (hF + hR) / 2 - 0.012;
    van.position.set(f.x, y, f.z); van.rotation.y = rotY;
    van.userData.inner.rotation.x = Math.atan2(hR - hF, d.wb);
    ctx.addStatic(van);
    const zc = (d.zF + d.zR) / 2, len = d.zF - d.zR;
    ctx.physics.addBox(f.x + fx * zc, f.z + fz * zc, d.W + 0.08, len, rotY, y - 0.1, y + d.H);
    van.traverse(o => { if (o.isMesh) note('van-' + (o.material?.name || o.material?.type), (o.geometry.index?.count ?? o.geometry.attributes.position.count) / 3); });
  }

  // ---------------------------------------------------------------- shared dressing pieces
  const bush = (S, x, y, z, r, colour) => {
    S.k.sphere(r, M.t(colour, { paint: 0.07 }), [x, y + r * 0.9, z], 10);
    S.k.sphere(r * 0.7, M.t(colour, { paint: 0.07 }), [x + r * 0.55, y + r * 1.05, z + r * 0.2], 8);
    note('bush', 2 * 80);
  };
  const planterPot = (S, x, y, z, r, potColour, leaf) => {
    S.k.cyl(r, r * 0.72, r * 1.5, M.t(potColour, { paint: 0.05 }), [x, y + r * 0.75, z], null, 10);
    bush(S, x, y + r * 1.2, z, r * 0.95, leaf);
    note('pot', 40);
  };
  const crateTower = (S, stock, x, y, z, rot, colours, bottleColours) => {
    let top = y;
    colours.forEach((c, i) => { C.P.crate(S, x + (i % 2) * 0.012, top, z, rot + (i % 2) * 0.05, c, { w: 0.5, h: 0.3, d: 0.36 }); top += 0.3; });
    note('crate-tower', colours.length * 12);
    if (!bottleColours) return top;
    const c = Math.cos(rot), s = Math.sin(rot);
    for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) {
      const lx = -0.17 + i * 0.113, lz = -0.11 + j * 0.11;
      stock.bottle(x + lx * c + lz * s, top, z - lx * s + lz * c, 0.065, 0.26, bottleColours[(i + j) % bottleColours.length]);
    }
    return top;
  };
  const board = (S, x, y, z, rot, w, h, draw, key) => {
    const g = S.k.group([x, y, z], rot), k = ctx.kit(g), lean = 0.2, ang = Math.atan2(lean, h);
    const frame = M.t('#4d5a60', { paint: 0.04 });
    for (const sgn of [1, -1]) {
      const b = new THREE.Group(); b.position.set(0, 0, sgn * lean); b.rotation.x = -sgn * ang; g.add(b);
      const kb = ctx.kit(b);
      kb.box(w, h, 0.03, frame, [0, h / 2, 0]);
      if (sgn > 0) { const face = kb.plane(w - 0.06, h - 0.07, lit(256, Math.round(256 * h / w), draw, key, 0.35), [0, h / 2, 0.018]); face.userData.noBatch = true; }
    }
    note('a-board', 2 * 12 + 2);
  };

  // ---------------------------------------------------------------- B: W1 ひだまりマート entrance
  {
    const S = C.space('W1'), k = S.k, FY = 0.30;
    const stock = createStock(ctx, 'w1-display');
    // Cold-grey chest freezer on the landing, left of the door (lid is glass over ice-cream packs).
    const fx = -1.48, fz = -2.22, body = M.t('#cfd5da', { paint: 0.03 }), teal = M.t('#12a899', { paint: 0.03 });
    k.box(1.1, 0.56, 0.62, body, [fx, FY + 0.28, fz]);
    k.box(1.12, 0.1, 0.02, teal, [fx, FY + 0.36, fz + 0.318]);
    k.box(1.14, 0.05, 0.66, M.t('#8f989f'), [fx, FY + 0.585, fz]);
    for (const dx of [-0.27, 0.27]) {
      const lid = k.box(0.5, 0.02, 0.5, ctx.mat.glass({ opacity: 0.12, tint: '#b8d8ea', streaks: false }), [fx + dx, FY + 0.602, fz], [0, 0, 0]);
      lid.castShadow = false; lid.receiveShadow = false; ctx.noOutline(lid);
    }
    k.box(1.08, 0.02, 0.58, M.t('#e6eef2'), [fx, FY + 0.52, fz]);
    const packs = ['#ffd24a', '#ff6f91', '#52c7e8', '#8bd24f', '#ffffff', '#ff9a3c', '#b58cf0'];
    for (let i = 0; i < 9; i++) for (let j = 0; j < 4; j++) stock.box(fx - 0.48 + i * 0.12, FY + 0.53, fz - 0.21 + j * 0.14, 0.1, 0.04, 0.12, packs[(i * 3 + j * 5) % packs.length], (rng() - 0.5) * 0.2);
    note('freezer', 6 * 12 + 24);
    // Beverage crates stacked beside the door.
    crateTower(S, stock, -0.56, FY, -2.26, 0.08, ['#2f78c4', '#e7c14f', '#2f78c4'], ['#ffffff', '#ffb347', '#7bd389', '#ff8fb1', '#7ec8ff']);
    crateTower(S, stock, -0.12, FY, -2.40, -0.05, ['#e7c14f', '#2f78c4'], ['#f4f1e8', '#ff8fb1', '#ffb347']);
    // Open metal display rack on the pavement to the right of the entrance.
    {
      const rx = 3.2, rz = -2.32, ry = gh(S, rx, rz) + 0.02, grey = M.t('#9aa2a8', { paint: 0.03 });
      for (const sx of [-0.46, 0.46]) for (const sz of [-0.17, 0.17]) k.box(0.035, 1.3, 0.035, grey, [rx + sx, ry + 0.65, rz + sz]);
      const colours = ['#ff7a59', '#ffd24a', '#47b8e0', '#ee5f93', '#8bd24f', '#ffffff', '#7a6df2', '#ff9a3c', '#3fcfb4'];
      for (let t = 0; t < 4; t++) {
        const sy = ry + 0.12 + t * 0.34;
        k.box(1.0, 0.02, 0.42, grey, [rx, sy, rz]);
        for (let i = 0; i < 9; i++) {
          const c = colours[(i * 2 + t * 3) % colours.length];
          if (t % 2) stock.bottle(rx - 0.42 + i * 0.105, sy + 0.01, rz - 0.1 + (i % 2) * 0.16, 0.075, 0.27, c);
          else stock.box(rx - 0.44 + i * 0.11, sy + 0.01, rz + 0.02, 0.095, 0.2 + (i % 3) * 0.03, 0.3, c, (rng() - 0.5) * 0.1);
        }
      }
      k.box(1.04, 0.14, 0.03, M.t('#12a899'), [rx, ry + 1.38, rz + 0.2]);
      note('rack', 4 * 14 + 12 + 8 * 12);
    }
    // Chalk board and a sale flag on the landing edge.
    board(S, 2.42, FY, -1.78, 0.3, 0.46, 0.8, (g, w, h) => {
      g.fillStyle = '#1e3f43'; g.fillRect(0, 0, w, h);
      g.fillStyle = '#ffd24a'; g.fillRect(0, 0, w, h * 0.2);
      text(g, '本日の', w / 2, h * 0.1, 40, '#1e3f43', w - 30);
      text(g, 'おすすめ', w / 2, h * 0.33, 52, '#ffffff', w - 24);
      text(g, 'さくら', w / 2, h * 0.52, 56, '#ff8fb1', w - 24);
      text(g, 'ソーダ ¥160', w / 2, h * 0.72, 40, '#ffffff', w - 24);
      g.fillStyle = '#ff8fb1'; g.fillRect(w * 0.15, h * 0.86, w * 0.7, 6);
    }, 'art-r1-w1-board');
    stock.finish(S.g);
    stats.instancedMeshes += 2;
    note('w1-stock', stock.triangles);

    // Sign band: one saturated teal block over the three striped cards (same plane, 15 mm proud).
    {
      const W = 12, H = 0.8, pxm = 200;
      const band = lit(W * pxm, H * pxm, (g, w, h) => {
        g.fillStyle = '#00a99a'; g.fillRect(0, 0, w, h);
        g.fillStyle = '#ffd23f'; g.fillRect(0, h * 0.82, w, h * 0.055);
        g.fillStyle = 'rgba(0,70,64,0.5)'; g.fillRect(0, 0, w, h * 0.05);
        const px = x => (x + 6) / W * w;
        g.fillStyle = '#fff8e6'; ctx.tex.roundRect(g, px(-1.65), h * 0.13, px(2.75) - px(-1.65), h * 0.62, 22); g.fill();
        g.fillStyle = '#00a99a'; ctx.tex.roundRect(g, px(-1.52), h * 0.2, h * 0.48, h * 0.48, 14); g.fill();
        g.fillStyle = '#ffd23f'; g.beginPath(); g.arc(px(-1.52) + h * 0.24, h * 0.44, h * 0.13, 0, 7); g.fill();
        text(g, 'ひだまりマート', px(1.15), h * 0.45, h * 0.46, '#007f74', (px(2.7) - px(-0.9)), 900);
        text(g, 'HIDAMARI MART', px(-4.0), h * 0.4, h * 0.2, '#e8fffb', px(-1.9) - px(-5.9), 900);
        text(g, '24時間営業', px(4.2), h * 0.36, h * 0.34, '#ffffff', px(5.9) - px(2.9), 900);
        text(g, 'OPEN 24H', px(4.2), h * 0.66, h * 0.17, '#ffd23f', px(5.5) - px(3.2), 900);
      }, 'art-r1-w1-band-v1', 0.62);
      const m = k.plane(W, H, band, [0, 3.62, -2.4]);
      m.castShadow = false; m.receiveShadow = false; m.userData.noBatch = true; ctx.noOutline(m);
      note('w1-sign-overlay', 2);
    }

    // Warm light spilling from the glass onto the landing and pavement (additive, no depth write).
    {
      const map = ctx.tex.draw(64, 128, (g, w, h) => {
        const gr = g.createLinearGradient(0, 0, 0, h);
        gr.addColorStop(0, 'rgba(255,205,130,1)'); gr.addColorStop(0.55, 'rgba(255,190,110,0.35)'); gr.addColorStop(1, 'rgba(255,180,100,0)');
        g.fillStyle = gr; g.fillRect(0, 0, w, h);
      }, { key: 'art-r1-w1-spill', anisotropy: 4 });
      const glow = new THREE.MeshBasicMaterial({ map, color: new THREE.Color('#ffb875').multiplyScalar(0.62), transparent: true, depthWrite: false,
        blending: THREE.AdditiveBlending, fog: true, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6 });
      glow.name = 'art-r1-w1-light-spill';
      const addSpill = (x0, x1, z0, z1, y) => {
        const geo = new THREE.PlaneGeometry(x1 - x0, z1 - z0, 1, 1); geo.rotateX(-Math.PI / 2);
        // v runs from the glass (z0) outwards (z1).
        const uv = geo.attributes.uv, p = geo.attributes.position;
        for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i), p.getZ(i) < 0 ? 1 : 0);
        geo.translate((x0 + x1) / 2, y, (z0 + z1) / 2);
        const mesh = new THREE.Mesh(geo, glow); mesh.castShadow = false; mesh.receiveShadow = false; mesh.renderOrder = 2; mesh.userData.noBatch = true;
        ctx.noOutline(mesh); S.g.add(mesh);
      };
      addSpill(-2.2, 2.6, -2.6, -1.42, FY + 0.012);
      note('light-spill', 2);
    }
  }

  // ---------------------------------------------------------------- B (round 3): category zones behind the glass
  // The three gondola end caps all faced the window in the same sakura pink, so from the street the
  // shop read as one pale mass. Each end cap now carries its own category colour (back panel and lit
  // header) and a low stacked island of matching goods stands in the aisle in front of it: three
  // colour zones at three depths (island, end cap, gondola rows) that read through the glass.
  {
    const S = C.space('W1'), k = S.k, FY = 0.30, GH = 1.42, Z1 = -4.6;
    const stock = createStock(ctx, 'w1-zones');
    const zones = [
      { cx: -2.65, label: 'お菓子', sub: 'SNACK', bg: '#f08a24', fg: '#ffffff', goods: ['#f2b53b', '#e36b5d', '#ffd24a', '#f08a4b', '#ffffff'] },
      { cx: -0.2, label: 'パン・カップ麺', sub: 'BAKERY', bg: '#f2c230', fg: '#5a3a12', goods: ['#f4e2b8', '#d98a2b', '#e36b5d', '#f2c230', '#ffffff'] },
      { cx: 2.3, label: 'ドリンク', sub: 'DRINK', bg: '#2f78c4', fg: '#ffffff', goods: ['#7ec8ff', '#2f78c4', '#ffffff', '#7bd389', '#9fd6f2'] },
    ];
    for (const z of zones) {
      const panel = M.t(z.bg, { paint: 0.02 });
      // back panel just in front of the pink one (pink sits at z1 + 0.012..0.022)
      k.box(0.84, GH - 0.13, 0.008, panel, [z.cx, FY + 0.13 + (GH - 0.13) / 2, Z1 + 0.027]);
      // shelf lips in the category colour
      for (const y of [0.52, 0.9]) k.box(0.87, 0.046, 0.016, panel, [z.cx, FY + y - 0.014, Z1 + 0.34 + 0.002]);
      // lit header over the pink POP
      const hdr = k.box(0.94, 0.34, 0.012, lit(256, 92, (g, w, h) => {
        g.fillStyle = z.bg; g.fillRect(0, 0, w, h);
        g.fillStyle = 'rgba(255,255,255,0.9)'; g.fillRect(0, h - 10, w, 4);
        text(g, z.label, w / 2, h * 0.4, 46, z.fg, w - 20);
        text(g, z.sub, w / 2, h * 0.8, 18, z.fg, w - 40, 700);
      }, 'art-r3-w1-zone-' + z.sub, 0.5), [z.cx, FY + GH + 0.2, Z1 + 0.05]);
      hdr.userData.noBatch = true;
      // low island of goods in the aisle, three tiers stepping back toward the end cap
      const iz = Z1 + 0.62;
      k.box(0.78, 0.12, 0.42, M.t('#e9ecef', { paint: 0.02 }), [z.cx, FY + 0.06, iz]);
      k.box(0.8, 0.1, 0.012, panel, [z.cx, FY + 0.06, iz + 0.216]);
      const r = ctx.rng('art-r3-island-' + z.sub);
      const tiers = [[0.12, 0.13, 0.36], [0.25, 0.04, 0.24], [0.38, -0.05, 0.12]];
      for (const [y, dz, depth] of tiers) {
        const tall = z.sub === 'DRINK';
        for (let x = -0.33; x <= 0.331; x += tall ? 0.085 : 0.13) {
          const c = z.goods[Math.floor(r() * z.goods.length)];
          if (tall) stock.bottle(z.cx + x, FY + y, iz + dz + depth / 2 - 0.05, 0.07, 0.2, c);
          else stock.box(z.cx + x, FY + y, iz + dz + depth / 2 - 0.06, 0.11, 0.12, 0.09, c, (r() - 0.5) * 0.12);
        }
      }
      S.box(z.cx, iz, 0.8, 0.44, -0.05, FY + 0.6);
      note('w1-zone', 5 * 12 + 12);
    }
    stock.finish(S.g); stats.instancedMeshes += 2; note('w1-zone-stock', stock.triangles);
  }

  // ---------------------------------------------------------------- A: east and west shop fronts
  {
    const sec = (id, build) => { const S = C.space(id); build(S); return S; };
    const E2 = sec('E2', S => {
      const stock = createStock(ctx, 'e2-display');
      crateTower(S, stock, 2.5, gh(S, 2.5, 0.55) + 0.02, 0.55, 0.1, ['#4f7fc4', '#e7c14f', '#4f7fc4'], ['#ffd1e0', '#ffffff', '#9ee0b0']);
      planterPot(S, -2.9, gh(S, -2.9, 0.5) + 0.02, 0.5, 0.2, '#b86a4a', '#5f9a58');
      planterPot(S, -2.45, gh(S, -2.45, 0.62) + 0.02, 0.62, 0.15, '#c9d1d6', '#7aa863');
      board(S, -0.6, gh(S, -0.6, 0.7) + 0.02, 0.7, 0.18, 0.5, 0.86, (g, w, h) => {
        g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h);
        g.fillStyle = '#d9556f'; g.fillRect(0, 0, w, h * 0.22);
        text(g, '桜もち', w / 2, h * 0.11, 62, '#ffffff', w - 20);
        text(g, '季節限定', w / 2, h * 0.4, 50, '#d9556f', w - 24);
        g.fillStyle = '#ffd1e0'; g.beginPath(); g.arc(w / 2, h * 0.7, w * 0.22, 0, 7); g.fill();
        text(g, '1個 ¥160', w / 2, h * 0.9, 38, '#4a3a40', w - 24);
      }, 'art-r1-e2-board');
      stock.finish(S.g); stats.instancedMeshes += 2; note('e2-stock', stock.triangles);
    });
    sec('E1', S => {
      const stock = createStock(ctx, 'e1-display');
      board(S, -3.2, gh(S, -3.2, 0.7) + 0.02, 0.7, -0.15, 0.5, 0.9, (g, w, h) => {
        g.fillStyle = '#3c2f2a'; g.fillRect(0, 0, w, h);
        g.fillStyle = '#ffd23f'; g.fillRect(0, 0, w, h * 0.16);
        text(g, '喫茶 はるいろ', w / 2, h * 0.08, 40, '#3c2f2a', w - 20);
        text(g, 'モーニング', w / 2, h * 0.3, 54, '#ffffff', w - 20);
        text(g, 'ホット ¥350', w / 2, h * 0.52, 44, '#ffd23f', w - 20);
        text(g, 'さくらラテ', w / 2, h * 0.7, 46, '#ff9fbc', w - 20);
        text(g, '8:00-', w / 2, h * 0.88, 40, '#ffffff', w - 20);
      }, 'art-r1-e1-board');
      planterPot(S, 3.9, gh(S, 3.9, 0.45) + 0.02, 0.45, 0.2, '#7e8f95', '#5a9a5f');
      planterPot(S, 4.4, gh(S, 4.4, 0.5) + 0.02, 0.5, 0.16, '#b86a4a', '#86ad68');
      stock.finish(S.g);
    });
    sec('W2', S => {
      const stock = createStock(ctx, 'w2-display');
      crateTower(S, stock, 2.55, gh(S, 2.55, 0.6) + 0.02, 0.6, -0.1, ['#e7c14f', '#4f8fc0'], null);
      planterPot(S, -2.7, gh(S, -2.7, 0.55) + 0.02, 0.55, 0.19, '#c27a5a', '#6aa36a');
      stock.finish(S.g);
    });
  }

  // ---------------------------------------------------------------- round 3: a folding board for every shop
  // Rule: each main-street shop without a hand-dressed front (W1, E1, E2 have theirs) gets one A-board
  // 0.7 m in front of its frontage, 1.6 m in from the lot's downstream end. Colours follow the nobori families.
  {
    const BOARDS = {
      flower: ['季節の花', '#ee8aa6', 'チューリップ', '一束 ¥500'], bookstore: ['新刊入荷', '#2d4b78', '文庫フェア', '2冊で10%OFF'],
      bicycle: ['修理承ります', '#2d4b78', 'パンク修理', '¥1,000〜'], general: ['本日特売', '#d4473e', 'お花見セット', '¥980'],
      ramen: ['ラーメン', '#d4473e', '醤油らーめん', '¥750'],
    };
    stats.shopBoards = [];
    for (const lot of L.LOTS) {
      const b = BOARDS[lot.kind];
      if (!b || ['W1', 'E1', 'E2'].includes(lot.id)) continue;
      const S = C.space(lot.id), w = lot.z1 - lot.z0, lx = -(w / 2 - 1.6), lz = 0.7;
      board(S, lx, gh(S, lx, lz) + 0.02, lz, 0.15, 0.5, 0.86, (g, W, H) => {
        g.fillStyle = '#ffffff'; g.fillRect(0, 0, W, H);
        g.fillStyle = b[1]; g.fillRect(0, 0, W, H * 0.24);
        text(g, b[0], W / 2, H * 0.12, 48, '#ffffff', W - 20);
        text(g, b[2], W / 2, H * 0.48, 42, b[1], W - 24);
        text(g, b[3], W / 2, H * 0.74, 40, '#3a3a40', W - 24);
      }, 'art-r3-board-' + lot.id);
      stats.shopBoards.push(lot.id);
    }
  }

  // ---------------------------------------------------------------- A: nobori flag rows along both kerbs
  {
    const T = 256, designs = [
      // Round 2: three colour families only (vermilion, indigo, sakura), all with white lettering.
      ['桜まつり', '#ee8aa6', '#ffffff'], ['本日特売', '#d4473e', '#ffffff'], ['営業中', '#d4473e', '#ffffff'], ['ラーメン', '#2d4b78', '#ffffff'],
      ['新茶入荷', '#2d4b78', '#ffffff'], ['春の新作', '#ee8aa6', '#ffffff'], ['お花見弁当', '#d4473e', '#ffffff'], ['クリーニング', '#2d4b78', '#ffffff'],
    ];
    const atlas = ctx.tex.draw(T * 4, T * 4, (g, w) => {
      designs.forEach(([label, bg, fg], i) => {
        const x = (i % 4) * T, y = Math.floor(i / 4) * T * 2 % (T * 4);
        const col = i % 4, row = Math.floor(i / 4);
        g.save(); g.translate(col * T, row * T * 2);
        g.fillStyle = bg; g.fillRect(0, 0, T, T * 2);
        g.fillStyle = fg; g.fillRect(10, 10, T - 20, 6); g.fillRect(10, T * 2 - 16, T - 20, 6);
        g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = fg;
        const chars = [...label];
        const size = Math.min(150, (T * 2 - 90) / chars.length);
        chars.forEach((ch, n) => { g.font = `900 ${size}px ${sans}`; g.fillText(ch, T / 2, 60 + size * (n + 0.5)); });
        g.restore();
      });
    }, { key: 'art-r1-nobori-atlas-v2', anisotropy: 8 });
    // The 4 x 4 grid holds eight 1:2 tiles: columns 0..3 in rows 0 (top half) and 1 (second half).
    const flagMat = ctx.mat.toon('#ffffff', { map: atlas, paint: 0.01, emissive: '#ffffff', emissiveIntensity: 0.22, name: 'art-r1-nobori' });
    flagMat.emissiveMap = atlas; flagMat.needsUpdate = true;
    const P = [], N = [], UV = [], I = [];
    const pole = M.t('#dfe2e4', { paint: 0.02 }), base = M.t('#6e7f88', { paint: 0.04 });
    // Round 2: a rule, not a hand list. Every main-street shop lot gets a pair of nobori on its kerb,
    // 1.2 m in from each lot end, with designs by shop kind. W1 (konbini) keeps its own entrance display.
    const NOBORI_BY_KIND = { cafe: [5, 2], wagashi: [4, 0], general: [1, 6], ramen: [3, 2], flower: [0, 5], bookstore: [2, 1], bicycle: [2, 1] };
    const rows = [[1, []], [-1, []]];
    for (const lot of L.LOTS) {
      const designs = NOBORI_BY_KIND[lot.kind];
      if (!designs || lot.id === 'W1') continue;
      rows[lot.side > 0 ? 0 : 1][1].push([lot.z0 + 1.2, designs[0]], [lot.z1 - 1.2, designs[1]]);
    }
    stats.noboriLots = rows.reduce((n, [, l]) => n + l.length / 2, 0);
    const group = new THREE.Group(); group.name = 'art-r1-nobori'; ctx.addStatic(group);
    const k = ctx.kit(group);
    for (const [side, list] of rows) for (const [z, di] of list) {
      const f = L.streetFrame(z, side, 4.2), y = ctx.physics.groundHeight(f.x, f.z, L.heightAt(f.x, f.z) + 0.5);
      const h = 1.25, w = 0.38, top = 1.75, dir = -side; // arm points toward the street
      k.cyl(0.13, 0.15, 0.22, base, [f.x, y + 0.11, f.z], null, 10);
      k.cyl(0.012, 0.012, 2.0, pole, [f.x, y + 1.0 + 0.1, f.z], null, 6);
      k.cyl(0.008, 0.008, w + 0.06, pole, [f.x + dir * (w / 2 + 0.03), y + top + 0.12, f.z], [0, 0, Math.PI / 2], 5);
      const col = di % 4, row = Math.floor(di / 4), u0 = col / 4, u1 = (col + 1) / 4, v1 = 1 - row / 2 * 1, v0 = v1 - 0.5;
      const rowTop = 1 - row * 0.5, rowBot = rowTop - 0.5;
      for (const face of [1, -1]) {
        const start = P.length / 3;
        for (let n = 0; n <= 6; n++) {
          const t = n / 6, wave = Math.sin(t * Math.PI * 1.3) * 0.03 * t;
          for (const yy of [0, 1]) {
            P.push(f.x + dir * (0.03 + t * w), y + top + 0.1 - yy * h, f.z + wave);
            N.push(0, 0, face);
            UV.push(u0 + (face * dir > 0 ? t : 1 - t) / 4, yy ? rowBot : rowTop);
          }
        }
        for (let n = 0; n < 6; n++) {
          const a = start + n * 2, b = a + 1, c = a + 2, d = a + 3;
          const flip = (face * dir) < 0;
          if (flip) I.push(a, c, b, b, c, d); else I.push(a, b, c, b, d, c);
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(UV, 2));
    geo.setIndex(I);
    const mesh = new THREE.Mesh(geo, flagMat); mesh.name = 'art-r1-nobori-flags'; mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.userData.noBatch = true; ctx.noOutline(mesh); group.add(mesh);
    // Round 3: measured, not estimated: every mesh under the nobori group (cloth + poles), by index count.
    let noboriTris = 0;
    group.traverse(o => { if (o.isMesh) noboriTris += (o.geometry.index?.count ?? o.geometry.attributes.position.count) / 3; });
    note('nobori', noboriTris);
    stats.nobori = { flags: rows.reduce((n, [, l]) => n + l.length, 0), triangles: noboriTris, clothTriangles: I.length / 3 };
  }

  return { stats };
}
