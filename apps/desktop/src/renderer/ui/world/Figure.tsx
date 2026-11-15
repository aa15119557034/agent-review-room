import type { CSSProperties, ReactNode } from "react";
import type { WorldExpression } from "@room/schemas";

/**
 * 默认素材（ADR-008 §4：没有 ComfyUI 也能玩）。居民和你的小人、表情、物品图标都是这里画的 SVG，
 * 以后 X-43 出了固定立绘，按同样的 id 换图，不改调用的地方。
 */

const FACE: Record<WorldExpression | "asleep", ReactNode> = {
  neutral: (
    <>
      <circle cx="19" cy="23" r="1.6" />
      <circle cx="29" cy="23" r="1.6" />
      <path d="M21.5 29h5" className="fig-line" />
    </>
  ),
  happy: (
    <>
      <path d="M17 23.5q2-2.6 4 0M27 23.5q2-2.6 4 0" className="fig-line" />
      <path d="M20.5 28q3.5 3.4 7 0" className="fig-line" />
    </>
  ),
  sad: (
    <>
      <circle cx="19" cy="23.5" r="1.6" />
      <circle cx="29" cy="23.5" r="1.6" />
      <path d="M21 30.5q3-2.6 6 0" className="fig-line" />
    </>
  ),
  tired: (
    <>
      <path d="M17 23.5h4M27 23.5h4" className="fig-line" />
      <path d="M22 29.5h4" className="fig-line" />
    </>
  ),
  surprised: (
    <>
      <circle cx="19" cy="23" r="2.1" />
      <circle cx="29" cy="23" r="2.1" />
      <circle cx="24" cy="29.5" r="1.8" className="fig-line" />
    </>
  ),
  annoyed: (
    <>
      <path d="M16.5 21.5l4.5 1.8M31.5 21.5L27 23.3" className="fig-line" />
      <circle cx="19" cy="24.6" r="1.3" />
      <circle cx="29" cy="24.6" r="1.3" />
      <path d="M21.5 30h5" className="fig-line" />
    </>
  ),
  shy: (
    <>
      <circle cx="19" cy="23" r="1.6" />
      <circle cx="29" cy="23" r="1.6" />
      <ellipse cx="15.5" cy="27" rx="2.6" ry="1.5" className="fig-blush" />
      <ellipse cx="32.5" cy="27" rx="2.6" ry="1.5" className="fig-blush" />
      <path d="M21.5 28.5q2.5 2 5 0" className="fig-line" />
    </>
  ),
  asleep: (
    <>
      <path d="M17 24q2 1.8 4 0M27 24q2 1.8 4 0" className="fig-line" />
      <path d="M22.5 29.5h3" className="fig-line" />
    </>
  ),
};

/** 小人。color 是这位秘书的代表色；player 用中性色，头上有一小撮呆毛好认 */
export function Figure({ color, expression = "neutral", player = false, asleep = false, className }: {
  color: string;
  expression?: WorldExpression;
  player?: boolean;
  asleep?: boolean;
  className?: string;
}) {
  return (
    <svg
      className={`fig${className ? ` ${className}` : ""}`}
      viewBox="0 0 48 64"
      aria-hidden="true"
      data-asleep={asleep || undefined}
      style={{ "--fig": color } as CSSProperties}
    >
      <ellipse cx="24" cy="60" rx="13" ry="3" className="fig-shadow" />
      <rect x="12" y="35" width="24" height="23" rx="10" className="fig-body" />
      <path d="M17 44h14" className="fig-collar" />
      <circle cx="24" cy="22" r="14" className="fig-head" />
      {player ? (
        <path d="M10.5 20C10 9 20 6 26 7.5c7-1 12 4 11.5 12.5-5-1-8.5-4-10-7.5-3 4.5-9 7-17 7.5zM23 7q1-5 5-5-2 2-2 5z" className="fig-hair" />
      ) : (
        <path d="M9.8 23C8 9 19 6 24 6s16 3 14.2 17c-1.2-5-3.5-8-6.2-9.5-4 3-12 4.5-18.5 3.5-1.7 1.5-3 3.5-3.7 6z" className="fig-hair" />
      )}
      <g className="fig-face">{FACE[asleep ? "asleep" : expression]}</g>
    </svg>
  );
}

const ITEM_ICON: Record<string, ReactNode> = {
  book: (
    <>
      <path d="M4 5.5C7 4 10 4 12 5.5V19c-2-1.5-5-1.5-8 0z" />
      <path d="M20 5.5C17 4 14 4 12 5.5V19c2-1.5 5-1.5 8 0z" />
    </>
  ),
  pot: (
    <>
      <path d="M5 10h14v6a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3z" />
      <path d="M3 11h2M19 11h2M9 7h6M12 5v2" />
    </>
  ),
  table: (
    <>
      <path d="M3 9h18M5 9v10M19 9v10" />
      <path d="M8 9V7h8v2" />
    </>
  ),
  seat: (
    <>
      <path d="M7 4v9h10V4" />
      <path d="M5 13h14v3H5zM7 16v4M17 16v4" />
    </>
  ),
  ingredients: (
    <>
      <path d="M12 8c-4 0-6 3-6 6s2 6 6 6 6-3 6-6-2-6-6-6z" />
      <path d="M12 8c0-2 1-3.5 3-4" />
    </>
  ),
  meals: (
    <>
      <path d="M4 12h16a8 8 0 0 1-16 0z" />
      <path d="M9 8c0-1.5 1.5-1.5 1.5-3M13.5 8c0-1.5 1.5-1.5 1.5-3" />
    </>
  ),
};

export function ItemIcon({ id }: { id: string }) {
  return (
    <svg className="item-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ITEM_ICON[id] ?? <rect x="5" y="6" width="14" height="12" rx="2" />}
    </svg>
  );
}
