import * as THREE from 'three';

// One clipped reflection for the lake the player is visiting. It contains the real
// bank geometry and plants. Clear texels use the same live sky as the ocean.
export function createLakeReflection() {
  const camera=new THREE.PerspectiveCamera(), plane=new THREE.Plane(), clip=new THREE.Vector4(), corner=new THREE.Vector4();
  const direction=new THREE.Vector3(), up=new THREE.Vector3(0,1,0), clear=new THREE.Color();
  const matrix={value:new THREE.Matrix4()};
  const target=new THREE.WebGLRenderTarget(640,400,{type:THREE.HalfFloatType});
  const map={value:target.texture}, modes=new Map(),hidden=[];
  let previous, last=-Infinity, captures=0;
  const previousEye=new THREE.Vector3(), previousRotation=new THREE.Quaternion();
  function register(b,mesh){modes.set(b,mesh.material.uniforms.uMirrorOn);hidden.push(mesh);}
  function update(renderer,scene,eye,body,omit,time) {
    if(previous!==body){
      if(previous)modes.get(previous).value=0;
      previous=body;last=-Infinity;
    }
    if(!body || eye.position.y<=body.level) return;
    const moving=eye.position.distanceToSquared(previousEye)>0.055 || eye.quaternion.angleTo(previousRotation)>0.017;
    if(time-last<(moving?0.14:0.8)) return;
    previousEye.copy(eye.position);previousRotation.copy(eye.quaternion);
    const level=body.level;
    eye.updateMatrixWorld();
    camera.position.copy(eye.position);camera.position.y=2*level-eye.position.y;
    eye.getWorldDirection(direction).reflect(up);
    camera.up.set(0,1,0).applyQuaternion(eye.quaternion).reflect(up);
    camera.lookAt(direction.add(camera.position));
    camera.layers.mask=eye.layers.mask;
    camera.near=eye.near;camera.far=eye.far;
    camera.updateMatrixWorld();
    camera.projectionMatrix.copy(eye.projectionMatrix);
    // Replace the near plane with the water plane in mirror-camera space.
    plane.set(up,-level-0.01).applyMatrix4(camera.matrixWorldInverse);
    clip.set(plane.normal.x,plane.normal.y,plane.normal.z,plane.constant);
    const e=camera.projectionMatrix.elements;
    e[0]*=0.91;e[5]*=0.91; // Guard band for wave distortion at the screen edges.
    corner.set((Math.sign(clip.x)+e[8])/e[0],(Math.sign(clip.y)+e[9])/e[5],-1,(1+e[10])/e[14]);
    clip.multiplyScalar(2/clip.dot(corner));
    e[2]=clip.x;e[6]=clip.y;e[10]=clip.z+1;e[14]=clip.w;
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
    matrix.value.multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse);
    const oldTarget=renderer.getRenderTarget(),alpha=renderer.getClearAlpha(),background=scene.background;
    const shadows=renderer.shadowMap.autoUpdate,objects=[...hidden,...omit],vis=objects.map(o=>o.visible);
    renderer.getClearColor(clear);
    try{
      objects.forEach(o=>{o.visible=false;});
      renderer.shadowMap.autoUpdate=false;
      scene.background=null;
      renderer.setClearColor(0,0);
      renderer.setRenderTarget(target);
      renderer.clear(); renderer.render(scene,camera);
    }finally{
      renderer.setRenderTarget(oldTarget);renderer.setClearColor(clear,alpha);scene.background=background;
      renderer.shadowMap.autoUpdate=shadows;objects.forEach((o,i)=>{o.visible=vis[i];});
    }
    modes.get(body).value=1;
    last=time;captures++;
  }
  return {map,matrix,register,update,get captures(){return captures;}};
}
