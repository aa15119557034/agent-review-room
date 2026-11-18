import * as THREE from 'three';
import { shared } from '../upstream/petalwake/src/core/ctx.js';
import { ATMOSPHERE, NOISE } from '../upstream/petalwake/src/shaders/common.js';
import { SKY_UNIFORMS } from '../upstream/petalwake/src/world/sky.js';
import { contour } from './basins.js';

// Actual cobbles cross the waterline, so the transparent shallows and the mirror
// see the same objects as the dry beach. Each cluster is seated on the edited DEM.
export function shoreStones(b,terrain,rows) {
  let seed=rows?29317:Math.round(12217+b.x*b.z);
  const rand=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  const stones=[], wetland=b.id==='marsh', upland=b.id==='tarn';
  const candidates=rows?rows.length*3:wetland?1600:upland?7400:4900;
  for(let i=0;i<candidates;i++){
    let cx,cz,level;
    if(rows){
      const row=rows[Math.floor(rand()*rows.length)], across=(0.59+0.73*rand())*(rand()<0.5?-1:1)*row.hw;
      cx=row.x-row.tz*across;cz=row.z+row.tx*across;level=row.y;
    }else{
      cx=b.x+(rand()*2-1)*b.rx*1.24;cz=b.z+(rand()*2-1)*b.rz*1.24;level=b.level;
      const d=contour(b,cx,cz);
      if(d<0.80 || d>1.23) continue;
    }
    if(Math.sin(cx*0.19)+Math.cos(cz*0.23)<-0.28) continue;
    const count=2+Math.floor(rand()*7);
    for(let j=0;j<count;j++){
      const x=cx+(rand()-0.5)*2.5,z=cz+(rand()-0.5)*2.5,y=terrain.heightAt(x,z);
      if(y-level>1.25 || y-level< -0.75) continue;
      const radius=(wetland?0.036:0.055)+(upland?0.43:0.24)*rand()**2;
      stones.push({x,y,z,radius,level});
    }
  }
  const g=new THREE.IcosahedronGeometry(1,2),pos=g.attributes.position,normal=g.attributes.normal;
  const radial=new THREE.Vector3(),gradient=new THREE.Vector3();
  for(let i=0;i<pos.count;i++){
    const x=pos.getX(i),y=pos.getY(i),z=pos.getZ(i);
    const a=x*4.2+y*2.3+z*3.7,c=x*6.7-z*3.1;
    const r=1+0.088*Math.sin(a)+0.047*Math.cos(c);
    pos.setXYZ(i,r*x,r*y,r*z);
    radial.set(x,y,z).normalize();
    gradient.set(0.088*4.2*Math.cos(a)-0.047*6.7*Math.sin(c),0.088*2.3*Math.cos(a),
      0.088*3.7*Math.cos(a)+0.047*3.1*Math.sin(c));
    gradient.addScaledVector(radial,-gradient.dot(radial));
    radial.addScaledVector(gradient,-1/r).normalize();
    normal.setXYZ(i,radial.x,radial.y,radial.z);
  }
  g.computeBoundingSphere();
  const material=new THREE.ShaderMaterial({
    uniforms:{...shared(...SKY_UNIFORMS),uMatC:terrain.material.uniforms.uMatC},
    vertexShader:`attribute float shoreLevel;uniform vec3 uCamPos;varying float vLevel;varying vec3 vP,vN,vColor;
      void main(){
        mat3 m=mat3(instanceMatrix);
        vN=normalize(m*(normal/vec3(dot(m[0],m[0]),dot(m[1],m[1]),dot(m[2],m[2]))));
        vec3 center=instanceMatrix[3].xyz;
        float detail=1.0-smoothstep(108.0,145.0,distance(center,uCamPos));
        vP=center+m*position*detail;vColor=instanceColor;vLevel=shoreLevel;
        gl_Position=projectionMatrix*viewMatrix*vec4(vP,1.0);}`,
    fragmentShader:`precision highp sampler2DArray;
      varying vec3 vP,vN,vColor;varying float vLevel;uniform sampler2DArray uMatC;
      ${NOISE}
      ${ATMOSPHERE}
      void main(){vec3 n=normalize(vN),v=normalize(uCamPos-vP);
        vec2 uv=(vP.xz+vP.y*vec2(0.7,0.29))*0.22;
        float grain=texture(uNoiseTex,uv).g;
        float wet=1.0-smoothstep(-0.015,0.19,vP.y-vLevel+(grain-0.5)*0.07);
        vec3 weights=pow(abs(n),vec3(3.0));weights/=dot(weights,vec3(1.0));
        vec3 rock=texture(uMatC,vec3(vP.zy*2.7,1.0)).rgb*weights.x+
          texture(uMatC,vec3(vP.xz*2.7,1.0)).rgb*weights.y+texture(uMatC,vec3(vP.xy*2.7,1.0)).rgb*weights.z;
        float mineral=dot(rock,vec3(0.2126,0.7152,0.0722));
        vec3 albedo=vColor*(0.49+2.55*rock+0.25*grain)*mix(1.0,0.51,wet);
        albedo+=vec3(0.075)*smoothstep(0.23,0.42,mineral)*(1.0-0.45*wet);
        float direct=max(dot(n,uSunDir),0.0)*(1.0-0.78*uCloudFlow.z);
        float gloss=pow(max(dot(n,normalize(v+uSunDir)),0.0),55.0)*wet*direct*0.48;
        vec3 color=albedo*(uAmbSky*(0.52+0.43*max(n.y,0.0))+0.64*uSunColor*direct)+uSunColor*gloss;
        gl_FragColor=vec4(applyAtmosphere(color,vP),1.0);}`,
  });
  const cells=new Map(),group=new THREE.Group();
  for(const s of stones){
    const key=Math.floor(s.x/48)+','+Math.floor(s.z/48);
    if(!cells.has(key)) cells.set(key,[]);
    cells.get(key).push(s);
  }
  const transform=new THREE.Object3D(),color=new THREE.Color();
  for(const batch of cells.values()){
    const geometry=new THREE.BufferGeometry();
    geometry.setAttribute('position',pos);geometry.setAttribute('normal',normal);
    geometry.setAttribute('shoreLevel',new THREE.InstancedBufferAttribute(Float32Array.from(batch,s=>s.level),1));
    const mesh=new THREE.InstancedMesh(geometry,material,batch.length);
    for(let i=0;i<batch.length;i++){
      const {x,y,z,radius:r}=batch[i],thin=(0.35+0.36*rand())*r;
      transform.position.set(x,y+thin*(0.08+0.20*rand()),z);
      transform.scale.set(r,thin,r*(0.58+0.39*rand()));
      transform.rotation.set(0.19*(rand()-0.5),rand()*Math.PI,0.22*(rand()-0.5));
      transform.updateMatrix();mesh.setMatrixAt(i,transform.matrix);
      const grey=0.20+rand()*0.21,warm=0.91+rand()*0.25;
      color.setRGB(grey*warm,grey*(0.96+rand()*0.10),grey*(upland?1.03:0.83));
      mesh.setColorAt(i,color);
    }
    mesh.computeBoundingSphere();group.add(mesh);
  }
  group.name=b.id+'-shore-stones';group.userData.count=stones.length;
  return group;
}
