import React, { useEffect, useRef, useState, type FormEvent } from "react";
import { ProjectResearchQuery, type ProjectResearchPreview, type QueryResponse } from "@room/schemas";
import type { ResearchHistory } from "../lib/research-actions";
import { useActions, useAppState } from "./hooks";
import { ResultDisplayView } from "./SourceReferences";
import { CurrentSourceReferences } from "./CurrentSourceReferences";
import { RUN_STATE_LABEL, FAILURE_REASON_LABEL } from "./labels";

export function ProjectResearch() {
  const projectId = useAppState((s) => s.currentProjectId);
  const [open, setOpen] = useState(false);
  if (!projectId) return null;
  return <details className="project-research" id="project-research" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
    <summary>检索公开资料</summary>
    {open && <ResearchWorkspace key={projectId} projectId={projectId} />}
  </details>;
}

function ResearchWorkspace({ projectId }: { projectId: string }) {
  const actions = useActions();
  const runs = useAppState((s) => s.runs), approvals = useAppState((s) => s.approvals);
  const [history, setHistory] = useState<ResearchHistory>({ previews: [], results: [] });
  const [choices, setChoices] = useState<Awaited<ReturnType<typeof actions.research.choices>>>(undefined);
  const [loadingNodes, setLoadingNodes] = useState(true), [selection, setSelection] = useState("");
  const [query, setQuery] = useState(""), [busy, setBusy] = useState(false);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => {
    let current = true;
    void actions.research.load(projectId).then((data) => { if (current && data) setHistory(data); });
    return () => { current = false; };
  }, [actions, projectId, runs, approvals]);
  useEffect(() => {
    let current = true;
    void actions.research.choices(projectId).then((data) => {
      if (!current) return;
      setChoices(data); setLoadingNodes(false);
      const first = data?.[0];
      if (first) setSelection(`${first.node.id}/${first.profiles[0]}`);
    });
    return () => { current = false; };
  }, [actions, projectId]);
  const queryValid = ProjectResearchQuery.safeParse(query.trim()).success;
  const prepare = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !selection || !queryValid) return;
    const [nodeId, profileId] = selection.split("/");
    if (!nodeId || !profileId) return;
    setBusy(true);
    await actions.research.prepare({ projectId, nodeId, profileId, query: query.trim() });
    if (active.current) setBusy(false);
  };
  return <div className="research-workspace">
    <p className="side-note">输入想查找的公开资料，先预览并批准，再执行一次搜索和最多一次网页读取。取回的原文存入本项目，使用前可单独查看。</p>
    <form onSubmit={prepare} className="research-form">
      <label className="field-label">检索节点<select aria-label="检索节点" value={selection} onChange={(e) => setSelection(e.target.value)} disabled={busy || loadingNodes}>
        <option value="">{loadingNodes ? "检查已配置节点…" : "请选择"}</option>
        {choices?.flatMap(({ node, profiles }) => profiles.map((profile) => <option key={`${node.id}/${profile}`} value={`${node.id}/${profile}`}>{node.label} · {profile}</option>))}
      </select></label>
      {!loadingNodes && !choices?.length && <p className="field-note">暂无支持检索的节点。请在设置中配置或更新节点后，重新打开此面板。</p>}
      <label className="field-label">查询<input aria-label="资料检索查询" value={query} maxLength={256} onChange={(e) => setQuery(e.target.value)} disabled={busy} placeholder="要查找的公开资料，最多 128 字" /></label>
      <span className="side-note">{Array.from(query.trim()).length} / 128 字 · 准备预览不会调用付费搜索</span>
      <button className="button-primary" type="submit" disabled={busy || !selection || !queryValid}>{busy ? "准备中…" : "准备检索预览"}</button>
    </form>
    {history.previews.filter((preview) => preview.approval.state === "READY_FOR_REVIEW").map((preview) => <PendingResearch key={preview.approval.id} preview={preview} />)}
    {history.results.length > 0 && <h3>检索记录</h3>}
    {history.results.map((result) => <ResearchResult key={result.run.id} result={result} />)}
  </div>;
}

export function ResearchApprovalView({ preview, busy, stale, onApprove, onReject }: { preview: ProjectResearchPreview; busy: boolean; stale: boolean; onApprove: () => void; onReject: () => void }) {
  return <article className="research-approval" aria-label="检索批准预览">
    <h3>确认这次检索</h3>
    <pre className="research-query">{preview.plan.query}</pre>
    <dl className="source-usage"><div><dt>节点地址</dt><dd>{preview.plan.target.baseUrl}</dd></div><div><dt>执行方式</dt><dd>{preview.plan.target.profileId}</dd></div><div><dt>调用上限</dt><dd>1 次搜索 + 最多 1 次网页读取</dd></div><div><dt>费用</dt><dd>未知，以服务商实际账单为准</dd></div></dl>
    <details><summary>查看内容指纹</summary><p className="hash">查询：{preview.snapshot.contentHash}</p><p className="hash">检索计划：{preview.researchHash}</p></details>
    {stale && <p className="field-error" role="alert">这份检索预览已失效，请退回后重新准备。</p>}
    <div className="decision-row"><button className="button-seal" type="button" disabled={busy || stale} onClick={onApprove}>批准并检索</button><button className="button-quiet" type="button" disabled={busy} onClick={onReject}>退回</button></div>
  </article>;
}

function PendingResearch({ preview }: { preview: ProjectResearchPreview }) {
  const actions = useActions(), [busy, setBusy] = useState(false);
  const stale = useAppState((s) => s.staleApprovalIds.includes(preview.approval.id));
  const decide = async (approve: boolean) => {
    if (busy) return;
    setBusy(true);
    if (approve) await actions.research.approve(preview); else await actions.reject(preview.approval.id, undefined);
    setBusy(false);
  };
  return <ResearchApprovalView preview={preview} busy={busy} stale={stale} onApprove={() => void decide(true)} onReject={() => void decide(false)} />;
}

export function ResearchResult({ result }: { result: QueryResponse<"research.result"> }) {
  const actions = useActions(), [busy, setBusy] = useState(false);
  const original = useAppState((s) => s.messages.find((m) => m.id === result.originalMessageId));
  const active = ["QUEUED", "STARTING", "RUNNING"].includes(result.run.state);
  return <article className="research-result" aria-label="项目检索结果">
    <header><strong>{result.plan.query}</strong><span>{RUN_STATE_LABEL[result.run.state]}</span>{active && <button type="button" className="button-quiet" disabled={busy} onClick={() => { setBusy(true); void actions.cancelRun(result.run.id).finally(() => setBusy(false)); }}>取消检索</button>}</header>
    {result.run.failureReason && <p className="field-error">{FAILURE_REASON_LABEL[result.run.failureReason]}</p>}
    {result.originalMessageId ? <p className="side-note">已保存取回的原文。原文会保留在项目资料中，可供选择片段；尚未加入讨论。</p> : <p className="side-note">{active ? "正在等待完整原文。" : result.run.state === "COMPLETED" ? "本次搜索未取回可保存的原文。" : "本次未保存原文。"}</p>}
    <ResultDisplayView blocks={result.blocks} />
    {original && <CurrentSourceReferences projectId={result.plan.projectId} owner={{ kind: "message", id: original.id }} references={original.sourceRefs} />}
  </article>;
}
