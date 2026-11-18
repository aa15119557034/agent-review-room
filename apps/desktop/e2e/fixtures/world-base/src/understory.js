import * as THREE from 'three';
import { World, shared } from '../upstream/petalwake/src/core/ctx.js';
import { ATMOSPHERE, CLOUD_SHADOW } from '../upstream/petalwake/src/shaders/common.js';
import { SKY_UNIFORMS } from '../upstream/petalwake/src/world/sky.js';

// Two close-range herb forms. Fern fronds carry opposite folded leaflets.
// Meadow panicles carry drooping spikelets along several wiry seed stems.
function herbGeometry(fern) {
  const points=[],colors=[];
  const V=(x,y,z)=>new THREE.Vector3(x,y,z);
  function triangle(a,b,c,color) {
    for(const p of [a,b,c]){points.push(p.x,p.y,p.z);colors.push(...color);}
  }
  function leaflet(base,tip,width,halfWidth,color) {
    const mid=base.clone().lerp(tip,0.43),l=mid.clone().addScaledVector(width,halfWidth),r=mid.clone().addScaledVector(width,-halfWidth);
    mid.y+=halfWidth*0.36;
    triangle(base,l,mid,color);triangle(l,tip,mid,color);triangle(base,mid,r,color);triangle(mid,tip,r,color);
  }
  for(let stem=0;stem<(fern?7:5);stem++){
    const a=stem*2.39996,length=(fern?0.58:0.8)*(0.76+0.2*Math.cos(stem*2.7));
    const dir=V(Math.cos(a),0,Math.sin(a)),side=V(-dir.z,0,dir.x);
    const at=t=>dir.clone().multiplyScalar(length*(fern?0.86:0.32)*t*t).add(V(0,length*(fern?1.45*t-0.92*t*t:1.18*t-0.23*t*t),0));
    let prev=at(0);
    for(let j=1;j<=11;j++){
      const t=j/11,p=at(t),width=fern?0.003:0.0025;
      const left=prev.clone().addScaledVector(side,width),right=prev.clone().addScaledVector(side,-width);
      triangle(left,right,p,[0.16,0.19,0.062]);triangle(right,p.clone().addScaledVector(side,-width),p,[0.16,0.19,0.062]);
      prev=p;
      if(fern && j>1){
        for(const sign of [-1,1]){
          const tip=p.clone().addScaledVector(side,sign*0.092*Math.sin(Math.PI*t)**0.73).addScaledVector(dir,0.056*(1-t)+0.014);
          tip.y+=0.014-0.017*t;
          leaflet(p,tip,dir,0.011*(1.3-t),[0.045+0.028*t,0.125+0.085*t,0.035+0.014*t]);
        }
      }else if(!fern && j>=7){
        for(const sign of [-1,1]){
          const head=p.clone().addScaledVector(side,sign*(0.10-0.058*t)).addScaledVector(dir,0.04);
          head.y+=0.003;triangle(p,p.clone().addScaledVector(dir,0.003),head,[0.24,0.23,0.10]);
          const tip=head.clone().addScaledVector(side,sign*0.016);tip.y-=0.030;
          leaflet(head,tip,dir,0.007,[0.38+0.12*t,0.30+0.09*t,0.13]);
        }
      }
    }
    if(!fern)leaflet(at(0.18),at(0.58).addScaledVector(side,0.13),dir,0.010,[0.092,0.15,0.047]);
  }
  const g=new THREE.BufferGeometry();
  g.setAttribute('position',new THREE.Float32BufferAttribute(points,3));g.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));
  g.computeVertexNormals();return g;
}

export function createUnderstory(terrain,atlas) {
  const group=new THREE.Group(), dummy=new THREE.Object3D();
  const mat=new THREE.ShaderMaterial({side:THREE.DoubleSide,vertexColors:true,
    uniforms:{...shared(...SKY_UNIFORMS,'uTime','uWind','uWorld','uLightTex'),uCanopy:{value:atlas}},
    vertexShader:`
      uniform float uTime;uniform vec4 uWind,uWorld;uniform sampler2D uCanopy,uLightTex;
      varying vec3 vP,vN,vC;varying float vSun;
      void main(){
        vP=(instanceMatrix*vec4(position,1.)).xyz;
        vec2 anchor=instanceMatrix[3].xz,uv=anchor*uWorld.y+0.5;
        vec4 crown=textureLod(uCanopy,vec2(uv.x,uv.y*0.5),0.);
        vSun=textureLod(uLightTex,uv,0.).r*(1.-crown.b*(1.-smoothstep(0.,0.02,crown.a)));
        vP.xz+=uWind.xy*uWind.z*position.y*position.y*0.12*sin(uTime*1.8+dot(anchor,vec2(1.7,0.5)));
        vC=color;vN=normalize(mat3(instanceMatrix)*normal);
        gl_Position=projectionMatrix*viewMatrix*vec4(vP,1.);
      }`,
    fragmentShader:`
      uniform float uTime;varying vec3 vP,vN,vC;varying float vSun;
      ${ATMOSPHERE}
      ${CLOUD_SHADOW}
      void main(){
        vec3 n=normalize(vN);
        vec3 col=vC*(mix(uAmbGround,uAmbSky,0.67)+uSunColor*(0.22+0.62*abs(dot(n,uSunDir)))*vSun*cloudShadow(vP.xz,uTime));
        gl_FragColor=vec4(applyAtmosphere(col,vP),1.);
      }`});
  const radius=13,step=2.4,slots=(2*radius+1)**2;
  const batches=[false,true].map(fern=>{
    const m=new THREE.InstancedMesh(herbGeometry(fern),mat,slots);m.count=0;m.frustumCulled=false;group.add(m);return m;
  });
  let lastX,lastZ,lastHigh;
  function update(camera) {
    const x=camera.position.x,z=camera.position.z;
    const ix=Math.floor(x/step),iz=Math.floor(z/step),high=camera.position.y>terrain.heightAt(x,z)+35;
    if(lastX===ix && lastZ===iz && high===lastHigh)return;
    lastX=ix;lastZ=iz;lastHigh=high;batches.forEach(m=>m.count=0);
    if(high)return;
    const n=terrain.splatN,cell=World.size/n,bank=atlas.image.data;
    for(let j=iz-radius;j<=iz+radius;j++)for(let i=ix-radius;i<=ix+radius;i++){
      let seed=(Math.imul(i,73856093)^Math.imul(j,19349663))>>>0;
      const rand=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
      const wx=(i+rand())*step,wz=(j+rand())*step;
      const k=4*(Math.floor((wz+World.half)/cell)*n+Math.floor((wx+World.half)/cell));
      const cover=terrain.splat[k+3]/255,moist=terrain.splat[k+2]/255;
      if(cover<0.13 || bank[k+3] || bank[k+1]>48)continue;
      const fern=bank[k]>38 || (moist>0.60 && bank[k+2]>13);
      const likelihood=fern?0.24+0.59*moist:0.08+0.30*(1-moist);
      if(rand()>cover*likelihood)continue;
      const falloff=1-THREE.MathUtils.smoothstep(Math.hypot(wx-x,wz-z),22,29);
      if(!falloff)continue;
      dummy.position.set(wx,terrain.heightAt(wx,wz)-0.018,wz);dummy.rotation.y=rand()*Math.PI*2;
      dummy.scale.setScalar((0.67+rand()*0.72)*falloff);dummy.updateMatrix();
      const mesh=batches[Number(fern)];mesh.setMatrixAt(mesh.count++,dummy.matrix);
    }
    for(const mesh of batches)mesh.instanceMatrix.needsUpdate=true;
  }
  return {group,update};
}
