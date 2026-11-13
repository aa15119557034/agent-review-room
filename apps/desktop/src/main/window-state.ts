import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * 窗口位置 / 大小 / 是否最大化的记忆（C-51）。不依赖 electron，方便单测。
 *
 * 文件：<数据目录>/window-state.json。坏文件当没有；写入防抖 + 原子写（tmp + rename）。
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowState extends Rect {
  maximized: boolean;
}

/** 开窗用的参数：没有 x / y 时由系统决定位置（居中） */
export interface WindowPlacement {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized: boolean;
}

export const DEFAULT_WINDOW_SIZE = { width: 1280, height: 800 } as const;
export const MIN_WINDOW_SIZE = { width: 960, height: 600 } as const;

/** 窗口至少要有这么大一块落在某个显示器里，才算「还看得见」 */
const MIN_VISIBLE = { width: 120, height: 80 } as const;

function isInt(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) < 1_000_000;
}

/** 读回来的 JSON 可能是任何东西：字段不对就当没有 */
export function parseWindowState(raw: unknown): WindowState | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (!isInt(value.x) || !isInt(value.y) || !isInt(value.width) || !isInt(value.height)) return null;
  if (value.width < 1 || value.height < 1) return null;
  return {
    x: Math.round(value.x),
    y: Math.round(value.y),
    width: Math.round(value.width),
    height: Math.round(value.height),
    maximized: value.maximized === true,
  };
}

function overlap(a: Rect, b: Rect): { width: number; height: number } {
  return {
    width: Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x),
    height: Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y),
  };
}

/**
 * 按现在接着的显示器决定窗口放哪。
 *
 * 上次的位置还落在某个显示器的可用区域里（标题栏够得着）才沿用；
 * 否则（显示器拔了、分辨率变了）回默认大小、交给系统居中，也不再最大化。
 */
export function resolveWindowPlacement(saved: WindowState | null, workAreas: readonly Rect[]): WindowPlacement {
  const fallback: WindowPlacement = { ...DEFAULT_WINDOW_SIZE, maximized: false };
  if (saved === null) return fallback;

  let best: { area: Rect; score: number } | null = null;
  for (const area of workAreas) {
    const visible = overlap(saved, area);
    if (visible.width < MIN_VISIBLE.width || visible.height < MIN_VISIBLE.height) continue;
    // 标题栏在窗口最上面：顶边跑到屏幕外就拖不回来了
    if (saved.y < area.y - 8 || saved.y > area.y + area.height - 40) continue;
    const score = visible.width * visible.height;
    if (best === null || score > best.score) best = { area, score };
  }
  if (best === null) return fallback;

  // 比显示器还大（换了小屏）就缩到显示器大小；太小则回到最小尺寸
  const width = Math.min(Math.max(saved.width, MIN_WINDOW_SIZE.width), Math.max(best.area.width, MIN_WINDOW_SIZE.width));
  const height = Math.min(
    Math.max(saved.height, MIN_WINDOW_SIZE.height),
    Math.max(best.area.height, MIN_WINDOW_SIZE.height),
  );
  return { x: saved.x, y: saved.y, width, height, maximized: saved.maximized };
}

export interface WindowStateStoreOptions {
  debounceMs?: number;
  /** 写失败时回调一次（记日志用）；不抛出 */
  onError?: (error: unknown) => void;
}

export class WindowStateStore {
  private pending: WindowState | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastWritten: string | null = null;
  private readonly debounceMs: number;
  private readonly onError: ((error: unknown) => void) | undefined;

  constructor(
    private readonly file: string,
    options: WindowStateStoreOptions = {},
  ) {
    this.debounceMs = options.debounceMs ?? 400;
    this.onError = options.onError;
  }

  /** 读上次保存的状态；文件不存在 / 坏了 / 字段不对都返回 null */
  load(): WindowState | null {
    try {
      return parseWindowState(JSON.parse(readFileSync(this.file, "utf8")));
    } catch {
      return null;
    }
  }

  /** 拖动 / 缩放时会连着触发很多次：只记最后一次，过一会儿再写 */
  update(state: WindowState): void {
    this.pending = state;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.debounceMs);
    // 别让这个定时器拖着进程不退出
    this.timer.unref?.();
  }

  /** 立刻把还没写的状态落盘（关窗口时调用） */
  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const state = this.pending;
    this.pending = null;
    if (state === null) return;
    const text = JSON.stringify(state);
    if (text === this.lastWritten) return;
    const temp = `${this.file}.tmp`;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(temp, text, "utf8");
      renameSync(temp, this.file);
      this.lastWritten = text;
    } catch (error) {
      this.onError?.(error);
    }
  }
}
