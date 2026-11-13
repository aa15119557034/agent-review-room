import { useEffect, useState, type FormEvent } from "react";
import { GithubRepoName, GithubToken } from "@room/schemas";
import { githubSaveBlocker, githubStatusText } from "../../lib/notes";
import { useActions, useAppState } from "../hooks";

/**
 * 设置页：笔记同步到 GitHub（ADR-005 §5 / C-47）。
 * Token 只写不读：保存后输入框清空，只显示「已保存」；只推私有仓库；主控机是准的，GitHub 是副本。
 */
export function GithubSettings() {
  const status = useAppState((s) => s.notes.github);
  const available = useAppState((s) => s.notes.githubAvailable);
  const actions = useActions();
  const [repo, setRepo] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (status?.repo) setRepo(status.repo);
  }, [status?.repo]);

  if (!available) {
    return (
      <section className="settings-form" aria-labelledby="github-title">
        <h2 className="settings-section" id="github-title">笔记同步到 GitHub</h2>
        <p className="step-hint">后端还没接上这一项（等 D-46c），笔记照常存在主控机上。</p>
      </section>
    );
  }

  const repoCheck = GithubRepoName.safeParse(repo.trim());
  const tokenCheck = token.trim() ? GithubToken.safeParse(token.trim()) : null;
  const tokenSet = status?.tokenSet ?? false;
  const canSave = !busy && repoCheck.success && (tokenCheck ? tokenCheck.success : tokenSet) && (repo.trim() !== status?.repo || tokenCheck !== null);

  const blocker = githubSaveBlocker({ repo, repoOk: repoCheck.success, token, tokenSet });

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSave) return;
    setBusy(true);
    setError(null);
    const r = await actions.notes.saveGithub(repo.trim(), tokenCheck?.success ? token.trim() : undefined);
    setBusy(false);
    if (typeof r === "string") setError(r);
    else setToken(""); // Token 不留在界面上
  };
  const turnOff = async () => {
    setBusy(true);
    const r = await actions.notes.saveGithub(null);
    setBusy(false);
    if (typeof r === "string") setError(r);
    else setRepo("");
  };

  return (
    <form className="settings-form" onSubmit={save} noValidate aria-labelledby="github-title">
      <h2 className="settings-section" id="github-title">笔记同步到 GitHub</h2>
      <p className="step-hint">
        填一个你自己的<b>私有</b>仓库，秘书的项目笔记每存一版就推一份到 <code>notes/</code> 下（以后议题导出、开发也推到这里）。
        主控机上的是准的，GitHub 是副本：在网页上改了会被下一次推送盖掉，要改就在应用里改。不填就不推，其他功能照常。
      </p>

      <label className="field-label" htmlFor="github-repo">仓库</label>
      <input
        id="github-repo"
        className="settings-input"
        value={repo}
        placeholder="你的用户名/仓库名"
        spellCheck={false}
        autoComplete="off"
        aria-invalid={repo !== "" && !repoCheck.success}
        onChange={(e) => setRepo(e.target.value)}
      />
      {repo !== "" && !repoCheck.success && <p className="field-error">格式是 用户名/仓库名，比如 jianghao/agent-notes（不带 .git）。</p>}

      <label className="field-label" htmlFor="github-token">Token</label>
      <input
        id="github-token"
        className="settings-input settings-token"
        type="password"
        value={token}
        autoComplete="off"
        spellCheck={false}
        placeholder={tokenSet ? "已保存（不显示）。留空表示不修改" : "只给这个仓库 Contents 读写权限的 fine-grained Token"}
        aria-invalid={tokenCheck !== null && !tokenCheck.success}
        onChange={(e) => setToken(e.target.value)}
      />
      {tokenCheck && !tokenCheck.success && <p className="field-error">Token 看起来不对（20 个字符以上，不能有空格）。</p>}
      <p className="side-note">Token 只存在主控机上，不会发给秘书，也不会写进日志。</p>

      <div className="settings-actions">
        <button type="submit" className="button-primary" disabled={!canSave}>{busy ? "保存中…" : "保存"}</button>
        {status?.repo && (
          <button type="button" className="button-outline" disabled={busy} onClick={() => void turnOff()}>不同步了</button>
        )}
      </div>
      {!canSave && !busy && blocker && <p className="step-hint" role="status">{blocker}</p>}
      {error && <p className="field-error" role="alert">{error}</p>}

      {status && (
        <div className="test-result github-status" data-ok={status.repo !== null && status.lastError === null && status.private === true} role="status">
          <p>{githubStatusText(status)}</p>
          {status.lastErrorMessage && <span className="test-detail">{status.lastErrorMessage}</span>}
          {status.lastPushedAt && <p className="side-note">上次推送：{new Date(status.lastPushedAt).toLocaleString()}</p>}
          {status.repo && status.lastError !== "public_repo" && (status.pending > 0 || status.lastError) && (
            <button type="button" className="button-outline" onClick={() => void actions.notes.pushGithubNow()}>现在推一次</button>
          )}
        </div>
      )}
    </form>
  );
}
