import type { ReactNode } from "react";
import { useDialog } from "../dialog";

/** 世界页的弹层（她知道什么、回顾、以前的对话）。键盘行为和别处的底部面板一样 */
export function WorldSheet({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  const ref = useDialog<HTMLElement>(onClose);
  return (
    <div className="profile-sheet-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <section ref={ref} tabIndex={-1} className="profile-sheet world-sheet" role="dialog" aria-modal="true" aria-label={label}>
        <span className="profile-sheet-grip" aria-hidden="true" />
        <header>
          <h2>{label}</h2>
          <button type="button" className="button-primary profile-done" onClick={onClose}>好</button>
        </header>
        {children}
      </section>
    </div>
  );
}
