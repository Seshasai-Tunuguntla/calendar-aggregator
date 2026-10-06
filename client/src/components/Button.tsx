import type { AnchorHTMLAttributes, ButtonHTMLAttributes } from 'react';

type Variant = 'primary' | 'secondary' | 'danger' | 'quiet';

const className = (variant: Variant, extra?: string) => ['button', `button--${variant}`, extra].filter(Boolean).join(' ');

// A real <button>. `busy` keeps the label (so the width doesn't jump), disables it and tells screen
// readers it's working.
export function Button({
  variant = 'secondary',
  busy = false,
  className: extra,
  disabled,
  children,
  type = 'button',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; busy?: boolean }) {
  return (
    <button {...rest} type={type} className={className(variant, extra)} disabled={disabled || busy} aria-busy={busy || undefined}>
      {children}
      {busy && <span className="button__busy" aria-hidden="true" />}
    </button>
  );
}

// A link that looks like a button: for full-page navigations such as "Sign in with Google", which
// must leave the app for Google's own page.
export function ButtonLink({ variant = 'secondary', className: extra, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { variant?: Variant }) {
  return <a {...rest} className={className(variant, extra)} />;
}
