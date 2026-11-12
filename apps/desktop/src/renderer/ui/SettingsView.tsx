import { useEffect, useState, type FormEvent } from "react";
import { NodeBaseUrl, NodeToken, ProfileId, type NodeTestResult } from "@room/schemas";
import { useActions, useAppState } from "./hooks";
import { NodesAndAgents } from "./NodesAndAgents";
import { GithubSettings } from "./notes/GithubSettings";
import { PacksSettings } from "./PacksSettings";

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
 * 设置页：节点与参与者（C-27，聊天和讨论室都用）、笔记同步、导入包；最下面收着旧版的 Reviewer 节点（ADR-001，单次评审用）。
 * Token 只写不读：保存后输入框清空，界面只显示"已保存"，永远拿不到已保存的值。
 */
export function SettingsView() {
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
    <section className="settings" aria-labelledby="settings-title">
      <header className="settings-head">
        <h1 id="settings-title">设置</h1>
        <button type="button" className="button-outline" onClick={actions.openWorkspace}>资料与维护</button>
        <button type="button" className="button-quiet" onClick={actions.closeSettings}>
          返回工作台
        </button>
      </header>

      {/* 新版在前：节点和参与者（聊天、讨论室都用它）。旧版「Reviewer 节点」只给单次评审用，收在最下面（B-05） */}
      <NodesAndAgents />

      <GithubSettings />

      <PacksSettings />

      <details className="settings-legacy">
        <summary>单次评审用的 Reviewer 节点（旧版）</summary>
      <form className="settings-form" onSubmit={save} noValidate>
        <p className="step-hint">
          只有旧的「单次评审」用这一项；聊天和讨论室看上面的「节点」。填过的地址和 Token 已经自动搬到上面的「你的电脑」，
          平时不用再动这里。Reviewer 运行在另一台电脑上：在那台电脑上运行 <code>pnpm --filter @room/agent-server setup</code>，
          把显示的地址、评审方式和 Token 填到这里。
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
    </section>
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
