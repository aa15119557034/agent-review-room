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
      z0: backZ - 0.3, z1: Math.max(mainBounds.z0, backZ) + 0.5
    });
    ground.approach = { cx, halfW, z0: backZ, z1: mainBounds.z0 };
  }

  return { areas, ground };
}

/** 把所有店铺的附加区算出来（写进 station.walkExtra） */
export function walkExtrasFromRooms(station, city) {
  const rooms = station.ctx?.services?.shopInteriors ?? [];
  const placements = city?.placements ?? [];
  const stairs = city?.stats?.connections?.stairs ?? [];
  const out = [];
  const plans = [];
  const skipped = [];
  for (const room of rooms) {
    if (!room.frame || !Array.isArray(room.box)) continue;
    const placement = placements.find(p => p.name === room.name);
    const stair = stairs.find(s => s.name === (room.name + '-entry'));
    const plan = planShopEntry(room, placement, stair, station.bounds);
    if (!plan) { skipped.push({ name: room.name || room.kind, why: 'no frame / rotY' }); continue; }
    out.push(...plan.areas);
    plans.push({ room, placement, stair, plan });
  }
  return { areas: out, plans, skipped };
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


