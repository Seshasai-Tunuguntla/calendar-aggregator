import type { ReactNode } from 'react';

type Tone = 'warning' | 'danger' | 'info' | 'success';

// A message the host should act on or know about. Warnings and errors are announced to screen
// readers (role="alert"); the others are polite status updates.
export function Notice({ tone, title, children, action }: { tone: Tone; title?: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className={`notice notice--${tone}`} role={tone === 'danger' || tone === 'warning' ? 'alert' : 'status'}>
      <div className="notice__body">
        {title && <p className="notice__title">{title}</p>}
        {children && <div className="notice__text">{children}</div>}
      </div>
      {action && <div className="notice__action">{action}</div>}
    </div>
  );
}
