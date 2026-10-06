import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Slot } from '@calendar-aggregator/shared';
import { SlotPicker } from '../../src/guest/SlotPicker.tsx';

// 08:30, 09:00 and 09:30 UTC on Tuesday 13 October 2026.
const SLOTS: Slot[] = ['08:30', '09:00', '09:30'].map((t) => {
  const start = new Date(`2026-10-13T${t}:00Z`);
  return { start: start.toISOString(), end: new Date(start.getTime() + 30 * 60_000).toISOString() };
});
const time = (text: string) => new RegExp(`^${text.replace(' ', '\\s')}$`);
// Guests see dates in their browser's language, so either order is right.
const tuesday13 = /Tuesday,? (13 October|October 13)/;

describe('SlotPicker', () => {
  it("shows each time as a button in the guest's time zone, under the day", () => {
    render(<SlotPicker slots={SLOTS} timeZone="Asia/Kolkata" selected={null} onSelect={() => {}} />);
    expect(screen.getByRole('heading', { name: tuesday13 })).toBeInTheDocument();
    // 08:30 UTC is 14:00 in India.
    // (Intl may put a narrow no-break space before PM: compare with plain spaces.)
    expect(screen.getAllByRole('button').map((b) => b.textContent?.replace(/\s/g, ' '))).toEqual(['2:00 PM', '2:30 PM', '3:00 PM']);
  });

  it('marks only the picked time as pressed', () => {
    render(<SlotPicker slots={SLOTS} timeZone="UTC" selected={SLOTS[1]?.start ?? null} onSelect={() => {}} />);
    expect(screen.getByRole('button', { name: time('9:00 AM') })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: time('8:30 AM') })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: time('9:30 AM') })).toHaveAttribute('aria-pressed', 'false');
  });

  it('reports the picked slot, by mouse or keyboard', async () => {
    const onSelect = vi.fn<(slot: Slot) => void>();
    render(<SlotPicker slots={SLOTS} timeZone="UTC" selected={null} onSelect={onSelect} />);
    await userEvent.tab();
    expect(screen.getByRole('button', { name: time('8:30 AM') })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(onSelect).toHaveBeenLastCalledWith(SLOTS[0]);

    await userEvent.click(screen.getByRole('button', { name: time('9:30 AM') }));
    expect(onSelect).toHaveBeenLastCalledWith(SLOTS[2]);
  });

  it('renders nothing for a day without times', () => {
    const { container } = render(<SlotPicker slots={[]} timeZone="UTC" selected={null} onSelect={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });
});
