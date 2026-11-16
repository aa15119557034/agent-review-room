import assert from "node:assert/strict";
import test from "node:test";
import {Vector3} from "three";
import type {WorldPlace} from "@room/schemas";
import {activityAnchor,roomLayout,separateAnchor} from "../ui/world/house-model";

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
