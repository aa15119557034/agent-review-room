/**
 * 回答正文里最常见的三种 Markdown 记号（C-49 / B-03）：**加粗**、`行内代码`、``` 代码块。
 *
 * 真 Claude 的回答经常带这几种记号，原样显示就是一堆星号和反引号。ADR 没有定过「聊天里渲染 Markdown」，
 * 所以只做最小的一版，而且只在界面上：
 * - 只认这三种；标题、列表、链接、图片、表格、HTML 一律原样当文字（不做链接，不放任何 HTML）
 * - 结果是一串 { kind, text }，由界面放进 React 文本节点，没有 innerHTML
 * - 记号不成对、加粗里面带换行或首尾是空格（比如「2 ** 3 ** 4」）都不算，原样显示
 * - 存的、复制的、引用的、转议题的、发给秘书的都还是原文，一个字不改
 * 图表块（```room-chart）在这之前已经由 splitReply 切走，不归这里管。
 */
export type MarkupBlock = { kind: "text"; spans: MarkupSpan[] } | { kind: "code"; text: string };
export type MarkupSpan = { kind: "plain" | "bold" | "code"; text: string };

/** 行首开始、闭合了的代码块；语言名不显示 */
const CODE_FENCE = /(^|\n)```[^\n`]*\n([\s\S]*?)\n```[ \t]*(?=\n|$)/g;
const INLINE = /`([^`\n]+)`|\*\*([^\s*](?:[^*\n]*[^\s*])?)\*\*/g;

export function inlineMarkup(text: string): MarkupSpan[] {
  const out: MarkupSpan[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push({ kind: "plain", text: text.slice(last, m.index) });
    out.push(m[1] !== undefined ? { kind: "code", text: m[1] } : { kind: "bold", text: m[2]! });
    last = m.index + m[0].length;
  }
  if (last < text.length || out.length === 0) out.push({ kind: "plain", text: text.slice(last) });
  return out;
}

export function parseMarkup(text: string): MarkupBlock[] {
  const out: MarkupBlock[] = [];
  let last = 0;
  const pushText = (t: string, trimStart: boolean) => {
    const body = trimStart ? t.replace(/^\n/, "") : t;
    if (body !== "") out.push({ kind: "text", spans: inlineMarkup(body) });
  };
  for (const m of text.matchAll(CODE_FENCE)) {
    pushText(text.slice(last, m.index), out.length > 0);
    out.push({ kind: "code", text: m[2] ?? "" });
    last = m.index + m[0].length;
  }
  pushText(text.slice(last), out.length > 0);
  if (out.length === 0) out.push({ kind: "text", spans: [{ kind: "plain", text }] });
  return out;
}

/** 有没有要处理的记号：没有就照旧一个 <p>，不多一层结构 */
export const hasMarkup = (text: string): boolean => text.includes("`") || text.includes("**");
