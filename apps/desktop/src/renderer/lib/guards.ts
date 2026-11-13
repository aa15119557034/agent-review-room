/**
 * 全局防护（在 main.tsx 启动时调用一次）。
 *
 * 拖文件防跳转：Electron 窗口里把文件拖到不接收文件的地方松手，浏览器的默认行为是「打开这个文件」，
 * 整个应用会被换成那张图片 / 那个文件，只能重启。这里把 window 上 dragover / drop 的默认行为拦掉。
 *
 * 不影响真正接收拖放的地方：
 * - 输入框（input / textarea / 可编辑区域）照常能拖进文字；拖进来的是文件时仍然拦掉（否则照样会跳转）
 * - 以后哪个组件自己处理了 drop（调用过 preventDefault），这里什么都不做
 * 粘贴（paste）不经过这里。
 */
export function installGlobalGuards(target: Window = window): () => void {
  const editable = (t: EventTarget | null): boolean => {
    const el = t as { closest?: (sel: string) => unknown } | null;
    return typeof el?.closest === "function" && el.closest('input, textarea, [contenteditable=""], [contenteditable="true"]') != null;
  };
  const hasFiles = (e: DragEvent): boolean => Array.from(e.dataTransfer?.types ?? []).includes("Files");

  const onDragOver = (e: DragEvent) => {
    if (e.defaultPrevented) return;
    if (editable(e.target) && !hasFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "none";
  };
  const onDrop = (e: DragEvent) => {
    if (e.defaultPrevented) return;
    if (editable(e.target) && !hasFiles(e)) return;
    e.preventDefault();
  };
  target.addEventListener("dragover", onDragOver);
  target.addEventListener("drop", onDrop);
  return () => {
    target.removeEventListener("dragover", onDragOver);
    target.removeEventListener("drop", onDrop);
  };
}
