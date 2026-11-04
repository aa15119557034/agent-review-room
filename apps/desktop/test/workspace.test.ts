import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync,rmSync,readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { openDatabase, WriteQueue, ulid, searchWorkspace, workspaceItem, saveWorkspaceDecision, workspaceDecisions, workspaceTasks, workspaceSources } from "@room/db";
import { WorkspaceBackupManifest } from "@room/schemas";
import { WorkspaceService, verifyWorkspaceBackup, verifyRestoredDirectory } from "../src/main/workspace";

function fixture(){
  const root=mkdtempSync(join(tmpdir(),"room-workspace-")),data=join(root,"data"),out=join(root,"out");
  mkdirSync(data);mkdirSync(out);for(const d of ["images","files","audio"])mkdirSync(join(data,d));
  const db=openDatabase(join(data,"room.db")),queue=new WriteQueue();
  const project="proj_"+ulid(),conversation="conv_"+ulid(),now="2026-11-04T00:00:00.000Z";
  db.prepare("INSERT INTO projects(id,name,created_at) VALUES(?,?,?)").run(project,"测试议题",now);
  db.prepare("INSERT INTO conversations(id,kind,direct_agent,last_activity_at,created_at) VALUES(?,'direct','codex',?,?)").run(conversation,now,now);
  db.prepare("INSERT INTO conversation_members(conversation_id,agent,ordinal) VALUES(?,'codex',0)").run(conversation);
  const dirs:Array<string|null>=[];
  const service=new WorkspaceService({db,queue,userData:data,version:"0.1.0",revision:"a".repeat(40),checks:async()=>[{id:"node-1",label:"private user label",state:"unknown",detail:"secret-path",checkedAt:now}],chooseDirectory:async()=>dirs.shift()??null,chooseSaveFile:async()=>join(out,"diagnostics.json")});
  const user=(text:string,when=now,attachments:Array<{ref:string}>=[])=>{
    const id="cmsg_"+ulid();db.prepare("INSERT INTO chat_messages(id,conversation_id,sender,created_at,content,mentions,state) VALUES(?,?,'user',?,?,?,'sent')").run(id,conversation,when,JSON.stringify({kind:"text",text,attachments}),JSON.stringify({kind:"none"}));return id;
  };
  const close=()=>{db.close();rmSync(root,{recursive:true,force:true});};
  return {root,data,out,db,queue,project,conversation,now,dirs,service,user,close};
}
test("workspace search excludes retracted messages, is literal and keyset pagination is stable",()=>{
 const f=fixture();try{
  const ids=Array.from({length:8},(_,i)=>f.user("共同关键词 "+i));
  const removed=f.user("共同关键词 RETRACT_SENTINEL");
  f.db.prepare("UPDATE chat_messages SET state='retracted',retracted_at=? WHERE id=?").run(f.now,removed);
  const seen:string[]=[];let before;
  for(;;){const p=searchWorkspace(f.db,{type:"workspace.search",term:"共同关键词",limit:3,...(before?{before}:{})});seen.push(...p.items.map(x=>x.id));if(!p.nextCursor)break;before=p.nextCursor;}
  assert.equal(new Set(seen).size,8);assert.deepEqual(new Set(seen),new Set(ids));assert.throws(()=>workspaceItem(f.db,{kind:"chat",id:removed}),/撤回/);
  assert.equal(searchWorkspace(f.db,{type:"workspace.search",term:"%",limit:30}).items.length,0);
  assert.equal(workspaceTasks(f.db,{type:"workspace.tasks",activeOnly:false}).items.length,0);
 }finally{f.close();}
});
test("workspace search can read old messages in a 10000-message conversation without exposing the whole corpus",()=>{
 const f=fixture();try{
  f.db.transaction(()=>{for(let i=0;i<10000;i++)f.user(i===0?"EARLIEST_UNIQUE":"普通消息 "+i);})();
  const start=performance.now(),page=searchWorkspace(f.db,{type:"workspace.search",term:"EARLIEST_UNIQUE",limit:30});
  assert.equal(page.items.length,1);assert.equal(page.items[0]?.preview,"EARLIEST_UNIQUE");
  console.log("workspace search 10000 messages ms",Math.round(performance.now()-start));
 }finally{f.close();}
});
test("human decisions preserve history, enforce project ownership and reject concurrent stale saves",async()=>{
 const f=fixture();try{
  const source="msg_"+ulid();f.db.prepare("INSERT INTO messages(id,project_id,kind,source_agent,content,created_at) VALUES(?,?,'source_input','human','来源意见',?)").run(source,f.project,f.now);
  const first=await saveWorkspaceDecision(f.db,f.queue,{type:"workspace.decision.save",projectId:f.project,title:"选择方案",state:"pending",reason:"",sourceMessageId:source,expectedVersion:null});
  const input={type:"workspace.decision.save" as const,id:first.id,projectId:f.project,title:first.title,state:"accepted" as const,reason:"满足要求",sourceMessageId:source,expectedVersion:1};
  const outcomes=await Promise.allSettled([saveWorkspaceDecision(f.db,f.queue,input),saveWorkspaceDecision(f.db,f.queue,input)]);
  assert.equal(outcomes.filter(x=>x.status==="fulfilled").length,1);
  assert.equal(workspaceDecisions(f.db,f.project).at(0)?.version,2);
  assert.equal(workspaceDecisions(f.db,f.project,true).length,2);
  assert.throws(()=>f.db.prepare("UPDATE workspace_decisions SET title='changed'").run(),/immutable/);
 }finally{f.close();}
});
test("backup and restore include referenced assets, verify hashes, and leave the active database untouched",async()=>{
 const f=fixture();try{
  f.user("BACKUP_SENTINEL");
  const bytes=Buffer.from("saved file"),sha=createHash("sha256").update(bytes).digest("hex"),ref="file_"+ulid();
  writeFileSync(join(f.data,"files",sha),bytes);
  f.db.prepare("INSERT INTO files(ref,sha256,name,mime,bytes,is_text,created_at) VALUES(?,?,?,'text/plain',?,1,?)").run(ref,sha,"note.txt",bytes.length,f.now);
  writeFileSync(join(f.data,"settings.json"),'{"token":"SECRET_TOKEN"}');
  f.dirs.push(f.out);const backup=await f.service.backup();assert.ok(backup.path);
  const manifest=verifyWorkspaceBackup(backup.path);assert.equal(manifest.files.length,2);assert.equal(existsSync(join(backup.path,"settings.json")),false);
  f.dirs.push(backup.path,f.out);const restored=await f.service.restore();assert.ok(restored.path);
  assert.notEqual(restored.path,f.data);assert.equal(verifyWorkspaceBackup(restored.path).files.length,2);
  const other=openDatabase(join(restored.path,"room.db"),{readonly:true});assert.equal((other.prepare("SELECT count(*) n FROM chat_messages").get() as {n:number}).n,1);other.close();
  assert.equal((f.db.prepare("SELECT count(*) n FROM chat_messages").get() as {n:number}).n,1);
  writeFileSync(join(backup.path,"files",sha),"tampered");assert.throws(()=>verifyWorkspaceBackup(backup.path!),/校验失败/);
  assert.equal(readdirSync(f.out).some(x=>x.endsWith(".partial")),false);
 }finally{f.close();}
});
test("backup rejects a missing asset and never publishes a partial backup",async()=>{
 const f=fixture();try{
  f.db.prepare("INSERT INTO files(ref,sha256,name,mime,bytes,is_text,created_at) VALUES(?,?,?,'text/plain',1,1,?)").run("file_"+ulid(),"b".repeat(64),"missing.txt",f.now);
  f.dirs.push(f.out);await assert.rejects(f.service.backup());assert.deepEqual(readdirSync(f.out),[]);
 }finally{f.close();}
});
test("backup manifest rejects traversal, unexpected files and duplicates before restoring",()=>{
 assert.equal(WorkspaceBackupManifest.shape.files.element.shape.path.safeParse("../settings.json").success,false);
 assert.equal(WorkspaceBackupManifest.shape.files.element.shape.path.safeParse("settings.json").success,false);
 assert.equal(WorkspaceBackupManifest.shape.files.element.shape.path.safeParse("roomXdb").success,false);
 const f=fixture();try{
  writeFileSync(join(f.out,"manifest.json"),JSON.stringify({format:"agent-room-backup-v1",createdAt:f.now,version:"1",revision:"test",databaseVersion:25,files:Array(2).fill({path:"room.db",bytes:0,sha256:"a".repeat(64)})}));
  assert.throws(()=>verifyWorkspaceBackup(f.out),/重复/);
 }finally{f.close();}
});
test("sharing export previews visible content, rejects stale previews, and omits credentials and snapshots",async()=>{
 const f=fixture();try{
  const msg=f.user("VISIBLE_EXPORT_SENTINEL"),removed=f.user("RETRACT_EXPORT_SENTINEL");
  f.db.prepare("UPDATE chat_messages SET state='retracted',retracted_at=? WHERE id=?").run(f.now,removed);
  const scope={kind:"conversation" as const,conversationId:f.conversation};
  const preview=f.service.preview(scope);assert.match(preview.markdown,/VISIBLE_EXPORT_SENTINEL/);assert.doesNotMatch(preview.markdown,/RETRACT_EXPORT_SENTINEL/);
  f.user("new message");f.dirs.push(f.out);await assert.rejects(f.service.exportScope({type:"workspace.export",scope,expectedDigest:preview.digest,includeAttachments:false}),/变化/);
  const fresh=f.service.preview(scope);f.dirs.push(f.out);const result=await f.service.exportScope({type:"workspace.export",scope,expectedDigest:fresh.digest,includeAttachments:false});assert.ok(result.path);
  assert.match(readFileSync(join(result.path,"资料.md"),"utf8"),/VISIBLE_EXPORT_SENTINEL/);
  assert.deepEqual(readdirSync(result.path).sort(),["资料.md","资料清单.json"].sort());
 }finally{f.close();}
});
test("diagnostic export uses a whitelist rather than forwarding raw health details",async()=>{
 const f=fixture();try{
  const diagnostic=await f.service.diagnostics(),encoded=JSON.stringify(diagnostic);
  assert.doesNotMatch(encoded,/private user label|secret-path|BACKUP_SENTINEL|token/i);
  const result=await f.service.exportDiagnostics();assert.ok(result.path);
  assert.equal(JSON.parse(readFileSync(result.path,"utf8")).format,"agent-room-diagnostics-v1");
 }finally{f.close();}
});

test("restored copies can be reopened after edits while immutable backups cannot be activated",async()=>{
 const f=fixture();try{
  f.user("original");f.dirs.push(f.out);const backup=await f.service.backup();assert.ok(backup.path);
  assert.throws(()=>verifyRestoredDirectory(backup.path!));
  f.dirs.push(backup.path,f.out);const copy=await f.service.restore();assert.ok(copy.path);
  const restored=openDatabase(join(copy.path,"room.db"));restored.prepare("UPDATE projects SET name='edited' WHERE id=?").run(f.project);restored.close();
  assert.equal(verifyRestoredDirectory(copy.path),25);
  let activated:string|null|undefined;let consent=false;
  const service=new WorkspaceService({db:f.db,queue:f.queue,userData:f.data,version:"test",revision:"test",checks:async()=>[],chooseDirectory:async()=>copy.path,chooseSaveFile:async()=>null,confirmSwitch:async()=>consent,activateDirectory:value=>{activated=value;}});
  assert.equal((await service.openRestored()).cancelled,true);assert.equal(activated,undefined);
  consent=true;assert.equal((await service.openRestored()).cancelled,false);assert.equal(activated,copy.path);
 }finally{f.close();}
});
test("decision sources remain in their project and missing sources are rejected",async()=>{
 const f=fixture();try{
  const other="proj_"+ulid(),source="msg_"+ulid();f.db.prepare("INSERT INTO projects(id,name,created_at) VALUES(?,?,?)").run(other,"另一个议题",f.now);
  f.db.prepare("INSERT INTO messages(id,project_id,kind,source_agent,content,created_at) VALUES(?,?,'source_input','human','foreign source',?)").run(source,other,f.now);
  assert.equal(workspaceSources(f.db,f.project).length,0);assert.equal(workspaceSources(f.db,other)[0]?.id,source);
  await assert.rejects(saveWorkspaceDecision(f.db,f.queue,{type:"workspace.decision.save",projectId:f.project,title:"invalid",state:"accepted",reason:"reason",sourceMessageId:source,expectedVersion:null}),/不属于/);
 }finally{f.close();}
});
test("sharing attachments keeps readable extensions and checks their bytes",async()=>{
 const f=fixture();try{
  const bytes=Buffer.from("shared text"),sha=createHash("sha256").update(bytes).digest("hex"),ref="file_"+ulid();
  writeFileSync(join(f.data,"files",sha),bytes);f.db.prepare("INSERT INTO files(ref,sha256,name,mime,bytes,is_text,created_at) VALUES(?,?,?,'text/plain',?,1,?)").run(ref,sha,"readme.txt",bytes.length,f.now);
  f.user("has attachment",f.now,[{ref}]);
  const scope={kind:"conversation" as const,conversationId:f.conversation},preview=f.service.preview(scope);assert.equal(preview.files.length,1);
  f.dirs.push(f.out);const exported=await f.service.exportScope({type:"workspace.export",scope,expectedDigest:preview.digest,includeAttachments:true});assert.ok(exported.path);
  assert.equal(readFileSync(join(exported.path,"附件",ref+".txt"),"utf8"),"shared text");
 }finally{f.close();}
});

test("emoji-heavy results fit UTF-16 contracts for search, detail and export",()=>{
 const f=fixture();try{
  const text="needle"+"😀".repeat(400),id=f.user(text);
  f.db.prepare("UPDATE projects SET name=? WHERE id=?").run("😀".repeat(149)+"x😀",f.project);
  f.db.prepare("INSERT INTO messages(id,project_id,kind,source_agent,content,created_at) VALUES(?,?,'source_input','human',?,?)").run("msg_"+ulid(),f.project,text,f.now);
  const page=searchWorkspace(f.db,{type:"workspace.search",term:"needle",limit:30});
  const item=workspaceItem(f.db,{kind:"chat",id});
  for(const hit of [...page.items,item]){assert.ok(hit.preview.length<=600);assert.ok(hit.title.length<=300);assert.doesNotMatch(hit.preview,/\uD83D$/);assert.doesNotMatch(hit.title,/\uD83D$/);}
  assert.equal(item.content,text);assert.match(f.service.preview({kind:"conversation",conversationId:f.conversation}).markdown,/needle/);
 }finally{f.close();}
});
