import { useCallback, useEffect, useState } from "react";
import { HexColor, NodeBaseUrl, NodeToken, ProfileId, type AgentProfile, type NodeInfo, type NodeTestResult } from "@room/schemas";
import { RECOMMENDED_AGENTS, RECOMMENDED_NODES } from "../lib/presets";
import { useActions, useAppState } from "./hooks";

/**
 * 设置页：节点与参与者（C-27）。讨论室要知道「谁在哪台电脑的哪个 profile 上」。
 * Token 只写不读：保存后输入框清空，只显示「已保存」。
 */
export function NodesAndAgents() {
  const actions = useActions();
  const [nodes, setNodes] = useState<NodeInfo[] | null>(null);

  const reload = useCallback(async () => {
    const list = await actions.loadNodes();
    if (list) setNodes(list);
  }, [actions]);

  useEffect(() => {
    void reload();
    void actions.loadAgents();
  }, [reload, actions]);

  return (
    <>
      <section className="settings-form" aria-labelledby="nodes-title">
        <h2 className="settings-section" id="nodes-title">节点</h2>
        <p className="step-hint">
          每台运行 AgentServer 的电脑是一个节点。地址和 Token 来自那台电脑上 <code>run setup</code> 的输出。
        </p>
        {nodes === null ? (
          <p className="step-hint">读取中…</p>
        ) : (
          nodeIds(nodes).map((id) => (
            <NodeEditor key={id} id={id} saved={nodes.find((n) => n.id === id) ?? null} onSaved={reload} />
          ))
        )}
      </section>

      <AgentsSection nodes={nodes ?? []} />
    </>
  );
}

/** 推荐的两个节点总是列出来（还没保存也列），再加上已有的其他节点 */
function nodeIds(nodes: NodeInfo[]): string[] {
  const ids = RECOMMENDED_NODES.map((n) => n.id);
  for (const n of nodes) if (!ids.includes(n.id)) ids.push(n.id);
  return ids;
}

function NodeEditor({ id, saved, onSaved }: { id: string; saved: NodeInfo | null; onSaved: () => Promise<void> }) {
  const actions = useActions();
  const agents = useAppState((s) => s.disc.agents);
  const preset = RECOMMENDED_NODES.find((n) => n.id === id);
  const [label, setLabel] = useState(saved?.label ?? preset?.label ?? id);
  const [baseUrl, setBaseUrl] = useState(saved?.baseUrl ?? preset?.baseUrl ?? "");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState<"test" | "save" | null>(null);
  const [result, setResult] = useState<NodeTestResult | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    if (saved) {
      setLabel(saved.label);
      setBaseUrl(saved.baseUrl);
    }
  }, [saved]);

  // 测试连接时用这个节点上第一个参与者的 profile；没有就用推荐配置里的
  const profileId =
    agents.find((a) => a.nodeId === id && a.profileId)?.profileId ??
    RECOMMENDED_AGENTS.find((a) => a.nodeId === id)?.profileId ??
    "claude-review";

  const urlCheck = NodeBaseUrl.safeParse(baseUrl.trim());
  const tokenCheck = token.trim() ? NodeToken.safeParse(token.trim()) : null;
  // 地址变了，已保存的 Token 不再有效（D-22c）：必须重新填
  const sameAddress = saved !== null && saved.baseUrl === baseUrl.trim();
  const hasToken = tokenCheck?.success === true || (sameAddress && saved.tokenConfigured);
  const valid = urlCheck.success && label.trim().length > 0 && (tokenCheck === null || tokenCheck.success);
  const tokenPart = tokenCheck?.success ? { token: token.trim() } : {};

  const test = async () => {
    setBusy("test");
    setResult(null);
    const r = await actions.testNode({ id, baseUrl: baseUrl.trim(), profileId, ...tokenPart });
    setBusy(null);
    if (r) setResult(r);
  };

  const save = async () => {
    setBusy("save");
    const ok = await actions.upsertNode({ id, label: label.trim(), baseUrl: baseUrl.trim(), ...tokenPart });
    setBusy(null);
    if (ok) {
      setToken("");
      setSavedAt(Date.now());
      await onSaved();
    }
  };

  return (
    <fieldset className="node-editor" aria-label={`节点 ${id}`}>
      <legend>
        {label || id} <code className="node-id">{id}</code>
        <span className="node-token" data-ok={saved?.tokenConfigured ?? false}>
          {saved === null ? "还没保存" : saved.tokenConfigured ? "Token 已保存" : "Token 未配置"}
        </span>
      </legend>
      {preset && <p className="step-hint">{preset.hint}</p>}
      <div className="node-fields">
        <label>
          名称
          <input className="settings-input" value={label} onChange={(e) => setLabel(e.target.value)} />
        </label>
        <label>
          地址
          <input
            className="settings-input"
            value={baseUrl}
            placeholder="http://192.168.1.20:7420"
            spellCheck={false}
            aria-invalid={baseUrl !== "" && !urlCheck.success}
            onChange={(e) => (setBaseUrl(e.target.value), setResult(null))}
          />
        </label>
        <label>
          Token
          <input
            className="settings-input settings-token"
            type="password"
            value={token}
            autoComplete="off"
            spellCheck={false}
            placeholder={sameAddress && saved.tokenConfigured ? "已保存（不显示）。留空表示不修改" : "那台电脑上 setup 显示的 Token"}
            aria-invalid={tokenCheck !== null && !tokenCheck.success}
            onChange={(e) => (setToken(e.target.value), setResult(null))}
          />
        </label>
      </div>
      {baseUrl !== "" && !urlCheck.success && <p className="field-error">需要形如 http://192.168.1.20:7420 的地址。</p>}
      {saved !== null && !sameAddress && saved.tokenConfigured && tokenCheck === null && (
        <p className="field-error">地址改了，原来的 Token 不会发到新地址，请重新填写 Token。</p>
      )}
      <div className="settings-actions">
        <button type="button" className="button-outline" disabled={!valid || !hasToken || busy !== null} onClick={test}>
          {busy === "test" ? "测试中…" : `测试连接（${profileId}）`}
        </button>
        <button type="button" className="button-primary" disabled={!valid || busy !== null} onClick={save}>
          {busy === "save" ? "保存中…" : "保存节点"}
        </button>
        {savedAt && busy === null && <span className="settings-saved" role="status">已保存</span>}
      </div>
      {result && (
        <p className="test-result" data-ok={result.reachable && result.profileAvailable} role="status">
          {result.reachable
            ? result.profileAvailable
              ? `已连接（${result.latencyMs} 毫秒），${profileId} 可用。`
              : `已连接，但节点上没有 ${profileId}。可用的有：${result.health.profiles.join("、")}`
            : `连不上：${result.message}`}
        </p>
      )}
    </fieldset>
  );
}

function AgentsSection({ nodes }: { nodes: NodeInfo[] }) {
  const actions = useActions();
  const agents = useAppState((s) => s.disc.agents);
  const [applying, setApplying] = useState(false);

  const applyPreset = async () => {
    setApplying(true);
    for (const a of RECOMMENDED_AGENTS) {
      if (!(await actions.updateAgent(a))) break;
    }
    setApplying(false);
  };

  return (
    <section className="settings-form" aria-labelledby="agents-title">
      <h2 className="settings-section" id="agents-title">参与者</h2>
      <p className="step-hint">
        每个参与者在哪个节点、用哪个 profile。推荐配置：三位都是你的秘书。C酱（首席秘书，负责汇总）在「你的电脑」（claude-review），
        汐（DeepSeek）和林离（Codex）在「主控机」（deepseek-discuss / codex-discuss）。角色设定可以随时改。
      </p>
      <div className="settings-actions">
        <button type="button" className="button-outline" disabled={applying} onClick={applyPreset}>
          {applying ? "填入中…" : agents.length ? "按推荐配置重新填入（会覆盖下面三位的设置）" : "填入推荐的三位参与者"}
        </button>
      </div>
      {agents.map((a) => (
        <AgentEditor key={a.id} agent={a} nodes={nodes} />
      ))}
    </section>
  );
}

function AgentEditor({ agent, nodes }: { agent: AgentProfile; nodes: NodeInfo[] }) {
  const actions = useActions();
  const [draft, setDraft] = useState(agent);
  const [busy, setBusy] = useState(false);
  useEffect(() => setDraft(agent), [agent]);

  const set = <K extends keyof AgentProfile>(k: K, v: AgentProfile[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const profileOk = draft.profileId === null || ProfileId.safeParse(draft.profileId).success;
  const colorOk = HexColor.safeParse(draft.color).success;
  const valid = draft.displayName.trim().length > 0 && profileOk && colorOk;
  const dirty = JSON.stringify(draft) !== JSON.stringify(agent);

  const save = async () => {
    setBusy(true);
    await actions.updateAgent({
      id: agent.id,
      displayName: draft.displayName.trim(),
      color: draft.color,
      roleNote: draft.roleNote,
      canDiscuss: draft.canDiscuss,
      canSummarize: draft.canSummarize,
      pausedByUser: draft.pausedByUser,
      nodeId: draft.nodeId,
      profileId: draft.profileId,
    });
    setBusy(false);
  };

  return (
    <fieldset className="agent-editor" aria-label={`参与者 ${agent.displayName}`} style={{ borderLeftColor: agent.color }}>
      <legend>
        {agent.displayName} <code className="node-id">{agent.id}</code>
      </legend>
      <div className="node-fields">
        <label>
          显示名
          <input className="settings-input" value={draft.displayName} onChange={(e) => set("displayName", e.target.value)} />
        </label>
        <label>
          颜色
          <input type="color" value={draft.color} onChange={(e) => set("color", e.target.value.toLowerCase())} />
        </label>
        <label>
          节点
          <select className="settings-input" value={draft.nodeId ?? ""} onChange={(e) => set("nodeId", e.target.value || null)}>
            <option value="">（未配置）</option>
            {nodes.map((n) => (
              <option key={n.id} value={n.id}>
                {n.label}（{n.id}）
              </option>
            ))}
          </select>
        </label>
        <label>
          profile
          <input
            className="settings-input"
            value={draft.profileId ?? ""}
            spellCheck={false}
            aria-invalid={!profileOk}
            onChange={(e) => set("profileId", e.target.value.trim() || null)}
          />
        </label>
      </div>
      <div className="agent-flags">
        <label><input type="checkbox" checked={draft.canDiscuss} onChange={(e) => set("canDiscuss", e.target.checked)} /> 参与讨论</label>
        <label><input type="checkbox" checked={draft.canSummarize} onChange={(e) => set("canSummarize", e.target.checked)} /> 可以做汇总</label>
        <label><input type="checkbox" checked={draft.pausedByUser} onChange={(e) => set("pausedByUser", e.target.checked)} /> 暂停（不发给他）</label>
      </div>
      <label className="field-label">
        角色设定（只写分工，会放在发给他的内容最前面）
        <textarea className="settings-input" rows={2} maxLength={2000} value={draft.roleNote} onChange={(e) => set("roleNote", e.target.value)} />
      </label>
      <div className="settings-actions">
        <button type="button" className="button-primary" disabled={!valid || !dirty || busy} onClick={save}>
          {busy ? "保存中…" : "保存"}
        </button>
      </div>
    </fieldset>
  );
}
