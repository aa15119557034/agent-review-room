import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import type { WorldActivity, WorldPlace, WorldResident, WorldSnapshot } from "@room/schemas";
import { WORLD_MAX_RESIDENTS } from "@room/schemas";
import { agentColor, agentName } from "../../lib/discussion";
import {
  ACTIVITY_DOING, ACTIVITY_LABEL, INVITABLE, REJECT_TEXT, activityProgress, budgetText, clockText, cognitionNote, commitmentViews,
  dayClockText, dayOf, dayPhase, eventText, gaugeLevel, isTimelineNoise, itemsHeldBy, itemsIn, knownItemText, placeKind, recentSaying,
  residentLine, worldNames, worldNow, type WorldNames,
} from "../../lib/world";
import { HoldButton } from "../HoldButton";
import { useActions, useAppState, useIsMock } from "../hooks";
import { Figure, ItemIcon } from "./Figure";
import { PastScenes, SceneView } from "./SceneView";
import { WorldSheet } from "./WorldSheet";
import "./world.css";

/**
 * 世界（ADR-008 / C-54）：秘书们的共享小屋。
 * 左边是俯视的小屋（房间、人、东西），右边是选中那位的状态、约定和最近发生的事。
 * 这里只显示后端给的状态和发命令；谁在哪、饭有几份都不在前端算。
 */
export function WorldView({ notice }: { notice: ReactNode }) {
  const loaded = useAppState((s) => s.world.loaded);
  const world = useAppState((s) => s.world.world);
  const actions = useActions();
  useEffect(() => {
    if (!loaded) void actions.world.load();
  }, [loaded, actions]);

  if (!loaded) return <main className="world world-empty" role="status">{notice}<p>正在打开小屋…</p></main>;
  if (!world) return <StartScreen notice={notice} />;
  return <Home world={world} notice={notice} />;
}

function useNames(world: WorldSnapshot | null): WorldNames {
  const disc = useAppState((s) => s.disc);
  return useMemo(() => worldNames(world, (a) => agentName(disc, a)), [world, disc]);
}

/** 世界里现在是第几分钟。按快照插值，每秒重算一次；暂停时不动 */
function useWorldMinutes(world: WorldSnapshot): number {
  const [, setBeat] = useState(0);
  const running = world.run.state === "running";
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setBeat((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [running]);
  return worldNow(world, Date.now());
}

// ---------------------------------------------------------------- 还没开始

/**
 * 选谁住进来。新开的一局最多 4 位（契约 WORLD_MAX_RESIDENTS）；以前存下的名单可能更长，只带出前 4 位让你重选。
 * 开始和重新开始都用它，提交时总是带上你选好的名单
 */
function useResidentChoice() {
  const agents = useAppState((s) => s.disc.agents);
  const settings = useAppState((s) => s.world.settings);
  const [picked, setPicked] = useState<string[] | null>(null);
  const chosen = picked ?? (settings?.residents ?? []).filter((a) => agents.some((x) => x.id === a)).slice(0, WORLD_MAX_RESIDENTS);
  const full = chosen.length >= WORLD_MAX_RESIDENTS;
  const toggle = (id: string) => {
    if (chosen.includes(id)) setPicked(chosen.filter((a) => a !== id));
    else if (!full) setPicked([...chosen, id]);
  };
  return { agents, chosen, full, toggle };
}

function ResidentPicker({ choice }: { choice: ReturnType<typeof useResidentChoice> }) {
  const { agents, chosen, full, toggle } = choice;
  return (
    <fieldset className="world-start-people" style={agents.length === 0 ? { display: "none" } : undefined}>
      <legend>谁住进来（最多 {WORLD_MAX_RESIDENTS} 位）</legend>
      {agents.map((a) => (
        <label key={a.id} style={{ "--agent": a.color } as CSSProperties}>
          <input type="checkbox" checked={chosen.includes(a.id)} disabled={full && !chosen.includes(a.id)} onChange={() => toggle(a.id)} />
          <Figure color={a.color} />
          <span>{a.displayName}</span>
        </label>
      ))}
    </fieldset>
  );
}

function StartScreen({ notice }: { notice: ReactNode }) {
  const loaded = useAppState((s) => s.world.loaded);
  const starting = useAppState((s) => s.world.starting);
  const actions = useActions();
  const choice = useResidentChoice();
  const { agents, chosen } = choice;
  return (
    <main className="world world-empty">
      {notice}
      <div className="world-start">
        <h1>小屋</h1>
        <p>秘书们住在这里过日子：自己做饭、看书、休息、互相说话。你也在这个家里，可以走到哪间屋、找谁说话、邀她一起做事。</p>
        {loaded && agents.length === 0 && <p className="world-start-hint" role="status">还没有配置秘书。先到「秘书」页配置至少一位，再回来开始。</p>}
        <ResidentPicker choice={choice} />
        <button type="button" className="button-primary" disabled={chosen.length === 0 || starting || !loaded} onClick={() => void actions.world.start(chosen)}>
          {starting ? "正在布置…" : "开始"}
        </button>
      </div>
    </main>
  );
}

// ---------------------------------------------------------------- 小屋

function Home({ world, notice }: { world: WorldSnapshot; notice: ReactNode }) {
  const names = useNames(world);
  const now = useWorldMinutes(world);
  const scene = useAppState((s) => s.world.scene);
  const knowledge = useAppState((s) => s.world.knowledge);
  const reviewDay = useAppState((s) => s.world.reviewDay);
  const pastScenes = useAppState((s) => s.world.pastScenes);
  return (
    <main className="world" data-phase={dayPhase(now)} data-paused={world.run.state === "paused" || undefined}>
      <WorldBar world={world} now={now} />
      <div className="world-stage">
        <House world={world} now={now} names={names} />
        {scene && <SceneView scene={scene} world={world} names={names} />}
      </div>
      <aside className="world-side" aria-label="居民和最近的事">
        {notice}
        <Rejected />
        <You world={world} names={names} />
        <ResidentPanel world={world} now={now} names={names} />
        <Commitments world={world} names={names} />
        <Timeline names={names} />
      </aside>
      {knowledge && <KnowledgeSheet names={names} />}
      {reviewDay !== null && <ReviewSheet day={reviewDay} today={dayOf(now)} />}
      {pastScenes && <PastScenes names={names} />}
    </main>
  );
}

const PHASE_LABEL = { night: "夜里", morning: "早上", day: "白天", evening: "傍晚" } as const;

function WorldBar({ world, now }: { world: WorldSnapshot; now: number }) {
  const actions = useActions();
  const isMock = useIsMock();
  const paused = world.run.state === "paused";
  const [asking, setAsking] = useState(false);
  return (
    <header className="world-bar">
      <div className="world-clock" role="timer" aria-label={`世界里的时间：${dayClockText(now)}`}>
        <span className="world-sun" aria-hidden="true" />
        <strong>{clockText(now)}</strong>
        <span>第 {dayOf(now)} 天 · {PHASE_LABEL[dayPhase(now)]}</span>
        {paused && <span className="world-paused-tag">{world.run.state === "paused" && world.run.by === "maintenance" ? "正在备份，稍后自动继续" : "已暂停"}</span>}
      </div>
      {isMock && <span className="mock-flag" title="演示数据只存在内存里，她们说的话是写死的几句">演示数据</span>}
      <div className="world-bar-actions">
        {paused ? (
          <button type="button" className="button-primary" onClick={() => void actions.world.resume()}>继续</button>
        ) : (
          <button type="button" className="button-outline" onClick={() => void actions.world.pause()}>暂停</button>
        )}
        <button type="button" className="button-outline" onClick={() => void actions.world.showReview()}>回顾</button>
        <button type="button" className="button-outline" onClick={() => void actions.world.showScenes()}>以前的对话</button>
        <button type="button" className="button-link" onClick={() => setAsking(true)}>重新开始</button>
      </div>
      {asking && <RestartSheet onClose={() => setAsking(false)} />}
    </header>
  );
}

/** 重新开始：先选好这一局谁住进来，再按住确认。名单总是跟着请求带过去，不沿用存着的（可能超过 4 位） */
function RestartSheet({ onClose }: { onClose: () => void }) {
  const actions = useActions();
  const starting = useAppState((s) => s.world.starting);
  const choice = useResidentChoice();
  return (
    <WorldSheet label="重新开始" onClose={onClose}>
      <p className="resident-note">重新开始会开新的一局，现在这一局的进度不带过去。</p>
      <ResidentPicker choice={choice} />
      {choice.chosen.length === 0 ? (
        <p className="resident-note" role="status">先选至少一位。</p>
      ) : (
        <HoldButton className="button-outline world-reset" hint="按住 1 秒重新开始" disabled={starting} onComplete={() => actions.world.reset(choice.chosen).finally(onClose)}>按住确认</HoldButton>
      )}
    </WorldSheet>
  );
}

function House({ world, now, names }: { world: WorldSnapshot; now: number; names: WorldNames }) {
  // 上面一排是各人的房间，下面一排是公共的屋子
  const rooms = world.places.filter((p) => p.owner !== null);
  const shared = world.places.filter((p) => p.owner === null);
  return (
    <section className="house" aria-label="小屋">
      <div className="house-row house-row-rooms">
        {rooms.map((p) => <Room key={p.id} place={p} world={world} now={now} names={names} />)}
      </div>
      <div className="house-row house-row-shared">
        {shared.map((p) => <Room key={p.id} place={p} world={world} now={now} names={names} />)}
      </div>
    </section>
  );
}

function Room({ place, world, now, names }: { place: WorldPlace; world: WorldSnapshot; now: number; names: WorldNames }) {
  const disc = useAppState((s) => s.disc);
  const actions = useActions();
  const here = world.player.placeId === place.id;
  const people = world.residents.filter((r) => r.placeId === place.id);
  const things = itemsIn(world, place.id);
  const go = () => {
    if (!here) void actions.world.goTo(place.id);
  };
  return (
    <div
      className="room"
      data-kind={placeKind(place)}
      data-here={here || undefined}
      style={place.owner ? ({ "--agent": agentColor(disc, place.owner) } as CSSProperties) : undefined}
      onClick={go}
    >
      <div className="room-head">
        <h2 title={names.place(place.id)}>{names.place(place.id)}</h2>
        {here ? (
          <span className="room-here">你在这里</span>
        ) : (
          <button type="button" className="room-go" onClick={(e) => { e.stopPropagation(); go(); }}>走过去</button>
        )}
      </div>
      <ul className="room-items" aria-label={`${names.place(place.id)}里的东西`}>
        {things.map((it) => (
          <li key={it.id} data-busy={(it.kind === "unique" && it.usedBy !== null) || undefined} data-empty={(it.kind === "stock" && it.count === 0) || undefined}>
            <ItemIcon id={it.id} />
            <span>{it.label}{it.kind === "stock" ? ` × ${it.count}` : it.usedBy ? "（在用）" : ""}</span>
          </li>
        ))}
      </ul>
      <div className="room-floor">
        {people.map((r) => <ResidentFigure key={r.agent} resident={r} world={world} now={now} names={names} />)}
        {here && <PlayerFigure world={world} now={now} />}
      </div>
    </div>
  );
}

function ActivityTag({ activity, now }: { activity: WorldActivity; now: number }) {
  return (
    <span className="fig-activity" data-kind={activity.kind}>
      {ACTIVITY_LABEL[activity.kind]}
      {activity.kind !== "sleep" && <progress value={activityProgress(activity, now)} max={1} aria-label="做到哪了" />}
    </span>
  );
}

function ResidentFigure({ resident, world, now, names }: { resident: WorldResident; world: WorldSnapshot; now: number; names: WorldNames }) {
  const disc = useAppState((s) => s.disc);
  const selected = useAppState((s) => s.world.selected === resident.agent);
  const saying = useAppState((s) => recentSaying(s.world.events, { kind: "resident", agent: resident.agent }, now));
  const actions = useActions();
  const activity = resident.activityId ? world.activities.find((a) => a.id === resident.activityId) : undefined;
  const asleep = activity?.kind === "sleep";
  const held = itemsHeldBy(world, { kind: "resident", agent: resident.agent });
  const name = names.agent(resident.agent);
  const expression = resident.energy < 25 ? "tired" : resident.satiety < 20 ? "sad" : resident.mood >= 70 ? "happy" : "neutral";
  return (
    <button
      type="button"
      className="person"
      data-selected={selected || undefined}
      data-doing={activity?.kind}
      aria-pressed={selected}
      aria-label={`${name}，${residentLine(resident, world, names)}`}
      onClick={(e) => { e.stopPropagation(); actions.world.select(resident.agent); }}
    >
      {saying && <span className="person-say">{saying}</span>}
      {activity && <ActivityTag activity={activity} now={now} />}
      <Figure color={agentColor(disc, resident.agent)} expression={expression} asleep={asleep} />
      {held.map((it) => <span key={it.id} className="person-held" title={`拿着${it.label}`}><ItemIcon id={it.id} /></span>)}
      <span className="person-name">{name}{resident.cognition.mode === "routine" && resident.cognition.reason === "offline" ? " · 不在线" : ""}</span>
    </button>
  );
}

function PlayerFigure({ world, now }: { world: WorldSnapshot; now: number }) {
  const activity = world.player.activityId ? world.activities.find((a) => a.id === world.player.activityId) : undefined;
  return (
    <span className="person person-you" data-doing={activity?.kind}>
      {activity && <ActivityTag activity={activity} now={now} />}
      <Figure color="#7b8794" player />
      <span className="person-name">你</span>
    </span>
  );
}

// ---------------------------------------------------------------- 右边

function Rejected() {
  const rejected = useAppState((s) => s.world.rejected);
  const actions = useActions();
  if (!rejected) return null;
  return (
    <p className="world-rejected" role="status" key={rejected.nonce}>
      <span>没做成：{REJECT_TEXT[rejected.reason]}</span>
      <button type="button" className="button-link" onClick={actions.world.dismissRejected}>知道了</button>
    </p>
  );
}

function You({ world, names }: { world: WorldSnapshot; names: WorldNames }) {
  const actions = useActions();
  const activity = world.player.activityId ? world.activities.find((a) => a.id === world.player.activityId) : undefined;
  const others = activity?.participants.filter((p) => p.kind === "resident").map((p) => (p.kind === "resident" ? names.agent(p.agent) : "")) ?? [];
  return (
    <section className="world-card world-you">
      <p>
        你在{names.place(world.player.placeId)}
        {activity ? `，${others.length ? `和${others.join("、")}一起` : ""}${ACTIVITY_LABEL[activity.kind]}` : "。点一间屋走过去，点一位秘书看她的情况。"}
      </p>
      {activity && <button type="button" className="button-outline" onClick={() => void actions.world.stop()}>停下</button>}
    </section>
  );
}

function Gauge({ label, value }: { label: string; value: number }) {
  return (
    <div className="gauge" data-level={gaugeLevel(value)}>
      <span>{label}</span>
      <meter min={0} max={100} low={25} high={60} optimum={90} value={value} aria-label={`${label} ${value}`} />
    </div>
  );
}

function ResidentPanel({ world, now, names }: { world: WorldSnapshot; now: number; names: WorldNames }) {
  const disc = useAppState((s) => s.disc);
  const selected = useAppState((s) => s.world.selected);
  const budgets = useAppState((s) => s.world.budgets);
  const sceneOpen = useAppState((s) => s.world.scene !== null);
  const actions = useActions();
  const resident = world.residents.find((r) => r.agent === selected) ?? world.residents[0];
  if (!resident) return null;
  const name = names.agent(resident.agent);
  const sameRoom = resident.placeId === world.player.placeId;
  const activity = resident.activityId ? world.activities.find((a) => a.id === resident.activityId) : undefined;
  const asleep = activity?.kind === "sleep";
  const note = cognitionNote(resident);
  const budget = budgetText(budgets, resident.agent);
  const canJoin = activity && sameRoom && !world.player.activityId && !asleep;
  return (
    <section className="world-card resident" style={{ "--agent": agentColor(disc, resident.agent) } as CSSProperties}>
      {world.residents.length > 1 && (
        <div className="resident-tabs" role="tablist" aria-label="看哪一位">
          {world.residents.map((r) => (
            <button key={r.agent} type="button" role="tab" aria-selected={r.agent === resident.agent} style={{ "--agent": agentColor(disc, r.agent) } as CSSProperties} onClick={() => actions.world.select(r.agent)}>
              {names.agent(r.agent)}
            </button>
          ))}
        </div>
      )}
      <h2>{name}</h2>
      <p className="resident-line">
        {residentLine(resident, world, names)}
        {activity && activity.kind !== "sleep" ? `，到 ${clockText(activity.endsAt)}` : ""}
        {activity && now < activity.endsAt && activity.kind === "sleep" ? `，${clockText(activity.endsAt)} 起` : ""}
      </p>
      {note && <p className="resident-note">{note}</p>}
      <Gauge label="体力" value={resident.energy} />
      <Gauge label="饱腹" value={resident.satiety} />
      <Gauge label="心情" value={resident.mood} />
      {budget && <p className="resident-budget">今天的思考次数 {budget}</p>}

      {sameRoom ? (
        <>
          <div className="resident-actions">
            <button type="button" className="button-primary" disabled={sceneOpen} onClick={() => void actions.world.talk(resident.agent)}>找她说话</button>
            {canJoin && <button type="button" className="button-outline" onClick={() => void actions.world.join(activity.id)}>加入，一起{ACTIVITY_LABEL[activity.kind]}</button>}
          </div>
          {!asleep && (
            <div className="resident-invite">
              <span>邀她：</span>
              {INVITABLE.map((k) => (
                <button key={k} type="button" className="chip" onClick={() => void actions.world.invite(resident.agent, k)}>{ACTIVITY_LABEL[k]}</button>
              ))}
            </div>
          )}
          {asleep && <p className="resident-note">她{ACTIVITY_DOING.sleep}，等她醒了再邀。</p>}
        </>
      ) : (
        <div className="resident-actions">
          <button type="button" className="button-outline" onClick={() => void actions.world.goTo(resident.placeId)}>走到{names.place(resident.placeId)}找她</button>
        </div>
      )}
      <button type="button" className="button-link" onClick={() => void actions.world.showKnowledge(resident.agent)}>她知道什么</button>
    </section>
  );
}

function Commitments({ world, names }: { world: WorldSnapshot; names: WorldNames }) {
  const actions = useActions();
  const list = commitmentViews(world, names);
  if (list.length === 0) return null;
  return (
    <section className="world-card">
      <h2>约定</h2>
      <ul className="commitments">
        {list.map((c) => (
          <li key={c.id} data-state={c.state}>
            <span>{c.text}</span>
            {c.awaitingYou && (
              <span className="commitment-answer">
                <button type="button" className="chip" onClick={() => void actions.world.answer(c.id, "accept")}>好</button>
                <button type="button" className="chip" onClick={() => void actions.world.answer(c.id, "later")}>晚点</button>
                <button type="button" className="chip" onClick={() => void actions.world.answer(c.id, "decline")}>来不了</button>
              </span>
            )}
            {c.cancellable && !c.awaitingYou && <button type="button" className="button-link" onClick={() => void actions.world.cancel(c.id)}>取消</button>}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Timeline({ names }: { names: WorldNames }) {
  const events = useAppState((s) => s.world.events);
  const more = useAppState((s) => s.world.eventsBefore !== null);
  const actions = useActions();
  const shown = events.filter((e) => !isTimelineNoise(e));
  return (
    <section className="world-card world-timeline">
      <h2>最近的事</h2>
      {shown.length === 0 ? (
        <p className="resident-note">还没有发生什么。</p>
      ) : (
        <ol>
          {shown.map((e) => (
            <li key={e.seq} data-type={e.type}>
              <time>{clockText(e.at)}</time>
              <span>{eventText(e, names)}</span>
            </li>
          ))}
        </ol>
      )}
      {more && <button type="button" className="button-link" onClick={() => void actions.world.loadMoreEvents()}>更早的</button>}
    </section>
  );
}

// ---------------------------------------------------------------- 弹层

function KnowledgeSheet({ names }: { names: WorldNames }) {
  const knowledge = useAppState((s) => s.world.knowledge)!;
  const actions = useActions();
  const name = names.agent(knowledge.agent);
  const data = knowledge.data;
  return (
    <WorldSheet label={`${name}知道什么`} onClose={actions.world.closeKnowledge}>
      <p className="side-note">只有她亲眼看到、亲耳听到的。可能是旧的，和现在真实的情况不一样是正常的。</p>
      {!data ? (
        <p role="status">正在读…</p>
      ) : (
        <>
          <h3>东西在哪</h3>
          {data.knownItems.length === 0 ? <p className="resident-note">她还没见过屋里的东西。</p> : (
            <ul className="world-list">{data.knownItems.map((k) => <li key={k.itemId}>{knownItemText(k, names)}</li>)}</ul>
          )}
          <h3>最近看到的</h3>
          {data.seen.length === 0 ? <p className="resident-note">没有。</p> : (
            <ol className="world-list">{data.seen.slice(0, 30).map((e) => <li key={e.seq}><time>{dayClockText(e.at)}</time> {eventText(e, names)}</li>)}</ol>
          )}
          <h3>最近听到的</h3>
          {data.heard.length === 0 ? <p className="resident-note">没有。</p> : (
            <ol className="world-list">{data.heard.slice(0, 30).map((h) => <li key={h.seq}><time>{dayClockText(h.at)}</time> {h.speaker.kind === "player" ? "你" : names.agent(h.speaker.agent)}：「{h.text}」</li>)}</ol>
          )}
        </>
      )}
    </WorldSheet>
  );
}

function ReviewSheet({ day, today }: { day: number; today: number }) {
  const review = useAppState((s) => s.world.reviews[day]);
  const actions = useActions();
  return (
    <WorldSheet label={`第 ${day} 天的回顾`} onClose={actions.world.closeReview}>
      <div className="review-nav">
        <button type="button" className="button-outline" disabled={day <= 1} onClick={() => void actions.world.showReview(day - 1)}>前一天</button>
        <button type="button" className="button-outline" disabled={day >= today - 1} onClick={() => void actions.world.showReview(day + 1)}>后一天</button>
      </div>
      {!review ? (
        <p className="resident-note">{day >= today ? "这一天还没过完，过完以后这里会有回顾。" : "这一天没有留下回顾。"}</p>
      ) : review.items.length === 0 ? (
        <p className="resident-note">这一天很平静，没有特别的事。</p>
      ) : (
        <ol className="world-list">{review.items.map((it) => <li key={it.seqs.join("-")}>{it.text}</li>)}</ol>
      )}
    </WorldSheet>
  );
}
