import { useState, type CSSProperties } from "react";
import type { PlanVersion } from "@room/schemas";
import { STANCE_LABEL, agentColor, agentName, canDerive, diffLines } from "../../lib/discussion";
import { useActions, useAppState } from "../hooks";
import { HoldButton } from "../HoldButton";
import { formatClock } from "../labels";
import { FirstPlan } from "./FirstPlan";

/**
 * 汇总与方案版本（C-24，画布「①-3 汇总 → 方案新版本」）。
 * 谁同意了什么 → 汇总者的补充 → 方案这一版和上一版的对照 → 推回下一轮 / 我来改 / 盖章定稿 / 派生。
 */
const ABSENT_STANCES = new Set(["no_response", "timed_out", "abstained", "off_topic", "not_addressed", "absent_quota", "interrupted"]);

export function ReviewView({ roundId }: { roundId: string }) {
  const d = useAppState((s) => s.disc);
  const messages = useAppState((s) => s.messages);
  const actions = useActions();
  const round = d.rounds.find((r) => r.id === roundId);
  const sum = d.summaries.find((s) => s.roundId === roundId);
  const plan = sum?.planVersionId ? d.plans.find((p) => p.id === sum.planVersionId) : undefined;
  const summaryText = sum ? messages.find((m) => m.id === sum.messageId)?.content : undefined;

  if (!round) return null;
  const agents = round.recipients;
  // 替补的态度单独一栏，不算票
  const substitutes = sum?.report
    ? [...new Set(sum.report.points.flatMap((p) => p.stances.filter((x) => x.bySubstituteFor).map((x) => x.agent)))]
    : [];

  return (
    <section className="review" aria-labelledby="review-title">
      <nav className="breadcrumb" aria-label="路径">
        <button type="button" className="button-link" onClick={actions.closeReview}>讨论</button>
        <span aria-hidden="true">›</span>
        <h1 id="review-title">第 {round.index} 轮汇总{sum ? ` · ${agentName(d, sum.summarizer)}` : ""}</h1>
        {sum && <span className="tag">{sum.answered}/{sum.expected} 参与</span>}
      </nav>

      {!sum ? (
        <p className="side-note">这一轮还没有汇总。</p>
      ) : (
        <div className="review-grid">
          <div className="review-main">
            <h2>谁同意了什么</h2>
            {sum.report ? (
              <div className="table-wrap">
                <table className="stance-table">
                  <thead>
                    <tr>
                      <th scope="col">要点</th>
                      {agents.map((a) => (
                        <th key={a} scope="col" style={{ "--agent": agentColor(d, a) } as CSSProperties}>{agentName(d, a)}</th>
                      ))}
                      {substitutes.map((a) => <th key={`sub-${a}`} scope="col">替补 {agentName(d, a)}（不算票）</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {sum.report.points.map((p) => (
                      <tr key={p.text}>
                        <td>
                          {p.text}
                          <span className="point-source">
                            {p.source.kind === "human" ? "你写的" : p.source.kind === "summarizer" ? `${agentName(d, sum.summarizer)} 抽取` : `${agentName(d, p.source.agent)} 提出`}
                          </span>
                        </td>
                        {agents.map((a) => {
                          const st = p.stances.find((x) => x.agent === a && !x.bySubstituteFor);
                          return <td key={a}>{st ? <Stance stance={st.stance} note={st.note} /> : <Stance stance="not_addressed" note={null} />}</td>;
                        })}
                        {substitutes.map((a) => {
                          const st = p.stances.find((x) => x.agent === a && x.bySubstituteFor);
                          return <td key={`sub-${a}`}>{st ? <Stance stance={st.stance} note={`代 ${agentName(d, st.bySubstituteFor!)}`} /> : "—"}</td>;
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="side-note">汇总没有按约定格式输出，下面只显示全文。</p>
            )}
            <p className="side-note">没表态的几种情况分开显示：未回应、超时、弃权、答非所问、未涉及、缺席（额度）、被中断。</p>

            {sum.report && (
              <>
                <h2>{agentName(d, sum.summarizer)} 的补充</h2>
                <div className="review-extra" style={{ "--agent": agentColor(d, sum.summarizer) } as CSSProperties}>
                  {sum.report.risks.map((x) => <p key={x}><b>风险</b> · {x}</p>)}
                  {sum.report.gaps.map((x) => <p key={x}><b>遗漏</b> · {x}</p>)}
                  {sum.report.alternatives.map((x) => <p key={x}><b>另一种做法</b> · {x}</p>)}
                  {sum.report.extraInfoNotes.map((x) => <p key={x} className="extra-info">{x}</p>)}
                </div>
              </>
            )}

            {summaryText && (
              <details className="review-fulltext">
                <summary>汇总全文</summary>
                <p className="long-text">{summaryText}</p>
              </details>
            )}

            {plan && <PlanCompare plan={plan} />}
          </div>

          <PlanActions plan={plan} roundIndex={round.index} />
        </div>
      )}
    </section>
  );
}

function Stance({ stance, note }: { stance: keyof typeof STANCE_LABEL; note: string | null }) {
  return (
    <span className="stance" data-stance={stance} data-absent={ABSENT_STANCES.has(stance) || undefined}>
      {STANCE_LABEL[stance]}
      {note && <span className="stance-note">{note}</span>}
    </span>
  );
}

function PlanCompare({ plan }: { plan: PlanVersion }) {
  const d = useAppState((s) => s.disc);
  const parent = plan.parentId ? d.plans.find((p) => p.id === plan.parentId) : undefined;
  const lines = diffLines(parent?.content ?? "", plan.content);
  const added = lines.filter((l) => l.kind === "added").length;
  const removed = lines.filter((l) => l.kind === "removed").length;
  return (
    <>
      <h2>
        方案 {parent ? `v${parent.version} → ` : ""}v{plan.version}
        <span className="side-note">
          {" "}+{added} 行 · −{removed} 行 · {plan.basedOnRoundId ? "基于这一轮" : ""} · {plan.draftedBy.kind === "agent" ? `${agentName(d, plan.draftedBy.agent)} 起草` : "你改的"} · {formatClock(plan.createdAt)}
        </span>
      </h2>
      <ol className="plan-diff">
        {lines.filter((l) => l.text !== "" || l.kind !== "same").map((l, i) => (
          <li key={i} data-kind={l.kind}>
            <span className="diff-mark" aria-label={l.kind === "added" ? "新增" : l.kind === "removed" ? "删除" : undefined}>
              {l.kind === "added" ? "+" : l.kind === "removed" ? "−" : " "}
            </span>
            {l.text}
          </li>
        ))}
      </ol>
    </>
  );
}

function PlanActions({ plan, roundIndex }: { plan: PlanVersion | undefined; roundIndex: number }) {
  const d = useAppState((s) => s.disc);
  const actions = useActions();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(plan?.content ?? "");
  const [note, setNote] = useState("");
  // 用户确认过之后，方案的最新状态以 plans 里为准
  const live = plan ? d.plans.find((p) => p.id === plan.id) ?? plan : undefined;
  const newer = live ? d.plans.filter((p) => p.version > live.version && p.state !== "SUPERSEDED") : [];

  return (
    <aside className="review-actions" aria-label="接下来怎么办">
      <p className="confirm-label">接下来怎么办？</p>
      {!live ? (
        <>
          <p className="side-note">这次汇总没有产生方案。</p>
          {d.plans.length === 0 && <FirstPlan />}
        </>
      ) : (
        <>
          <p className="side-note">方案 v{live.version} · {live.state === "DRAFT" ? "草稿，等你确认" : live.state === "CURRENT" ? "当前版本" : live.state === "FINAL" ? "已定稿" : "已被取代"}</p>
          {newer.length > 0 && <p className="confirm-warn">已经有更新的版本 v{newer.map((p) => p.version).join("、v")}。</p>}

          {live.state === "DRAFT" && (
            <button type="button" className="action-card" onClick={() => void actions.confirmPlan(live.id)}>
              <b>确认这一版</b>
              <span>成为当前方案，下一轮会附带它</span>
            </button>
          )}
          {(live.state === "CURRENT" || live.state === "DRAFT") && (
            <button type="button" className="action-card" onClick={() => { actions.closeReview(); }}>
              <b>推回下一轮</b>
              <span>回到讨论，写下第 {roundIndex + 1} 轮的任务，盖章后发出</span>
            </button>
          )}
          {live.state !== "FINAL" && live.state !== "SUPERSEDED" && !editing && (
            <button type="button" className="action-card" onClick={() => (setDraft(live.content), setEditing(true))}>
              <b>我来改一下</b>
              <span>在这一版上直接改，存成新的草稿</span>
            </button>
          )}
          {editing && (
            <form
              className="plan-edit"
              onSubmit={async (e) => {
                e.preventDefault();
                const p = await actions.editPlan(live.id, draft, note.trim() || "你改的");
                if (p) setEditing(false);
              }}
            >
              <label htmlFor="plan-edit">方案内容</label>
              <textarea id="plan-edit" rows={10} value={draft} onChange={(e) => setDraft(e.target.value)} />
              <label htmlFor="plan-note">改了什么（给以后的自己看）</label>
              <input id="plan-note" value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} />
              <button type="submit" className="button-primary" disabled={!draft.trim() || draft === live.content}>存成新草稿</button>
              <button type="button" className="button-link" onClick={() => setEditing(false)}>取消</button>
            </form>
          )}
          {live.state === "CURRENT" && (
            <HoldButton className="button-seal action-seal" resetKey={live.id + live.contentHash} onComplete={() => actions.finalizePlan(live.id, live.contentHash)}>
              盖章定稿
              <span>v{live.version} 成为最终方案，之后可以拆成任务</span>
            </HoldButton>
          )}
          {live.state === "DRAFT" && <p className="side-note">先确认这一版，才能盖章定稿。</p>}
          {canDerive(d, live) && (
            <button type="button" className="action-card" onClick={() => void actions.derivePlan(live.id)}>
              <b>从 v{live.version} 派生下一版</b>
              <span>定稿后发现漏了：继续讨论，版本链不断</span>
            </button>
          )}
        </>
      )}
      <p className="side-note">汇总也只是一条意见：方案每一版都要你点头才算数。讨论不会自己停，什么时候定稿由你决定。</p>
      <button type="button" className="button-link" onClick={actions.closeReview}>返回讨论</button>
    </aside>
  );
}
