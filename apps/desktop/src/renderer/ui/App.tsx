import { useEffect, useState, type FormEvent } from "react";
import { currentProject } from "../lib/state";
import { useActions, useAppState, useIsMock } from "./hooks";
import { SourceStep } from "./SourceStep";
import { FragmentPicker, PromptStep } from "./PromptStep";
import { ResultStep, RunList } from "./ResultStep";
import { SettingsView } from "./SettingsView";
import { DiscussionBadge, DiscussionView } from "./discussion/DiscussionView";
import { ChatView } from "./chat/ChatView";
import { ConsoleView } from "./ConsoleView";
import { NotesSheetHost } from "./notes/NoteSheets";
import { WorldView } from "./world/WorldView";

/**
 * 整体布局：项目 / 四个工作步骤 / 运行记录。
 * 1 原文（SourceStep）→ 2 片段 → 3 Prompt 与审批（PromptStep）→ 4 评审结果（ResultStep）
 */
export function App() {
  const connection = useAppState((s) => s.connection);
  if (connection.phase === "connecting") return <div className="splash" role="status">正在打开…</div>;
  if (connection.phase === "failed") {
    return (
      <div className="splash splash-failed" role="alert">
        <h1>应用没有正常启动</h1>
        <p>{connection.message}</p>
        <p>
          <button type="button" className="button-primary" onClick={() => location.reload()}>
            再试一次
          </button>
        </p>
        <p>如果一直这样，请完全退出后重新打开；反馈问题时把上面这段文字一起发给开发者。</p>
      </div>
    );
  }
  return <Shell />;
}

function Shell() {
  const view = useAppState((s) => s.view);
  const actions = useActions();
  // 秘书在不在线：节点开关机没有事件通知，换页时和每隔一会儿（窗口看得见时）重读一次（C-04）
  useEffect(() => {
    if (view === "settings" || view === "workspace" || view === "desk" || view === "world") return;
    void actions.refreshStatus();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void actions.refreshStatus();
    }, 45_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") void actions.refreshStatus();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [view, actions]);
  // 设置和「资料与维护」是同一页的不同分区（C-50），用同一个组件，切换时分区选择不丢
  if (view === "settings" || view === "workspace") {
    return (
      <div className="shell shell-console shell-settings">
        <TopBar />
        <SettingsView notice={<Notice />} />
      </div>
    );
  }
  if (view === "chat") {
    return (
      <div className="shell shell-chat">
        <TopBar />
        <ChatView notice={<Notice />} />
        <NotesSheetHost />
      </div>
    );
  }
  if (view === "console") {
    return (
      <div className="shell shell-console">
        <TopBar />
        <ConsoleView notice={<Notice />} />
        <NotesSheetHost />
      </div>
    );
  }
  if (view === "world") {
    return (
      <div className="shell shell-console shell-world">
        <TopBar />
        <WorldView notice={<Notice />} />
      </div>
    );
  }
  if (view === "discussion") {
    return (
      <div className="shell shell-discussion">
        <TopBar />
        <DiscussionView notice={<Notice />} />
        <NotesSheetHost />
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
  return (
    <main className="desk">
      <Notice />
      <ReviewerSetupHint />
      <Workflow />
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
  return (
    <>
      <TopHeader />
      <MainNav />
    </>
  );
}

/**
 * C-33b 主导航（画布《1B 外观草案》）：桌面是左边一条竖着的玻璃栏，图标在上、字在下；
 * 手机宽度变成底部悬浮的玻璃标签栏（样式在 theme-apple.css）。
 */
const NAV_ICONS = {
  chat: <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 4v-4h0A1.5 1.5 0 0 1 4 14.5z" />,
  room: (
    <>
      <path d="M5 19V9l7-5 7 5v10z" />
      <path d="M10 19v-5h4v5" />
    </>
  ),
  agents: (
    <>
      <circle cx="9" cy="9" r="3.2" />
      <circle cx="16.5" cy="10" r="2.5" />
      <path d="M3.5 19c.9-3 3-4.5 5.5-4.5s4.6 1.5 5.5 4.5" />
      <path d="M15 15.2c2.3-.4 4.5.8 5.5 3.8" />
    </>
  ),
  run: <path d="M8 5.5v13l10-6.5z" />,
  world: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17M12 3.5c2.4 2.4 3.5 5.2 3.5 8.5s-1.1 6.1-3.5 8.5c-2.4-2.4-3.5-5.2-3.5-8.5s1.1-6.1 3.5-8.5z" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8" />
    </>
  ),
} as const;

function NavIcon({ name }: { name: keyof typeof NAV_ICONS }) {
  return (
    <svg className="topnav-icon" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {NAV_ICONS[name]}
    </svg>
  );
}

function MainNav() {
  const view = useAppState((s) => s.view);
  const actions = useActions();
  return (
    <nav className="topnav" aria-label="主导航">
      <button type="button" aria-current={view === "chat" ? "page" : undefined} onClick={actions.goChat}>
        <NavIcon name="chat" />
        <span className="topnav-label">聊天</span>
        <ChatUnread />
      </button>
      <button type="button" aria-current={view === "discussion" ? "page" : undefined} onClick={actions.goDiscussion}>
        <NavIcon name="room" />
        <span className="topnav-label">讨论室</span>
        <DiscussionBadge />
      </button>
      <button type="button" aria-current={view === "console" ? "page" : undefined} onClick={() => void actions.agentConsole.open()}>
        <NavIcon name="agents" />
        <span className="topnav-label">秘书</span>
      </button>
      <button type="button" className="topnav-run" disabled title="执行：即将推出">
        <NavIcon name="run" />
        <span className="topnav-label">执行</span>
      </button>
      {/* 世界（ADR-008 / C-54）：秘书们的共享小屋 */}
      <button type="button" className="topnav-world" aria-current={view === "world" ? "page" : undefined} onClick={actions.world.open}>
        <NavIcon name="world" />
        <span className="topnav-label">世界</span>
      </button>
      <button
        type="button"
        className="topnav-settings"
        aria-current={view === "settings" || view === "workspace" ? "page" : undefined}
        onClick={() => void actions.openSettings()}
      >
        <NavIcon name="settings" />
        {/* 草案：手机上这一格叫「我」 */}
        <span className="topnav-label">
          <span className="label-desk">设置</span>
          <span className="label-phone">我</span>
        </span>
      </button>
    </nav>
  );
}

function TopHeader() {
  const project = useAppState(currentProject);
  const status = useAppState((s) => s.status);
  const view = useAppState((s) => s.view);
  const isMock = useIsMock();
  // C-33b 收一收（江浩「界面还是太杂了」）：聊天、讨论室、秘书页不要顶上那一行，标题在各自面板里
  if (view !== "desk") return null;
  return (
    <header className="topbar">
      <span className="wordmark">Agent 评审室</span>
      <span className="topbar-project">{project?.name ?? "未选择项目"}</span>
      {isMock && (
        <span className="mock-flag" title="演示数据只存在内存里，不会真的发给秘书">
          演示数据
        </span>
      )}
      {/* 只在旧的单次评审工作台上显示：设置页现在以「节点」为主，这一行红字「未设置节点」会让人以为刚保存的节点没生效（C-49 / B-05） */}
      {status && (
        <span className="reviewer-status" data-ok={status.reviewerConfigured}>
          Reviewer：{status.reviewerConfigured ? status.reviewerAgent : "未设置节点"}
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
      <p className="rail-hint">项目 = 一组议题的视图，用来把相关的评审和讨论放在一起。</p>
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
