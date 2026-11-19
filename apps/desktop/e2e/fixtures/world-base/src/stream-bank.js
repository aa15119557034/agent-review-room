import { MathUtils } from 'three';
import { World } from '../upstream/petalwake/src/core/ctx.js';

// Use the river's actual water levels, widths and channel direction. Adjacent
// rows overlap their stamps so the damp gravel follows bends and the waterfall approach.
export function dressStreamBanks(terrain,river) {
  const texture=terrain.material.uniforms.uInlandBank.value,data=texture.image.data;
  const size=texture.image.width,cell=World.size/size;
  for(const r of river.rows){
    const reach=r.hw+4, ix=Math.floor((r.x+World.half)/cell),iz=Math.floor((r.z+World.half)/cell),cells=Math.ceil(reach/cell);
    for(let j=iz-cells;j<=iz+cells;j++)for(let i=ix-cells;i<=ix+cells;i++){
      const x=(i+0.5)*cell-World.half,z=(j+0.5)*cell-World.half;
      const d=Math.hypot(x-r.x,z-r.z),bed=terrain.heightAt(x,z),above=bed-r.y;
      const weight=(1-MathUtils.smoothstep(d,r.hw*0.76,reach))*(1-MathUtils.smoothstep(above,0.45,1.3));
      if(weight<=0)continue;
      const k=4*(j*size+i);
      data[k]=Math.max(data[k],Math.round(208*weight));
      data[k+1]=Math.max(data[k+1],Math.round(47*weight));
      data[k+2]=Math.max(data[k+2],Math.round(255*weight*(1-MathUtils.smoothstep(above,0.02,0.36))));
      data[k+3]=240;
      // The foliage and bank textures have the same native 3 m resolution.
      terrain.splat[k]=Math.min(terrain.splat[k],Math.round((1-weight)*255));
      terrain.splat[k+3]=Math.min(terrain.splat[k+3],Math.round((1-weight)*255));
    }
  }
  texture.needsUpdate=true;terrain.splatTex.needsUpdate=true;
  const r=river.rows[Math.floor(river.rows.length*0.64)];
  const nx=-r.tz,nz=r.tx;
  let offset=r.hw;
  while(offset<r.hw+8 && terrain.heightAt(r.x+nx*offset,r.z+nz*offset)<r.y+0.09)offset+=0.25;
  const x=r.x+nx*offset,z=r.z+nz*offset,y=terrain.heightAt(x,z);
  return {name:'stream',fov:60,position:[x,y+1.65,z],target:[r.x+r.tx*8,r.y+0.15,r.z+r.tz*8],
    feet:[x,y,z],yaw:Math.atan2(nx,nz)*180/Math.PI};
}
