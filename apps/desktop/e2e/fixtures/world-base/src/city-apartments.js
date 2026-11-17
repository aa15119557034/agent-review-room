// Original fixture composition using the vendored Sakuragaoka house builders,
// materials and atlases. Their upstream license remains applicable; no new assets.
import { buildWindow } from '../upstream/sakuragaoka/src/world/houses/house.js';
import { PAL } from '../upstream/sakuragaoka/src/world/houses/lot.js';

export function townApartmentBounds({ width: w, depth: d }) {
  const groundSupportBounds = { minX: -w / 2 - 2.05, maxX: w / 2 + .10, minZ: -d - 2.30, maxZ: 0 };
  return { groundSupportBounds, bounds: { ...groundSupportBounds, maxX: w / 2 + .2 } };
}

/** Append a flat-base, non-enterable background apartment to H.gb / H.laundry.
 * F is the frontage centre, +Z faces the street. All returned bounds are F-local.
 * Caller owns terrain support, batching, laundry.build/update and all resources.
 * width/depth describe the main block; rear access and bicycle shelter extend it.
 */
export function buildTownApartment(H, F, spec) {
  const { width: w, depth: d, floors, accent, shop, tone } = spec;
  const { M, A, gb } = H;
  const fh = 2.85, top = floors * fh, front = -1.25, back = -d;
  const white = PAL.paint[(floors - 3) % PAL.paint.length], steel = PAL.metal[0];
  // Two-tone facade: tinted wall planes recede behind white slabs and parapets,
  // so the shaded street face keeps value structure without touching lighting.
  const wall = tone || white;
  const trim = accent, start = gb.tris, clothStart = H.laundry.I.length / 3;
  const garmentStart = H.laundry.count;
  const r = H.ctx.rng(`town-apartment-${floors}-${F.origin.x}-${F.origin.z}`);
  const uv = { world: 3 };
  const at = name => ({ uv: { rect: A.rects[name], white: A.white } });
  const face = F.sub(0, 0, front), rear = F.sub(0, 0, back, Math.PI);
  const S = { frameColor: PAL.frame[4], sillColor: PAL.frame[4], grilleColor: PAL.frame[4],
    shutterColor: PAL.shutter[0], shutterStyle: 'none', shutterClosed: 0,
    trim, interiors: null, roof: { mat: 'metal', color: steel }, wall: { kind: 'paint', color: white },
    floorY: 0, fh, groundMin: 0, lod: 0, rng: r };
  const unit = w / 3;

  for (let fl = 0; fl < floors; fl++) {
    const y = fl * fh;
    // Individual storey shells and slabs: no scaled two-storey model.
    F.boxB(M.plain, white, w, .14, d + front, 0, y, (back + front) / 2);
    for (const side of [-1, 1]) F.boxB(M.plaster, wall, .2, fh, d + front,
      side * (w / 2 - .1), y, (back + front) / 2, { uv });
    F.boxB(M.plaster, wall, w, fh, .18, 0, y, back + .09, { uv });
    if (shop && fl === 0) {
      const wing = (w - 6) / 2;
      for (const side of [-1, 1]) F.boxB(M.plaster, wall, wing, fh, .18,
        side * (3 + wing / 2), y, front - .09, { uv });
      F.boxB(M.plaster, wall, 6, .49, .18, 0, 2.36, front - .09, { uv });
    } else F.boxB(M.plaster, wall, w, fh, .18, 0, y, front - .09, { uv });
    F.box(M.plain, trim, w + .08, .13, .14, 0, y + fh - .1, front + .02);

    for (let u = 0; u < 3; u++) {
      const x = (u - 1) * unit;
      if (!(shop && fl === 0)) {
        if (fl === 0 && u === 1) {
          face.boxB(M.plain, steel, 1.14, 2.18, .08, 0, .14, .04);
          face.boxB(M.atlas, '#ffffff', 1.02, 2.06, .025, 0, .17, .095, at('door_steel'));
        } else buildWindow(H, face, x, y + .3, 1.75, 1.92, 'std', S, r, 0, 'balc', fl);
      }
      // Generic steel doors deliberately have no invented upper-floor room labels.
      rear.boxB(M.plain, steel, 1.03, 2.12, .07, x, y + .14, .035);
      rear.boxB(M.atlas, '#ffffff', .92, 2.02, .025, x, y + .18, .085, at('door_steel'));
      if (fl > 0) {
        F.boxB(M.plain, white, unit - .04, 1.05, .13, x, y + .14, -.185);
        F.box(M.plain, trim, unit - .04, .055, .16, x, y + 1.215, -.185);
      }
    }
    if (fl > 0) {
      F.boxB(M.plain, white, w, .14, 1.1, 0, y, -.7);
      for (const x of [-w / 2 + .06, -unit / 2, unit / 2, w / 2 - .06])
        F.boxB(M.plain, white, .12, 1.85, 1.05, x, y + .14, -.725);
      // A few inhabited balconies, not one clothes line per window.
      if (fl === 1 || (floors === 5 && fl === 3)) {
        const x = (fl === 1 ? -1 : 1) * unit;
        F.box(M.metal, steel, 1.65, .025, .025, x, y + 2.22, -.57);
        for (const dx of [-.75, .75]) F.beam(M.metal, steel,
          [x + dx, y + 2.22, -1.24], [x + dx, y + 2.22, -.52], .025, .025);
        H.laundry.line(F, x - .72, x + .72, y + 2.21, -.57, r, 'apartment');
      }
    }
    for (const side of [-1, 1]) {
      const sf = F.sub(side * w / 2, 0, (front + back) / 2, side * Math.PI / 2);
      buildWindow(H, sf, 0, y + .95, 1.1, 1.15, 'mid', S, r, 0, 'side', fl);
    }
    // Rear corridor leaves a central opening for both ends of the stair flight.
    F.boxB(M.plain, white, w, .14, 1.05, 0, y, back - .525);
    if (fl > 0) for (const side of [-1, 1]) {
      const len = w / 2 - 2.65;
      F.boxB(M.plain, white, len, .98, .12, side * (2.65 + len / 2), y + .14, back - 1);
    }
  }

  // Alternating straight flights, 16 real treads per level; visual only, no collider.
  const stairZ = back - 1.65, steps = 16, run = 4, rise = fh / steps;
  for (let fl = 0; fl < floors - 1; fl++) {
    const dir = fl % 2 ? -1 : 1, y = fl * fh + .14;
    for (let i = 0; i < steps; i++) {
      const x = dir * (-run / 2 + (i + .5) * run / steps);
      F.box(M.metal, steel, run / steps + .01, .045, 1.05, x, y + (i + 1) * rise - .0225, stairZ);
    }
    for (const dz of [-.5, .5]) {
      const a = [dir * -2, y, stairZ + dz], b = [dir * 2, y + fh, stairZ + dz];
      F.beam(M.metal, steel, a, b, .07, .12);
      F.beam(M.metal, steel, [a[0], a[1] + .95, a[2]], [b[0], b[1] + .95, b[2]], .04, .04);
      for (let i = 0; i <= 4; i++) F.boxB(M.metal, steel, .035, .95, .035,
        dir * (-2 + i), y + i * fh / 4, stairZ + dz);
    }
    // Landings join each end to the corridor, rather than ending over empty space.
    for (const [x, level] of [[dir * -2.3, y], [dir * 2.3, y + fh]])
      F.box(M.metal, steel, .6, .10, 1.25, x, level - .05, back - 1.55);
  }

  F.box(M.plain, white, w + .4, .16, d + front + .3, 0, top + .08, (back + front) / 2);
  // Low parapet and simple steel roof guard, without dense repeated balusters.
  for (const z of [front, back]) {
    F.boxB(M.plain, white, w, .35, .14, 0, top + .16, z);
    F.box(M.metal, steel, w, .04, .04, 0, top + 1.05, z);
    for (let x = -w / 2; x <= w / 2 + .01; x += w / 6)
      F.boxB(M.metal, steel, .04, .7, .04, x, top + .35, z);
  }
  for (const x of [-w / 2, w / 2]) {
    F.boxB(M.plain, white, .14, .35, d + front, x, top + .16, (back + front) / 2);
    F.box(M.metal, steel, .04, .04, d + front, x, top + 1.05, (back + front) / 2);
    for (let i = 1; i <= 3; i++) F.boxB(M.metal, steel, .04, .7, .04, x, top + .35, back + (d + front) * i / 4);
  }
  const tankX = w * .24, tankZ = back + 1.6;
  for (const dx of [-.5, .5]) for (const dz of [-.5, .5])
    F.boxB(M.metal, steel, .08, .55, .08, tankX + dx, top + .16, tankZ + dz);
  F.cyl(M.plain, PAL.tile[0], .78, 1.25, tankX, top + 1.31, tankZ, { seg: 10 });
  F.cyl(M.metal, steel, .81, .07, tankX, top + 1.97, tankZ, { seg: 10 });
  F.cyl(M.metal, steel, .12, .18, tankX, top + 2.095, tankZ, { seg: 6 });
  H.P.acUnit(face, w / 2 - .65, .16, .55, 0);
  face.box(M.atlas, '#ffffff', 2.2, .55, .035, 0, top - .65, .035, at('apt_sign'));

  // Bicycle shelter and unnumbered POST boxes reuse the house atlas.
  const bx = -w / 2 - 1.05;
  for (const dx of [-.78, .78]) for (const z of [-4.7, -1.8])
    F.boxB(M.metal, steel, .055, 2.08, .055, bx + dx, 0, z);
  F.box(M.poly, null, 1.8, .06, 3.5, bx, 2.12, -3.25);
  for (let i = 0; i < 3; i++) {
    F.box(M.metal, steel, 1.25, .04, .04, bx, .12, -2.2 - i * .8);
    F.boxB(M.atlas, '#ffffff', .38, .3, .18, -w / 2 + .35 + i * .42, .95, -.5, at('mailbox'));
  }
  F.boxB(M.plain, white, 1.38, .95, .2, -w / 2 + .77, 0, -.55);

  if (shop) buildLaundryShop(H, F, front, trim);
  const footprint = townApartmentBounds(spec), groundSupportBounds = footprint.groundSupportBounds;
  const bounds = { ...footprint.bounds, minY: 0, maxY: top + 2.185 };
  const supportSamples = [];
  for (const x of [groundSupportBounds.minX, 0, groundSupportBounds.maxX])
    for (const z of [groundSupportBounds.minZ, (back + front) / 2, 0]) supportSamples.push({ x, z });
  return { bounds, groundSupportBounds, supportSamples, floors, floorHeight: fh, height: bounds.maxY,
    entrances: [{ x: 0, y: .14, z: 0, width: shop ? 1.2 : 1.02 }],
    triangles: gb.tris - start, laundryTriangles: H.laundry.I.length / 3 - clothStart,
    garments: H.laundry.count - garmentStart,
    features: { balconies: floors - 1, rearCorridor: true, stairFlights: floors - 1,
      stairTreads: (floors - 1) * steps, roofTank: true, bicycleShelter: true, mailboxes: 3,
      shop: shop ? 'laundromat' : null, walkable: false } };
}

function buildLaundryShop(H, F, front, accent) {
  const { M } = H;
  F.boxB(M.plain, '#f6efe2', 5.8, 2.35, .12, 0, .14, front - 2.2);
  // Warm ceiling strips make the shop read as open and lit from the street.
  for (const z of [front - .6, front - 1.6]) F.box(M.lamp, null, 4.6, .04, .16, 0, 2.3, z, { shadow: false });
  // Visible front-load machines identify the small shop without a new text atlas.
  for (const x of [-2.1, -1.2, 1.2, 2.1]) {
    F.boxB(M.plain, '#e9e9e2', .76, 1.25, .65, x, .14, front - .7);
    F.cyl(M.metal, '#8e949b', .265, .055, x, .77, front - .345, { seg: 12, rx: Math.PI / 2 });
    F.cyl(M.plain, '#43586b', .205, .06, x, .77, front - .31, { seg: 12, rx: Math.PI / 2 });
    F.box(M.plain, accent, .5, .10, .02, x, 1.24, front - .365);
  }
  for (const x of [-3, -.6, .6, 3]) F.boxB(M.metal, '#8e949b', .055, 2.25, .07, x, .14, front + .035);
  F.box(M.metal, '#8e949b', 6, .055, .07, 0, 2.36, front + .035);
  // The city owns this clear-glass clone; shared house glass stays unchanged.
  const shopGlass = H.shopGlass;
  for (const x of [-1.8, 1.8]) F.boxB(shopGlass, null, 2.34, 2.14, .012, x, .18, front + .025, { shadow: false });
  F.boxB(shopGlass, null, 1.14, 2.14, .012, 0, .18, front + .025, { shadow: false });
  F.box(M.metal, '#8e949b', .025, .4, .1, .47, 1.12, front + .09);
  F.box(M.plain, accent, 6.25, .11, 1.05, 0, 2.52, front + .525);
  F.box(M.plain, accent, 6.25, .23, .07, 0, 2.43, front + 1.015);
  // Washer-symbol sign (geometry); apartment name itself uses existing apt_sign.
  F.box(M.plain, '#e9e9e2', .65, .55, .045, -2.65, 2.43, front + 1.065);
  F.cyl(M.metal, '#8e949b', .2, .025, -2.65, 2.43, front + 1.1, { seg: 12, rx: Math.PI / 2 });
  F.cyl(M.plain, '#43586b', .14, .03, -2.65, 2.43, front + 1.12, { seg: 12, rx: Math.PI / 2 });
}
