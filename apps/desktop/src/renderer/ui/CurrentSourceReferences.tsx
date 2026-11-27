import React, { useEffect, useRef, useState } from "react";
import type { ProjectSourcePreview, ProjectSourcesCurrent, SourceReference } from "@room/schemas";
import { useActions, useAppState } from "./hooks";
import { SourceReferenceCard } from "./SourceReferences";

const currentLabel = { readable: "当前可读", missing: "当前缺少原文", revoked: "当前已撤回" };

export function CurrentSourceReferences(props: { projectId: string; owner: ProjectSourcesCurrent["owner"]; references?: readonly SourceReference[] }) {
  const revision = useAppState((s) => s.sourceRevision);
  const projectId = useAppState((s) => s.currentProjectId);
  if (!props.references?.length || projectId !== props.projectId) return null;
  return <SourceOwner key={`${projectId}:${props.owner.kind}:${props.owner.id}:${revision}`} {...props} />;
}

function SourceOwner({ projectId, owner, references }: { projectId: string; owner: ProjectSourcesCurrent["owner"]; references?: readonly SourceReference[] }) {
  const actions = useActions();
  const [current, setCurrent] = useState<ProjectSourcesCurrent | null>(null);
  const [checked, setChecked] = useState(false);
  useEffect(() => {
    let active = true;
    void actions.research.currentSources(projectId, owner).then((result) => { if (active) { setCurrent(result ?? null); setChecked(true); } });
    return () => { active = false; };
  }, [actions, projectId, owner.kind, owner.id]);
  return <section className="source-references" aria-label="当前引用来源">
    <h3>引用来源</h3>
    {!current && <p className="side-note" role="status">{checked ? "暂时无法检查当前状态，请重新打开此预览。" : "正在检查当前来源…"}</p>}
    {references?.map((reference, index) => <CurrentSource key={index} projectId={projectId} owner={owner} index={index} reference={reference} current={current?.sources[index]} />)}
  </section>;
}

function CurrentSource({ projectId, owner, index, reference, current }: { projectId: string; owner: ProjectSourcesCurrent["owner"]; index: number; reference: SourceReference; current?: ProjectSourcesCurrent["sources"][number] }) {
  const actions = useActions(), alive = useRef(true);
  const [preview, setPreview] = useState<ProjectSourcePreview | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const status = preview?.status ?? current?.currentStatus;
  const open = async () => {
    if (busy || status !== "readable") return;
    setBusy(true);
    const result = await actions.research.previewSource(projectId, owner, index);
    if (alive.current) { setPreview(result ?? null); setBusy(false); }
  };
  return <div className="source-current">
    <SourceReferenceCard reference={reference} />
    <p className="source-current-state" role="status">{status ? currentLabel[status] : "当前状态尚未确认"}</p>
    {status && status !== "readable" && <p className="side-note">请补充可用资料后重新生成预览。历史记录保留，正文不能继续预览。</p>}
    <button type="button" className="button-quiet" disabled={busy || status !== "readable"} onClick={() => preview?.status === "readable" ? setPreview(null) : void open()}>{busy ? "检查原文…" : preview?.status === "readable" ? "收起原文" : "查看已存原文"}</button>
    {preview?.status === "readable" && <pre className="source-original-text">{preview.content}</pre>}
  </div>;
}
