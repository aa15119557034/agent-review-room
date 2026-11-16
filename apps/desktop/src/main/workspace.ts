import { createHash, randomUUID } from "node:crypto";
import { closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { currentVersion, workspaceSources, openDatabase, scopeItems, searchWorkspace, workspaceItem, workspaceTasks, workspaceDecisions, saveWorkspaceDecision, WorkspaceError, type SqliteDatabase, type WriteQueue } from "@room/db";
import { WorkspaceRestoreMarker, WorkspaceBackupManifest, WorkspaceDiagnostics, WorkspaceExportPreview, type CommandRequest, type NoteScope, type QueryRequest, type WorkspaceFileResult, type WorkspaceHealth, type WorkspaceHealthCheck } from "@room/schemas";

export interface WorkspaceServiceDeps {
  db: SqliteDatabase; queue: WriteQueue; userData: string; version: string; revision: string;
  checks: () => Promise<WorkspaceHealthCheck[]>;
  confirmSwitch?: (target:string|null)=>Promise<boolean>;
  activateDirectory?: (target:string|null)=>void;
  /** Called outside the DB queue: close world admission and drain before taking the snapshot. */
  withWorldMaintenance?: <T>(work: () => Promise<T>) => Promise<T>;
  /** A failed switch resumes the old world; success permanently stops its runtime. */
  withWorldSwitch?: <T>(work: () => Promise<T>) => Promise<T>;
  chooseDirectory: (title: string) => Promise<string|null>;
  chooseSaveFile: (title: string, name: string) => Promise<string|null>;
}
const cancelled: WorkspaceFileResult = {cancelled:true,path:null,files:0};
const hashText=(s:string)=>createHash("sha256").update(s,"utf8").digest("hex");
function fileDigest(file:string):{bytes:number;sha256:string}{
  const fd=openSync(file,"r"),hash=createHash("sha256"),buf=Buffer.alloc(1024*1024);let bytes=0;
  try{for(;;){const n=readSync(fd,buf,0,buf.length,null);if(!n)break;hash.update(buf.subarray(0,n));bytes+=n;}}finally{closeSync(fd);}
  return {bytes,sha256:hash.digest("hex")};
}
function containedFile(root:string,name:string):string{
  const base=resolve(root),file=resolve(base,name),rel=relative(base,file);
  if(!rel||rel.startsWith("..")||isAbsolute(rel))throw new WorkspaceError("invalid_state","文件路径超出资料目录");
  let p=base;
  if(lstatSync(base).isSymbolicLink())throw new WorkspaceError("invalid_state","资料目录不能是链接");
  for(const part of rel.split(/[\\/]/)){p=join(p,part);if(lstatSync(p).isSymbolicLink())throw new WorkspaceError("invalid_state","资料文件不能经过链接");}
  if(!lstatSync(file).isFile())throw new WorkspaceError("invalid_state","资料不是普通文件");
  return file;
}
const assetRows=(db:SqliteDatabase)=>{
  const rows=db.prepare("SELECT 'images' dir,sha256,bytes FROM images UNION SELECT 'files',sha256,bytes FROM files UNION SELECT 'audio',sha256,bytes FROM audio_refs").all() as Array<{dir:string;sha256:string;bytes:number}>;
  return rows.map(r=>({path:r.dir+"/"+r.sha256,bytes:r.bytes,sha256:r.sha256}));
};
/** Backup DB is never opened with migrations and never replaces a live database. */
export function verifyWorkspaceBackup(folder:string){
  const manifestPath=containedFile(folder,"manifest.json");
  if(lstatSync(manifestPath).size>32*1024*1024)throw new WorkspaceError("invalid_state","备份清单过大");
  const manifest=WorkspaceBackupManifest.parse(JSON.parse(readFileSync(manifestPath,"utf8")));
  if(new Set(manifest.files.map(f=>f.path)).size!==manifest.files.length||manifest.files.filter(f=>f.path==="room.db").length!==1)throw new WorkspaceError("invalid_state","备份清单重复或缺少数据库");
  for(const f of manifest.files){const actual=fileDigest(containedFile(folder,f.path));if(actual.bytes!==f.bytes||actual.sha256!==f.sha256)throw new WorkspaceError("invalid_state","备份文件校验失败："+f.path);}
  const db=openDatabase(join(folder,"room.db"),{readonly:true});
  try{
    if(currentVersion(db)!==manifest.databaseVersion)throw new WorkspaceError("invalid_state","数据库版本与备份清单不符");
    if(db.pragma("quick_check",{simple:true})!=="ok"||(db.pragma("foreign_key_check") as unknown[]).length!==0)throw new WorkspaceError("invalid_state","备份数据库完整性检查失败");
    for(const f of assetRows(db)){if(!manifest.files.some(x=>x.path===f.path&&x.sha256===f.sha256&&x.bytes===f.bytes))throw new WorkspaceError("invalid_state","备份缺少数据库引用的附件："+f.path);}
  }finally{db.close();}
  return manifest;
}
export function verifyRestoredDirectory(folder:string){
  const marker=containedFile(folder,"restore-origin.json");
  if(lstatSync(marker).size>10000)throw new WorkspaceError("invalid_state","恢复标记无效");
  WorkspaceRestoreMarker.parse(JSON.parse(readFileSync(marker,"utf8")));
  const db=openDatabase(containedFile(folder,"room.db"),{readonly:true});
  try{
    if(db.pragma("quick_check",{simple:true})!=="ok"||(db.pragma("foreign_key_check") as unknown[]).length)throw new WorkspaceError("invalid_state","恢复副本数据库检查失败");
    for(const f of assetRows(db)){const actual=fileDigest(containedFile(folder,f.path));if(actual.sha256!==f.sha256||actual.bytes!==f.bytes)throw new WorkspaceError("invalid_state","恢复副本附件校验失败");}
    return currentVersion(db);
  }finally{db.close();}
}
export class WorkspaceService {
  constructor(private readonly deps:WorkspaceServiceDeps){}
  sources(projectId:string){return workspaceSources(this.deps.db,projectId);}
  search(q:QueryRequest<"workspace.search">){return searchWorkspace(this.deps.db,q);}
  item(q:QueryRequest<"workspace.item">){return workspaceItem(this.deps.db,q);}
  tasks(q:QueryRequest<"workspace.tasks">){return workspaceTasks(this.deps.db,q);}
  decisions(q:QueryRequest<"workspace.decisions">){return workspaceDecisions(this.deps.db,q.projectId,q.history);}
  saveDecision(q:CommandRequest<"workspace.decision.save">){return saveWorkspaceDecision(this.deps.db,this.deps.queue,q);}
  async health():Promise<WorkspaceHealth>{
    return {version:this.deps.version,revision:this.deps.revision,databaseVersion:currentVersion(this.deps.db),checks:await this.deps.checks(),checkedAt:new Date().toISOString()};
  }
  async diagnostics(){
    const h=await this.health();
    const tasks=this.tasks({type:"workspace.tasks",activeOnly:false}).items.map(({scope,...task})=>task);
    return WorkspaceDiagnostics.parse({format:"agent-room-diagnostics-v1",createdAt:new Date().toISOString(),version:h.version,revision:h.revision,databaseVersion:h.databaseVersion,checks:h.checks.map(c=>({id:c.id,state:c.state})),tasks});
  }
  async exportDiagnostics():Promise<WorkspaceFileResult>{
    const data=await this.diagnostics();
    const file=await this.deps.chooseSaveFile("保存诊断记录","评审室诊断.json");if(file===null)return cancelled;
    const staging=file+".partial-"+randomUUID();
    try{writeFileSync(staging,JSON.stringify(data,null,2),{encoding:"utf8",flag:"wx"});renameSync(staging,file);}
    finally{if(existsSync(staging))rmSync(staging);}
    return {cancelled:false,path:file,files:1};
  }
  private requireIdle(){
    if(this.tasks({type:"workspace.tasks",activeOnly:true}).items.length>0)throw new WorkspaceError("invalid_state","请先停止正在运行或排队的任务，再备份");
    const transcribing=this.deps.db.prepare("SELECT 1 FROM voice_recordings WHERE status='transcribing' LIMIT 1").get();
    if(transcribing)throw new WorkspaceError("invalid_state","请等待录音转写结束后再备份");
  }
  async backup():Promise<WorkspaceFileResult>{
    const parent=await this.deps.chooseDirectory("选择备份保存位置");if(parent===null)return cancelled;
    const work = () => this.deps.queue.run(()=>{
      this.requireIdle();
      const name="评审室备份-"+new Date().toISOString().replace(/[:.]/g,"-")+"-"+randomUUID().slice(0,8);
      const target=join(parent,name),staging=target+".partial";
      mkdirSync(staging);
      try{
        this.deps.db.prepare("VACUUM INTO ?").run(join(staging,"room.db"));
        const snapshot=openDatabase(join(staging,"room.db"),{readonly:true});
        let assets:ReturnType<typeof assetRows>;try{assets=assetRows(snapshot);}finally{snapshot.close();}
        for(const f of assets){
          const source=containedFile(this.deps.userData,f.path),dest=join(staging,f.path);
          mkdirSync(dirname(dest),{recursive:true});copyFileSync(source,dest);
          const actual=fileDigest(dest);if(actual.bytes!==f.bytes||actual.sha256!==f.sha256)throw new WorkspaceError("invalid_state","附件损坏，备份未完成："+f.path);
        }
        const manifest=WorkspaceBackupManifest.parse({format:"agent-room-backup-v1",createdAt:new Date().toISOString(),version:this.deps.version,revision:this.deps.revision,databaseVersion:currentVersion(this.deps.db),files:[{path:"room.db",...fileDigest(join(staging,"room.db"))},...assets]});
        writeFileSync(join(staging,"manifest.json"),JSON.stringify(manifest,null,2),"utf8");
        verifyWorkspaceBackup(staging);
        renameSync(staging,target);
        return {cancelled:false,path:target,files:manifest.files.length};
      }catch(error){rmSync(staging,{recursive:true,force:true});throw error;}
    });
    return this.deps.withWorldMaintenance ? this.deps.withWorldMaintenance(work) : work();
  }
  async openRestored(useDefault=false):Promise<WorkspaceFileResult>{
    const target=useDefault?null:await this.deps.chooseDirectory("选择已恢复的资料副本");
    if(!useDefault&&target===null)return cancelled;
    if(target!==null){const version=verifyRestoredDirectory(target);if(version>currentVersion(this.deps.db))throw new WorkspaceError("invalid_state","副本来自更新版本，请先升级应用");}
    if(!this.deps.confirmSwitch||!this.deps.activateDirectory)throw new WorkspaceError("invalid_state","当前环境不能切换资料目录");
    if(!await this.deps.confirmSwitch(target))return cancelled;
    const work = () => this.deps.queue.run(()=>{this.requireIdle();this.deps.activateDirectory!(target);return {cancelled:false,path:target??this.deps.userData,files:0};});
    return this.deps.withWorldSwitch ? this.deps.withWorldSwitch(work) : work();
  }
  async restore():Promise<WorkspaceFileResult>{
    const source=await this.deps.chooseDirectory("选择备份文件夹（含 manifest.json）");if(source===null)return cancelled;
    const manifest=verifyWorkspaceBackup(source);
    if(manifest.databaseVersion>currentVersion(this.deps.db))throw new WorkspaceError("invalid_state","此备份来自更新版本，请先升级应用");
    const parent=await this.deps.chooseDirectory("选择恢复副本的位置（不会覆盖当前资料）");if(parent===null)return cancelled;
    const target=join(parent,"评审室恢复-"+randomUUID()),staging=target+".partial";
    mkdirSync(staging);
    try{
      for(const f of manifest.files){const dest=join(staging,f.path);mkdirSync(dirname(dest),{recursive:true});copyFileSync(containedFile(source,f.path),dest);}
      writeFileSync(join(staging,"manifest.json"),JSON.stringify(manifest,null,2),"utf8");
      verifyWorkspaceBackup(staging);
      writeFileSync(join(staging,"restore-origin.json"),JSON.stringify({format:"agent-room-restored-copy-v1",createdAt:new Date().toISOString()}),"utf8");
      renameSync(staging,target);
      return {cancelled:false,path:target,files:manifest.files.length};
    }catch(error){rmSync(staging,{recursive:true,force:true});throw error;}
  }
  private exportData(scope:NoteScope){
    const db=this.deps.db,items=scopeItems(db,scope),refs=new Set<string>();
    if(!items.length)throw new WorkspaceError("not_found","没有可导出的资料");
    for(const item of items){
      if(item.kind==="chat"){
        const row=db.prepare("SELECT content FROM chat_messages WHERE id=?").get(item.id) as {content:string|null};
        if(row.content){const content=JSON.parse(row.content) as {attachments?:Array<{ref:string}>;audio?:string;stickerId?:string};for(const a of content.attachments??[])refs.add(a.ref);if(content.audio)refs.add(content.audio);if(content.stickerId){const sticker=db.prepare("SELECT image_ref FROM chat_stickers WHERE id=?").get(content.stickerId) as {image_ref:string}|undefined;if(sticker)refs.add(sticker.image_ref);}}
      }
      if(item.kind==="chat"||item.kind==="message"){
        const jobs=db.prepare("SELECT result,speech FROM media_jobs WHERE state='succeeded' AND json_extract(source,'$.messageId')=?").all(item.id) as Array<{result:string|null;speech:string|null}>;
        for(const job of jobs){if(job.result)refs.add((JSON.parse(job.result) as {ref:string}).ref);if(job.speech)refs.add((JSON.parse(job.speech) as {audioRef:string}).audioRef);}
      }
    }
    const files=Array.from(refs).map(ref=>{
      const row=db.prepare("SELECT 'images' dir,ref,sha256,bytes,mime,NULL name FROM images WHERE ref=? UNION ALL SELECT 'files',ref,sha256,bytes,mime,name FROM files WHERE ref=? UNION ALL SELECT 'audio',ref,sha256,bytes,mime,NULL FROM audio_refs WHERE ref=?").get(ref,ref,ref) as {dir:string;ref:string;sha256:string;bytes:number;mime:string;name:string|null}|undefined;
      if(!row)throw new WorkspaceError("invalid_state","资料附件引用不存在");
      const ext:Record<string,string>={"image/png":".png","image/jpeg":".jpg","image/webp":".webp","audio/wav":".wav","audio/ogg":".ogg","audio/mpeg":".mp3","text/plain":".txt","text/markdown":".md","application/pdf":".pdf","application/json":".json"};
      return {...row,name:row.name??ref+(ext[row.mime]??""),exportName:ref+(ext[row.mime]??".bin")};
    });
    const title=items.find(x=>x.kind==="topic")?.title??items.find(x=>x.kind==="chat")?.title??"资料";
    const sections=items.map(item=>["## "+item.title+" · "+item.createdAt,"来源："+item.kind+"/"+item.id,"",item.content,""].join("\n"));
    if(scope.kind==="topic"){for(const d of workspaceDecisions(db,scope.projectId,true))sections.push(["## 人工决定 · "+d.title,"版本："+d.version+"；状态："+d.state,"来源消息："+(d.sourceMessageId??"手动记录"),d.reason].join("\n"));}
    const markdown=["# "+title,"","导出仅包含可见资料，不含节点记忆正文、运行 Prompt 或凭据。","",...sections,"## 附件清单",...files.map(f=>"- "+f.ref+" · "+f.name+" · "+f.bytes+" bytes · sha256="+f.sha256)].join("\n");
    const digest=hashText(JSON.stringify({scope,markdown,files:files.map(f=>({ref:f.ref,sha256:f.sha256,bytes:f.bytes}))}));
    return {preview:WorkspaceExportPreview.parse({scope,title,markdown,files:files.map(f=>({ref:f.ref,name:f.name,bytes:f.bytes})),digest}),files};
  }
  preview(scope:NoteScope){return this.exportData(scope).preview;}
  async exportScope(command:CommandRequest<"workspace.export">):Promise<WorkspaceFileResult>{
    const parent=await this.deps.chooseDirectory("选择资料导出位置");if(parent===null)return cancelled;
    const {preview,files}=this.exportData(command.scope);
    if(preview.digest!==command.expectedDigest)throw new WorkspaceError("stale_snapshot","资料已变化，请重新预览后导出");
    const target=join(parent,"评审室资料-"+randomUUID()),staging=target+".partial";mkdirSync(staging);
    try{
      writeFileSync(join(staging,"资料.md"),preview.markdown,"utf8");
      writeFileSync(join(staging,"资料清单.json"),JSON.stringify({scope:command.scope,digest:preview.digest,files:command.includeAttachments?files.map(f=>({ref:f.ref,name:f.name,file:"附件/"+f.exportName,sha256:f.sha256,bytes:f.bytes})):[]},null,2),"utf8");
      if(command.includeAttachments)for(const f of files){
        const dest=join(staging,"附件",f.exportName);mkdirSync(dirname(dest),{recursive:true});copyFileSync(containedFile(this.deps.userData,f.dir+"/"+f.sha256),dest);
        const actual=fileDigest(dest);if(actual.sha256!==f.sha256||actual.bytes!==f.bytes)throw new WorkspaceError("invalid_state","导出附件校验失败");
      }
      renameSync(staging,target);
      return {cancelled:false,path:target,files:2+(command.includeAttachments?files.length:0)};
    }catch(error){rmSync(staging,{recursive:true,force:true});throw error;}
  }
}
