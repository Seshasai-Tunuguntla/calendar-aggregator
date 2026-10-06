import type { ReactNode } from 'react';
import { errorMessage } from '../api/client.ts';
import { Button } from './Button.tsx';

// The three states every page and section has besides "ready".

export function LoadingState({ label }: { label: string }) {
  return (
    <div className="state state--loading" role="status" aria-live="polite">
      <span className="state__spinner" aria-hidden="true" />
      <p>{label}</p>
    </div>
  );
}

export function ErrorState({ error, onRetry, title = "This didn't load" }: { error: unknown; onRetry?: () => void; title?: string }) {
  return (
    <div className="state state--error" role="alert">
      <p className="state__title">{title}</p>
      <p>{errorMessage(error)}</p>
      {onRetry && (
        <Button variant="secondary" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="state state--empty">
      <p className="state__title">{title}</p>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}
