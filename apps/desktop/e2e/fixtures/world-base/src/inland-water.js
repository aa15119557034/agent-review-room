import * as THREE from 'three';
import { shared, U } from '../upstream/petalwake/src/core/ctx.js';
import { NOISE, ATMOSPHERE, TERRAIN_LOOKUP } from '../upstream/petalwake/src/shaders/common.js';
import { SKY_UNIFORMS, CLOUD_LOOKUP } from '../upstream/petalwake/src/world/sky.js';
import { basins, basinAt, contour } from './basins.js';
import { createRipples } from './water-ripples.js';
import { createLakeReflection } from './lake-reflection.js';
import { createDriftwood } from './driftwood.js';
import { shoreStones } from './shore-stones.js';

// Direction along/across the wind, wave number, amplitude and deep-water frequency.
const windWaves=[[1,0,0.64,0.043],[0.84,0.53,1.2,0.016]].map(([along,across,k,a])=>({along,across,k,a,omega:Math.sqrt(9.81*k)}));
const waveGLSL=windWaves.map(w=>`${w.a}*sin(dot(p,wind*${w.along.toFixed(2)}+crossWind*${w.across.toFixed(2)})*${w.k}-uTime*${w.omega.toFixed(5)})`).join('+');

const waves = /* glsl */`
uniform float uTime;
uniform vec4 uWind, uPatch;
uniform sampler2D uDisturbance;
float rippleAt(vec2 p){
  vec2 uv=(p-uPatch.xy)*uPatch.z+0.5;
  if(uPatch.z==0.0 || any(greaterThan(abs(uv-0.5),vec2(0.485)))) return 0.0;
  return textureLod(uDisturbance,uv,0.0).r;
}
float windRunup(vec2 p){
  float w=clamp(uWind.z,0.3,1.9);
  return w*(0.025*sin(dot(p,uWind.xy)*0.29-uTime*1.52)+0.011*sin(dot(p,vec2(0.57,0.82))*0.58-uTime*2.06));
}
float windWave(vec2 p){
  vec2 wind=uWind.xy, crossWind=vec2(-wind.y,wind.x);
  return uWind.z*(${waveGLSL});
}
`;

const vertex = /* glsl */`
varying vec3 vPoint;
uniform float uLevel;
${waves}
${TERRAIN_LOOKUP}
void main(){
  vec3 p=(modelMatrix*vec4(position,1.0)).xyz;
  float depth=uLevel-terrainH(p.xz);
  p.y+=mix(windRunup(p.xz),windWave(p.xz)+rippleAt(p.xz),smoothstep(-0.01,0.48,depth));
  vPoint=p;
  gl_Position=projectionMatrix*viewMatrix*vec4(p,1.0);
}`;

const fragment = /* glsl */`
varying vec3 vPoint;
uniform float uRain, uLevel, uMirrorOn;
uniform sampler2D uMirrorMap;
uniform mat4 uMirrorVP;
uniform vec3 uDeep;
uniform sampler2D uRipple;
${NOISE}
${ATMOSPHERE}
${TERRAIN_LOOKUP}
${CLOUD_LOOKUP}
${waves}
vec2 rainSlope(vec2 p){
  vec2 grid=p*3.0,id=floor(grid);
  vec2 q=fract(grid)-0.5-(hash22(id)-0.5)*0.36;
  float age=fract(uTime*1.22+hash12(id)), d=length(q);
  return q/max(d,0.001)*sin((d-age*0.50)*41.0)*exp(-45.0*abs(d-age*0.50))*(1.0-age);
}
vec3 reflectedBank(vec3 p,vec3 ray,vec3 sky){
  if(ray.y>0.54) return sky;
  float t=2.0, prev=0.0;
  for(int k=0;k<19;k++){
    vec3 q=p+ray*t;
    if(terrainH(q.xz)>q.y){
      for(int j=0;j<3;j++){
        float mid=(prev+t)*0.5;
        vec3 v=p+ray*mid;
        if(terrainH(v.xz)>v.y) t=mid; else prev=mid;
      }
      q=p+ray*t;
      vec4 light=texture(uLightTex,worldUV(q.xz));
      vec3 n=terrainN(q.xz,1.0);
      vec3 bank=mix(vec3(0.095,0.17,0.060),vec3(0.24,0.21,0.17),smoothstep(0.14,0.5,1.0-n.y));
      return applyAtmosphere(bank*(uAmbSky+uSunColor*light.r*max(dot(n,uSunDir),0.0)),q);
    }
    prev=t; t=t*1.34+2.5;
  }
  return sky;
}
void main(){
  vec3 p=vPoint, v=normalize(uCamPos-p);
  float meanDepth=uLevel-terrainH(p.xz);
  float depth=meanDepth+mix(windRunup(p.xz),p.y-uLevel,smoothstep(0.02,0.46,meanDepth));
  float edge=max(fwidth(depth),0.003);
  float coverage=smoothstep(-edge,edge,depth);
  if(coverage<0.008) discard;
  depth=max(depth,0.0);
  float bank=smoothstep(0.0,0.45,depth);
  float e=0.12;
  vec2 slope=vec2(windWave(p.xz+vec2(e,0))-windWave(p.xz-vec2(e,0)),
    windWave(p.xz+vec2(0,e))-windWave(p.xz-vec2(0,e)))/(2.0*e);
  vec2 contact=vec2(0.0);float focusing=0.0;
  if(uPatch.z>0.0 && all(lessThan(abs((p.xz-uPatch.xy)*uPatch.z),vec2(0.46)))){
    float left=rippleAt(p.xz-vec2(e,0)),right=rippleAt(p.xz+vec2(e,0));
    float up=rippleAt(p.xz+vec2(0,e)),down=rippleAt(p.xz-vec2(0,e));
    contact=vec2(right-left,up-down)/(2.0*e);
    focusing=clamp((left+right+up+down-4.0*rippleAt(p.xz))/(e*e),-1.0,1.0);
    slope+=contact;
  }
  float dist=distance(uCamPos,p);
  slope+=(texture(uRipple,p.xz*0.12-uWind.xy*uTime*0.055).xy-0.5)*0.12*uWind.z;
  if(uRain>0.01 && dist<90.0) slope+=uRain*0.24*rainSlope(p.xz)*(1.0-smoothstep(40.0,90.0,dist));
  vec3 n=normalize(vec3(-slope.x*bank,1.0,-slope.y*bank));
  vec3 ray=reflect(-v,n);
  vec3 skyRay=normalize(vec3(ray.x,max(ray.y,0.002),ray.z));
  vec4 cloud=sampleClouds(skyRay,p);
  vec3 sky=skyBase(skyRay)*(1.0-cloud.a)+cloud.rgb;
  vec3 reflected=sky;
  vec4 projected=uMirrorVP*vec4(p.x,uLevel,p.z,1.0);
  vec2 uv=projected.xy/max(0.001,projected.w)*0.5+0.5 + n.xz*min(0.08,0.021+dist*0.00012);
  if(uMirrorOn>0.5 && projected.w>0.0 && all(lessThan(abs(uv-0.5),vec2(0.496)))){
    vec4 geometry=texture(uMirrorMap,uv);
    reflected=geometry.rgb+sky*(1.0-geometry.a);
  }else reflected=reflectedBank(p+vec3(0,0.12,0),ray,sky);
  float nv=clamp(dot(n,v),0.0,1.0), fresnel=0.0204+0.9796*pow(1.0-nv,5.0);
  vec3 bed=mix(vec3(0.110,0.130,0.146),vec3(0.32,0.34,0.35),texture(uNoiseTex,(p.xz+n.xz*depth)*0.09).g);
  vec3 transmit=exp(-depth*vec3(1.16,0.58,0.24)/max(nv,0.30));
  vec3 diffuse=mix(uDeep,bed,transmit)*(vec3(0.16,0.20,0.25)+uAmbSky*0.68+uSunColor*0.23);
  diffuse*=1.0+focusing*0.40*(1.0-uCloudFlow.z*0.7)*exp(-0.7*depth);
  float gloss=mix(650.0,130.0,clamp(uWind.z/2.0+uRain*0.3,0.0,1.0));
  float sun=pow(max(dot(n,normalize(uSunDir+v)),0.0),gloss)*(1.0-uCloudFlow.z*0.93);
  // The bed under a few centimetres of water is the actual opaque terrain already
  // in the framebuffer. As the optical path grows, absorption replaces it with the lake body.
  float opticalDepth=depth/max(nv,0.38);
  float extinction=1.0-exp(-2.5*opticalDepth);
  float surface=fresnel*smoothstep(0.0,0.055,opticalDepth);
  float scatter=(1.0-surface)*extinction;
  float alpha=max(0.0001,surface+scatter);
  vec3 color=(scatter*diffuse+surface*reflected+sun*uSunColor*2.5*extinction)/alpha;
  // Windblown broken foam only on an exposed, shallow wave front, never a solid outline.
  float crest=smoothstep(0.013,0.033,windRunup(p.xz));
  float foam=crest*(1.0-smoothstep(0.035,0.14,depth))*smoothstep(0.02,0.05,depth)
    *smoothstep(0.66,0.82,texture(uNoiseTex,p.xz*0.12-uTime*uWind.xy*0.006).g)*smoothstep(0.9,1.7,uWind.z);
  color=mix(color,uAmbSky+0.38*uSunColor,0.4*foam);
  gl_FragColor=vec4(applyAtmosphere(color,p),coverage*alpha);
}`;

function surfaceGeometry(b) {
  const w=2.6*b.rx, h=2.6*b.rz;
  const g=new THREE.PlaneGeometry(w,h,Math.ceil(w/3),Math.ceil(h/3)).rotateX(-Math.PI/2);
  const pos=g.attributes.position,indices=g.index.array,keep=[];
  for(let i=0;i<indices.length;i+=3){
    const a=indices[i],c=indices[i+1],d=indices[i+2];
    const x=b.x+(pos.getX(a)+pos.getX(c)+pos.getX(d))/3, z=b.z+(pos.getZ(a)+pos.getZ(c)+pos.getZ(d))/3;
    if(contour(b,x,z)<1.08) keep.push(a,c,d);
  }
  g.setIndex(keep);
  return g;
}

function marshReeds(b,terrain){
  const points=[], colors=[];
  let seed=2971;
  const rand=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  function face(a,b,c,tint){points.push(...a,...b,...c);colors.push(...tint,...tint,...tint);}
  for(let i=0;i<3600;i++){
    const cx=b.x+(rand()*2-1)*b.rx*1.24,cz=b.z+(rand()*2-1)*b.rz*1.24,d=contour(b,cx,cz);
    if(d<0.72 || d>1.13 || Math.sin(cx*0.14)+Math.cos(cz*0.19)<0.55) continue;
    for(let j=0;j<6;j++){
      const x=cx+(rand()-0.5)*2.1,z=cz+(rand()-0.5)*2.1,y=terrain.heightAt(x,z);
      const h=0.75+rand()*0.95,a=rand()*Math.PI*2;
      const green=[0.19+rand()*0.08,0.25+rand()*0.08,0.071], straw=[0.41,0.33,0.13];
      for(let k=0;k<4;k++){
        const angle=a+k*2.15,sx=Math.cos(angle),sz=Math.sin(angle),reach=h*(0.32+0.22*rand());
        const vigor=0.70+rand()*0.28;
        let left=[x,y+h*0.11,z],right=left;
        for(let segment=1;segment<=6;segment++){
          const t=segment/6,w=0.018*Math.sin(Math.PI*t)**0.7;
          const spread=reach*t**1.6;
          const cy=y+h*(0.11+vigor*(1.50*t-0.90*t*t));
          const l=[x+sx*spread-sz*w,cy,z+sz*spread+sx*w],r=[x+sx*spread+sz*w,cy,z+sz*spread-sx*w];
          face(left,right,l,green);face(right,r,l,green);left=l;right=r;
        }
      }
      const tip=[x+0.12,y+h,z+0.06],base=[x,y,z];
      for(let k=0;k<2;k++){
        const wx=k?0:0.011,wz=k?0.011:0;
        face([base[0]-wx,y,base[2]-wz],[base[0]+wx,y,base[2]+wz],tip,straw);
        const bottom=[tip[0]-0.033,tip[1]-0.19,tip[2]-0.013];
        const w=1.75;
        face([bottom[0]-wx*w,bottom[1],bottom[2]-wz*w],[bottom[0]+wx*w,bottom[1],bottom[2]+wz*w],tip,[0.26,0.16,0.059]);
      }
    }
  }
  const g=new THREE.BufferGeometry();
  g.setAttribute('position',new THREE.Float32BufferAttribute(points,3));
  g.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));
  const mat=new THREE.ShaderMaterial({
    vertexColors:true,side:THREE.DoubleSide,uniforms:shared(...SKY_UNIFORMS),
    vertexShader:`varying vec3 vColor,vP;void main(){vColor=color;vP=position;gl_Position=projectionMatrix*viewMatrix*vec4(position,1.0);}`,
    fragmentShader:`varying vec3 vColor,vP;
      ${NOISE}
      ${ATMOSPHERE}
      void main(){gl_FragColor=vec4(applyAtmosphere(vColor*(uAmbSky*0.85+uSunColor*0.35),vP),1.0);}
    `,
  });
  return new THREE.Mesh(g,mat);
}

export function createInlandWater(terrain,sky,river,streamLevelAt,branches) {
  const group=new THREE.Group();
  const sea={id:'sea'},stream={id:'river'};
  const levelAt=(b,x,z)=>b===sea ? U.uSeaSetup.value : b===stream ? streamLevelAt(x,z) : b.level;
  const depthAt=(b,x,z)=>(b===stream || b===sea || contour(b,x,z)<1.09) ? levelAt(b,x,z)-terrain.heightAt(x,z) : 0;
  const waterAt=(x,z)=>{
    const lake=basinAt(x,z);
    if(lake) return lake;
    if(terrain.heightAt(x,z)<U.uSeaSetup.value) return sea;
    if(streamLevelAt(x,z)>terrain.heightAt(x,z)) return stream;
  };
  const ripples=createRipples(depthAt);
  U.uWaterPatch.value=ripples.patch; U.uWaterDisturbance.value=ripples.texture;
  const reflection=createLakeReflection(), floats=[],stoneGroups=[];
  const sampleSurface=(b,x,z)=>{
    const w=U.uWind.value,t=U.uTime.value;
    let displacement=ripples.heightAt(b,x,z);
    for(const wave of windWaves){
      const dot=x*(w.x*wave.along-w.y*wave.across)+z*(w.y*wave.along+w.x*wave.across);
      displacement+=w.z*wave.a*Math.sin(dot*wave.k-t*wave.omega);
    }
    const runup=w.z*(0.025*Math.sin((x*w.x+z*w.y)*0.29-t*1.52)+0.011*Math.sin((x*0.57+z*0.82)*0.58-t*2.06));
    return b.level+THREE.MathUtils.lerp(runup,displacement,THREE.MathUtils.smoothstep(depthAt(b,x,z),-0.01,0.48));
  };
  const rain={value:0};
  for(const b of basins) {
    const material=new THREE.ShaderMaterial({
      uniforms:{...shared(...SKY_UNIFORMS,'uTime','uWind','uWorld','uHeightTex','uLightTex','uSplatTex'),
        ...sky.cloudUniforms, uLevel:{value:b.level}, uDeep:{value:new THREE.Vector3(...b.color)},uRain:rain,
        uMirrorMap:reflection.map,uMirrorVP:reflection.matrix,uMirrorOn:{value:0},
        uDisturbance:{value:ripples.texture},uPatch:{value:ripples.patch},uRipple:river.material.uniforms.uRipple},
      vertexShader:vertex,fragmentShader:fragment,transparent:true,depthWrite:true,
    });
    const mesh=new THREE.Mesh(surfaceGeometry(b),material);
    mesh.name=b.id+'-water';mesh.position.set(b.x,b.level,b.z);mesh.renderOrder=510;group.add(mesh);
    reflection.register(b,mesh);
    const wood=createDriftwood(b,terrain,sampleSurface);
    floats.push(wood);group.add(wood.group);stoneGroups.push(shoreStones(b,terrain));
    if(b.id==='marsh' || b.id==='oxbow') group.add(marshReeds(b,terrain));
  }
  stoneGroups.push(shoreStones(stream,terrain,river.rows));
  for(const branch of branches)stoneGroups.push(shoreStones({id:'mountain-stream'},terrain,branch.rows));
  group.add(...stoneGroups);
  let previous=new THREE.Vector3(Infinity,0,0), stride=0;
  function update(dt,weather,feet,eye){
    for(const shore of stoneGroups)for(const mesh of shore.children){
      const sphere=mesh.boundingSphere;mesh.visible=eye.distanceToSquared(sphere.center)<(145+sphere.radius)**2;
    }
    rain.value=weather.rain;
    if(feet){
      const distance=previous.distanceTo(feet);
      const b=distance>0.001 && distance<1 ? waterAt(feet.x,feet.z) : null;
      if(b && levelAt(b,feet.x,feet.z)-feet.y>0.035){
        stride+=distance;
        if(stride>0.68){ripples.disturb(b,feet.x,feet.z,0.035);stride=0;}
      }else stride=0;
      previous.copy(feet);
    }else previous.x=Infinity;
    ripples.update(dt);
    for(const wood of floats)wood.update(dt,U.uWind.value);
  }
  function splashRay(ray){
    if(ray.direction.y>=0) return false;
    for(let d=0.25;d<900;d+=Math.min(2.0,0.18+0.007*d)){
      const x=ray.origin.x+d*ray.direction.x,z=ray.origin.z+d*ray.direction.z,y=ray.origin.y+d*ray.direction.y;
      const bed=terrain.heightAt(x,z);
      const body=waterAt(x,z);
      if(body && y<=levelAt(body,x,z) && levelAt(body,x,z)>bed) return ripples.disturb(body,x,z,0.052);
      if(y<=bed) break;
    }
    return false;
  }
  return {group,ripples,depthAt,sampleSurface,splashRay,reflection,update};
}
