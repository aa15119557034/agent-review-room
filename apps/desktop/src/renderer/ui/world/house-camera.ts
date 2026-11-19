import * as T from "three";

/** Select a cut within the existing room; never moves people to stage a shot. */
export function dialogueCamera(face:T.Vector3,preferred:T.Vector3,occluders:readonly T.Object3D[]){
  const direction=preferred.clone().setY(0).normalize();const angles=[0,-Math.PI/4,Math.PI/4,-Math.PI/2,Math.PI/2,Math.PI,-3*Math.PI/4,3*Math.PI/4];
  let best:{position:T.Vector3;target:T.Vector3;score:number}|undefined;
  for(const distance of [3.4,2.4,1.5,.7])for(const angle of angles){
    const offset=direction.clone().applyAxisAngle(new T.Vector3(0,1,0),angle).multiplyScalar(distance);
    const target=face.clone().add(new T.Vector3(0,distance<1.6?0:-.2,0));const position=target.clone().add(offset).add(new T.Vector3(0,distance<1.6?.25:.85,0));
    const ray=new T.Raycaster(position,face.clone().sub(position).normalize(),.05,position.distanceTo(face)-.1);
    const score=ray.intersectObjects([...occluders],true).filter(hit=>{for(let o:T.Object3D|null=hit.object;o;o=o.parent)if(!o.visible)return false;return true;}).length;
    if(score===0)return {position,target};if(!best||score<best.score)best={position,target,score};
  }
  return {position:best!.position,target:best!.target};
}
