/**
 * C-33b 线条小图标（输入区、更多菜单用）。江浩要的是微信那种只有图标的工具条，字放在 title / aria-label 里。
 */
const ICONS = {
  emoji: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M8.5 14c.9 1.4 2.1 2 3.5 2s2.6-.6 3.5-2" />
      <path d="M9 9.5h.01M15 9.5h.01" strokeWidth="2.4" />
    </>
  ),
  image: (
    <>
      <rect x="3.5" y="5" width="17" height="14" rx="2.5" />
      <circle cx="9" cy="10" r="1.6" />
      <path d="M20.5 16l-5-5-8 8" />
    </>
  ),
  folder: <path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h4l2 2h8a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z" />,
  mic: (
    <>
      <rect x="9" y="3.5" width="6" height="11" rx="3" />
      <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v2.5" />
    </>
  ),
  /** 让回答用语音发 */
  voice: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M9.5 12h.01" strokeWidth="2.4" />
      <path d="M12 9.5a3.5 3.5 0 0 1 0 5M14.5 7.5a6.5 6.5 0 0 1 0 9" />
    </>
  ),
  plus: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 8v8M8 12h8" />
    </>
  ),
  keyboard: (
    <>
      <rect x="3" y="6.5" width="18" height="11" rx="2" />
      <path d="M7 10h.01M10.5 10h.01M14 10h.01M17.5 10h.01M8 14h8" />
    </>
  ),
  send: <path d="M12 18V6M7 11l5-5 5 5" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6" />
      <path d="M16 16l4 4" />
    </>
  ),
  copy: (
    <>
      <rect x="8" y="8" width="11" height="11" rx="2" />
      <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
    </>
  ),
  quote: <path d="M10 8L5 12.5 10 17M5 12.5h9a5 5 0 0 1 5 5V19" />,
  select: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M8.5 12.2l2.4 2.4 4.6-4.8" />
    </>
  ),
  topic: (
    <>
      <path d="M5 19V9l7-5 7 5v10z" />
      <path d="M10 19v-5h4v5" />
    </>
  ),
  draw: (
    <>
      <path d="M4 20l4-1 10.5-10.5a2.1 2.1 0 0 0-3-3L5 16z" />
      <path d="M14 7l3 3" />
    </>
  ),
  undo: <path d="M9 7L4.5 11.5 9 16M4.5 11.5H15a4.5 4.5 0 0 1 0 9h-3" />,
  info: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5.5M12 7.6h.01" />
    </>
  ),
  memory: (
    <>
      <ellipse cx="12" cy="6" rx="7" ry="2.6" />
      <path d="M5 6v12c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6V6M5 12c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6" />
    </>
  ),
  arrow: <path d="M5 12h14M13 6l6 6-6 6" />,
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 22 }: { name: IconName; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICONS[name]}
    </svg>
  );
}
