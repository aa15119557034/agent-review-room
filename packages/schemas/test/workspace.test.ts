import { test } from "node:test";
import assert from "node:assert/strict";
import { COMMANDS, QUERIES, WorkspaceDiagnostics, WorkspaceSearchRequest } from "../src/index";
test("workspace search bounds page size and rejects blank or unexpected input",()=>{
 assert.equal(WorkspaceSearchRequest.parse({type:"workspace.search",term:"  资料  "}).term,"资料");
 for(const extra of [{term:" "},{limit:51},{path:"C:/private"}])assert.equal(WorkspaceSearchRequest.safeParse({type:"workspace.search",term:"资料",...extra}).success,false);
});
test("workspace maintenance never accepts renderer supplied filesystem paths",()=>{
 for(const name of ["workspace.backup","workspace.restore","workspace.openRestored","workspace.useDefaultData","workspace.diagnostics.export"] as const){
  assert.equal(COMMANDS[name].request.safeParse({type:name}).success,true);
  assert.equal(COMMANDS[name].request.safeParse({type:name,path:"C:/private"}).success,false);
 }
 assert.equal(QUERIES["workspace.item"].request.safeParse({type:"workspace.item",kind:"chat",id:"example",preview:"accidental extra"}).success,false);
});
test("diagnostic boundary rejects raw fields instead of forwarding sensitive data",()=>{
 const value={format:"agent-room-diagnostics-v1",createdAt:"2026-11-04T00:00:00.000Z",version:"1",revision:"test",databaseVersion:25,checks:[],tasks:[]};
 assert.equal(WorkspaceDiagnostics.safeParse(value).success,true);
 assert.equal(WorkspaceDiagnostics.safeParse({...value,prompt:"secret"}).success,false);
 assert.equal(WorkspaceDiagnostics.safeParse({...value,checks:[{id:"node-1",state:"unknown",detail:"secret"}]}).success,false);
});
