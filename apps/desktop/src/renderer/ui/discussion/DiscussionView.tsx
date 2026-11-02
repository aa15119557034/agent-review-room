import { useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import type { AgentStatus, Message, Project, Turn } from "@room/schemas";
import { GROUP_LABEL, groupTopics, statusFor, todoCount, type TodoItem, type TopicPerson, type TopicStatus } from "../../lib/topic-board";
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
import { RECOMMENDED_NODES } from "../../lib/presets";
import { useActions, useAppState } from "../hooks";
import { ReplyBody } from "../Chart";
import { hasChart } from "../../lib/media";
import { formatClock } from "../labels";
import { HoldButton } from "../HoldButton";
import { ConfirmView } from "./ConfirmView";
import { ReviewView } from "./ReviewView";
import { FirstPlan } from "./FirstPlan";
import { NewTopic } from "./NewTopic";

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
  const pane = useAppState((s) => s.disc.ui.pane);
  const sheet = useAppState((s) => s.disc.ui.sheet);

  if (!available) {
    return (
      <main className="disc-unavailable">
        {notice}
        <h1>讨论室还没有接上后端</h1>
        <p>后端的讨论室功能（D-21）还没接上。开发界面时在地址后加 <code>?mock</code> 可以看演示数据。</p>
      </main>
    );
  }

  return (
    <div className="disc" data-rail={railCollapsed ? "collapsed" : "open"} data-side={sideCollapsed ? "collapsed" : "open"} data-pane={pane} data-sheet={sheet || undefined} data-page={confirm ? "confirm" : page.kind}>
      <TopicRail />
      <main className="disc-main">
        {notice}
        {confirm ? <ConfirmView /> : page.kind === "review" ? <ReviewView roundId={page.roundId} /> : page.kind === "new" ? <NewTopic /> : <Conversation />}
      </main>
      <SidePanel />
    </div>
  );
}

// ---------------------------------------------------------------- 左：议题栏

/**
 * 草案「讨论室」：标题「讨论室」+「＋ 新议题」；分组「等你处理 / 进行中 / 还没开始 / 已定稿」。
 * 宽屏是一行名字 + 一句状态（等你处理的带红点）；手机是白色圆角卡片，右边带「去盖章 / 看一下」，
 * 正在答的议题下面列每人状态和「暂停 / 补充一句」（这些按钮宽屏收起来，点开议题再操作）。
 */
function TopicRail() {
  const projects = useAppState((s) => s.projects);
  const currentId = useAppState((s) => s.currentProjectId);
  const collapsed = useAppState((s) => s.disc.ui.railCollapsed);
  const creating = useAppState((s) => s.disc.ui.page.kind === "new");
  const d = useAppState((s) => s.disc);
  const actions = useActions();

  const groups = groupTopics(projects, (p) => statusFor(d, currentId, p));
  const todoN = groups.find((g) => g.group === "todo")?.items.reduce((n, x) => n + x.status.todos.length, 0) ?? 0;

  if (collapsed) {
    return (
      <nav className="disc-rail" aria-label="议题">
        <button type="button" className="icon-button" aria-label="展开议题栏" onClick={actions.toggleRail}>»</button>
        {todoN > 0 && <span className="chat-badge" aria-label={`${todoN} 件等你处理`}>{todoN}</span>}
      </nav>
    );
  }

  const open = (projectId: string) => {
    actions.showTopicPane();
    if (projectId !== currentId) void actions.selectProject(projectId);
    else if (creating) actions.closeReview();
  };

  return (
    <nav className="disc-rail" aria-label="议题">
      <div className="disc-rail-head">
        <h2>讨论室</h2>
        <button type="button" className="disc-new-button" aria-pressed={creating} onClick={() => (actions.openNewTopic(), actions.showTopicPane())}>
          ＋ 新议题
        </button>
        <button type="button" className="icon-button disc-rail-collapse" aria-label="收起议题栏" onClick={actions.toggleRail}>«</button>
      </div>
      {groups.map((g) => (
        <section key={g.group} className="disc-topic-group" data-group={g.group} aria-label={GROUP_LABEL[g.group]}>
          <h3>{GROUP_LABEL[g.group]}{g.group === "todo" ? ` · ${todoN}` : ""}</h3>
          <ul className="disc-topics">
            {g.items.map(({ project, status }) => (
              <li key={project.id}>
                <TopicRow project={project} status={status} current={project.id === currentId && !creating} onOpen={open} />
              </li>
            ))}
          </ul>
        </section>
      ))}
      {projects.length === 0 && <p className="disc-rail-more">还没有议题，点「＋ 新议题」建一个。</p>}
    </nav>
  );
}

const PERSON_LABEL: Record<TopicPerson["state"], string> = { answered: "已答", running: "回答中", waiting: "等着", stopped: "停下了", missed: "没答上" };

function TopicRow(props: { project: Project; status: TopicStatus; current: boolean; onOpen: (id: string) => void }) {
  const { project, status } = props;
  const d = useAppState((s) => s.disc);
  const actions = useActions();
  const todo = status.todos[0];
  const final = status.group === "final";
  const live = status.live;
  const doTodo = () => {
    actions.showTopicPane();
    void actions.openTodo(todo!);
  };
  return (
    <div className="disc-topic-card" data-group={status.group} aria-current={props.current ? "page" : undefined}>
      <button type="button" className="disc-topic" aria-current={props.current ? "page" : undefined} onClick={() => props.onOpen(project.id)}>
        <span className="disc-topic-name">
          {project.name}
          {todo && <span className="disc-dot" aria-label="等你处理" />}
        </span>
        <span className="disc-topic-line">{status.line}</span>
      </button>
      {todo && (
        <button type="button" className={todo.kind === "stamp" ? "disc-topic-act button-seal-small" : "disc-topic-act button-outline"} onClick={doTodo}>
          {todo.kind === "stamp" ? "去盖章" : todo.kind === "summarize" ? "请人汇总" : "看一下"}
        </button>
      )}
      {final && <span className="disc-final-stamp" aria-hidden="true">定稿</span>}
      {live && (
        <div className="disc-topic-live">
          <ul className="disc-people" aria-label="每人状态">
            {live.people.map((p) => (
              <li key={p.agent} data-state={p.state} style={{ "--agent": agentColor(d, p.agent) } as CSSProperties}>
                {agentName(d, p.agent)} {PERSON_LABEL[p.state]}{p.by ? `（${agentName(d, p.by)}代）` : ""}
              </li>
            ))}
          </ul>
          <div className="disc-topic-buttons">
            {live.paused ? (
              <button type="button" className="button-quiet" onClick={() => (props.onOpen(project.id))}>恢复</button>
            ) : (
              <button type="button" className="button-quiet" onClick={() => void actions.pauseRound(live.roundId)}>暂停</button>
            )}
            <button type="button" className="button-quiet" onClick={() => (props.onOpen(project.id), focusComposerSoon())}>补充一句</button>
          </div>
        </div>
      )}
    </div>
  );
}

const todoKey = (t: TodoItem) =>
  t.kind === "stamp" ? t.batchId : t.kind === "confirm_plan" ? t.planId : `${t.kind}-${t.roundId}`;

/** 顶栏「讨论」上的角标：所有议题等你盖章 / 确认的事（C-38） */
export function DiscussionBadge() {
  const n = useAppState((s) => (s.disc.available ? todoCount(s.disc, s.currentProjectId, s.projects) : 0));
  if (!n) return null;
  return <span className="chat-badge" aria-label={`${n} 件等你处理`}>{n > 99 ? "99+" : n}</span>;
}

/** 手机宽度下，议题标题左边的「‹」回到议题列表（宽屏隐藏），带等你处理的数 */
function BackToList() {
  const actions = useActions();
  const n = useAppState((s) => todoCount(s.disc, s.currentProjectId, s.projects));
  return (
    <button type="button" className="icon-button disc-back" aria-label={`返回议题列表${n ? `（${n} 件等你处理）` : ""}`} onClick={actions.showTopicList}>
      ‹{n > 0 && <span className="chat-badge" aria-hidden="true">{n}</span>}
    </button>
  );
}

// ---------------------------------------------------------------- 中：时间线 + 输入框

function Conversation() {
  const project = useAppState((s) => s.projects.find((p) => p.id === s.currentProjectId) ?? null);
  const d = useAppState((s) => s.disc);
  const fromChat = useAppState((s) => s.messages.some((m) => m.kind === "chat_material"));
  const actions = useActions();
  if (!project) {
    return (
      <section className="disc-empty">
        <h1>从左边选一个议题，或者新建一个</h1>
        <p>每一轮发给谁、带上什么，都先给你看全文；你盖章了才发出去。</p>
      </section>
    );
  }
  const people = d.agents.filter((a) => a.canDiscuss).map((a) => a.displayName).join(" · ");
  const sub = [fromChat ? "从聊天转来" : people, d.rounds.length ? `${d.rounds.length} 轮` : "还没开始"].join(" · ");
  return (
    <>
      <header className="disc-head">
        <BackToList />
        <div className="disc-head-title">
          <h1>{project.name}</h1>
          <span className="disc-head-meta">{sub}</span>
        </div>
        <StagePills />
        <button
          type="button"
          className="icon-button disc-side-toggle"
          aria-label="方案和参与者"
          aria-pressed={narrow() ? d.ui.sheet : !d.ui.sideCollapsed}
          onClick={() => (narrow() ? actions.toggleSheet() : actions.toggleSide())}
        >
          <SideIcon />
        </button>
      </header>
      <Timeline />
      <Composer />
    </>
  );
}

function SideIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <rect x="3.5" y="4.5" width="17" height="15" rx="3" />
      <path d="M15 4.5v15" />
    </svg>
  );
}

/**
 * 草案顶上的进度胶囊：「第 1 轮 ✓」「汇总 · 方案 v1 ✓」「第 2 轮 · 等你盖章」。
 * 只放轮次和汇总（议题 / 执行这种固定的不放）；做完的灰色带 ✓，当前的黑色。点做完的汇总打开汇总与方案。
 */
function StagePills() {
  const d = useAppState((s) => s.disc);
  const actions = useActions();
  const list = stages(d).filter((st) => st.roundId !== null || (st.key === "final" && st.state === "done"));
  if (list.length === 0) return null;
  const waiting = pendingBatches(d);
  return (
    <nav className="stage-bar" aria-label="进度">
      {list.map((st) => {
        const isSum = st.key.endsWith("-sum");
        const round = st.roundId ? d.rounds.find((r) => r.id === st.roundId) : undefined;
        let label = st.label.replace(/^汇总 v(\d+)$/, "汇总 · 方案 v$1");
        if (st.state === "current" && round && !isSum) {
          label += waiting.some((b) => b.roundId === round.id) ? " · 等你盖章" : ` · ${ROUND_STATE_LABEL[round.state]}`;
        }
        const done = st.state === "done";
        const content = <>{label}{done && <span aria-label="已完成"> ✓</span>}</>;
        return isSum && done ? (
          <button key={st.key} type="button" className="stage" data-state={st.state} onClick={() => actions.openReview(st.roundId!)}>{content}</button>
        ) : (
          <span key={st.key} className="stage" data-state={st.state} aria-current={st.state === "current" ? "step" : undefined}>{content}</span>
        );
      })}
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
    case "material":
      return (
        <Bubble who="聊天" color="var(--ink-soft)" meta={`从聊天转来的材料 · ${entry.message.chatMessageIds.length} 条消息 · ${formatClock(entry.message.createdAt)}`}>
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
  // 草案：「第 1 轮 · 发给 C酱、汐、林离 · 你已盖章 21:30 · 用时 4 分钟」；还在进行的轮才写状态
  const ongoing = round.state !== "SUMMARIZED";
  return (
    <div className="round-bar" data-state={round.state}>
      <button type="button" className="round-bar-toggle" aria-expanded={!collapsed} title={collapsed ? "展开这一轮" : "收起这一轮"} onClick={() => actions.toggleRound(round.id)}>
        第 {round.index} 轮 · 发给 {round.recipients.map((r) => agentName(d, r)).join("、")}
        {stamped && <> · <b className="stamped">你已盖章</b> {formatClock(stamped.decidedAt ?? stamped.createdAt)}</>}
        {ongoing && !waiting && ` · ${ROUND_STATE_LABEL[round.state]}`}
        {round.activeMs > 0 && ` · 用时 ${formatActive(round.activeMs)}`}
      </button>
      {round.state === "VOIDED" && round.voidReason && <span className="round-bar-note">作废原因：{round.voidReason}</span>}
      {waiting && (
        <button type="button" className="round-bar-wait" onClick={() => void actions.openConfirm(waiting.id)}>
          第 {round.index} 轮 · 内容已拼好，等你盖章
        </button>
      )}
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
  const meta = [turn.onBehalfOf ? `代 ${agentName(d, turn.onBehalfOf)}` : null, label || (turn.outcome === "answered" ? "已答" : formatClock(turn.createdAt))].filter(Boolean).join(" · ");
  return (
    <Bubble who={agentName(d, turn.agent)} color={agentColor(d, turn.agent)} meta={meta} state={turn.outcome} title={formatClock(turn.createdAt)}>
      {text ? <LongText id={turn.id} text={text} live={live} /> : <p className="turn-empty">{live ? "正在思考…" : "（没有输出）"}</p>}
      {canRetry && (
        <button type="button" className="button-link" onClick={() => void actions.retryAgent(turn.roundId, turn.agent)}>
          单独重试 {agentName(d, turn.agent)}
        </button>
      )}
    </Bubble>
  );
}

type SummaryTab = "points" | "risks" | "gaps";

/** 草案：汇总卡「C 第 1 轮汇总 → 方案 v1 · 3/3 参与」，下面分页签「要点 / 风险 / 遗漏 / 谁同意什么」 */
function SummaryCard({ entry }: { entry: Extract<TimelineEntry, { kind: "summary" }> }) {
  const d = useAppState((s) => s.disc);
  const actions = useActions();
  const events = useAppState((s) => (entry.turn.runId ? s.runEvents[entry.turn.runId] : undefined));
  const [tab, setTab] = useState<SummaryTab>("points");
  const { text, live } = turnText(entry.turn, entry.reply, events);
  const sum = entry.summary;
  const plan = sum?.planVersionId ? d.plans.find((p) => p.id === sum.planVersionId) : undefined;
  const report = sum?.report;
  const lists: Record<SummaryTab, string[]> = report
    ? { points: report.points.map((p) => p.text), risks: report.risks, gaps: report.gaps }
    : { points: [], risks: [], gaps: [] };
  const TAB_LABEL: Record<SummaryTab, string> = { points: "要点", risks: "风险", gaps: "遗漏" };
  const who = agentName(d, entry.turn.agent);
  return (
    <article className="summary-card" style={{ "--agent": agentColor(d, entry.turn.agent) } as CSSProperties}>
      <div className="summary-head">
        <span className="avatar" aria-hidden="true">{who.slice(0, 1)}</span>
        <b>第 {entry.round.index} 轮汇总{plan ? ` → 方案 v${plan.version}` : ""}</b>
        <span className="summary-by">{who}{live ? " · 汇总中" : ""}</span>
        {sum && <span className="summary-count">{sum.answered}/{sum.expected} 参与</span>}
      </div>
      {report ? (
        <>
          <div className="summary-tabs" role="tablist" aria-label="汇总内容">
            {(Object.keys(TAB_LABEL) as SummaryTab[]).map((k) => (
              <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>
                {TAB_LABEL[k]} {lists[k].length}
              </button>
            ))}
            <button type="button" role="tab" aria-selected={false} onClick={() => actions.openReview(entry.round.id)}>谁同意什么</button>
          </div>
          {lists[tab].length ? (
            <ul className="summary-list">{lists[tab].map((x) => <li key={x}>{x}</li>)}</ul>
          ) : (
            <p className="side-note">没有{TAB_LABEL[tab]}。</p>
          )}
          {report.extraInfoNotes.map((n) => <p key={n} className="extra-info">{n}</p>)}
        </>
      ) : (
        <LongText id={entry.turn.id} text={text} live={live} />
      )}
      {sum && (
        <button type="button" className="button-outline summary-open" onClick={() => actions.openReview(entry.round.id)}>
          {plan ? `打开方案 v${plan.version}` : "打开汇总"}
        </button>
      )}
    </article>
  );
}

function Bubble(props: { who: string; color: string; meta: string; state?: string; title?: string; children: ReactNode }) {
  return (
    <article className="bubble" data-state={props.state} style={{ "--agent": props.color } as CSSProperties}>
      <div className="avatar" aria-hidden="true">{props.who.slice(0, 1)}</div>
      <div className="bubble-body">
        <div className="bubble-meta" title={props.title}><b>{props.who}</b> · {props.meta}</div>
        <div className="bubble-content">{props.children}</div>
      </div>
    </article>
  );
}

const FOLD_AT = 300;

function LongText({ id, text, live = false }: { id: string; text: string; live?: boolean }) {
  const expanded = useAppState((s) => !!s.disc.ui.expanded[id]);
  const actions = useActions();
  // 带 ```room-chart 的发言 / 汇总（C-43）：图表画出来，不折叠（折一半会把图表切断）
  if (!live && hasChart(text)) return <ReplyBody text={text} className="long-text" />;
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

/**
 * 草案的输入卡片：第一行「发给 C酱✓ 汐✓ 林离✓ ……… 带上方案 v1」，第二行输入框 + 红色「去盖章」。
 * 一轮还没结束时上面多一行这一轮的状态和操作；插话时「发给」换成三种插话方式。
 */
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
  const MODES = [
    { key: "restart_now", label: "立刻打断重答", hint: "旧回答标「被打断」并保留" },
    { key: "next_round", label: "放进下一轮", hint: "不打断，下一轮一起带上" },
    { key: "only", label: "只发给某人", hint: "会标「他收到了额外信息」" },
  ] as const;

  return (
    <div className="composer">
      <RoundControls />
      <div className="composer-card">
        {interjecting ? (
          <div className="composer-recipients">
            <span className="composer-label">补充</span>
            <div className="interject-modes" role="radiogroup" aria-label={`插话方式（第 ${round!.index} 轮）`}>
              {MODES.map((m) => (
                <button
                  key={m.key}
                  type="button"
                  role="radio"
                  aria-checked={mode === m.key}
                  title={m.hint}
                  disabled={paused && m.key !== "next_round"}
                  onClick={() => actions.setInterjectMode(m.key)}
                >
                  {m.label}
                </button>
              ))}
            </div>
            {mode !== "next_round" &&
              round!.recipients.map((aid) => (
                <label key={aid} className="recipient-chip" style={{ "--agent": agentColor(d, aid) } as CSSProperties}>
                  <input type="checkbox" checked={targets.includes(aid)} onChange={() => actions.toggleInterjectTarget(aid)} />
                  {agentName(d, aid)}
                </label>
              ))}
          </div>
        ) : (
          <div className="composer-recipients">
            <span className="composer-label">发给</span>
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
            {attached && <span className="composer-attach">带上方案 v{attached.version}{attached.state === "FINAL" ? "（定稿）" : ""}</span>}
          </div>
        )}
        {paused && interjecting && <p className="step-hint">暂停中只能记下来放进下一轮；要立刻带上补充重答，先点「恢复」。</p>}
        <div className="composer-row">
          <label htmlFor="composer" className="visually-hidden">发言</label>
          <textarea
            id="composer"
            rows={1}
            value={text}
            placeholder={interjecting ? "补充什么，或者想改什么方向……" : round ? "这一轮还在等盖章，可以先说点什么（只发言）" : `写下第 ${nextIndex} 轮的任务……`}
            onChange={(e) => actions.setComposerText(e.target.value)}
          />
          <button type="button" className="button-quiet" disabled={!text.trim()} title="写进时间线，不发给任何人" onClick={() => void actions.addNote()}>
            只发言
          </button>
          {interjecting ? (
            <button
              type="button"
              className={mode === "next_round" ? "button-primary" : "button-seal-small composer-seal"}
              disabled={!text.trim() || (mode !== "next_round" && targets.length === 0)}
              onClick={() => void actions.supplement()}
            >
              {mode === "next_round" ? "记下来" : "去盖章"}
            </button>
          ) : (
            <button
              type="button"
              className="button-seal-small composer-seal"
              disabled={round !== null || !text.trim() || recipients.length === 0}
              title={round ? `第 ${round.index} 轮还没结束` : `先看每人收到的全文，再盖章发出第 ${nextIndex} 轮`}
              onClick={() => void actions.draftRound()}
            >
              去盖章
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** 一轮还没结束时，输入卡片上方一行：这一轮的状态和操作 */
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
      <b>第 {round.index} 轮 · {waiting ? "等你盖章" : ROUND_STATE_LABEL[round.state]}</b>
      {round.activeMs > 0 && <span className="round-time">用时 {formatActive(round.activeMs)}{round.state === "PAUSED" ? "（暂停中不计时）" : ""}</span>}
      {waiting && <button type="button" className="button-seal-small" onClick={() => void actions.openConfirm(waiting.id)}>去盖章</button>}
      {round.state === "RUNNING" && (
        <>
          <button type="button" className="button-quiet" onClick={() => void actions.pauseRound(round.id)}>全部暂停</button>
          <button type="button" className="button-quiet" onClick={() => void actions.endRound(round.id)}>结束本轮 → 汇总</button>
        </>
      )}
      {round.state === "PAUSED" && !waiting && (
        <>
          <button type="button" className="button-quiet" onClick={() => void actions.resumeRound(round.id)}>恢复（重新盖章）</button>
          <button type="button" className="button-quiet" onClick={() => void actions.endRound(round.id)}>结束本轮 → 汇总</button>
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

/**
 * 草案右栏两张卡：「方案」（版本标签、前几行、看全文和历史版本）和「参与者」（谁在线、谁汇总）。
 * 额度不放这里了（草案：讨论室只说在不在线；额度在「秘书」页看）。
 */
function SidePanel() {
  const d = useAppState((s) => s.disc);
  const actions = useActions();
  if (d.ui.sideCollapsed) return <aside className="disc-side" data-collapsed aria-label="方案与参与者" />;
  const plan = displayedPlan(d);
  const reviewRound = plan?.basedOnRoundId ?? [...d.summaries].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0]?.roundId ?? null;
  return (
    <aside className="disc-side" aria-label="方案与参与者">
      <section className="side-card" aria-label="方案">
        <header>
          <h2>方案</h2>
          {plan && <span className="side-tag" data-state={plan.state}>v{plan.version} · {planStateShort(plan.state)}</span>}
          <button type="button" className="icon-button side-close" aria-label="收起" onClick={() => (narrow() ? actions.toggleSheet() : actions.toggleSide())}>×</button>
        </header>
        {plan ? (
          <>
            <p className="plan-preview">{plan.content}</p>
            {reviewRound && (
              <button type="button" className="button-link side-more" onClick={() => actions.openReview(reviewRound)}>看全文和历史版本 ›</button>
            )}
            <div className="side-actions">
              {plan.state === "DRAFT" && (
                <button type="button" className="button-outline" onClick={() => void actions.confirmPlan(plan.id)}>确认这一版</button>
              )}
              {plan.state === "CURRENT" && (
                <HoldButton className="button-seal" resetKey={plan.id + plan.contentHash} onComplete={() => actions.finalizePlan(plan.id, plan.contentHash)}>
                  盖章定稿 v{plan.version}
                </HoldButton>
              )}
              {canDerive(d, plan) && (
                <button type="button" className="button-outline" onClick={() => void actions.derivePlan(plan.id)}>从 v{plan.version} 派生下一版</button>
              )}
            </div>
          </>
        ) : (
          <>
            <p className="side-note">汇总后会出现方案草稿；也可以自己先写一版。</p>
            {d.plans.length === 0 && <FirstPlan compact />}
          </>
        )}
      </section>

      <section className="side-card" aria-label="参与者">
        <header><h2>参与者</h2></header>
        <ul className="side-people">
          {d.agents.filter((a) => a.canDiscuss || a.canSummarize).map((a) => (
            <Participant key={a.id} d={d} id={a.id} />
          ))}
        </ul>
        <p className="side-note">讨论不会自己停，什么时候定稿由你决定。额度在「秘书」页看。</p>
      </section>
    </aside>
  );
}

function Participant({ d, id }: { d: DiscussionState; id: string }) {
  const a = d.agents.find((x) => x.id === id)!;
  const st = d.status[id];
  // 推荐节点用推荐配置里的名字（主控机拆成汐 / 林离两个节点，D-40），其它节点显示 id
  const node = a.nodeId === null ? "未配置节点" : (RECOMMENDED_NODES.find((n) => n.id === a.nodeId)?.label ?? a.nodeId);
  const ctx = st?.contextUsedPercent != null ? `上下文 ${Math.round(st.contextUsedPercent)}%${st.compactions ? ` · 压缩 ${st.compactions} 次` : ""}` : null;
  return (
    <li className="side-person" data-state={st?.availability ?? "unknown"} style={{ "--agent": a.color } as CSSProperties} title={[node, ctx].filter(Boolean).join(" · ")}>
      <span className="avatar" aria-hidden="true">{a.displayName.slice(0, 1)}</span>
      <span className="side-person-name">
        {a.displayName}
        {a.canSummarize && <span className="side-person-role"> · 汇总</span>}
      </span>
      <span className="side-person-state">{availabilityLabel(st)}</span>
    </li>
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

function planStateShort(s: string): string {
  return s === "DRAFT" ? "草稿" : s === "CURRENT" ? "当前" : s === "FINAL" ? "定稿" : "已取代";
}

/** 「补充一句」：打开议题后把光标放进输入框 */
function focusComposerSoon() {
  setTimeout(() => document.getElementById("composer")?.focus(), 60);
}

/** 手机宽度（和 CSS 的 720px 断点一致） */
const narrow = () => typeof window !== "undefined" && window.matchMedia?.("(max-width: 720px)").matches === true;
