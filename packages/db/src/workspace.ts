import { ulid } from "./ulid";
import { writeTransaction, type WriteQueue } from "./write-queue";
import type { SqliteDatabase } from "./database";
import { WorkspaceDecision, WorkspaceItem, WorkspaceSearchHit, WorkspaceTask, type CommandRequest, type NoteScope, type QueryRequest, type WorkspaceItemKey, type WorkspaceSearchPage, type WorkspaceTaskPage } from "@room/schemas";

export class WorkspaceError extends Error {
  constructor(readonly code: "not_found" | "invalid_state" | "stale_snapshot", message: string) { super(message); }
}
const visibleChat = `(m.sender='user' AND m.state='sent') OR (m.sender='agent' AND EXISTS(SELECT 1 FROM chat_messages parent WHERE parent.id=m.in_reply_to AND parent.state='sent'))`;
const visibleMaterial = `m.kind!='chat_material' OR NOT EXISTS(SELECT 1 FROM json_each(m.chat_message_ids) j LEFT JOIN chat_messages c ON c.id=j.value LEFT JOIN chat_messages p ON p.id=c.in_reply_to WHERE c.id IS NULL OR c.state='retracted' OR (c.sender='agent' AND (p.state IS NULL OR p.state!='sent')))`;
const visibleNote = `n.source_kind IS NULL OR n.source_kind!='chat_run' OR NOT EXISTS(
  SELECT 1 FROM chat_runs r JOIN chat_snapshots s ON s.id=r.snapshot_id JOIN json_each(s.included_message_ids) j
  LEFT JOIN chat_messages c ON c.id=j.value LEFT JOIN chat_messages p ON p.id=c.in_reply_to
  WHERE r.id=n.source_id AND (c.id IS NULL OR c.state='retracted' OR (c.sender='agent' AND (p.state IS NULL OR p.state!='sent'))))`;
const corpus = `
SELECT 'chat' kind,m.id,'conversation' scope_kind,m.conversation_id scope_id,
  COALESCE(c.title,c.direct_agent,'群聊') title,COALESCE(m.text,json_extract(m.content,'$.text'),json_extract(m.content,'$.transcriptText'),'') content,m.created_at,m.run_id
FROM chat_messages m JOIN conversations c ON c.id=m.conversation_id WHERE ${visibleChat}
UNION ALL
SELECT 'message',m.id,'topic',m.project_id,p.name,m.content,m.created_at,m.run_id FROM messages m JOIN projects p ON p.id=m.project_id WHERE ${visibleMaterial}
UNION ALL
SELECT 'plan',v.id,'topic',v.project_id,p.name || ' · 方案 v' || v.version,v.content,v.created_at,NULL FROM plan_versions v JOIN projects p ON p.id=v.project_id
UNION ALL
SELECT 'note',n.id,n.scope_kind,n.scope_id,n.agent || ' · 笔记 v' || n.version,n.content,n.created_at,NULL FROM project_notes n WHERE ${visibleNote}
UNION ALL
SELECT 'topic',id,'topic',id,name,name,created_at,NULL FROM projects`;
type Row = { kind: WorkspaceItemKey["kind"]; id: string; scope_kind: "topic" | "conversation"; scope_id: string; title: string; content: string; created_at: string; run_id: string | null };
const scopeOf = (r: Row): NoteScope => r.scope_kind === "topic" ? { kind: "topic", projectId: r.scope_id } : { kind: "conversation", conversationId: r.scope_id };
function truncateUtf16(text:string,limit:number):string {
 let result="";for(const point of text){if(result.length+point.length>limit)break;result+=point;}return result;
}
const hit = (r: Row, term = "") => {
  const index = r.content.toLowerCase().indexOf(term.toLowerCase());
  let start=Math.max(0,index-60);
  if(start>0&&/[\uDC00-\uDFFF]/.test(r.content[start]??""))start--;
  return WorkspaceSearchHit.parse({ kind: r.kind, id: r.id, scope: scopeOf(r), title: truncateUtf16(r.title,300),
    preview: truncateUtf16(r.content.slice(start),600), createdAt: r.created_at });
};
export function searchWorkspace(db: SqliteDatabase, q: QueryRequest<"workspace.search">): WorkspaceSearchPage {
  const rows = db.prepare(`WITH corpus AS (${corpus}) SELECT * FROM corpus WHERE
    (instr(lower(content),lower(@term))>0 OR instr(lower(title),lower(@term))>0)
    AND (@scopeKind IS NULL OR (scope_kind=@scopeKind AND scope_id=@scopeId))
    AND (@before IS NULL OR created_at<@before OR (created_at=@before AND kind||':'||id<@key))
    ORDER BY created_at DESC,kind||':'||id DESC LIMIT @limit`).all({
      term:q.term,scopeKind:q.scope?.kind??null,scopeId:q.scope ? (q.scope.kind==="topic"?q.scope.projectId:q.scope.conversationId):null,
      before:q.before?.createdAt??null,key:q.before?.key??null,limit:q.limit+1,
    }) as Row[];
  const items=rows.slice(0,q.limit).map(r=>hit(r,q.term)),last=items.at(-1);
  return {items,nextCursor:rows.length>q.limit&&last?{createdAt:last.createdAt,key:last.kind+":"+last.id}:null};
}
export function workspaceItem(db: SqliteDatabase, key: WorkspaceItemKey): WorkspaceItem {
  const r=db.prepare(`WITH corpus AS (${corpus}) SELECT * FROM corpus WHERE kind=? AND id=?`).get(key.kind,key.id) as Row|undefined;
  if(!r)throw new WorkspaceError("not_found","内容不存在或已撤回");
  return WorkspaceItem.parse({...hit(r),content:r.content,runId:r.run_id});
}
export function scopeItems(db: SqliteDatabase, scope: NoteScope): WorkspaceItem[] {
  const id=scope.kind==="topic"?scope.projectId:scope.conversationId;
  const rows=db.prepare(`WITH corpus AS (${corpus}) SELECT * FROM corpus WHERE scope_kind=? AND scope_id=? ORDER BY created_at,kind,id LIMIT 10001`).all(scope.kind,id) as Row[];
  if(rows.length>10000)throw new WorkspaceError("invalid_state","单次导出最多 10000 条资料，请缩小范围");
  return rows.map(r=>WorkspaceItem.parse({...hit(r),content:r.content,runId:r.run_id}));
}
export function workspaceTasks(db: SqliteDatabase,q: QueryRequest<"workspace.tasks">): WorkspaceTaskPage {
  const rows=db.prepare(`WITH tasks AS (
    SELECT id,'chat' kind,state,failure_reason failure,created_at,started_at,finished_at,'conversation' scope_kind,conversation_id scope_id FROM chat_runs
    UNION ALL SELECT id,'discussion',state,failure_reason,created_at,started_at,finished_at,'topic',project_id FROM runs
    UNION ALL SELECT id,'media',state,json_extract(failure,'$.reason'),created_at,started_at,finished_at,CASE json_extract(source,'$.kind') WHEN 'topic' THEN 'topic' ELSE 'conversation' END,COALESCE(json_extract(source,'$.projectId'),json_extract(source,'$.conversationId')) FROM media_jobs
  ) SELECT * FROM tasks WHERE (@active=0 OR state IN ('QUEUED','STARTING','RUNNING','queued','running'))
    AND (@before IS NULL OR created_at<@before OR (created_at=@before AND kind||':'||id<@key))
    ORDER BY created_at DESC,kind||':'||id DESC LIMIT 101`).all({active:q.activeOnly?1:0,before:q.before?.createdAt??null,key:q.before?.key??null}) as Array<{id:string;kind:"chat"|"discussion"|"media";state:string;failure:string|null;created_at:string;started_at:string|null;finished_at:string|null;scope_kind:"topic"|"conversation";scope_id:string}>;
  const items=rows.slice(0,100).map(r=>WorkspaceTask.parse({id:r.id,kind:r.kind,state:r.state,failure:r.failure,createdAt:r.created_at,startedAt:r.started_at,finishedAt:r.finished_at,scope:r.scope_kind==="topic"?{kind:"topic",projectId:r.scope_id}:{kind:"conversation",conversationId:r.scope_id}})),last=items.at(-1);
  return {items,nextCursor:rows.length>100&&last?{createdAt:last.createdAt,key:last.kind+":"+last.id}:null};
}
const decisionRows = (db:SqliteDatabase,projectId:string,history:boolean) => db.prepare(`SELECT * FROM workspace_decisions d WHERE project_id=? ${history?"":"AND version=(SELECT max(version) FROM workspace_decisions x WHERE x.id=d.id)"} ORDER BY created_at DESC,id DESC,version DESC LIMIT 1001`).all(projectId) as Array<{id:string;project_id:string;title:string;state:string;reason:string;source_message_id:string|null;version:number;created_at:string}>;
export function workspaceDecisions(db:SqliteDatabase,projectId:string,history=false):WorkspaceDecision[] {
  const rows=decisionRows(db,projectId,history);
  if(rows.length>1000)throw new WorkspaceError("invalid_state","待决定事项过多，请先按议题整理");
  return rows.map(r=>WorkspaceDecision.parse({id:r.id,projectId:r.project_id,title:r.title,state:r.state,reason:r.reason,sourceMessageId:r.source_message_id,version:r.version,createdAt:r.created_at}));
}
export function saveWorkspaceDecision(db:SqliteDatabase,queue:WriteQueue,input:CommandRequest<"workspace.decision.save">):Promise<WorkspaceDecision>{
  return writeTransaction(db,queue,()=>{
    if(!db.prepare("SELECT 1 FROM projects WHERE id=?").get(input.projectId))throw new WorkspaceError("not_found","议题不存在");
    const id=input.id??"decision_"+ulid();
    const latest=db.prepare("SELECT project_id,version FROM workspace_decisions WHERE id=? ORDER BY version DESC LIMIT 1").get(id) as {project_id:string;version:number}|undefined;
    if((latest?.version??null)!==input.expectedVersion||(input.id!==undefined&&!latest)||(latest&&latest.project_id!==input.projectId))throw new WorkspaceError("stale_snapshot","事项已变化，请刷新后再保存");
    if(input.sourceMessageId){const source=workspaceItem(db,{kind:"message",id:input.sourceMessageId});if(source.scope.kind!=="topic"||source.scope.projectId!==input.projectId)throw new WorkspaceError("invalid_state","来源不属于这个议题");}
    if(input.state!=="pending"&&!input.reason.trim())throw new WorkspaceError("invalid_state","请写明采纳、拒绝或延后的理由");
    const next=WorkspaceDecision.parse({id,projectId:input.projectId,title:input.title,state:input.state,reason:input.reason,sourceMessageId:input.sourceMessageId,version:(latest?.version??0)+1,createdAt:new Date().toISOString()});
    db.prepare("INSERT INTO workspace_decisions(id,project_id,title,state,reason,source_message_id,version,created_at) VALUES(?,?,?,?,?,?,?,?)").run(next.id,next.projectId,next.title,next.state,next.reason,next.sourceMessageId,next.version,next.createdAt);
    return next;
  });
}

export function workspaceSources(db:SqliteDatabase,projectId:string):WorkspaceItem[]{
  const rows=db.prepare(`WITH corpus AS (${corpus}) SELECT * FROM corpus WHERE kind='message' AND scope_id=? ORDER BY created_at DESC,id DESC LIMIT 200`).all(projectId) as Row[];
  return rows.map(r=>WorkspaceItem.parse({...hit(r),content:r.content,runId:r.run_id}));
}
