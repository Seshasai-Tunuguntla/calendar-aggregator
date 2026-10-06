import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DayPicker } from '../../src/guest/DayPicker.tsx';
import type { Day } from '../../src/guest/guestTime.ts';

const slot = (date: string) => ({ start: `${date}T09:00:00.000Z`, end: `${date}T09:30:00.000Z` });
// Nine days with times, skipping some dates (those have none, so they aren't offered at all).
const DATES = ['2026-10-12', '2026-10-13', '2026-10-15', '2026-10-16', '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-26'];
const DAYS: Day[] = DATES.map((date, i) => ({ date, slots: Array.from({ length: (i % 3) + 1 }, () => slot(date)) }));

// Guests see dates in their browser's language, so either order is right.
const day = (weekday: string, n: number, month = 'October') => new RegExp(`${weekday},? (${n} ${month}|${month} ${n})`);
const dayButtons = () => screen.getAllByRole('button', { pressed: undefined }).filter((b) => b.classList.contains('day-button'));

describe('DayPicker', () => {
  it('offers only days that have free times, a week of them at a time, saying how many', () => {
    render(<DayPicker days={DAYS} selected="2026-10-12" onSelect={() => {}} canLoadMore={false} loadingMore={false} onLoadMore={() => {}} />);
    expect(dayButtons()).toHaveLength(7);
    expect(screen.queryByRole('button', { name: /14 October/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: new RegExp(`${day('Monday', 12).source}, 1 free time$`) })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: new RegExp(`${day('Tuesday', 13).source}, 2 free times$`) })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('heading', { name: 'October 2026' })).toBeInTheDocument();
  });

  it('pages through the days with Earlier and Later', async () => {
    render(<DayPicker days={DAYS} selected="2026-10-12" onSelect={() => {}} canLoadMore={false} loadingMore={false} onLoadMore={() => {}} />);
    expect(screen.getByRole('button', { name: '← Earlier' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Later →' }));
    expect(dayButtons().map((b) => b.getAttribute('aria-label')?.replace(/, \d+ free times?$/, ''))).toEqual([
      expect.stringMatching(day('Thursday', 22)),
      expect.stringMatching(day('Monday', 26)),
    ]);
    expect(screen.getByRole('button', { name: 'Later →' })).toBeDisabled();
    expect(screen.getByText('No more free times after these.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '← Earlier' }));
    expect(dayButtons()).toHaveLength(7);
  });

  it('asks for later dates once the loaded ones run out', async () => {
    const onLoadMore = vi.fn<() => void>();
    render(<DayPicker days={DAYS.slice(0, 3)} selected={null} onSelect={() => {}} canLoadMore loadingMore={false} onLoadMore={onLoadMore} />);
    await userEvent.click(screen.getByRole('button', { name: 'Later →' }));
    expect(onLoadMore).toHaveBeenCalledOnce();
  });

  it('reports the picked day', async () => {
    const onSelect = vi.fn<(date: string) => void>();
    render(<DayPicker days={DAYS} selected="2026-10-12" onSelect={onSelect} canLoadMore={false} loadingMore={false} onLoadMore={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: day('Friday', 16) }));
    expect(onSelect).toHaveBeenCalledWith('2026-10-16');
  });
});
