import * as THREE from 'three';
import { shared } from '../upstream/petalwake/src/core/ctx.js';
import { SKY_UNIFORMS } from '../upstream/petalwake/src/world/sky.js';
import { ATMOSPHERE, CLOUD_SHADOW } from '../upstream/petalwake/src/shaders/common.js';

const origin=[-1888,-508], ax=0.785,az=0.620;
function point(u,v){return [origin[0]+ax*u+az*v,origin[1]+az*u-ax*v];}

export function createSeaArch(terrain) {
  const positions=[],indices=[],solids=[];
  const slices=96,ring=40;
  function section(t) {
    const s=t/19;
    const hole=Math.sqrt(Math.max(0,1-((s+0.11)/0.69)**2));
    const bottom=-9+24.8*hole + (1.10*Math.sin(5.3*s+0.6)+0.47*Math.sin(14.8*s))*hole;
    const ridge=19.2+4.7*s+1.65*Math.cos(5*s-0.9)+1.3*Math.sin(11*s)+0.56*Math.sin(19*s+0.6);
    const top=THREE.MathUtils.lerp(-3.6,ridge,THREE.MathUtils.smoothstep(t,-28,-13));
    return {bottom,top,depth:3.45+2.5*(1-hole)+0.63*Math.sin(5.6*s),skew:1.25*Math.sin(2.7*s+0.9)};
  }
  for(let i=0;i<=slices;i++){
    const u=-28+66*i/slices,{bottom,top,depth,skew}=section(u);
    for(let j=0;j<ring;j++){
      const a=j/ring*Math.PI*2,c=Math.cos(a),s=Math.sin(a);
      const corner=x=>Math.sign(x)*Math.pow(Math.abs(x),0.55);
      let y=(top+bottom)/2+(top-bottom)/2*corner(s);
      const shelf=Math.tanh(1.8*Math.sin(y*0.96+0.17*u+0.45*Math.sin(u*0.24)));
      const notch=1.6*Math.exp(-Math.pow((y-2.0)/2.1,2));
      const joint=0.62*shelf+0.75*Math.sin(0.46*u+0.48*y)+0.39*Math.sin(1.27*u-0.34*y+0.6*c)-notch;
      const [x,z]=point(u+0.55*Math.sin(0.23*y+u*0.19),skew+corner(c)*(depth+joint)+0.12*y);
      y+=0.49*Math.sin(0.73*u+1.6*c)+0.21*Math.cos(1.14*u-3*c);
      positions.push(x,y,z);
      if(i<slices){
        const b=i*ring+j,n=i*ring+(j+1)%ring;
        indices.push(b,n,b+ring,n,n+ring,b+ring);
      }
    }
    if(i%4===2){
      const [x,z]=point(u,skew+0.12*(bottom+top)/2);
      solids.push({x,z,bottom,top,width:2.76,depth:depth*1.92});
    }
  }
  for(let j=1;j<ring-1;j++)indices.push(0,j+1,j,slices*ring,slices*ring+j,slices*ring+j+1);
  const geometry=new THREE.BufferGeometry();
  geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));geometry.setIndex(indices);geometry.computeVertexNormals();
  const material=new THREE.ShaderMaterial({side:THREE.DoubleSide,uniforms:{
    ...shared(...SKY_UNIFORMS,'uTime','uSeaSetup'),rock:terrain.material.uniforms.uMatC,mean:{value:terrain.material.uniforms.uMean.value[0]}},
    vertexShader:`varying vec3 vP,vN;void main(){vP=position;vN=normal;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
    fragmentShader:`precision highp float;precision highp sampler2DArray;uniform sampler2DArray rock;uniform vec3 mean;
      uniform float uTime,uSeaSetup;varying vec3 vP,vN;
      ${ATMOSPHERE}
      ${CLOUD_SHADOW}
      void main(){
        vec3 n=normalize(vN);if(!gl_FrontFacing)n=-n;
        vec3 w=abs(n);w/=w.x+w.y+w.z;
        vec3 p=vP*0.092;p.y+=0.13*p.x+0.19*sin(p.z*0.64);
        vec3 grain=texture(rock,vec3(p.zy,0.)).rgb*w.x+texture(rock,vec3(p.xz,0.)).rgb*w.y+texture(rock,vec3(p.xy,0.)).rgb*w.z;
        float seam=texture(uNoiseTex,vec2((vP.y+vP.x*0.075)*0.033,vP.z*0.009)).g;
        vec3 stone=mix(vec3(0.30,0.273,0.224),vec3(0.49,0.45,0.35),smoothstep(0.30,0.74,seam));
        float grainY=clamp(dot(grain/mean,vec3(0.25,0.55,0.20)),0.24,1.68);
        stone*=0.56+0.40*grainY;
        float fissure=texture(uNoiseTex,vec2(p.y*0.59+p.z*0.09,p.x*0.085)).r;
        stone*=0.80+0.22*smoothstep(0.30,0.65,fissure);
        stone=mix(stone*vec3(0.54,0.66,0.70),stone,smoothstep(uSeaSetup+0.20,uSeaSetup+2.4,vP.y));
        float direct=smoothstep(-0.20,0.74,dot(n,uSunDir));
        vec3 fill=mix(uAmbGround,uAmbSky,0.53+n.y*0.36);
        vec3 col=stone*(fill+uSunColor*direct*cloudShadow(vP.xz,uTime));
        gl_FragColor=vec4(applyAtmosphere(col,vP),1.);
      }`});
  const mesh=new THREE.Mesh(geometry,material);
  const [ex,ez]=point(0,-16),[vx,vz]=point(-3,-34),[tx,tz]=point(0,0);
  const view={name:'sea-arch',label:'潮门 · 海蚀石拱',fov:56,position:[vx,terrain.heightAt(vx,vz)+2.8,vz],
    target:[tx,11,tz],feet:[ex,terrain.heightAt(ex,ez),ez],yaw:Math.atan2(ex-tx,ez-tz)*180/Math.PI};
  return {mesh,view,solids,yaw:-Math.atan2(az,ax),centre:[tx,tz]};
}
