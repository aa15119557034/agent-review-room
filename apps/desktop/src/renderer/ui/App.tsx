import { useState, type FormEvent } from "react";
import { currentProject, runsNewestFirst } from "../lib/state";
import { useActions, useAppState, useIsMock } from "./hooks";
import {
  APPROVAL_STATE_LABEL,
  CONTRIBUTION_TYPE_LABEL,
  RUN_STATE_LABEL,
  formatTime,
  runTone,
} from "./labels";

/**
 * C-02：整体布局 + 只读数据展示。
 * 三个工作步骤的交互（粘贴与选取、生成 prompt、审批与运行）分别由 C-03 / C-04 / C-05 填充。
 */
export function App() {
  const connection = useAppState((s) => s.connection);
  if (connection.phase === "connecting") return <div className="splash">正在连接后端…</div>;
  if (connection.phase === "failed") {
    return (
      <div className="splash splash-failed" role="alert">
        <h1>无法连接后端</h1>
        <p>{connection.message}</p>
        <p>请重启应用。如果一直出现，把这段文字发给开发者。</p>
      </div>
    );
  }
  return (
    <div className="shell">
      <TopBar />
      <ProjectRail />
      <main className="desk">
        <Notice />
        <Workflow />
      </main>
      <RunLog />
    </div>
  );
}

function TopBar() {
  const project = useAppState(currentProject);
  const status = useAppState((s) => s.status);
  const isMock = useIsMock();
  return (
    <header className="topbar">
      <span className="wordmark">Agent 评审室</span>
      <span className="topbar-project">{project?.name ?? "未选择项目"}</span>
      {isMock && (
        <span className="mock-flag" title="数据只存在内存里，不会调用真实的 Reviewer">
          演示数据
        </span>
      )}
      {status && (
        <span className="reviewer-status" data-ok={status.reviewerConfigured}>
          Reviewer：{status.reviewerAgent}
          {status.reviewerConfigured ? "" : "（未配置 API key）"}
        </span>
      )}
    </header>
  );
}

function ProjectRail() {
  const projects = useAppState((s) => s.projects);
  const currentId = useAppState((s) => s.currentProjectId);
  const actions = useActions();
  const [name, setName] = useState("");

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    void actions.createProject(trimmed);
    setName("");
  };

  return (
    <nav className="rail" aria-label="项目">
      <h2 className="rail-heading">项目</h2>
      <ul className="rail-list">
        {projects.map((p) => (
          <li key={p.id}>
            <button
              type="button"
              className="rail-item"
              aria-current={p.id === currentId ? "page" : undefined}
              onClick={() => void actions.selectProject(p.id)}
            >
              {p.name}
            </button>
          </li>
        ))}
      </ul>
      <form className="rail-new" onSubmit={submit}>
        <label htmlFor="new-project">新建项目</label>
        <input
          id="new-project"
          value={name}
          maxLength={200}
          placeholder="项目名称"
          onChange={(e) => setName(e.target.value)}
        />
        <button type="submit" disabled={!name.trim()}>
          创建
        </button>
      </form>
    </nav>
  );
}

function Notice() {
  const notice = useAppState((s) => s.notice);
  const actions = useActions();
  if (!notice) return null;
  return (
    <div className="notice" role="alert">
      <p>{notice.message}</p>
      <button type="button" onClick={actions.dismissNotice}>
        知道了
      </button>
    </div>
  );
}

/** 三个步骤确实是有先后顺序的流程，所以用编号 */
function Workflow() {
  const projectId = useAppState((s) => s.currentProjectId);
  const messages = useAppState((s) => s.messages);
  const contributions = useAppState((s) => s.contributions);
  const approvals = useAppState((s) => s.approvals);

  if (!projectId) {
    return (
      <section className="empty-desk">
        <h1>从左边新建一个项目开始</h1>
        <p>每个项目里：粘贴 Agent 的输出，挑出值得评审的片段，生成 prompt，你批准后才会发给 Reviewer。</p>
      </section>
    );
  }

  const sources = messages.filter((m) => m.kind === "source_input");

  return (
    <ol className="steps">
      <li className="step">
        <h2 className="step-title">
          <span className="step-no">1</span>原文
        </h2>
        {sources.length === 0 ? (
          <p className="step-empty">还没有原文。把 Agent 的输出粘贴进来。</p>
        ) : (
          <ul className="source-list">
            {sources.map((m) => (
              <li key={m.id} className="source">
                <div className="source-meta">
                  <span className="source-agent">{m.kind === "source_input" ? m.sourceAgent : ""}</span>
                  <time dateTime={m.createdAt}>{formatTime(m.createdAt)}</time>
                </div>
                <pre className="source-text">{m.content}</pre>
              </li>
            ))}
          </ul>
        )}
      </li>

      <li className="step">
        <h2 className="step-title">
          <span className="step-no">2</span>片段
        </h2>
        {contributions.length === 0 ? (
          <p className="step-empty">在原文里选中值得评审的一段，标记成片段。</p>
        ) : (
          <ul className="fragment-list">
            {contributions.map((c) => (
              <li key={c.id} className="fragment">
                <span className="fragment-type">{CONTRIBUTION_TYPE_LABEL[c.type]}</span>
                <span className="fragment-title">{c.title}</span>
                <blockquote className="fragment-quote">{c.content}</blockquote>
              </li>
            ))}
          </ul>
        )}
      </li>

      <li className="step">
        <h2 className="step-title">
          <span className="step-no">3</span>Prompt 与审批
        </h2>
        {approvals.length === 0 ? (
          <p className="step-empty">选好片段后生成 prompt，确认无误再批准发送。</p>
        ) : (
          <ul className="approval-list">
            {approvals.map((a) => (
              <li key={a.id} className="approval" data-state={a.state}>
                <span>{APPROVAL_STATE_LABEL[a.state]}</span>
                <span className="approval-time">{formatTime(a.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </li>
    </ol>
  );
}

function RunLog() {
  const runs = useAppState(runsNewestFirst);
  return (
    <aside className="runlog" aria-label="运行记录">
      <h2 className="rail-heading">运行记录</h2>
      {runs.length === 0 ? (
        <p className="step-empty">批准后，每次评审都会出现在这里。</p>
      ) : (
        <ul className="run-list">
          {runs.map((r) => (
            <li key={r.id} className="run" data-tone={runTone(r.state)}>
              <span className="run-state">{RUN_STATE_LABEL[r.state]}</span>
              <span className="run-time">{formatTime(r.createdAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
