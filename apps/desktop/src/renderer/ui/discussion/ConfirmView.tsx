import { useState, type CSSProperties } from "react";
import type { BatchKind } from "@room/schemas";
import { agentColor, agentName } from "../../lib/discussion";
import { noteKey, scopeKey } from "../../lib/notes";
import { effortLabel, modelLabel } from "../../lib/models";
import { useActions, useAppState } from "../hooks";
import { imageSrc } from "../../lib/media";
import { HoldButton } from "../HoldButton";

/**
 * 发送前确认（C-22；C-33b 照草案「确认第 2 轮」重排）。
 * 上面是本轮任务；中间每人一行「模型 · 思考强度 · 指纹 · 字数 · 看全文」，点开逐字看；
 * 底下「按住 盖章发送给 N 位」和「退回去改」。
 * 盖章 = 把这里看到的每一份 hash 一起交给后端，任何一份变了整批都不发。
 */
const KIND_TITLE: Record<BatchKind, string> = {
  initial: "确认",
  supplement: "确认补充",
  resume: "确认恢复",
  retry: "确认重试",
  summary: "确认汇总",
};

export function ConfirmView() {
  const c = useAppState((s) => s.disc.confirm)!;
  const d = useAppState((s) => s.disc);
  const round = d.rounds.find((r) => r.id === c.batch.roundId);
  const actions = useActions();
  const [selected, setSelected] = useState(c.batch.items[0]?.recipient ?? "");
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");

  const item = c.batch.items.find((i) => i.recipient === selected) ?? c.batch.items[0];
  const snapshot = item ? c.snapshots.find((s) => s.id === item.snapshotId) : undefined;
  const hashes = new Set(c.batch.items.map((i) => i.contentHash));
  const allSame = hashes.size === 1 && c.batch.items.length > 1;
  const total = c.batch.items.reduce((n, i) => n + i.tokenEstimate, 0);
  const decided = c.batch.state !== "READY_FOR_REVIEW";
  const offline = c.batch.items.filter((i) => d.status[i.recipient]?.availability !== "available");
  const plan = round?.planVersionId ? d.plans.find((p) => p.id === round.planVersionId) : undefined;
  const n = c.batch.items.length;
  const chars = (snapshotId: string) => c.snapshots.find((s) => s.id === snapshotId)?.content.length;
  // C-47：这次带的是他笔记的第几版（PromptSnapshot.projectNoteId；省略 = 老 Snapshot / 后端还没带）
  const notes = useAppState((s) => s.notes);
  const noteLine = (snapshotId: string, recipient: string): string | null => {
    const id = c.snapshots.find((s) => s.id === snapshotId)?.projectNoteId;
    if (id === undefined) return null;
    if (id === null) return "还没有笔记";
    const scope = { kind: "topic" as const, projectId: c.batch.projectId };
    const v =
      notes.history[noteKey(scope, recipient)]?.find((n) => n.id === id)?.version ??
      notes.latest[scopeKey(scope)]?.find((n) => n.id === id)?.version;
    return v ? `带他的笔记第 ${v} 版` : "带他的笔记";
  };

  return (
    <section className="confirm" aria-labelledby="confirm-title">
      <header className="sheet-head">
        <button type="button" className="button-link" onClick={actions.closeConfirm}>取消</button>
        <h1 id="confirm-title">{KIND_TITLE[c.batch.kind]}第 {round?.index ?? "?"} 轮</h1>
        <span />
      </header>

      <div className="confirm-grid">
        <div className="confirm-recipients">
          {round && (
            <div className="sheet-group confirm-task">
              <span className="sheet-label-inline">本轮任务</span>
              <p className="confirm-task-text">{round.task}</p>
              <span className="side-note">
                {[plan ? `带上方案 v${plan.version}` : null, `发给 ${n} 位`, total > 0 ? `约 ${total.toLocaleString()} tokens` : null].filter(Boolean).join(" · ")}
              </span>
            </div>
          )}

          <h2 className="sheet-label">每个人会收到的内容（逐字可看）</h2>
          <ul className="sheet-group confirm-people">
            {c.batch.items.map((i) => {
              const len = chars(i.snapshotId);
              return (
                <li key={i.approvalId}>
                  <button
                    type="button"
                    className="confirm-person"
                    aria-pressed={i.recipient === item?.recipient}
                    style={{ "--agent": agentColor(d, i.recipient) } as CSSProperties}
                    onClick={() => setSelected(i.recipient)}
                  >
                    <span className="avatar" aria-hidden="true">{agentName(d, i.recipient).slice(0, 1)}</span>
                    <span className="confirm-person-body">
                      <span className="confirm-person-line">
                        <b>{agentName(d, i.recipient)}{i.onBehalfOf ? `（代 ${agentName(d, i.onBehalfOf)}）` : ""}</b>
                        {i.model === null ? (
                          <span> · 模型用节点配置自带的</span>
                        ) : (
                          <span>
                            {" · "}{modelLabel(d.models[i.recipient] ?? undefined, i.model.model)}
                            {" · 思考 "}{effortLabel(d.models[i.recipient] ?? undefined, i.model.model, i.model.effort)}
                          </span>
                        )}
                      </span>
                      {i.differsFromOthers && <span className="extra-info">多一段只给{agentName(d, i.recipient)}的补充</span>}
                      {i.model?.usedFallback && <span className="extra-info">首选用不了，用的是备选</span>}
                      {i.model?.effortSource === "node_default" && <span className="extra-info">你设的强度这个模型没有，用的是节点默认</span>}
                      {i.attachments ? (
                        <span className="side-note">带 {i.attachments.length} 张图</span>
                      ) : (
                        c.batch.items.some((x) => x.attachments) && <span className="extra-info">这次看不到图</span>
                      )}
                      {noteLine(i.snapshotId, i.recipient) && <span className="side-note">{noteLine(i.snapshotId, i.recipient)}</span>}
                      <code className="confirm-print">
                        指纹 {i.contentHash.slice(0, 4)} · {i.contentHash.slice(-4)} · {len != null ? `${len.toLocaleString()} 字` : `约 ${i.tokenEstimate.toLocaleString()} tokens`}
                      </code>
                    </span>
                    <span className="confirm-person-more">看全文 ›</span>
                  </button>
                </li>
              );
            })}
          </ul>
          <p className="side-note confirm-foot">
            {allSame ? `${n} 个人收到的内容完全相同（指纹一样）。` : ""}
            盖章时会逐个核对指纹，内容有任何变化就盖不上，需要重新确认。<b>盖章后不能撤回</b>，要更正只能之后再补充。
          </p>
          {offline.length > 0 && (
            <p className="confirm-warn">
              {offline.map((i) => agentName(d, i.recipient)).join("、")} 现在不在线：仍然可以发送，上线后会补答；太久没回会记为「超时」。
            </p>
          )}
        </div>

        <div className="confirm-content" aria-label={item ? `发给 ${agentName(d, item.recipient)} 的完整内容` : undefined}>
          {item && <p className="sheet-label-inline">发给 {agentName(d, item.recipient)} 的全文</p>}
          {c.batch.compressedRounds.length > 0 && (
            <details className="confirm-compressed">
              <summary>讨论记录被压缩了：第 {c.batch.compressedRounds.map((r) => r.roundIndex).join("、")} 轮 → 摘要</summary>
              <ul>
                {c.batch.compressedRounds.map((r) => (
                  <li key={r.roundIndex}>第 {r.roundIndex} 轮 → {agentName(d, r.summarizer)} 的汇总</li>
                ))}
              </ul>
            </details>
          )}
          {item && !item.attachments && c.batch.items.some((i) => i.attachments) && (
            <p className="confirm-warn">{agentName(d, item.recipient)} 这次看不到图（模型看不了或还没测过），只收到「[图片：文件名]」占位文字。</p>
          )}
          {item?.attachments && (
            <section aria-label="这次带的图">
              <p className="confirm-label">
                这次带给 {agentName(d, item.recipient)} 的图（{item.attachments.length} 张，按清单逐张核对后才发）
              </p>
              <ul className="confirm-attachments">
                {item.attachments.map((a) => (
                  <li key={a.index}>
                    <img src={imageSrc(a.ref)} alt={`图 ${a.index}：${a.name}`} />
                    <span title={a.name}>
                      图 {a.index} · {a.name}
                    </span>
                    <code title={a.sha256}>{a.sha256.slice(0, 8)}</code>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {snapshot ? <pre className="confirm-prompt">{snapshot.content}</pre> : <p>正在加载内容……</p>}
        </div>
      </div>

      <footer className="confirm-bottom">
        {decided ? (
          <p className="confirm-note">这一批已经{c.batch.state === "APPROVED" ? "盖过章" : "处理过"}了。</p>
        ) : rejecting ? (
          <form
            className="confirm-reject"
            onSubmit={(e) => {
              e.preventDefault();
              void actions.rejectBatch(reason.trim() || undefined);
            }}
          >
            <label htmlFor="reject-reason">这一批不发了。想改什么？（可以不写）</label>
            <textarea id="reject-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
            <div className="settings-actions">
              <button type="submit" className="button-outline">确定不发</button>
              <button type="button" className="button-link" onClick={() => setRejecting(false)}>返回</button>
            </div>
          </form>
        ) : (
          <>
            <HoldButton
              className="button-seal button-seal-large"
              resetKey={c.batch.id}
              onComplete={() => actions.approveBatch()}
            >
              按住 盖章发送给 {n} 位
            </HoldButton>
            <p className="side-note">按住一秒，进度走满才盖上；中途松手就不算</p>
            <button type="button" className="button-link" onClick={() => setRejecting(true)}>退回去改</button>
          </>
        )}
      </footer>
    </section>
  );
}
