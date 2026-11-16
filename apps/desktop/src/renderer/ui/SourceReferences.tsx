import React from "react";
import type { ResultDisplayBlock, SourceReference, UsageCount } from "@room/schemas";

const statusLabel = { readable: "记录时已取回", missing: "记录时缺少原文", revoked: "记录时已撤回" };
const statusNote = {
  readable: "这是取回时的记录，发送前仍需重新检查资料是否可用。",
  missing: "没有可读原文，搜索摘要不能代替原文。请补充资料后重新生成预览。",
  revoked: "这份引用记录为已撤回。请更新资料后重新生成预览。",
};

/** 只展示已存的引用元数据；不能用历史 status 当作当前读取许可。 */
export function SourceReferenceCard({ reference, title }: { reference: SourceReference; title?: string }) {
  const source = reference.source;
  return (
    <details className="source-reference" data-status={reference.status}>
      <summary><span>{title || (source.kind === "web" ? "网页来源" : source.kind === "message" ? "项目资料来源" : "会话资料来源")}</span><span className="source-reference-status">{statusLabel[reference.status]}</span></summary>
      <p className="side-note">{statusNote[reference.status]}</p>
      <dl>
        <div><dt>{source.kind === "web" ? "来源网址" : "来源记录"}</dt><dd>{source.kind === "web" ? source.url : source.id}</dd></div>
        <div><dt>来源版本</dt><dd>{reference.version ?? "未知"}</dd></div>
        <div><dt>正文 SHA-256</dt><dd>{reference.contentHash ?? "未知（没有已校验的正文）"}</dd></div>
        <div><dt>记录时间</dt><dd><time dateTime={reference.retrievedAt}>{reference.retrievedAt}</time></dd></div>
      </dl>
    </details>
  );
}

export function SourceReferences({ references }: { references?: readonly SourceReference[] }) {
  if (!references?.length) return null;
  return (
    <section className="source-references" aria-label="引用来源">
      <h3>引用来源 <span>· {references.length}</span></h3>
      {references.map((reference, index) => <SourceReferenceCard key={index} reference={reference} />)}
    </section>
  );
}

const countLabel = (count: UsageCount) => count.status === "measured" ? String(count.value) : count.reason === "not_reported" ? "未知（未返回）" : "未知（暂不可用）";
const stepLabel = { started: "进行中", completed: "报告完成", failed: "报告失败", unknown: "状态未知" };

/** C11 展示块只作纯文本。进度不修改 Run 状态，未知用量不显示为 0。 */
export function ResultDisplayView({ blocks }: { blocks: readonly ResultDisplayBlock[] }) {
  return (
    <section className="result-display" aria-label="工具与引用记录">
      {blocks.map((block, index) => {
        if (block.kind === "citation") return <SourceReferenceCard key={index} reference={block.source} title={block.title} />;
        if (block.kind === "tool_step") return <div className="source-tool-step" key={index}><b>{block.tool}</b><span>{stepLabel[block.status]}</span><p>{block.summary}</p><small>运行方报告，以本次运行的最终状态为准。</small></div>;
        if (block.kind === "unsupported") return <p className="source-unsupported" key={index}>暂不支持的展示内容：{block.originalKind}（{block.reason === "unsupported_display_version" ? "版本不支持" : "类型不支持"}）</p>;
        return <dl className="source-usage" key={index} aria-label="本次累计用量">
          <div><dt>输入 tokens</dt><dd>{countLabel(block.inputTokens)}</dd></div>
          <div><dt>输出 tokens</dt><dd>{countLabel(block.outputTokens)}</dd></div>
          <div><dt>工具调用</dt><dd>{countLabel(block.toolCalls)}</dd></div>
          <div><dt>费用</dt><dd>{block.cost.status === "measured" ? `${block.cost.amount} ${block.cost.currency}` : block.cost.reason === "not_reported" ? "未知（未返回）" : "未知（暂不可用）"}</dd></div>
        </dl>;
      })}
    </section>
  );
}
