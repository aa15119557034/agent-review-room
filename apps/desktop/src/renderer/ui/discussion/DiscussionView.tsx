import { useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import type { AgentStatus, Message, Turn } from "@room/schemas";
import {
  OUTCOME_LABEL,
  ROUND_STATE_LABEL,
  TASK_SOURCE_LABEL,
  agentColor,
  agentName,
  canDerive,
  displayedPlan,
  planForNextRound,
  formatActive,
  openRound,
  pendingBatches,
  stages,
  timeline,
  turnText,
  type DiscussionState,
  type TimelineEntry,
} from "../../lib/discussion";
import { useActions, useAppState } from "../hooks";
import { formatClock } from "../labels";
import { ConfirmView } from "./ConfirmView";
import { ReviewView } from "./ReviewView";
import { FirstPlan } from "./FirstPlan";

/**
 * 讨论室主页（C-21，画布「① 主页 · 讨论」）。
 * 左：议题栏 ｜ 中：时间线 + 输入框 ｜ 右：方案与参与者状态。三栏都可以收起。
 */
export function DiscussionView({ notice }: { notice: ReactNode }) {
  const available = useAppState((s) => s.disc.available);
  const confirm = useAppState((s) => s.disc.confirm);
  const page = useAppState((s) => s.disc.ui.page);
  const railCollapsed = useAppState((s) => s.disc.ui.railCollapsed);
  const sideCollapsed = useAppState((s) => s.disc.ui.sideCollapsed);

  if (!available) {
    return (
      <main className="disc-unavailable">
        {notice}
        <h1>讨论室还没有接上后端</h1>
        <p>后端的讨论室功能（D-21）完成之前，可以先用顶栏的「单次评审」。开发界面时在地址后加 <code>?mock</code> 可以看演示数据。</p>
      </main>
    );
  }

  return (
    <div className="disc" data-rail={railCollapsed ? "collapsed" : "open"} data-side={sideCollapsed ? "collapsed" : "open"}>
      <TopicRail />
      <main className="disc-main">
        {notice}
        {confirm ? <ConfirmView /> : page.kind === "review" ? <ReviewView roundId={page.roundId} /> : <Conversation />}
      </main>
      <SidePanel />
    </div>
  );
}

// ---------------------------------------------------------------- 顶栏的额度状态条

export function QuotaChips() {
  const agents = useAppState((s) => s.disc.agents);
  const status = useAppState((s) => s.disc.status);
  if (agents.length === 0) return null;
  return (
    <ul className="quota-chips" aria-label="参与者额度">
      {agents.map((a) => {
        const st = status[a.id];
        return (
          <li key={a.id} className="quota-chip" data-state={st?.availability ?? "unknown"} style={{ "--agent": a.color } as CSSProperties}>
            {a.displayName} {quotaShort(st)}
          </li>
        );
      })}
    </ul>
  );
}

function quotaShort(st: AgentStatus | undefined): string {
  if (!st) return "未知";
  if (st.availability === "absent_quota") return "缺席";
  if (st.availability === "offline") return "离线";
  if (st.availability === "unconfigured") return "未配置";
  if (st.availability === "paused_by_user") return "已暂停";
  if (st.balance) return `余额 ${st.balance.currency === "CNY" ? "¥" : ""}${st.balance.amount}`;
  const parts = [];
  if (st.fiveHour) parts.push(`5h ${Math.round(100 - st.fiveHour.usedPercent)}%`);
  if (st.weekly) parts.push(`周 ${Math.round(100 - st.weekly.usedPercent)}%`);
  return parts.length ? parts.join(" · ") : "额度未知";
}

// ---------------------------------------------------------------- 左：议题栏

function TopicRail() {
  const projects = useAppState((s) => s.projects);
  const currentId = useAppState((s) => s.currentProjectId);
  const collapsed = useAppState((s) => s.disc.ui.railCollapsed);
  const actions = useActions();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");

  if (collapsed) {
    return (
      <nav className="disc-rail" aria-label="议题">
        <button type="button" className="icon-button" aria-label="展开议题栏" onClick={actions.toggleRail}>»</button>
      </nav>
    );
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;
    void actions.createProject(n);
    setName("");
    setCreating(false);
  };

  return (
    <nav className="disc-rail" aria-label="议题">
      <div className="disc-rail-head">
        <h2>议题 · {projects.length}</h2>
        <button type="button" className="icon-button" aria-label="新议题" onClick={() => setCreating((v) => !v)}>+</button>
        <button type="button" className="icon-button" aria-label="收起议题栏" onClick={actions.toggleRail}>«</button>
      </div>
      {creating && (
        <form className="disc-new-topic" onSubmit={submit}>
          <label htmlFor="new-topic">议题名称</label>
          <input id="new-topic" autoFocus value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
          <button type="submit" className="button-primary" disabled={!name.trim()}>创建</button>
        </form>
      )}
      <ul className="disc-topics">
        {projects.map((p) => (
          <li key={p.id}>
            <button type="button" aria-current={p.id === currentId ? "page" : undefined} onClick={() => void actions.selectProject(p.id)}>
              {p.name}
            </button>
          </li>
        ))}
      </ul>
      {projects.length > 4 && <p className="disc-rail-more">往下滑看更多</p>}
    </nav>
  );
}

// ---------------------------------------------------------------- 中：时间线 + 输入框

function Conversation() {
  const project = useAppState((s) => s.projects.find((p) => p.id === s.currentProjectId) ?? null);
  const agents = useAppState((s) => s.disc.agents);
  const actions = useActions();
  if (!project) {
    return (
      <section className="disc-empty">
        <h1>从左边新建一个议题开始</h1>
        <p>发议题和文件，勾选这一轮让谁发言；每次发出去之前都要你盖章。</p>
      </section>
    );
  }
  return (
    <>
      <header className="disc-head">
        <h1>{project.name}</h1>
        <span className="disc-head-meta">参与：你 · {agents.filter((a) => a.canDiscuss).map((a) => a.displayName).join(" · ")}</span>
        <span className="spacer" />
        <button type="button" className="button-link" onClick={() => actions.setAllRounds(true)}>全部收起</button>
        <button type="button" className="button-link" onClick={() => actions.setAllRounds(false)}>全部展开</button>
      </header>
      <StageBar />
      <Timeline />
      <Composer />
    </>
  );
}

function StageBar() {
  const list = useAppState((s) => stages(s.disc));
  const actions = useActions();
  if (list.length <= 3) return null;
  return (
    <nav className="stage-bar" aria-label="阶段">
      {list.map((st, i) => (
        <span key={st.key} className="stage-item">
          {i > 0 && <span aria-hidden="true" className="stage-sep">—</span>}
          {st.roundId && st.label.startsWith("汇总") && st.state === "done" ? (
            <button type="button" className="stage" data-state={st.state} onClick={() => actions.openReview(st.roundId!)}>{st.label}</button>
          ) : (
            <span className="stage" data-state={st.state} aria-current={st.state === "current" ? "step" : undefined}>{st.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}

function Timeline() {
  const entries = useAppState((s) => timeline(s.disc, s.messages));
  const collapsed = useAppState((s) => s.disc.ui.collapsedRounds);
  if (entries.length === 0) {
    return (
      <div className="disc-timeline disc-timeline-empty">
        <p>还没有发言。在下面写下议题，选好这一轮发给谁，点「预览并发起」。</p>
      </div>
    );
  }
  return (
    <ol className="disc-timeline">
      {entries.map((e) => {
        const hidden = (e.kind === "turn" || e.kind === "summary") && collapsed[e.round.id];
        if (hidden) return null;
        return <li key={e.key}><Entry entry={e} /></li>;
      })}
    </ol>
  );
}

function Entry({ entry }: { entry: TimelineEntry }) {
  switch (entry.kind) {
    case "round":
      return <RoundBar entry={entry} />;
    case "note":
      return (
        <Bubble who="你" color="var(--ink)" meta={`${entry.message.roundId ? "插话" : "发言"} · ${formatClock(entry.message.createdAt)}`}>
          <LongText id={entry.message.id} text={entry.message.content} />
        </Bubble>
      );
    case "turn":
      return <TurnCard turn={entry.turn} reply={entry.reply} />;
    case "summary":
      return <SummaryCard entry={entry} />;
  }
}

function RoundBar({ entry }: { entry: Extract<TimelineEntry, { kind: "round" }> }) {
  const { round, batches } = entry;
  const d = useAppState((s) => s.disc);
  const collapsed = useAppState((s) => !!s.disc.ui.collapsedRounds[round.id]);
  const actions = useActions();
  const stamped = batches.find((b) => b.kind === "initial" && b.state === "APPROVED");
  const waiting = batches.find((b) => b.state === "READY_FOR_REVIEW");
  return (
    <div className="round-bar" data-state={round.state}>
      <button type="button" className="round-bar-toggle" aria-expanded={!collapsed} onClick={() => actions.toggleRound(round.id)}>
        第 {round.index} 轮 · 发给 {round.recipients.map((r) => agentName(d, r)).join("、")} · 任务：{TASK_SOURCE_LABEL[round.taskSource]}
        {stamped && <> · <b className="stamped">你已盖章</b> {formatClock(stamped.decidedAt ?? stamped.createdAt)}</>}
        {" · "}
        {ROUND_STATE_LABEL[round.state]}
        {round.activeMs > 0 && ` · 用时 ${formatActive(round.activeMs)}`}
      </button>
      {waiting && (
        <button type="button" className="button-seal-small" onClick={() => void actions.openConfirm(waiting.id)}>
          去盖章
        </button>
      )}
      {round.state === "VOIDED" && round.voidReason && <span className="round-bar-note">作废原因：{round.voidReason}</span>}
    </div>
  );
}

function TurnCard({ turn, reply }: { turn: Turn; reply: Message | null }) {
  const d = useAppState((s) => s.disc);
  const events = useAppState((s) => (turn.runId ? s.runEvents[turn.runId] : undefined));
  const actions = useActions();
  const { text, live } = turnText(turn, reply, events);
  const label = OUTCOME_LABEL[turn.outcome];
  const canRetry = ["timed_out", "failed", "absent_quota"].includes(turn.outcome) && !turn.supersededBy;
  const meta = [
    turn.onBehalfOf ? `代 ${agentName(d, turn.onBehalfOf)}` : null,
    label || null,
    formatClock(turn.createdAt),
  ].filter(Boolean).join(" · ");
  return (
    <Bubble who={agentName(d, turn.agent)} color={agentColor(d, turn.agent)} meta={meta} state={turn.outcome}>
      {text ? <LongText id={turn.id} text={text} live={live} /> : <p className="turn-empty">{live ? "正在思考…" : "（没有输出）"}</p>}
      {canRetry && (
        <button type="button" className="button-link" onClick={() => void actions.retryAgent(turn.roundId, turn.agent)}>
          单独重试 {agentName(d, turn.agent)}
        </button>
      )}
    </Bubble>
  );
}

function SummaryCard({ entry }: { entry: Extract<TimelineEntry, { kind: "summary" }> }) {
  const d = useAppState((s) => s.disc);
  const actions = useActions();
  const events = useAppState((s) => (entry.turn.runId ? s.runEvents[entry.turn.runId] : undefined));
  const { text, live } = turnText(entry.turn, entry.reply, events);
  const sum = entry.summary;
  const plan = sum?.planVersionId ? d.plans.find((p) => p.id === sum.planVersionId) : undefined;
  return (
    <Bubble who={agentName(d, entry.turn.agent)} color={agentColor(d, entry.turn.agent)} meta={`汇总 · ${OUTCOME_LABEL[entry.turn.outcome] || formatClock(entry.turn.createdAt)}`} variant="summary">
      <div className="summary-head">
        <b>第 {entry.round.index} 轮汇总{plan ? ` → 方案 v${plan.version} 草稿` : ""}</b>
        {sum && <span className="tag">{sum.answered}/{sum.expected} 参与</span>}
      </div>
      {sum?.report ? (
        <div className="summary-grid">
          <div><span className="summary-label">要点</span>{sum.report.points.map((p) => <p key={p.text}>{p.text}</p>)}</div>
          <div><span className="summary-label">风险</span>{sum.report.risks.map((x) => <p key={x}>{x}</p>)}</div>
          <div><span className="summary-label">遗漏</span>{sum.report.gaps.map((x) => <p key={x}>{x}</p>)}</div>
        </div>
      ) : (
        <LongText id={entry.turn.id} text={text} live={live} />
      )}
      {sum?.report?.extraInfoNotes.map((n) => <p key={n} className="extra-info">{n}</p>)}
      {sum && (
        <button type="button" className="button-outline summary-open" onClick={() => actions.openReview(entry.round.id)}>
          打开汇总与方案{plan ? ` v${plan.version}` : ""}
        </button>
      )}
    </Bubble>
  );
}

function Bubble(props: { who: string; color: string; meta: string; state?: string; variant?: "summary"; children: ReactNode }) {
  return (
    <article className="bubble" data-state={props.state} data-variant={props.variant} style={{ "--agent": props.color } as CSSProperties}>
      <div className="avatar" aria-hidden="true">{props.who.slice(0, 1)}</div>
      <div className="bubble-body">
        <div className="bubble-meta"><b>{props.who}</b> · {props.meta}</div>
        <div className="bubble-content">{props.children}</div>
      </div>
    </article>
  );
}

const FOLD_AT = 300;

function LongText({ id, text, live = false }: { id: string; text: string; live?: boolean }) {
  const expanded = useAppState((s) => !!s.disc.ui.expanded[id]);
  const actions = useActions();
  const long = !live && text.length > FOLD_AT;
  const shown = long && !expanded ? text.slice(0, FOLD_AT) + "……" : text;
  return (
    <>
      <p className="long-text">{shown}{live && <span className="cursor" aria-hidden="true">▍</span>}</p>
      {long && (
        <button type="button" className="button-link" onClick={() => actions.toggleExpanded(id)}>
          {expanded ? "收起" : `展开全文（${text.length.toLocaleString()} 字）`}
        </button>
      )}
    </>
  );
}

function Composer() {
  const d = useAppState((s) => s.disc);
  const actions = useActions();
  const round = openRound(d);
  const { text, recipients } = d.ui.composer;
  const discussants = d.agents.filter((a) => a.canDiscuss);
  const interjecting = round !== null && ["RUNNING", "PAUSED", "AWAITING_SUMMARY"].includes(round.state);
  const nextIndex = d.rounds.length + 1;
  const attached = planForNextRound(d);
  const paused = round?.state === "PAUSED";
  // 暂停中只能「放进下一轮」：要立刻发出去的补充得先恢复
  const mode = paused ? "next_round" : d.ui.interject.mode;
  const { targets } = d.ui.interject;

  return (
    <div className="composer">
      <RoundControls />
      {interjecting ? (
        <fieldset className="interject">
          <legend>插话：补充或改方向（第 {round!.index} 轮）</legend>
          <div className="interject-modes">
            <label><input type="radio" name="interject-mode" checked={mode === "restart_now"} disabled={paused} onChange={() => actions.setInterjectMode("restart_now")} /> 立刻打断，带上补充重答（旧的标「被打断」并保留）</label>
            <label><input type="radio" name="interject-mode" checked={mode === "next_round"} onChange={() => actions.setInterjectMode("next_round")} /> 不打断，放进下一轮</label>
            <label><input type="radio" name="interject-mode" checked={mode === "only"} disabled={paused} onChange={() => actions.setInterjectMode("only")} /> 只发给某个人（会标「他收到了额外信息」）</label>
          </div>
          {paused && <p className="step-hint">暂停中只能记下来放进下一轮；要立刻带上补充重答，先点「恢复」。</p>}
          {mode !== "next_round" && (
            <div className="composer-recipients">
              <span>发给：</span>
              {round!.recipients.map((aid) => (
                <label key={aid} className="recipient-chip" style={{ "--agent": agentColor(d, aid) } as CSSProperties}>
                  <input type="checkbox" checked={targets.includes(aid)} onChange={() => actions.toggleInterjectTarget(aid)} />
                  {agentName(d, aid)}
                </label>
              ))}
            </div>
          )}
        </fieldset>
      ) : (
        <div className="composer-recipients">
          <span>下一轮发给：</span>
          {discussants.map((a) => {
            const st = d.status[a.id]?.availability ?? "available";
            const unavailable = st !== "available";
            return (
              <label key={a.id} className="recipient-chip" data-unavailable={unavailable || undefined} style={{ "--agent": a.color } as CSSProperties}>
                <input type="checkbox" checked={recipients.includes(a.id)} disabled={unavailable} onChange={() => actions.toggleRecipient(a.id)} />
                {a.displayName}
                {unavailable && <span>（{st === "absent_quota" ? "缺席" : st === "offline" ? "离线" : st === "paused_by_user" ? "已暂停" : "未配置"}）</span>}
              </label>
            );
          })}
          {attached && <span className="composer-attach">附带：方案 v{attached.version}{attached.state === "FINAL" ? "（定稿）" : ""}</span>}
        </div>
      )}
      <div className="composer-row">
        <label htmlFor="composer" className="visually-hidden">发言</label>
        <textarea
          id="composer"
          rows={2}
          value={text}
          placeholder={interjecting ? "补充什么，或者想改什么方向……" : round ? "这一轮还在等盖章，可以先说点什么（只发言）" : "写下议题，或者下一轮的任务……"}
          onChange={(e) => actions.setComposerText(e.target.value)}
        />
        <button type="button" className="button-outline" disabled={!text.trim()} onClick={() => void actions.addNote()}>
          只发言
        </button>
        {interjecting ? (
          <button
            type="button"
            className="button-primary"
            disabled={!text.trim() || (mode !== "next_round" && targets.length === 0)}
            onClick={() => void actions.supplement()}
          >
            {mode === "next_round" ? "记下来，放进下一轮" : "预览并发送补充"}
          </button>
        ) : (
          <button
            type="button"
            className="button-primary"
            disabled={round !== null || !text.trim() || recipients.length === 0}
            title={round ? `第 ${round.index} 轮还没结束` : undefined}
            onClick={() => void actions.draftRound()}
          >
            预览并发起第 {nextIndex} 轮
          </button>
        )}
      </div>
    </div>
  );
}

/** 一轮还没结束时，输入框上方显示这一轮的操作（完整的进行中页面在 C-23） */
function RoundControls() {
  const d = useAppState((s) => s.disc);
  const actions = useActions();
  const round = openRound(d);
  if (!round) return null;
  const waiting = pendingBatches(d).find((b) => b.roundId === round.id);
  const summarizers = d.agents.filter((a) => a.canSummarize);
  const anyAnswer = d.turns.some((t) => t.roundId === round.id && !t.isSummary && t.outcome === "answered");
  return (
    <div className="round-controls" data-state={round.state}>
      <b>第 {round.index} 轮 · {ROUND_STATE_LABEL[round.state]}</b>
      {round.activeMs > 0 && <span className="round-time">用时 {formatActive(round.activeMs)}{round.state === "PAUSED" ? "（暂停中不计时）" : ""}</span>}
      {waiting && <button type="button" className="button-seal-small" onClick={() => void actions.openConfirm(waiting.id)}>去盖章</button>}
      {round.state === "RUNNING" && (
        <>
          <button type="button" className="button-outline" onClick={() => void actions.pauseRound(round.id)}>全部暂停</button>
          <button type="button" className="button-outline" onClick={() => void actions.endRound(round.id)}>结束本轮 → 汇总</button>
        </>
      )}
      {round.state === "PAUSED" && !waiting && (
        <>
          <button type="button" className="button-outline" onClick={() => void actions.resumeRound(round.id)}>恢复（重新盖章）</button>
          <button type="button" className="button-outline" onClick={() => void actions.endRound(round.id)}>结束本轮 → 汇总</button>
        </>
      )}
      {round.state === "AWAITING_SUMMARY" && !waiting && !anyAnswer && (
        <span className="round-time">这一轮没有任何回答，没什么可汇总的，可以改方向（作废这一轮）。</span>
      )}
      {round.state === "AWAITING_SUMMARY" && !waiting && anyAnswer &&
        summarizers.map((s) => (
          <button key={s.id} type="button" className="button-primary" onClick={() => void actions.summarize(round.id, s.id)}>
            请 {s.displayName} 汇总
          </button>
        ))}
      <span className="spacer" />
      <VoidRound roundId={round.id} />
    </div>
  );
}

/** 改方向：作废这一轮要写原因（Electron 不支持 window.prompt，用行内表单） */
function VoidRound({ roundId }: { roundId: string }) {
  const actions = useActions();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  if (!open) {
    return <button type="button" className="button-link" onClick={() => setOpen(true)}>改方向（作废这一轮）</button>;
  }
  return (
    <form
      className="void-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!reason.trim()) return;
        void actions.voidRound(roundId, reason.trim());
        setOpen(false);
        setReason("");
      }}
    >
      <label htmlFor="void-reason">这一轮会标成「作废」，记录保留。为什么改方向？</label>
      <input id="void-reason" autoFocus value={reason} maxLength={2000} onChange={(e) => setReason(e.target.value)} />
      <button type="submit" className="button-outline" disabled={!reason.trim()}>作废这一轮</button>
      <button type="button" className="button-link" onClick={() => setOpen(false)}>取消</button>
    </form>
  );
}

// ---------------------------------------------------------------- 右：方案与参与者

function SidePanel() {
  const d = useAppState((s) => s.disc);
  const actions = useActions();
  if (d.ui.sideCollapsed) {
    return (
      <aside className="disc-side" aria-label="方案与状态">
        <button type="button" className="icon-button" aria-label="展开右栏" onClick={actions.toggleSide}>«</button>
      </aside>
    );
  }
  const plan = displayedPlan(d);
  return (
    <aside className="disc-side" aria-label="方案与状态">
      <details open className="side-section">
        <summary>
          <b>方案</b>
          <span>{plan ? `v${plan.version} · ${planStateLabel(plan.state)}` : "还没有"}</span>
          <button type="button" className="icon-button" aria-label="收起右栏" onClick={(e) => (e.preventDefault(), actions.toggleSide())}>»</button>
        </summary>
        {plan ? (
          <>
            <pre className="plan-content">{plan.content}</pre>
            <p className="side-note">{plan.changeNote}{plan.draftedBy.kind === "agent" ? ` · ${agentName(d, plan.draftedBy.agent)} 起草` : " · 你改的"}</p>
            {plan.state === "DRAFT" && (
              <button type="button" className="button-outline" onClick={() => void actions.confirmPlan(plan.id)}>确认这一版</button>
            )}
            {plan.state === "CURRENT" && (
              <button type="button" className="button-seal" onClick={() => void actions.finalizePlan(plan.id, plan.contentHash)}>
                盖章定稿 v{plan.version}
              </button>
            )}
            {canDerive(d, plan) && (
              <button type="button" className="button-outline" onClick={() => void actions.derivePlan(plan.id)}>从 v{plan.version} 派生下一版</button>
            )}
          </>
        ) : (
          <>
            <p className="side-note">汇总后会出现方案草稿；也可以自己先写一版。</p>
            {d.plans.length === 0 && <FirstPlan compact />}
          </>
        )}
        <p className="side-note">讨论不会自己停，什么时候定稿由你决定。</p>
      </details>

      <details open className="side-section">
        <summary><b>参与者状态</b></summary>
        <ul className="agent-cards">
          {d.agents.map((a) => (
            <AgentCard key={a.id} d={d} id={a.id} />
          ))}
        </ul>
      </details>
    </aside>
  );
}

function AgentCard({ d, id }: { d: DiscussionState; id: string }) {
  const a = d.agents.find((x) => x.id === id)!;
  const st = d.status[id];
  const node = a.nodeId === "user-pc" ? "你的电脑" : a.nodeId === "controller-local" ? "主控机" : a.nodeId ?? "未配置节点";
  return (
    <li className="agent-card" data-state={st?.availability ?? "unknown"} style={{ "--agent": a.color } as CSSProperties}>
      <div className="agent-card-head">
        <b>{a.displayName}</b>
        <span>{node}</span>
        <span className="agent-card-state">{availabilityLabel(st)}</span>
      </div>
      {st?.billing === "api" && st.balance && (
        <p>API · 余额 <b>{st.balance.currency === "CNY" ? "¥" : ""}{st.balance.amount}</b>{st.balance.spentThisMonth ? ` · 本月已用 ${st.balance.spentThisMonth}` : ""}</p>
      )}
      {st?.billing === "subscription" && (
        <>
          <Meter label="5 小时额度剩余" w={st.fiveHour} />
          <Meter label="周额度剩余" w={st.weekly} />
        </>
      )}
      <p className="side-note">
        上下文 {st?.contextUsedPercent != null ? `${Math.round(st.contextUsedPercent)}%` : "未知"}
        {st?.compactions != null ? ` · 已压缩 ${st.compactions} 次` : ""}
        {st?.model ? ` · ${st.model}` : ""}
        {st?.effort ? ` · 强度 ${st.effort}` : ""}
      </p>
    </li>
  );
}

function Meter({ label, w }: { label: string; w: AgentStatus["fiveHour"] }) {
  if (!w) return <p className="side-note">{label} 未知</p>;
  const left = Math.max(0, Math.round(100 - w.usedPercent));
  return (
    <div className="meter">
      <p>{label} <b>{left}%</b>{w.resetsAt ? ` · ${formatClock(w.resetsAt)} 重置` : ""}</p>
      <div className="meter-track" aria-hidden="true"><div className="meter-fill" style={{ width: `${left}%` }} /></div>
    </div>
  );
}

function availabilityLabel(st: AgentStatus | undefined): string {
  switch (st?.availability) {
    case "available": return "在线";
    case "offline": return "离线";
    case "unconfigured": return "未配置";
    case "paused_by_user": return "已暂停";
    case "absent_quota": return "缺席（额度）";
    default: return "未知";
  }
}

function planStateLabel(s: string): string {
  return s === "DRAFT" ? "草稿，等你确认" : s === "CURRENT" ? "当前版本" : s === "FINAL" ? "已定稿" : "已取代";
}
