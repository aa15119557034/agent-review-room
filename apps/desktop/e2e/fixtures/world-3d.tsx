import {createRoot} from "react-dom/client";
import {useEffect,useState} from "react";
import {WorldScene,WorldSnapshot} from "@room/schemas";
import type {Scene,WebGLRenderer} from "three";
import {createActions} from "../../src/renderer/lib/actions";
import {createClient} from "../../src/renderer/lib/client";
import {initialState} from "../../src/renderer/lib/state";
import {createStore} from "../../src/renderer/lib/store";
import {worldNames} from "../../src/renderer/lib/world";
import {newId} from "../../src/renderer/lib/ids";
import {createMockBridge} from "../../src/renderer/mock/mock-backend";
import {AppProvider,useAppState} from "../../src/renderer/ui/hooks";
import {House3D} from "../../src/renderer/ui/world/House3D";
import {SceneView} from "../../src/renderer/ui/world/SceneView";
import "../../src/renderer/styles.css";
import "../../src/renderer/ui/world/world.css";
import "../../src/renderer/ui/world/world-3d.css";

// Rendering/interaction fixture only. This is never an application entry point
// and does not substitute for the real service acceptance.
const bridge=createMockBridge({seed:true,world:{autoTick:false}});
const client=createClient(bridge);const store=createStore(initialState);const actions=createActions(store,client);
const params=new URLSearchParams(location.search);const long=params.has("long");
declare global {interface Window {world3dFixture:{renderer:WebGLRenderer|null;scene:Scene|null;ready:boolean;world:WorldSnapshot|null;openLong:()=>void;close:()=>void}}}
window.world3dFixture={renderer:null,scene:null,ready:false,world:null,openLong:()=>{},close:()=>{}};

function Fixture(){
 const world=useAppState(s=>s.world.world);const scene=useAppState(s=>s.world.scene);const names=worldNames(world,id=>({claude:"C酱",codex:"林离",deepseek:"汐",fourth:"小夏"})[id]??id);
 if(!world)return <p>正在准备四人渲染 fixture…</p>;
 window.world3dFixture.world=world;
 return <main className="world" style={{position:"fixed",inset:0,display:"block"}}><div className="world-stage" style={{height:"100%"}}><House3D world={world} names={names} inspectRenderer={(r,scene)=>{window.world3dFixture.renderer=r;window.world3dFixture.scene=scene;}}/>{scene&&<SceneView scene={scene} world={world} names={names}/>}</div></main>;
}
(async()=>{
 await client.command({type:"agent.update",id:"fourth",displayName:"小夏",color:"#a38bae"});
 await actions.start();await actions.world.load();await actions.world.start(["claude","codex","deepseek","fourth"]);await actions.world.load();
 const world=store.get().world.world!;
 if(world.residents.length!==4)throw new Error("Fixture must have four residents");
 // Fixed display activities allow reproducible poses without altering the rule engine.
 const residents=world.residents.map((r,i)=>({...r,placeId:i===0?"kitchen":i===1?"living_room":world.places.find(p=>p.owner===r.agent)!.id,activityId:newId("wavt")}));
 const kinds=["cook","read","sleep","rest"] as const;
 const activities=residents.map((r,i)=>({id:r.activityId!,kind:kinds[i]!,participants:[{kind:"resident" as const,agent:r.agent}],placeId:r.placeId,startedAt:world.now,endsAt:world.now+120,state:"running" as const,endReason:null,itemIds:i===0?["pot"]:i===1?["book"]:[]}));
 const items=world.items.map(item=>item.kind==="unique"&&item.id==="book"?{...item,usedBy:activities[1]!.id}:item.kind==="unique"&&item.id==="pot"?{...item,usedBy:activities[0]!.id}:item);
 const snapshot=WorldSnapshot.parse({...world,residents,activities,items});
 store.set(s=>({...s,world:{...s.world,world:snapshot}}));
 const openLong=()=>{const scene=WorldScene.parse({id:newId("wscn"),generation:world.generation,origin:{kind:"player",agent:"claude"},placeId:"kitchen",residents:["claude"],openedAt:world.now,createdAt:new Date().toISOString(),state:"open",canType:true,options:[{id:"opt_fixture",label:"继续聊一会儿",act:null}],past:[],lines:[{speaker:{kind:"resident",agent:"claude"},text:"闲".repeat(120),source:"chat",expression:"happy",seq:null},{speaker:{kind:"resident",agent:"claude"},text:"事实".repeat(248)+"。",source:"model",expression:"neutral",seq:null},{speaker:null,text:"这个动作没有通过规则检查，台词保留在上面。",source:"rule",expression:"neutral",seq:null}]});store.set(s=>({...s,world:{...s.world,scene}}));};
 window.world3dFixture.openLong=openLong;window.world3dFixture.close=()=>store.set(s=>({...s,world:{...s.world,scene:null}}));if(long)openLong();
 createRoot(document.getElementById("root")!).render(<AppProvider store={store} actions={actions} isMock><Fixture/></AppProvider>);window.world3dFixture.ready=true;
})();
