import { useState, type FormEvent } from "react";
import { currentProject } from "../lib/state";
import { useActions, useAppState, useIsMock } from "./hooks";
import { SourceStep } from "./SourceStep";
import { FragmentPicker, PromptStep } from "./PromptStep";
import { ResultStep, RunList } from "./ResultStep";
import { SettingsView } from "./SettingsView";
import { DiscussionView, QuotaChips } from "./discussion/DiscussionView";
import { ChatView } from "./chat/ChatView";
import { ConsoleView } from "./ConsoleView";

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
  return <Shell />;
}

function Shell() {
  const view = useAppState((s) => s.view);
  if (view === "chat") {
    return (
      <div className="shell shell-chat">
        <TopBar />
        <ChatView notice={<Notice />} />
      </div>
    );
  }
  if (view === "console") {
    return (
      <div className="shell shell-console">
        <TopBar />
        <ConsoleView notice={<Notice />} />
      </div>
    );
  }
  if (view === "discussion") {
    return (
      <div className="shell shell-discussion">
        <TopBar />
        <DiscussionView notice={<Notice />} />
      </div>
    );
  }
  return (
    <div className="shell">
      <TopBar />
      <ProjectRail />
      <Desk />
      <RunLog />
    </div>
  );
}

function Desk() {
  const view = useAppState((s) => s.view);
  return (
    <main className="desk">
      <Notice />
      {view === "settings" ? (
        <SettingsView />
      ) : (
        <>
          <ReviewerSetupHint />
          <Workflow />
        </>
      )}
    </main>
  );
}

/** 还没设置 Reviewer 节点时，在工作台顶部提示一次 */
function ReviewerSetupHint() {
  const configured = useAppState((s) => s.status?.reviewerConfigured ?? true);
  const actions = useActions();
  if (configured) return null;
  return (
    <div className="setup-hint">
      <p>还没有设置 Reviewer 节点。可以先整理原文和片段，批准发送前需要设置好。</p>
      <button type="button" className="button-outline" onClick={() => void actions.openSettings()}>
        去设置
      </button>
    </div>
  );
}

function TopBar() {
  const project = useAppState(currentProject);
  const status = useAppState((s) => s.status);
  const view = useAppState((s) => s.view);
  const actions = useActions();
  const isMock = useIsMock();
  return (
    <header className="topbar">
      <span className="wordmark">Agent 评审室</span>
      {(view === "desk" || view === "settings") && <span className="topbar-project">{project?.name ?? "未选择项目"}</span>}
      {isMock && (
        <span className="mock-flag" title="数据只存在内存里，不会调用真实的 Reviewer">
          演示数据
        </span>
      )}
      {view === "discussion" && <QuotaChips />}
      {(view === "desk" || view === "settings") && status && (
        <span className="reviewer-status" data-ok={status.reviewerConfigured}>
          Reviewer：{status.reviewerConfigured ? status.reviewerAgent : "未设置节点"}
        </span>
      )}
      <nav className="topnav" aria-label="主导航">
        <button type="button" aria-current={view === "chat" ? "page" : undefined} onClick={actions.goChat}>
          聊天
          <ChatUnread />
        </button>
        <button type="button" aria-current={view === "discussion" ? "page" : undefined} onClick={actions.goDiscussion}>
          讨论
        </button>
        <button type="button" disabled title="阶段 1C">
          执行
        </button>
        <button type="button" aria-current={view === "console" ? "page" : undefined} onClick={() => void actions.agentConsole.open()}>
          秘书
        </button>
        <button type="button" aria-current={view === "desk" ? "page" : undefined} onClick={actions.goDesk}>
          单次评审
        </button>
        <button
          type="button"
          aria-current={view === "settings" ? "page" : undefined}
          onClick={() => (view === "settings" ? actions.closeSettings() : void actions.openSettings())}
        >
          设置
        </button>
      </nav>
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

/** 顶栏「聊天」上的未读数（免打扰的会话不算） */
function ChatUnread() {
  const n = useAppState((s) => (s.chat.list ?? []).reduce((sum, x) => sum + (x.conversation.muted ? 0 : x.unreadCount), 0));
  if (!n) return null;
  return <span className="chat-badge" aria-label={`${n} 条未读`}>{n > 99 ? "99+" : n}</span>;
}

export function Notice() {
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
