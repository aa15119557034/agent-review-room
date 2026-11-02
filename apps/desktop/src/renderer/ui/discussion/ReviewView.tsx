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
  const projectName = useAppState((s) => s.projects.find((p) => p.id === s.currentProjectId)?.name ?? "汇总与方案");
  // 草案默认停在「方案」那一页：有方案时先看方案，没有就看汇总
  const [tab, setTab] = useState<"summary" | "plan">(plan ? "plan" : "summary");

  if (!round) return null;
  const agents = round.recipients;
  // 替补的态度单独一栏，不算票
  const substitutes = sum?.report
    ? [...new Set(sum.report.points.flatMap((p) => p.stances.filter((x) => x.bySubstituteFor).map((x) => x.agent)))]
    : [];

  const project = projectName;
  return (
    <section className="review" aria-labelledby="review-title">
      <header className="sheet-head">
        <button type="button" className="button-link" aria-label="返回讨论" onClick={actions.closeReview}>‹ 返回</button>
        <h1 id="review-title">{project}</h1>
        <span />
      </header>

      {!sum ? (
        <p className="side-note">这一轮还没有汇总。</p>
      ) : (
        <>
          <div className="review-tabs" role="tablist" aria-label="汇总与方案">
            <button type="button" role="tab" aria-selected={tab === "summary"} onClick={() => setTab("summary")}>第 {round.index} 轮汇总</button>
            <button type="button" role="tab" aria-selected={tab === "plan"} onClick={() => setTab("plan")}>{plan ? `方案 v${plan.version}` : "方案"}</button>
          </div>
          {tab === "summary" ? (
            <div className="review-main">
              <p className="review-tags">
                <span className="side-tag">{agentName(d, sum.summarizer)} 汇总</span>
                <span className="side-tag" data-soft>{sum.answered}/{sum.expected} 参与</span>
              </p>
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
            </div>
          ) : (
            <PlanTab plan={plan} roundIndex={round.index} agents={agents} />
          )}
        </>
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
  if (!parent) return null;
  return (
    <details className="sheet-group plan-compare">
      <summary>
        和 v{parent.version} 对比 <span className="side-note">+{added} 行 · −{removed} 行</span>
      </summary>
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
    </details>
  );
}

const AGREE = new Set(["agree", "partial"]);

/**
 * 草案「方案 v1」页：版本标签 → 方案正文（长了先折起来）→ 谁同意了什么 → 和上一版对比；
 * 底部两个大按钮：草稿是「我来改 / 确认，进下一轮」，当前版是「我来改 / 按住盖章定稿」，定稿后是「派生下一版」。
 */
function PlanTab({ plan, roundIndex, agents }: { plan: PlanVersion | undefined; roundIndex: number; agents: readonly string[] }) {
  const d = useAppState((s) => s.disc);
  const actions = useActions();
  const [editing, setEditing] = useState(false);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(plan?.content ?? "");
  const [note, setNote] = useState("");
  // 用户确认过之后，方案的最新状态以 plans 里为准
  const live = plan ? d.plans.find((p) => p.id === plan.id) ?? plan : undefined;
  const newer = live ? d.plans.filter((p) => p.version > live.version && p.state !== "SUPERSEDED") : [];
  const sum = d.summaries.find((s) => s.planVersionId === live?.id);

  if (!live) {
    return (
      <div className="review-main">
        <p className="side-note">这次汇总没有产生方案。</p>
        {d.plans.length === 0 && <FirstPlan />}
      </div>
    );
  }

  const long = live.content.length > 400;
  const stateTag = live.state === "DRAFT" ? "草稿" : live.state === "CURRENT" ? "当前" : live.state === "FINAL" ? "已定稿" : "已被取代";
  const tally = agents.map((a) => {
    const all = sum?.report?.points.map((p) => p.stances.find((x) => x.agent === a && !x.bySubstituteFor)?.stance ?? "not_addressed") ?? [];
    return {
      agent: a,
      agree: all.filter((x) => AGREE.has(x)).length,
      oppose: all.filter((x) => x === "oppose").length,
      none: all.filter((x) => !AGREE.has(x) && x !== "oppose").length,
    };
  });

  return (
    <div className="review-plan">
      <p className="review-tags">
        <span className="side-tag" data-state={live.state}>v{live.version} · {stateTag}</span>
        <span className="side-tag" data-soft>
          {live.draftedBy.kind === "agent" ? `${agentName(d, live.draftedBy.agent)} 起草` : "你改的"}
          {live.basedOnRoundId ? ` · 由第 ${roundIndex} 轮汇总生成` : ""} · {formatClock(live.createdAt)}
        </span>
      </p>
      {newer.length > 0 && <p className="confirm-warn">已经有更新的版本 v{newer.map((p) => p.version).join("、v")}。</p>}

      {editing ? (
        <form
          className="plan-edit sheet-group"
          onSubmit={async (e) => {
            e.preventDefault();
            const p = await actions.editPlan(live.id, draft, note.trim() || "你改的");
            if (p) setEditing(false);
          }}
        >
          <label htmlFor="plan-edit">方案内容</label>
          <textarea id="plan-edit" rows={12} value={draft} onChange={(e) => setDraft(e.target.value)} />
          <label htmlFor="plan-note">改了什么（给以后的自己看）</label>
          <input id="plan-note" value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} />
          <div className="settings-actions">
            <button type="submit" className="button-primary" disabled={!draft.trim() || draft === live.content}>存成新草稿</button>
            <button type="button" className="button-link" onClick={() => setEditing(false)}>取消</button>
          </div>
        </form>
      ) : (
        <article className="sheet-group plan-card">
          <p className="long-text" data-clamped={long && !open ? "" : undefined}>{long && !open ? live.content.slice(0, 400) + "……" : live.content}</p>
          {long && (
            <button type="button" className="button-link" onClick={() => setOpen((v) => !v)}>
              {open ? "收起" : `展开全文 · ${live.content.length.toLocaleString()} 字`}
            </button>
          )}
        </article>
      )}

      {sum?.report && (
        <section className="sheet-group plan-tally" aria-label="谁同意了什么">
          <h2 className="sheet-label-inline">谁同意了什么（{sum.report.points.length} 个要点）</h2>
          <ul>
            {tally.map((t) => (
              <li key={t.agent} style={{ "--agent": agentColor(d, t.agent) } as CSSProperties}>
                <span className="avatar" aria-hidden="true">{agentName(d, t.agent).slice(0, 1)}</span>
                <span>{agentName(d, t.agent)}</span>
                <span className="tally" data-kind={t.agree && !t.oppose ? "agree" : t.oppose ? "oppose" : "none"}>
                  {[t.agree ? `同意 ${t.agree}` : null, t.oppose ? `反对 ${t.oppose}` : null, t.none ? `没表态 ${t.none}` : null].filter(Boolean).join(" · ") || "没表态"}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <PlanCompare plan={live} />

      <footer className="review-bottom">
        {live.state !== "FINAL" && live.state !== "SUPERSEDED" && !editing && (
          <button type="button" className="button-big button-big-light" onClick={() => (setDraft(live.content), setEditing(true))}>我来改</button>
        )}
        {live.state === "DRAFT" && (
          <button type="button" className="button-big" onClick={() => void actions.confirmPlan(live.id).then(actions.closeReview)}>
            确认，进下一轮
          </button>
        )}
        {live.state === "CURRENT" && (
          <HoldButton className="button-seal action-seal" resetKey={live.id + live.contentHash} onComplete={() => actions.finalizePlan(live.id, live.contentHash)}>
            盖章定稿 v{live.version}
          </HoldButton>
        )}
        {canDerive(d, live) && (
          <button type="button" className="button-big" onClick={() => void actions.derivePlan(live.id)}>从 v{live.version} 派生下一版</button>
        )}
      </footer>
      <p className="side-note review-hint">
        {live.state === "DRAFT"
          ? "确认之后，下一轮会带上它，这里会出现「盖章定稿」。"
          : live.state === "CURRENT"
            ? `要继续讨论就返回，写第 ${roundIndex + 1} 轮的任务。讨论不会自己停，什么时候定稿由你决定。`
            : "定稿后发现漏了：派生下一版继续讨论，版本链不断。"}
      </p>
    </div>
  );
}
