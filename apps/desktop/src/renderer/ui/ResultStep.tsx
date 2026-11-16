import { useEffect, useState } from "react";
import { RUN_TRANSITIONS, canTransition, type Run } from "@room/schemas";
import { runTranscript, selectedRun, terminalEvent } from "../lib/state";
import { useActions, useAppState } from "./hooks";
import { FAILURE_REASON_LABEL, RUN_STATE_LABEL, formatClock, formatDuration, formatTime, runTone } from "./labels";
import { SourceReferences } from "./SourceReferences";

/** 第 4 步：查看当前选中（默认最新）的评审结果 */
export function ResultStep() {
  const run = useAppState(selectedRun);
  if (!run) {
    return <p className="step-empty">批准一份 prompt 后，Reviewer 的回复会显示在这里。</p>;
  }
  return <RunDetail key={run.id} run={run} />;
}

function RunDetail({ run }: { run: Run }) {
  const actions = useActions();
  const transcript = useAppState((s) => runTranscript(s, run.id));
  const terminal = useAppState((s) => terminalEvent(s, run.id));
  const references = useAppState((s) => s.messages.find((m) => "runId" in m && m.runId === run.id)?.sourceRefs);
  const [cancelling, setCancelling] = useState(false);
  const canCancel = canTransition(RUN_TRANSITIONS, run.state, "CANCELLED") && !cancelling;
  const tone = runTone(run.state);

  const cancel = async () => {
    setCancelling(true);
    await actions.cancelRun(run.id);
    setCancelling(false);
  };

  let statusLine: string;
  switch (run.state) {
    case "QUEUED":
    case "STARTING":
      statusLine = "正在连接 Reviewer…";
      break;
    case "RUNNING":
      statusLine = transcript.source === "empty" ? "Reviewer 正在思考…" : "Reviewer 正在回复…";
      break;
    case "COMPLETED":
      statusLine = "评审完成，结果已保存。";
      break;
    case "CANCELLED":
      statusLine = `已取消${terminal?.type === "cancelled" && terminal.reason ? `（${terminal.reason}）` : ""}。`;
      break;
    case "TIMED_OUT":
      statusLine =
        terminal?.type === "timed_out" && terminal.kind === "idle"
          ? "Reviewer 长时间没有任何输出，已停止。"
          : "评审超过了总时长上限，已停止。";
      break;
    case "FAILED":
      statusLine = run.failureReason ? FAILURE_REASON_LABEL[run.failureReason] : "评审失败。";
      // 有具体错误信息时接在后面："Reviewer 调用出错：HTTP 529 …"
      if (terminal?.type === "error" && terminal.message) statusLine = `${statusLine.replace(/。$/, "")}：${terminal.message}`;
      break;
  }

  return (
    <article className="result" data-tone={tone} aria-label="评审结果">
      <header className="result-head">
        <span className="result-state">{RUN_STATE_LABEL[run.state]}</span>
        <time dateTime={run.createdAt}>{formatTime(run.createdAt)}</time>
        {run.startedAt && run.finishedAt && <span>用时 {formatDuration(run.startedAt, run.finishedAt)}</span>}
        {canCancel && (
          <button type="button" className="button-quiet result-cancel" onClick={cancel}>
            {cancelling ? "取消中…" : "取消评审"}
          </button>
        )}
      </header>

      <p className="result-status" role="status">
        {statusLine}
      </p>

      {transcript.source === "partial" && <p className="field-note">评审没有完成，下面是中断前收到的部分。</p>}

      {transcript.source !== "empty" && (
        <pre className="result-text" data-source={transcript.source}>
          {transcript.text}
        </pre>
      )}

      <SentPrompt snapshotId={run.snapshotId} />
      <SourceReferences references={references} />
    </article>
  );
}

/** 折叠显示"当时实际发出去的 prompt"：Snapshot 不可变，所以这就是当时发送的原文 */
function SentPrompt({ snapshotId }: { snapshotId: string }) {
  const actions = useActions();
  const [open, setOpen] = useState(false);
  const snapshot = useAppState((s) => s.snapshots[snapshotId]);

  useEffect(() => {
    if (open) void actions.ensureSnapshot(snapshotId);
  }, [open, actions, snapshotId]);

  return (
    <div className="sent-prompt">
      <button type="button" className="button-quiet prompt-expand" aria-expanded={open} onClick={() => setOpen((x) => !x)}>
        {open ? "收起发送的 prompt" : "查看当时发送的 prompt"}
      </button>
      {open &&
        (snapshot ? (
          <>
            <p className="sent-prompt-meta">
              指纹 <span className="hash" title={snapshot.contentHash} data-hash={snapshot.contentHash}>{snapshot.contentHash.slice(0, 12)}</span>
            </p>
            <pre className="prompt-text">{snapshot.content}</pre>
            <SourceReferences references={snapshot.sourceRefs} />
          </>
        ) : (
          <p className="step-empty">正在读取…</p>
        ))}
    </div>
  );
}

/** 右栏：所有运行，点击切换第 4 步显示哪一个 */
export function RunList() {
  const runs = useAppState((s) => s.runs);
  const current = useAppState(selectedRun);
  const actions = useActions();
  const sorted = [...runs].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));

  if (sorted.length === 0) return <p className="step-empty">批准后，每次评审都会出现在这里。</p>;
  return (
    <ul className="run-list">
      {sorted.map((r) => (
        <li key={r.id}>
          <button
            type="button"
            className="run"
            data-tone={runTone(r.state)}
            aria-current={r.id === current?.id ? "true" : undefined}
            onClick={() => actions.selectRun(r.id)}
          >
            <span className="run-state">{RUN_STATE_LABEL[r.state]}</span>
            <time className="run-time" dateTime={r.createdAt}>
              {formatClock(r.createdAt)}
            </time>
          </button>
        </li>
      ))}
    </ul>
  );
}
