import { CatmullRomCurve3, MathUtils, Vector3 } from 'three';
import { World } from '../upstream/petalwake/src/core/ctx.js';

const {smoothstep, lerp, clamp} = MathUtils;
const gaussian=x=>Math.exp(-x*x);
const coverLoss=[0.98,0.87,0.87,0.76];
const sectors = [
  {id:'caldera', x:951,z:-80,rx:343,rz:290},
  {id:'cape', x:-1765,z:-523,rx:251,rz:153},
  {id:'ravines', x:1480,z:267,rx:238,rz:199},
  {id:'dunes', x:-1464,z:377,rx:290,rz:138},
];

function sectorAt(s,x,z,y) {
  const u=(x-s.x)/s.rx,v=(z-s.z)/s.rz;
  const a=Math.atan2(v,u);
  const r=Math.hypot(u,v)*(1+0.043*Math.sin(3*a+0.6)+0.030*Math.cos(7*a-0.9))
    +0.018*Math.sin(x*0.034+z*0.02);
  const edge=1-smoothstep(r,0.70,1.06);
  if(edge<=0 || (y<0 && s.id!=='cape')) return [y,0];
  const rough=Math.sin(x*0.062+0.6*Math.sin(z*0.043))*Math.cos(z*0.057)+0.45*Math.sin((x-z)*0.15);
  if(s.id==='caldera'){
    const w=edge*smoothstep(x,651,711);
    // An eroded ring, a breached saddle and radial ribs extending down the outer cone.
    const rim=0.42+0.037*Math.sin(3*a)+0.022*Math.cos(6*a);
    const gapAngle=Math.atan2(Math.sin(a+2.50),Math.cos(a+2.50));
    const gate=gaussian(gapAngle/0.29);
    const crown=490+10*Math.sin(3*a)+8*Math.cos(5*a)-34*gate;
    const ribs=(4*Math.sin(10*a+r*3)+2.5*Math.sin(17*a-r*4))*smoothstep(r,0.16,0.48);
    const floor=372+6*Math.sin(3*a)*smoothstep(r,0.05,0.34);
    const profile=r<rim ? lerp(floor,crown,smoothstep(r,0.15,rim)) : crown-(r-rim)*282;
    return [lerp(y,profile+ribs+rough*(1.2+2*smoothstep(r,0.15,0.4)),w),w];
  }
  if(s.id==='cape'){
    const w=edge*smoothstep(y,0.1,5);
    const shelf=2.8+0.13*y+rough*0.8;
    const joint=x+0.34*z+8*Math.sin(z*0.031);
    const slots=gaussian((joint+1942)/11)+gaussian((joint+1876)/8);
    const cliff=97+0.25*y+8*Math.sin(x*0.028)+rough*1.8-24*slots;
    const lip=0.5+0.5*Math.tanh((y-48+7*Math.sin(x*0.034))/9);
    return [lerp(y,lerp(shelf,cliff,lip),w),edge];
  }
  if(s.id==='ravines'){
    const trunk=0.13*Math.sin(v*4)+0.12*v;
    const divide=Math.max(0,0.57-v);
    const channels=Math.min(Math.abs(u-trunk),Math.abs(u-trunk-0.71*divide),Math.abs(u-trunk+0.89*divide));
    const gully=Math.exp(-channels*8.5);
    const spurs=Math.cos((u*4.5+v)*Math.PI+0.5*Math.sin(v*7));
    const toe=smoothstep(v,0.18,0.93);
    const spur=0.5+0.5*spurs;
    const riser=0.5+0.5*Math.tanh(2.1*Math.sin((y+u*7+v*4)/3.9));
    const fan=Math.cos(5.5*Math.atan2(u-trunk,Math.max(0.10,v+0.1))+v*3.1);
    const delta=(13+11*spur-51*gully+4.2*(riser-0.5)*spur)*(1-0.66*toe)+toe*(5+2.8*rough+4.1*fan);
    return [lerp(y,Math.max(1,y+delta+1.9*rough),edge),edge];
  }
  // Parabolic ridges have an asymmetric windward ramp and a shorter lee face.
  const w=edge*smoothstep(y,0.8,3.0)*(1-smoothstep(y,30,45));
  const drift=8*Math.sin(x*0.016+z*0.011)+5*Math.sin(z*0.039-x*0.013);
  const cycle=(z+0.17*(x-s.x)+0.00065*(x-s.x)**2+drift)/38;
  const t=cycle-Math.floor(cycle);
  const ridge=t<0.72 ? smoothstep(t,0,0.72) : 1-smoothstep(t,0.72,1);
  const crests=0.50+0.50*smoothstep(Math.sin(x*0.022+z*0.018)+Math.cos(z*0.027-x*0.009),-0.8,1.0);
  const blowout=gaussian((x+1463)/37)*gaussian((z-370)/18);
  return [y+w*(0.8+5.2*crests*ridge+0.18*rough-2.1*blowout),w];
}

function visit(s,size,fn) {
  const cell=World.size/size;
  const grid=v=>clamp(Math.floor((v+World.half)/cell),0,size-1);
  const x0=grid(s.x-s.rx*1.2),x1=grid(s.x+s.rx*1.2),z0=grid(s.z-s.rz*1.2),z1=grid(s.z+s.rz*1.2);
  for(let j=z0;j<=z1;j++) {
    const z=(j+0.5)*cell-World.half;
    for(let i=x0;i<=x1;i++) fn(j*size+i,(i+0.5)*cell-World.half,z);
  }
}

export function sculptDistricts(terrain, atlas) {
  const {N,h,splat,splatN}=terrain, data=atlas.image.data;
  const mapSize=atlas.image.width, offset=mapSize*mapSize*4;
  for(const [channel,s] of sectors.entries()){
    // Paint before sculpting so the dune strand and wave-cut shelf use the undisturbed datum.
    visit(s,mapSize,(i,x,z)=>{
      const [,w]=sectorAt(s,x,z,terrain.heightAt(x,z));
      data[offset+4*i+channel]=Math.round(255*w);
    });
    visit(s,splatN,(i,x,z)=>{
      const [,w]=sectorAt(s,x,z,terrain.heightAt(x,z));
      const cover=1-w*coverLoss[channel];
      splat[4*i]=Math.round(splat[4*i]*cover*cover);
      splat[4*i+3]=Math.round(splat[4*i+3]*cover);
    });
    visit(s,N,(i,x,z)=>{h[i]=sectorAt(s,x,z,h[i])[0];});
  }
  atlas.needsUpdate=true;
}

function reach(points) {
  const curve=new CatmullRomCurve3(points.map(([x,z])=>new Vector3(x,0,z)));
  const rows=[];
  let distance=0;
  for(let i=0;i<points.length-1;i++){
    const a=points[i], b=points[i+1],count=Math.ceil(Math.hypot(b[0]-a[0],b[1]-a[1])/1.1);
    for(let j=0;j<=count;j++){
      if(i && !j)continue;
      const t=j/count,k=(i+t)/(points.length-1),p=curve.getPoint(k),tangent=curve.getTangent(k);
      const prev=rows.at(-1);
      if(prev)distance+=Math.hypot(p.x-prev.x,p.z-prev.z);
      const width=lerp(a[3],b[3],t)*(1+0.095*Math.sin(distance*0.098)+0.045*Math.sin(distance*0.23));
      rows.push({x:p.x,z:p.z,y:lerp(a[2],b[2],t),hw:width,s:distance,tx:tangent.x,tz:tangent.z});
    }
  }
  for(let i=0;i<rows.length;i++){
    const a=rows[Math.max(0,i-1)],b=rows[Math.min(rows.length-1,i+1)];
    rows[i].slope=(a.y-b.y)/Math.max(0.01,b.s-a.s);
  }
  return rows;
}

// Grade the thalweg and both banks from the same cross sections as the water mesh.
// Nearest-row ownership avoids scalloped banks where adjacent cross sections overlap.
function cutReach(terrain,rows,{brink=false,below=false,joins=false}={}) {
  const first=rows[0],last=rows.at(-1), pad=30, cell=terrain.cell;
  const grid=v=>Math.floor((v+World.half)/cell);
  const x0=grid(Math.min(...rows.map(r=>r.x))-pad),z0=grid(Math.min(...rows.map(r=>r.z))-pad);
  const w=grid(Math.max(...rows.map(r=>r.x))+pad)-x0+1,h=grid(Math.max(...rows.map(r=>r.z))+pad)-z0+1;
  const nearest=new Int32Array(w*h).fill(-1),ds=new Float32Array(w*h).fill(Infinity);
  rows.forEach((r,index)=>{
    for(let j=grid(r.z-pad);j<=grid(r.z+pad);j++)for(let i=grid(r.x-pad);i<=grid(r.x+pad);i++){
      const dx=(i+0.5)*cell-World.half-r.x,dz=(j+0.5)*cell-World.half-r.z,k=(j-z0)*w+i-x0;
      const d=dx*dx+dz*dz;
      if(d<ds[k]){ds[k]=d;nearest[k]=index;}
    }
  });
  for(let k=0;k<nearest.length;k++){
    if(nearest[k]<0)continue;
    const r=rows[nearest[k]],d=Math.sqrt(ds[k]),i=x0+k%w,j=z0+Math.floor(k/w);
    const x=(i+0.5)*cell-World.half,z=(j+0.5)*cell-World.half;
    const downstream=(x-last.x)*last.tx+(z-last.z)*last.tz;
    const inlet=(x-first.x)*first.tx+(z-first.z)*first.tz;
    let weight=1-smoothstep(d,r.hw*1.07,pad);
    if(brink)weight*=1-smoothstep(downstream,0,3);
    if(below)weight*=smoothstep(inlet,-4.5,-0.5);
    if(joins)weight*=1-smoothstep(downstream,0,4);
    if(!weight)continue;
    const bed=terrain.h[j*terrain.N+i],u=d/r.hw;
    const depth=below?lerp(2.6,0.75,smoothstep(r.s,3,23)):0.72;
    const signed=(x-r.x)*(-r.tz)+(z-r.z)*r.tx;
    const bar=smoothstep(u,0.28,0.87)*(0.29+0.30*Math.sin(r.s*0.11+Math.sign(signed)*1.7));
    const floor=r.y-depth+(depth+0.38)*smoothstep(u,0.44,1.18)+bar;
    const side=floor+Math.max(d-r.hw,0)*(0.49+0.22*Math.sin(r.s*0.039));
    let target=u<1.25?side:Math.min(side,bed);
    if(joins)target=lerp(target,Math.min(bed,target),smoothstep(r.s,last.s-24,last.s-5));
    terrain.h[j*terrain.N+i]=lerp(bed,target,weight);
  }
}

export function sculptTributaries(terrain,river) {
  const receiver=river.rows.reduce((a,b)=>Math.hypot(b.x-518,b.z+130)<Math.hypot(a.x-518,a.z+130)?b:a);
  const upper=reach([[822,-251,412,2.5],[792,-242,402,3.0],[754,-217,382,3.8],[720,-204,359,4.3],
    [690,-219,345,4.8],[663,-205,327,5.3],[640,-193,313,5.7],[622,-184,307,6.1]]);
  const lip=upper.at(-1),join=upper.find(r=>r.s>upper.at(-1).s*0.76);
  const lower=reach([[lip.x+lip.tx*6,lip.z+lip.tz*6,285,7.2],[609,-177,284.8,8.0],[590,-169,274,5.5],
    [567,-159,251,4.6],[543,-142,234,4.0],[receiver.x,receiver.z,receiver.y,receiver.hw]]);
  const fork=reach([[770,-333,383,2.1],[739,-312,372,2.8],[714,-293,359,3.1],[702,-267,350,3.3],
    [682,-242,342,3.5],[join.x,join.z,join.y,3.5]]);
  cutReach(terrain,upper,{brink:true});
  cutReach(terrain,fork,{joins:true});
  cutReach(terrain,lower,{below:true,joins:true});
  return {upper,lower,fork,receiver,join};
}

export function makeLandformViews(terrain,fall,drainage) {
  function lookout(name,label,eye,focus,entry,fov=54,clearSightline=true){
    const point=(p)=>[p[0],terrain.heightAt(p[0],p[1])+p[2],p[1]];
    const position=point(eye),target=point(focus),feet=point([entry[0],entry[1],0]);
    // Clear intervening ridges, including the near wall of the crater.
    for(let k=1;clearSightline && k<38;k++){
      const t=k/40,x=lerp(position[0],target[0],t),z=lerp(position[2],target[2],t);
      position[1]=Math.max(position[1],(terrain.heightAt(x,z)+1.8-t*target[1])/(1-t));
    }
    const yaw=Math.atan2(feet[0]-target[0],feet[2]-target[2])*180/Math.PI;
    return {name,label,position,target,feet,yaw,fov};
  }
  const {top,base}=fall,j=drainage.join;
  return [
    lookout('alpine','雪山群峰 · 西南全景',[1043,-132,1.7],[1385,-380,566-terrain.heightAt(1385,-380)],[1043,-132],35,false),
    lookout('couloir','冰蚀雪槽 · 岩脊步道',[1173,-196,1.65],[1314,-430,523-terrain.heightAt(1314,-430)],[1173,-196],50,false),
    lookout('woodland','山麓混交林 · 林下',[1063,436,1.65],[1077,456,4],[1063,436],63,false),
    lookout('meadow','花草坡 · 林缘草甸',[1031,578,1.65],[1062,490,8],[1031,578],57,false),
    lookout('treeline','北坡 · 针叶林带',[1058,-870,1.7],[1101,-853,5],[1058,-870],52,false),
    lookout('caldera','火山口 · 破口与熔岩脊',[1184,132,177],[951,-80,14],[1034,30.5],57),
    lookout('gorge','汇流峡谷 · 双溪交汇',[j.x-45,j.z-48,72],[j.x+10,j.z-9,1],[674,-197]),
    lookout('cascade','悬谷瀑布 · 跌水潭',[base.x-26,base.z+12,8],[top.x,top.z,top.y-terrain.heightAt(top.x,top.z)-7],[565.4,-206],57),
    lookout('cape','海蚀岬 · 层状岩壁',[-2010,-676,126],[-1780,-598,20],[-1740,-536]),
    lookout('ravines','赭土沟谷 · 冲积扇',[1403,184,23],[1462,239,12],[1473.2,374.8]),
    lookout('dunes','西南沙岸 · 风成沙丘',[-1575,358,10],[-1470,391,2],[-1510,401],58),
  ];
}
