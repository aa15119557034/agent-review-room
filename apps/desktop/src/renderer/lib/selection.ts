import type { TextSelection } from "@room/schemas";

/**
 * 原文选区的纯函数部分（不依赖 DOM，可单测）。
 * 所有下标都是 JS 字符串下标（UTF-16 code unit），与契约里 TextSelection 的定义一致。
 */

/** 去掉选区两端的空白。全是空白时返回 null */
export function trimSelection(content: string, sel: TextSelection): TextSelection | null {
  let { start, end } = sel;
  start = Math.max(0, Math.min(start, content.length));
  end = Math.max(0, Math.min(end, content.length));
  while (start < end && /\s/.test(content[start]!)) start++;
  while (end > start && /\s/.test(content[end - 1]!)) end--;
  if (end <= start) return null;
  // 不把代理对（emoji 等）从中间切开
  if (isLowSurrogate(content.charCodeAt(start))) start--;
  if (isHighSurrogate(content.charCodeAt(end - 1))) end++;
  return { start, end };
}

const isHighSurrogate = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLowSurrogate = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/** 用选中文字的开头做默认标题：只取第一行，去掉"风险："这类前缀后的内容，最多 30 个字符 */
export function suggestTitle(excerpt: string): string {
  const firstLine = excerpt.split(/\r?\n/).find((l) => l.trim()) ?? "";
  const body = firstLine.replace(/^\s*[^：:\s]{1,6}[：:]\s*/, "").trim() || firstLine.trim();
  const chars = Array.from(body); // 按字符而不是 UTF-16 截断
  return chars.length > 30 ? chars.slice(0, 30).join("") + "…" : chars.join("");
}

export interface Segment {
  text: string;
  start: number;
  /** 覆盖这一段的片段 id；空数组表示没被标记 */
  covers: string[];
}

/**
 * 把原文按已有片段的边界切成若干段，用来渲染高亮。片段可以互相重叠。
 * 拼回去的文字一定等于原文（渲染后 DOM 文字与原文一致，选区下标才能对上）。
 */
export function segmentText(content: string, ranges: { id: string; start: number; end: number }[]): Segment[] {
  const valid = ranges.filter((r) => r.start < r.end && r.start >= 0 && r.end <= content.length);
  const cuts = new Set<number>([0, content.length]);
  for (const r of valid) (cuts.add(r.start), cuts.add(r.end));
  const points = [...cuts].sort((a, b) => a - b);
  const out: Segment[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const start = points[i]!;
    const end = points[i + 1]!;
    if (end === start) continue;
    out.push({
      text: content.slice(start, end),
      start,
      covers: valid.filter((r) => r.start <= start && r.end >= end).map((r) => r.id),
    });
  }
  return out;
}
