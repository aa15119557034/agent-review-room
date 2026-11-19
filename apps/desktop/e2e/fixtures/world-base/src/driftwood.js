import * as THREE from 'three';
import { bankView } from './basins.js';

// A partially submerged branch samples the waves at its bow, stern and sides.
// Damped heave, pitch and roll keep it from snapping to every capillary ripple.
export function createDriftwood(body, terrain, sampleSurface) {
  const entry=bankView(body,terrain), entryYaw=entry.yaw*Math.PI/180;
  const dx=-Math.sin(entryYaw),dz=-Math.cos(entryYaw);
  let x=entry.feet[0],z=entry.feet[2];
  for(let i=0;i<120 && body.level-terrain.heightAt(x,z)<0.36;i++){
    x+=dx*0.75;z+=dz*0.75;
  }
  const group=new THREE.Group();
  group.name=body.id+'-driftwood';
  const bark=new THREE.MeshLambertMaterial({color:0x92785b,flatShading:true});
  function branch(a,b,r1,r2){
    const delta=b.clone().sub(a);
    const mesh=new THREE.Mesh(new THREE.CylinderGeometry(r2,r1,delta.length(),7,1),bark);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),delta.normalize());
    mesh.position.addVectors(a,b).multiplyScalar(0.5);
    group.add(mesh);
  }
  const v=(x,y,z)=>new THREE.Vector3(x,y,z);
  branch(v(-1.1,0,0),v(1.2,0.07,0.06),0.136,0.093);
  branch(v(0.16,0.04,0),v(0.48,0.20,-0.32),0.061,0.034);
  branch(v(0.48,0.20,-0.32),v(0.70,0.25,-0.45),0.034,0.014);
  group.position.set(x,body.level,z);
  const heading=entryYaw+0.7, ax=Math.cos(heading),az=-Math.sin(heading);
  let vy=0, pitchSpeed=0,rollSpeed=0,vx=0,vz=0;
  function update(dt,wind) {
    const p=group.position;
    vx+=(wind.x*wind.z*0.042-vx)*dt*0.85;
    vz+=(wind.y*wind.z*0.042-vz)*dt*0.85;
    const nx=p.x+vx*dt,nz=p.z+vz*dt;
    if(body.level-terrain.heightAt(nx,nz)>0.18){p.x=nx;p.z=nz;}
    const front=sampleSurface(body,p.x+ax,p.z+az),back=sampleSurface(body,p.x-ax,p.z-az);
    const left=sampleSurface(body,p.x-az*0.24,p.z+ax*0.24),right=sampleSurface(body,p.x+az*0.24,p.z-ax*0.24);
    vy+=((front*0.25+back*0.25+left*0.25+right*0.25-p.y)*24-7*vy)*dt;
    pitchSpeed+=(Math.atan2(front-back,2)-group.rotation.z)*18*dt-6*pitchSpeed*dt;
    rollSpeed+=(-Math.atan2(left-right,0.48)-group.rotation.x)*18*dt-6*rollSpeed*dt;
    p.y+=vy*dt;
    group.rotation.set(group.rotation.x+rollSpeed*dt,heading,group.rotation.z+pitchSpeed*dt,'YXZ');
  }
  return {group,update};
}
