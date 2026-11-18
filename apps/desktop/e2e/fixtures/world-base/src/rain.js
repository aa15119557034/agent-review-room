import * as THREE from 'three';
import { shared } from '../upstream/petalwake/src/core/ctx.js';

// A top-down depth pass over the station lets drops land on the actual roof,
// awnings and pavement. It is rendered once while assembling the static town.
export function createRain(scene,renderer,station){
  const size=260,top=station.root.position.y+110;
  const target=new THREE.WebGLRenderTarget(512,512,{depthTexture:new THREE.DepthTexture(512,512)});
  const overhead=new THREE.OrthographicCamera(-size/2,size/2,size/2,-size/2,1,160);
  overhead.up.set(0,0,-1);
  overhead.position.set(station.root.position.x,top,station.root.position.z);
  overhead.lookAt(station.root.position);
  const keep=scene.children.map(c=>c.visible),oldMaterial=scene.overrideMaterial,oldTarget=renderer.getRenderTarget();
  const depthMaterial=new THREE.MeshDepthMaterial({side:THREE.DoubleSide});
  const shadows=renderer.shadowMap.autoUpdate;
  try{
    scene.children.forEach(c=>{c.visible=c===station.root;});
    scene.overrideMaterial=depthMaterial;
    renderer.shadowMap.autoUpdate=false;
    renderer.setRenderTarget(target);
    renderer.clear();
    renderer.render(scene,overhead);
  }finally{
    renderer.setRenderTarget(oldTarget);
    renderer.shadowMap.autoUpdate=shadows;
    scene.overrideMaterial=oldMaterial;
    scene.children.forEach((c,i)=>{c.visible=keep[i];});
    depthMaterial.dispose();
  }
  const count=1750, seeds=new Float32Array(count*2*3),ends=new Float32Array(count*2);
  let seed=1769;
  const rand=()=>{seed=(Math.imul(1664525,seed)+1013904223)>>>0;return seed/4294967296;};
  for(let k=0;k<count;k++){
    const p=[rand(),rand(),rand()];
    seeds.set(p,k*6);seeds.set(p,k*6+3);ends[2*k+1]=1;
  }
  const g=new THREE.BufferGeometry();
  g.setAttribute('position',new THREE.BufferAttribute(seeds,3));
  g.setAttribute('end',new THREE.BufferAttribute(ends,1));
  const mat=new THREE.ShaderMaterial({
    uniforms:{...shared('uWind','uCamPos','uTime','uWorld','uHeightTex'),uRain:{value:0},uRoof:{value:target.depthTexture},
      uFootprint:{value:new THREE.Vector4(overhead.position.x,overhead.position.z,top,size)}},
    transparent:true,depthWrite:false,
    vertexShader:`attribute float end;
      uniform vec4 uWind,uWorld,uFootprint; uniform vec3 uCamPos; uniform float uTime,uRain;
      uniform sampler2D uHeightTex,uRoof;
      varying float vAlpha;
      void main(){
        vec3 box=vec3(40.,18.,40.);
        vec3 velocity=vec3(uWind.x*uWind.z*2.6,-12.,uWind.y*uWind.z*2.6);
        vec3 p=mod(position*box+velocity*uTime-uCamPos+box*0.5,box)-box*0.5+uCamPos;
        p+=velocity*end*0.025;
        vec2 uv=(p.xz-uFootprint.xy)/uFootprint.w*vec2(1.,-1.)+0.5;
        float ground=textureLod(uHeightTex,p.xz*uWorld.y+0.5,0.).r;
        if(all(lessThan(abs(uv-0.5),vec2(0.5)))){
          float roof=uFootprint.z-1.0-textureLod(uRoof,uv,0.).r*159.0;
          ground=max(ground,roof);
        }
        float dist=distance(p,uCamPos);
        vAlpha=step(ground,p.y)*uRain*smoothstep(0.7,2.0,dist)*(1.0-smoothstep(12.0,20.0,dist));
        gl_Position=projectionMatrix*viewMatrix*vec4(p,1.);
      }`,
    fragmentShader:`varying float vAlpha; void main(){gl_FragColor=vec4(0.66,0.72,0.78,0.38*vAlpha);}`,
  });
  const streaks=new THREE.LineSegments(g,mat);
  streaks.frustumCulled=false;streaks.renderOrder=1010;
  scene.add(streaks);
  return {update(amount){streaks.visible=amount>0.015;mat.uniforms.uRain.value=amount;},streaks};
}
