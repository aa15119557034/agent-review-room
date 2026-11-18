import * as THREE from 'three';
import { basins, contour } from '../src/basins.js';

// Photograph ordinary materials at two wave phases, then count the wet pixels in
// a separate unlit pass using the very same surface, height texture and shore discard.
export function strandlineProbe(w, shore) {
  const island=w.island,b=basins.find(b=>b.id==='marsh'),[x,bed,z]=shore;
  const gx=contour(b,x+1,z)-contour(b,x-1,z),gz=contour(b,x,z+1)-contour(b,x,z-1);
  const length=Math.hypot(gx,gz),nx=gx/length,nz=gz/length;
  w.camera.position.set(x+nx*1.65+nz*0.7,bed+1.24,z+nz*1.65-nx*0.7);
  w.camera.lookAt(x,bed,z);w.camera.fov=55;w.camera.updateProjectionMatrix();w.camera.updateMatrixWorld();
  const realUpdate=island.update,realWeather=island.weather.update,original=island.U.uTime.value;
  island.weather.update=()=>realWeather(24);
  island.weather.update();
  let phase=0,lowest=Infinity,highest=-Infinity,lowTime,highTime;
  for(let t=0;t<25;t+=0.04){
    island.U.uTime.value=t;
    const elevation=island.inland.sampleSurface(b,x,z)-bed;
    if(elevation<lowest){lowest=elevation;lowTime=t;}
    if(elevation>highest){highest=elevation;highTime=t;}
  }
  island.update=dt=>realUpdate(dt,phase);
  const mesh=island.inland.group.getObjectByName('marsh-water'),input=mesh.material;
  const marker='gl_FragColor=vec4(applyAtmosphere(color,p),coverage*alpha);';
  if(!input.fragmentShader.includes(marker))throw Error('Shore coverage shader changed');
  const material=new THREE.ShaderMaterial({uniforms:input.uniforms,vertexShader:input.vertexShader,
    fragmentShader:input.fragmentShader.replace(marker,'gl_FragColor=vec4(vec3(coverage),1.0);')});
  const scene=new THREE.Scene();scene.background=new THREE.Color(0);
  const mask=new THREE.Mesh(mesh.geometry,material);mask.position.copy(mesh.position);scene.add(mask);
  const width=400,height=250,rt=new THREE.WebGLRenderTarget(width,height),renderer=w.renderer;
  function snapshot(t){
    const target=renderer.getRenderTarget();
    try{
      island.U.uTime.value=t;
      renderer.setRenderTarget(rt); renderer.clear(); renderer.render(scene,w.camera);
      const data=new Uint8Array(width*height*4);
      renderer.readRenderTargetPixels(rt,0,0,width,height,data);
      return data;
    }finally{renderer.setRenderTarget(target);}
  }
  return {
    lowTime,highTime,lowest,highest,
    show(t){phase=t;},
    measure(){
      const low=snapshot(lowTime),high=snapshot(highTime);
      let gained=0,exposed=0,lowWet=0,highWet=0;
      for(let k=0;k<low.length;k+=4){
        const a=low[k]>127,b=high[k]>127;
        lowWet+=Number(a);highWet+=Number(b);gained+=Number(!a&&b);exposed+=Number(a&&!b);
      }
      return {width,height,lowWet,highWet,gained,exposed,lowTime,highTime,lowest,highest,shore};
    },
    restore(){island.U.uTime.value=original;island.update=realUpdate;island.weather.update=realWeather;rt.dispose();material.dispose();},
  };
}
