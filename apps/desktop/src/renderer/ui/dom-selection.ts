import type { TextSelection } from "@room/schemas";

/**
 * 把浏览器当前的选区换算成相对于 container 文字的下标。
 *
 * 用"从 container 开头到选区端点"的 Range.toString().length 计算，
 * 所以 container 里有 <mark> 高亮等嵌套元素时也正确。
 * 选区不完全落在 container 内、或者为空时返回 null。
 */
export function selectionWithin(container: HTMLElement): TextSelection | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  if (!container.contains(range.startContainer) || !container.contains(range.endContainer)) return null;

  const offsetOf = (node: Node, offset: number) => {
    const r = document.createRange();
    r.selectNodeContents(container);
    r.setEnd(node, offset);
    return r.toString().length;
  };
  const start = offsetOf(range.startContainer, range.startOffset);
  const end = offsetOf(range.endContainer, range.endOffset);
  return end > start ? { start, end } : null;
}
