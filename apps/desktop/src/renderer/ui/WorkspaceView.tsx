import { useEffect, useRef, useState } from "react";
import type { NoteScope, PlanVersion, WorkspaceDecision, WorkspaceDiagnostics, WorkspaceExportPreview, WorkspaceFileResult, WorkspaceHealth, WorkspaceItem, WorkspaceSearchPage, WorkspaceTaskPage } from "@room/schemas";
import { useActions, useAppState, useIsMock } from "./hooks";
import { comparePlanLines } from "../lib/plan-diff";
import "./workspace.css";

const healthLabel={configured:"已配置，未试跑",available:"连接可用",unavailable:"不可用",unconfigured:"未配置",unknown:"未知"};
const decisionLabel={pending:"待决定",accepted:"采纳",rejected:"拒绝",deferred:"延后"};
const formatTime=(value:string|null)=>value?new Date(value).toLocaleString():"尚未发生";
const TAB_HINT={search:"解决「那段话在哪」：按关键词找回聊天、方案、笔记，或把一个范围导出成文件。",plans:"解决「方案改了什么、决定了没有」：对照方案版本，记录采纳 / 拒绝 / 延后。",tasks:"解决「任务卡在哪」：看排队、运行和失败的任务，以及每次回答的来源。",maintenance:"解决「资料安不安全」：检查健康状况，备份和恢复。"} as const;
export function WorkspaceView(){
  const actions=useActions(),api=actions.workspace,projects=useAppState(s=>s.projects),conversations=useAppState(s=>s.chat.list);
  const notice=useAppState(s=>s.notice),isMock=useIsMock();
  const [tab,setTab]=useState<"search"|"plans"|"tasks"|"maintenance">("search");
  const [scopeValue,setScopeValue]=useState(""),[term,setTerm]=useState(""),[search,setSearch]=useState<WorkspaceSearchPage|null>(null);
  const [item,setItem]=useState<WorkspaceItem|null>(null),[preview,setPreview]=useState<WorkspaceExportPreview|null>(null),[attachments,setAttachments]=useState(true);
  const [searchBusy,setSearchBusy]=useState(false),[fileBusy,setFileBusy]=useState(false),[result,setResult]=useState<WorkspaceFileResult|null>(null);
  const busy=searchBusy||fileBusy;
  const request=useRef(0),selection=useRef(0);
  const scope:NoteScope|undefined=scopeValue.startsWith("topic:")?{kind:"topic",projectId:scopeValue.slice(6)}:scopeValue.startsWith("conversation:")?{kind:"conversation",conversationId:scopeValue.slice(13)}:undefined;
  useEffect(()=>{void actions.chat.loadConversations();return()=>{request.current++;selection.current++;};},[actions]);
  function invalidate(){request.current++;selection.current++;setSearch(null);setItem(null);setPreview(null);}
  async function find(older=false){
    const token=++request.current;setSearchBusy(true);
    const page=await api.search({term:term.trim(),scope,limit:30,...(older&&search?.nextCursor?{before:search.nextCursor}:{})});
    if(token!==request.current)return;
    setSearchBusy(false);if(page)setSearch(older?{...page,items:[...(search?.items??[]),...page.items]}:page);
  }
  async function inspect(hit:WorkspaceItem){setItem(hit);}
  async function fileAction(action:()=>Promise<WorkspaceFileResult|null>){setFileBusy(true);setResult(null);try{setResult(await action());}finally{setFileBusy(false);}}
  return <main className="workspace-page">
    <header className="workspace-heading"><div><h1>资料与维护</h1><p>找回资料，核对回答来源，整理决定与备份。</p></div><button onClick={()=>void actions.openSettings()}>← 返回设置</button></header>
    {notice&&<p role="alert">{notice.message}</p>}
    {isMock?<p role="status">演示数据下没有资料可以维护，请在桌面应用里使用。</p>:<>
    <nav className="workspace-tabs" aria-label="资料与维护">
      {([["search","搜索与成果"],["plans","方案与决定"],["tasks","任务与来源"],["maintenance","健康与备份"]] as const).map(([key,label])=><button key={key} aria-pressed={tab===key} onClick={()=>setTab(key)}>{label}</button>)}
    </nav>
    <p className="workspace-tab-hint">{TAB_HINT[tab]}</p>
    {tab==="search"&&<section>
      <form className="workspace-toolbar" onSubmit={e=>{e.preventDefault();void find();}}>
        <label>范围<select value={scopeValue} onChange={e=>{setScopeValue(e.target.value);invalidate();setSearchBusy(false);}}>
          <option value="">全部资料</option>
          {projects.map(p=><option key={p.id} value={"topic:"+p.id}>议题 · {p.name}</option>)}
          {conversations?.map(c=><option key={c.conversation.id} value={"conversation:"+c.conversation.id}>聊天 · {c.conversation.title??c.conversation.members.join("、")}</option>)}
        </select></label>
        <label>关键词<input value={term} maxLength={200} onChange={e=>{setTerm(e.target.value);invalidate();setSearchBusy(false);}} placeholder="消息、方案、笔记或议题标题"/></label>
        <button disabled={busy||!term.trim()}>搜索</button>
        <button type="button" disabled={!scope||busy} onClick={()=>{const token=++selection.current;setPreview(null);void api.preview(scope!).then(p=>{if(token===selection.current)setPreview(p);});}}>预览并导出这个范围</button>
      </form>
      {busy&&<p role="status">正在处理…</p>}
      {search&&<p role="status">已找到 {search.items.length} 条{search.nextCursor?"，还有更多":""}</p>}
      <ul className="workspace-results">{search?.items.map(hit=><li key={hit.kind+hit.id}>
        <button onClick={()=>{const token=++selection.current;setItem(null);void api.item(hit).then(value=>{if(value&&token===selection.current)void inspect(value);});}}><strong>{hit.title}</strong><span>{formatTime(hit.createdAt)}</span><p>{hit.preview||"这条资料只有附件"}</p></button>
      </li>)}</ul>
      {search?.nextCursor&&<button disabled={busy} onClick={()=>void find(true)}>更多结果</button>}
      {item&&<article className="workspace-card"><h2>{item.title}</h2><p>{formatTime(item.createdAt)} · {item.kind}</p><pre>{item.content}</pre>
        {item.runId&&item.kind==="chat"&&<ContextDetails runId={item.runId}/>}
        <button onClick={()=>setItem(null)}>收起</button>
      </article>}
      {preview&&<article className="workspace-card"><h2>导出预览 · {preview.title}</h2><p>包含可见资料和下列附件；不含运行 Prompt、节点记忆正文或凭据。</p>
        <pre>{preview.markdown}</pre><label><input type="checkbox" checked={attachments} onChange={e=>setAttachments(e.target.checked)}/>包含 {preview.files.length} 个附件</label>
        <ul>{preview.files.map(f=><li key={f.ref}>{f.name} · {f.bytes.toLocaleString()} 字节</li>)}</ul>
        <button disabled={busy} onClick={()=>void fileAction(()=>api.exportScope({scope:preview.scope,expectedDigest:preview.digest,includeAttachments:attachments}))}>选择文件夹并导出</button>
      </article>}
    </section>}
    {tab==="plans"&&<PlanWorkspace/>}
    {tab==="tasks"&&<TaskWorkspace/>}
    {tab==="maintenance"&&<Maintenance fileAction={fileAction} busy={busy}/>}
    {result&&!result.cancelled&&<p role="status">已保存 {result.files} 个文件：<code>{result.path}</code></p>}
    </>}
  </main>;
}

export function ContextDetails({runId}:{runId:string}){
  const api=useActions().workspace;
  const [context,setContext]=useState<Awaited<ReturnType<typeof api.context>>>(null),[loading,setLoading]=useState(false);
  const [open,setOpen]=useState(false);
  useEffect(()=>{setContext(null);setOpen(false);},[runId]);
  useEffect(()=>{if(!open)return;let current=true;setLoading(true);void api.context(runId).then(value=>{if(current){setContext(value);setLoading(false);}});return()=>{current=false;};},[api,runId,open]);
  const current=context?.snapshot,previous=context?.previous;
  return <section className="workspace-context"><button onClick={()=>setOpen(!open)} aria-expanded={open}>{open?"收起回答来源":"查看这次回答的来源"}</button>
    {open&&(loading?<p role="status">正在读取本次记录…</p>:context&&current?<div>
      <dl><dt>模型与强度</dt><dd>{context.run.model?JSON.stringify(context.run.model):"跟随节点默认；没有额外记录"}</dd>
        <dt>尝试次数 / 状态</dt><dd>{context.attempt??"内部任务"} / {context.run.state}</dd>
        <dt>输入消息 / 摘要</dt><dd>{current.includedMessageIds.length} 条消息，{current.includedSummaryIds.length} 份摘要</dd>
        <dt>笔记版本记录</dt><dd>{current.projectNoteId??"没有使用笔记"}</dd>
        <dt>实际图片清单</dt><dd>{current.attachments?.map(a=>a.name).join("、")||"没有图片字节；可能只有文字占位"}</dd>
      </dl>
      {previous&&<p role="status">与上次尝试相比：模型{JSON.stringify(previous.run.model)===JSON.stringify(context.run.model)?"未变":"已变化"}；笔记{previous.snapshot.projectNoteId===current.projectNoteId?"未变":"已变化"}；消息/摘要范围{JSON.stringify([previous.snapshot.includedMessageIds,previous.snapshot.includedSummaryIds])===JSON.stringify([current.includedMessageIds,current.includedSummaryIds])?"未变":"已变化"}；图片{JSON.stringify(previous.snapshot.attachments)===JSON.stringify(current.attachments)?"未变":"已变化"}。快照指纹{previous.snapshot.contentHash===current.contentHash?"相同":"不同（新边界随机值也会改变指纹）"}。</p>}
      <details><summary>查看主控实际保存的输入和来源标识</summary><p>这里包含当时的历史资料和文本附件；节点填入的记忆正文不在主控快照中。仅用于你本人核对。</p><p>快照：{current.contentHash}</p><p>节点最终输入：{context.run.finalPromptHash??"尚未收到节点记录"}</p><pre>{current.content}</pre></details>
    </div>:<p>无法读取记录，请查看错误提示后重试。</p>)}
  </section>;
}
function PlanWorkspace(){
  const api=useActions().workspace,projects=useAppState(s=>s.projects);
  const [projectId,setProjectId]=useState(projects[0]?.id??""),[plans,setPlans]=useState<PlanVersion[]>([]),[decisions,setDecisions]=useState<WorkspaceDecision[]>([]),[messages,setMessages]=useState<WorkspaceItem[]>([]);
  const [left,setLeft]=useState(""),[right,setRight]=useState(""),[selected,setSelected]=useState<WorkspaceDecision|null>(null);
  const [title,setTitle]=useState(""),[reason,setReason]=useState(""),[state,setState]=useState<WorkspaceDecision["state"]>("pending"),[source,setSource]=useState(""),[history,setHistory]=useState(false),[saving,setSaving]=useState(false),[refresh,setRefresh]=useState(0);
  useEffect(()=>{let active=true;setPlans([]);setDecisions([]);setMessages([]);setSelected(null);setTitle("");setReason("");setState("pending");setSource("");
    if(projectId)void Promise.all([api.plans(projectId),api.decisions(projectId,history),api.messages(projectId)]).then(([p,d,m])=>{if(!active)return;setPlans(p??[]);setDecisions(d??[]);setMessages(m??[]);setLeft(p?.at(-2)?.id??p?.[0]?.id??"");setRight(p?.at(-1)?.id??"");});
    return()=>{active=false;};},[api,projectId,history,refresh]);
  const a=plans.find(p=>p.id===left),b=plans.find(p=>p.id===right),diff=a&&b?comparePlanLines(a.content,b.content):[];
  function edit(d:WorkspaceDecision){setSelected(d);setTitle(d.title);setReason(d.reason);setState(d.state);setSource(d.sourceMessageId??"");}
  async function save(){setSaving(true);const result=await api.saveDecision({projectId,...(selected?{id:selected.id}:{}),expectedVersion:selected?.version??null,title,state,reason,sourceMessageId:source||null});setSaving(false);if(result)setRefresh(x=>x+1);}
  return <section>
    <label>议题<select value={projectId} onChange={e=>setProjectId(e.target.value)}>{projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
    <h2>方案版本对照</h2><div className="workspace-toolbar">{([["之前",left,setLeft],["之后",right,setRight]] as const).map(([label,value,set])=><label key={label}>{label}<select value={value} onChange={e=>set(e.target.value)}>{plans.map(p=><option key={p.id} value={p.id}>v{p.version} · {p.state}</option>)}</select></label>)}</div>
    {!plans.length&&<p>这个议题还没有方案。</p>}
    {diff.length>0&&<><p>红色为移除，绿色为新增；中间变化按整段对照。</p><pre className="workspace-diff">{diff.slice(0,2000).map((l,i)=><span key={i} data-kind={l.kind}>{l.kind==="removed"?"− ":l.kind==="added"?"+ ":"  "}{l.text}{"\n"}</span>)}</pre>{diff.length>2000&&<p>对照展示前 2000 行，请导出议题查看全文。</p>}</>}
    <h2>待决定事项</h2><p>人工记录的采纳、拒绝或延后，不会自动定稿、批准或执行。</p>
    <label><input type="checkbox" checked={history} onChange={e=>setHistory(e.target.checked)}/>显示历史版本</label>
    <button onClick={()=>setRefresh(x=>x+1)}>刷新</button>
    <ul className="workspace-results">{decisions.map(d=><li key={d.id+":"+d.version}><button onClick={()=>edit(d)}><strong>{d.title}</strong> · {decisionLabel[d.state]} · v{d.version}<p>{d.reason}</p></button></li>)}</ul>
    <form className="workspace-card" onSubmit={e=>{e.preventDefault();void save();}}>
      <h3>{selected?"更新事项（保存为新版本）":"新建事项"}</h3>
      <label>事项<input value={title} onChange={e=>setTitle(e.target.value)} required maxLength={300}/></label>
      <label>决定<select value={state} onChange={e=>setState(e.target.value as WorkspaceDecision["state"])}>{Object.entries(decisionLabel).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
      <label>理由<textarea value={reason} onChange={e=>setReason(e.target.value)} required={state!=="pending"} maxLength={4000}/></label>
      <label>来源意见（最近 200 条可见消息）<select value={source} onChange={e=>setSource(e.target.value)}><option value="">手动记录</option>{messages.map(m=><option key={m.id} value={m.id}>{m.content.slice(0,100)}</option>)}</select></label>
      {source&&<pre>{messages.find(m=>m.id===source)?.content??"来源消息已不可见"}</pre>}
      <button disabled={saving||!projectId||!title.trim()}>保存</button>
      {selected&&<button type="button" onClick={()=>{setSelected(null);setTitle("");setReason("");setState("pending");setSource("");}}>改为新建</button>}
    </form>
  </section>;
}
function TaskWorkspace(){
  const api=useActions().workspace;
  const [page,setPage]=useState<WorkspaceTaskPage|null>(null),[activeOnly,setActiveOnly]=useState(false),[busy,setBusy]=useState(false),[context,setContext]=useState<string|null>(null);
  const request=useRef(0);
  useEffect(()=>{const token=++request.current;setPage(null);setBusy(true);void api.tasks({activeOnly}).then(p=>{if(token===request.current){setPage(p);setBusy(false);}});return()=>{request.current++;};},[api,activeOnly]);
  async function load(older=false){const token=++request.current;setBusy(true);const p=await api.tasks({activeOnly,...(older&&page?.nextCursor?{before:page.nextCursor}:{})});if(token!==request.current)return;setBusy(false);if(p)setPage(older?{...p,items:[...(page?.items??[]),...p.items]}:p);}
  return <section><div className="workspace-toolbar"><label><input type="checkbox" checked={activeOnly} onChange={e=>setActiveOnly(e.target.checked)}/>只看排队与运行中</label><button disabled={busy} onClick={()=>void load()}>刷新</button></div>
    <p>时间来自任务记录。排队中尚无开始时间，不估算完成倒计时。</p>
    <ul className="workspace-results">{page?.items.map(t=><li key={t.kind+t.id}><strong>{t.kind==="media"?"媒体":t.kind==="chat"?"聊天":"讨论"} · {t.state}</strong><p>创建 {formatTime(t.createdAt)} · 开始 {formatTime(t.startedAt)} · 结束 {formatTime(t.finishedAt)}</p>
      {t.startedAt&&t.finishedAt&&<p>运行 {Math.max(0,Date.parse(t.finishedAt)-Date.parse(t.startedAt))/1000} 秒</p>}{t.failure&&<p>失败原因：{t.failure}</p>}
      {t.kind==="chat"&&<button onClick={()=>setContext(t.id)}>回答来源</button>}
      {t.kind==="media"&&["queued","running"].includes(t.state)&&<button disabled={busy} onClick={()=>{setBusy(true);void api.cancelMedia(t.id).then(()=>load());}}>取消这个任务</button>}
    </li>)}</ul>{page?.nextCursor&&<button disabled={busy} onClick={()=>void load(true)}>更早的任务</button>}
    {context&&<ContextDetails runId={context}/>}
  </section>;
}
function Maintenance({fileAction,busy}:{fileAction:(action:()=>Promise<WorkspaceFileResult|null>)=>Promise<void>;busy:boolean}){
  const api=useActions().workspace;const [health,setHealth]=useState<WorkspaceHealth|null>(null),[diagnostics,setDiagnostics]=useState<WorkspaceDiagnostics|null>(null),[checking,setChecking]=useState(false);
  async function check(){setChecking(true);try{setHealth(await api.health());}finally{setChecking(false);}}
  return <section>
    <h2>健康检查</h2><p>读取配置、资源和节点健康接口，不调用模型或生成内容。</p><button disabled={checking} onClick={()=>void check()}>{checking?"正在检查…":"检查当前状态"}</button>
    {health&&<><p>应用 {health.version} · 数据版本 {health.databaseVersion} · 检查于 {formatTime(health.checkedAt)}</p><details><summary>构建版本</summary><code>{health.revision}</code></details>
      <ul className="workspace-results">{health.checks.map(c=><li key={c.id}><strong>{c.label} · {healthLabel[c.state]}</strong><p>{c.detail}</p></li>)}</ul></>}
    <h2>诊断记录</h2><p>仅包含版本、状态、任务关联标识和时间；不包含聊天、Prompt、节点记忆、地址、文件路径或凭据。</p>
    <button onClick={()=>void api.diagnostics().then(setDiagnostics)}>预览诊断</button>
    {diagnostics&&<><pre>{JSON.stringify(diagnostics,null,2)}</pre><button disabled={busy} onClick={()=>void fileAction(()=>api.exportDiagnostics())}>保存诊断 JSON</button></>}
    <h2>备份与恢复</h2><p>备份包含数据库、图片、文件、录音和合成音频。数据库含历史审计资料，请自行妥善保存。凭据、Python 环境、模型和本机配置不包含在备份中，换电脑后需要重新配置。</p>
    <p>恢复会先校验全部文件，再写入一个新文件夹，不覆盖正在使用的资料。完成后可用应用的“打开恢复副本”入口切换。</p>
    <div className="workspace-toolbar"><button disabled={busy} onClick={()=>void fileAction(()=>api.backup())}>备份资料</button><button disabled={busy} onClick={()=>void fileAction(()=>api.restore())}>校验备份并恢复为副本</button><button disabled={busy} onClick={()=>void fileAction(()=>api.openRestored())}>打开恢复副本并重启</button><button disabled={busy} onClick={()=>void fileAction(()=>api.useDefaultData())}>切回原资料并重启</button></div>
  </section>;
}
