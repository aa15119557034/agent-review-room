import * as T from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { WorldSnapshot } from "@room/schemas";

// Coordinates belong only to this presentation. The persisted world owns places,
// objects and activities; these anchors never participate in a rules decision.
export interface RoomAnchor { id: string; x: number; z: number; width: number; depth: number; bedroom: boolean }
export function roomLayout(world: Pick<WorldSnapshot,"places">): RoomAnchor[] {
  const bedrooms = world.places.filter(p => p.owner !== null);
  const width = Math.max(16, bedrooms.length * 3.8);
  return [
    ...world.places.filter(p => p.owner === null).map((p,i) => ({ id:p.id,x:i === 0 ? -width/4 : width/4,z:2.8,width:width/2,depth:6.6,bedroom:false })),
    ...bedrooms.map((p,i)=>({id:p.id,x:-width/2+(i+.5)*width/bedrooms.length,z:-3.4,width:width/bedrooms.length,depth:5.6,bedroom:true})),
  ];
}

const material = (color: T.ColorRepresentation, roughness = .8) => new T.MeshStandardMaterial({color,roughness});
const palette = { wood:material("#b58456"), pale:material("#efe3ca"), cream:material("#f5eedf"), green:material("#406e56"), dark:material("#3c4847"), metal:material("#adab9f",.35), teal:material("#609b99"), clay:material("#b8765a"), leaf:material("#548558") };
function box(parent:T.Object3D, size:number[], pos:number[], mat:T.Material, radius=0) {
  const mesh=new T.Mesh(radius ? new RoundedBoxGeometry(size[0]!,size[1]!,size[2]!,2,radius) : new T.BoxGeometry(size[0],size[1],size[2]), mat);
  mesh.position.set(pos[0]!,pos[1]!,pos[2]!); mesh.castShadow=true;mesh.receiveShadow=true;parent.add(mesh);return mesh;
}
function cylinder(parent:T.Object3D,r:number,h:number,x:number,y:number,z:number,mat:T.Material,r2=r){
  const m=new T.Mesh(new T.CylinderGeometry(r,r2,h,20),mat);m.position.set(x,y,z);m.castShadow=true;m.receiveShadow=true;parent.add(m);return m;
}
function sphere(parent:T.Object3D,r:number,x:number,y:number,z:number,mat:T.Material,scale?:number[]) {
  const m=new T.Mesh(new T.SphereGeometry(r,12,10),mat);m.position.set(x,y,z);if(scale)m.scale.set(scale[0]!,scale[1]!,scale[2]!);m.castShadow=true;parent.add(m);return m;
}
function plant(parent:T.Object3D,x:number,z:number,s=1){
  const g=new T.Group();g.position.set(x,0,z);g.scale.setScalar(s);parent.add(g);
  cylinder(g,.22,.42,0,.21,0,palette.clay,.16);cylinder(g,.2,.055,0,.43,0,palette.dark);
  for(let i=0;i<7;i++){const a=i*2.4;const leaf=sphere(g,.2,Math.sin(a)*.17,.72+i*.055,Math.cos(a)*.17,palette.leaf,[.65,1.8,.8]);leaf.rotation.z=Math.sin(a)*.6;}
}
function rug(parent:T.Object3D,x:number,z:number,w:number,d:number,color:string){
  box(parent,[w,.025,d],[x,.025,z],material(color),.015);
  for(let i=-1;i<=1;i+=2)box(parent,[w-.15,.005,.035],[x,.04,z+i*(d/2-.12)],material("#e1d5bc"));
}
function legs(parent:T.Object3D,w:number,d:number,h:number,mat=palette.wood){for(const x of [-1,1])for(const z of [-1,1])box(parent,[.08,h,.08],[x*(w/2-.13),h/2,z*(d/2-.13)],mat);}
function table(parent:T.Object3D,x:number,z:number,w:number,d:number,h=.8){const g=new T.Group();g.position.set(x,0,z);parent.add(g);legs(g,w,d,h);box(g,[w,.1,d],[0,h,0],palette.wood,.04);return g;}
function chair(parent:T.Object3D,x:number,z:number,rotation=0){const g=new T.Group();g.position.set(x,0,z);g.rotation.y=rotation;parent.add(g);legs(g,.55,.55,.46);box(g,[.57,.12,.57],[0,.5,0],palette.teal,.04);box(g,[.57,.65,.09],[0,.82,-.24],palette.teal,.04);return g;}
function picture(parent:T.Object3D,x:number,y:number,z:number,color:string){box(parent,[.85,.65,.055],[x,y,z],palette.wood);box(parent,[.74,.54,.06],[x,y,z+.01],palette.cream);sphere(parent,.17,x+.12,y+.05,z+.055,material(color),[1,1,.1]);box(parent,[.6,.12,.01],[x-.03,y-.16,z+.06],palette.green);}
function lamp(parent:T.Object3D,x:number,z:number){cylinder(parent,.3,.045,x,.03,z,palette.dark);cylinder(parent,.025,1.55,x,.8,z,palette.dark);const shade=new T.Mesh(new T.ConeGeometry(.36,.48,24,1,true),material("#f2dca8"));shade.position.set(x,1.6,z);parent.add(shade);sphere(parent,.085,x,1.44,z,new T.MeshBasicMaterial({color:"#ffe6b5"}));}

function bedroom(parent:T.Object3D,room:RoomAnchor,index:number){
  const g=new T.Group();g.position.set(room.x,0,room.z);parent.add(g);
  const tone=["#92aaa3","#c7a090","#97a7be","#b8a4bf"][index%4]!;
  rug(g,0,.2,room.width-.5,4.2,"#e7d5b8");
  // Bed frame, upholstered headboard, mattress, folded duvet and pillows.
  box(g,[1.55,.35,2.45],[-.55,.28,-.65],palette.wood,.08);
  box(g,[1.6,1.15,.14],[-.55,.7,-1.85],material(tone),.05);
  box(g,[1.45,.27,2.25],[-.55,.58,-.65],palette.cream,.1);
  box(g,[1.49,.2,1.48],[-.55,.77,-.27],material(tone),.08);
  box(g,[1.5,.07,.32],[-.55,.9,-.96],material("#cbd6c5"),.025);
  box(g,[1.1,.2,.48],[-.55,.82,-1.4],palette.cream,.08);
  table(g,1,-1.4,.55,.55,.55);cylinder(g,.12,.18,1,.76,-1.4,palette.cream);
  box(g,[1.15,1.95,.55],[room.width/2-.7,.98,-1.7],palette.pale,.025);
  box(g,[.025,1.65,.025],[room.width/2-.7,1.06,-1.41],palette.wood);
  cylinder(g,.022,.1,room.width/2-.62,1.05,-1.39,palette.dark);
  table(g,room.width/2-.8,1.5,1.25,.65);chair(g,room.width/2-.8,.7);
  box(g,[.45,.03,.34],[room.width/2-.7,.87,1.45],material(tone));
  plant(g,-room.width/2+.4,1.8,.7);
  picture(g,-.55,1.9,-2.78,tone);
}
function living(parent:T.Object3D,room:RoomAnchor){
  const g=new T.Group();g.position.set(room.x,0,room.z);parent.add(g);
  rug(g,-.5,.15,4.6,3.7,"#d9c8ac");
  // A fabric sofa with separate cushions, low feet and a throw.
  const sofa=new T.Group();sofa.position.set(-1.2,0,-1.5);g.add(sofa);
  for(const x of [-1.3,1.3])for(const z of [-.4,.4])cylinder(sofa,.065,.2,x,.1,z,palette.wood);
  box(sofa,[3,.38,1.05],[0,.42,0],palette.teal,.1);
  box(sofa,[3,1,.2],[0,.9,-.48],palette.teal,.08);
  for(const x of [-1.46,1.46])box(sofa,[.22,.7,1.12],[x,.68,0],palette.teal,.08);
  for(let i=-1;i<=1;i++)box(sofa,[.86,.2,.86],[i*.9,.69,.02],material("#85b0a5"),.07);
  box(sofa,[.45,.5,.17],[-.98,.98,-.25],material("#e4bb75"),.06).rotation.z=.15;
  box(sofa,[.6,.04,1.08],[.83,.83,.02],material("#eee3c7"),.025);
  const coffee=table(g,-1.2,.35,2,1.1,.38);cylinder(coffee,.085,.13,.38,.5,.12,palette.cream);
  const shelfX=-room.width/2+.55;
  box(g,[.62,1.95,2],[shelfX,1,-1],palette.wood);
  for(const y of [.24,.8,1.35,1.9])box(g,[.7,.08,2.04],[shelfX,y,-1],palette.pale);
  for(let row=0;row<3;row++)for(let i=0;i<8;i++)box(g,[.38,.33+(i%3)*.05,.12],[shelfX+.18,.48+row*.55,-1.8+i*.22],material(["#bd7059","#5d8381","#d1b165","#758b5a"][i%4]!));
  lamp(g,-2.95,-1.4);plant(g,-2.95,2,1.2);
  const dining=table(g,2.05,1,1.8,1.45);for(const [x,z,a] of [[1.45,-.1,0],[2.6,-.1,0],[1.45,2.15,Math.PI],[2.6,2.15,Math.PI]])chair(g,x!,z!,a);
  cylinder(dining,.22,.08,0,.9,0,palette.clay);sphere(dining,.1,0,1.04,0,material("#d9ae55"));
}
function kitchen(parent:T.Object3D,room:RoomAnchor){
  const g=new T.Group();g.position.set(room.x,0,room.z);g.rotation.y=-Math.PI/2;parent.add(g);
  const back=-2.65;
  for(let i=0;i<4;i++){
    const x=-2.7+i*1.15;box(g,[1.1,.88,.8],[x,.46,back],palette.green,.025);box(g,[1.17,.085,.87],[x,.94,back],palette.pale,.02);box(g,[.8,.025,.025],[x,.8,back+.42],palette.metal);
  }
  // Range / pot and sink clearly distinguish cooking from the dining area.
  box(g,[.9,.06,.65],[-1.55,1.01,back],palette.dark,.015);
  for(const x of [-1.78,-1.32])for(const z of [back-.18,back+.18])cylinder(g,.12,.02,x,1.05,z,palette.metal);
  box(g,[.65,.04,.48],[.75,1.01,back],palette.metal,.05);box(g,[.48,.03,.33],[.75,1.04,back],palette.dark,.03);
  const faucet=new T.Mesh(new T.TorusGeometry(.15,.025,8,16,Math.PI),palette.metal);faucet.position.set(.75,1.22,back-.15);g.add(faucet);
  box(g,[1,2.05,.9],[2.9,1.03,back],palette.cream,.06);box(g,[.035,.7,.05],[2.55,1.45,back+.49],palette.dark);
  for(const x of [-2.7,-1.5,.9]){box(g,[1.05,.65,.35],[x,2.1,back-.22],palette.pale,.025);box(g,[.6,.02,.03],[x,1.9,back-.01],palette.metal);}
  box(g,[1.3,.2,.55],[-1.55,1.91,back-.15],palette.metal);
  const island=table(g,0,.05,3,1.25,.9);box(island,[2.75,.75,1.05],[0,.4,0],palette.cream,.02);
  for(let i=0;i<3;i++)cylinder(g,.28,.06,-.75+i*.75,1.01,.05,palette.cream);
  chair(g,-.7,1.25,Math.PI);chair(g,.7,1.25,Math.PI);
  plant(g,3,2,.9);
}

export function buildHouse(world:WorldSnapshot) {
  const group=new T.Group();const rooms=roomLayout(world);const width=Math.max(...rooms.map(r=>r.x+r.width/2))*2;
  const picks:T.Object3D[]=[];
  box(group,[width+1,.35,13.2],[0,-.3,.2],material("#777d68"),.1);
  // Visible plank joints give the model scale without image texture downloads.
  for(const r of rooms){
    const floor=box(group,[r.width-.025,.14,r.depth-.025],[r.x,-.07,r.z],material(r.id==="kitchen"?"#d8d4bf":r.bedroom?"#c4a47e":"#b99a72"));floor.userData.placeId=r.id;picks.push(floor);
    if(r.id!=="kitchen")for(let z=-r.depth/2+.15;z<r.depth/2;z+=.35)box(group,[r.width-.05,.003,.012],[r.x,.005,r.z+z],material("#a68966"));
    else for(let x=-r.width/2;x<r.width/2;x+=.65)for(let z=-r.depth/2;z<r.depth/2;z+=.65){box(group,[.008,.004,.63],[r.x+x,.006,r.z+z+.32],palette.cream);box(group,[.63,.004,.008],[r.x+x+.32,.006,r.z+z],palette.cream);}
  }
  // Back wall with actual window openings and glazing.
  const wall=material("#e4decb");box(group,[width,.65,.18],[0,.325,-6.25],wall);box(group,[width,.55,.18],[0,2.55,-6.25],wall);
  for(let x=-width/2;x<=width/2;x+=2){box(group,[.35,1.6,.18],[x,1.45,-6.25],wall);}
  const glass=new T.MeshStandardMaterial({color:"#a9d3d4",transparent:true,opacity:.4,roughness:.2});
  for(let x=-width/2+1;x<width/2;x+=2){box(group,[1.65,1.55,.055],[x,1.45,-6.25],glass);for(const dx of [-.84,0,.84])box(group,[.055,1.65,.1],[x+dx,1.45,-6.14],palette.cream);box(group,[1.8,.07,.12],[x,1.45,-6.12],palette.cream);box(group,[1.85,.1,.36],[x,.65,-6.05],palette.wood);}
  for(const r of rooms.filter(r=>r.bedroom)){
    if(r.x-r.width/2> -width/2+.1)box(group,[.14,.85,5.6],[r.x-r.width/2,.425,r.z],wall);
    // Low dollhouse cut walls keep the rooms readable, doorway is left open.
    for(const sign of [-1,1])box(group,[(r.width-1.05)/2,.62,.14],[r.x+sign*(r.width+1.05)/4,.31,-.61],wall);
    for(const sign of [-1,1])box(group,[.08,1.5,.2],[r.x+sign*.56,.75,-.61],palette.wood);
    box(group,[1.2,.08,.2],[r.x,1.5,-.61],palette.wood);const door=new T.Group();door.position.set(r.x-.52,0,-.61);door.rotation.y=-Math.PI/2;group.add(door);box(door,[1,1.4,.065],[.5,.73,0],palette.pale,.02);sphere(door,.035,.87,.75,.055,palette.metal);
  }
  for(const sign of [-1,1]){box(group,[.18,.8,12.4],[sign*width/2,.4,0],wall);box(group,[.2,.06,12.4],[sign*width/2,.83,0],palette.wood);}
  box(group,[width,.25,.18],[0,.125,6.12],wall);
  let bedroomIndex=0;for(const r of rooms)if(r.bedroom)bedroom(group,r,bedroomIndex++);else if(r.id==="kitchen")kitchen(group,r);else living(group,r);
  // Surrounding garden, porch and step establish a little home, not a UI grid.
  box(group,[width+5,.15,18.5],[0,-.6,.2],material("#9ba985"),.12);
  box(group,[5,.14,1.1],[0,-.27,6.8],palette.wood,.04);box(group,[3,.12,.7],[0,-.43,7.55],palette.pale,.03);
  for(let i=0;i<6;i++){plant(group,-width/2-1.25, -5+i*2,1.1);plant(group,width/2+1.25,-5+i*2,.9);}
  for(let i=0;i<5;i++)box(group,[1,.08,.65],[0,-.49,8.1+i*.8],palette.pale,.06);
  mergeStaticHouse(group,picks);
  return {group,rooms,picks};
}

/** Bake static furniture transforms once and batch identical materials. Floors
 * remain separate raycast targets carrying the authoritative place IDs. */
function mergeStaticHouse(group:T.Group,picks:T.Object3D[]){
  group.updateMatrixWorld(true);const keep=new Set(picks);const batches=new Map<string,{material:T.Material;geometry:T.BufferGeometry[]}>();
  group.traverse(object=>{if(!(object instanceof T.Mesh)||keep.has(object))return;const mat=object.material;if(Array.isArray(mat))throw new Error("House meshes must use one material");const m=mat as T.MeshStandardMaterial;
    const key=JSON.stringify([mat.type,m.color.getHex(),m.roughness,m.metalness,mat.transparent,mat.opacity,mat.side]);const batch=batches.get(key)??{material:mat,geometry:[] as T.BufferGeometry[]};
    const geometry=object.geometry.index?object.geometry.toNonIndexed():object.geometry.clone();geometry.applyMatrix4(object.matrixWorld);batch.geometry.push(geometry);batches.set(key,batch);object.geometry.dispose();
  });
  group.clear();for(const floor of picks)group.add(floor);
  for(const {material,geometry}of batches.values()){const merged=mergeGeometries(geometry,false);if(!merged)throw new Error("Static house geometry could not be merged");geometry.forEach(g=>g.dispose());const mesh=new T.Mesh(merged,material);mesh.castShadow=true;mesh.receiveShadow=true;group.add(mesh);}
}

export function activityAnchor(room:RoomAnchor,kind:string|undefined,index:number):T.Vector3 {
  if(room.bedroom){if(kind==="sleep")return new T.Vector3(room.x-.55,.76,room.z+.5);if((kind==="rest"||kind==="read")&&index===0)return new T.Vector3(room.x+room.width/2-.8,0,room.z+.7);return new T.Vector3(room.x-.6+(index%3)*.6,0,room.z+1+Math.floor(index/3)*.5);}
  if(room.id==="kitchen"){if(kind==="cook")return new T.Vector3(room.x+1.7,0,room.z-1.55+index*.6);if(kind==="eat"&&index<4)return new T.Vector3(room.x+(index<2?-1.25:1.25),0,room.z-.7+(index%2)*1.4);const column=Math.floor(index/4);return new T.Vector3(room.x+(column===0?1.7:column===1?-2.7:-3.5),0,room.z-1.4+(index%4)*.95);}
  if(!room.bedroom&&room.id!=="kitchen"){
    if(kind==="rest"||kind==="read"){if(index<3)return new T.Vector3(room.x-2.05+index*.85,.2,room.z-1.3);if(index<7)return new T.Vector3(room.x+1.45+((index-3)%2)*1.15,0,room.z+(index<5?-.1:2.15));return new T.Vector3(room.x+.7,0,room.z+2.3+(index-7)*.6);}
    if(kind==="eat"||kind==="set_table")return new T.Vector3(room.x+1.45+(index%2)*1.15,0,room.z+(Math.floor(index/2)===0?-.1:2.15+(Math.floor(index/2)-1)*.6));
  }
  return new T.Vector3(room.x-.6+(index%3)*.6,0,room.z+2+Math.floor(index/3)*.5);
}

/** Resolve mixed-activity presentation collisions without changing a place ID. */
export function separateAnchor(target:T.Vector3,occupied:readonly T.Vector3[],room:RoomAnchor):T.Vector3{
  const clear=(p:T.Vector3)=>occupied.every(other=>Math.hypot(p.x-other.x,p.z-other.z)>=.46);
  if(clear(target))return target;
  for(let ring=1;ring<=5;ring++)for(let i=0;i<12;i++){const p=target.clone().add(new T.Vector3(Math.cos(i*Math.PI/6)*ring*.55,0,Math.sin(i*Math.PI/6)*ring*.55));if(Math.abs(p.x-room.x)<room.width/2-.25&&Math.abs(p.z-room.z)<room.depth/2-.25&&clear(p))return p;}
  throw new Error("No visual slot remains in room "+room.id);
}
