import * as THREE from 'three';
import { U, World, shared } from '../upstream/petalwake/src/core/ctx.js';
import { ATMOSPHERE, CLOUD_SHADOW } from '../upstream/petalwake/src/shaders/common.js';
import { SKY_UNIFORMS } from '../upstream/petalwake/src/world/sky.js';
import { basinAt } from './basins.js';
import { loadWoodlandModels, loadForestAtlas, species } from './woodland-models.js';

const smooth=THREE.MathUtils.smoothstep;
const stands=[
  // Centre, radii, affinity for moist deciduous woodland.
  [1070,444,234,130,0.48],[1323,472,180,90,0.28],[1390,795,133,116,0.57],
  [890,641,167,99,0.84],[652,669,133,84,0.75],[497,300,114,169,0.55],
  [638,-83,153,78,0.71],[895,-759,104,123,0.23],[490,-879,140,115,0.38],
  [1087,-854,158,115,0.18],[1490,-665,161,123,0.10],[-1500,-192,147,139,0.53],
  [-1327,-538,113,118,0.81],[-1644,90,154,119,0.36],[-912,-1005,239,109,0.39],
];
const grid=7.3;
function hash(i,j,k) {
  let v=Math.imul(i,374761393)+Math.imul(j,668265263)+Math.imul(k,144269501);
  v=Math.imul(v^(v>>>13),1274126177);
  return ((v^(v>>>16))>>>0)/4294967296;
}
function noise(x,z,scale) {
  const u=x/scale,v=z/scale,i=Math.floor(u),j=Math.floor(v);
  const a=smooth(u-i,0,1),b=smooth(v-j,0,1),mix=THREE.MathUtils.lerp;
  return mix(mix(hash(i,j,17),hash(i+1,j,17),a),mix(hash(i,j+1,17),hash(i+1,j+1,17),a),b);
}

// Use the native R/G/B/A meadow fields for flower abundance, species, soil moisture
// and blade cover. Preserve the authored fields, streets, and their approaches.
export function shapeMeadows(terrain,towns,station) {
  const n=terrain.splatN,step=World.size/n,splat=terrain.splat;
  const rects=towns.map(t=>[t.aabb[0],t.aabb[2],t.aabb[3],t.aabb[5]]);
  rects.push([station.minX-60,station.minZ-85,station.maxX+60,station.maxZ+100]);
  for(let j=0;j<n;j++){
    const z=(j+0.5)*step-World.half;
    for(let i=0;i<n;i++){
      const k=4*(j*n+i);if(splat[k+3]<10)continue;
      const x=(i+0.5)*step-World.half,y=terrain.heightAt(x,z);
      if(y<2.8)continue;
      let margin=Infinity;
      for(const b of rects) margin=Math.min(margin,Math.max(b[0]-x,0,x-b[2],b[1]-z,z-b[3]));
      const influence=smooth(margin,4,48);if(!influence)continue;
      const patch=noise(x,z,37), tuft=noise(x,z,11);
      const grade=Math.hypot(terrain.heightAt(x+2,z)-y,terrain.heightAt(x,z+2)-y)/2;
      const wet=Math.min(1,(splat[k+2]/255)*0.72+0.28*patch);
      const exposure=smooth(y+155*grade+33*(1-wet),125,370);
      const bloom=smooth(0.70*patch+0.30*tuft,0.43,0.76)*(1-0.84*exposure);
      const mix=THREE.MathUtils.lerp;
      splat[k]=Math.round(splat[k]*mix(1,0.012+0.55*bloom*bloom,influence));
      splat[k+1]=Math.round(mix(splat[k+1],255*(0.38+0.53*noise(x+90,z-28,67)),influence));
      splat[k+2]=Math.round(mix(splat[k+2],255*wet*(1-0.60*exposure),influence));
      splat[k+3]=Math.round(splat[k+3]*mix(1,(0.75+0.25*tuft)*(1-0.58*exposure),influence));
    }
  }
  terrain.splatTex.needsUpdate=true;
}

export function plantWoodland(terrain,atlas,towns,streamLevelAt,entries) {
  const trees=[],counts=Object.fromEntries(species.map(s=>[s.name,0]));
  const used=new Set(),{data,width:n}=atlas.image;
  const step=World.size/n,bank=k=>4*k,district=4*n*n;
  const cell=(x,z)=>Math.floor((z+World.half)/step)*n+Math.floor((x+World.half)/step);
  for(const [cx,cz,rx,rz,moisture] of stands){
    for(let iz=Math.floor((cz-rz)/grid);iz<=Math.ceil((cz+rz)/grid);iz++){
      for(let ix=Math.floor((cx-rx)/grid);ix<=Math.ceil((cx+rx)/grid);ix++){
        const key=ix+','+iz;if(used.has(key))continue;
        const x=(ix+0.17+0.66*hash(ix,iz,1))*grid,z=(iz+0.17+0.66*hash(ix,iz,2))*grid;
        const radius=Math.hypot((x-cx)/rx,(z-cz)/rz);
        const patch=noise(x,z,53),edge=1-smooth(radius+(0.5-patch)*0.45,0.53,1.03);
        if(hash(ix,iz,3)>edge*(0.18+0.80*smooth(patch,0.16,0.76)))continue;
        const y=terrain.heightAt(x,z);
        if(y<4 || y>399 || towns.some(({aabb:b})=>x>b[0]-10&&x<b[3]+10&&z>b[2]-10&&z<b[5]+10))continue;
        const k=bank(cell(x,z)),g=district+k,basin=basinAt(x,z,1.12);
        if((basin&&y<basin.level+1.2)||streamLevelAt(x,z)>y-1.15||data[k+3]>0||data[k+1]>40||Math.max(...data.subarray(g,g+4))>110)continue;
        if(entries.some(p=>Math.hypot(p.feet[0]-x,p.feet[2]-z)<4.8))continue;
        const gx=(terrain.heightAt(x+2,z)-terrain.heightAt(x-2,z))/4;
        const gz=(terrain.heightAt(x,z+2)-terrain.heightAt(x,z-2))/4;
        const slope=Math.hypot(gx,gz);
        if(slope>0.90 || hash(ix,iz,6)<smooth(y+55*slope,237,400))continue;
        const wet=THREE.MathUtils.clamp(0.45*moisture+0.35*(terrain.splat[k+2]/255)+0.20*patch,0,1);
        const upland=smooth(y+42*slope+90*(0.5-moisture),110,300);
        const r=hash(ix,iz,5);
        const id=r<0.10+0.69*upland ? 2 : r>1-0.56*wet ? 1 : r<0.30+0.24*wet ? 3 : 0;
        const age=hash(ix,iz,7);
        const scale=(0.38+0.84*Math.sqrt(age)*smooth(age,-0.14,0.48))*(0.67+0.33*edge)*(1-0.18*upland);
        const variant=2*id+Number(hash(ix,iz,8)>0.5),yaw=hash(ix,iz,9)*Math.PI*2;
        const height=species[id].height*scale;
        trees.push({x,y:y-0.10,z,height,scale,yaw,variant,radius:height*(id===0?0.033:0.022)});
        used.add(key);counts[species[id].name]++;
        // Litter and grazing light thin the herb layer beneath individual crowns.
        const crown=height*(id===2?0.28:0.41);
        for(let j=Math.floor((z-crown+World.half)/step);j<=Math.floor((z+crown+World.half)/step);j++){
          for(let i=Math.floor((x-crown+World.half)/step);i<=Math.floor((x+crown+World.half)/step);i++){
            const wx=(i+0.5)*step-World.half,wz=(j+0.5)*step-World.half;
            const cover=1-smooth(Math.hypot(wx-x,wz-z)/crown,0.18,1);
            const b=4*(j*n+i);if(!cover || data[b+3])continue;
            data[b]=Math.max(data[b],Math.round(cover*213));
            terrain.splat[b]=Math.round(terrain.splat[b]*(1-0.94*cover));
            terrain.splat[b+3]=Math.round(terrain.splat[b+3]*(1-0.69*cover));
          }
        }
      }
    }
  }
  // Project each crown onto the actual slope along the active sun direction.
  // R/G/B on dry texels carry litter / survey weight / canopy shadow.
  const sun=U.uSunDir.value, horizontal=Math.hypot(sun.x,sun.z);
  const dx=sun.x/horizontal,dz=sun.z/horizontal,rise=sun.y/horizontal;
  for(const t of trees){
    const crown=t.height*((t.variant>>1)===2?0.27:0.36), reach=Math.min(75,t.height/Math.max(0.12,rise)*1.6);
    const tx=t.x-reach*dx,tz=t.z-reach*dz;
    for(let j=Math.floor((Math.min(tz,t.z)-crown+World.half)/step);j<=Math.ceil((Math.max(tz,t.z)+crown+World.half)/step);j++)
    for(let i=Math.floor((Math.min(tx,t.x)-crown+World.half)/step);i<=Math.ceil((Math.max(tx,t.x)+crown+World.half)/step);i++){
      const x=(i+0.5)*step-World.half,z=(j+0.5)*step-World.half;
      const along=(t.x-x)*dx+(t.z-z)*dz,side=(t.x-x)*dz-(t.z-z)*dx;
      if(along<0||Math.abs(side)>crown)continue;
      const ray=terrain.heightAt(x,z)+along*rise;
      const r=Math.hypot(side/crown,(ray-t.y-t.height*0.64)/(0.38*t.height));
      const opacity=(1-smooth(r,0.52,1))*(0.59+0.22*noise(x,z,3.7));
      const k=4*(j*n+i);if(data[k+3]===0)data[k+2]=Math.max(data[k+2],Math.round(opacity*255));
    }
  }
  atlas.needsUpdate=true;terrain.splatTex.needsUpdate=true;
  return {trees,counts};
}

function treeMaterial(map,leaf,far=false){
  return new THREE.ShaderMaterial({
    side:leaf||far?THREE.DoubleSide:THREE.FrontSide,
    uniforms:{...shared(...SKY_UNIFORMS,'uTime','uWind','uLightTex','uWorld'),map:{value:map}},
    defines:{...(leaf?{LEAF:1}:{}),...(far?{DISTANT_TREE:1}:{})},
    vertexShader:`
      uniform vec3 uCamPos;uniform float uTime;uniform vec4 uWind;
      varying vec3 vP,vN;varying vec2 vUv;varying float vFade,vTone,vHeight;
      #ifdef DISTANT_TREE
      attribute vec2 aTree;
      #endif
      void main(){
        vec3 foot=instanceMatrix[3].xyz;
        float d=distance(uCamPos,foot), phase=fract(dot(foot.xz,vec2(0.0731,0.0357)));
        vFade=smoothstep(78.0+phase*24.0,104.0+phase*24.0,d);
        vTone=0.84+0.20*phase;
        #ifdef DISTANT_TREE
          if(vFade<=0.0){gl_Position=vec4(2.,2.,2.,1.);return;}
          vec2 dir=normalize(cameraPosition.xz-foot.xz+vec2(0.00001));
          float angle=atan(dir.x,dir.y)-atan(instanceMatrix[2].x,instanceMatrix[2].z);
          float col=mod(floor(angle*0.63661977+0.5),4.0);
          vUv=(vec2(col,7.0-aTree.y)+uv)/vec2(4.,8.);
          vP=foot+vec3(dir.y,0.,-dir.x)*position.x*aTree.x*1.6;
          vP.y+=aTree.x*(0.5+position.y*1.6);
          vN=normalize(vec3(dir.x*position.x,0.87,dir.y*position.x));
          vHeight=clamp(0.5+1.6*position.y,0.,1.);
        #else
          vP=(instanceMatrix*vec4(position,1.)).xyz;vN=normalize(mat3(instanceMatrix)*normal);vUv=uv;
          vHeight=clamp(position.y/13.,0.,1.);
          float bend=smoothstep(0.6,13.0,vP.y-foot.y);
          vP.xz+=uWind.xy*bend*uWind.z*(0.07+0.09*sin(uTime*1.5+phase*8.0));
          #ifdef LEAF
            vP.xz+=uWind.xy*bend*0.035*sin(uTime*4.0+position.z+position.x);
          #endif
        #endif
        gl_Position=projectionMatrix*viewMatrix*vec4(vP,1.0);
      }`,
    fragmentShader:`
      precision highp float;uniform sampler2D map,uLightTex;uniform vec4 uWorld;uniform float uTime;
      varying vec3 vP,vN;varying vec2 vUv;varying float vFade,vTone,vHeight;
      ${ATMOSPHERE}
      ${CLOUD_SHADOW}
      void main(){
        float pattern=fract(52.9829189*fract(dot(floor(gl_FragCoord.xy),vec2(0.06711056,0.00583715))));
        #ifdef DISTANT_TREE
          if(pattern>vFade)discard;
        #else
          if(pattern<vFade)discard;
        #endif
        vec4 sampleColor=texture2D(map,vUv);
        #if defined(LEAF) || defined(DISTANT_TREE)
          if(sampleColor.a<0.36)discard;
        #endif
        vec3 n=normalize(vN);float ndl=max(dot(n,uSunDir),0.0);
        #ifdef LEAF
          ndl=0.28+0.56*abs(dot(n,uSunDir));n.y=abs(n.y);
        #endif
        #ifdef DISTANT_TREE
          ndl=0.48;
        #endif
        float sun=texture2D(uLightTex,vP.xz*uWorld.y+0.5).r*cloudShadow(vP.xz,uTime);
        vec3 sky=mix(uAmbGround,uAmbSky,0.53+0.32*n.y);
        vec3 pigment=mix(vec3(dot(sampleColor.rgb,vec3(0.23,0.60,0.17))),sampleColor.rgb,0.80);
        float crownFill=mix(0.72,1.0,smoothstep(0.12,0.87,vHeight));
        vec3 color=pigment*vTone*(sky*crownFill+uSunColor*ndl*sun*mix(0.72,1.0,crownFill));
        gl_FragColor=vec4(applyAtmosphere(color,vP),1.);
      }`,
  });
}

export async function createWoodland(planted) {
  const [models,atlas]=await Promise.all([loadWoodlandModels(),loadForestAtlas()]);
  const group=new THREE.Group(),dummy=new THREE.Object3D(),trees=planted.trees;
  const near=models.map((m,i)=>m.parts.map(({mesh,leaf})=>{
    const batch=new THREE.InstancedMesh(mesh.geometry,treeMaterial(mesh.material.map,leaf),Math.max(1,trees.filter(t=>t.variant===i).length));
    batch.count=0;batch.frustumCulled=false;group.add(batch);return batch;
  }));
  const plane=new THREE.PlaneGeometry(1,1);
  const far=new THREE.InstancedMesh(plane,treeMaterial(atlas,false,true),trees.length);
  const dims=new Float32Array(trees.length*2);
  trees.forEach((t,i)=>{
    dummy.position.set(t.x,t.y,t.z);dummy.rotation.y=t.yaw;dummy.scale.setScalar(t.scale);
    dummy.updateMatrix();t.matrix=dummy.matrix.clone();far.setMatrixAt(i,t.matrix);
    dims.set([t.height,t.variant],i*2);
  });
  plane.setAttribute('aTree',new THREE.InstancedBufferAttribute(dims,2));far.frustumCulled=false;group.add(far);
  const last=new THREE.Vector3(Infinity,Infinity,Infinity);
  function update(camera){
    if(camera.position.distanceToSquared(last)<16)return;
    last.copy(camera.position);for(const pair of near)for(const batch of pair)batch.count=0;
    for(const t of trees){
      if((last.x-t.x)**2+(last.y-t.y)**2+(last.z-t.z)**2>142**2)continue;
      for(const batch of near[t.variant])batch.setMatrixAt(batch.count++,t.matrix);
    }
    for(const pair of near)for(const batch of pair)if(batch.count)batch.instanceMatrix.needsUpdate=true;
  }
  return {group,update,...planted};
}
