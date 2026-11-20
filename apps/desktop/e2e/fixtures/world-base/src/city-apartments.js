// Original three-building composition. Geometry/atlas helpers retain Sakuragaoka
// MIT provenance; photo-source PBR maps are pinned separately in apartment-assets.json.
import * as THREE from 'three';
import { buildWindow } from '../upstream/sakuragaoka/src/world/houses/house.js';
import { PAL } from '../upstream/sakuragaoka/src/world/houses/lot.js';

const FH = 2.85;
export function townApartmentBounds({ width: w, depth: d }) {
  const groundSupportBounds = { minX: -w / 2 - 2.05, maxX: w / 2 + .10, minZ: -d - 2.30, maxZ: 0 };
  return { groundSupportBounds, bounds: { ...groundSupportBounds, maxX: w / 2 + .20 } };
}

/** Append genuine storeys/openings/loggias to the existing GB. No scene-scale
 * manipulation: the frontage/entrance and surveyed support footprint stay fixed.
 * H.apartmentSurfaces is prepared asynchronously by the city owner beforehand. */
export function buildTownApartment(H, F, spec) {
  const { width: w, depth: d, floors, shop } = spec;
  if (![3, 4, 5].includes(floors) || !H.apartmentSurfaces?.materials) throw new Error('Apartment requires 3/4/5 floors and prepared PBR surfaces');
  const { plaster, tile, metal, roof } = H.apartmentSurfaces.materials;
  const { M, A, gb } = H, top = floors * FH, back = -d, baseFront = -1.25, unit = w / 3;
  const start = gb.tris, clothStart = H.laundry.I.length / 3, garments = H.laundry.count;
  const wall = floors === 3 ? '#f0e9d7' : floors === 4 ? '#c6d3d6' : '#dce4e4';
  const trim = floors === 3 ? '#d1d0c1' : floors === 4 ? '#b9c6c9' : '#c6cfd0';
  // Round 7 (#254 X-51): railings are a lighter painted teal-grey so thin bars do not read as black lines against lit windows.
  const steel = '#7f9692', dark = '#4c6463', rail = '#6d8985', r = H.ctx.rng(`apartment-rebuild-${floors}`);
  const S = { frameColor: dark, sillColor: '#a8aeaa', grilleColor: dark,
    shutterColor: dark, shutterStyle: 'none', shutterClosed: 0, trim,
    interiors: null, roof: { mat: 'metal', color: steel }, wall: { kind: 'paint', color: wall },
    floorY: 0, fh: FH, groundMin: 0, lod: 0, rng: r };
  const records = [], openings = [], balconies = [], lamps = [];
  const record = (kind, position, extra = {}) => records.push({ kind, position, ...extra });
  const detailStart = gb.tris;
  for (let fl = 0; fl < floors; fl++) {
    const y = fl * FH;
    // 3F top storey retreats to form a terrace; 4F has deep sheltered loggias;
    // 5F alternates the right bays around a continuous masonry service spine.
    const front = floors === 3 && fl === floors - 1 ? -1.90 : baseFront;
    F.boxB(plaster, trim, w, .16, d + front, 0, y, (back + front) / 2, { uv: { world: 1.5 } });
    for (let bay = 0; bay < 3; bay++) {
      const x = (bay - 1) * unit;
      if (shop && fl === 0) continue;
      const isSpine = floors === 5 && bay === 0;
      const bayFront = floors === 4 && fl > 0 ? -1.70 : floors === 5 && fl > 0 && bay > 0 ? front - ((fl + bay) % 2) * .32 : front;
      const ff = F.sub(x, 0, bayFront);
      const entry = fl === 0 && bay === 1;
      const opening = { x: 0, y: y + (entry ? .14 : isSpine ? .76 : .28), w: entry ? 1.12 : isSpine ? 1.24 : 2.18, h: entry ? 2.13 : isSpine ? 1.42 : 2.08 };
      wallOpening(H, ff, unit, y + .14, FH - .14, opening, isSpine ? tile : plaster, isSpine ? '#c3c5bf' : wall);
      if (entry) recessedDoor(H, ff, opening);
      else recessedWindow(H, ff, opening, S, r, fl);
      openings.push({ face: 'front', floor: fl + 1, ...opening, x, planeZ: bayFront, revealDepth: .26 });
      if (fl > 0 && !isSpine) {
        const outer = floors === 3 ? -.18 : floors === 4 ? -.24 : -.18 - ((fl + bay) % 2) * .12;
        const bw = unit - (floors === 3 ? .30 : .12), slabTop = y + .16;
        F.boxB(plaster, trim, bw, .16, outer - bayFront + .06, x, y, (outer + bayFront) / 2, { uv: { world: 1.5 } });
        // Finish tile on a real slab, with a narrow metal drip at its exposed lip.
        F.box(tile, '#b3b6ab', bw - .09, .014, outer - bayFront - .07, x, slabTop + .007, (outer + bayFront) / 2, { uv: { world: 2 }, skip: 'd' });
        F.box(metal, steel, bw, .055, .035, x, y + .075, outer + .025, { uv: { world: 1 } });
        const solid = floors === 5 ? .38 : 0;
        if (solid) F.boxB(tile, '#c4c7c1', bw, solid, .11, x, slabTop, outer - .035, { uv: { world: 2 } });
        railing(F, metal, rail, [x - bw / 2 + .055, slabTop + solid, outer - .04], [x + bw / 2 - .055, slabTop + solid, outer - .04], 1.02 - solid, floors === 3 ? .17 : .20);
        for (const side of [-1, 1]) {
          const bx = x + side * (bw / 2 - .045);
          if (floors === 4) {
            F.boxB(plaster, trim, .13, 2.20, outer - bayFront, bx, slabTop, (outer + bayFront) / 2, { uv: { world: 1.5 } });
            F.box(metal, steel, .17, .035, outer - bayFront + .03, bx, slabTop + 2.22, (outer + bayFront) / 2, { uv: { world: 1 } });
          } else railing(F, metal, rail, [bx, slabTop, bayFront + .09], [bx, slabTop, outer - .04], 1.02, .22);
        }
        // Balcony drain goes into the downpipe rather than ending over the lane.
        F.box(metal, '#666e6b', .11, .018, .11, x + bw / 2 - .17, slabTop + .018, outer - .19);
        balconies.push({ floor: fl + 1, bay, x, minZ: bayFront, maxZ: outer, width: bw, floorTop: slabTop, railHeight: 1.02, type: floors === 4 ? 'recessed-loggia' : floors === 3 ? 'open-cantilever' : 'staggered-tiled-loggia' });
        if ((fl === 1 && bay === 0) || (floors === 5 && fl === 3 && bay === 2)) {
          const z = (outer + bayFront) / 2;
          for (const dx of [-.77, .77]) F.beam(metal, steel, [x + dx, y + 2.32, bayFront], [x + dx, y + 2.32, z], .025, .035);
          F.box(metal, steel, 1.65, .025, .025, x, y + 2.32, z);
          H.laundry.line(F, x - .72, x + .72, y + 2.30, z, r, 'apartment');
          record('laundry', [x, y + 2.30, z], { floor: fl + 1 });
        }
      }
    }
    if (floors === 5 && fl > 0) {
      const planes = [front, front - ((fl + 1) % 2) * .32, front - ((fl + 2) % 2) * .32];
      for (let j = 0; j < 2; j++) if (planes[j] !== planes[j + 1]) F.boxB(plaster, wall, .18, FH - .16,
        Math.abs(planes[j] - planes[j + 1]) + .26, (j - .5) * unit, y + .16, (planes[j] + planes[j + 1]) / 2 - .13, { uv: { world: 1.5 } });
    }
    // Two actual recessed openings per side per storey. There is no continuous
    // wall behind the window: jambs/header/spandrel form the aperture perimeter.
    for (const side of [-1, 1]) {
      const sf = F.sub(side * w / 2, 0, (back + front) / 2, side * Math.PI / 2);
      const length = d + front;
      for (const sign of [-1, 1]) {
        const ff = sf.sub(sign * length / 4, 0, 0);
        const opening = { x: 0, y: y + .81, w: 1.24, h: 1.36 };
        wallOpening(H, ff, length / 2, y + .16, FH - .16, opening, plaster, wall);
        recessedWindow(H, ff, opening, S, r, fl);
      }
    }
    // Open rear access, separated from the solid building by recessed doors.
    const rear = F.sub(0, 0, back, Math.PI);
    for (let bay = 0; bay < 3; bay++) {
      const x = (bay - 1) * unit, ff = rear.sub(x, 0, 0);
      const opening = { x: 0, y: y + .16, w: 1.03, h: 2.08 };
      wallOpening(H, ff, unit, y + .16, FH - .16, opening, plaster, wall);
      recessedDoor(H, ff, opening);
      rear.box(M.lamp, null, .24, .065, .08, x + .75, y + 2.42, .045, { shadow: false });
      // Art round 9: registered for the fake light pools (door-glow.js). City-root coordinates; the wall face is rear z = 0,
      // outward is rear +z, the corridor slab top is 0.14 m above the storey line and 1.05 m deep.
      lamps.push({ lamp: rear.w(x + .75, y + 2.42, 0).toArray(), floor: rear.w(x + .75, y + .14, 0).y,
        normal: new THREE.Vector3(0, 0, 1).transformDirection(rear.m).toArray(), slabDepth: 1.05, floorIndex: fl });
      if (bay === 0) H.P.elecMeter(rear, x + 1.0, y + 1.35);
    }
    // Art round 3: the rear-corridor dressing is a rule for every apartment, not only the shot-C one
    // (that one keeps its hand-placed fence, pipes and cardboard from round 1/2).
    if (fl === 0 && !shop && H.artRearCorridor) H.artRearCorridor(rear, { unit, w, floorY: y + .14, rng: H.ctx.rng(`art-r3-rear-${floors}`) });
    // Art round 8: doorstep life (umbrellas, pots, buckets) at every corridor door, clear of the round-3 cardboard
    // and of the laundromat's hand-placed broom corner (shop rear, x -5.4..-4.6) and first-floor parcels (x -5.4..-4.8, #254 r8 check).
    if (H.artDoorsteps) H.artDoorsteps(rear, { unit, floorY: y + .14, ground: fl === 0, rng: H.ctx.rng(`art-r8-door-${floors}-${fl}`),
      avoid: fl === 0 ? (shop ? [[-5.5, -4.5]] : [[unit / 2 - .5, unit / 2 + 1.0]]) : shop && fl === 1 ? [[-5.5, -4.6]] : [] });
    F.boxB(plaster, trim, w, .14, 1.05, 0, y, back - .525, { uv: { world: 1.5 } });
    if (fl > 0) for (const side of [-1, 1]) railing(F, metal, rail,
      [side < 0 ? -w / 2 + .08 : 2.66, y + .14, back - 1.01],
      [side < 0 ? -2.66 : w / 2 - .08, y + .14, back - 1.01], 1.02, .18);
    // Slender continuous stringcourses catch grazing light without hiding wall relief.
    for (const side of [-1, 1]) F.box(plaster, trim, .16, .095, d + front, side * (w / 2 - .07), y + FH - .08, (back + front) / 2, { uv: { world: 1.5 } });
  }
  const stairs = rearStairs(H, F, floors, back, steel);
  const roofInfo = roofscape(H, F, spec, wall, trim, steel);
  // Parallel downpipes pick up each slab via short elbows. All are wall-mounted.
  for (const x of [-w / 2 + .28, w / 2 - .28]) {
    const z = baseFront + .055;
    F.cyl(metal, steel, .038, top + .10, x, top / 2 + .19, z, { seg: 8 });
    for (let fl = 0; fl < floors; fl++) {
      F.box(metal, '#687371', .12, .04, .12, x, fl * FH + .6, z - .02);
      F.beam(metal, steel, [x, fl * FH + .21, z], [x, fl * FH + .14, -.28], .045, .045);
    }
    record('rainpipe', [x, .14, z], { top: top + .24, diameter: .076, gutterBottom: top + .1725 });
  }
  F.box(metal, steel, w - .36, .035, .14, 0, top + .19, baseFront + .045, { uv: { world: 1 } });
  for (const z of [baseFront - .015, baseFront + .105]) F.box(metal, steel, w - .36, .10, .02, 0, top + .235, z, { uv: { world: 1 } });
  // The west elevation is exposed to the fixed rear eye view. Put equipment
  // between the two windows, with feet/brackets and a conduit into the building.
  const west = F.sub(-w / 2, 0, (back + baseFront) / 2, -Math.PI / 2);
  for (let fl = 1; fl < floors; fl++) {
    H.P.acUnit(west, 0, fl * FH + .45, .16, 0);
    west.box(metal, steel, .06, .58, .07, .52, fl * FH + .72, .05);
    record('ac', [-w / 2 - .16, fl * FH + .45, (back + baseFront) / 2], { floor: fl + 1 });
  }
  // Shared, physically sized shelter/mailboxes remain in the surveyed footprint.
  const bx = -w / 2 - 1.05;
  for (const dx of [-.78, .78]) for (const z of [-4.7, -1.8]) F.boxB(metal, steel, .055, 2.08, .055, bx + dx, 0, z);
  F.box(roof, '#a5aea7', 1.8, .06, 3.5, bx, 2.12, -3.25, { uv: { world: 1.5 } });
  for (let i = 0; i < 3; i++) {
    F.box(metal, steel, 1.25, .04, .04, bx, .12, -2.2 - i * .8);
    F.boxB(M.atlas, '#ffffff', .38, .30, .18, -w / 2 + .35 + i * .42, .95, -.50, { uv: { rect: A.rects.mailbox, white: A.white } });
  }
  F.boxB(plaster, trim, 1.38, .95, .2, -w / 2 + .77, 0, -.55, { uv: { world: 1.5 } });
  const storefront = shop ? buildLaundryShop(H, F, baseFront) : null;
  // Art round 11: the laundromat room (inner faces of the rear tile wall and the glass front, floor, ground-floor ceiling), apartment-frame
  // box [x0, y0, z0, x1, y1, z1]; city.js registers it in ctx.services.shopInteriors so it gets the same indoor lighting as the shops.
  const shopRoom = storefront ? [-3.0, .14, baseFront - 2.14, 3.0, FH, baseFront] : null;
  const footprint = townApartmentBounds(spec), bounds = { ...footprint.bounds, minY: 0, maxY: roofInfo.maxY };
  const supportSamples = [];
  for (const x of [footprint.groundSupportBounds.minX, 0, footprint.groundSupportBounds.maxX])
    for (const z of [footprint.groundSupportBounds.minZ, (back + baseFront) / 2, 0]) supportSamples.push({ x, z });
  const cloth = H.laundry.I.length / 3 - clothStart;
  return { bounds, groundSupportBounds: footprint.groundSupportBounds, supportSamples,
    floors, floorHeight: FH, height: bounds.maxY, lamps, shopRoom, entrances: [{ x: 0, y: .14, z: 0, width: shop ? 1.2 : 1.02 }],
    triangles: gb.tris - start, laundryTriangles: cloth, garments: H.laundry.count - garments,
    facade: { items: records, gbTriangles: gb.tris - detailStart, clothTriangles: cloth, totalTriangles: gb.tris - detailStart + cloth,
      scope: 'Complete facade reconstruction, not the retired 900-triangle decoration allowance' },
    architecture: { variant: floors === 3 ? 'terraced-open-balconies' : floors === 4 ? 'masonry-loggias-over-laundry' : 'staggered-loggias-service-spine', openings, balconies, roof: roofInfo },
    storefront, features: { balconies: balconies.length, rearCorridor: true, stairFlights: floors - 1,
      stairTreads: stairs.treads, roofTank: true, bicycleShelter: true, mailboxes: 3, shop: shop ? 'laundromat' : null, walkable: false } };
}

function wallOpening(H, F, width, bottom, height, hole, material, color) {
  const left = hole.x - hole.w / 2, right = hole.x + hole.w / 2, top = bottom + height, t = .26;
  if (left <= -width / 2 || right >= width / 2 || hole.y < bottom - 1e-6 || hole.y + hole.h > top) throw new Error('Window/door aperture leaves its wall bay');
  const block = (a, b, lo, hi) => { if (b - a > .001 && hi - lo > .001) F.boxB(material, color, b - a, hi - lo, t, (a + b) / 2, lo, -t / 2, { uv: { world: material === H.apartmentSurfaces.materials.tile ? 2 : 1.5, ou: (a + b) / 2, ov: (lo + hi) / 2 } }); };
  block(-width / 2, left, bottom, top); block(right, width / 2, bottom, top);
  block(left, right, bottom, hole.y); block(left, right, hole.y + hole.h, top);
}

function recessedWindow(H, F, o, S, r, fl) {
  buildWindow(H, F.sub(0, 0, -.245), o.x, o.y, o.w, o.h, o.h > 1.7 ? 'std' : 'mid', S, r, 0, 'side', fl);
  const m = H.apartmentSurfaces.materials.metal;
  F.box(m, '#b0b5b0', o.w + .18, .045, .40, o.x, o.y - .027, -.035, { uv: { world: 1 }, skip: 'b' });
  F.box(m, '#7d8987', o.w + .18, .035, .025, o.x, o.y - .056, .155, { uv: { world: 1 } });
  F.box(m, '#b5bab4', o.w + .22, .035, .27, o.x, o.y + o.h + .025, -.035, { uv: { world: 1 } });
}

function recessedDoor(H, F, o) {
  const { M, A } = H, m = H.apartmentSurfaces.materials.metal;
  F.boxB(m, '#84918d', o.w, o.h, .045, o.x, o.y, -.21, { uv: { world: 1 } });
  F.boxB(M.atlas, '#ffffff', o.w - .06, o.h - .06, .012, o.x, o.y + .03, -.181, { uv: { rect: A.rects.door_steel, white: A.white }, skip: 'rltdb' });
  for (const side of [-1, 1]) F.boxB(m, '#646f70', .045, o.h, .24, o.x + side * (o.w / 2 - .02), o.y, -.12, { uv: { world: 1 } });
  F.box(m, '#a3aaa4', o.w, .035, .30, o.x, o.y + .01, -.09, { uv: { world: 1 } });
}

function railing(F, mat, color, a, b, height, spacing) {
  const dx = b[0] - a[0], dz = b[2] - a[2], length = Math.hypot(dx, dz), n = Math.ceil(length / spacing);
  if (length <= .01) return;
  F.beam(mat, color, [a[0], a[1] + height, a[2]], [b[0], b[1] + height, b[2]], .045, .045, { uv: { world: 1 } });
  F.beam(mat, color, [a[0], a[1] + .09, a[2]], [b[0], b[1] + .09, b[2]], .025, .025, { uv: { world: 1 } });
  for (let i = 0; i <= n; i++) F.boxB(mat, color, i === 0 || i === n ? .038 : .018, height, i === 0 || i === n ? .038 : .018,
    a[0] + dx * i / n, a[1], a[2] + dz * i / n, { uv: { world: 1 }, skip: 'td' });
}

function rearStairs(H, F, floors, back, steel) {
  const m = H.apartmentSurfaces.materials.metal, stairZ = back - 1.65, steps = 16, run = 4, rise = FH / steps;
  for (let fl = 0; fl < floors - 1; fl++) {
    const dir = fl % 2 ? -1 : 1, y = fl * FH + .14;
    for (let i = 0; i < steps; i++) {
      const x = dir * (-run / 2 + (i + .5) * run / steps);
      F.box(m, steel, run / steps + .01, .045, 1.05, x, y + (i + 1) * rise - .0225, stairZ, { uv: { world: 1 } });
    }
    for (const dz of [-.5, .5]) {
      const a = [dir * -2, y, stairZ + dz], b = [dir * 2, y + FH, stairZ + dz];
      F.beam(m, steel, a, b, .07, .12, { uv: { world: 1 } });
      F.beam(m, steel, [a[0], a[1] + .95, a[2]], [b[0], b[1] + .95, b[2]], .04, .04);
      for (let i = 0; i <= 8; i++) F.boxB(m, steel, .025, .95, .025, dir * (-2 + i / 2), y + i * FH / 8, stairZ + dz, { skip: 'td' });
    }
    for (const [x, level] of [[dir * -2.3, y], [dir * 2.3, y + FH]]) F.box(m, steel, .6, .10, 1.25, x, level - .05, back - 1.55, { uv: { world: 1 } });
  }
  return { treads: (floors - 1) * steps };
}

function roofscape(H, F, { width: w, depth: d, floors }, wall, trim, steel) {
  const { plaster, tile, metal, roof } = H.apartmentSurfaces.materials, top = floors * FH, back = -d, front = -1.25;
  F.box(roof, '#a5ada8', w + .24, .17, d + front + .20, 0, top + .085, (back + front) / 2, { uv: { world: 1.5 } });
  for (const z of [front, back]) {
    F.boxB(plaster, trim, w, .46, .15, 0, top + .17, z, { uv: { world: 1.5 } });
    F.box(metal, steel, w + .08, .045, .21, 0, top + .65, z, { uv: { world: 1 } });
  }
  for (const x of [-w / 2, w / 2]) {
    F.boxB(plaster, trim, .15, .46, d + front, x, top + .17, (back + front) / 2, { uv: { world: 1.5 } });
    F.box(metal, steel, .21, .045, d + front, x, top + .65, (back + front) / 2, { uv: { world: 1 } });
  }
  const equipmentX = floors === 5 ? -w * .25 : w * .25, equipmentZ = back + 2.1;
  const roomHeight = floors === 3 ? 1.3 : floors === 4 ? 1.7 : 2.3;
  F.boxB(plaster, wall, 2.45, roomHeight, 2.75, equipmentX, top + .17, equipmentZ, { uv: { world: 1.5 } });
  F.box(roof, '#8e9b97', 2.65, .14, 2.95, equipmentX, top + .17 + roomHeight + .07, equipmentZ, { uv: { world: 1 } });
  // Real louvres in front of the roof utility room, rather than a painted stripe.
  F.box(metal, '#586561', 1.3, .95, .06, equipmentX, top + .85, equipmentZ + 1.40, { uv: { world: 1 } });
  for (let i = 0; i < 9; i++) F.box(metal, steel, 1.30, .035, .09, equipmentX, top + .46 + i * .09, equipmentZ + 1.45, { rx: -.25 });
  const tankX = -equipmentX, tankZ = back + 2.15;
  for (const dx of [-.55, .55]) for (const dz of [-.55, .55]) F.boxB(metal, steel, .08, .5, .08, tankX + dx, top + .17, tankZ + dz);
  F.cyl(metal, '#c9cfca', .85, 1.4, tankX, top + 1.37, tankZ, { seg: 20 });
  for (const y of [top + .72, top + 2.04]) F.cyl(metal, steel, .875, .055, tankX, y, tankZ, { seg: 20 });
  F.cyl(metal, '#c9cfca', .85, .08, tankX, top + 2.11, tankZ, { seg: 20, rTop: .75 });
  F.cyl(metal, steel, .11, .24, tankX, top + 2.24, tankZ, { seg: 8 });
  F.cyl(metal, steel, .045, 1.8, tankX + .90, top + 1.08, tankZ, { seg: 8 });
  F.beam(metal, steel, [tankX + .90, top + .20, tankZ], [tankX + .90, top + .20, front], .07, .07);
  if (floors === 3) {
    // A short slatted terrace canopy makes the low building read independently.
    for (const x of [-2.1, 2.1]) {
      for (const z of [front - .65, front - 1.85]) F.boxB(metal, steel, .08, 1.65, .08, x, top + .17, z);
      F.box(metal, steel, .08, .07, 1.60, x, top + 1.80, front - 1.25);
    }
    for (let i = 0; i < 8; i++) F.box(roof, '#9caba1', 4.4, .065, .10, 0, top + 1.85, front - .55 - i * .20, { uv: { world: 1 } });
  }
  return { parapetHeight: .46, headhouseHeight: roomHeight, tankRadius: .85,
    maxY: top + Math.max(2.36, roomHeight + .31), sourceGeometry: 'Actual caps, rails, room, louvres, tank bands and connecting pipe; no scaled proxy' };
}

function buildLaundryShop(H, F, front) {
  const { M, gb } = H, start = gb.tris;
  const teal = '#326e70', dark = '#274e54', cream = '#eee9d9', brass = '#c8ac79';
  // Reuse the kit's ceramic/paving maps at a small, legible physical scale.
  // The pale tiled backdrop keeps the actual white machine bodies readable.
  F.boxB(M.tile, '#b2cac1', 5.8, 2.35, .12, 0, .14, front - 2.2, { uv: { world: 1.2 } });
  F.box(M.paver, '#8d9b98', 5.8, .01, 2.1, 0, .14, front - 1.1, { uv: { world: 1.2 }, shadow: false });
  // Warm ceiling strips make the shop read as open and lit from the street.
  for (const z of [front - .6, front - 1.6]) F.box(M.lamp, null, 4.6, .04, .16, 0, 2.3, z, { shadow: false });
  // Visible front-load machines identify the small shop without a new text atlas.
  for (const x of [-2.1, -1.2, 1.2, 2.1]) {
    F.boxB(M.plain, '#e9e9e2', .76, 1.25, .65, x, .14, front - .7);
    F.cyl(M.metal, '#8e949b', .265, .055, x, .77, front - .345, { seg: 12, rx: Math.PI / 2 });
    F.cyl(M.plain, '#43586b', .205, .06, x, .77, front - .31, { seg: 12, rx: Math.PI / 2 });
    F.box(M.plain, teal, .5, .10, .02, x, 1.24, front - .365);
  }
  for (const x of [-3, -.6, .6, 3]) F.boxB(M.metal, '#8e949b', .055, 2.25, .07, x, .14, front + .035);
  F.box(M.metal, '#8e949b', 6, .055, .07, 0, 2.36, front + .035);
  // The city owns this clear-glass clone; shared house glass stays unchanged.
  const shopGlass = H.shopGlass;
  for (const x of [-1.8, 1.8]) F.boxB(shopGlass, null, 2.34, 2.14, .012, x, .18, front + .025, { shadow: false });
  F.boxB(shopGlass, null, 1.14, 2.14, .012, 0, .18, front + .025, { shadow: false });
  F.box(M.metal, '#8e949b', .025, .4, .1, .47, 1.12, front + .09);
  // One continuous enamel-colour portal, with a layered canopy below the next
  // balcony slab. Side posts sit on the opaque wings, outside the 6m glazing.
  for (const x of [-3.15, 3.15]) F.boxB(M.plain, teal, .2, 2.32, .12, x, .14, front + .06, { skip: 'b' });
  F.box(M.plain, dark, 6.25, .11, 1.05, 0, 2.60, front + .525);
  F.box(M.plain, teal, 6.25, .46, .07, 0, 2.55, front + 1.015);
  F.box(M.metal, brass, 6.25, .035, .085, 0, 2.315, front + 1.015);
  for (const x of [-2.8, 2.8]) F.beam(M.metal, dark,
    [x, 2.12, front + .04], [x, 2.52, front + .88], .035, .05);
  // The washer icon now uses a crop of the same A-frame artwork: replace the
  // two 12-segment cylinders with a quad, spending those triangles on the portal.
  F.box(H.signLight, null, .65, .55, .045, -2.65, 2.55, front + 1.065, { shadow: false });
  atlasCard(F, H.laundrySigns.icon, .49, .49, -2.65, 2.55, front + 1.09);
  F.box(H.signTeal || M.plain, H.signTeal ? null : teal, 5.3, .44, .025, .4, 2.55, front + 1.062, { shadow: false });
  atlasCard(F, H.laundrySigns.name, 4.56, .42, .45, 2.55, front + 1.0755);
  // Functional labels sit above the drums; the narrow lower sash sits below
  // them. Keep the central door, its handle and all four machine windows clear.
  for (const x of [-1.8, 1.8]) {
    atlasCard(F, H.laundrySigns.function, 1.06, .28, x, 1.76, front + .034);
    F.box(M.plain, teal, 2.34, .045, .018, x, .42, front + .04, { shadow: false });
  }
  // A wall-mounted service panel catches the eye-height side view without
  // putting another freestanding sign in the crate / umbrella / entry passage.
  F.boxB(H.signTeal || M.plain, H.signTeal ? null : teal, .60, 2.07, .08, 3.5, .16, front + .04, { skip: 'b' });
  atlasCard(F, H.laundrySigns.aframe, .50, .78, 3.5, 1.47, front + .081);
  return { palette: { teal, dark, cream, brass }, triangles: gb.tris - start,
    labelTriangles: 10, labelBackingTriangles: 12,
    name: { position: [.45, 2.55, front + 1.0755], size: [4.56, .42] },
    glass: [-1.8, 1.8].map(x => ({ position: [x, 1.76, front + .034], size: [1.06, .28] })),
    servicePanel: { position: [3.5, 1.47, front + .081], size: [.50, .78] },
    canopy: { width: 6.25, projection: 1.05, fasciaHeight: .46, top: 2.825 },
    entryWidth: 1.14, machineCount: 4, atlasRegions: 3, extraTexturePages: 0 };
}

function atlasCard(F, reg, w, h, x, y, z) {
  F.raw(reg.m, '#ffffff', { p: [-w / 2, -h / 2, 0, w / 2, -h / 2, 0, w / 2, h / 2, 0, -w / 2, h / 2, 0],
    n: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
    u: [reg.u0, reg.v0, reg.u1, reg.v0, reg.u1, reg.v1, reg.u0, reg.v1], i: [0, 1, 2, 0, 2, 3] },
    x, y, z, { shadow: false });
}

/** Sorting bins with the house kit's geometry, labels and footprint (0.42 m body,
 * 0.46 m lid, 0.5 m pitch) but a restrained palette: the kit's colours read as
 * toy-bright at 1.6 m beside the muted walls. Darker lids give each bin a top edge. */
export function townSortingBins(H, F, x, y, z, n = 2) {
  const { M, A } = H;
  const labels = ['bin_burn', 'bin_res', 'bin_pla'];
  const body = ['#62786a', '#55687f', '#7d8288'], lid = ['#4c5f53', '#43536a', '#62676d'];
  for (let i = 0; i < n; i++) {
    const bx = x + (i - (n - 1) / 2) * 0.5;
    F.boxB(M.plain, body[i % 3], 0.42, 0.62, 0.42, bx, y, z);
    F.boxB(M.plain, lid[i % 3], 0.46, 0.06, 0.46, bx, y + 0.62, z);
    F.box(M.atlas, '#ffffff', 0.3, 0.12, 0.01, bx, y + 0.45, z + 0.215,
      { uv: { rect: A.rects[labels[i % 3]], white: A.white } });
  }
}
