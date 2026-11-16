import React, { useState } from "react";
import { ResultDisplayBlock, SourceReference } from "@room/schemas";
import { ResultDisplayView, SourceReferences } from "../ui/SourceReferences";

export const sourceDemoOriginal = "示例资料：搜索摘要只用于寻找网页。\n引用必须绑定取回的原文和版本。\n<b>这一行仍是原文，不会执行 HTML。</b>";
export const sourceDemoReference = SourceReference.parse({
  source: { kind: "web", url: "https://example.com/research" },
  version: "demo-v1", contentHash: "72f8954c329c9d964c253d3f82483da92ecc17f07653f3267de541c41fd2158a",
  retrievedAt: "2026-11-17T03:30:00.000Z", status: "readable",
});
export const sourceDemoBlocks = [
  { kind: "tool_step", stepId: "search", tool: "Search", status: "completed", summary: "找到一个候选网页；摘要不作为原文。" },
  { kind: "tool_step", stepId: "fetch", tool: "Fetch", status: "completed", summary: "已取回完整正文。<b>标签仍是普通文字</b>" },
  { kind: "citation", citationId: "source-1", title: "资料引用说明 <b>纯文本标题</b>", source: sourceDemoReference },
  { kind: "usage", scope: "run", inputTokens: { status: "unknown", reason: "not_reported" }, outputTokens: { status: "unknown", reason: "not_reported" }, toolCalls: { status: "measured", value: 2 }, cost: { status: "unknown", reason: "not_reported" } },
  { kind: "unsupported", originalKind: "future_card", reason: "unknown_display_kind" },
].map((block) => ResultDisplayBlock.parse(block));

/** 仅 ?mock&sources 的演示，不是来源查询 API，也不读历史消息来推导授权。 */
export function SourcePreviewDemo() {
  const [current, setCurrent] = useState<SourceReference["status"]>("readable");
  const labels = { readable: "可读", missing: "缺少原文", revoked: "已撤回" };
  return (
    <main className="source-preview-demo">
      <h1>引用与来源</h1>
      <p>演示数据，不访问网络，也不会发送给秘书。</p>
      <p><a href="?mock">返回讨论室演示</a></p>
      <div className="source-preview-columns">
        <section><h2>检索记录</h2><ResultDisplayView blocks={sourceDemoBlocks} /></section>
        <section>
          <h2>来源预览</h2>
          <fieldset className="source-demo-controls"><legend>模拟资料现在的状态</legend>{(["readable", "missing", "revoked"] as const).map((status) => <label key={status}><input type="radio" name="source-status" checked={current === status} onChange={() => setCurrent(status)} />{labels[status]}</label>)}</fieldset>
          <SourceReferences references={[sourceDemoReference]} />
          <p className="source-current-state" role="status">本次模拟检查：{labels[current]}</p>
          {current === "readable" ? <details className="source-original" open><summary>已取回的原文 · 同一版本</summary><pre>{sourceDemoOriginal}</pre></details> : <p className="field-error">{current === "revoked" ? "来源已撤回，不显示原文。" : "缺少原文，不能用摘要代替。"}请更新资料并重新生成预览。</p>}
          <p className="side-note">分享时应让每位秘书看到同一份已授权的原文；仅有网址或旧的可读记录不能直接发送。</p>
        </section>
      </div>
    </main>
  );
}
