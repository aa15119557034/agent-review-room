import * as T from "three";

/** A sewn torso and two connected short sleeves, skinned to the CC0 rig. */
export function dressCharacter(body:T.Object3D,color:string){
  const bodies:T.SkinnedMesh[]=[];body.traverse(o=>{if(o instanceof T.SkinnedMesh&&(Array.isArray(o.material)?o.material:[o.material]).some(m=>m.name.includes("Superhero")))bodies.push(o);});
  for(const mesh of bodies){
    const source=mesh.geometry;source.computeBoundingBox();const unit=source.boundingBox!.max.y/1.76664;
    const positions=source.getAttribute("position"),normals=source.getAttribute("normal"),indices=source.index;if(!indices)throw new Error("Character body must be indexed");
    const visibleBody:number[]=[],pants:number[]=[];
    for(let i=0;i<indices.count;i+=3){const tri=[indices.getX(i),indices.getX(i+1),indices.getX(i+2)];if(tri.every(j=>positions.getY(j)/unit<.99))pants.push(...tri);
      const covered=tri.every(j=>{const y=positions.getY(j)/unit,x=Math.abs(positions.getX(j)/unit);return y<.97||(y>.93&&y<1.515&&x<.40);});if(!covered)visibleBody.push(...tri);
    }
    // Mask the source body under clothes rather than letting skin protrude when
    // nearby bones have slightly different influences during a gesture.
    mesh.geometry=source.clone();mesh.geometry.setIndex(visibleBody);
    const trousers=source.clone(),p=trousers.getAttribute("position");for(let i=0;i<p.count;i++)p.setXYZ(i,p.getX(i)+normals.getX(i)*.012,p.getY(i)+normals.getY(i)*.006,p.getZ(i)+normals.getZ(i)*.012);trousers.setIndex(pants);trousers.clearGroups();
    attach(mesh,trousers,new T.MeshStandardMaterial({color:"#37484c",roughness:1,side:T.DoubleSide}),"trousers");
    attach(mesh,shirtGeometry(mesh,unit),new T.MeshStandardMaterial({color,roughness:1,side:T.DoubleSide}),"shirt");
  }
}

function attach(body:T.SkinnedMesh,geometry:T.BufferGeometry,material:T.Material,name:string){const garment=new T.SkinnedMesh(geometry,material);garment.name=name;garment.bind(body.skeleton,body.bindMatrix);garment.position.copy(body.position);garment.quaternion.copy(body.quaternion);garment.scale.copy(body.scale);body.parent!.add(garment);}

function shirtGeometry(body:T.SkinnedMesh,unit:number){
  const pos:number[]=[],skin:number[]=[],weights:number[]=[],triangles:number[]=[];const segments=24;
  const bone=(name:string)=>{const index=body.skeleton.bones.findIndex(b=>b.name===name);if(index<0)throw new Error("Character is missing clothing bone "+name);return index;};
  const pelvis=bone("pelvis"),spine1=bone("spine_01"),spine2=bone("spine_02"),spine3=bone("spine_03");
  const vertex=(x:number,y:number,z:number,a:number,b:number,t:number)=>{pos.push(x*unit,y*unit,z*unit);skin.push(a,b,0,0);weights.push(1-t,t,0,0);};
  const rings=[
    {y:.92,x:.195,z:.133,a:pelvis,b:spine1,t:.5},
    {y:1.12,x:.177,z:.126,a:spine1,b:spine2,t:.25},
    {y:1.34,x:.232,z:.16,a:spine2,b:spine3,t:.55},
    {y:1.465,x:.235,z:.13,a:spine3,b:spine3,t:0},
    {y:1.505,x:.088,z:.073,a:spine3,b:spine3,t:0},
  ];
  for(const ring of rings)for(let i=0;i<segments;i++){const angle=i/segments*Math.PI*2;vertex(Math.cos(angle)*ring.x,ring.y,Math.sin(angle)*ring.z-.005,ring.a,ring.b,ring.t);}
  for(let row=0;row<rings.length-1;row++)for(let i=0;i<segments;i++){const next=(i+1)%segments,a=row*segments+i,b=row*segments+next,c=a+segments,d=b+segments;triangles.push(a,c,b,b,c,d);}
  // Sleeves are fabric surfaces with real openings, not detached torus cuffs.
  for(const side of [-1,1]){
    const arm=bone(side===1?"upperarm_l":"upperarm_r"),start=pos.length/3;
    for(let row=0;row<3;row++)for(let i=0;i<segments;i++){const angle=i/segments*Math.PI*2;const x=[.205,.29,.405][row]!,radius=[.092,.086,.076][row]!;vertex(side*x,1.435+Math.cos(angle)*radius,Math.sin(angle)*radius,spine3,arm,row===0?.35:row===1?.85:1);}
    for(let row=0;row<2;row++)for(let i=0;i<segments;i++){const next=(i+1)%segments,a=start+row*segments+i,b=start+row*segments+next,c=a+segments,d=b+segments;if(side===1)triangles.push(a,b,c,b,d,c);else triangles.push(a,c,b,b,c,d);}
  }
  const geometry=new T.BufferGeometry();geometry.setAttribute("position",new T.Float32BufferAttribute(pos,3));geometry.setAttribute("skinIndex",new T.Uint16BufferAttribute(skin,4));geometry.setAttribute("skinWeight",new T.Float32BufferAttribute(weights,4));geometry.setIndex(triangles);geometry.computeVertexNormals();return geometry;
}
