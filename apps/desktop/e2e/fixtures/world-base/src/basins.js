import { DataTexture, RGBAFormat, LinearFilter, MathUtils } from 'three';
import { World } from '../upstream/petalwake/src/core/ctx.js';

// Metres in Petalwake world space. Levels remain above the ocean datum even at the deepest point.
export const basins = [
  { id: 'tarn', name: '山地冰斗湖', x: 735, z: -824, rx: 173, rz: 103, level: 138, depth: 13, rim: 14, color: [0.030, 0.115, 0.132] },
  { id: 'terrace', name: '西侧阶地湖', x: -1443, z: -370, rx: 195, rz: 95, level: 97, depth: 7.5, rim: 6, color: [0.050, 0.140, 0.110] },
  { id: 'oxbow', name: '东侧牛轭湖', x: 1195, z: 660, rx: 154, rz: 86, level: 26, depth: 3.8, rim: 2.6, color: [0.092, 0.123, 0.057] },
  { id: 'marsh', name: '南侧浅滩湿地', x: 615, z: 865, rx: 115, rz: 59, level: 10, depth: 1.45, rim: 1.75, color: [0.105, 0.132, 0.067] },
];

const smooth = MathUtils.smoothstep;
// A value of one follows the waterline. The same contour carves, meshes and bounds play.
export function contour(b, x, z) {
  // Displace the contour in metres so coves and depositional notches retain
  // their physical scale on both the narrow oxbow and the larger upland lakes.
  const u = (x-b.x+1.35*Math.sin(z*0.103)+0.75*Math.sin((x+z)*0.21))/b.rx;
  const v = (z-b.z+1.7*Math.sin(x*0.081)+0.6*Math.cos((x-z)*0.18))/b.rz;
  if (b.id === 'oxbow') {
    let a = Math.atan2(v, u);
    const end = 0.76;
    if (Math.abs(a) < end) a = a < 0 ? -end : end;
    return Math.hypot(u-0.71*Math.cos(a), v-0.77*Math.sin(a)) / (0.23 + 0.035*Math.sin(2*a));
  }
  const a = Math.atan2(v, u);
  let d = Math.hypot(u, v) / (1 + 0.085*Math.sin(3*a+0.6) + 0.06*Math.sin(5*a-0.8) + 0.025*Math.cos(9*a));
  if (b.id === 'marsh') {
    // Two emergent sediment bars split the shallow pool into backwaters.
    d = Math.max(d, 1.34 - Math.hypot((u+0.28)/0.32, (v-0.14)/0.74),
      1.28 - Math.hypot((u-0.40)/0.38, (v+0.58)/0.40));
  }
  return d;
}

// Approximate signed metres from the contour. Use its local gradient so a metre
// of wet margin has comparable width around the ends and sides of a long lake.
function shoreMetres(b,x,z,d) {
  const gx=(contour(b,x+1,z)-contour(b,x-1,z))*0.5;
  const gz=(contour(b,x,z+1)-contour(b,x,z-1))*0.5;
  return (d-1)/Math.max(0.003,Math.hypot(gx,gz));
}

function outerBend(b,x,z) {
  const radial=Math.hypot((x-b.x)/b.rx,(z-b.z)/b.rz);
  return smooth(radial,0.66,0.83);
}

export function basinAt(x, z, limit = 1) {
  for (const b of basins) {
    if (Math.abs(x-b.x) < 1.8*b.rx && Math.abs(z-b.z) < 1.8*b.rz && contour(b,x,z) < limit) return b;
  }
}

function visitGrid(b, size, visit) {
  const cell = World.size/size;
  const index = metres => Math.floor((metres+World.half)/cell);
  for (let j=index(b.z-1.8*b.rz); j<=index(b.z+1.8*b.rz); j++) {
    const z=(j+0.5)*cell-World.half;
    for (let i=index(b.x-1.8*b.rx); i<=index(b.x+1.8*b.rx); i++) {
      const x=(i+0.5)*cell-World.half;
      const d=contour(b,x,z);
      if (d < (b.id==='oxbow' ? 2.75 : 1.55)) visit(j*size+i,x,z,d);
    }
  }
}

export function carveBasins(terrain) {
  return basins.map(b => {
    let wetCells = 0, volume = 0;
    visitGrid(b,terrain.N,(i,x,z,d) => {
      // A shallow littoral shelf gives way to the lake floor. The cirque has a steep
      // headwall and the terrace lake a second bench above its ordinary waterline.
      const north = MathUtils.clamp((b.z-z)/b.rz,0,1);
      let bank = b.rim * smooth(d,1,1.32);
      if (b.id === 'tarn') bank += 23*north*smooth(d,1.04,1.31);
      if (b.id === 'terrace') bank = 2*smooth(d,1,1.10)+5*smooth(d,1.19,1.29);
      const bed = b.depth * (0.28*(1-smooth(d,0.60,1)) + 0.72*(1-smooth(d,0.12,0.84)));
      const gravel = 0.15*Math.sin(0.061*x)*Math.sin(0.074*z)*smooth(Math.abs(d-1),0,0.18);
      let y = b.level + bank - bed + gravel;
      if(d>0.50 && d<1.40){
        const metres=shoreMetres(b,x,z,d);
        const slope=b.id==='tarn'?0.145:b.id==='terrace'?0.079:b.id==='marsh'?0.037:
          MathUtils.lerp(0.043,0.23,outerBend(b,x,z));
        const small=0.033*Math.sin(x*0.72+z*0.42)+0.018*Math.sin(z*1.11-x*0.36);
        const shoreY=b.level+metres*slope+small*smooth(Math.abs(metres),0,1.8);
        y=MathUtils.lerp(shoreY,y,smooth(Math.abs(metres),4,12));
      }
      terrain.h[i] = MathUtils.lerp(y,terrain.h[i],smooth(d,1.28,b.id==='oxbow' ? 2.75 : 1.55));
      if (d < 1 && terrain.h[i] < b.level) { wetCells++; volume += b.level-terrain.h[i]; }
    });
    visitGrid(b,terrain.splatN,(i,x,z,d) => {
      const keep = smooth(d,1.01,1.15);
      const k = i*4;
      terrain.splat[k] = Math.round(terrain.splat[k]*smooth(d,1.14,1.52));
      terrain.splat[k+3] = Math.round(terrain.splat[k+3]*keep);
      terrain.splat[k+2] = Math.round(MathUtils.lerp(255,terrain.splat[k+2],keep));
    });
    return {id:b.id, areaM2:wetCells*terrain.cell**2, volumeM3:Math.round(volume*terrain.cell**2)};
  });
}

// Pack local coarse gravel, fine sediment and wet margins into one terrain sample.
export function makeBankTexture() {
  const size=2048, data=new Uint8Array(size*size*4);
  for(const b of basins) visitGrid(b,size,(i,x,z,d)=>{
    const irregular=0.035*Math.sin(x*0.14+Math.sin(z*0.07))+0.018*Math.cos(z*0.21);
    const weight=1-smooth(d+irregular,1.01,1.22);
    const gravel=b.id==='tarn'?0.97:b.id==='terrace'?0.72:b.id==='oxbow'?0.24+0.48*outerBend(b,x,z):0.12;
    data[i*4]=Math.round(255*weight*gravel);
    data[i*4+1]=Math.round(255*weight*(1-gravel));
    data[i*4+2]=Math.round(255*(1-smooth(d+irregular,1.03,1.17)));
    data[i*4+3]=48*(1+basins.indexOf(b));
  });
  const texture=new DataTexture(data,size,size,RGBAFormat);
  texture.magFilter=texture.minFilter=LinearFilter;texture.needsUpdate=true;
  return texture;
}

// Each shore has a fixed eye-level viewpoint and a wading entry facing its water.
export function bankView(b, terrain) {
  const [dx,dz] = {tarn:[-0.56,-0.83],terrace:[0.64,-0.77],oxbow:[-0.99,0.14],marsh:[0.94,0.34]}[b.id];
  const radius=Math.hypot(b.rx,b.rz)*1.55;
  const shore=distance=>[b.x+dx*distance,b.z+dz*distance];
  let d=radius;
  while(d>0 && contour(b,...shore(d))>1.075) d-=0.5;
  const [x,z]=shore(d),ground=terrain.heightAt(x,z);
  while(d>0 && contour(b,...shore(d))>1.012) d-=0.25;
  const [fx,fz]=shore(d);
  return {name:b.id,fov:62,position:[x,ground+2.15,z],target:[x-65*dx,b.level+0.3,z-65*dz],
    feet:[fx,terrain.heightAt(fx,fz),fz],yaw:Math.atan2(dx,dz)*180/Math.PI};
}
