import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { NodeBaseUrl, NodeToken, ProfileId, type NodeInfo, type NodeTestResult } from "@room/schemas";
import { useActions, useAppState, useIsMock } from "./hooks";
import { AgentsSection, NodesSection } from "./NodesAndAgents";
import { GithubSettings } from "./notes/GithubSettings";
import { PacksSettings } from "./PacksSettings";
import { WorkspaceView } from "./WorkspaceView";
import "./settings.css";

const DEFAULT_PROFILE = "claude-review";

/** 节点测试失败时给人看的说明 */
const TEST_ERROR: Record<Extract<NodeTestResult, { reachable: false }>["error"], string> = {
  unreachable: "连不上这个地址。检查执行节点上 AgentServer 是否已启动、地址和端口是否正确、Windows 防火墙是否允许。",
  timeout: "连接超时。两台电脑可能不在同一个局域网，或者被防火墙拦截了。",
  unauthorized: "连上了，但 Token 不对。请重新复制执行节点上 setup 显示的 Token。",
  protocol_mismatch: "连上了，但对方的版本和这边不一致。请两边都更新到最新代码。",
  no_token: "还没有填写 Token。",
};

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
                <LegacyReviewerNode />
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

/** 旧版「单次评审」用的节点（ADR-001）。聊天和讨论室不用它，收在「连接」最下面 */
function LegacyReviewerNode() {
  const actions = useActions();
  const saved = useAppState((s) => s.reviewerNode);
  const [baseUrl, setBaseUrl] = useState("");
  const [profileId, setProfileId] = useState(DEFAULT_PROFILE);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState<"test" | "save" | null>(null);
  const [result, setResult] = useState<NodeTestResult | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // 读到已保存的设置后填进表单（Token 除外）
  useEffect(() => {
    if (saved) {
      setBaseUrl(saved.baseUrl);
      setProfileId(saved.profileId);
    }
  }, [saved]);

  const urlCheck = NodeBaseUrl.safeParse(baseUrl.trim());
  const profileCheck = ProfileId.safeParse(profileId.trim());
  const tokenCheck = token ? NodeToken.safeParse(token.trim()) : null;
  const tokenConfigured = saved?.tokenConfigured ?? false;
  const formValid = urlCheck.success && profileCheck.success && (tokenCheck ? tokenCheck.success : true);
  const canSave = formValid && (tokenCheck !== null || tokenConfigured) && busy === null;
  const canTest = formValid && (tokenCheck !== null || tokenConfigured) && busy === null;

  const payload = () => ({
    baseUrl: baseUrl.trim(),
    profileId: profileId.trim(),
    ...(token.trim() ? { token: token.trim() } : {}),
  });

  const test = async () => {
    setBusy("test");
    setResult(null);
    const r = await actions.testReviewerNode(payload());
    setBusy(null);
    if (r) setResult(r);
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSave) return;
    setBusy("save");
    const ok = await actions.saveReviewerNode(payload());
    setBusy(null);
    if (ok) {
      setToken(""); // Token 不留在界面上
      setSavedAt(Date.now());
    }
  };

  const profiles = result?.reachable ? result.health.profiles : [];

  return (
    <>
      <details className="settings-legacy">
        <summary>旧版「单次评审」用的节点</summary>
      <form className="settings-form" onSubmit={save} noValidate>
        <p className="step-hint">
          只有旧版的「单次评审」用这一项，聊天和讨论室用上面的节点。以前填过的地址和 Token 已经自动搬到上面的「你的电脑」，
          平时不用再动这里。
        </p>

        <label className="field-label" htmlFor="node-url">
          节点地址
        </label>
        <input
          id="node-url"
          className="settings-input"
          value={baseUrl}
          placeholder="http://192.168.1.20:7420"
          spellCheck={false}
          autoComplete="off"
          aria-invalid={baseUrl !== "" && !urlCheck.success}
          onChange={(e) => {
            setBaseUrl(e.target.value);
            setResult(null);
          }}
        />
        {baseUrl !== "" && !urlCheck.success && (
          <p className="field-error">需要形如 http://192.168.1.20:7420 的地址（不带路径）。</p>
        )}

        <label className="field-label" htmlFor="node-profile">
          评审方式
        </label>
        <input
          id="node-profile"
          className="settings-input"
          value={profileId}
          list="node-profiles"
          spellCheck={false}
          autoComplete="off"
          aria-invalid={!profileCheck.success}
          onChange={(e) => {
            setProfileId(e.target.value);
            setResult(null);
          }}
        />
        <datalist id="node-profiles">
          {profiles.map((p) => (
            <option key={p} value={p} />
          ))}
        </datalist>

        <label className="field-label" htmlFor="node-token">
          Token
        </label>
        <input
          id="node-token"
          className="settings-input settings-token"
          type="password"
          value={token}
          autoComplete="off"
          spellCheck={false}
          placeholder={tokenConfigured ? "已保存（不显示）。留空表示不修改" : "执行节点上 setup 显示的 64 位 Token"}
          aria-invalid={tokenCheck !== null && !tokenCheck.success}
          onChange={(e) => {
            setToken(e.target.value);
            setResult(null);
          }}
        />
        {tokenCheck && !tokenCheck.success && (
          <p className="field-error">Token 至少 32 个字符，不能有空格。</p>
        )}

        <div className="settings-actions">
          <button type="button" className="button-outline" disabled={!canTest} onClick={test}>
            {busy === "test" ? "测试中…" : "测试连接"}
          </button>
          <button type="submit" className="button-primary" disabled={!canSave}>
            {busy === "save" ? "保存中…" : "保存"}
          </button>
          {savedAt && busy === null && <span className="settings-saved" role="status">已保存</span>}
        </div>

        {result && <TestResult result={result} profileId={profileId.trim()} />}
      </form>
      </details>
    </>
  );
}


function TestResult({ result, profileId }: { result: NodeTestResult; profileId: string }) {
  if (!result.reachable) {
    return (
      <p className="test-result" data-ok="false" role="status">
        {TEST_ERROR[result.error]}
        <span className="test-detail">{result.message}</span>
      </p>
    );
  }
  return (
    <div className="test-result" data-ok={result.profileAvailable} role="status">
      <p>
        已连接到节点 {result.health.nodeId}，用时 {result.latencyMs} 毫秒。
      </p>
      {result.profileAvailable ? (
        <p>评审方式 {profileId} 可用。</p>
      ) : (
        <p>
          节点上没有评审方式 {profileId}。可用的有：{result.health.profiles.join("、")}。
        </p>
      )}
    </div>
  );
}
