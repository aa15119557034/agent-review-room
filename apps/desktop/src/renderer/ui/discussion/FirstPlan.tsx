import { useState } from "react";
import { useActions } from "../hooks";

/**
 * 议题还没有任何方案时，自己写第一版（C-28 plan.create）。
 * 汇总没有给出方案、或者想先定个框架再讨论时用。存成 v1 草稿，之后照常确认、定稿。
 */
export function FirstPlan({ compact = false }: { compact?: boolean }) {
  const actions = useActions();
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  if (!open) {
    return compact ? (
      <button type="button" className="button-outline" onClick={() => setOpen(true)}>自己写第一版</button>
    ) : (
      <button type="button" className="action-card" onClick={() => setOpen(true)}>
        <b>自己写第一版方案</b>
        <span>存成 v1 草稿，之后照常确认、定稿；下一轮会附带它</span>
      </button>
    );
  }

  return (
    <form
      className="plan-edit"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        const p = await actions.createPlan(content.trim(), note.trim() || "你写的第一版");
        setBusy(false);
        if (p) setOpen(false);
      }}
    >
      <label htmlFor={compact ? "plan-first-side" : "plan-first"}>方案内容</label>
      <textarea
        id={compact ? "plan-first-side" : "plan-first"}
        rows={compact ? 6 : 10}
        value={content}
        placeholder={"# 方案\n1. …"}
        onChange={(e) => setContent(e.target.value)}
      />
      <label htmlFor={compact ? "plan-first-note-side" : "plan-first-note"}>说明（给以后的自己看，可不填）</label>
      <input id={compact ? "plan-first-note-side" : "plan-first-note"} value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} />
      <div className="settings-actions">
        <button type="submit" className="button-primary" disabled={!content.trim() || busy}>{busy ? "保存中…" : "存成 v1 草稿"}</button>
        <button type="button" className="button-quiet" onClick={() => setOpen(false)}>取消</button>
      </div>
    </form>
  );
}
