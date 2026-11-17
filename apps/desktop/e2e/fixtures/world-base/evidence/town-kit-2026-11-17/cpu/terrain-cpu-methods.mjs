// Exact CPU methods extracted from current upstream terrain.js; no renderer constructed.
const World={half:3072};
export class CpuTerrain {
  flattenRect({ minX, maxX, minZ, maxZ, height, blend, surface }) {
    const { cell, N, h } = this;
    // Keep bilinear samples exactly flat up to the requested rectangle's edges.
    minX -= cell; maxX += cell; minZ -= cell; maxZ += cell;
    const x0 = Math.max(0, Math.floor((minX - blend + World.half) / cell));
    const x1 = Math.min(N - 1, Math.ceil((maxX + blend + World.half) / cell));
    const z0 = Math.max(0, Math.floor((minZ - blend + World.half) / cell));
    const z1 = Math.min(N - 1, Math.ceil((maxZ + blend + World.half) / cell));
    let changed = 0, originalMin = Infinity, originalMax = -Infinity;
    for (let iz = z0; iz <= z1; iz++) for (let ix = x0; ix <= x1; ix++) {
      const x = (ix + 0.5) * cell - World.half;
      const z = (iz + 0.5) * cell - World.half;
      const distance = Math.hypot(Math.max(minX - x, 0, x - maxX), Math.max(minZ - z, 0, z - maxZ));
      if (distance >= blend) continue;
      const index = iz * N + ix;
      if (distance === 0) { originalMin = Math.min(originalMin, h[index]); originalMax = Math.max(originalMax, h[index]); }
      const t = distance / blend;
      const weight = 1 - t * t * (3 - 2 * t);
      const target = surface ? surface(x, z) : height;
      h[index] += (target - h[index]) * weight;
      changed++;
    }
    this.heightTex.needsUpdate = true;
    this._buildMinMax();
    return { changed, originalMin, originalMax, height, blend, conformed: Boolean(surface) };
  }

  /** Bilinear terrain height at world xz. */
  heightAt(x, z) {
    const N = this.N;
    let fx = (x + World.half) / this.cell - 0.5;
    let fz = (z + World.half) / this.cell - 0.5;
    if (fx < 0) fx = 0; else if (fx > N - 1.001) fx = N - 1.001;
    if (fz < 0) fz = 0; else if (fz > N - 1.001) fz = N - 1.001;
    const ix = fx | 0, iz = fz | 0, tx = fx - ix, tz = fz - iz;
    const h = this.h, i = iz * N + ix;
    const a = h[i], b = h[i + 1], c = h[i + N], d = h[i + N + 1];
    return (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz;
  }


_buildMinMax() {}
}
