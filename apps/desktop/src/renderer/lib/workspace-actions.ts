import type { CommandRequest, NoteScope, QueryRequest, WorkspaceItemKey } from "@room/schemas";
import type { RoomClient } from "./client";

export function createWorkspaceActions(client:RoomClient,fail:(error:unknown)=>void,onSwitch?:()=>void){
  async function attempt<T>(operation:()=>Promise<T>):Promise<T|null>{try{return await operation();}catch(error){fail(error);return null;}}
  async function switchData(type:"workspace.openRestored"|"workspace.useDefaultData") { const result=await client.command({type});if(!result.cancelled)onSwitch?.();return result; }
  return {
    search:(q:Omit<QueryRequest<"workspace.search">,"type">)=>attempt(()=>client.query({type:"workspace.search",...q})),
    item:(key:WorkspaceItemKey)=>attempt(()=>client.query({type:"workspace.item",kind:key.kind,id:key.id})),
    health:()=>attempt(()=>client.query({type:"workspace.health"})),
    diagnostics:()=>attempt(()=>client.query({type:"workspace.diagnostics"})),
    tasks:(q:Omit<QueryRequest<"workspace.tasks">,"type">)=>attempt(()=>client.query({type:"workspace.tasks",...q})),
    decisions:(projectId:string,history=false)=>attempt(()=>client.query({type:"workspace.decisions",projectId,history})),
    saveDecision:(q:Omit<CommandRequest<"workspace.decision.save">,"type">)=>attempt(()=>client.command({type:"workspace.decision.save",...q})),
    preview:(scope:NoteScope)=>attempt(()=>client.query({type:"workspace.export.preview",scope})),
    exportScope:(q:Omit<CommandRequest<"workspace.export">,"type">)=>attempt(()=>client.command({type:"workspace.export",...q})),
    openRestored:()=>attempt(()=>switchData("workspace.openRestored")),
    useDefaultData:()=>attempt(()=>switchData("workspace.useDefaultData")),
    backup:()=>attempt(()=>client.command({type:"workspace.backup"})),
    restore:()=>attempt(()=>client.command({type:"workspace.restore"})),
    exportDiagnostics:()=>attempt(()=>client.command({type:"workspace.diagnostics.export"})),
    messages:(projectId:string)=>attempt(()=>client.query({type:"workspace.sources",projectId})),
    plans:(projectId:string)=>attempt(()=>client.query({type:"plans.list",projectId})),
    context:(runId:string)=>attempt(async()=>{
      const run=await client.query({type:"chat.runs.get",runId});
      const snapshot=await client.query({type:"chat.snapshots.get",snapshotId:run.snapshotId});
      const attempts=run.slotId?await client.query({type:"chat.slots.runs",slotId:run.slotId}):[];
      const index=attempts.findIndex(r=>r.id===run.id);
      const prior=index>0?attempts[index-1]:undefined;
      const previous=prior?{run:prior,snapshot:await client.query({type:"chat.snapshots.get",snapshotId:prior.snapshotId})}:null;
      return {run,snapshot,previous,attempt:index>=0?index+1:null};
    }),
    cancelMedia:(jobId:string)=>attempt(()=>client.command({type:"media.cancel",jobId})),
  };
}
