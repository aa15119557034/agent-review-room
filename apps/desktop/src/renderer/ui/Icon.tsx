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
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 22 }: { name: IconName; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICONS[name]}
    </svg>
  );
}
