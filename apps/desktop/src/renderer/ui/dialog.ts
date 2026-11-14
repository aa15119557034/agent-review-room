import { useEffect, useRef, type RefObject } from "react";

/** 现在开着的弹层，后开的在后面：Esc 只关最上面那一个 */
const stack: symbol[] = [];

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * 弹层（底部面板、对话框）共用的键盘行为：
 * - 打开时焦点进到弹层里（里面已经有 autoFocus 的就不抢）
 * - Esc 关闭（叠着几层时只关最上面的）；Tab 在弹层里打转，不跑到后面的页面上
 * - 关闭后焦点回到打开它的那个按钮
 * 用法：`const ref = useDialog<HTMLElement>(onClose)`，把 ref 挂在 role="dialog" 的元素上并加 tabIndex={-1}。
 */
export function useDialog<T extends HTMLElement>(onClose: () => void): RefObject<T | null> {
  const ref = useRef<T | null>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const id = Symbol("dialog");
    stack.push(id);
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const el = ref.current;
    if (el && !el.contains(document.activeElement)) el.focus({ preventScroll: true });

    const onKey = (e: KeyboardEvent) => {
      if (stack[stack.length - 1] !== id) return;
      if (e.key === "Escape") {
        // 输入法选字时的 Esc 是取消选字，不是关弹层
        if (e.isComposing) return;
        e.stopPropagation();
        close.current();
        return;
      }
      if (e.key !== "Tab" || !el) return;
      const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.offsetParent !== null || x === document.activeElement);
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      if (!el.contains(active)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && (active === first || active === el)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      const i = stack.indexOf(id);
      if (i >= 0) stack.splice(i, 1);
      // 打开它的按钮还在页面上就把焦点还回去（不在了就算了，比如那条消息已经撤回）
      if (opener && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);

  return ref;
}
