import { useState, type FormEvent } from "react";
import { currentProject } from "../lib/state";
import { useActions, useAppState, useIsMock } from "./hooks";
import { SourceStep } from "./SourceStep";
import { FragmentPicker, PromptStep } from "./PromptStep";
import { ResultStep, RunList } from "./ResultStep";

/**
 * 整体布局：项目 / 四个工作步骤 / 运行记录。
 * 1 原文（SourceStep）→ 2 片段 → 3 Prompt 与审批（PromptStep）→ 4 评审结果（ResultStep）
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

/** 四个步骤确实是有先后顺序的流程，所以用编号 */
function Workflow() {
  const projectId = useAppState((s) => s.currentProjectId);

  if (!projectId) {
    return (
      <section className="empty-desk">
        <h1>从左边新建一个项目开始</h1>
        <p>每个项目里：粘贴 Agent 的输出，挑出值得评审的片段，生成 prompt，你批准后才会发给 Reviewer。</p>
      </section>
    );
  }

  return (
    <ol className="steps">
      <li className="step">
        <h2 className="step-title">
          <span className="step-no">1</span>原文
        </h2>
        <SourceStep />
      </li>

      <li className="step">
        <h2 className="step-title">
          <span className="step-no">2</span>片段
        </h2>
        <FragmentPicker />
      </li>

      <li className="step">
        <h2 className="step-title">
          <span className="step-no">3</span>Prompt 与审批
        </h2>
        <PromptStep />
      </li>

      <li className="step" id="step-result">
        <h2 className="step-title">
          <span className="step-no">4</span>评审结果
        </h2>
        <ResultStep />
      </li>
    </ol>
  );
}

function RunLog() {
  return (
    <aside className="runlog" aria-label="运行记录">
      <h2 className="rail-heading">运行记录</h2>
      <RunList />
    </aside>
  );
}
