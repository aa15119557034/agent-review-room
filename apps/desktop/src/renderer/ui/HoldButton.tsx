import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createHoldController, HOLD_TO_CONFIRM_MS, type HoldController, type HoldPhase } from "../lib/hold-to-confirm";

/**
 * C-33 按住盖章的按钮。规则都在 lib/hold-to-confirm.ts，这里只把指针、键盘、失焦、页面隐藏接上去。
 * resetKey 变了（换了批次 / 方案版本）就重新可以按；完成后锁住，防止按满后再按一次又发一遍。
 */
export function HoldButton(props: {
  /** 返回 Promise 时，结束后（成功或失败）回到可按：失败了（比如内容变了被拒）可以再盖一次 */
  onComplete: () => void | Promise<unknown>;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
  resetKey?: string;
  /** 读屏和悬停提示，默认「按住 1 秒」 */
  hint?: string;
}) {
  const [phase, setPhase] = useState<HoldPhase>("idle");
  const completeRef = useRef(props.onComplete);
  completeRef.current = props.onComplete;
  const controllerRef = useRef<HoldController | null>(null);
  /** 按下的那根手指 / 那个指针；别的触点的事件不管（汐 #172 建议 1） */
  const pointerRef = useRef<number | null>(null);

  useEffect(() => {
    const controller = createHoldController({
      onComplete: () => {
        const result = completeRef.current();
        if (result instanceof Promise) void result.finally(() => controllerRef.current?.reset());
      },
      onPhase: setPhase,
      disabled: props.disabled ?? false,
    });
    controllerRef.current = controller;
    const cancel = () => controller.cancel();
    const onVisibility = () => {
      if (document.visibilityState === "hidden") controller.cancel();
    };
    window.addEventListener("blur", cancel);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("blur", cancel);
      document.removeEventListener("visibilitychange", onVisibility);
      controller.dispose();
      controllerRef.current = null;
    };
    // 只建一次；disabled 和 resetKey 由下面两个 effect 跟进
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    controllerRef.current?.setDisabled(props.disabled ?? false);
  }, [props.disabled]);

  useEffect(() => {
    controllerRef.current?.reset();
  }, [props.resetKey]);

  const press = () => controllerRef.current?.press();
  const cancel = () => {
    pointerRef.current = null;
    controllerRef.current?.cancel();
  };
  const ours = (pointerId: number) => pointerRef.current === pointerId;
  const cancelIfOurs = (e: { pointerId: number }) => {
    if (ours(e.pointerId)) cancel();
  };
  const isKey = (key: string) => key === " " || key === "Enter";
  const hint = props.hint ?? `按住 ${HOLD_TO_CONFIRM_MS / 1000} 秒`;

  return (
    <button
      type="button"
      className={"hold-button " + (props.className ?? "")}
      data-phase={phase}
      disabled={props.disabled}
      title={hint}
      style={{ "--hold-ms": `${HOLD_TO_CONFIRM_MS}ms` } as CSSProperties}
      onPointerDown={(e) => {
        if (e.button !== 0 || pointerRef.current !== null) return;
        pointerRef.current = e.pointerId;
        // 按住期间指针移出按钮也要能收到 pointerleave / pointerup
        e.currentTarget.setPointerCapture?.(e.pointerId);
        press();
      }}
      onPointerUp={cancelIfOurs}
      onPointerCancel={cancelIfOurs}
      onLostPointerCapture={cancelIfOurs}
      onPointerLeave={cancelIfOurs}
      onPointerMove={(e) => {
        // 有指针捕获时 pointerleave 不触发：自己判断是不是移出了按钮。
        // 看控制器的实时阶段，不看渲染闭包里的 phase（汐 #172 建议 2）
        if (!ours(e.pointerId) || controllerRef.current?.phase !== "holding") return;
        const r = e.currentTarget.getBoundingClientRect();
        if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) cancel();
      }}
      onBlur={cancel}
      onKeyDown={(e) => {
        if (!isKey(e.key)) return;
        // 阻止回车 / 空格变成一次 click（click 本来也什么都不做，这里只是不让它连发）
        e.preventDefault();
        if (!e.repeat) press();
      }}
      onKeyUp={(e) => {
        if (isKey(e.key)) cancel();
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <span className="hold-fill" aria-hidden="true" />
      <span className="hold-label">{props.children}</span>
      <span className="hold-hint" aria-live="polite">{phase === "holding" ? "继续按住…" : phase === "done" ? "已盖章" : hint}</span>
    </button>
  );
}
