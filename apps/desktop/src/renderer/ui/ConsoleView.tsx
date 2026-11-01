import { useState, type CSSProperties, type ReactNode } from "react";
import type { AgentActivityItem, AgentProfile, AgentStatus } from "@room/schemas";
import { useActions, useAppState } from "./hooks";
import { formatTime } from "./labels";
import { RECOMMENDED_NODES } from "../lib/presets";
import {
  AVAILABILITY_LABEL,
  BILLING_LABEL,
  QUOTA_STATE_LABEL,
  activityId,
  activityOutcome,
  activityPreview,
  activityTags,
  activityTitle,
  money,
  pct,
  quotaView,
  substituteOptions,
  type QuotaRow,
} from "../lib/console";

/**
 * 秘书控制台（C-37）：左边选人，右边一页——状态、额度、暂停 / 恢复、替补、正在答什么、历史。
 * 手机宽度下左边那栏变成顶上一排按钮。数据都是后端给的，界面不推导额度和结局。
 */
export function ConsoleView({ notice }: { notice: ReactNode }) {
  const agents = useAppState((s) => s.disc.agents);
  const status = useAppState((s) => s.disc.status);
  const agentId = useAppState((s) => s.console.agentId);
  const actions = useActions();
  const agent = agents.find((a) => a.id === agentId) ?? null;

  return (
    <div className="console">
      <nav className="console-list" aria-label="秘书">
        <h1 className="console-list-head">秘书</h1>
        {agents.length === 0 && <p className="side-note">还没有秘书。去「设置」里添加。</p>}
        <ul>
          {agents.map((a) => {
            const st = status[a.id];
            return (
              <li key={a.id}>
                <button
                  type="button"
                  className="console-list-item"
                  aria-current={a.id === agentId ? "page" : undefined}
                  data-state={st?.availability ?? "unknown"}
                  style={agentStyle(a.color)}
                  onClick={() => void actions.agentConsole.selectAgent(a.id)}
                >
                  <span className="avatar" aria-hidden="true">{a.displayName.slice(0, 1)}</span>
                  <span className="console-list-name">{a.displayName}</span>
                  <span className="console-list-state">{st ? AVAILABILITY_LABEL[st.availability] : "未知"}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
      <main className="console-page">
        {notice}
        {agent ? <AgentPage agent={agent} st={status[agent.id]} /> : <p className="side-note">从左边选一位。</p>}
      </main>
    </div>
  );
}

const agentStyle = (color: string) => ({ "--agent": color }) as CSSProperties;

function AgentPage({ agent, st }: { agent: AgentProfile; st: AgentStatus | undefined }) {
  const node = agent.nodeId === null ? "未配置节点" : (RECOMMENDED_NODES.find((n) => n.id === agent.nodeId)?.label ?? agent.nodeId);
  return (
    <article className="console-agent" style={agentStyle(agent.color)} aria-label={`${agent.displayName} 的控制台`}>
      <header className="console-agent-head">
        <span className="avatar" aria-hidden="true">{agent.displayName.slice(0, 1)}</span>
        <div>
          <h2>{agent.displayName}</h2>
          <p className="side-note">{node}{agent.profileId ? ` · ${agent.profileId}` : ""}</p>
        </div>
        <span className="console-badge" data-state={st?.availability ?? "unknown"}>
          {st ? AVAILABILITY_LABEL[st.availability] : "状态未知"}
        </span>
        <PauseButton agent={agent} />
      </header>
      {agent.pausedByUser && <p className="console-hint">已暂停：讨论和聊天都不发给 {agent.displayName}，点「恢复」才会再发。</p>}
      {st?.availability === "absent_quota" && (
        <p className="console-hint">额度用完了：讨论里{agent.substitute ? "由替补代答" : "记为缺席"}，读到额度恢复后自动回来。</p>
      )}
      <div className="console-grid">
        <QuotaPanel st={st} />
        <SubstitutePanel agent={agent} />
      </div>
      <Activity agent={agent} />
    </article>
  );
}

function PauseButton({ agent }: { agent: AgentProfile }) {
  const actions = useActions();
  const [busy, setBusy] = useState(false);
  const toggle = async () => {
    setBusy(true);
    await actions.updateAgent({ id: agent.id, pausedByUser: !agent.pausedByUser });
    setBusy(false);
  };
  return (
    <button type="button" className="button-outline console-pause" disabled={busy} onClick={() => void toggle()}>
      {agent.pausedByUser ? "恢复" : "暂停"}
    </button>
  );
}

// ---------------------------------------------------------------- 额度

function QuotaPanel({ st }: { st: AgentStatus | undefined }) {
  const q = quotaView(st);
  return (
    <section className="console-panel" aria-labelledby="console-quota">
      <h3 id="console-quota">
        额度 <span className="console-quota-state" data-state={q.state}>{QUOTA_STATE_LABEL[q.state]}</span>
      </h3>
      <p className="side-note">{BILLING_LABEL[q.billing]}{st ? ` · ${formatTime(st.updatedAt)} 更新` : ""}</p>
      {q.rows.map((r) => <QuotaMeter key={r.label} row={r} />)}
      {q.billing === "subscription" && !st?.fiveHour && <p className="side-note">5 小时 未知</p>}
      {q.billing === "subscription" && !st?.weekly && <p className="side-note">每周 未知</p>}
      {q.balance && (
        <dl className="console-balance">
          <dt>余额</dt>
          <dd><b>{money(q.balance)}</b></dd>
          <dt>本月消耗</dt>
          <dd>{q.balance.spentThisMonth ? money({ amount: q.balance.spentThisMonth, currency: q.balance.currency }) : "暂不可用"}</dd>
        </dl>
      )}
      {q.billing === "api" && !q.balance && <p className="side-note">余额 未知</p>}
      {q.state === "unknown" && <p className="side-note">读不到额度不算缺席，照常发给他。</p>}
      <p className="side-note">
        上下文 {st?.contextUsedPercent != null ? pct(st.contextUsedPercent) : "未知"}
        {st?.compactions != null ? ` · 已压缩 ${st.compactions} 次` : ""}
        {st?.model ? ` · ${st.model}` : ""}
        {st?.effort ? ` · 强度 ${st.effort}` : ""}
      </p>
    </section>
  );
}

function QuotaMeter({ row }: { row: QuotaRow }) {
  const left = Math.max(0, 100 - row.usedPercent);
  return (
    <div className="meter" data-empty={left <= 0 || undefined}>
      <p>
        {row.label}剩余 <b>{pct(left)}</b>
        {row.resetsAt ? ` · ${formatTime(row.resetsAt)} 重置` : ""}
      </p>
      <div className="meter-track" aria-hidden="true">
        <div className="meter-fill" style={{ width: `${left}%` }} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 替补

function SubstitutePanel({ agent }: { agent: AgentProfile }) {
  const agents = useAppState((s) => s.disc.agents);
  const actions = useActions();
  const [busy, setBusy] = useState(false);
  const options = substituteOptions(agents, agent.id);
  // 已经设了、但那位现在不能参加讨论：也列出来，不然下拉框显示不出当前值
  const current = agent.substitute ? agents.find((a) => a.id === agent.substitute) : undefined;
  const list = current && !options.includes(current) ? [...options, current] : options;
  const change = async (value: string) => {
    setBusy(true);
    await actions.updateAgent({ id: agent.id, substitute: value === "" ? null : value });
    setBusy(false);
  };
  return (
    <section className="console-panel" aria-labelledby="console-sub">
      <h3 id="console-sub">替补</h3>
      <label className="console-field">
        <span>{agent.displayName} 额度用完时，讨论里由谁代答</span>
        <select value={agent.substitute ?? ""} disabled={busy} onChange={(e) => void change(e.target.value)}>
          <option value="">不找替补（记缺席）</option>
          {list.map((a) => (
            <option key={a.id} value={a.id}>
              {a.displayName}{a.canDiscuss ? "" : "（现在不能参加讨论）"}
            </option>
          ))}
        </select>
      </label>
      <p className="side-note">只在讨论里生效，聊天不找替补。替补不能是这个议题的汇总者，起草时会再检查。</p>
    </section>
  );
}

// ---------------------------------------------------------------- 正在答 / 历史

function Activity({ agent }: { agent: AgentProfile }) {
  const page = useAppState((s) => (s.console.activity?.agent === agent.id ? s.console.activity : null));
  const available = useAppState((s) => s.console.activityAvailable);
  const actions = useActions();
  const [more, setMore] = useState(false);

  if (!available) {
    return (
      <section className="console-panel" aria-label="正在答和历史">
        <h3>正在答 · 历史</h3>
        <p className="side-note">后端还没接上这一项（等 D-44），其余设置照常可用。</p>
      </section>
    );
  }
  if (!page) {
    return (
      <section className="console-panel" aria-label="正在答和历史">
        <p className="side-note">正在读取…</p>
      </section>
    );
  }
  const loadMore = async () => {
    setMore(true);
    await actions.agentConsole.loadMore();
    setMore(false);
  };
  return (
    <>
      <section className="console-panel" aria-labelledby="console-now">
        <h3 id="console-now">正在答</h3>
        {page.current.length === 0 ? (
          <p className="side-note">现在没有在答的。</p>
        ) : (
          <ul className="console-items">{page.current.map((x) => <ActivityRow key={activityId(x)} x={x} />)}</ul>
        )}
      </section>
      <section className="console-panel" aria-labelledby="console-history">
        <h3 id="console-history">历史</h3>
        {page.recent.length === 0 ? (
          <p className="side-note">还没有答过。</p>
        ) : (
          <ul className="console-items">{page.recent.map((x) => <ActivityRow key={activityId(x)} x={x} />)}</ul>
        )}
        {page.nextCursor && (
          <button type="button" className="button-outline" disabled={more} onClick={() => void loadMore()}>
            {more ? "正在读取…" : "更早的"}
          </button>
        )}
      </section>
    </>
  );
}

function ActivityRow({ x }: { x: AgentActivityItem }) {
  const agents = useAppState((s) => s.disc.agents);
  const actions = useActions();
  const name = (id: string) => agents.find((a) => a.id === id)?.displayName ?? id;
  const outcome = activityOutcome(x);
  const preview = activityPreview(x);
  const when = x.kind === "discussion" ? x.turn.createdAt : x.slot.createdAt;
  const open = () =>
    void actions.agentConsole.openItem(
      x.kind === "discussion" ? { kind: "discussion", projectId: x.projectId } : { kind: "chat", conversationId: x.conversation.id },
    );
  return (
    <li className="console-item" data-tone={outcome.tone}>
      <div className="console-item-head">
        <b>{activityTitle(x, name)}</b>
        {activityTags(x, name).map((t) => <span key={t} className="console-tag">{t}</span>)}
        <span className="console-item-outcome">{outcome.label}</span>
      </div>
      <p className="console-item-preview" data-muted={preview.muted || undefined}>{preview.text}</p>
      <div className="console-item-foot">
        <span className="side-note">{formatTime(when)}</span>
        <button type="button" className="link-button" onClick={open}>
          {x.kind === "discussion" ? "打开议题" : "打开会话"}
        </button>
      </div>
    </li>
  );
}
