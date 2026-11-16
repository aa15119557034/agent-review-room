import { useEffect, useRef, useState } from "react";
import * as T from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { clone } from "three/addons/utils/SkeletonUtils.js";
import type { WorldSnapshot } from "@room/schemas";
import { agentColor } from "../../lib/discussion";
import { ACTIVITY_LABEL, residentLine, type WorldNames } from "../../lib/world";
import { useActions, useAppState } from "../hooks";
import { activityAnchor, actorRenderOrder, buildHouse, separateAnchor } from "./house-model";
import characterUrl from "../../assets/world/character.glb?url";
import playerUrl from "../../assets/world/player.glb?url";

interface Avatar {
  root:T.Group; body:T.Object3D; target:T.Vector3; route:T.Vector3[]; placeId:string;
  kind:string|undefined; bones:Map<string,{bone:T.Bone;original:T.Quaternion;modelRotation:T.Quaternion;direction:T.Vector3}>;
  marker:T.Mesh; agent:string|null; index:number; slot:number;
}
interface Label { key:string; x:number; y:number; name:string; activity:string; selected:boolean }
const v=new T.Vector3();

/** One WebGL scene, reading committed snapshots. Animation has no IPC side effects. */
export function House3D({world,names,inspectRenderer}:{world:WorldSnapshot;names:WorldNames;inspectRenderer?:(renderer:T.WebGLRenderer,scene:T.Scene)=>void}) {
  const host=useRef<HTMLDivElement>(null);
  const disc=useAppState(s=>s.disc);const selected=useAppState(s=>s.world.selected);
  const dialogue=useAppState(s=>s.world.scene);const actions=useActions();
  const current=useRef({world,names,disc,selected,dialogue,actions});
  current.current={world,names,disc,selected,dialogue,actions};
  const [labels,setLabels]=useState<Label[]>([]);const [error,setError]=useState<string|null>(null);const [loading,setLoading]=useState(true);
  const [focus,setFocus]=useState(0);
  const controlsRef=useRef<{reset:()=>void;zoom:(n:number)=>void}|null>(null);
  useEffect(()=>{
    const element=host.current;if(!element)return;
    setLoading(true);setError(null);setLabels([]);
    let renderer:T.WebGLRenderer;
    try{renderer=new T.WebGLRenderer({antialias:true,alpha:false,powerPreference:"high-performance"});}
    catch(e){setError(`3D 画面无法启动：${e instanceof Error?e.message:String(e)}`);setLoading(false);return;}
    renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));renderer.shadowMap.enabled=true;renderer.shadowMap.type=T.PCFShadowMap;
    renderer.outputColorSpace=T.SRGBColorSpace;renderer.toneMapping=T.ACESFilmicToneMapping;renderer.toneMappingExposure=1.22;
    renderer.domElement.setAttribute("aria-label","可旋转缩放的小屋3D画面。拖动旋转，滚轮缩放，点房间走过去，点人物查看。");
    element.prepend(renderer.domElement);
    const scene=new T.Scene();scene.background=new T.Color("#e4e8df");scene.fog=new T.Fog("#e4e8df",45,80);
    inspectRenderer?.(renderer,scene);
    scene.add(new T.HemisphereLight("#e7f4ff","#ada184",2.1));
    const sun=new T.DirectionalLight("#fff0cf",3.2);sun.position.set(-8,16,8);sun.castShadow=true;
    sun.shadow.mapSize.set(2048,2048);sun.shadow.camera.left=-18;sun.shadow.camera.right=18;sun.shadow.camera.top=18;sun.shadow.camera.bottom=-18;
    sun.shadow.normalBias=.025;sun.shadow.bias=-.0001;scene.add(sun);
    const fill=new T.DirectionalLight("#d8e6ed",1.2);fill.position.set(10,8,-6);scene.add(fill);
    const house=buildHouse(current.current.world);scene.add(house.group);
    const overviewScale=Math.max(1,current.current.world.residents.length*3.8/16);
    const camera=new T.PerspectiveCamera(36,1,.1,100*overviewScale);camera.position.set(17*overviewScale,18*overviewScale,23*overviewScale);
    const controls=new OrbitControls(camera,renderer.domElement);controls.target.set(0,.3,0);controls.enableDamping=true;controls.dampingFactor=.09;
    controls.maxPolarAngle=Math.PI*.46;controls.minPolarAngle=.12;controls.minDistance=2.5;controls.maxDistance=43*overviewScale;controls.enablePan=true;
    const homePosition=camera.position.clone();const homeTarget=new T.Vector3(0,.3,0);scene.fog=new T.Fog("#e4e8df",45*overviewScale,80*overviewScale);
    const reset=()=>{camera.position.copy(homePosition);controls.target.copy(homeTarget);controls.update();};
    controlsRef.current={reset,zoom:n=>{camera.position.sub(controls.target).multiplyScalar(n).add(controls.target);controls.update();}};
    const roomMap=new Map(house.rooms.map(r=>[r.id,r]));
    const novel=new T.Group();novel.name="world-item-book";const cover=new T.Mesh(new T.BoxGeometry(.34,.055,.25),new T.MeshStandardMaterial({color:"#bf6548"}));novel.add(cover);const pages=new T.Mesh(new T.BoxGeometry(.3,.028,.22),new T.MeshStandardMaterial({color:"#fff1d3"}));pages.position.y=.04;novel.add(pages);const band=new T.Mesh(new T.BoxGeometry(.04,.06,.25),new T.MeshStandardMaterial({color:"#ddb971"}));band.position.x=-.1;novel.add(band);scene.add(novel);
    const pot=new T.Group();const pan=new T.Mesh(new T.CylinderGeometry(.23,.2,.28,20),new T.MeshStandardMaterial({color:"#b8765a"}));pot.add(pan);const lid=new T.Mesh(new T.CylinderGeometry(.26,.26,.035,20),new T.MeshStandardMaterial({color:"#3c4847"}));lid.position.y=.15;pot.add(lid);scene.add(pot);
    const avatars=new Map<string,Avatar>();const templates:T.Object3D[]=[];const avatarRoots:T.Group[]=[];let assetFailed=false;let cancelled=false;let frame=0;let last=performance.now();let elapsed=0;let lastLabels=0;
    let lastSnapshot:WorldSnapshot|null=null;let lastDialogue:string|null=null;let cameraGoal:{position:T.Vector3;target:T.Vector3}|null=null;
    const ray=new T.Raycaster();const pointer=new T.Vector2();let down={x:0,y:0};
    const onDown=(e:PointerEvent)=>{down={x:e.clientX,y:e.clientY};};
    const onClick=(e:MouseEvent)=>{
      if(Math.hypot(e.clientX-down.x,e.clientY-down.y)>5||current.current.dialogue)return;
      const rect=renderer.domElement.getBoundingClientRect();pointer.set((e.clientX-rect.left)/rect.width*2-1,-(e.clientY-rect.top)/rect.height*2+1);
      ray.setFromCamera(pointer,camera);
      const hits=ray.intersectObjects([...avatars.values()].map(a=>a.root).concat(house.picks as T.Group[]),true);
      for(const hit of hits){let object:T.Object3D|null=hit.object;
        while(object){if(object.userData.agent){current.current.actions.world.select(object.userData.agent as string);return;}if(object.userData.placeId){void current.current.actions.world.goTo(object.userData.placeId as string);return;}object=object.parent;}
      }
    };
    renderer.domElement.addEventListener("pointerdown",onDown);renderer.domElement.addEventListener("click",onClick);
    const onStart=()=>{cameraGoal=null;};controls.addEventListener("start",onStart);
    const resize=new ResizeObserver(()=>{const w=element.clientWidth,h=element.clientHeight;if(w&&h){renderer.setSize(w,h);camera.aspect=w/h;camera.updateProjectionMatrix();}});resize.observe(element);
    const loader=new GLTFLoader();
    const loadOwned=async(url:string)=>{const gltf=await loader.loadAsync(url);if(cancelled||assetFailed){dispose([gltf.scene]);throw new Error("3D asset owner has closed");}templates.push(gltf.scene);return gltf;};
    Promise.all([loadOwned(characterUrl),loadOwned(playerUrl)]).then(([gltf,playerGltf])=>{
      if(cancelled)return;
      const people=[...current.current.world.residents.map((r,index)=>({id:r.agent,agent:r.agent,index})),{id:"__player",agent:null,index:current.current.world.residents.length}];
      for(const person of people){
        const root=new T.Group();root.userData.agent=person.agent;scene.add(root);avatarRoots.push(root);
        const body=clone(person.agent?gltf.scene:playerGltf.scene);addClothing(body,person.agent?agentColor(current.current.disc,person.agent):"#879aa5");const bounds=new T.Box3().setFromObject(body);const height=bounds.max.y-bounds.min.y;body.scale.setScalar(1.62/height);body.position.y=-bounds.min.y*body.scale.y;root.add(body);
        body.traverse(object=>{if(object instanceof T.Mesh){object.castShadow=true;object.receiveShadow=true;const mats=Array.isArray(object.material)?object.material:[object.material];const copies=mats.map(m=>{const copy=m.clone();if(copy instanceof T.MeshStandardMaterial&&copy.name.includes("Hair"))copy.color.set(["#3d2b23","#342c38","#9c6738","#542b2a"][person.index%4]!);return copy;});object.material=Array.isArray(object.material)?copies:copies[0]!;}});
        body.updateWorldMatrix(true,true);const bodyInverse=body.getWorldQuaternion(new T.Quaternion()).invert();
        const bones:Avatar["bones"]=new Map();body.traverse(object=>{if(object instanceof T.Bone){const child=object.children.find(c=>c instanceof T.Bone);const direction=child?child.getWorldPosition(new T.Vector3()).sub(object.getWorldPosition(new T.Vector3())).applyQuaternion(bodyInverse).normalize():new T.Vector3(0,1,0);bones.set(object.name,{bone:object,original:object.quaternion.clone(),modelRotation:bodyInverse.clone().multiply(object.getWorldQuaternion(new T.Quaternion())),direction});}});
        const color=person.agent?agentColor(current.current.disc,person.agent):"#ecdaaf";
        const marker=new T.Mesh(new T.TorusGeometry(.32,.025,8,40),new T.MeshBasicMaterial({color}));marker.rotation.x=Math.PI/2;marker.position.y=.035;root.add(marker);
        avatars.set(person.id,{root,body,target:new T.Vector3(),route:[],placeId:"",kind:undefined,bones,marker,agent:person.agent,index:person.index,slot:0});
      }
      // Clones share template geometry and decoded images. Keep ownership until
      // the whole scene unmounts; closing a template bitmap here breaks clones.
      lastSnapshot=null;lastDialogue=null;setLoading(false);
    }).catch(e=>{assetFailed=true;for(const root of avatarRoots)scene.remove(root);dispose([...avatarRoots,...templates]);avatars.clear();if(!cancelled){setError(`人物素材没有载入：${e instanceof Error?e.message:"请检查素材文件"}`);setLoading(false);}});

    const updateAvatar=(a:Avatar,placeId:string,kind:string|undefined,slot:number,occupied:T.Vector3[])=>{
      const room=roomMap.get(placeId);if(!room)return;
      const target=separateAnchor(activityAnchor(room,kind,slot),occupied,room);occupied.push(target);a.slot=slot;
      if(a.placeId!==placeId){
        const previous=roomMap.get(a.placeId);
        if(previous){const exitX=previous.id==="kitchen"?previous.x+1.7:previous.bedroom?previous.x:previous.x+.8;const entryX=room.id==="kitchen"?room.x+1.7:room.bedroom?room.x:room.x+.8;const exit=previous.bedroom||previous.id==="kitchen"?[]:[new T.Vector3(a.root.position.x,0,previous.z-.5),new T.Vector3(exitX,0,previous.z-.5)];a.route=[...exit,new T.Vector3(exitX,0,-.05),new T.Vector3(entryX,0,-.05),target.clone()];}
        else a.root.position.copy(target);
      }else if(a.target.distanceTo(target)>.1)a.route=[target.clone()];
      a.placeId=placeId;a.target.copy(target);a.kind=kind;
    };
    const animate=()=>{
      if(cancelled)return;frame=requestAnimationFrame(animate);
      const stamp=performance.now();const dt=Math.min((stamp-last)/1000,.05);last=stamp;const state=current.current;const running=state.world.run.state==="running";
      if(running)elapsed+=dt;
      if(lastSnapshot!==state.world){
        const slots=new Map<string,T.Vector3[]>();for(const id of actorRenderOrder(state.world)){const a=avatars.get(id);const resident=id==="__player"?state.world.player:state.world.residents.find(r=>r.agent===id);if(!a||!resident)continue;const act=state.world.activities.find(act=>act.id===resident.activityId&&act.state==="running");const occupied=slots.get(resident.placeId)??[];updateAvatar(a,resident.placeId,act?.kind,occupied.length,occupied);slots.set(resident.placeId,occupied);}
        lastSnapshot=state.world;
      }
      const activeDialogue=state.dialogue?.id??null;
      if(lastDialogue!==activeDialogue){
        if(activeDialogue){const a=avatars.get(state.dialogue!.residents[0]??"");if(a){const target=a.target.clone().add(new T.Vector3(0,1.1,0));const offset=a.placeId==="kitchen"?new T.Vector3(-2.5,1.1,-1.7):new T.Vector3(1.5,1,3.1);cameraGoal={target,position:target.clone().add(offset)};}}
        else if(lastDialogue)cameraGoal={position:homePosition.clone(),target:homeTarget.clone()};lastDialogue=activeDialogue;
      }
      for(const a of avatars.values()){
        if(!running&&a.route.length){a.root.position.copy(a.target);a.route=[];}
        const moving=a.route.length>0;
        if(running&&moving){const to=a.route[0]!;v.subVectors(to,a.root.position);const distance=v.length();const step=dt*3.4;if(distance<=step){a.root.position.copy(to);a.route.shift();}else{a.root.position.addScaledVector(v.normalize(),step);a.root.rotation.y=Math.atan2(v.x,v.z);}}
        const speaking=!!state.dialogue?.residents.includes(a.agent??"");
        if(!moving&&speaking)a.root.rotation.y=Math.atan2(camera.position.x-a.root.position.x,camera.position.z-a.root.position.z);
        else if(!moving)a.root.rotation.y=a.kind==="cook"?Math.PI/2: a.placeId==="kitchen"&&a.kind==="eat"?Math.PI/2:0;
        pose(a,elapsed,moving&&running,speaking);
        a.marker.visible=a.agent===state.selected||a.agent===null;
      }
      // Exactly one visible prop per unique item. A shared reading activity
      // shows one book; occupancy never creates extra inventory instances.
      for(const [id,prop]of [["book",novel],["pot",pot]] as const){
        const item=state.world.items.find(i=>i.id===id);prop.visible=!!item&&item.kind==="unique";if(!item||item.kind!=="unique")continue;
        let holder:Avatar|undefined;
        if(item.at.kind==="held")holder=avatars.get(item.at.by.kind==="player"?"__player":item.at.by.agent);
        else if(id==="book"&&item.usedBy){const reader=state.world.activities.find(a=>a.id===item.usedBy)?.participants[0];if(reader)holder=avatars.get(reader.kind==="player"?"__player":reader.agent);}
        if(holder){if(prop.parent!==holder.root)holder.root.add(prop);prop.position.set(0,.95,.38);prop.rotation.set(0,0,0);}
        else if(item.at.kind==="place"){if(prop.parent!==scene)scene.add(prop);const room=roomMap.get(item.at.placeId);if(!room){prop.visible=false;continue;}prop.rotation.set(0,0,0);if(id==="pot"&&room.id==="kitchen")prop.position.set(room.x+2.65,1.2,room.z-1.55);else if(room.bedroom)prop.position.set(room.x+room.width/2-.8,.9,room.z+1.5);else if(room.id==="kitchen")prop.position.set(room.x,1.04,room.z);else prop.position.set(room.x-1.65,.48,room.z+.35);}
        else prop.visible=false;
      }
      if(cameraGoal){camera.position.lerp(cameraGoal.position,1-Math.exp(-dt*4));controls.target.lerp(cameraGoal.target,1-Math.exp(-dt*4));if(camera.position.distanceTo(cameraGoal.position)<.015)cameraGoal=null;}
      controls.update();renderer.render(scene,camera);
      if(stamp-lastLabels>80){lastLabels=stamp;const rect=element.getBoundingClientRect();const projected:Label[]=[];
        for(const [key,a]of avatars){v.copy(a.root.position).add(new T.Vector3(0,1.95,0)).project(camera);if(v.z>1||v.x< -1||v.x>1||v.y< -1||v.y>1)continue;projected.push({key,x:(v.x+1)/2*rect.width,y:(1-v.y)/2*rect.height,name:a.agent?state.names.agent(a.agent):"江浩",activity:a.kind?ACTIVITY_LABEL[a.kind as keyof typeof ACTIVITY_LABEL]:"",selected:a.agent===state.selected});}
        setLabels(projected);
      }
    };animate();
    return()=>{cancelled=true;cancelAnimationFrame(frame);resize.disconnect();controls.dispose();controlsRef.current=null;renderer.domElement.removeEventListener("pointerdown",onDown);renderer.domElement.removeEventListener("click",onClick);dispose([scene,...templates]);renderer.dispose();renderer.domElement.remove();};
  },[world.id,world.residents.map(r=>r.agent).join("|"),focus]);
  return <section className="house-3d" aria-label="3D小屋">
    <div className="house-3d-canvas" ref={host}>
      {labels.map(label=><button type="button" key={label.key} className="house-3d-name" data-selected={label.selected||undefined} style={{left:label.x,top:label.y}} onClick={()=>label.key!=="__player"&&actions.world.select(label.key)}><span>{label.name}</span>{label.activity&&<small>{label.activity}</small>}</button>)}
      {loading&&<p className="house-3d-status" role="status">正在打开 3D 小屋…</p>}
      {error&&<div className="house-3d-error" role="alert"><p>{error}</p><button type="button" onClick={()=>{setError(null);setLoading(true);setFocus(n=>n+1);}}>重试</button></div>}
    </div>
    <div className="house-3d-tools"><span>拖动旋转 · 滚轮缩放 · 点房间走动</span><button type="button" aria-label="拉近镜头" onClick={()=>controlsRef.current?.zoom(.85)}>＋</button><button type="button" aria-label="拉远镜头" onClick={()=>controlsRef.current?.zoom(1.18)}>－</button><button type="button" onClick={()=>controlsRef.current?.reset()}>全景</button></div>
    <nav className="house-3d-rooms" aria-label="走到房间">{world.places.map(place=><button type="button" key={place.id} aria-current={world.player.placeId===place.id?"location":undefined} onClick={()=>void actions.world.goTo(place.id)}>{names.place(place.id)}{world.player.placeId===place.id&&<small>你在这里</small>}</button>)}</nav>
    <div className="visually-hidden">{world.residents.map(r=><p key={r.agent}>{names.agent(r.agent)}：{residentLine(r,world,names)}</p>)}</div>
  </section>;
}

function pose(avatar:Avatar,time:number,moving:boolean,speaking:boolean){
  const kind=avatar.kind;const seated=!moving&&avatar.slot<7&&(kind==="read"||kind==="rest"||kind==="eat");const sleep=!moving&&kind==="sleep";
  avatar.body.rotation.x=sleep?-Math.PI/2:0;avatar.body.position.y=sleep?.12:seated?-.4:0;
  for(const {bone,original}of avatar.bones.values())bone.quaternion.copy(original);
  avatar.body.updateWorldMatrix(true,true);const bodyRotation=avatar.body.getWorldQuaternion(new T.Quaternion());
  for(const [name,rig]of avatar.bones){
    const {bone,direction,modelRotation}=rig;const n=name.toLowerCase();const side=n.endsWith("_l")?1:-1;let desired:T.Vector3|undefined;
    const swing=Math.sin(time*8)*.4*side;
    if(n.includes("upperarm"))desired=new T.Vector3(side*.12,-1,moving?swing:kind==="cook"||kind==="read"?.42:kind==="eat"?.3:speaking?.08:0);
    if(n.includes("lowerarm"))desired=new T.Vector3(side*.08,kind==="read"?-.05:kind==="cook"?-.15:-1,moving?-swing:kind==="cook"?.9+Math.sin(time*4)*.15:kind==="read"?.9:kind==="eat"?.6+Math.sin(time*2)*.4:.08);
    if(n.includes("thigh"))desired=new T.Vector3(0,seated?-.1:-1,seated?1:moving?-swing:0);
    if(n.includes("calf"))desired=new T.Vector3(0,-1,moving?Math.max(0,swing):0);
    if(desired){const delta=new T.Quaternion().setFromUnitVectors(direction,desired.normalize());const target=bodyRotation.clone().multiply(delta).multiply(modelRotation);bone.quaternion.copy(bone.parent!.getWorldQuaternion(new T.Quaternion()).invert().multiply(target));bone.updateWorldMatrix(false,true);}
  }
}
/** Fitted skinned shirt and trousers derived from the CC0 body surface. */
function addClothing(body:T.Object3D,color:string){
  const meshes:T.SkinnedMesh[]=[];body.traverse(o=>{if(o instanceof T.SkinnedMesh&&(Array.isArray(o.material)?o.material:[o.material]).some(m=>m.name.includes("Superhero")))meshes.push(o);});
  for(const mesh of meshes){
    const source=mesh.geometry;source.computeBoundingBox();const unit=source.boundingBox!.max.y/1.76664;const positions=source.getAttribute("position");const normals=source.getAttribute("normal");const indices=source.index;
    if(!indices)continue;
    for(const part of ["shirt","trousers"]){
      const selected:number[]=[];
      for(let i=0;i<indices.count;i+=3){const triangle=[indices.getX(i),indices.getX(i+1),indices.getX(i+2)];const include=triangle.every(j=>{const y=positions.getY(j)/unit,x=Math.abs(positions.getX(j)/unit);return part==="shirt"?y>.88&&y<1.49&&x<.39:y<.96;});if(include)selected.push(...triangle);}
      const geometry=source.clone();const p=geometry.getAttribute("position");for(let i=0;i<p.count;i++){let x=p.getX(i)/unit,y=p.getY(i)/unit,z=p.getZ(i)/unit;if(part==="shirt"&&y<1.48&&y>.86&&Math.abs(x)<.32){const angle=Math.atan2(z/.16,x/.25);const blend=T.MathUtils.clamp((1.48-y)/.18,0,1)*T.MathUtils.clamp((.32-Math.abs(x))/.07,0,1);x=T.MathUtils.lerp(x,Math.cos(angle)*.25,blend);z=T.MathUtils.lerp(z,Math.sin(angle)*.175,blend);}x+=normals.getX(i)*.016;z+=normals.getZ(i)*.016;p.setXYZ(i,x*unit,(y+normals.getY(i)*.01)*unit,z*unit);}geometry.setIndex(selected);geometry.clearGroups();geometry.computeVertexNormals();
      const garment=new T.SkinnedMesh(geometry,new T.MeshStandardMaterial({color:part==="shirt"?color:"#37484c",roughness:.95,side:T.DoubleSide}));garment.name=part;garment.bind(mesh.skeleton,mesh.bindMatrix);garment.position.copy(mesh.position);garment.quaternion.copy(mesh.quaternion);garment.scale.copy(mesh.scale);mesh.parent!.add(garment);
    }
    const trim=new T.MeshStandardMaterial({color:new T.Color(color).multiplyScalar(.65),roughness:1});
    const ring=(radius:number,tube:number,position:T.Vector3,boneName:string,rotation:T.Euler,scale:T.Vector3)=>{const geometry=new T.TorusGeometry(radius,tube,6,24);geometry.rotateX(rotation.x);geometry.rotateY(rotation.y);geometry.scale(scale.x,scale.y,scale.z);geometry.translate(position.x,position.y,position.z);const joint=mesh.skeleton.bones.findIndex(b=>b.name===boneName);if(joint<0){geometry.dispose();return;}const count=geometry.getAttribute("position").count;const skin=new Uint16Array(count*4),weights=new Float32Array(count*4);for(let i=0;i<count;i++){skin[i*4]=joint;weights[i*4]=1;}geometry.setAttribute("skinIndex",new T.Uint16BufferAttribute(skin,4));geometry.setAttribute("skinWeight",new T.Float32BufferAttribute(weights,4));const garment=new T.SkinnedMesh(geometry,trim);garment.bind(mesh.skeleton,mesh.bindMatrix);mesh.parent!.add(garment);};
    ring(.105*unit,.017*unit,new T.Vector3(0,1.49*unit,0),"spine_03",new T.Euler(Math.PI/2,0,0),new T.Vector3(1,1,.8));
    ring(.25*unit,.016*unit,new T.Vector3(0,.91*unit,0),"pelvis",new T.Euler(Math.PI/2,0,0),new T.Vector3(1,1,.7));
    for(const side of [-1,1])ring(.075*unit,.014*unit,new T.Vector3(side*.37*unit,1.43*unit,0),side===1?"upperarm_l":"upperarm_r",new T.Euler(0,Math.PI/2,0),new T.Vector3(1,1,1));
  }
}
const closedBitmaps=new WeakSet<ImageBitmap>();
function dispose(roots:T.Object3D[]){const geometries=new Set<T.BufferGeometry>(),materials=new Set<T.Material>(),textures=new Set<T.Texture>();for(const root of roots)root.traverse(o=>{if(o instanceof T.Mesh){geometries.add(o.geometry);for(const m of Array.isArray(o.material)?o.material:[o.material]){materials.add(m);for(const value of Object.values(m))if(value instanceof T.Texture)textures.add(value);}}});geometries.forEach(g=>g.dispose());materials.forEach(m=>m.dispose());textures.forEach(t=>{t.dispose();const data:unknown=t.source.data;for(const image of Array.isArray(data)?data:[data])if(typeof ImageBitmap!=="undefined"&&image instanceof ImageBitmap&&!closedBitmaps.has(image)){image.close();closedBitmaps.add(image);}});}
