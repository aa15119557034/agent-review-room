import * as THREE from 'three';
import { shared } from '../upstream/petalwake/src/core/ctx.js';
import { NOISE_TEX } from '../upstream/petalwake/src/shaders/common.js';

// Soft spray at the impact point. Animation follows scene time and local wind.
export function fallMist(fall) {
  const geometry=new THREE.InstancedBufferGeometry().copy(new THREE.PlaneGeometry(1,1));
  const seeds=[];
  for(let i=0;i<52;i++)seeds.push((i*0.618034)%1,(i*0.754878)%1,(i*0.56984)%1);
  geometry.setAttribute('seed',new THREE.InstancedBufferAttribute(new Float32Array(seeds),3));
  geometry.instanceCount=seeds.length/3;
  geometry.boundingSphere=new THREE.Sphere(new THREE.Vector3(0,4,0),29);
  const material=new THREE.ShaderMaterial({
    uniforms:{...shared('uTime','uWind','uNoiseTex','uSunColor','uAmbSky'),uRadius:{value:fall.hw}},
    vertexShader:`
      attribute vec3 seed;
      uniform float uTime,uRadius;
      uniform vec4 uWind;
      varying vec2 vUV;varying float vOpacity,vSeed;
      void main(){
        float age=fract(seed.x+uTime*(0.21+0.11*seed.z));
        float angle=6.283185*seed.y;
        vec2 outward=vec2(cos(angle),sin(angle));
        vec2 lateral=outward*uRadius*(0.15+0.70*seed.z+0.54*age)+uWind.xy*age*age*3.8;
        vec3 center=vec3(lateral.x,0.4+age*(2.2+3.8*seed.z),lateral.y);
        vec4 eye=modelViewMatrix*vec4(center,1.);
        eye.xy+=position.xy*vec2(1.15,0.87)*(1.7+4.4*age);
        vUV=uv;vSeed=seed.y;vOpacity=0.15*sin(age*3.14159)*(1.-smoothstep(220.,380.,-eye.z));
        gl_Position=projectionMatrix*eye;
      }`,
    fragmentShader:`
      uniform vec3 uSunColor,uAmbSky;
      varying vec2 vUV;varying float vOpacity,vSeed;
      ${NOISE_TEX}
      void main(){
        vec2 q=vUV-0.5;
        float density=1.-smoothstep(0.04,0.49,length(q)+(ntex(13.*q+vSeed*70.).r-0.5)*0.16);
        gl_FragColor=vec4(vec3(0.68,0.80,0.86)*(0.60*uAmbSky+0.36*uSunColor),vOpacity*density);
      }`,transparent:true,depthWrite:false,
  });
  const mist=new THREE.Mesh(geometry,material);
  mist.position.copy(fall.base);mist.renderOrder=512;
  return mist;
}
