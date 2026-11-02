/**
 * C-33 按住盖章：按住满 HOLD_TO_CONFIRM_MS 才触发一次 onComplete。
 *
 * 规则（任务板 C-33 验收）：
 * - 按 999ms 松手 → 什么都不发，状态回到 idle；再推进时钟也不会补发
 * - 移出按钮 / 窗口失焦 / 页面隐藏 / 按钮变灰 → 清计时（cancel）
 * - 按满只发一次：完成后锁住（done），直到 reset()（换了要盖章的对象）
 * - 普通点击、键盘回车 / 空格的一次按下都绕不过：只有 press → 计时满才算。键盘要按住空格 / 回车满 1 秒，
 *   松开（keyup）同样清计时；系统的按键连发（repeat）不算新的按下
 *
 * 纯逻辑、不碰 DOM，计时器可以注入，测试用假时钟。
 */
export const HOLD_TO_CONFIRM_MS = 1000;

export type HoldPhase = "idle" | "holding" | "done";

export interface HoldTimers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: HoldTimers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface HoldController {
  readonly phase: HoldPhase;
  /** 开始按住；变灰、已在按、已完成时忽略 */
  press(): void;
  /** 松手 / 移出 / 失焦 / 页面隐藏：没按满就清掉 */
  cancel(): void;
  /** 按钮能不能用；变灰时正在按的立即清掉 */
  setDisabled(disabled: boolean): void;
  /** 换了盖章对象：回到 idle，可以再按 */
  reset(): void;
  /** 组件卸载 */
  dispose(): void;
}

export interface HoldControllerOptions {
  onComplete: () => void;
  /** 阶段变化（给界面画进度用） */
  onPhase?: (phase: HoldPhase) => void;
  durationMs?: number;
  timers?: HoldTimers;
  disabled?: boolean;
}

export function createHoldController(options: HoldControllerOptions): HoldController {
  const timers = options.timers ?? realTimers;
  const duration = options.durationMs ?? HOLD_TO_CONFIRM_MS;
  let phase: HoldPhase = "idle";
  let disabled = options.disabled ?? false;
  let handle: unknown = null;
  let disposed = false;

  const setPhase = (next: HoldPhase) => {
    if (phase === next) return;
    phase = next;
    options.onPhase?.(next);
  };
  const clearTimer = () => {
    if (handle !== null) timers.clear(handle);
    handle = null;
  };

  return {
    get phase() {
      return phase;
    },
    press() {
      if (disposed || disabled || phase !== "idle") return;
      setPhase("holding");
      handle = timers.set(() => {
        handle = null;
        if (disposed || disabled || phase !== "holding") return;
        setPhase("done");
        options.onComplete();
      }, duration);
    },
    cancel() {
      if (phase !== "holding") return;
      clearTimer();
      setPhase("idle");
    },
    setDisabled(next) {
      disabled = next;
      if (next) this.cancel();
    },
    reset() {
      clearTimer();
      setPhase("idle");
    },
    dispose() {
      disposed = true;
      clearTimer();
    },
  };
}
