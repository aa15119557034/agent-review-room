// 店铺室内可进入：附加可走区 + 室内碰撞
//
// 背景（#254 汐·评估2）：洗衣店在 `layout.WORLD.play` 主矩形之外约 26 m，
// 玩家被 clamp 在主矩形里，根本走不到门口。这里做两件事：
//
//   1. `walkExtrasFromRooms` —— 从 `ctx.services.shopInteriors` 里**带 frame 的房间**
//      推出附加可走区（主矩形 + 附加区的并集），不写死坐标；
//   2. `addRoomCollision` —— 从同一个 `box` 和 `entrances` 推出后墙、左右墙和
//      带门洞的前墙，门洞宽度取 `entrances[].width`。
//
// 上游那 8 家店的 box 是 lot 局部坐标（没有 frame），本轮跳过，另开一轮。

const WALL_T = 0.12;        // 墙厚
const DOOR_CLEAR = 0.05;    // 门洞两侧留一点余量，避免门框吃进门宽

/** frame 旋转本轮只支持 0（洗衣店 rotY = 0）；非 0 的房间直接跳过并报告 */
function axisAligned(room) {
  const rot = room.frame?.rotY ?? 0;
  return Math.abs(rot) < 1e-6;
}

/** 从房间盒推出站区局部坐标的 [x0, z0, x1, z1] */
function roomRect(room) {
  const [x0, , z0, x1, , z1] = room.box;
  const f = room.frame;
  return {
    x0: f.x + Math.min(x0, x1), x1: f.x + Math.max(x0, x1),
    z0: f.z + Math.min(z0, z1), z1: f.z + Math.max(z0, z1)
  };
}

/**
 * 附加可走区：房间宽度 + 左右各 1.2 m 门前缓冲，
 * 从店后墙一直连到主矩形的北边界（两者重叠 0.5 m，保证并集连着不断）。
 */
export function walkExtrasFromRooms(station) {
  const rooms = station.ctx?.services?.shopInteriors ?? [];
  const main = station.bounds;
  const out = [];
  const skipped = [];
  for (const room of rooms) {
    if (!room.frame || !Array.isArray(room.box) || room.box.length !== 6) continue;
    if (!axisAligned(room)) { skipped.push({ name: room.name || room.kind, why: 'rotY != 0' }); continue; }
    const r = roomRect(room);
    const area = {
      name: room.name || room.kind || 'room',
      // 房间左右各留 1.2 m 门前缓冲；纵深**从店后墙起**（不再往后留余量，
      // 否则玩家会被夹在后墙外面，侧墙也就碰不到了）
      x0: r.x0 - 1.2, x1: r.x1 + 1.2,
      z0: r.z0, z1: Math.max(main.z0, r.z1) + 0.5
    };
    // 只有真正越过主矩形的房间才需要附加区
    const outside = r.z0 < main.z0 || r.z1 > main.z1 || r.x0 < main.x0 || r.x1 > main.x1;
    if (outside) out.push(area);
  }
  return { areas: out, skipped };
}

/**
 * 附加区内的物理地面改成**岛屿地形**，不再沿用站区那块平面。
 *
 * 背景：站区内物理地面与岛屿地形平均只差 0.26 m，但主矩形之外差 −3.06 m
 * （站区地面在下面一层）。附加区正好落在这段上，所以玩家会走在地形下方约 3–4 m，
 * 室内墙（按 frame.y 推，位于地形标高）自然挡不住。
 *
 * 做法：沿 z 铺一串 `addWalkRamp`，两端取 `island.heightAt`，让物理面贴合地形。
 * 边界那一格额外铺一段从站区平台升到地形的斜坡，作为接缝。
 */
export function addTerrainWalk(station, island, areas) {
  const physics = station.ctx?.physics;
  if (!physics || !island?.heightAt || !areas?.length) return { ramps: 0, seam: null };
  const rootY = station.root.position.y;
  const rootX = station.root.position.x, rootZ = station.root.position.z;   // 局部→世界
  let ramps = 0;
  let seam = null;

  for (const area of areas) {
    const width = area.x1 - area.x0;
    const cx = (area.x0 + area.x1) / 2;
    const STEP = 2.0;
    // 从北（店那一侧）往南铺到主矩形边界，再补一段接缝斜坡跨过边界
    for (let z = area.z0; z < area.z1 - 1e-6; z += STEP) {
      const za = z, zb = Math.min(z + STEP, area.z1);
      // 地形高度是世界的，物理在站区局部 Y 上
        const ya = island.heightAt(rootX + cx, rootZ + za) - rootY;
        const yb = island.heightAt(rootX + cx, rootZ + zb) - rootY;
      physics.addWalkRamp(cx, (za + zb) / 2, width, zb - za, 0, ya, yb);
      ramps++;
    }
    // 接缝：从主矩形平台高度升到地形，跨过 area.z1 往南 3 m
    const zStart = area.z1;
    const platformY = physics.groundHeight(cx, zStart + 1.5, 1e9);
    const terrainY = island.heightAt(rootX + cx, rootZ + zStart) - rootY;
    if (Number.isFinite(platformY) && Number.isFinite(terrainY) && Math.abs(terrainY - platformY) > 0.15) {
      physics.addWalkRamp(cx, zStart + 1.5, width, 3.0, 0, terrainY, platformY);
      seam = { z: +zStart.toFixed(2), platformY: +platformY.toFixed(2), terrainY: +terrainY.toFixed(2), width: +width.toFixed(2) };
    }
  }
  return { ramps, seam };
}

/**
 * 室内碰撞：后墙、左右墙、带门洞的前墙。
 * 全部由 box + entrances 推导，上游 8 家店将来接上 frame 即可复用。
 */
export function addRoomCollision(station) {
  const rooms = station.ctx?.services?.shopInteriors ?? [];
  const physics = station.ctx?.physics;
  const roomHigh = station.root.position.y;   // 物理在站区局部 Y 上
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

    const wall = (minx, minz, maxx, maxz) => {
      physics.addAABB(minx, minz, maxx, maxz, y0, y1);
      added.push([+minx.toFixed(2), +minz.toFixed(2), +maxx.toFixed(2), +maxz.toFixed(2)]);
    };

    // 后墙（远离街道那一侧）
    wall(r.x0, r.z0, r.x1, r.z0 + WALL_T);
    // 左右墙
    wall(r.x0, r.z0, r.x0 + WALL_T, r.z1);
    wall(r.x1 - WALL_T, r.z0, r.x1, r.z1);
    // 前墙：中间留门洞
    // 碰撞口比视觉门框宽 0.4 m：玩家半径约 0.3 m，严格按门宽留口会只剩 0.6 m 可走，进门容易卡边
    const gapW = doorW + 0.4;
    const d0 = Math.max(r.x0 + WALL_T, doorCx - gapW / 2 + DOOR_CLEAR);
    const d1 = Math.min(r.x1 - WALL_T, doorCx + gapW / 2 - DOOR_CLEAR);
    if (d0 > r.x0 + WALL_T) wall(r.x0, r.z1 - WALL_T, d0, r.z1);
    if (d1 < r.x1 - WALL_T) wall(d1, r.z1 - WALL_T, r.x1, r.z1);
    // 门框两侧的短墙（把门洞挤成正好的宽度）
    wall(d0, r.z1 - WALL_T, d0 + 0.02, r.z1);
    wall(d1 - 0.02, r.z1 - WALL_T, d1, r.z1);
  }
  return { added, skipped };
}


