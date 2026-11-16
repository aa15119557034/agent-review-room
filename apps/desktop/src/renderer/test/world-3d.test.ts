import assert from "node:assert/strict";
import test from "node:test";
import {Vector3} from "three";
import type {WorldPlace} from "@room/schemas";
import {activityAnchor,actorRenderOrder,roomLayout,separateAnchor} from "../ui/world/house-model";
import {createMockBridge} from "../mock/mock-backend";
import {createClient} from "../lib/client";
import {newId} from "../lib/ids";
import {arrangeHouseLabels,type HouseLabel} from "../ui/world/house-labels";

function places(count:number):WorldPlace[]{return [
 {id:"living_room",label:"客厅",owner:null,neighbors:["kitchen",...Array.from({length:Math.min(7,count)},(_,i)=>`room_${i+1}`)]},
 {id:"kitchen",label:"厨房",owner:null,neighbors:["living_room",...(count===8?["room_8"]:[])]},
 ...Array.from({length:count},(_,i)=>({id:`room_${i+1}`,label:`房间${i+1}`,owner:`resident_${i+1}`,neighbors:[i<7?"living_room":"kitchen"]})),
];}

for(const count of [4,8])test(`${count} residents plus player keep distinct visual positions in shared rooms`,()=>{
 const rooms=roomLayout({places:places(count)});
 assert.equal(rooms.filter(r=>r.bedroom).length,count);
 for(const room of rooms.filter(r=>!r.bedroom))for(const kinds of [Array(count+1).fill(undefined),Array(count+1).fill("read"),Array(count+1).fill("rest"),["cook","read","rest","eat",undefined,"read","rest",undefined,undefined]]){
   const occupied:Vector3[]=[];
   for(let slot=0;slot<count+1;slot++)occupied.push(separateAnchor(activityAnchor(room,kinds[slot],slot),occupied,room));
   for(let i=0;i<occupied.length;i++)for(let j=i+1;j<occupied.length;j++)assert.ok(Math.hypot(occupied[i]!.x-occupied[j]!.x,occupied[i]!.z-occupied[j]!.z)>=.46,`${room.id}: ${i} overlaps ${j}`);
 }
});

test("mixed activities cannot reuse the same exact anchor",()=>{
 const room=roomLayout({places:places(4)}).find(r=>r.id==="living_room")!;
 const taken=activityAnchor(room,"rest",0);const adjusted=separateAnchor(taken.clone(),[taken],room);
 assert.ok(Math.hypot(taken.x-adjusted.x,taken.z-adjusted.z)>=.46);
 assert.ok(Math.abs(adjusted.x-room.x)<room.width/2);
 assert.ok(Math.abs(adjusted.z-room.z)<room.depth/2);
});

test("a cook listed after visitors still stands at the stove",async()=>{
 const state=await createClient(createMockBridge({seed:true,world:{autoTick:false}})).query({type:"world.get"});const world=state.world!;const agent=world.residents[1]!.agent;const id=newId("wavt");
 const activities=[{id,kind:"cook" as const,participants:[{kind:"resident" as const,agent}],placeId:"kitchen",itemIds:["pot"],startedAt:world.now,endsAt:world.now+30,state:"running" as const,endReason:null}];
 const residents=world.residents.map(r=>({...r,placeId:"kitchen",activityId:r.agent===agent?id:null}));
 const order=actorRenderOrder({...world,residents,activities,player:{placeId:"kitchen",activityId:null}});
 assert.equal(order[0],agent);const kitchen=roomLayout(world).find(r=>r.id==="kitchen")!;const cook=activityAnchor(kitchen,"cook",order.indexOf(agent));
 assert.ok(Math.abs(cook.z-(kitchen.z-1.55))<.001);assert.ok(Math.abs(cook.x-(kitchen.x+2.65))<1);
});

test("clustered projected nameplates retain selected resident and player without overprinting",()=>{
 const labels:HouseLabel[]=Array.from({length:5},(_,i)=>({key:i===4?"__player":`resident_${i}`,x:220+i*6,y:180+i*4,name:i===4?"江浩":`居民${i}`,activity:"",selected:i===0}));
 const result=arrangeHouseLabels(labels,850,620);
 assert.ok(result.some(l=>l.selected));assert.ok(result.some(l=>l.key==="__player"));assert.ok(result.length<5);
 const chosen=result.find(l=>l.selected)!,player=result.find(l=>l.key==="__player")!;
 assert.ok(Math.abs(chosen.y-player.y)>34||Math.abs(chosen.x-player.x)>75);
 assert.equal(labels[4]!.y,196,"screen avoidance must not mutate source positions");
});

test("separated projected nameplates remain available",()=>{
 const labels:HouseLabel[]=Array.from({length:5},(_,i)=>({key:`resident_${i}`,x:90+i*150,y:180,name:`居民${i}`,activity:"看书",selected:i===2}));
 assert.equal(arrangeHouseLabels(labels,850,620).length,5);
});
