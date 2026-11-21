// 店铺室内可进入：附加可走区 + 台阶/石台/室内地面 + 室内碰撞
//
// 背景（#254 汐·评估2 / C酱 评审 #271）：
//   1. 洗衣店在 `layout.WORLD.play` 主矩形之外约 26 m，玩家被 clamp 在主矩形里，走不到门口；
//   2. 主矩形之外站区物理地面比可见地形低约 3 m；
//   3. 店铺坐在**石台**上，正门有一段**石阶**——物理面必须跟着台阶和石台走，
//      不能用草地高度，否则玩家脚陷在台阶里、进店后比地板低 0.8 m。
//
// 本模块全部从现成数据推导，不写死坐标：
//   - 石阶：`city.stats.connections.stairs`（`{name, x, width, highZ, lowZ, steps, rise, tread, top, bottom}`）
//   - 石台顶：`placement.baseY`
//   - 室内地板：`frame.y + box.y0`
//
// 附加区拆成**四块互相重叠**（重叠 1.0 m > 2×玩家半径 0.6 m，保证收缩后仍连通）：
//   台阶 → 石台 → 店内 → 街面（地形贴合）

const OVERLAP = 1.0;        // 相邻块的重叠，必须 > 2 × 玩家半径
const WALL_T = 0.12;        // 墙厚
const DOOR_CLEAR = 0.05;    // 门洞两侧余量

function axisAligned(room) {
  const rot = room.frame?.rotY ?? 0;
  return Math.abs(rot) < 1e-6;
}

/** 房间盒 → 站区局部 [x0, z0, x1, z1] */
function roomRect(room) {
  const [x0, , z0, x1, , z1] = room.box;
  const f = room.frame;
  return {
    x0: f.x + Math.min(x0, x1), x1: f.x + Math.max(x0, x1),
    z0: f.z + Math.min(z0, z1), z1: f.z + Math.max(z0, z1)
  };
}

/**
 * 为一间带 frame 的店铺算：附加可走区（多块）+ 地面（台阶分级 / 石台 / 店内）。
 * 返回 { areas, ground: { steps, plinth, floor, approach } }
 */
export function planShopEntry(room, placement, stair, mainBounds) {
  if (!room?.frame || !Array.isArray(room.box) || room.box.length !== 6) return null;
  if (!axisAligned(room)) return null;

  const r = roomRect(room);
  const f = room.frame;
  const plinthTop = placement?.baseY ?? f.y;                 // 石台顶（局部 Y）
  const floorY = f.y + Math.min(room.box[1], room.box[4]);    // 室内地板
  const areas = [];

  // ① 店内
  areas.push({ name: 'room', x0: r.x0 - 0.2, x1: r.x1 + 0.2, z0: r.z0 - 0.2, z1: r.z1 + OVERLAP });

  // ② 门前石台（盖住门洞，向店内重叠）
  const halfDoor = ((room.entrances?.[0]?.width ?? 1.2) / 2) + 0.9;
  // 石台按**整间房的宽度**：画面上 foundation 铺的就是整块石台，站在上面是合法的；
  // 只按门洞两侧加宽会让石台边缘外的条带没有地面，玩家会从那儿掉下去。
  const px0 = r.x0, px1 = r.x1;
  const plinthZ1 = stair ? stair.highZ : r.z1 + 1.2;
  areas.push({ name: 'plinth', x0: px0, x1: px1, z0: r.z1 - OVERLAP, z1: plinthZ1 });

  let ground = { plinth: { x0: px0, x1: px1, z0: r.z1 - 0.6, z1: plinthZ1, y: plinthTop },
    floor: { x0: r.x0, x1: r.x1, z0: r.z0, z1: r.z1, y: floorY }, steps: [], approach: null };

  // ③ 台阶（每级一块 walk box，尺寸用现成 rise/tread）
  if (stair && stair.steps > 0) {
    const halfW = stair.width / 2 + 0.15;
    areas.push({
      name: 'stairs', x0: stair.x - halfW, x1: stair.x + halfW,
      z0: stair.highZ - OVERLAP, z1: stair.lowZ + 0.6
    });
    for (let k = 0; k < stair.steps; k++) {
      const zA = stair.highZ + (stair.lowZ - stair.highZ) * k / stair.steps;
      const zB = stair.highZ + (stair.lowZ - stair.highZ) * (k + 1) / stair.steps;
      ground.steps.push({
        x: stair.x, w: stair.width, z: (zA + zB) / 2, d: Math.abs(zB - zA) + 0.02,
        y: stair.top - stair.rise * k
      });
    }
  }

  // ④ 街面衔接：从台阶底一路到主矩形边界，靠地形贴合
  const backZ = stair ? stair.lowZ : r.z1;
  if (mainBounds && backZ < mainBounds.z0) {
    const halfW = stair ? stair.width / 2 + 0.15 : (px1 - px0) / 2;
    const cx = stair ? stair.x : (px0 + px1) / 2;
    areas.push({
      name: 'approach', x0: cx - halfW, x1: cx + halfW,
      z0: backZ - OVERLAP, z1: Math.max(mainBounds.z0, backZ) + OVERLAP   // 与主矩形重叠 OVERLAP(1.0m)，缩半径后仍连通
    });
    ground.approach = { cx, halfW, z0: backZ, z1: mainBounds.z0 };
  }

  // 断言：相邻块的重叠必须 >= 2×玩家半径 + 0.3（半径按 0.3 算 → 0.9），
  // 否则收缩后会出现缝，高帧率慢走会卡在缝里（C酱 评审 #271 第 3 条）。
  {
    const R = 0.3, NEED = 2 * R + 0.3;
    const order = ['room', 'plinth', 'stairs', 'approach'];
    const byName = Object.fromEntries(areas.map(a => [a.name, a]));
    for (let i = 0; i + 1 < order.length; i++) {
      const a = byName[order[i]], b = byName[order[i + 1]];
      if (!a || !b) continue;
      const overlap = Math.min(a.z1, b.z1) - Math.max(a.z0, b.z0);
      if (overlap < NEED - 1e-3) {
        throw new Error('shop-entry: ' + order[i] + ' 与 ' + order[i + 1] + ' 的 z 重叠只有 ' + overlap.toFixed(2) + ' m，需要 >= ' + NEED.toFixed(1) + ' m（玩家半径 ' + R + '）');
      }
    }
  }

  return { areas, ground };
}

/** 把所有店铺的附加区算出来（写进 station.walkExtra） */
export function walkExtrasFromRooms(station, city, layout = null) {
  const rooms = station.ctx?.services?.shopInteriors ?? [];
  const placements = city?.placements ?? [];
  const stairs = city?.stats?.connections?.stairs ?? [];
  const out = [];
  const plans = [];
  const lotPlans = [];
  const skipped = [];
  for (const room of rooms) {
    // 上游 8 家店：只有 { lot, box }，用 layout.lotFrame 现算 frame
    if (!room.frame && room.lot && layout?.lotFrame && layout?.lotById) {
      const lot = layout.lotById(room.lot);
      if (!lot) { skipped.push({ name: room.lot, why:'lot not found' }); continue; }
      const frame = layout.lotFrame(lot);
      const geom = lotRoomGeom(frame, room.box);
      const plan = planLotShopEntry(geom, room.lot);
      out.push(...plan.areas);
      lotPlans.push({ geom, plan, name: room.lot });
      continue;
    }
    if (!room.frame || !Array.isArray(room.box)) continue;
    const placement = placements.find(p => p.name === room.name);
    const stair = stairs.find(s => s.name === (room.name + '-entry'));
    const plan = planShopEntry(room, placement, stair, station.bounds);
    if (!plan) { skipped.push({ name: room.name || room.kind, why: 'no frame / rotY' }); continue; }
    out.push(...plan.areas);
    plans.push({ room, placement, stair, plan });
  }
  return { areas: out, plans, lotPlans, skipped };
}

/**
 * 铺地面：台阶分级 → 石台 → 店内 → 街面地形。
 * 全部用站区局部坐标（physics 就在这个空间里）。
 */
export function addShopGround(station, island, plans) {
  const physics = station.ctx?.physics;
  const rootY = station.root.position.y, rootX = station.root.position.x, rootZ = station.root.position.z;
  const stats = { steps: 0, plinth: 0, floor: 0, approach: 0 };
  if (!physics) return stats;

  for (const { plan } of plans) {
    const ground = plan.ground;
    // 台阶：每级一块
    for (const s of ground.steps) {
      physics.addWalkBox(s.x, s.z, s.w, s.d, 0, s.y);
      stats.steps++;
    }
    // 石台
    if (ground.plinth) {
      const p = ground.plinth;
      physics.addWalkBox((p.x0 + p.x1) / 2, (p.z0 + p.z1) / 2, p.x1 - p.x0, p.z1 - p.z0, 0, p.y);
      stats.plinth++;
    }
    // 店内地板
    if (ground.floor) {
      const g = ground.floor;
      physics.addWalkBox((g.x0 + g.x1) / 2, (g.z0 + g.z1) / 2, g.x1 - g.x0, g.z1 - g.z0, 0, g.y);
      stats.floor++;
    }
    // 街面：从台阶底到主矩形边界，跟地形
    const ap = ground.approach;
    if (ap && island?.heightAt && Number.isFinite(ap.z0) && Number.isFinite(ap.z1) && ap.z1 - ap.z0 > 0.5) {
      const STEP = 2.0;
      const width = ap.halfW * 2;
      for (let z = ap.z0; z < ap.z1 - 1e-6; z += STEP) {
        const za = z, zb = Math.min(z + STEP, ap.z1);
        const ya = island.heightAt(rootX + ap.cx, rootZ + za) - rootY;
        const yb = island.heightAt(rootX + ap.cx, rootZ + zb) - rootY;
        physics.addWalkRamp(ap.cx, (za + zb) / 2, width, zb - za, 0, ya, yb);
        stats.approach++;
      }
    }
  }
  return stats;
}

/** 室内碰撞：后墙、左右墙、带门洞的前墙（由 box + entrances 推导） */
export function addRoomCollision(station) {
  const rooms = station.ctx?.services?.shopInteriors ?? [];
  const physics = station.ctx?.physics;
  const added = [];
  const skipped = [];
  if (!physics) return { added, skipped };

  for (const room of rooms) {
    if (!room.frame || !Array.isArray(room.box) || room.box.length !== 6) continue;
    if (!axisAligned(room)) { skipped.push({ name: room.name || room.kind, why: 'rotY != 0' }); continue; }
    const [bx0, by0, bz0, bx1, by1, bz1] = room.box;
    const f = room.frame;
    const y0 = f.y + Math.min(by0, by1);
    const y1 = f.y + Math.max(by0, by1);
    const r = roomRect(room);
    const entrance = (room.entrances ?? [])[0];
    const doorW = entrance?.width ?? 1.2;
    const doorCx = f.x + (entrance?.x ?? 0);
    const gapW = doorW + 0.4;   // 碰撞口比视觉门框宽，避免卡边

    const wall = (minx, minz, maxx, maxz) => {
      physics.addAABB(minx, minz, maxx, maxz, y0, y1);
      added.push([+minx.toFixed(2), +minz.toFixed(2), +maxx.toFixed(2), +maxz.toFixed(2)]);
    };

    wall(r.x0, r.z0, r.x1, r.z0 + WALL_T);                 // 后墙
    wall(r.x0, r.z0, r.x0 + WALL_T, r.z1);                 // 左墙
    wall(r.x1 - WALL_T, r.z0, r.x1, r.z1);                 // 右墙
    const d0 = Math.max(r.x0 + WALL_T, doorCx - gapW / 2 + DOOR_CLEAR);
    const d1 = Math.min(r.x1 - WALL_T, doorCx + gapW / 2 - DOOR_CLEAR);
    if (d0 > r.x0 + WALL_T) wall(r.x0, r.z1 - WALL_T, d0, r.z1);
    if (d1 < r.x1 - WALL_T) wall(d1, r.z1 - WALL_T, r.x1, r.z1);
    wall(d0, r.z1 - WALL_T, d0 + 0.02, r.z1);
    wall(d1 - 0.02, r.z1 - WALL_T, d1, r.z1);
  }
  return { added, skipped };
}







/**
 * 打通接缝处的**隐形边界墙**。
 *
 * 实测：`physics.resolve` 在接缝前每帧把玩家推回恰好一个步长，命中的实体是
 * `{type:'box', cx:0, cz:-99.5, hw:10, hd:0.3, y0:-5, y1:20}` —— 一道横跨街道、
 * 20 m 宽 0.6 m 厚 25 m 高的不可见边界墙，用来把玩家关在主矩形里。
 *
 * 做法：凡是「薄、宽、够高」且横跨某条 approach 的 box，把它在附加区那条带上**切开**，
 * 两边保留、中间留出等于附加区宽度的口子。其它地方的可走范围完全不变。
 */
export function clearBoundaryWalls(station, areas, margin = 0.25) {
  const physics = station.ctx?.physics;
  const items = physics?.items;
  if (!items?.length || !areas?.length) return { cleared: 0, items: [] };

  const strips = areas.filter(a => a.name === 'approach');
  if (!strips.length) return { cleared: 0, items: [] };
  const done = [];

  for (const it of items.slice()) {
    if (it.type !== 'box') continue;
    if ((it.hd ?? 0) > 0.8) continue;
    if ((it.hw ?? 0) < 2 || (it.hw ?? 0) > 60) continue;
    if ((it.y1 ?? 0) - (it.y0 ?? 0) < 2) continue;
    for (const s of strips) {
      const wallL = it.cx - it.hw, wallR = it.cx + it.hw;
      const mid = (s.z0 + s.z1) / 2, half = (s.z1 - s.z0) / 2 + 1.0;
      if (Math.abs(it.cz - mid) > half) continue;
      const holeL = s.x0 - margin, holeR = s.x1 + margin;
      if (wallR <= holeL || wallL >= holeR) continue;
      if (holeL <= wallL && holeR >= wallR) continue;

      const leftL = wallL, leftR = Math.min(wallR, holeL);
      const rightL = Math.max(wallL, holeR), rightR = wallR;
      done.push({ wall: [+wallL.toFixed(2), +wallR.toFixed(2)], hole: [+holeL.toFixed(2), +holeR.toFixed(2)], z: +it.cz.toFixed(2) });

      if (rightR - rightL > 0.01) physics.addBox((rightL + rightR) / 2, it.cz, rightR - rightL, it.hd * 2, 0, it.y0, it.y1);
      if (leftR - leftL > 0.01) {
        it.cx = (leftL + leftR) / 2; it.hw = (leftR - leftL) / 2; it.w = it.hw * 2;
      } else {
        it.y0 = -999; it.y1 = -998;
      }
      break;
    }
  }
  return { cleared: done.length, items: done };
}

/**
 * 室内第三人称相机夹取。
 *
 * 现象（2026-11-21 实测）：玩家从门洞走进洗衣店后，相机仍停在墙外 4.7 m，
 * 画面拍的是店门外立面，玩家被墙挡住；等玩家走到后墙才「啪」地收进 1.52 m。
 *
 * 原因：`station-view.js` 的 `physics.sweepSphere(target, desired, clearance)` 本身是对的，
 * 但玩家是从**门洞**进去的，相机沿原路退回时正好从门洞穿出，扫掠路径上没有障碍 ——
 * 物理正确，画面错误。
 *
 * 修法：玩家在某个房间内时，把相机位置夹到该房间的内盒里（留出 near 平面余量）。
 */
export function makeCameraClamp(station, rooms, lotPlans = []) {
  const boxes = [];
  for (const room of rooms) {
    if (!room?.frame || !Array.isArray(room.box)) continue;
    // 只处理轴对齐房间：未旋转的盒子套在转过的店上会盖到街面，把相机夹到错地方
    if (!axisAligned(room)) continue;
    const [bx0, by0, bz0, bx1, by1, bz1] = room.box;
    const f = room.frame;
    boxes.push({
      x0: f.x + Math.min(bx0, bx1), x1: f.x + Math.max(bx0, bx1),
      y0: f.y + Math.min(by0, by1), y1: f.y + Math.max(by0, by1),
      z0: f.z + Math.min(bz0, bz1), z1: f.z + Math.max(bz0, bz1)
    });
  }
  // lot 店：box 是 lot 局部，带旋转，用 OBB 判定 + 在 lot 局部夹取
  for (const { geom, plan } of lotPlans) {
    boxes.push({
      rotY: geom.rotY, fx: geom.frame.x, fz: geom.frame.z,
      x0: geom.lotX0, x1: geom.lotX1, z0: geom.lotZ0, z1: geom.lotZ1,
      y0: geom.floorY, y1: geom.ceilY, doorX: plan?.doorX
    })
  }
  if (!boxes.length) return null;

  return function clampCamera(playerLocal, camLocal, margin = 0.25) {
    for (const b of boxes) {
      // 旋转盒：先转到 lot 局部再判定/夹取（rotY=0 时等同于轴对齐）
      const rot = b.rotY ?? 0, cc = Math.cos(rot), ss = Math.sin(rot)
      const pl = (p) => {
        const dx0 = p.x - (b.fx ?? 0), dz0 = p.z - (b.fz ?? 0)
        return { u: dx0 * cc - dz0 * ss, v: dx0 * ss + dz0 * cc }
      }
      const pLoc = pl(playerLocal)
      const inRoom = pLoc.u >= b.x0 && pLoc.u <= b.x1 &&
                     pLoc.v >= b.z0 && pLoc.v <= b.z1 &&
                     playerLocal.y >= b.y0 - 0.3 && playerLocal.y <= b.y1
      if (!inRoom) continue;
      const cLoc = pl(camLocal)
      const cu = Math.min(Math.max(cLoc.u, b.x0 + margin), b.x1 - margin)
      const cv = Math.min(Math.max(cLoc.v, b.z0 + margin), b.z1 - margin)
      camLocal.x = (b.fx ?? 0) + cu * cc + cv * ss
      camLocal.z = (b.fz ?? 0) - cu * ss + cv * cc
      camLocal.y = Math.min(Math.max(camLocal.y, b.y0 + margin), b.y1 - margin);
      // clamp 完如果离玩家太近（薄房间、刚进门），改成往上抬，别硬挤在墙边切近平面
      const MIN_D = 1.2;
      const dx = camLocal.x - playerLocal.x;
      const dz = camLocal.z - playerLocal.z;
      const dy = camLocal.y - playerLocal.y;
      const d = Math.hypot(dx, dy, dz);
      if (d < MIN_D) {
        camLocal.y = Math.min(b.y1 - 0.35, camLocal.y + (MIN_D - d));
      }
      return true;
    }
    return false;
  };
}


// ---------------------------------------------------------------------------
// 上游 8 家店（主街 lot）：`ctx.services.shopInteriors` 里这几间只登记了
//   { lot: 'W1', box: [x0,y0,z0,x1,y1,z1] }   ← box 是 **lot 局部**坐标
// 没有 frame。上游 layout 提供了 lotFrame(lotById(id)) → {x,y,z,rotY,w,depth}，
// 就在站区局部空间，直接可以当 frame 用（shadow-tint.js 已经这么用了）。
//
// 与洗衣店的差别：
//   - 地板只比街面高 0.16–0.37 m（洗衣店是 0.8 m + 石阶），所以**不需要石阶**；
//   - 朝向有 90°/270°（沿街），另有三间是 91.5°/94.5°/272.9°（沿街弯道斜铺）。
//
// 做法：可走区用旋转盒的 **AABB**（略大一圈，但墙是精确的旋转盒，玩家进不去），
//       地面/墙体用 physics 支持的 rotY 盒。
// ---------------------------------------------------------------------------

/** lot 局部房间盒 → 站区局部的旋转盒 + AABB */
export function lotRoomGeom(frame, box) {
  const c = Math.cos(frame.rotY), s = Math.sin(frame.rotY);
  const x0 = Math.min(box[0], box[3]), x1 = Math.max(box[0], box[3]);
  const y0 = Math.min(box[1], box[4]), y1 = Math.max(box[1], box[4]);
  const z0 = Math.min(box[2], box[5]), z1 = Math.max(box[2], box[5]);
  const toStation = (lx, lz) => [frame.x + lx * c + lz * s, frame.z - lx * s + lz * c];
  const corners = [toStation(x0, z0), toStation(x1, z0), toStation(x0, z1), toStation(x1, z1)];
  const xs = corners.map(p => p[0]), zs = corners.map(p => p[1]);
  const [cx, cz] = toStation((x0 + x1) / 2, (z0 + z1) / 2);
  return {
    frame, rotY: frame.rotY, cx, cz,
    hw: (x1 - x0) / 2, hd: (z1 - z0) / 2,
    aabb: { x0: Math.min(...xs), x1: Math.max(...xs), z0: Math.min(...zs), z1: Math.max(...zs) },
    floorY: frame.y + y0, ceilY: frame.y + y1, baseY: frame.y,
    lotX0: x0, lotX1: x1, lotZ0: z0, lotZ1: z1
  };
}

/** 一家 lot 店铺的可走区 + 地面 + 墙（全部站区局部） */
// 门位覆盖表：上游各店的门/暖帘坐标不同，先留 null（用 lot 中间），有坐标了再填。
const LOT_DOOR_X = { W1: null, E1: null, W2: null, W4: null, E2: null, E3: null, E5: null, W6: null };

export function planLotShopEntry(geom, name, doorW = 1.4) {
  const a = geom.aabb;
  const areas = [
    { name: 'room-' + name, x0: a.x0 - 0.2, x1: a.x1 + 0.2, z0: a.z0 - 0.2, z1: a.z1 + 0.2 }
  ];
  // 临街方向：lot 局部 +z 边 → 站区局部方向 (s, c)
  const c = Math.cos(geom.rotY), s = Math.sin(geom.rotY);
  const fx = s, fz = c;
  const push = 4.0;
  const grow = (v) => Math.abs(v) * push;
  areas.push({
    name: 'approach-' + name,
    x0: a.x0 - 0.5 - (fx < 0 ? grow(fx) : 0),
    x1: a.x1 + 0.5 + (fx > 0 ? grow(fx) : 0),
    z0: a.z0 - 0.5 - (fz < 0 ? grow(fz) : 0),
    z1: a.z1 + 0.5 + (fz > 0 ? grow(fz) : 0)
  });
  return {
    doorX: LOT_DOOR_X[name] ?? ((geom.lotX0 + geom.lotX1) / 2),
    areas,
    ground: {
      floor: { cx: geom.cx, cz: geom.cz, w: geom.hw * 2, d: geom.hd * 2, rotY: geom.rotY, y: geom.floorY },
      approach: { cx: geom.cx + fx * push / 2, cz: geom.cz + fz * push / 2, w: geom.hw * 2, d: push, rotY: geom.rotY, y: geom.baseY },
      doorW
    }
  };
}



/** 把 lot 店铺的地面（地板 + 门前）和四面墙写进物理，全部用旋转盒 */
export function addLotShopSolid(station, lotPlans) {
  const physics = station.ctx?.physics;
  const stats = { floors: 0, approaches: 0, walls: 0, doors: 0 };
  if (!physics || !lotPlans?.length) return stats;

  for (const { geom, plan, name } of lotPlans) {
    const g = plan.ground;
    physics.addWalkBox(g.floor.cx, g.floor.cz, g.floor.w, g.floor.d, g.floor.rotY, g.floor.y);
    stats.floors++;
    physics.addWalkBox(g.approach.cx, g.approach.cz, g.approach.w, g.approach.d, g.approach.rotY, g.approach.y);
    stats.approaches++;

    // 四面墙：lot 局部四条边 → 旋转盒
    const c = Math.cos(geom.rotY), s = Math.sin(geom.rotY);
    const F = geom.frame;
    const toStation = (lx, lz) => [F.x + lx * c + lz * s, F.z - lx * s + lz * c];
    const hy = (geom.floorY + geom.ceilY) / 2, th = geom.ceilY - geom.floorY;
    const doorHalf = g.doorW / 2;
    const wall = (lx, lz, w, d) => {
      const [px, pz] = toStation(lx, lz);
      physics.addBox(px, pz, w, d, geom.rotY, geom.floorY, geom.ceilY);
      stats.walls++;
    };
    const T = 0.12;
    // 后墙（lot z0）、左右墙（lot x0 / x1）
    wall(0, geom.lotZ0 + T / 2, geom.lotX1 - geom.lotX0, T);
    wall(geom.lotX0 + T / 2, (geom.lotZ0 + geom.lotZ1) / 2, T, geom.lotZ1 - geom.lotZ0);
    wall(geom.lotX1 - T / 2, (geom.lotZ0 + geom.lotZ1) / 2, T, geom.lotZ1 - geom.lotZ0);
    // 前墙：中间留门洞
    const zf = geom.lotZ1 - T / 2;
    const mid = plan.doorX;   // 优先用覆盖表，没有就 lot 中间
    const leftW = (mid - doorHalf) - geom.lotX0;
    const rightW = geom.lotX1 - (mid + doorHalf);
    if (leftW > 0.05) wall(geom.lotX0 + leftW / 2, zf, leftW, T);
    if (rightW > 0.05) wall(mid + doorHalf + rightW / 2, zf, rightW, T);
    stats.doors++;
  }
  return stats;
}





// ---------------------------------------------------------------------------
// 室内专用机位（C酱 2026-11-20 22:09 定的方案）
//
// 房间只有 2.14 m 深时，第三人称夹进房间后会贴着天花板（接近俯视），取景很难看。
// 改成：玩家进店就切到**门口斜上方的固定机位**看店内，不跟玩家；出门切回第三人称，
// 切换用 0.3 s 插值。
//
// 返回 { pose(playerLocal) → { pos, look } | null }，坐标都是**站区局部**。
// ---------------------------------------------------------------------------
export function makeIndoorCamera(station, rooms, lotPlans = []) {
  const shots = [];

  const push = (f, lotX0, lotX1, lotZ0, lotZ1, floorY, doorX) => {
    const c = Math.cos(f.rotY), s = Math.sin(f.rotY);
    const toS = (lx, lz) => [f.x + lx * c + lz * s, f.z - lx * s + lz * c];
    const dx = doorX ?? (lotX0 + lotX1) / 2;
    // 房间只有 2.1 m 深，机位放在**门洞外 0.4 m**、高 1.9 m，看向房间中心偏后
    const [px, pz] = toS(dx, lotZ1 + 1.1);
    const [lx2, lz2] = toS((lotX0 + lotX1) / 2, lotZ0 + 1.2);
    shots.push({
      lotX0, lotX1, lotZ0, lotZ1, rotY: f.rotY, f,
      floorY,
      pos: { x: px, y: floorY + 1.55, z: pz },
      look: { x: lx2, y: floorY + 1.0, z: lz2 }
    });
  };

  // 带 frame 的房间（洗衣店）
  for (const room of rooms) {
    if (!room?.frame || !Array.isArray(room.box)) continue;
    if (!axisAligned(room)) continue;
    const [bx0, by0, bz0, bx1, by1, bz1] = room.box;
    const f = room.frame;
    const lotX0 = Math.min(bx0, bx1), lotX1 = Math.max(bx0, bx1);
    const lotZ0 = Math.min(bz0, bz1), lotZ1 = Math.max(bz0, bz1);
    push(f, lotX0, lotX1, lotZ0, lotZ1, f.y + Math.min(by0, by1), room.entrances?.[0]?.x ?? 0);
  }

  // lot 店
  for (const { geom, plan } of lotPlans) {
    push(geom.frame, geom.lotX0, geom.lotX1, geom.lotZ0, geom.lotZ1, geom.floorY, plan?.doorX);
  }

  if (!shots.length) return null;

  return {
    /** 玩家在哪个房间里？返回固定机位；不在任何房间返回 null */
    pose(playerLocal) {
      for (const s of shots) {
        // 转到 lot 局部判定
        const c = Math.cos(s.rotY), sn = Math.sin(s.rotY);
        const dx0 = playerLocal.x - s.f.x, dz0 = playerLocal.z - s.f.z;
        const lx = dx0 * c - dz0 * sn;
        const lz = dx0 * sn + dz0 * c;
        if (lx < s.lotX0 || lx > s.lotX1 || lz < s.lotZ0 || lz > s.lotZ1) continue;
        if (playerLocal.y < s.floorY - 0.3 || playerLocal.y > s.floorY + 3.2) continue;
        return s;
      }
      return null;
    }
  };
}



