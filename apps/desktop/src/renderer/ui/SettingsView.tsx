import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { NodeInfo } from "@room/schemas";
import { useActions, useAppState, useIsMock } from "./hooks";
import { AgentsSection, NodesSection } from "./NodesAndAgents";
import { GithubSettings } from "./notes/GithubSettings";
import { PacksSettings } from "./PacksSettings";
import { WorkspaceView } from "./WorkspaceView";
import "./settings.css";

/**
 * 设置页（C-50）：左边分区、右边一页，和「秘书」页一个样子，不再套在旧的单次评审三栏里。
 * 分区：连接（节点）/ 秘书接入 / 笔记同步 / 扩展包 / 资料与维护 / 关于。
 * 「资料与维护」沿用 view = "workspace"（别处也会跳过来），其余分区记在本组件里。
 * Token 只写不读：保存后输入框清空，界面只显示"已保存"，永远拿不到已保存的值。
 */
type SectionId = "connect" | "agents" | "sync" | "packs" | "data" | "about";

const SECTIONS: readonly { id: SectionId; label: string; hint: string; icon: ReactNode }[] = [
  { id: "connect", label: "连接", hint: "秘书所在的电脑", icon: <path d="M9.5 14.5l5-5M8 11l-2 2a3.5 3.5 0 0 0 5 5l2-2M16 13l2-2a3.5 3.5 0 0 0-5-5l-2 2" /> },
  {
    id: "agents",
    label: "秘书接入",
    hint: "谁在哪台电脑上",
    icon: (
      <>
        <circle cx="12" cy="8.5" r="3.5" />
        <path d="M5 19.5c1-3.4 3.6-5 7-5s6 1.6 7 5" />
      </>
    ),
  },
  {
    id: "sync",
    label: "笔记同步",
    hint: "备份到 GitHub",
    icon: (
      <>
        <path d="M7 17.5a4 4 0 0 1-.6-7.95 5.5 5.5 0 0 1 10.7 1.2A3.4 3.4 0 0 1 17 17.5" />
        <path d="M12 12v7M9.5 14.5L12 12l2.5 2.5" />
      </>
    ),
  },
  {
    id: "packs",
    label: "扩展包",
    hint: "语音、补丁",
    icon: (
      <>
        <path d="M4.5 8L12 4l7.5 4v8L12 20l-7.5-4z" />
        <path d="M4.5 8L12 12l7.5-4M12 12v8" />
      </>
    ),
  },
  {
    id: "data",
    label: "资料与维护",
    hint: "搜索、导出、备份",
    icon: (
      <>
        <ellipse cx="12" cy="6.5" rx="7" ry="2.8" />
        <path d="M5 6.5V12c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8V6.5M5 12v5.5c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8V12" />
      </>
    ),
  },
  {
    id: "about",
    label: "关于",
    hint: "版本与隐私",
    icon: (
      <>
        <circle cx="12" cy="12" r="8.5" />
        <path d="M12 11v5.5M12 7.6v.2" />
      </>
    ),
  },
];

export function SettingsView({ notice }: { notice?: ReactNode }) {
  const actions = useActions();
  const view = useAppState((s) => s.view);
  const [picked, setPicked] = useState<Exclude<SectionId, "data">>("connect");
  const section: SectionId = view === "workspace" ? "data" : picked;
  const [nodes, setNodes] = useState<NodeInfo[] | null>(null);

  const reloadNodes = useCallback(async () => {
    const list = await actions.loadNodes();
    if (list) setNodes(list);
  }, [actions]);

  useEffect(() => {
    void reloadNodes();
    // 先拿到秘书，再按他们所在的节点问能用哪些模型（C-41）
    void actions.loadAgents().then(() => actions.loadModels());
  }, [reloadNodes, actions]);

  const go = (id: SectionId) => {
    if (id === "data") {
      actions.openWorkspace();
      return;
    }
    setPicked(id);
    if (view !== "settings") void actions.openSettings();
  };

  return (
    <div className="console settings-console">
      <nav className="console-list settings-nav" aria-label="设置分区">
        <h1 className="console-list-head">设置</h1>
        <ul>
          {SECTIONS.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                className="console-list-item settings-nav-item"
                aria-current={section === s.id ? "page" : undefined}
                onClick={() => go(s.id)}
              >
                <svg className="settings-nav-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  {s.icon}
                </svg>
                <span className="console-list-name">
                  {s.label}
                  <span className="settings-nav-hint">{s.hint}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <main className="console-page settings-page" data-section={section}>
        {section === "data" ? (
          <WorkspaceView />
        ) : (
          <div className="settings">
            {notice}
            {section === "connect" && (
              <>
                <NodesSection nodes={nodes} reload={reloadNodes} onNext={() => go("agents")} />
              </>
            )}
            {section === "agents" && <AgentsSection nodes={nodes ?? []} onNodesChanged={reloadNodes} onGoConnect={() => go("connect")} />}
            {section === "sync" && <GithubSettings />}
            {section === "packs" && <PacksSettings />}
            {section === "about" && <AboutSection />}
          </div>
        )}
      </main>
    </div>
  );
}

/** 关于：名字、版本、数据放在哪、用到的开源组件。上架审核要看的隐私说明也在这里 */
function AboutSection() {
  const version = useAppState((s) => s.status?.appVersion ?? null);
  const isMock = useIsMock();
  return (
    <section className="settings-form settings-about" aria-labelledby="about-title">
      <h2 className="settings-section" id="about-title">关于</h2>
      <div className="about-card">
        <div className="about-mark" aria-hidden="true">
          <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 4v-4A1.5 1.5 0 0 1 4 14.5z" />
            <path d="M8.5 9.5l2.5 2.5 4.5-4.5" />
          </svg>
        </div>
        <div>
          <p className="about-name">Agent 评审室</p>
          <p className="side-note">
            版本 {version ?? "读取中…"}
            {isMock ? " · 演示数据" : ""}
          </p>
        </div>
      </div>
      <p className="step-hint">和你的几位 AI 秘书聊天、一起讨论、把方案定下来。每一轮发给谁、带上什么都先给你看，你盖章了才发出去。</p>

      <h3 className="about-heading">数据与隐私</h3>
      <ul className="about-list">
        <li>聊天、讨论、方案、笔记、图片和录音都只保存在这台电脑上，应用不会把它们上传到任何服务器。</li>
        <li>只有你发送或盖章的内容，才会发给你自己在「连接」里填的节点。</li>
        <li>节点 Token 和 GitHub Token 用系统的加密存储保存，界面上不会再显示，也不会写进日志。</li>
        <li>「笔记同步」默认关闭；只有你填了自己的私有仓库，笔记才会推送到那里。</li>
        <li>应用不收集使用数据，没有统计，也没有广告。</li>
      </ul>

      <h3 className="about-heading">开源组件</h3>
      <p className="step-hint">本应用使用了 Electron、React、better-sqlite3、sharp、Zod、yauzl 等开源软件，感谢它们的作者。</p>
    </section>
  );
}
