import { test } from "node:test";
import assert from "node:assert/strict";
import { QUERIES } from "@room/schemas";
import type { RoomClient } from "../lib/client";
import { createWorkspaceActions } from "../lib/workspace-actions";
import { comparePlanLines } from "../lib/plan-diff";
test("opening a search result sends only the strict item key",async()=>{
 let sent:unknown;const errors:unknown[]=[];
 const client={query:async(q:unknown)=>{sent=q;return QUERIES["workspace.item"].request.parse(q);}} as unknown as RoomClient;
 const hit={kind:"chat" as const,id:"test",title:"extra",preview:"extra"};
 await createWorkspaceActions(client,e=>errors.push(e)).item(hit);
 assert.deepEqual(sent,{type:"workspace.item",kind:"chat",id:"test"});assert.equal(errors.length,0);
});
test("answer context compares the preceding recorded attempt",async()=>{
 const runs=[{id:"r1",slotId:"slot",snapshotId:"s1"},{id:"r2",slotId:"slot",snapshotId:"s2"}];
 const client={query:async(q:{type:string;snapshotId?:string})=>q.type==="chat.runs.get"?runs[1]:q.type==="chat.slots.runs"?runs:{id:q.snapshotId}} as unknown as RoomClient;
 const result=await createWorkspaceActions(client,e=>{throw e;}).context("r2");
 assert.equal(result?.attempt,2);assert.equal(result?.previous?.run.id,"r1");assert.equal(result?.previous?.snapshot.id,"s1");assert.equal(result?.snapshot.id,"s2");
});
test("line comparison preserves unchanged boundaries and supports whole replacement",()=>{
 const diff=comparePlanLines("header\nold\nfooter","header\nnew\nfooter");
 assert.deepEqual(diff.map(x=>x.kind),["same","removed","added","same"]);
 assert.equal(comparePlanLines("x","x").length,1);
 assert.deepEqual(comparePlanLines("a","b").map(x=>x.kind),["removed","added"]);
});
