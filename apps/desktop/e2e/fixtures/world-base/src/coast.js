import * as THREE from 'three';
import { basinAt } from './basins.js';
import { World } from '../upstream/petalwake/src/core/ctx.js';
import { Physics } from '../upstream/sakuragaoka/src/core/physics.js';
import { streetCenterX } from '../upstream/sakuragaoka/src/world/layout.js';

const smooth = THREE.MathUtils.smoothstep;

// Refine natural shore bars, meadow swales and mountain ribs on the native grid.
// Keep the authored harbour, farm lots, river bed and station approaches seated.
export function shapeIslandRelief(terrain, towns, stationRect) {
  const { h, N, cell } = terrain;
  const reserves = towns.map(({ aabb: [x0, , z0, x1, , z1] }) => [x0, z0, x1, z1]);
  reserves.push([stationRect.minX - 70, stationRect.minZ - 110, stationRect.maxX + 70, stationRect.maxZ + 35]);
  for (const [x, z, width] of terrain.meta.river) reserves.push([x-width, z-width, x+width, z+width]);
  const [lx, lz] = terrain.meta.lighthouse;
  reserves.push([lx-18, lz-18, lx+18, lz+18]);

  let shoreSamples = 0, inlandSamples = 0, maxRise = 0, maxCut = 0;
  for (let iz = 1; iz < N-1; iz++) {
    const z = (iz + 0.5) * cell - World.half;
    const rowReserves = reserves.filter(r => z >= r[1]-24 && z <= r[3]+24);
    for (let ix = 1; ix < N-1; ix++) {
      const i = iz*N + ix, y = h[i];
      if (y <= -6 || (y >= 6 && y <= 12)) continue;
      const x = (ix + 0.5) * cell - World.half;
      let nearest = 24;
      for (const [x0, z0, x1, z1] of rowReserves) {
        nearest = Math.min(nearest, Math.max(x0-x, x-x1, z0-z, z-z1, 0));
        if (nearest <= 3) break;
      }
      if (nearest <= 3) continue;
      let offset;
      if (y < 6) {
        const lobe = 0.5 + 0.5*Math.sin(x*0.031 + z*0.017 + 1.3*Math.sin(z*0.042));
        const berm = smooth(y, 0, 1.2) * (1-smooth(y, 1.6, 5.5));
        const bar = smooth(-y, 0, 1.8) * (1-smooth(-y, 2, 6));
        offset = berm*(0.95*lobe-0.22) + bar*(1.10*lobe-0.45);
      } else {
        const ridge = Math.sin(0.023*x - 0.017*z + 1.4*Math.sin(z*0.009));
        offset = smooth(y, 12, 65) * (0.7 + 3.6*smooth(y, 160, 340)) * ridge;
      }
      const delta = smooth(nearest, 3, 24) * offset;
      h[i] += delta;
      if (Math.abs(delta) > 0.001) { if (y < 6) shoreSamples++; else inlandSamples++; }
      maxRise = Math.max(maxRise, delta);
      maxCut = Math.min(maxCut, delta);
    }
  }

  // The station flatten immediately after this pass uploads h and rebuilds CDLOD bounds.
  return { shoreSamples, inlandSamples, maxRise, maxCut };
}

// A worn continuation of the main street crosses the existing two-metre seam,
// then opens out onto the sand. World x/z and the same curve feed material and feet.
export function makeCoastRoute(placement) {
  const endZ = placement.bounds.maxZ;
  const startX = placement.x + streetCenterX(endZ), startZ = placement.z + endZ;
  const centerX = dz => startX + 20 * smooth(dz, 0, 68) - 13 * smooth(dz, 60, 100);
  return {
    startX, startZ, centerX,
    // Ease the crest below the road over a longer shoulder than the station embankment.
    maxBlend: 78,
    blendAt(x, z, base) {
      if (z < startZ) return base;
      return THREE.MathUtils.lerp(78, base, smooth(Math.abs(x - centerX(z - startZ)), 3, 21));
    },
    // Stop at shallow swash; the harbour buildings remain outside the walking corridor.
    contains(x, z, y, radius) {
      const dz = z - startZ;
      const halfWidth = 3.1 + 3 * smooth(dz, 2, 30) + 25 * smooth(dz, 51, 78);
      return dz >= -radius && dz <= 140 && Math.abs(x - centerX(dz)) <= halfWidth - radius && y >= -0.08;
    },
    markGround(terrain) {
      terrain.material.uniforms.uBeachExit.value.set(startX, startZ);
      const size = terrain.splatN, step = World.size / size;
      const row = z => Math.floor((z + World.half) / step);
      for (let j = row(startZ) - 1; j <= row(startZ + 77); j++) {
        const dz = (j + 0.5) * step - World.half - startZ;
        const cx = centerX(dz);
        for (let i = row(cx - 6); i <= row(cx + 6); i++) {
          const distance = Math.abs((i + 0.5) * step - World.half - cx);
          const keep = Math.max(smooth(distance, 1.4, 4.2), smooth(dz, 47, 74));
          const k = (j * size + i) * 4;
          terrain.splat[k] = Math.round(terrain.splat[k] * keep);
          terrain.splat[k + 3] = Math.round(terrain.splat[k + 3] * keep);
        }
      }
      terrain.splatTex.needsUpdate = true;
    },
  };
}

export function coastWalking(station, island) {
  const route = island.coastRoute, { bounds, root } = station;
  const islandFloor = (x, z) => island.heightAt(x + root.position.x, z + root.position.z) - root.position.y;
  // The two-metre strip connects the road shoulder to the first island triangles.
  const height = (x, z) => {
    if (z >= bounds.z1 + 2 || z < bounds.z0 || x < bounds.x0 || x > bounds.x1) return islandFloor(x, z);
    const t = THREE.MathUtils.clamp((z - bounds.z1) / 2, 0, 1);
    return THREE.MathUtils.lerp(station.physics.heightAt(x, bounds.z1), islandFloor(x, bounds.z1 + 2), t);
  };
  const physics=new Physics(height);
  for(const tree of island.woodland?.trees ?? []){
    const y=tree.y-root.position.y;
    physics.addCylinder(tree.x-root.position.x,tree.z-root.position.z,tree.radius,y-0.3,y+tree.height*0.83);
  }
  for(const s of island.seaArch?.solids ?? [])physics.addBox(s.x-root.position.x,s.z-root.position.z,s.width,s.depth,island.seaArch.yaw,s.bottom-root.position.y,s.top-root.position.y);
  return {
    physics,
    wadingDepth(x,z){
      const wx=x+root.position.x,wz=z+root.position.z,b=basinAt(wx,wz);
      const surface=b ? b.level : island.streamLevelAt(wx,wz);
      return Math.max(0,surface-island.heightAt(wx,wz));
    },
    contains(x, z, radius) {
      const wx=x+root.position.x, wz=z+root.position.z;
      const basin=basinAt(wx,wz,1.46);
      if(basin) return basin.level-island.heightAt(wx,wz)<0.82;
      const nearby=island.landformViews?.some(v=>Math.hypot(wx-v.feet[0],wz-v.feet[2])<95-radius);
      if(nearby){
        const floor=island.heightAt(wx,wz);
        const gradient=Math.hypot(island.heightAt(wx+0.5,wz)-island.heightAt(wx-0.5,wz),island.heightAt(wx,wz+0.5)-island.heightAt(wx,wz-0.5));
        return floor>0 && gradient<1.35 && island.streamLevelAt(wx,wz)-floor<0.82;
      }
      const bank=island.streamView.feet;
      if(Math.hypot(wx-bank[0],wz-bank[2])<36-radius) return island.streamLevelAt(wx,wz)-island.heightAt(wx,wz)<0.82;
      if (z < bounds.z1 - radius) return false;
      return route.contains(x + root.position.x, z + root.position.z, height(x, z) + root.position.y, radius);
    },
  };
}
