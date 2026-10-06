import { useState } from 'react';
import { Button } from './Button.tsx';

// Copies a full URL (the booking link). Says "Copied" for a moment; if the browser refuses
// (no clipboard permission), says so instead of failing silently.
export function CopyButton({ text, label = 'Copy link', variant = 'quiet' }: { text: string; label?: string; variant?: 'quiet' | 'secondary' }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState('copied');
    } catch {
      setState('failed');
    }
    setTimeout(() => setState('idle'), 2500);
  };
  return (
    <Button variant={variant} onClick={copy} aria-live="polite">
      {state === 'copied' ? 'Copied' : state === 'failed' ? "Couldn't copy" : label}
    </Button>
  );
}
