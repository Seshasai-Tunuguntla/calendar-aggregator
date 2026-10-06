// Checks WCAG contrast for every colour pair the components use, reading the tokens straight from
// src/styles/tokens.css (so the check can't drift from the stylesheet). Runs in CI:
// `npm run contrast --workspace client`. Ported from the Study Scheduler (one theme here).
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../src/styles/tokens.css', import.meta.url), 'utf8');
const tokens = new Map<string, string>();
for (const [, name, hex] of css.matchAll(/(--color-[\w-]+):\s*(#[0-9a-f]{6})\b/gi)) {
  if (name && hex) tokens.set(name, hex);
}

const channel = (hex: string, i: number) => {
  const c = Number.parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
  return c <= 0.039_28 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex: string) => 0.2126 * channel(hex, 0) + 0.7152 * channel(hex, 1) + 0.0722 * channel(hex, 2);
export const contrast = (a: string, b: string) => {
  const [hi = 0, lo = 0] = [luminance(a), luminance(b)].toSorted((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

// [foreground, background, minimum]: 4.5 for text, 3 for control edges and the focus ring.
const surfaces = ['--color-paper', '--color-paper-deep', '--color-surface'];
export const PAIRS: [string, string, number][] = [
  ...surfaces.map((bg): [string, string, number] => ['--color-ink', bg, 4.5]),
  ...surfaces.map((bg): [string, string, number] => ['--color-ink-muted', bg, 4.5]),
  // Links and the accent as text, including on the hover wash.
  ...[...surfaces, '--color-accent-wash'].map((bg): [string, string, number] => ['--color-accent', bg, 4.5]),
  ['--color-ink', '--color-accent-wash', 4.5],
  // Primary buttons and the selected slot.
  ['--color-on-accent', '--color-accent', 4.5],
  ['--color-on-accent', '--color-accent-hover', 4.5],
  // Edges of inputs, checkboxes and slot buttons, and the focus ring, against what's around them.
  ...[...surfaces, '--color-accent-wash'].map((bg): [string, string, number] => ['--color-control-line', bg, 3]),
  ...surfaces.map((bg): [string, string, number] => ['--color-accent', bg, 3]),
  // Status text on its own surface and on the page.
  ['--color-warning', '--color-warning-surface', 4.5],
  ['--color-warning', '--color-paper', 4.5],
  ['--color-danger', '--color-danger-surface', 4.5],
  ['--color-danger', '--color-paper', 4.5],
  ['--color-danger', '--color-surface', 4.5],
  ['--color-success', '--color-success-surface', 4.5],
  ['--color-info', '--color-info-surface', 4.5],
  ['--color-ink', '--color-warning-surface', 4.5],
  ['--color-ink', '--color-danger-surface', 4.5],
  ['--color-ink', '--color-success-surface', 4.5],
  ['--color-ink', '--color-info-surface', 4.5],
];

if (import.meta.main) {
  let failures = 0;
  for (const [fg, bg, min] of PAIRS) {
    const [a, b] = [tokens.get(fg), tokens.get(bg)];
    if (!a || !b) throw new Error(`Missing colour token: ${a ? bg : fg}`);
    const ratio = contrast(a, b);
    const ok = ratio >= min;
    if (!ok) failures += 1;
    console.info(`${ok ? ' ok ' : 'FAIL'} ${ratio.toFixed(1).padStart(5)}:1  ${fg} on ${bg} (needs ${min})`);
  }
  if (failures > 0) {
    console.error(`\n${failures} pair(s) below WCAG AA`);
    process.exitCode = 1;
  } else {
    console.info(`\nAll ${PAIRS.length} pairs meet WCAG AA.`);
  }
}
