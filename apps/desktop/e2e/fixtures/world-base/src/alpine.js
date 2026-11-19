import { MathUtils, Vector4 } from 'three';
import { World } from '../upstream/petalwake/src/core/ctx.js';
import { dataTex, loadImage } from '../upstream/petalwake/src/world/terrain.js';

// North-up in world XZ. Both axes and heights use one quarter of survey scale.
const west = 770, north = -700, spanX = 1000, spanZ = 750;
const cols = 800, rows = 600;
export const alpineRect = new Vector4(west, north, spanX, spanZ);
const smooth = MathUtils.smoothstep;

export async function loadAlpine() {
  const url = new URL('./alpine/relief.u16', import.meta.url);
  const [response, image] = await Promise.all([fetch(url), loadImage(new URL('./alpine/surface.jpg', import.meta.url))]);
  if (!response.ok) throw new Error(`Alpine relief: HTTP ${response.status}`);
  return { heights: new Uint16Array(await response.arrayBuffer()), surface: dataTex(image, { srgb: true }) };
}

export function applyAlpine(terrain, atlas, heights) {
  if (heights.length !== cols * rows) throw new Error('Incomplete Alpine survey grid');
  const { lerp, clamp } = MathUtils;
  function elevation(x, z) {
    const sx = clamp((x-west)/spanX*cols-0.5, 0, cols-1);
    const sy = clamp((z-north)/spanZ*rows-0.5, 0, rows-1);
    const i = Math.floor(sx), j = Math.floor(sy);
    const next = Math.min(i+1, cols-1), row = Math.min(j+1, rows-1)*cols;
    const a = lerp(heights[j*cols+i], heights[j*cols+next], sx-i);
    const b = lerp(heights[row+i], heights[row+next], sx-i);
    return 124 + 0.025*lerp(a, b, sy-j);
  }
  // Irregular apron follows the old valley and stops above the headwater fork.
  // Bake its weight once so mesh, turf, and fragment shader share the same mask.
  function weight(x,z) {
    const inset = Math.min(x-west, west+spanX-x, z-north, north+spanZ-z);
    const edge = inset - 13 - 11*Math.sin(x*0.024+z*0.016) - 6*Math.sin(z*0.039);
    const u=(x-1315)/508, v=(z+315)/371;
    const spur=Math.sqrt(u*u+v*v-0.70*u*v)+0.032*Math.sin(x*0.017+z*0.021);
    return smooth(edge,0,92)*(1-smooth(spur,0.50,1.02))*smooth(x+0.16*(z+280),821,993);
  }
  function visit(n, op) {
    const step = World.size/n;
    for(let j=Math.floor((north+World.half)/step); j<Math.ceil((north+spanZ+World.half)/step); j++){
      const z=(j+0.5)*step-World.half;
      for(let i=Math.floor((west+World.half)/step); i<Math.ceil((west+spanX+World.half)/step); i++){
        const x=(i+0.5)*step-World.half, w=weight(x,z);
        if(w>0) op(j*n+i,x,z,w);
      }
    }
  }
  visit(terrain.N,(k,x,z,w)=>{terrain.h[k]=lerp(terrain.h[k],elevation(x,z),w);});
  visit(terrain.splatN,(k,x,z,w)=>{
    terrain.splat[k*4]=Math.round(terrain.splat[k*4]*(1-w)**2);
    terrain.splat[k*4+3]=Math.round(terrain.splat[k*4+3]*(1-w));
  });
  // The empty G channel in the lower bank map is used elsewhere for shoreline
  // sand. At alpine altitudes it can hold survey coverage when A (water ID) is 0.
  const n=atlas.image.width, data=atlas.image.data;
  visit(n,(k,x,z,w)=>{if(data[k*4+3]===0) data[k*4+1]=Math.round(w*255);});
  atlas.needsUpdate=true;
}

export function alpineLodRange(x,z) {
  const dx=Math.max(west-x,0,x-west-spanX), dz=Math.max(north-z,0,z-north-spanZ);
  return 150 + 135*(1-smooth(Math.hypot(dx,dz),0,280));
}
