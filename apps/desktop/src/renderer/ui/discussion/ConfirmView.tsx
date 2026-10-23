import { useState, type CSSProperties } from "react";
import type { BatchKind } from "@room/schemas";
import { agentColor, agentName } from "../../lib/discussion";
import { effortLabel, modelLabel } from "../../lib/models";
import { useActions, useAppState } from "../hooks";

/**
 * 发送前确认（C-22，画布「①-1 发送前确认」）。
 * 每个收件人的完整内容都能逐字看到；指纹一样时说明"内容完全相同"；
 * 盖章 = 把这里看到的每一份 hash 一起交给后端，任何一份变了整批都不发。
 */
const KIND_TITLE: Record<BatchKind, string> = {
  initial: "发起这一轮",
  supplement: "发送补充",
  resume: "暂停后恢复",
  retry: "单独重试",
  summary: "请求汇总",
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

  return (
    <section className="confirm" aria-labelledby="confirm-title">
      <nav className="breadcrumb" aria-label="路径">
        <button type="button" className="button-link" onClick={actions.closeConfirm}>讨论</button>
        <span aria-hidden="true">›</span>
        <span>第 {round?.index ?? "?"} 轮</span>
        <span aria-hidden="true">›</span>
        <h1 id="confirm-title">{KIND_TITLE[c.batch.kind]} · 发送前确认</h1>
      </nav>

      <div className="confirm-grid">
        <div className="confirm-recipients">
          <p className="confirm-label">这次会发给 {c.batch.items.length} 个 Agent</p>
          {c.batch.items.map((i) => (
            <button
              key={i.approvalId}
              type="button"
              className="recipient-card"
              aria-pressed={i.recipient === item?.recipient}
              style={{ "--agent": agentColor(d, i.recipient) } as CSSProperties}
              onClick={() => setSelected(i.recipient)}
            >
              <b>{agentName(d, i.recipient)}{i.onBehalfOf ? `（代 ${agentName(d, i.onBehalfOf)}）` : ""}</b>
              <span>约 {i.tokenEstimate.toLocaleString()} tokens</span>
              <code>指纹 {i.contentHash.slice(0, 6)}…{i.contentHash.slice(-4)}</code>
              {i.differsFromOthers && <span className="extra-info">他会收到额外信息</span>}
              {i.model === null ? (
                <span className="recipient-model">模型：profile 自带的</span>
              ) : (
                <span className="recipient-model">
                  {modelLabel(d.models[i.recipient] ?? undefined, i.model.model)} ·{" "}
                  {effortLabel(d.models[i.recipient] ?? undefined, i.model.model, i.model.effort)}
                </span>
              )}
              {i.model?.usedFallback && <span className="extra-info">首选用不了，用的是备选</span>}
              {i.model?.effortSource === "node_default" && <span className="extra-info">你设的强度这个模型没有，用的是节点默认</span>}
            </button>
          ))}
          {allSame && <p className="confirm-note">{c.batch.items.length} 个人收到的内容<b>完全相同</b>（指纹一样）。</p>}
          {!allSame && c.batch.items.length > 1 && <p className="confirm-note">每个人收到的内容不同（角色设定不同），点上面的卡片分别查看。</p>}
          {offline.length > 0 && (
            <p className="confirm-warn">
              {offline.map((i) => agentName(d, i.recipient)).join("、")} 现在不在线：仍然可以发送，上线后会补答；太久没回会记为「超时」。
            </p>
          )}
        </div>

        <div className="confirm-content">
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
          {snapshot ? (
            <pre className="confirm-prompt" aria-label={`发给 ${agentName(d, item!.recipient)} 的完整内容`}>{snapshot.content}</pre>
          ) : (
            <p>正在加载内容……</p>
          )}
        </div>

        <div className="confirm-side">
          <p className="confirm-label">盖章后会发生什么</p>
          <ul>
            <li>{c.batch.items.map((i) => agentName(d, i.recipient)).join("、")} 同时开始</li>
            <li>发出去的内容和这里看到的一字不差，用的模型和思考强度也和左边写的一样</li>
            <li><b>盖章后不能撤回</b>，要更正只能之后再补充</li>
          </ul>
          <p className="confirm-note">预计约 {total.toLocaleString()} tokens（按字数估算，可能差 ±20%）</p>
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
              <label htmlFor="reject-reason">不发的原因（可以不写）</label>
              <textarea id="reject-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
              <button type="submit" className="button-outline">确定不发</button>
              <button type="button" className="button-link" onClick={() => setRejecting(false)}>返回</button>
            </form>
          ) : (
            <>
              <button type="button" className="button-seal button-seal-large" onClick={() => void actions.approveBatch()}>
                盖章发送
              </button>
              <button type="button" className="button-link" onClick={() => setRejecting(true)}>不发了</button>
            </>
          )}
          <button type="button" className="button-link" onClick={actions.closeConfirm}>返回讨论</button>
        </div>
      </div>
    </section>
  );
}
