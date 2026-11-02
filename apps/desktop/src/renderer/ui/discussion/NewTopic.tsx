import { useState, type CSSProperties, type FormEvent } from "react";
import { useActions, useAppState } from "../hooks";

/**
 * 新议题（C-33b，草案「新议题」）：名字、想讨论什么（作为第一条发言）、参与者、先写一版方案。
 * 创建本身不发给任何人——第一轮写好任务后，照常先看内容、再盖章发送。
 * 「材料」只有从聊天转议题时才有（chat.toTopic），这里不另加上传。
 */
export function NewTopic() {
  const agents = useAppState((s) => s.disc.agents.filter((a) => a.canDiscuss));
  const summarizer = useAppState((s) => s.disc.agents.find((a) => a.canSummarize));
  const recipients = useAppState((s) => s.disc.ui.composer.recipients);
  const actions = useActions();
  const [name, setName] = useState("");
  const [first, setFirst] = useState("");
  const [withPlan, setWithPlan] = useState(false);
  const [plan, setPlan] = useState("");
  const [busy, setBusy] = useState(false);

  const ok = name.trim() !== "" && (!withPlan || plan.trim() !== "") && !busy;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ok) return;
    setBusy(true);
    try {
      // 建失败（或没切过去）时，下面这些不能写到别的议题里去
      const created = await actions.createProject(name.trim());
      if (!created) return;
      // 每一步前都核一次：中途切到别的议题就停，不写进别人那里
      const still = () => actions.isCurrentProject(created.id);
      if (first.trim() && still()) {
        actions.setComposerText(first.trim());
        await actions.addNote();
      }
      if (withPlan && still()) await actions.createPlan(plan.trim(), "你写的第一版");
      if (still()) actions.closeReview();
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="new-topic" onSubmit={(e) => void submit(e)} aria-labelledby="new-topic-title">
      <header className="sheet-head">
        <button type="button" className="button-link" onClick={actions.closeReview}>取消</button>
        <h1 id="new-topic-title">新议题</h1>
        <button type="submit" className="button-primary sheet-done" disabled={!ok}>{busy ? "创建中…" : "创建"}</button>
      </header>

      <div className="sheet-group">
        <label className="sheet-field">
          <span>议题名称</span>
          <input autoFocus value={name} maxLength={200} placeholder="比如：聊天空间 1B" onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="sheet-field">
          <span>想讨论什么（会作为第一条发言）</span>
          <textarea rows={4} value={first} maxLength={20_000} placeholder="可以不写，之后在议题里再说" onChange={(e) => setFirst(e.target.value)} />
        </label>
      </div>

      <h2 className="sheet-label">参与者</h2>
      <div className="sheet-group sheet-chips">
        {agents.map((a) => (
          <label key={a.id} className="recipient-chip" style={{ "--agent": a.color } as CSSProperties}>
            <input type="checkbox" checked={recipients.includes(a.id)} onChange={() => actions.toggleRecipient(a.id)} />
            {a.displayName}
            {a.id === summarizer?.id ? " · 汇总" : ""}
          </label>
        ))}
        {agents.length === 0 && <p className="side-note">还没有能参加讨论的秘书，去「秘书」页配一下。</p>}
      </div>

      <div className="sheet-group">
        <label className="sheet-switch">
          <span>
            <b>先写一版方案</b>
            <small>不写的话，第一轮汇总后由{summarizer ? ` ${summarizer.displayName}` : "汇总的人"}起草 v1</small>
          </span>
          <input type="checkbox" role="switch" checked={withPlan} onChange={(e) => setWithPlan(e.target.checked)} />
        </label>
        {withPlan && (
          <label className="sheet-field">
            <span>方案 v1</span>
            <textarea rows={6} value={plan} placeholder={"# 方案\n1. …"} onChange={(e) => setPlan(e.target.value)} />
          </label>
        )}
      </div>

      <p className="side-note sheet-foot">创建议题不会发给任何人。第一轮写好任务后，照常先看内容、再盖章发送。</p>
    </form>
  );
}
