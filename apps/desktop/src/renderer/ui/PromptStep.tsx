import { useEffect, useState, type FormEvent } from "react";
import { APPROVAL_TRANSITIONS, canTransition, type Approval, type PromptSnapshot } from "@room/schemas";
import { decidedApprovals, readyApproval } from "../lib/state";
import { useActions, useAppState } from "./hooks";
import { APPROVAL_STATE_LABEL, CONTRIBUTION_TYPE_LABEL, RUN_STATE_LABEL, formatTime } from "./labels";
import { SourceReferences } from "./SourceReferences";

// ------------------------------------------------------------ 第 2 步：勾选片段

export function FragmentPicker() {
  const contributions = useAppState((s) => s.contributions);
  const selected = useAppState((s) => s.draft.contributionIds);
  const actions = useActions();

  if (contributions.length === 0) {
    return <p className="step-empty">在上面的原文里选中值得评审的一段，标记成片段。</p>;
  }
  return (
    <>
      <p className="step-hint">勾选的片段会放进下一步的 prompt。</p>
      <ul className="fragment-list">
        {contributions.map((c) => {
          const checked = selected.includes(c.id);
          return (
            <li key={c.id} className="fragment" data-checked={checked}>
              <input
                type="checkbox"
                className="fragment-check"
                id={`pick-${c.id}`}
                checked={checked}
                onChange={() => actions.toggleDraftContribution(c.id)}
              />
              <label htmlFor={`pick-${c.id}`} className="fragment-head">
                <span className="fragment-type">{CONTRIBUTION_TYPE_LABEL[c.type]}</span>
                <span className="fragment-title">{c.title}</span>
              </label>
              <blockquote className="fragment-quote">{c.content}</blockquote>
            </li>
          );
        })}
      </ul>
    </>
  );
}

// ------------------------------------------------------------ 第 3 步：生成 prompt 与审批

export function PromptStep() {
  const ready = useAppState(readyApproval);
  const decided = useAppState(decidedApprovals);
  return (
    <>
      <PromptComposer hasPending={ready !== null} />
      {ready && <PendingApproval key={ready.id} approval={ready} />}
      {decided.length > 0 && (
        <section className="decided" aria-label="审批记录">
          <h3 className="decided-heading">审批记录</h3>
          <ul className="decided-list">
            {decided.map((a) => (
              <DecidedRow key={a.id} approval={a} />
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function PromptComposer({ hasPending }: { hasPending: boolean }) {
  const actions = useActions();
  const task = useAppState((s) => s.draft.taskInstruction);
  const count = useAppState((s) => s.contributions.filter((c) => s.draft.contributionIds.includes(c.id)).length);
  const [busy, setBusy] = useState(false);
  const canSubmit = count > 0 && task.trim().length > 0 && !busy;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    await actions.createSnapshot();
    setBusy(false);
  };

  return (
    <form className="prompt-composer" onSubmit={submit}>
      <label className="field-label" htmlFor="task-instruction">
        评审任务
      </label>
      <textarea
        id="task-instruction"
        className="source-input task-input"
        rows={3}
        maxLength={20_000}
        value={task}
        onChange={(e) => actions.setTaskInstruction(e.target.value)}
      />
      <div className="composer-row">
        <span className="composer-count">
          {count === 0 ? "还没有勾选片段" : `已勾选 ${count} 个片段`}
        </span>
        {hasPending && <span className="field-note">重新生成会让下面这份待批准的 prompt 失效</span>}
        <button type="submit" className="button-primary" disabled={!canSubmit}>
          {busy ? "生成中…" : hasPending ? "重新生成 prompt" : "生成 prompt"}
        </button>
      </div>
    </form>
  );
}

function PendingApproval({ approval }: { approval: Approval }) {
  const actions = useActions();
  const snapshot = useAppState((s) => s.snapshots[approval.snapshotId]);
  const reviewerConfigured = useAppState((s) => s.status?.reviewerConfigured ?? false);
  const stale = useAppState((s) => s.staleApprovalIds.includes(approval.id));
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    void actions.ensureSnapshot(approval.snapshotId);
  }, [actions, approval.snapshotId]);

  const canDecide = snapshot !== undefined && busy === null;
  const canApprove = canDecide && !stale && reviewerConfigured && canTransition(APPROVAL_TRANSITIONS, approval.state, "APPROVED");

  const approve = async () => {
    if (!canApprove || !snapshot) return;
    setBusy("approve");
    // 带上"此刻屏幕上这份 prompt"的 hash：后端发现不一致会拒绝
    const run = await actions.approve(approval.id, snapshot.contentHash);
    setBusy(null);
    // 批准后把视线带到第 4 步，看 Reviewer 的回复
    if (run) {
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      document.getElementById("step-result")?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
    }
  };

  const reject = async (e: FormEvent) => {
    e.preventDefault();
    if (!canDecide) return;
    setBusy("reject");
    await actions.reject(approval.id, reason.trim() || undefined);
    setBusy(null);
  };

  return (
    <article className="pending" aria-label="等待批准的 prompt">
      <header className="pending-head">
        <span className="pending-state">{APPROVAL_STATE_LABEL[approval.state]}</span>
        <time dateTime={approval.createdAt}>{formatTime(approval.createdAt)}</time>
      </header>

      {!snapshot ? (
        <p className="step-empty pending-loading">正在读取 prompt…</p>
      ) : (
        <>
          <SnapshotFacts snapshot={snapshot} />
          <SourceReferences references={snapshot.sourceRefs} />
          <pre className="prompt-text" data-expanded={expanded}>
            {snapshot.content}
          </pre>
          <button type="button" className="button-quiet prompt-expand" onClick={() => setExpanded((x) => !x)}>
            {expanded ? "收起" : "展开全文"}
          </button>
        </>
      )}

      {stale && <p className="field-error" role="alert">这份预览或引用资料已经失效。请更新资料，并在上方重新生成 prompt 后再批准；不会重发这份旧预览。</p>}

      {!reviewerConfigured && (
        <p className="field-error">
          还没有设置 Reviewer 节点，暂时不能批准。{" "}
          <button type="button" className="link-button" onClick={() => void actions.openSettings()}>
            去设置
          </button>
        </p>
      )}

      {rejecting ? (
        <form className="reject-form" onSubmit={reject}>
          <label className="field-inline field-grow">
            退回原因（可不填）
            <input value={reason} maxLength={2000} onChange={(e) => setReason(e.target.value)} autoFocus />
          </label>
          <button type="submit" className="button-primary" disabled={!canDecide}>
            {busy === "reject" ? "退回中…" : "确认退回"}
          </button>
          <button type="button" className="button-quiet" onClick={() => setRejecting(false)}>
            取消
          </button>
        </form>
      ) : (
        <div className="decision-row">
          <button type="button" className="button-seal" disabled={!canApprove} onClick={approve}>
            {busy === "approve" ? "发送中…" : "批准并发送"}
          </button>
          <button type="button" className="button-quiet" disabled={!canDecide} onClick={() => setRejecting(true)}>
            退回
          </button>
          <span className="decision-note">批准后，上面这份 prompt 会原样发给 Reviewer。</span>
        </div>
      )}
    </article>
  );
}

function SnapshotFacts({ snapshot }: { snapshot: PromptSnapshot }) {
  return (
    <dl className="facts">
      <div>
        <dt>片段</dt>
        <dd>{snapshot.contributionIds.length} 个</dd>
      </div>
      <div>
        <dt>长度</dt>
        <dd>约 {snapshot.tokenEstimate.toLocaleString()} tokens</dd>
      </div>
      <div>
        <dt>发给</dt>
        <dd>{snapshot.reviewerAgent}</dd>
      </div>
      <div>
        <dt>指纹</dt>
        <dd className="hash" title={snapshot.contentHash} data-hash={snapshot.contentHash}>
          {snapshot.contentHash.slice(0, 12)}
        </dd>
      </div>
    </dl>
  );
}

function DecidedRow({ approval }: { approval: Approval }) {
  const actions = useActions();
  const run = useAppState((s) => s.runs.find((r) => r.approvalId === approval.id));
  // 刚刚批准的那一项播放一次盖章动画；从历史加载的不播放
  const fresh =
    approval.state === "APPROVED" &&
    approval.decidedAt !== null &&
    Date.now() - new Date(approval.decidedAt).getTime() < 4000;
  return (
    <li className="decided-row" data-state={approval.state}>
      <span className="decided-state">{APPROVAL_STATE_LABEL[approval.state]}</span>
      <time dateTime={approval.createdAt}>{formatTime(approval.createdAt)}</time>
      {approval.reason && <span className="decided-reason">{approval.reason}</span>}
      {run && (
        <button
          type="button"
          className="button-quiet decided-link"
          onClick={() => {
            actions.selectRun(run.id);
            document.getElementById("step-result")?.scrollIntoView({ block: "start" });
          }}
        >
          查看结果（{RUN_STATE_LABEL[run.state]}）
        </button>
      )}
      {approval.state === "APPROVED" && <Seal fresh={fresh} />}
    </li>
  );
}

/** 朱红印章：整个界面唯一的强烈颜色，只表示"人已经批准" */
function Seal({ fresh }: { fresh: boolean }) {
  return (
    <span className="seal" data-fresh={fresh} role="img" aria-label="已批准">
      准
    </span>
  );
}
