import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { AgentModelSettings, type AgentActivityItem, type AgentProfile, type AgentStatus, type NodeInfo, type NoteScope } from "@room/schemas";
import { agentTitle } from "../lib/chat";
import { ModelSettings } from "./ModelSettings";
import { VoiceSettings } from "./VoiceSettings";
import { AgentEditor } from "./NodesAndAgents";
import { useActions, useAppState } from "./hooks";
import { formatTime } from "./labels";
import { RECOMMENDED_NODES } from "../lib/presets";
import { NodeWhy } from "./NodeWhy";
import {
  AVAILABILITY_LABEL,
  BILLING_LABEL,
  availabilityText,
  chatNotConfigured,
  QUOTA_STATE_LABEL,
  activityId,
  activityOutcome,
  activityPreview,
  activityTags,
  activityTitle,
  groupActivity,
  type ActivityGroup,
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
        {agent ? <AgentPage key={agent.id} agent={agent} st={status[agent.id]} /> : <p className="side-note">从左边选一位。</p>}
      </main>
    </div>
  );
}

const agentStyle = (color: string) => ({ "--agent": color }) as CSSProperties;

/** 代表色：草案给三个备选，外加现在用的（不在里面时） */
const SWATCHES = ["#a0522d", "#2f5aa0", "#1f6b55", "#3d6f8a", "#5b4a9e", "#b4435a"];

type SheetKind = "persona" | "model" | "voice" | "advanced";

/**
 * 秘书资料（C-37 控制台；C-33b 照草案「秘书资料」重排成一页资料）：
 * 头像、名字、身份；「发消息 / 暂停」；状态、额度、替补；人设和记忆；外观；正在答；历史（按议题 / 会话分组）。
 * 人设、模型、声音、节点这些从「设置」挪过来：点一行弹出一张单，改完点「完成」才保存。
 * 上下文 % 和压缩次数挪到会话里（聊天顶上的记忆条），这里不放。
 */
function AgentPage({ agent, st }: { agent: AgentProfile; st: AgentStatus | undefined }) {
  const node = agent.nodeId === null ? "未配置节点" : (RECOMMENDED_NODES.find((n) => n.id === agent.nodeId)?.label ?? agent.nodeId);
  const models = useAppState((s) => s.disc.models[agent.id]);
  const direct = useAppState((s) => (s.chat.list ?? []).find((x) => x.conversation.kind === "direct" && x.conversation.members[0] === agent.id)?.conversation.id);
  const actions = useActions();
  const [sheet, setSheet] = useState<SheetKind | null>(null);
  const title = agentTitle(agent.roleNote);
  const q = quotaView(st);
  const sentences = agent.roleNote.split(/[。！？!?\n]+/).filter((x) => x.trim()).length;
  const primary = models?.find((m) => m.id === agent.modelSettings.primaryModel);
  const modelLine = agent.modelSettings.primaryModel === null ? "跟随 profile" : (primary?.displayName ?? agent.modelSettings.primaryModel);
  const effortId = agent.modelSettings.effort.chat;
  const effortLine = primary && effortId ? primary.efforts.find((e) => e.id === effortId)?.displayName : undefined;

  return (
    <article className="console-agent profile" style={agentStyle(agent.color)} aria-label={`${agent.displayName} 的资料`}>
      <header className="profile-head">
        <span className="avatar profile-avatar" aria-hidden="true">{agent.displayName.slice(0, 1)}</span>
        <h2>{agent.displayName}</h2>
        <p className="side-note">{[title, node].filter(Boolean).join(" · ")}</p>
        <div className="profile-buttons">
          <button
            type="button"
            className="profile-button"
            onClick={() => (direct ? void actions.agentConsole.openItem({ kind: "chat", conversationId: direct }) : actions.goChat())}
          >
            <span aria-hidden="true">💬</span>发消息
          </button>
          <PauseButton agent={agent} />
        </div>
      </header>
      {chatNotConfigured(agent) && (
        <p className="console-hint">
          聊天还没配：{agent.displayName} 在聊天里不能回答。点下面的「节点和权限」，填上聊天 profile（一般是「{agent.id}-chat」）。
        </p>
      )}
      {agent.pausedByUser && <p className="console-hint">已暂停：讨论和聊天都不发给 {agent.displayName}，点「恢复」才会再发。</p>}
      {st?.availability === "absent_quota" && (
        <p className="console-hint">额度用完了：讨论里{agent.substitute ? "由替补代答" : "记为缺席"}，读到额度恢复后自动回来。</p>
      )}

      <section className="sheet-group profile-rows" aria-label="状态">
        <div className="profile-row">
          <span>状态</span>
          <span className="profile-state" data-state={st?.availability ?? "unknown"}>
            {availabilityText(agent, st)} · {node}
          </span>
        </div>
        {st?.availability === "offline" && (
          <div className="profile-row profile-why">
            <NodeWhy agent={agent} profileId={agent.profileId} />
          </div>
        )}
        <details className="profile-row profile-quota">
          <summary>
            <span>额度</span>
            <span className="profile-value">{quotaSummary(q)}</span>
          </summary>
          <QuotaPanel st={st} />
        </details>
        <SubstituteRow agent={agent} />
      </section>

      <h3 className="sheet-label">人设和记忆</h3>
      <section className="sheet-group profile-rows" aria-label="人设和记忆">
        <RowButton label="讨论室人设" value={agent.roleNote.trim() ? `${sentences} 句` : "没写"} onClick={() => setSheet("persona")} />
        <RowButton label="模型和思考强度" value={[modelLine, effortLine].filter(Boolean).join(" · ")} onClick={() => setSheet("model")} />
        <RowButton label="声音" value={agent.voice ? agent.voice.voiceId : "没选"} onClick={() => setSheet("voice")} />
        <div className="profile-row">
          <span>记忆来源</span>
          <span className="profile-value">{agent.memorySource.nodeFolder ? "节点记忆文件夹 + 聊天记录" : "聊天记录"} · 只读</span>
        </div>
      </section>

      <h3 className="sheet-label">外观</h3>
      <section className="sheet-group profile-rows" aria-label="外观">
        <ColorRow agent={agent} />
        <RowButton label="节点和权限" value={agent.profileId ?? "未配置"} onClick={() => setSheet("advanced")} />
      </section>

      <Activity agent={agent} />

      {sheet && <ProfileSheet agent={agent} kind={sheet} onClose={() => setSheet(null)} />}
    </article>
  );
}

function quotaSummary(q: ReturnType<typeof quotaView>): string {
  if (q.state === "unknown") return "未知（读不到不猜）";
  if (q.balance) return `余额 ${money(q.balance)}`;
  // 和展开后的条一样说「剩余」；画图那边说的是「已用」，两处都写明是哪个（B-10）
  const rows = q.rows.map((r) => `${r.label}剩 ${pct(Math.max(0, 100 - r.usedPercent))}`);
  return rows.length ? rows.join(" · ") : QUOTA_STATE_LABEL[q.state];
}

function RowButton({ label, value, onClick }: { label: string; value: string; onClick: () => void }) {
  return (
    <button type="button" className="profile-row profile-row-button" onClick={onClick}>
      <span>{label}</span>
      <span className="profile-value">{value} ›</span>
    </button>
  );
}

function ColorRow({ agent }: { agent: AgentProfile }) {
  const actions = useActions();
  const list = SWATCHES.includes(agent.color) ? SWATCHES : [agent.color, ...SWATCHES];
  return (
    <div className="profile-row">
      <span>代表色</span>
      <span className="profile-swatches" role="radiogroup" aria-label="代表色">
        {list.map((c) => (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={c === agent.color}
            aria-label={c}
            style={{ background: c }}
            onClick={() => c !== agent.color && void actions.updateAgent({ id: agent.id, color: c })}
          />
        ))}
      </span>
    </div>
  );
}

/** 点一行弹出来的单：人设 / 模型和思考强度 / 声音 / 节点和权限。改完点「完成」保存 */
function ProfileSheet({ agent, kind, onClose }: { agent: AgentProfile; kind: SheetKind; onClose: () => void }) {
  const actions = useActions();
  const models = useAppState((s) => s.disc.models[agent.id]);
  const [roleNote, setRoleNote] = useState(agent.roleNote);
  const [modelSettings, setModelSettings] = useState(agent.modelSettings);
  const [voice, setVoice] = useState(agent.voice ?? null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (kind === "model" && models === undefined) void actions.loadModels();
  }, [kind, models, actions]);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);

  const TITLE: Record<SheetKind, string> = { persona: "讨论室人设", model: "模型和思考强度", voice: "声音", advanced: "节点和权限" };
  const done = async () => {
    if (kind === "advanced") return onClose();
    setBusy(true);
    const ok = await actions.updateAgent(
      kind === "persona" ? { id: agent.id, roleNote } : kind === "model" ? { id: agent.id, modelSettings } : { id: agent.id, voice },
    );
    setBusy(false);
    if (ok) onClose();
  };
  const modelsOk = AgentModelSettings.safeParse(modelSettings).success;

  return (
    <div className="profile-sheet-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <section className="profile-sheet" role="dialog" aria-modal="true" aria-label={TITLE[kind]}>
        <span className="profile-sheet-grip" aria-hidden="true" />
        <header>
          <h2>{TITLE[kind]}</h2>
          <button type="button" className="button-link" onClick={onClose}>取消</button>
          <button type="button" className="button-primary profile-done" disabled={busy || (kind === "model" && !modelsOk)} onClick={() => void done()}>
            {busy ? "保存中…" : "完成"}
          </button>
        </header>
        {kind === "persona" && (
          <>
            <p className="side-note">只写分工，会放在发给 {agent.displayName} 的内容最前面。</p>
            <textarea className="settings-input" rows={6} maxLength={2000} value={roleNote} onChange={(e) => setRoleNote(e.target.value)} />
          </>
        )}
        {kind === "model" && (
          <>
            <p className="side-note">想得越久越准，也越慢、越费额度。档位由 {agent.displayName} 所在的节点报告，左右拖动选择。</p>
            <ModelSettings value={modelSettings} models={models} onChange={setModelSettings} />
          </>
        )}
        {kind === "voice" && (
          <>
            <p className="side-note">聊天里的「播放」和「用语音回」用这个声音。</p>
            <VoiceSettings value={voice} onChange={setVoice} />
          </>
        )}
        {kind === "advanced" && <AdvancedEditor agent={agent} />}
      </section>
    </div>
  );
}

/** 节点、profile、能不能讨论 / 汇总：沿用设置页的编辑器 */
function AdvancedEditor({ agent }: { agent: AgentProfile }) {
  const actions = useActions();
  const [nodes, setNodes] = useState<NodeInfo[] | null>(null);
  useEffect(() => {
    let alive = true;
    void actions.loadNodes().then((n) => alive && setNodes(n ?? []));
    return () => {
      alive = false;
    };
  }, [actions]);
  if (!nodes) return <p className="side-note">正在读取节点…</p>;
  return <AgentEditor agent={agent} nodes={nodes} />;
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
    <button type="button" className="profile-button console-pause" disabled={busy} onClick={() => void toggle()}>
      <span aria-hidden="true">{agent.pausedByUser ? "▶" : "Ⅱ"}</span>
      {agent.pausedByUser ? "恢复" : "暂停"}
    </button>
  );
}

// ---------------------------------------------------------------- 额度

function QuotaPanel({ st }: { st: AgentStatus | undefined }) {
  const q = quotaView(st);
  return (
    <div className="profile-quota-body">
      <p className="side-note">
        <span className="console-quota-state" data-state={q.state}>{QUOTA_STATE_LABEL[q.state]}</span> · {BILLING_LABEL[q.billing]}
        {st ? ` · ${formatTime(st.updatedAt)} 更新` : ""}
      </p>
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
    </div>
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

/** 替补是默认值（江浩 2026-11-02：以后每个聊天可以单独调；那需要改契约，先只有默认） */
function SubstituteRow({ agent }: { agent: AgentProfile }) {
  const agents = useAppState((s) => s.disc.agents);
  const status = useAppState((s) => s.disc.status);
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
    <label className="profile-row profile-sub" title="额度用完时讨论里由谁代答。只在讨论里生效，聊天不找替补；替补不能是这个议题的汇总者；两人互为替补可以，但同一轮两人都缺席时这一轮发不出去。">
      <span>替补（默认）</span>
      <select value={agent.substitute ?? ""} disabled={busy} onChange={(e) => void change(e.target.value)}>
        <option value="">不找替补（记缺席）</option>
        {list.map((a) => (
          <option key={a.id} value={a.id}>
            {a.displayName}
            {!a.canDiscuss ? "（现在不能参加讨论）" : status[a.id] && status[a.id]!.availability !== "available" ? `（现在${AVAILABILITY_LABEL[status[a.id]!.availability]}）` : ""}
          </option>
        ))}
      </select>
    </label>
  );
}

// ---------------------------------------------------------------- 正在答 / 历史

function Activity({ agent }: { agent: AgentProfile }) {
  const page = useAppState((s) => (s.console.activity?.agent === agent.id ? s.console.activity : null));
  const available = useAppState((s) => s.console.activityAvailable);
  const agents = useAppState((s) => s.disc.agents);
  const actions = useActions();
  const [more, setMore] = useState(false);
  const notesOn = useAppState((s) => s.notes.available);
  const name = (id: string) => agents.find((a) => a.id === id)?.displayName ?? id;

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
  const KIND: Record<ActivityGroup["kind"], string> = { discussion: "讨论", group: "群聊", direct: "单聊" };
  return (
    <>
      <h3 className="sheet-label" id="console-now">正在答</h3>
      <section className="console-panel" aria-labelledby="console-now">
        {page.current.length === 0 ? (
          <p className="side-note">现在没有在答的。</p>
        ) : (
          <ul className="console-items">{page.current.map((x) => <ActivityRow key={activityId(x)} x={x} />)}</ul>
        )}
      </section>
      <h3 className="sheet-label" id="console-history">历史 · 按议题和会话</h3>
      <section className="console-panel" aria-labelledby="console-history">
        {page.recent.length === 0 ? (
          <p className="side-note">还没有答过。</p>
        ) : (
          groupActivity(page.recent, name).map((g) => (
            <details key={g.key} className="console-group" open>
              <summary>
                <b>{g.title}</b>
                <span className="console-tag">{KIND[g.kind]}</span>
                <span className="side-note">{g.items.length} 条</span>
                {notesOn && (
                  <button
                    type="button"
                    className="link-button console-note"
                    onClick={(e) => {
                      // 别让点「笔记」顺手把这一组收起来
                      e.preventDefault();
                      actions.notes.openNote(groupScope(g.key), agent.id, [agent.id]);
                    }}
                  >
                    笔记 ›
                  </button>
                )}
              </summary>
              <ul className="console-items">{g.items.map((x) => <ActivityRow key={activityId(x)} x={x} grouped />)}</ul>
            </details>
          ))
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

/** 历史分组的 key（p:议题 / c:会话，见 groupActivity）→ 笔记的子项目 */
function groupScope(key: string): NoteScope {
  return key.startsWith("p:") ? { kind: "topic", projectId: key.slice(2) } : { kind: "conversation", conversationId: key.slice(2) };
}

function ActivityRow({ x, grouped = false }: { x: AgentActivityItem; grouped?: boolean }) {
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
  // 分组里组名已经写了议题 / 会话，行内只留「第 N 轮」和标签
  const title = grouped ? (x.kind === "discussion" ? `第 ${x.roundIndex} 轮` : null) : activityTitle(x, name);
  const tags = grouped
    ? activityTags(x, name).filter((t) => !["讨论", "群聊", "单聊"].includes(t)).map((t) => (t === "讨论 · 汇总" ? "汇总" : t))
    : activityTags(x, name);
  return (
    <li className="console-item" data-tone={outcome.tone}>
      <div className="console-item-head">
        {title && <b>{title}</b>}
        {tags.map((t) => <span key={t} className="console-tag">{t}</span>)}
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
