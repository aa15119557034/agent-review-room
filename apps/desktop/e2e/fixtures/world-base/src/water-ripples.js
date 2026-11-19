import * as THREE from 'three';

// Linear shallow-water waves on a local metre-scaled patch. Wet cells exchange
// flux with wet neighbours; a dry bank reflects the incident disturbance.
export function createRipples(depthAt) {
  const n=96, cell=0.24, step=1/60, span=n*cell;
  let previous=new Float32Array(n*n), height=new Float32Array(n*n);
  const speed2=new Float32Array(n*n);
  const tex=new THREE.DataTexture(height,n,n,THREE.RedFormat,THREE.FloatType);
  tex.minFilter=tex.magFilter=THREE.LinearFilter;
  tex.needsUpdate=true;
  const patch=new THREE.Vector4(0,0,0,cell);
  let owner, age=Infinity, carry=0, impacts=0;
  function disturb(body,x,z,amplitude=0.12) {
    if (!body || depthAt(body,x,z)<=0.025) return false;
    if (owner!==body || Math.abs(x-patch.x)>span*0.37 || Math.abs(z-patch.y)>span*0.37 || age>5) {
      owner=body; patch.set(x,z,1/span,cell); height.fill(0); previous.fill(0);
      for(let j=0;j<n;j++) for(let i=0;i<n;i++) {
        const depth=depthAt(body,x+(i+0.5-n/2)*cell,z+(j+0.5-n/2)*cell);
        speed2[j*n+i]=9.81*THREE.MathUtils.clamp(depth,0,2);
      }
    }
    const col=Math.floor((x-patch.x)/cell+n/2), row=Math.floor((z-patch.y)/cell+n/2);
    for(let j=-2;j<=2;j++) for(let i=-2;i<=2;i++) {
      const k=(row+j)*n+col+i;
      if(speed2[k]>0) height[k]+=amplitude*Math.exp(-(i*i+j*j)*0.78);
    }
    impacts++; age=0;
    tex.needsUpdate=true;
    return true;
  }
  function update(dt) {
    if (!patch.z) return;
    age+=dt;
    if(age>5){patch.z=0;return;}
    carry+=dt;
    while(carry>=step) {
      carry-=step;
      for(let j=1;j<n-1;j++) for(let i=1;i<n-1;i++){
        const k=j*n+i,c=speed2[k];
        if(!c) continue;
        const h=height[k];
        const flux=Math.min(c,speed2[k-1])*(height[k-1]-h)+Math.min(c,speed2[k+1])*(height[k+1]-h)
          +Math.min(c,speed2[k-n])*(height[k-n]-h)+Math.min(c,speed2[k+n])*(height[k+n]-h);
        const damping=Math.min(i,j,n-1-i,n-1-j)<5 ? 0.80 : 0.977;
        previous[k]=h+damping*(h-previous[k])+flux*(step/cell)**2;
      }
      [previous,height]=[height,previous];
    }
    tex.image.data=height;tex.needsUpdate=true;
  }
  function heightAt(body,x,z) {
    if(!patch.z || body!==owner) return 0;
    const u=(x-patch.x)/cell+n/2-0.5,v=(z-patch.y)/cell+n/2-0.5;
    if(u<1 || v<1 || u>=n-2 || v>=n-2) return 0;
    const i=Math.floor(u),j=Math.floor(v),k=j*n+i;
    return THREE.MathUtils.lerp(THREE.MathUtils.lerp(height[k],height[k+1],u-i),
      THREE.MathUtils.lerp(height[k+n],height[k+n+1],u-i),v-j);
  }
  return {patch,texture:tex,disturb,update,heightAt,get impacts(){return impacts;}};
}
